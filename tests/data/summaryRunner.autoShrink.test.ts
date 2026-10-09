/**
 * Spec for summary auto-shrink + error surfacing.
 *
 * When the engine rejects the report as too large (claude: a
 * `result` event with `is_error: true`, "Prompt is too long" — no
 * assistant text), `agenthud summary` must:
 *
 *   - rebuild the report with a smaller detail-limit and retry
 *     (ladder: requested limit, then 800, 400, 200, 100 when the
 *     request was unlimited)
 *   - NOT retry failures of a different class (auth, crash, network)
 *   - surface the engine's error message on abort, instead of a
 *     silent "aborted"
 *
 * Engine behavior is simulated with mocked `spawn` processes that
 * emit claude stream-json events:
 *   - too-long failure: a `result` event with `is_error: true` and
 *     no assistant event (mirrors a gateway prompt-size rejection)
 *   - success: an assistant text event + a clean result event
 */

import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  createWriteStream: vi.fn(),
  copyFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Keep the real claude engine (its stream-json parser must match the
// mocked spawn output); only force engine RESOLUTION to claude, since
// the test/CI environment has no agent CLI on PATH.
vi.mock("../../src/data/summaryEngines.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/data/summaryEngines.js")>();
  return { ...actual, resolveSummaryEngine: vi.fn(() => actual.claudeEngine) };
});

vi.mock("../../src/data/sessions.js", () => ({
  discoverSessions: vi.fn(() => ({
    projects: [],
    coldProjects: [],
    totalCount: 0,
    timestamp: "",
  })),
  getProjectsDir: vi.fn(() => "/tmp/projects"),
}));
vi.mock("../../src/data/reportGenerator.js", () => ({
  // The detailLimit argument is what the tests assert on (which ladder
  // step each attempt used); the body content is irrelevant here.
  generateReport: vi.fn(
    () => "# Report\n\n## test (10:00 – 11:00)\n[10:00] $ Bash: ls\n",
  ),
}));
vi.mock("../../src/config/globalConfig.js", () => ({
  loadGlobalConfig: vi.fn(() => ({
    refreshIntervalMs: 2000,
    hiddenSessions: [],
    hiddenSubAgents: [],
    filterPresets: [[]],
  })),
}));
vi.mock("../../src/utils/openInDefaultApp.js", () => ({
  openInDefaultApp: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/data/summariesIndex.js", () => ({
  regenerateIndex: vi.fn(),
}));

const { writeFileSync } = await import("node:fs");
const { spawn } = await import("node:child_process");
const { generateReport } = await import("../../src/data/reportGenerator.js");
const { runSummary } = await import("../../src/data/summaryRunner.js");

// ── Fake engine processes ──────────────────────────────────────────

const TOO_LONG_RESULT = JSON.stringify({
  type: "result",
  is_error: true,
  result: "Prompt is too long",
});
const OK_RESULT = JSON.stringify({
  type: "result",
  is_error: false,
  result: "fine",
  usage: { input_tokens: 1, output_tokens: 1 },
});
const assistantEvent = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });

function mockProc(stdoutEvents: string[], exitCode: number, stderr = "") {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: Readable;
    stderr: Readable;
  };
  proc.stdin = new PassThrough();
  proc.stdout = Readable.from(
    stdoutEvents.length ? [`${stdoutEvents.join("\n")}\n`] : [],
  );
  proc.stderr = Readable.from([stderr]);
  setImmediate(() => proc.emit("close", exitCode));
  return proc as unknown as ReturnType<typeof spawn>;
}

const tooLongProc = () => mockProc([TOO_LONG_RESULT], 1);
const successProc = (text = "Summary text") =>
  mockProc([assistantEvent(text), OK_RESULT], 0);

// ── Helpers ────────────────────────────────────────────────────────

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    date: new Date(2026, 4, 15),
    today: new Date(2026, 4, 15),
    force: false,
    include: ["user", "response", "bash", "edit", "thinking"],
    detailLimit: 0,
    withGit: false,
    ...overrides,
  };
}

function detailLimitsUsed(): number[] {
  return vi
    .mocked(generateReport)
    .mock.calls.map((c) => (c[1] as { detailLimit: number }).detailLimit);
}

function captureStderr(run: () => Promise<number>): Promise<number> {
  const chunks: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  return run().then((code) => {
    process.stderr.write = origErr;
    (captureStderr as { stderr?: string[] }).stderr = chunks;
    return code;
  });
}
function capturedStderr(): string {
  return (captureStderr as { stderr?: string[] }).stderr?.join("") ?? "";
}

beforeAll(() => {
  // These tests assert against the DEFAULT home-dir layout
  // (join(homedir(), ".agenthud")); the global setup points
  // AGENTHUD_HOME at a temp dir. Unset it — safe because node:fs is
  // mocked, so no real I/O can occur.
  delete process.env.AGENTHUD_HOME;
});

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does NOT flush pending mockReturnValueOnce queue —
  // reset the spawn mock (every test re-mocks it individually) so a
  // leftover fake engine process can't leak into the next test.
  vi.mocked(spawn).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Auto-shrink retry ──────────────────────────────────────────────

describe("runSummary auto-shrink on prompt-too-long", () => {
  it("rebuilds the report with a smaller detail-limit and retries", async () => {
    vi.mocked(spawn)
      .mockReturnValueOnce(tooLongProc())
      .mockReturnValueOnce(successProc());

    const code = await runSummary(baseOpts());

    expect(code).toBe(0);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    // Unlimited (0) request: first finite retry step is 800.
    expect(detailLimitsUsed()).toEqual([0, 800]);
  });

  it("writes the successful retry's text to the cache", async () => {
    vi.mocked(spawn)
      .mockReturnValueOnce(tooLongProc())
      .mockReturnValueOnce(successProc("Shrunk summary"));

    await runSummary(baseOpts());

    const cacheWrites = vi
      .mocked(writeFileSync)
      .mock.calls.filter(([p]) => String(p).includes("2026-05-15.md"));
    expect(cacheWrites.length).toBeGreaterThan(0);
    expect(String(cacheWrites[0][1])).toContain("Shrunk summary");
  });

  it("anchors the shrink ladder at an explicit detailLimit", async () => {
    vi.mocked(spawn)
      .mockReturnValueOnce(tooLongProc())
      .mockReturnValueOnce(successProc());

    const code = await runSummary(baseOpts({ detailLimit: 500 }));

    expect(code).toBe(0);
    expect(detailLimitsUsed()).toEqual([500, 250]);
  });

  it("succeeds on the first attempt without retrying", async () => {
    vi.mocked(spawn).mockReturnValueOnce(successProc());

    const code = await runSummary(baseOpts());

    expect(code).toBe(0);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(detailLimitsUsed()).toEqual([0]);
  });
});

// ── Error classification + surfacing ───────────────────────────────

describe("runSummary failure handling", () => {
  it("does not retry unrelated engine failures (e.g. bad credentials)", async () => {
    vi.mocked(spawn).mockReturnValueOnce(
      mockProc([], 1, "Error: Invalid API key\n"),
    );

    const code = await captureStderr(() => runSummary(baseOpts()));

    expect(code).toBe(1);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    // The engine's own error line must reach the user.
    expect(capturedStderr()).toContain("Invalid API key");
    expect(capturedStderr()).toMatch(/summary failed/i);
  });

  it("exhausts the shrink ladder, then aborts with the engine's error visible", async () => {
    vi.mocked(spawn).mockImplementation(() => tooLongProc());

    const code = await captureStderr(() =>
      runSummary(baseOpts({ detailLimit: 0 })),
    );

    expect(code).toBe(1);
    // Ladder for an unlimited request: 0 → 800 → 400 → 200 → 100.
    expect(detailLimitsUsed()).toEqual([0, 800, 400, 200, 100]);
    expect(capturedStderr()).toContain("Prompt is too long");
  });
});
