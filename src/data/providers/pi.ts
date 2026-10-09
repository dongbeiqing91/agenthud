/**
 * pi (pi-coding-agent) session provider. pi stores each session as an
 * append-only JSONL file:
 *
 *   ~/.pi/agent/sessions/<sanitized-cwd>/<ISO>_<uuid>.jsonl
 *
 * (override with PI_SESSIONS_DIR). Line 1 is a header
 * `{type:"session", version, id, timestamp, cwd}`; every later line is an
 * entry `{type, id, parentId, timestamp, ...}`. Entries link via
 * `parentId` and form a TREE, not a flat list: pi's rollback forks within
 * the same file, so dead branches can linger. The ACTIVE branch is the
 * path from the file's last entry (the current leaf — appends always land
 * on the live branch) back to the header.
 *
 * Entry types: `message` (roles: system / user / assistant / toolResult /
 * bashExecution), `model_change`, `thinking_level_change`,
 * `session_info` (auto/session title), `compaction`, `branch_summary`,
 * `usage`, `label`, `context_edit`, `custom_message`. Assistant messages
 * carry `provider`/`model`/`usage` and content blocks (`thinking`,
 * `text`, `toolCall`); tool results are SEPARATE `toolResult` messages
 * keyed by `toolCallId`.
 *
 * Design decisions:
 * - `parseActivities` re-walks the active branch from WHATEVER lines it
 *   is handed (whole file or a bounded tail window from the history
 *   cache). The walk stops at the window seam (parent absent from the
 *   window), which is correct as long as the seam sits on the active
 *   branch — the cache guarantees that by splitting at turn boundaries.
 *   Lines that fall off the walked path (dead branches inside the
 *   window) are dropped, matching what the pi UI itself shows.
 * - Discovery metadata is cached by (path, mtime) — pi keeps every
 *   historical session on disk and files can be hundreds of KB, so a
 *   full re-read per 2s poll would be wasteful; cold files never change
 *   mtime and stay cached.
 * - Context gauge: the last assistant `usage.totalTokens` on the branch,
 *   divided by the model's `contextWindow` from the agent dir's
 *   `models.json` (`<agentDir>/models.json`, i.e. `~/.pi/agent/`). The
 *   lookup is best-effort — unknown model → no gauge, never an error.
 * - Tool labels go through `canonicalToolLabel` (pi uses lowercase tool
 *   names: `read`, `bash`, `edit`, ...) into the shared taxonomy; input
 *   args are normalized (`path` → `file_path`) so the Claude-shaped
 *   `summarizeToolDetail` summarizers work unchanged.
 *
 * Gotchas:
 * - pi tool args use `path`, NOT Claude's `file_path` — normalize before
 *   summarizing or Read/Edit rows go blank.
 * - `stopReason: "aborted" | "error"` assistant usage is not real
 *   context consumption (mirrors pi's own `getAssistantUsage`).
 * - Forked sessions (`createBranchedSession` / `forkFrom`) write a
 *   `parentSession` header field; MVP treats every file as a
 *   top-level session (forks may live in a different project dir, so
 *   nesting them would cross project boundaries).
 * - pi-subagents ephemeral child sessions live under
 *   `<agentDir>/ephemeral-sessions/`, a DIFFERENT root that gets
 *   cleaned up — intentionally not discovered here.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  ActivityEntry,
  GlobalConfig,
  ProjectNode,
  SessionNode,
  SessionStatus,
  SessionTree,
} from "../../types/index.js";
import { ICONS } from "../../types/index.js";
import { ONE_HOUR_MS, THIRTY_MINUTES_MS } from "../../utils/timeConstants.js";
import { summarizeToolDetail, type ToolInput } from "../toolDetails.js";
import { pickLatestUserTitle } from "./sessionTitle.js";
import { canonicalToolLabel, iconForCanonicalLabel } from "./toolLabels.js";
import type { ParseResult, SessionProvider } from "./types.js";

export function getPiSessionsDir(): string {
  return (
    process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions")
  );
}

// models.json sits in the agent dir, the parent of the sessions dir.
// Overridable for tests / custom agent roots.
function getPiModelsFile(): string {
  return (
    process.env.PI_MODELS_FILE ?? `${dirname(getPiSessionsDir())}/models.json`
  );
}

function getSessionStatus(mtimeMs: number): SessionStatus {
  const now = Date.now();
  const age = now - mtimeMs;
  if (age < THIRTY_MINUTES_MS) return "hot";
  if (age < ONE_HOUR_MS) return "warm";
  const mtime = new Date(mtimeMs);
  const nowDate = new Date(now);
  if (
    mtime.getUTCFullYear() === nowDate.getUTCFullYear() &&
    mtime.getUTCMonth() === nowDate.getUTCMonth() &&
    mtime.getUTCDate() === nowDate.getUTCDate()
  ) {
    return "cool";
  }
  return "cold";
}

// --- entry shapes (defensive: pi's schema isn't versioned in the log) ---

interface PiBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

interface PiMessage {
  role?: string;
  content?: string | PiBlock[];
  provider?: string;
  model?: string;
  stopReason?: string;
  usage?: PiUsage;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
}

interface PiEntry {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  version?: number;
  cwd?: string;
  provider?: string;
  modelId?: string;
  name?: string;
  summary?: string;
  tokensBefore?: number;
  message?: PiMessage;
}

function parsePiEntries(lines: string[]): PiEntry[] {
  const out: PiEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as PiEntry;
      if (e && typeof e.type === "string" && typeof e.id === "string") {
        out.push(e);
      }
    } catch {
      // malformed line — skip (the cache may hand us a partial tail line)
    }
  }
  return out;
}

/** Walk the active branch: from the LAST entry (the live leaf) follow
 * `parentId` links to the root. Entries off this path are dead branches
 * (pi rollback forks) and are excluded. Works on a full file OR a tail
 * window — in the windowed case the walk simply stops at the seam. */
function walkActiveBranch(entries: PiEntry[]): PiEntry[] {
  if (entries.length === 0) return [];
  const byId = new Map<string, PiEntry>();
  for (const e of entries) byId.set(e.id, e);
  const path: PiEntry[] = [];
  let current: PiEntry | undefined = entries[entries.length - 1];
  let guard = 0;
  while (current && guard++ < 1_000_000) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}

// content is a bare string OR an array of blocks; join the text blocks.
function messageText(msg: PiMessage): string | null {
  const c = msg.content;
  if (typeof c === "string") {
    const t = c.trim();
    return t || null;
  }
  if (Array.isArray(c)) {
    const text = c
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
    return text || null;
  }
  return null;
}

const firstLine = (text: string) =>
  text.split("\n").find((l) => l.trim()) ?? "";

// pi assistant usage: totalTokens when present, else the sum of the
// context-building fields (mirrors pi's calculateContextTokens).
function usageTotal(usage: PiUsage): number {
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  return (
    (usage.input ?? 0) +
    (usage.output ?? 0) +
    (usage.cacheRead ?? 0) +
    (usage.cacheWrite ?? 0)
  );
}

const isUsableUsage = (msg: PiMessage): msg is PiMessage & { usage: PiUsage } =>
  msg.role === "assistant" &&
  msg.stopReason !== "aborted" &&
  msg.stopReason !== "error" &&
  !!msg.usage &&
  usageTotal(msg.usage) > 0;

// --- context-window lookup (best-effort, per discover call) ---

interface PiModelsFile {
  providers?: Record<
    string,
    { models?: { id?: string; contextWindow?: number }[] }
  >;
}

/** Map of `provider/modelId` → contextWindow from the agent's
 * models.json. Empty map when the file is missing or unparseable. */
function loadContextWindows(): Map<string, number> {
  const map = new Map<string, number>();
  let content: string;
  try {
    content = readFileSync(getPiModelsFile(), "utf-8");
  } catch {
    return map;
  }
  let parsed: PiModelsFile;
  try {
    parsed = JSON.parse(content) as PiModelsFile;
  } catch {
    return map;
  }
  for (const [providerKey, prov] of Object.entries(parsed.providers ?? {})) {
    for (const m of prov?.models ?? []) {
      if (typeof m?.id === "string" && typeof m?.contextWindow === "number") {
        map.set(`${providerKey}/${m.id}`, m.contextWindow);
      }
    }
  }
  return map;
}

function contextUsageFor(
  msg: PiMessage,
  windows: Map<string, number>,
): { used: number; total: number; percent: number } | null {
  if (!isUsableUsage(msg) || !msg.provider || !msg.model) return null;
  const total = windows.get(`${msg.provider}/${msg.model}`);
  if (total === undefined || total <= 0) return null;
  const used = usageTotal(msg.usage);
  return {
    used,
    total,
    percent: Math.min(100, Math.round((used / total) * 100)),
  };
}

// --- discovery ---

interface PiMeta {
  id: string;
  cwd: string;
  version: string | undefined;
  title: string | null;
  model: string | null;
  contextUsage: { used: number; total: number; percent: number } | null;
}

// (path, mtime)-keyed metadata cache, like codex's.
const metaCache = new Map<string, { mtimeMs: number; value: PiMeta | null }>();

/** Test hook: the module-level cache collides on fake (path, mtime)
 * pairs across test cases. Production never needs this. */
export function clearPiMetaCache(): void {
  metaCache.clear();
}

function parsePiMeta(path: string, mtimeMs: number): PiMeta | null {
  const cached = metaCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;

  let value: PiMeta | null = null;
  try {
    const content = readFileSync(path, "utf-8");
    const entries = parsePiEntries(content.split("\n"));
    const header = entries.find((e) => e.type === "session");
    if (header && typeof header.cwd === "string") {
      const branch = walkActiveBranch(entries);
      const windows = loadContextWindows();

      let model: string | null = null;
      let contextUsage: PiMeta["contextUsage"] = null;
      const userMessages: string[] = [];
      let title: string | null = null;

      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i];
        if (
          e.type === "model_change" &&
          typeof e.modelId === "string" &&
          e.modelId.length > 0
        ) {
          model = e.modelId; // last model_change on the branch wins
          break;
        }
      }
      for (const e of branch) {
        if (e.type === "message" && e.message) {
          const msg = e.message;
          if (msg.role === "user") {
            const t = messageText(msg);
            if (t) userMessages.push(t);
          } else if (msg.role === "assistant") {
            if (!model && typeof msg.model === "string") model = msg.model;
            if (isUsableUsage(msg)) {
              const cu = contextUsageFor(msg, windows);
              if (cu) contextUsage = cu; // last usable usage wins
            }
          }
        } else if (e.type === "session_info" && typeof e.name === "string") {
          if (e.name.trim()) title = e.name.trim(); // last session_info wins
        }
      }
      if (!title) title = pickLatestUserTitle(userMessages) ?? null;

      value = {
        id: header.id,
        cwd: header.cwd,
        version:
          typeof header.version === "number"
            ? String(header.version)
            : undefined,
        title,
        model,
        contextUsage,
      };
    }
  } catch {
    value = null;
  }
  metaCache.set(path, { mtimeMs, value });
  return value;
}

const safeReadDir = (dir: string): string[] => {
  try {
    // SAFETY: readdirSync is typed withFileTypes=false → string[], but the
    // overloads make TS return Dirent[] | string[]; the cast is safe because
    // we call the plain (non-withFileTypes) overload.
    return readdirSync(dir) as unknown as string[];
  } catch {
    return [];
  }
};

function makeNode(
  meta: PiMeta,
  filePath: string,
  mtimeMs: number,
  hidden: boolean,
): SessionNode {
  const projectName = basename(meta.cwd);
  const node: SessionNode = {
    id: meta.id,
    hideKey: `${projectName}/${meta.id}`,
    filePath,
    projectPath: meta.cwd,
    projectName,
    lastModifiedMs: mtimeMs,
    status: getSessionStatus(mtimeMs),
    modelName: meta.model,
    subAgents: [],
    nonInteractive: false,
    firstUserPrompt: meta.title,
    liveState: null,
    provider: "pi",
    contextUsage: meta.contextUsage ?? undefined,
    version: meta.version,
  };
  if (hidden) node.hidden = true;
  return node;
}

function discoverPiSessions(config: GlobalConfig): SessionTree {
  const root = getPiSessionsDir();
  const empty: SessionTree = {
    projects: [],
    coldProjects: [],
    totalCount: 0,
    timestamp: new Date().toISOString(),
    hiddenStats: { total: 0, active: 0 },
  };
  if (!existsSync(root)) return empty;

  interface Parsed {
    meta: PiMeta;
    filePath: string;
    mtimeMs: number;
  }
  const parsed: Parsed[] = [];
  for (const dirName of safeReadDir(root)) {
    const dirPath = join(root, dirName);
    let isDir = false;
    try {
      isDir = statSync(dirPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const file of safeReadDir(dirPath)) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, file);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      const meta = parsePiMeta(filePath, mtimeMs);
      if (meta) parsed.push({ meta, filePath, mtimeMs });
    }
  }

  const nodesById = new Map<string, SessionNode>();
  const byProject = new Map<string, SessionNode[]>();
  let hiddenTotal = 0;
  let hiddenActive = 0;

  for (const { meta, filePath, mtimeMs } of parsed) {
    const projectName = basename(meta.cwd);
    const projectHidden = config.hiddenProjects.includes(projectName);
    const sessionHidden = config.hiddenSessions.includes(
      `${projectName}/${meta.id}`,
    );
    const hidden = projectHidden || sessionHidden;
    const node = makeNode(meta, filePath, mtimeMs, hidden);
    nodesById.set(meta.id, node);
    if (hidden) {
      hiddenTotal++;
      if (node.status === "hot" || node.status === "warm") hiddenActive++;
    }
    const arr = byProject.get(meta.cwd) ?? [];
    arr.push(node);
    byProject.set(meta.cwd, arr);
  }

  const statusOrder: Record<SessionStatus, number> = {
    hot: 0,
    warm: 1,
    cool: 2,
    cold: 3,
  };

  const allProjects: ProjectNode[] = [];
  for (const [projectPath, sessions] of byProject) {
    if (sessions.length === 0) continue;
    const projectName = sessions[0].projectName;
    sessions.sort((a, b) => {
      const d = statusOrder[a.status] - statusOrder[b.status];
      if (d !== 0) return d;
      return b.lastModifiedMs - a.lastModifiedMs;
    });
    allProjects.push({
      name: projectName,
      projectPath,
      sessions,
      hotness: sessions[0].status,
      hidden: config.hiddenProjects.includes(projectName) || undefined,
    });
  }

  const activeProjects = allProjects.filter((p) => p.hotness !== "cold");
  const coldProjects = allProjects.filter((p) => p.hotness === "cold");
  activeProjects.sort((a, b) => {
    const d = statusOrder[a.hotness] - statusOrder[b.hotness];
    if (d !== 0) return d;
    return b.sessions[0].lastModifiedMs - a.sessions[0].lastModifiedMs;
  });

  const count = (projects: ProjectNode[]) =>
    projects.reduce(
      (sum, p) =>
        sum +
        p.sessions.length +
        p.sessions.reduce((s, sn) => s + sn.subAgents.length, 0),
      0,
    );

  return {
    projects: activeProjects,
    coldProjects,
    totalCount: count(activeProjects) + count(coldProjects),
    timestamp: new Date().toISOString(),
    hiddenStats: { total: hiddenTotal, active: hiddenActive },
  };
}

// --- activities ---

// pi args use `path`; the shared summarizers expect Claude's `file_path`.
function normalizeToolInput(args: unknown): ToolInput | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return undefined;
  const rec = args as Record<string, unknown>;
  const input = { ...rec } as ToolInput;
  if (typeof input.file_path !== "string" && typeof rec.path === "string") {
    input.file_path = rec.path;
  }
  return input;
}

interface PiToolResult {
  isError?: boolean;
  text: string;
}

function pushToolCall(
  activities: ActivityEntry[],
  ts: Date,
  block: PiBlock,
  resultsById: Map<string, PiToolResult>,
): void {
  const name = block.name as string;
  // TodoWrite churn is noise in the activity stream (Claude does the same).
  if (name.toLowerCase() === "todowrite" || name.toLowerCase() === "todo") {
    return;
  }
  const label = canonicalToolLabel(name);
  const icon = iconForCanonicalLabel(label);
  const input = normalizeToolInput(block.arguments);
  let detail = "";
  try {
    // pi tool results carry no structured fields (no toolUseResult), so
    // the input-driven summarizer path is all we get. The try/catch is
    // defensive: args can drift across pi versions and must never crash
    // the whole activity parse.
    detail = summarizeToolDetail(label, input, undefined);
  } catch {
    detail = "";
  }
  if (!detail && input) {
    // Last-resort detail: the command or the target file basename, so a
    // tool with an unrecognised arg shape still shows something useful.
    const target = input.command ?? input.file_path;
    if (typeof target === "string" && target.trim()) {
      detail = firstLine(basename(target) || target);
    }
  }
  const last = activities[activities.length - 1];
  if (
    last &&
    last.type === "tool" &&
    last.label === label &&
    last.detail === detail
  ) {
    last.count = (last.count ?? 1) + 1;
    last.timestamp = ts;
  } else {
    activities.push({ timestamp: ts, type: "tool", icon, label, detail });
  }
}

export function parsePiActivities(lines: string[]): ParseResult {
  const entries = parsePiEntries(lines);
  const activities: ActivityEntry[] = [];
  let modelName: string | null = null;
  let tokenCount = 0;

  // The header (type:"session") is NOT linked into the parentId chain —
  // the first real entry has parentId:null — so it never lands in the
  // walked branch. Prefer its timestamp as the session start when
  // present (whole-file parses); windowed tail parses fall back to the
  // first branch entry.
  const headerEntry = entries.find((e) => e.type === "session");
  let sessionStartTime: Date | null = headerEntry?.timestamp
    ? new Date(headerEntry.timestamp)
    : null;

  if (entries.length === 0) {
    return { activities, tokenCount, modelName, sessionStartTime };
  }

  const branch = walkActiveBranch(entries);

  // Pre-pass: toolCallId → result (pi stores results as separate
  // toolResult messages, like Claude). Windowed parses keep a call and
  // its result together because the seam sits at a turn boundary.
  const resultsById = new Map<string, PiToolResult>();
  for (const e of branch) {
    if (e.type === "message" && e.message?.role === "toolResult") {
      const id = e.message.toolCallId;
      if (id && !resultsById.has(id)) {
        resultsById.set(id, {
          isError: e.message.isError,
          text: messageText(e.message) ?? "",
        });
      }
    }
  }

  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (!e) continue;
    if (
      e.type === "model_change" &&
      typeof e.modelId === "string" &&
      e.modelId.length > 0
    ) {
      modelName = e.modelId;
      break;
    }
  }

  for (const e of branch) {
    const ts = e.timestamp ? new Date(e.timestamp) : new Date(0);
    if (sessionStartTime === null && e.timestamp) sessionStartTime = ts;

    if (e.type === "message" && e.message) {
      const msg = e.message;
      if (msg.role === "user") {
        const text = messageText(msg);
        if (!text) continue;
        activities.push({
          timestamp: ts,
          type: "user",
          icon: ICONS.User,
          label: "User",
          detail: firstLine(text),
          detailBody: text,
        });
      } else if (msg.role === "assistant") {
        if (!modelName && typeof msg.model === "string") modelName = msg.model;
        if (isUsableUsage(msg)) tokenCount += usageTotal(msg.usage);
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (
              block.type === "thinking" &&
              typeof block.thinking === "string" &&
              block.thinking.trim()
            ) {
              activities.push({
                timestamp: ts,
                type: "thinking",
                icon: ICONS.Thinking,
                label: "Thinking",
                detail: block.thinking,
              });
            } else if (block.type === "toolCall" && block.name) {
              pushToolCall(activities, ts, block, resultsById);
            } else if (
              block.type === "text" &&
              typeof block.text === "string" &&
              block.text.trim()
            ) {
              activities.push({
                timestamp: ts,
                type: "response",
                icon: ICONS.Response,
                label: "Response",
                detail: firstLine(block.text),
                detailBody: block.text,
              });
            }
          }
        }
      } else if (msg.role === "bashExecution") {
        const command = typeof msg.command === "string" ? msg.command : "";
        if (!command.trim()) continue;
        activities.push({
          timestamp: ts,
          type: "tool",
          icon: ICONS.Bash,
          label: "Bash",
          detail: firstLine(command),
          detailBody: typeof msg.output === "string" ? msg.output : undefined,
          detailKind: "code",
        });
      }
      // system / toolResult / custom: no standalone activity.
    } else if (e.type === "compaction") {
      const detail =
        typeof e.tokensBefore === "number" && e.tokensBefore > 0
          ? `Context compacted (~${e.tokensBefore} tokens before)`
          : "Context compacted";
      activities.push({
        timestamp: ts,
        type: "response",
        icon: ICONS.Thinking,
        label: "Compaction",
        detail,
        detailBody: typeof e.summary === "string" ? e.summary : undefined,
      });
    } else if (e.type === "branch_summary") {
      if (typeof e.summary === "string" && e.summary.trim()) {
        activities.push({
          timestamp: ts,
          type: "response",
          icon: ICONS.Response,
          label: "Branch",
          detail: firstLine(e.summary),
          detailBody: e.summary,
        });
      }
    }
    // header / model_change / thinking_level_change / session_info /
    // usage / label / context_edit / custom_message: no activity.
  }

  return { activities, tokenCount, modelName, sessionStartTime };
}

export const piProvider: SessionProvider = {
  name: "pi",
  lineDelimited: true,
  isTurnBoundary: (line) => {
    try {
      const e = JSON.parse(line) as PiEntry;
      if (e.type === "compaction" || e.type === "branch_summary") return true;
      if (e.type === "message") {
        const role = e.message?.role;
        return role === "user" || role === "bashExecution" || role === "custom";
      }
      return false;
    } catch {
      return false;
    }
  },
  isAvailable: () => existsSync(getPiSessionsDir()),
  discoverSessions: discoverPiSessions,
  parseActivities: parsePiActivities,
};
