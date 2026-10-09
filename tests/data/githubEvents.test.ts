/**
 * Spec for GitHub corp events as a `--with-git` data source.
 *
 * The per-session `git log` only covers repos that have agent
 * sessions on the day, and only the checked-out branch — manual work
 * (pushed commits, PRs, reviews, comments) done outside a tracked
 * agent session never reaches the report. This module fills that gap
 * via `gh api /users/<me>/events` (corp host only, github.com
 * intentionally out of scope).
 *
 * Behavior under test:
 * - eventsToActivities: pure mapping of raw GitHub events to
 *   ActivityEntry rows (commits, PRs, reviews, comments)
 * - author filtering on pushes (a push can carry other people's
 *   commits — e.g. pushing a colleague's branch to a fork)
 * - fetchGitHubActivities: local-date windowing, pagination stop,
 *   cache (past dates permanent, today 10-minute TTL), and graceful
 *   degradation when gh is unavailable
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { GitHubIdentity } from "../../src/data/githubEvents.js";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
}));

const { execSync } = await import("node:child_process");
const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
const { eventsToActivities, fetchGitHubActivities } = await import(
  "../../src/data/githubEvents.js"
);

const ME: GitHubIdentity = {
  login: "bedong",
  name: "bedong",
  email: "bedong@ebay.com",
};
const COLLEAGUE = { name: "qiffang", email: "qiffang@eBay.com" };

// ── eventsToActivities ─────────────────────────────────────────────

describe("eventsToActivities", () => {
  it("maps my PushEvent commits to commit rows with repo, ref, and message", () => {
    const acts = eventsToActivities(
      [
        {
          type: "PushEvent",
          created_at: "2026-10-08T10:16:39Z",
          repo: { name: "cloud/cloud-cicd-mcp" },
          payload: {
            ref: "refs/heads/CLOUDSRE-10582-sso-session-issuer",
            commits: [
              {
                sha: "584fc80abc1234567890abcdef1234567890abcdef",
                message:
                  "CLOUDSRE-10582: Reject redirects when resolving the SSO issuer\n\nbody line 2",
                author: { name: "bedong", email: "bedong@ebay.com" },
              },
            ],
          },
        },
      ],
      ME,
    );
    expect(acts).toHaveLength(1);
    expect(acts[0].type).toBe("commit");
    expect(acts[0].icon).toBe("◆");
    expect(acts[0].label).toBe("584fc80");
    expect(acts[0].detail).toContain("cloud/cloud-cicd-mcp");
    expect(acts[0].detail).toContain("CLOUDSRE-10582-sso-session-issuer");
    expect(acts[0].detail).toContain(
      "CLOUDSRE-10582: Reject redirects when resolving the SSO issuer",
    );
    expect(acts[0].detail).not.toContain("body line 2"); // first line only
  });

  it("drops commits authored by others inside my push", () => {
    const acts = eventsToActivities(
      [
        {
          type: "PushEvent",
          created_at: "2026-10-09T01:48:49Z",
          repo: { name: "bedong/managedci" },
          payload: {
            ref: "refs/heads/feature/ci-cluster-build-pr-url",
            commits: [
              {
                sha: "68a570c111111111111111111111111111111111",
                message:
                  "CLOUDSRE-10578: Fix synthetic PR and push probe payloads (#1113)",
                author: COLLEAGUE,
              },
              {
                sha: "aaaaaaabbbbbbbccccccdddddddeeeeeeeffffff",
                message: "my fix",
                author: { name: "bedong", email: "bedong@ebay.com" },
              },
            ],
          },
        },
      ],
      ME,
    );
    expect(acts).toHaveLength(1);
    expect(acts[0].label).toBe("aaaaaaa");
    expect(acts[0].detail).toContain("my fix");
  });

  it("keeps commits with no author info (cannot verify identity)", () => {
    const acts = eventsToActivities(
      [
        {
          type: "PushEvent",
          created_at: "2026-10-08T10:16:39Z",
          repo: { name: "cloud/cloud-cicd-mcp" },
          payload: {
            ref: "refs/heads/main",
            commits: [
              {
                sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                message: "mystery commit",
                author: null,
              },
            ],
          },
        },
      ],
      ME,
    );
    expect(acts).toHaveLength(1);
    expect(acts[0].label).toBe("deadbee");
  });

  it("maps PR opened / merged / closed, ignores noise actions", () => {
    const pr = (action: string, mergedAt: string | null) => ({
      type: "PullRequestEvent",
      created_at: "2026-10-08T09:53:26Z",
      repo: { name: "cloud/cloud-cicd-mcp" },
      payload: {
        action,
        pull_request: {
          number: 21,
          title:
            "CLOUDSRE-10582: Resolve SiteIAM SSO issuer from OIDC discovery",
          merged_at: mergedAt,
        },
      },
    });
    const acts = eventsToActivities(
      [
        pr("opened", null),
        pr("closed", "2026-10-09T00:48:00Z"),
        pr("closed", null),
        pr("synchronize", null),
        pr("assigned", null),
      ],
      ME,
    );
    expect(acts.map((a) => a.label)).toEqual([
      "PR #21 opened",
      "PR #21 merged",
      "PR #21 closed",
    ]);
    expect(acts[0].type).toBe("github");
    expect(acts[0].detail).toContain("cloud/cloud-cicd-mcp");
    expect(acts[0].detail).toContain("CLOUDSRE-10582");
  });

  it("maps review events with their state", () => {
    const acts = eventsToActivities(
      [
        {
          type: "PullRequestReviewEvent",
          created_at: "2026-10-08T07:00:00Z",
          repo: { name: "cloud/mcd-controller" },
          payload: {
            action: "submitted",
            review: { state: "approved" },
            pull_request: { number: 42, title: "some PR" },
          },
        },
        {
          type: "PullRequestReviewEvent",
          created_at: "2026-10-08T07:05:00Z",
          repo: { name: "cloud/mcd-controller" },
          payload: {
            action: "edited",
            review: { state: "approved" },
            pull_request: { number: 42, title: "some PR" },
          },
        },
      ],
      ME,
    );
    expect(acts).toHaveLength(1);
    expect(acts[0].label).toBe("review: approved");
    expect(acts[0].detail).toContain("cloud/mcd-controller#42");
    expect(acts[0].detail).toContain("some PR");
  });

  it("maps issue comments, truncating the body to 120 chars", () => {
    const longBody = "x".repeat(200);
    const acts = eventsToActivities(
      [
        {
          type: "IssueCommentEvent",
          created_at: "2026-10-08T09:51:48Z",
          repo: { name: "cloud/managedci" },
          payload: {
            action: "created",
            issue: { number: 1108, title: "an issue", pull_request: null },
            comment: { body: `${longBody}\nsecond line` },
          },
        },
      ],
      ME,
    );
    expect(acts).toHaveLength(1);
    expect(acts[0].label).toBe("comment");
    expect(acts[0].detail).toContain("cloud/managedci#1108");
    expect(acts[0].detail).toContain("an issue");
    expect(acts[0].detail).toContain("x".repeat(120));
    expect(acts[0].detail).not.toContain("x".repeat(121));
    expect(acts[0].detail).not.toContain("second line");
  });

  it("ignores unrelated event types", () => {
    const acts = eventsToActivities(
      [
        {
          type: "WatchEvent",
          created_at: "2026-10-08T01:00:00Z",
          repo: { name: "a/b" },
          payload: {},
        },
        {
          type: "ForkEvent",
          created_at: "2026-10-08T01:00:00Z",
          repo: { name: "a/b" },
          payload: {},
        },
        {
          type: "CreateEvent",
          created_at: "2026-10-08T01:00:00Z",
          repo: { name: "a/b" },
          payload: {},
        },
        {
          type: "DeleteEvent",
          created_at: "2026-10-08T01:00:00Z",
          repo: { name: "a/b" },
          payload: {},
        },
      ],
      ME,
    );
    expect(acts).toHaveLength(0);
  });

  it("sorts the result by timestamp", () => {
    const acts = eventsToActivities(
      [
        {
          type: "IssueCommentEvent",
          created_at: "2026-10-08T12:00:00Z",
          repo: { name: "a/b" },
          payload: {
            action: "created",
            issue: { number: 1, title: "later" },
            comment: { body: "hi" },
          },
        },
        {
          type: "PullRequestEvent",
          created_at: "2026-10-08T09:00:00Z",
          repo: { name: "a/b" },
          payload: {
            action: "opened",
            pull_request: { number: 2, title: "earlier", merged_at: null },
          },
        },
      ],
      ME,
    );
    expect(acts.map((a) => a.label)).toEqual(["PR #2 opened", "comment"]);
  });
});

// ── fetchGitHubActivities ──────────────────────────────────────────

// A date guaranteed to be in the past for the TTL rules.
const PAST = new Date(2020, 0, 1); // local 2020-01-01

function pastWindowTimes() {
  const start = new Date(2020, 0, 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(2020, 0, 2);
  end.setHours(0, 0, 0, 0);
  return {
    start,
    end,
    inside: new Date(start.getTime() + 3_600_000).toISOString(),
    before: new Date(start.getTime() - 3_600_000).toISOString(),
    after: new Date(end.getTime() + 3_600_000).toISOString(),
  };
}

function prEvent(createdAt: string, number = 1, title = "t") {
  return {
    type: "PullRequestEvent",
    created_at: createdAt,
    repo: { name: "a/b" },
    payload: {
      action: "opened",
      pull_request: { number, title, merged_at: null },
    },
  };
}

function mockGh(
  pages: unknown[][],
  user = { login: "bedong", name: "bedong", email: "bedong@ebay.com" },
) {
  vi.mocked(execSync).mockImplementation((cmd: string) => {
    const c = String(cmd);
    // NOTE: exact match — "/user" is a substring of "/users/<login>/events"
    if (c === "gh api /user") return JSON.stringify(user);
    // "/page=/" — "per_page=100" contains the substring "page=100"
    const page = Number((c.match(/&page=(\d+)/) ?? [])[1] ?? 1);
    const batch = pages[page - 1];
    if (batch === undefined) throw new Error(`unexpected page ${page}`);
    return JSON.stringify(batch);
  });
}

beforeAll(() => {
  process.env.AGENTHUD_HOME = "/tmp/agenthud-github-events-test";
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(existsSync).mockReturnValue(false);
});

afterEach(() => {
  delete process.env.AGENTHUD_HOME;
});

describe("fetchGitHubActivities", () => {
  it("returns [] without throwing when gh is unavailable", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("gh not found");
    });
    const acts = fetchGitHubActivities(PAST);
    expect(acts).toEqual([]);
    // the warning is emitted once per process, not per call
    fetchGitHubActivities(PAST);
    const userCalls = vi
      .mocked(execSync)
      .mock.calls.filter((c) => String(c[0]) === "gh api /user").length;
    expect(userCalls).toBe(2);
  });

  it("returns [] when /user fails", () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (String(cmd) === "gh api /user") throw new Error("not logged in");
      return "[]";
    });
    expect(fetchGitHubActivities(PAST)).toEqual([]);
  });

  it("keeps only events inside the local date window", () => {
    const t = pastWindowTimes();
    mockGh([[prEvent(t.after), prEvent(t.inside), prEvent(t.before)]]);
    const acts = fetchGitHubActivities(PAST);
    expect(acts).toHaveLength(1);
    expect(acts[0].timestamp.toISOString()).toBe(t.inside);
  });

  it("paginates until the window start is reached", () => {
    const t = pastWindowTimes();
    // page 1: full page (100) all after the window → must fetch page 2
    const page1 = Array.from({ length: 100 }, (_, i) =>
      prEvent(t.after, i + 1),
    );
    // page 2: contains in-window events and ends before the window
    const page2 = [prEvent(t.inside, 500), prEvent(t.before, 501)];
    mockGh([page1, page2]);
    const acts = fetchGitHubActivities(PAST);
    const pagesFetched = vi
      .mocked(execSync)
      .mock.calls.filter((c) => String(c[0]).includes("/events")).length;
    expect(pagesFetched).toBe(2);
    // only the in-window event survives mapping
    expect(acts).toHaveLength(1);
    expect(acts[0].label).toBe("PR #500 opened");
  });

  it("stops after a short page (no further pagination)", () => {
    const t = pastWindowTimes();
    mockGh([[prEvent(t.inside)]]);
    fetchGitHubActivities(PAST);
    const pagesFetched = vi
      .mocked(execSync)
      .mock.calls.filter((c) => String(c[0]).includes("/events")).length;
    expect(pagesFetched).toBe(1);
  });

  it("serves a past date from cache without calling the events API", () => {
    const t = pastWindowTimes();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        fetchedAt: Date.now() - 3600_000,
        complete: true,
        events: [prEvent(t.inside, 7, "cached")],
      }),
    );
    mockGh([]);
    const acts = fetchGitHubActivities(PAST);
    expect(acts).toHaveLength(1);
    expect(acts[0].detail).toContain("cached");
    // /user is allowed (login needed for the cache path); the events
    // feed must not be hit
    expect(
      vi
        .mocked(execSync)
        .mock.calls.some((c) => String(c[0]).includes("/events")),
    ).toBe(false);
  });

  it("ignores an incomplete cache for a past date", () => {
    const t = pastWindowTimes();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        fetchedAt: Date.now() - 3600_000,
        complete: false,
        events: [prEvent(t.inside, 7, "cached")],
      }),
    );
    mockGh([[prEvent(t.inside, 8, "fresh")]]);
    const acts = fetchGitHubActivities(PAST);
    expect(acts).toHaveLength(1);
    expect(acts[0].detail).toContain("fresh");
  });

  it("refetches today's cache after the TTL (10 minutes)", () => {
    const today = new Date();
    // local midnight + 1s: always inside today's window regardless of
    // when the suite runs
    const insideBase = new Date(today);
    insideBase.setHours(0, 0, 0, 1);
    const inside = insideBase.toISOString();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        fetchedAt: Date.now() - 11 * 60_000,
        complete: true,
        events: [prEvent(inside, 7, "stale")],
      }),
    );
    mockGh([[prEvent(inside, 8, "fresh")]]);
    const acts = fetchGitHubActivities(today);
    expect(acts).toHaveLength(1);
    expect(acts[0].detail).toContain("fresh");
    // and the fresh fetch is written back to the cache
    expect(vi.mocked(writeFileSync)).toHaveBeenCalled();
  });

  it("reuses today's cache while fresh", () => {
    const today = new Date();
    const insideBase = new Date(today);
    insideBase.setHours(0, 0, 0, 1);
    const inside = insideBase.toISOString();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        fetchedAt: Date.now() - 60_000,
        complete: true,
        events: [prEvent(inside, 7, "cached")],
      }),
    );
    mockGh([]);
    const acts = fetchGitHubActivities(today);
    expect(acts).toHaveLength(1);
    expect(acts[0].detail).toContain("cached");
    expect(
      vi
        .mocked(execSync)
        .mock.calls.some((c) => String(c[0]).includes("/events")),
    ).toBe(false);
  });

  it("bypasses the cache with force", () => {
    const t = pastWindowTimes();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        fetchedAt: Date.now() - 3600_000,
        complete: true,
        events: [prEvent(t.inside, 7, "cached")],
      }),
    );
    mockGh([[prEvent(t.inside, 8, "forced")]]);
    const acts = fetchGitHubActivities(PAST, { force: true });
    expect(acts).toHaveLength(1);
    expect(acts[0].detail).toContain("forced");
  });

  it("writes the fetched window to the cache", () => {
    const t = pastWindowTimes();
    mockGh([[prEvent(t.inside, 1, "new")]]);
    fetchGitHubActivities(PAST);
    expect(vi.mocked(writeFileSync)).toHaveBeenCalled();
    const [path, body] = vi.mocked(writeFileSync).mock.calls[0];
    expect(String(path)).toContain("bedong");
    expect(String(path)).toContain("2020-01-01");
    const parsed = JSON.parse(String(body));
    expect(parsed.complete).toBe(true);
    expect(parsed.events).toHaveLength(1);
  });
});
