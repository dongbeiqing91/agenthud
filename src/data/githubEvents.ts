/**
 * GitHub corp events as a `--with-git` data source.
 *
 * The per-session `git log` (gitCommits.ts) only covers repos that have
 * agent sessions on the day, and only the checked-out branch — manual
 * work (pushed commits, PRs, reviews, issue comments) done outside a
 * tracked agent session never reaches the report or summary. This
 * module fills that gap by fetching the authenticated user's GitHub
 * events for a local date via `gh api`.
 *
 * Design notes:
 * - corp host only (github.com is intentionally out of scope; the user's
 *   work repos live on the corp instance)
 * - synchronous (execSync) to match parseGitCommits and keep
 *   generateReport synchronous
 * - cached under `<agenthudHome>/cache/github-events/<login>/<date>.json`:
 *   past dates are immutable (cached permanently), today is re-fetched
 *   every 10 minutes (GitHub events lag a few minutes, and watch mode
 *   calls the report repeatedly)
 * - graceful degradation: gh missing / not logged in / network failure
 *   → one stderr warning + empty result; the report never fails
 *   because of this source
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ActivityEntry, ICONS } from "../types/index.js";
import { agenthudHome } from "../utils/agenthudHome.js";

/** The only GitHub instance this source reads from. */
export const GITHUB_CORP_HOST = "github-cli.corp.ebay.com";

/** TTL for today's cache — events lag a few minutes upstream, and
 * watch mode regenerates the report on an interval. */
const TODAY_TTL_MS = 10 * 60 * 1000;
/** GitHub caps the events feed at 3 pages (300 events) per user. */
const MAX_PAGES = 3;
const GH_TIMEOUT_MS = 20_000;

export interface GitHubIdentity {
  login: string;
  name?: string | null;
  email?: string | null;
}

interface RawEvent {
  type: string;
  created_at: string;
  repo: { name?: string };
  payload: Record<string, unknown>;
}

interface CacheFile {
  fetchedAt: number;
  complete: boolean;
  events: RawEvent[];
}

// ── small helpers ──────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function firstLine(s: string): string {
  return s.split("\n")[0].trim();
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

let warned = false;
function warnOnce(msg: string): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`agenthud: ${msg}\n`);
}

/**
 * Run `gh api <path>` against the corp host. Returns parsed JSON or
 * null (with a one-line error for warnings). Never throws.
 */
function ghApi(path: string): { data: unknown; error: string | null } {
  try {
    const out = execSync(`gh api ${path}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GH_TIMEOUT_MS,
      env: { ...process.env, GH_HOST: GITHUB_CORP_HOST },
    });
    return { data: JSON.parse(out), error: null };
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    const line =
      str(e.stderr)
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0) ??
      str(e.message) ??
      "unknown error";
    return { data: null, error: line.slice(0, 200) };
  }
}

// ── identity ───────────────────────────────────────────────────────

export function fetchGitHubIdentity(): GitHubIdentity | null {
  const { data, error } = ghApi("/user");
  if (!isRecord(data) || typeof data.login !== "string") {
    warnOnce(
      `GitHub events unavailable (${error ?? "unknown error"}) — manual git activity is skipped; check \`gh auth login\` (host ${GITHUB_CORP_HOST})`,
    );
    return null;
  }
  return {
    login: data.login,
    name: typeof data.name === "string" ? data.name : null,
    email: typeof data.email === "string" ? data.email : null,
  };
}

// ── mapping: raw events → activity rows ────────────────────────────

/**
 * Whether a pushed commit counts as "mine". A push can carry other
 * people's commits (e.g. pushing a colleague's branch to a fork) —
 * filter by the commit author against my GitHub identity. Commits with
 * no author info cannot be verified and are kept (I did the pushing).
 */
function isMyCommit(
  c: Record<string, unknown>,
  identity: GitHubIdentity,
): boolean {
  const author = isRecord(c.author) ? c.author : null;
  const email = author ? str(author.email).toLowerCase() : "";
  const name = author ? str(author.name).toLowerCase() : "";
  if (!email && !name) return true;
  if (identity.email && email && email === identity.email.toLowerCase()) {
    return true;
  }
  if (identity.name && name && name === identity.name.toLowerCase())
    return true;
  if (identity.login && name && name === identity.login.toLowerCase()) {
    return true;
  }
  return false;
}

function isRawEvent(v: unknown): v is RawEvent {
  if (!isRecord(v)) return false;
  return (
    typeof v.type === "string" &&
    typeof v.created_at === "string" &&
    isRecord(v.payload)
  );
}

/**
 * Map raw GitHub events to report activity rows. Pure — no I/O.
 * Kept as a separate export so the mapping is testable without gh.
 */
export function eventsToActivities(
  events: RawEvent[],
  identity: GitHubIdentity,
): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const ev of events) {
    const ts = new Date(ev.created_at);
    if (Number.isNaN(ts.getTime())) continue;
    const repo = ev.repo?.name ?? "unknown";
    const payload = ev.payload;
    switch (ev.type) {
      case "PushEvent": {
        const commits = payload.commits;
        if (!Array.isArray(commits)) break;
        const ref = str(payload.ref).replace(/^refs\/(heads|tags)\//, "");
        for (const c of commits) {
          if (!isRecord(c)) continue;
          if (!isMyCommit(c, identity)) continue;
          const sha = str(c.sha).slice(0, 7);
          if (!sha) continue;
          const msg = firstLine(str(c.message));
          out.push({
            timestamp: ts,
            type: "commit",
            icon: ICONS.Commit,
            label: sha,
            detail: `${repo} (${ref}): ${msg}`.trim(),
          });
        }
        break;
      }
      case "PullRequestEvent": {
        const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
        if (!pr) break;
        if (typeof pr.number !== "number") break;
        const action = str(payload.action);
        // Only state changes a reader cares about — synchronize,
        // assigned, labeled, etc. are push noise on PR branches.
        let verb: string | null = null;
        if (action === "opened") verb = "opened";
        else if (action === "closed") verb = pr.merged_at ? "merged" : "closed";
        if (!verb) break;
        out.push({
          timestamp: ts,
          type: "github",
          icon: ICONS.GitHub,
          label: `PR #${pr.number} ${verb}`,
          detail: `${repo}: ${str(pr.title)}`.trim(),
        });
        break;
      }
      case "PullRequestReviewEvent": {
        const action = str(payload.action);
        if (action !== "submitted" && action !== "created") break;
        const review = isRecord(payload.review) ? payload.review : null;
        const state = review ? str(review.state) : "";
        if (!state) break;
        const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
        const number = pr && typeof pr.number === "number" ? pr.number : null;
        const target = number !== null ? `${repo}#${number}` : repo;
        out.push({
          timestamp: ts,
          type: "github",
          icon: ICONS.GitHub,
          label: `review: ${state}`,
          detail: `${target} ${pr ? str(pr.title) : ""}`.trim(),
        });
        break;
      }
      case "IssueCommentEvent": {
        if (str(payload.action) !== "created") break;
        const issue = isRecord(payload.issue) ? payload.issue : null;
        if (!issue) break;
        const number = typeof issue.number === "number" ? issue.number : null;
        const target = number !== null ? `${repo}#${number}` : repo;
        const comment = isRecord(payload.comment) ? payload.comment : null;
        const body = comment ? firstLine(str(comment.body)).slice(0, 120) : "";
        out.push({
          timestamp: ts,
          type: "github",
          icon: ICONS.GitHub,
          label: "comment",
          detail: [target, str(issue.title), body && `— ${body}`]
            .filter(Boolean)
            .join(" "),
        });
        break;
      }
      // Watch/Fork/Create/Delete/… — deliberately ignored.
    }
  }
  return out.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

// ── cache ──────────────────────────────────────────────────────────

function cachePathFor(identity: GitHubIdentity, date: Date): string {
  return join(
    agenthudHome(),
    "cache",
    "github-events",
    identity.login,
    `${formatLocalDate(date)}.json`,
  );
}

function readCache(path: string): CacheFile | null {
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
    if (
      !isRecord(obj) ||
      typeof obj.fetchedAt !== "number" ||
      !Array.isArray(obj.events)
    ) {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

function writeCache(path: string, cache: CacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), "utf-8");
  } catch {
    // best-effort — a cache write failure never affects the report
  }
}

// ── main entry ─────────────────────────────────────────────────────

/**
 * Fetch (or read from cache) the GitHub events for one local date and
 * map them to activity rows. Synchronous; never throws.
 */
export function fetchGitHubActivities(
  date: Date,
  opts: { force?: boolean } = {},
): ActivityEntry[] {
  const identity = fetchGitHubIdentity();
  if (!identity) return [];

  const dateStr = formatLocalDate(date);
  const isToday = dateStr === formatLocalDate(new Date());
  const cachePath = cachePathFor(identity, date);

  if (!opts.force) {
    const cached = readCache(cachePath);
    if (cached?.complete) {
      const ttl = isToday ? TODAY_TTL_MS : Infinity;
      if (Date.now() - cached.fetchedAt < ttl) {
        return eventsToActivities(cached.events, identity);
      }
    }
  }

  // Local window: [date 00:00, next-day 00:00).
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);

  const events: RawEvent[] = [];
  let complete = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = ghApi(
      `/users/${identity.login}/events?per_page=100&page=${page}`,
    );
    if (!Array.isArray(data)) break; // auth/network failure mid-loop
    for (const raw of data) {
      if (!isRawEvent(raw)) continue;
      const ts = Date.parse(raw.created_at);
      if (Number.isNaN(ts)) continue;
      if (ts < start.getTime()) {
        // Events are newest-first: we have reached past the window.
        complete = true;
        continue;
      }
      if (ts >= end.getTime()) continue; // newer than the window
      events.push(raw);
    }
    if (complete) break;
    if (data.length < 100) {
      complete = true;
      break;
    }
  }

  writeCache(cachePath, { fetchedAt: Date.now(), complete, events });
  return eventsToActivities(events, identity);
}
