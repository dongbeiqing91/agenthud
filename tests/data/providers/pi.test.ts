import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const { existsSync, readdirSync, statSync, readFileSync } = await import(
  "node:fs"
);
const { piProvider, parsePiActivities, clearPiMetaCache } = await import(
  "../../../src/data/providers/pi.js"
);

const NOW = 1_700_000_000_000;

const mockConfig = {
  refreshIntervalMs: 2000,
  hiddenSessions: [] as string[],
  hiddenSubAgents: [] as string[],
  filterPresets: [[]] as string[][],
  hiddenProjects: [] as string[],
};

const ROOT = join("/tmp", "pi-test", "sessions");
const PROJECT_DIR = join(ROOT, "--Users-neo-piapp--");
const CWD = "/Users/neo/piapp";
const MODEL_ID = "qwen3-8-27b-fp8-gpu/qwen3-8-27b-fp8";
const PROVIDER_KEY = "magpie";

function setRoot() {
  process.env.PI_SESSIONS_DIR = ROOT;
}

afterEach(() => {
  vi.resetAllMocks();
  clearPiMetaCache();
  delete process.env.PI_SESSIONS_DIR;
});

// --- fixture builders (mirror the real pi JSONL shapes) ---

function header(over: Record<string, unknown> = {}) {
  return {
    type: "session",
    version: 3,
    id: "01a11fe5-9361-7153-8624-7219e4b0fdb7",
    timestamp: "2026-10-09T09:01:41.601Z",
    cwd: CWD,
    ...over,
  };
}

function modelChange(id: string, parentId: string | null, modelId: string) {
  return {
    type: "model_change",
    id,
    parentId,
    timestamp: "2026-10-09T09:01:42.000Z",
    provider: PROVIDER_KEY,
    modelId,
  };
}

function userMsg(id: string, parentId: string | null, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-09T09:01:52.000Z",
    message: { role: "user", content: text },
  };
}

function assistantMsg(
  id: string,
  parentId: string | null,
  blocks: object[],
  over: Record<string, unknown> = {},
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-09T09:02:00.000Z",
    message: {
      role: "assistant",
      content: blocks,
      provider: PROVIDER_KEY,
      model: MODEL_ID,
      stopReason: "stop",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 50,
        cacheWrite: 0,
        totalTokens: 52428,
      },
      ...over,
    },
  };
}

function sessionInfo(id: string, parentId: string, name: string) {
  return {
    type: "session_info",
    id,
    parentId,
    timestamp: "2026-10-09T09:02:30.000Z",
    name,
  };
}

function compaction(
  id: string,
  parentId: string,
  over: Record<string, unknown> = {},
) {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-10-09T09:02:40.000Z",
    summary: "Earlier work: parsed the config module.",
    tokensBefore: 50000,
    ...over,
  };
}

function toolResult(
  id: string,
  parentId: string,
  toolCallId: string,
  text: string,
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-09T09:02:10.000Z",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text }],
    },
  };
}

// A complete healthy session: header → model → user → assistant(tool) →
// toolResult → assistant(text) → session_info. Leaf is the last line.
function healthyRecords() {
  return [
    header(),
    modelChange("m1", null, MODEL_ID),
    userMsg("u1", "m1", "read the config"),
    assistantMsg(
      "a1",
      "u1",
      [
        { type: "thinking", thinking: "I should read the file." },
        {
          type: "toolCall",
          id: "tc1",
          name: "read",
          arguments: { path: join(CWD, "config.yaml") },
        },
      ],
      { stopReason: "toolUse" },
    ),
    toolResult("r1", "a1", "tc1", "key: value"),
    assistantMsg("a2", "r1", [
      { type: "text", text: "The config has one key set." },
    ]),
    sessionInfo("s1", "a2", "Config exploration"),
  ];
}

function recordsToLines(records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

// Mock the sessions tree: ROOT contains one project dir with the given
// session files. `old` files get a 2-day mtime (cold status).
function mockTree(files: Record<string, string>, oldFiles: string[] = []) {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readdirSync).mockImplementation((p) => {
    const path = String(p);
    if (path === ROOT)
      return ["--Users-neo-piapp--"] as unknown as ReturnType<
        typeof readdirSync
      >;
    if (path === PROJECT_DIR)
      return Object.keys(files) as unknown as ReturnType<typeof readdirSync>;
    return [] as unknown as ReturnType<typeof readdirSync>;
  });
  vi.mocked(statSync).mockImplementation((p) => {
    const path = String(p);
    const isFile = path.endsWith(".jsonl") || path.endsWith(".json");
    const isOld = oldFiles.some((f) => path.endsWith(f));
    return {
      isDirectory: () => !isFile,
      mtimeMs: isOld ? NOW - 2 * 24 * 3600 * 1000 : NOW - 60_000,
      size: 1000,
    } as ReturnType<typeof statSync>;
  });
  const modelsJson = JSON.stringify({
    providers: {
      [PROVIDER_KEY]: { models: [{ id: MODEL_ID, contextWindow: 131072 }] },
    },
  });
  vi.mocked(readFileSync).mockImplementation((p) => {
    const path = String(p);
    if (path.endsWith("models.json")) return modelsJson;
    for (const [name, content] of Object.entries(files)) {
      if (path.endsWith(name)) return content;
    }
    return "";
  });
  vi.spyOn(Date, "now").mockReturnValue(NOW);
}

function allNodes(tree: ReturnType<typeof piProvider.discoverSessions>) {
  return [
    ...tree.projects.flatMap((p) => p.sessions),
    ...tree.coldProjects.flatMap((p) => p.sessions),
  ];
}

describe("piProvider.isAvailable", () => {
  it("false when the sessions root is missing", () => {
    setRoot();
    vi.mocked(existsSync).mockReturnValue(false);
    expect(piProvider.isAvailable()).toBe(false);
  });

  it("true when the root exists", () => {
    setRoot();
    vi.mocked(existsSync).mockReturnValue(true);
    expect(piProvider.isAvailable()).toBe(true);
  });
});

describe("piProvider.discoverSessions", () => {
  it("discovers a session grouped by the header cwd", () => {
    setRoot();
    mockTree({
      "2026-10-09T09-01-41-601Z_sid1.jsonl": recordsToLines(healthyRecords()),
    });

    const tree = piProvider.discoverSessions(mockConfig);
    expect(tree.projects).toHaveLength(1);
    expect(tree.projects[0].name).toBe("piapp");
    expect(tree.projects[0].projectPath).toBe(CWD);

    const s = tree.projects[0].sessions[0];
    expect(s.id).toBe("01a11fe5-9361-7153-8624-7219e4b0fdb7");
    expect(s.provider).toBe("pi");
    expect(s.modelName).toBe(MODEL_ID);
    // title: session_info wins over user messages
    expect(s.firstUserPrompt).toBe("Config exploration");
    // context gauge: 52428 / 131072 = 40%
    expect(s.contextUsage?.percent).toBe(40);
    expect(s.contextUsage?.total).toBe(131072);
    expect(s.hideKey).toBe("piapp/01a11fe5-9361-7153-8624-7219e4b0fdb7");
    expect(s.version).toBe("3");
    expect(s.status).toBe("hot");
    expect(tree.totalCount).toBe(1);
  });

  it("falls back to the latest substantial user message for the title", () => {
    setRoot();
    mockTree({
      "x_sid2.jsonl": recordsToLines([
        header({ id: "sid2" }),
        modelChange("m1", null, MODEL_ID),
        userMsg("u1", "m1", "first prompt"),
        assistantMsg("a1", "u1", [
          { type: "text", text: "Working on it, here is a reply." },
        ]),
        userMsg("u2", "a1", "second question"),
        assistantMsg("a2", "u2", [
          { type: "text", text: "Another reply that is long enough." },
        ]),
      ]),
    });

    const tree = piProvider.discoverSessions(mockConfig);
    const s = allNodes(tree)[0];
    expect(s.firstUserPrompt).toBe("second question");
  });

  it("excludes dead branches (rolled-back forks) from meta", () => {
    setRoot();
    // Common prefix, then a dead fork (user + model_change), then the
    // active branch continues from the common leaf. File order:
    // dead entries land BEFORE the active ones, so the file's last
    // line is the active leaf.
    mockTree({
      "x_sid3.jsonl": recordsToLines([
        header({ id: "sid3" }),
        modelChange("m1", null, "old/old-model"),
        userMsg("u1", "m1", "start"),
        assistantMsg("a1", "u1", [
          { type: "text", text: "Acknowledged, starting work now." },
        ]),
        // dead fork (rolled back, never revisited)
        userMsg("d1", "a1", "abandoned question"),
        modelChange("d2", "d1", "dead/dead-model"),
        // active continuation from a1
        userMsg("u2", "a1", "real question"),
        modelChange("m2", "u2", MODEL_ID),
        assistantMsg("a2", "m2", [
          { type: "text", text: "Answering the real question now." },
        ]),
      ]),
    });

    const tree = piProvider.discoverSessions(mockConfig);
    const s = allNodes(tree)[0];
    expect(s.firstUserPrompt).toBe("real question");
    expect(s.modelName).toBe(MODEL_ID);
    // dead branch's model_change must not be seen
    expect(s.modelName).not.toBe("dead/dead-model");
  });

  it("respects hiddenSessions config", () => {
    setRoot();
    mockTree({ "x_sid1.jsonl": recordsToLines(healthyRecords()) });
    const tree = piProvider.discoverSessions({
      ...mockConfig,
      hiddenSessions: ["piapp/01a11fe5-9361-7153-8624-7219e4b0fdb7"],
    });
    expect(tree.projects[0].sessions[0].hidden).toBe(true);
    expect(tree.hiddenStats.total).toBe(1);
  });

  it("moves projects whose sessions are all stale to coldProjects", () => {
    setRoot();
    mockTree({ "x_old.jsonl": recordsToLines(healthyRecords()) }, [
      "x_old.jsonl",
    ]);
    const tree = piProvider.discoverSessions(mockConfig);
    expect(tree.projects).toHaveLength(0);
    expect(tree.coldProjects).toHaveLength(1);
    expect(tree.coldProjects[0].hotness).toBe("cold");
  });

  it("empty tree when the root is missing", () => {
    setRoot();
    vi.mocked(existsSync).mockReturnValue(false);
    const tree = piProvider.discoverSessions(mockConfig);
    expect(tree.projects).toHaveLength(0);
    expect(tree.totalCount).toBe(0);
  });

  it("skips context gauge when models.json is absent", () => {
    setRoot();
    mockTree({ "x_sid1.jsonl": recordsToLines(healthyRecords()) });
    // override: models.json unreadable
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("models.json")) return "";
      return recordsToLines(healthyRecords());
    });
    const tree = piProvider.discoverSessions(mockConfig);
    const s = allNodes(tree)[0];
    expect(s.contextUsage).toBeUndefined();
  });
});

describe("parsePiActivities", () => {
  it("maps user / assistant text / thinking entries", () => {
    const lines = recordsToLines([
      header(),
      modelChange("m1", null, MODEL_ID),
      userMsg("u1", "m1", "read the config"),
      assistantMsg("a1", "u1", [
        { type: "thinking", thinking: "Let me look." },
        { type: "text", text: "The config has one key set." },
      ]),
    ]).split("\n");

    const { activities, sessionStartTime } = parsePiActivities(lines);
    expect(activities.map((a) => a.type)).toEqual([
      "user",
      "thinking",
      "response",
    ]);
    expect(activities[0].detail).toBe("read the config");
    expect(activities[2].detail).toBe("The config has one key set.");
    expect(sessionStartTime?.toISOString()).toBe("2026-10-09T09:01:41.601Z");
  });

  it("maps toolCalls to canonical labels with input-based details", () => {
    const lines = recordsToLines([
      header(),
      userMsg("u1", null, "go"),
      assistantMsg("a1", "u1", [
        {
          type: "toolCall",
          id: "tc1",
          name: "read",
          arguments: { path: join(CWD, "config.yaml") },
        },
        {
          type: "toolCall",
          id: "tc2",
          name: "bash",
          arguments: { command: "npm test" },
        },
        {
          type: "toolCall",
          id: "tc3",
          name: "lens_diagnostics",
          arguments: {},
        },
      ]),
      toolResult("r1", "a1", "tc1", "content"),
      toolResult("r2", "a1", "tc2", "ok"),
      toolResult("r3", "a1", "tc3", "ok"),
      assistantMsg("a2", "r3", [
        { type: "text", text: "Done with the three tool calls above." },
      ]),
    ]).split("\n");

    const { activities } = parsePiActivities(lines);
    const tools = activities.filter((a) => a.type === "tool");
    expect(tools.map((t) => t.label)).toEqual([
      "Read",
      "Bash",
      "lens_diagnostics",
    ]);
    // read detail comes from the path argument (normalized to file_path)
    expect(tools[0].detail).toBe("config.yaml");
    expect(tools[1].detail).toBe("npm test");
    // unknown tool passes through with its raw name
    expect(tools[2].icon).not.toBeUndefined();
  });

  it("merges consecutive identical tool calls", () => {
    const lines = recordsToLines([
      header(),
      userMsg("u1", null, "go"),
      assistantMsg("a1", "u1", [
        {
          type: "toolCall",
          id: "tc1",
          name: "read",
          arguments: { path: join(CWD, "a.ts") },
        },
        {
          type: "toolCall",
          id: "tc2",
          name: "read",
          arguments: { path: join(CWD, "a.ts") },
        },
      ]),
      toolResult("r1", "a1", "tc1", "x"),
      toolResult("r2", "a1", "tc2", "y"),
      assistantMsg("a2", "r2", [
        { type: "text", text: "Finished reading the same file twice." },
      ]),
    ]).split("\n");

    const { activities } = parsePiActivities(lines);
    const reads = activities.filter((a) => a.label === "Read");
    expect(reads).toHaveLength(1);
    expect(reads[0].count).toBe(2);
  });

  it("renders compaction and branch_summary entries as response rows", () => {
    const lines = recordsToLines([
      header(),
      userMsg("u1", null, "start"),
      assistantMsg("a1", "u1", [
        { type: "text", text: "Some work happens here in the session." },
      ]),
      compaction("c1", "a1"),
      userMsg("u2", "c1", "continue"),
      assistantMsg("a2", "u2", [
        { type: "text", text: "Continuing after compaction now." },
      ]),
    ]).split("\n");

    const { activities } = parsePiActivities(lines);
    const comp = activities.find((a) => a.label === "Compaction");
    expect(comp).toBeDefined();
    expect(comp?.detailBody).toBe("Earlier work: parsed the config module.");
    expect(activities.some((a) => a.detail === "start")).toBe(true);
  });

  it("maps bashExecution messages to Bash rows", () => {
    const lines = recordsToLines([
      header(),
      {
        type: "message",
        id: "b1",
        parentId: null,
        timestamp: "2026-10-09T09:02:00.000Z",
        message: {
          role: "bashExecution",
          command: "ls -la",
          output: "total 8",
        },
      },
    ]).split("\n");

    const { activities } = parsePiActivities(lines);
    expect(activities).toHaveLength(1);
    expect(activities[0].type).toBe("tool");
    expect(activities[0].label).toBe("Bash");
    expect(activities[0].detail).toBe("ls -la");
    expect(activities[0].detailBody).toBe("total 8");
  });

  it("excludes dead-branch lines in a windowed parse", () => {
    // A tail window: common prefix + dead fork + active continuation.
    // The leaf is the last line; dead entries are off-path.
    const lines = recordsToLines([
      userMsg("u1", null, "start"),
      assistantMsg("a1", "u1", [
        { type: "text", text: "Acknowledged, starting work now." },
      ]),
      userMsg("d1", "a1", "abandoned question"),
      assistantMsg("d2", "d1", [
        { type: "text", text: "Answer to the abandoned question here." },
      ]),
      userMsg("u2", "a1", "real question"),
      assistantMsg("a2", "u2", [
        { type: "text", text: "Answering the real question now." },
      ]),
    ]).split("\n");

    const { activities } = parsePiActivities(lines);
    expect(activities.some((a) => a.detail === "abandoned question")).toBe(
      false,
    );
    expect(activities.some((a) => a.detail === "real question")).toBe(true);
    expect(activities.some((a) => a.detail === "start")).toBe(true);
  });

  it("tolerates malformed lines", () => {
    const { activities } = parsePiActivities(["not json", "{}", ""]);
    expect(activities).toHaveLength(0);
  });
});

describe("piProvider.isTurnBoundary", () => {
  const isTurnBoundary = piProvider.isTurnBoundary!;

  it("true for user messages", () => {
    expect(isTurnBoundary(JSON.stringify(userMsg("u1", null, "hi")))).toBe(
      true,
    );
  });

  it("true for compaction and branch_summary entries", () => {
    expect(isTurnBoundary(JSON.stringify(compaction("c1", "a1")))).toBe(true);
    expect(
      isTurnBoundary(
        JSON.stringify({
          type: "branch_summary",
          id: "b1",
          parentId: "a1",
          summary: "s",
        }),
      ),
    ).toBe(true);
  });

  it("false for assistant, toolResult, and control entries", () => {
    expect(
      isTurnBoundary(
        JSON.stringify(assistantMsg("a1", "u1", [{ type: "text", text: "x" }])),
      ),
    ).toBe(false);
    expect(
      isTurnBoundary(JSON.stringify(toolResult("r1", "a1", "tc1", "y"))),
    ).toBe(false);
    expect(
      isTurnBoundary(JSON.stringify(modelChange("m1", null, MODEL_ID))),
    ).toBe(false);
  });

  it("false for malformed lines", () => {
    expect(isTurnBoundary("not json")).toBe(false);
  });
});
