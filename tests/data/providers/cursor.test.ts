import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cursorProvider,
  cursorSessionPath,
  parseCursorActivities,
  parseCursorSessionActivities,
} from "../../../src/data/providers/cursor.js";
import { parseSessionHistory } from "../../../src/data/sessionHistory.js";
import type { GlobalConfig } from "../../../src/types/index.js";

// node:sqlite is Node 22+. Skip the whole suite where it's missing (CI Node
// 20) — the provider degrades to isAvailable() === false there, by design.
let DatabaseSync:
  | {
      new (
        path: string,
        opts?: { readOnly?: boolean },
      ): {
        exec(s: string): void;
        prepare(s: string): {
          run(...a: unknown[]): void;
          get(...a: unknown[]): unknown;
          all(...a: unknown[]): unknown[];
        };
        close(): void;
      };
    }
  | undefined;
let sqliteAvailable = false;
try {
  DatabaseSync = createRequire(import.meta.url)("node:sqlite")
    .DatabaseSync as typeof DatabaseSync;
  sqliteAvailable = true;
} catch {
  // node:sqlite unavailable
}

const config: GlobalConfig = {
  refreshIntervalMs: 2000,
  hiddenSessions: [],
  hiddenSubAgents: [],
  filterPresets: [[]],
  hiddenProjects: [],
  report: { include: [], detailLimit: 0, withGit: false, format: "markdown" },
  summary: {},
};

// --- protobuf encoding (mirror the on-disk node format) ---------------------
// See docs/schemas/cursor-session.md for the decoded field map.

function encVarint(n: bigint | number): Buffer {
  let x = BigInt(n);
  const bytes: number[] = [];
  for (;;) {
    const b = Number(x & 0x7fn);
    x >>= 7n;
    if (x !== 0n) bytes.push(b | 0x80);
    else {
      bytes.push(b);
      break;
    }
  }
  return Buffer.from(bytes);
}

const tag = (field: number, wt: number) => encVarint((field << 3) | wt);
const lenField = (field: number, data: Buffer) =>
  Buffer.concat([tag(field, 2), encVarint(data.length), data]);
const strField = (field: number, s: string) =>
  lenField(field, Buffer.from(s, "utf-8"));
const refField = (field: number, idHex: string) =>
  lenField(field, Buffer.from(idHex, "hex")); // 32 raw bytes
const uintField = (field: number, v: number) =>
  Buffer.concat([tag(field, 0), encVarint(v)]);

// Cursor's content addressing: id = sha256(blob bytes), hex-encoded in the
// table; raw 32 bytes in protobuf refs.
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// --- fixture: build one Cursor chat dir (meta.json + store.db) --------------

interface FixtureMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  id?: string;
  providerOptions?: object;
}

interface FixtureChat {
  projHash: string;
  chatId: string;
  name: string;
  cwd: string;
  createdAtMs: number;
  updatedAtMs: number;
  schemaVersion?: number;
  hasConversation?: boolean;
  /**
   * Chronological chain nodes: nodes[0] is the ROOT (its field8 points to
   * nodes[1], and so on). Each node carries its own field26 timestamp
   * applied to its messages.
   */
  nodes: { ts: number; messages: FixtureMessage[] }[];
  /**
   * Context gauge (state-node field 5: {1: used, 2: window}). Encoded on
   * the LAST walked node (newest state) — the provider takes the gauge from
   * the latest state node that carries one.
   */
  context?: { used: number; window: number };
  /**
   * Real-data shape: the root's field8 points to an OPAQUE blob (a
   * field-1 payload that is not a 32-byte message ref). The walker must
   * follow it, extract nothing, and stop without error.
   */
  danglingNextBytes?: number;
}

let ROOT = "";

function buildChat(chat: FixtureChat): void {
  const chatDir = join(ROOT, chat.projHash, chat.chatId);
  mkdirSync(chatDir, { recursive: true });

  // Opaque successor blob (real-data shape): one f1 with a payload that is
  // neither a 32-byte ref nor JSON.
  let opaqueId: string | null = null;
  let opaqueBuf: Buffer | null = null;
  if (chat.danglingNextBytes != null) {
    opaqueBuf = Buffer.concat([
      tag(1, 2),
      encVarint(chat.danglingNextBytes),
      Buffer.alloc(chat.danglingNextBytes, 0xaa),
    ]);
    opaqueId = sha(opaqueBuf);
  }

  // Message blobs (content-addressed).
  const msgBlob = new Map<string, Buffer>();
  const msgIdsPerNode: string[][] = chat.nodes.map((node) =>
    node.messages.map((m) => {
      const buf = Buffer.from(JSON.stringify(m), "utf-8");
      const id = sha(buf);
      msgBlob.set(id, buf);
      return id;
    }),
  );

  // Node protobufs, built newest-first because each node's field8 must
  // contain its successor's sha256 id.
  const built: { id: string; buf: Buffer }[] = [];
  for (let i = chat.nodes.length - 1; i >= 0; i--) {
    const node = chat.nodes[i];
    const parts: Buffer[] = [];
    for (const id of msgIdsPerNode[i]) parts.push(refField(1, id));
    if (chat.context && i === chat.nodes.length - 1) {
      parts.push(
        lenField(
          5,
          Buffer.concat([
            uintField(1, chat.context.used),
            uintField(2, chat.context.window),
          ]),
        ),
      );
    }
    if (i < chat.nodes.length - 1) parts.push(refField(8, built[0].id));
    else if (chat.nodes.length === 1 && opaqueId)
      parts.push(refField(8, opaqueId));
    parts.push(strField(9, `file://${chat.cwd}`));
    parts.push(uintField(10, 1));
    parts.push(strField(22, "cli"));
    parts.push(uintField(26, node.ts));
    parts.push(strField(27, "Asia/Shanghai"));
    const buf = Buffer.concat(parts);
    built.unshift({ id: sha(buf), buf });
  }
  const rootId = built[0].id;

  const db = new DatabaseSync!(join(chatDir, "store.db"));
  db.exec(
    "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);" +
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);",
  );
  const insBlob = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
  for (const n of built) insBlob.run(n.id, n.buf);
  if (opaqueId && opaqueBuf) insBlob.run(opaqueId, opaqueBuf);
  for (const [id, buf] of msgBlob) insBlob.run(id, buf);
  db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(
    Buffer.from(
      JSON.stringify({
        agentId: chat.chatId,
        latestRootBlobId: rootId,
        name: chat.name,
        mode: "default",
        isRunEverything: false,
        createdAt: chat.createdAtMs,
        blobEncryptionKey:
          "0000000000000000000000000000000000000000000000000000000000000000",
      }),
      "utf-8",
    ).toString("hex"),
  );
  db.close();

  writeFileSync(
    join(chatDir, "meta.json"),
    JSON.stringify({
      schemaVersion: chat.schemaVersion ?? 1,
      createdAtMs: chat.createdAtMs,
      hasConversation: chat.hasConversation ?? true,
      updatedAtMs: chat.updatedAtMs,
      cwd: chat.cwd,
    }),
  );
}

beforeEach(() => {
  if (!sqliteAvailable) return;
  ROOT = mkdtempSync(join(tmpdir(), "agenthud-cursor-"));
  process.env.CURSOR_CHATS_DIR = ROOT;
});

afterEach(() => {
  delete process.env.CURSOR_CHATS_DIR;
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  ROOT = "";
});

const sysMsg = (model: string): FixtureMessage => ({
  role: "system",
  content: `You are an AI coding assistant, powered by ${model}. You are an internal version.`,
});
const userInfoMsg = (): FixtureMessage => ({
  role: "user",
  content:
    "<user_info>\nOS Version: darwin 25.4.0\n\nWorkspace Path: /x\n</user_info>",
});
const userMsg = (text: string): FixtureMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});
// Real cursor-cli user queries are wrapped in a <user_query> tag, prefixed
// by a <timestamp> block in the same text block.
const userQueryMsg = (text: string): FixtureMessage => ({
  role: "user",
  content: [
    {
      type: "text",
      text: `<timestamp>Friday, Sep 4, 2026, 10:19 PM (UTC+8)</timestamp>\n<user_query>\n${text}\n</user_query>`,
    },
  ],
});
const assistantMsg = (blocks: object[], id = "as1"): FixtureMessage => ({
  role: "assistant",
  content: blocks,
  id,
  providerOptions: { cursor: { modelProviderMessageId: `msg_${id}` } },
});
const toolResultMsg = (
  toolCallId: string,
  toolName: string,
  result: string,
): FixtureMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId, toolName, result }],
});

describe.skipIf(!sqliteAvailable)("cursorProvider.isAvailable", () => {
  it("true when the chats root exists", () => {
    mkdirSync(join(ROOT, "p1"), { recursive: true });
    expect(cursorProvider.isAvailable()).toBe(true);
  });

  it("false when the chats root is missing", () => {
    process.env.CURSOR_CHATS_DIR = join(ROOT, "nope");
    expect(cursorProvider.isAvailable()).toBe(false);
  });
});

describe.skipIf(!sqliteAvailable)("cursorProvider.discoverSessions", () => {
  it("discovers a chat grouped by meta.json cwd, with model and title", () => {
    const now = Date.now();
    buildChat({
      projHash: "deadbeef",
      chatId: "chat-1",
      name: "New Agent",
      cwd: "/Users/neo/cursproj",
      createdAtMs: now - 5000,
      updatedAtMs: now,
      nodes: [
        {
          ts: now - 4000,
          messages: [
            sysMsg("Cursor Grok 4.6"),
            userInfoMsg(),
            userMsg("fix the build error"),
          ],
        },
        {
          ts: now,
          messages: [
            assistantMsg([
              { type: "text", text: "On it — checking the build now." },
            ]),
          ],
        },
      ],
    });

    const tree = cursorProvider.discoverSessions(config);
    expect(tree.projects).toHaveLength(1);
    expect(tree.projects[0].name).toBe("cursproj");
    expect(tree.projects[0].projectPath).toBe("/Users/neo/cursproj");
    const s = tree.projects[0].sessions[0];
    expect(s.id).toBe("chat-1");
    expect(s.provider).toBe("cursor");
    expect(s.modelName).toBe("Cursor Grok 4.6");
    // title: first substantial user text (user_info noise skipped)
    expect(s.firstUserPrompt).toBe("fix the build error");
    expect(s.filePath).toBe(cursorSessionPath("deadbeef", "chat-1"));
    expect(s.version).toBe("1");
    expect(s.status).toBe("hot");
    // no f5 gauge in this fixture
    expect(s.contextUsage).toBeUndefined();
    expect(tree.totalCount).toBe(1);
  });

  it("sets contextUsage from the latest state node's f5 gauge", () => {
    const now = Date.now();
    buildChat({
      projHash: "gaugeproj",
      chatId: "chat-g",
      name: "G",
      cwd: "/Users/neo/gaugeproj",
      createdAtMs: now - 5000,
      updatedAtMs: now,
      context: { used: 26040, window: 256000 },
      nodes: [
        {
          ts: now - 4000,
          messages: [sysMsg("Cursor Grok 4.6"), userMsg("hello gauge world")],
        },
      ],
    });
    const s = cursorProvider.discoverSessions(config).projects[0].sessions[0];
    expect(s.contextUsage).toEqual({
      used: 26040,
      total: 256000,
      percent: 10, // 26040/256000 = 10.17%
    });
  });

  it("skips chats without a conversation (no store.db)", () => {
    const now = Date.now();
    const chatDir = join(ROOT, "p2", "empty-chat");
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(
      join(chatDir, "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        createdAtMs: now,
        hasConversation: false,
        updatedAtMs: now,
        cwd: "/Users/neo/nodb",
      }),
    );
    const tree = cursorProvider.discoverSessions(config);
    expect(tree.projects).toHaveLength(0);
    expect(tree.coldProjects).toHaveLength(0);
  });

  it("moves stale chats to coldProjects", () => {
    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 3600 * 1000;
    buildChat({
      projHash: "coldproj",
      chatId: "chat-cold",
      name: "Old",
      cwd: "/Users/neo/coldproj",
      createdAtMs: tenDaysAgo - 5000,
      updatedAtMs: tenDaysAgo,
      nodes: [
        {
          ts: tenDaysAgo,
          messages: [sysMsg("Composer 2.5"), userMsg("old question")],
        },
      ],
    });
    const tree = cursorProvider.discoverSessions(config);
    expect(tree.projects).toHaveLength(0);
    expect(tree.coldProjects).toHaveLength(1);
    expect(tree.coldProjects[0].hotness).toBe("cold");
  });

  it("respects hiddenSessions config", () => {
    const now = Date.now();
    buildChat({
      projHash: "hp",
      chatId: "chat-h",
      name: "H",
      cwd: "/Users/neo/hproj",
      createdAtMs: now - 5000,
      updatedAtMs: now,
      nodes: [
        {
          ts: now,
          messages: [sysMsg("Grok 4.6"), userMsg("hello there world")],
        },
      ],
    });
    const tree = cursorProvider.discoverSessions({
      ...config,
      hiddenSessions: ["hproj/chat-h"],
    });
    expect(tree.projects[0].sessions[0].hidden).toBe(true);
    expect(tree.hiddenStats.total).toBe(1);
  });
});

describe.skipIf(!sqliteAvailable)(
  "parseCursorSessionActivities (chain walk)",
  () => {
    const CHAT = "chat-act";
    const PROJ = "actproj";
    const CWD = "/Users/neo/actproj";

    beforeEach(() => {
      const now = Date.now();
      buildChat({
        projHash: PROJ,
        chatId: CHAT,
        name: "Act",
        cwd: CWD,
        createdAtMs: now - 9000,
        updatedAtMs: now,
        nodes: [
          {
            ts: now - 8000,
            messages: [
              sysMsg("Cursor Grok 4.6"),
              userInfoMsg(),
              userMsg("list the files and run the tests"),
            ],
          },
          {
            ts: now - 4000,
            messages: [
              assistantMsg(
                [
                  {
                    type: "reasoning",
                    text: "I should list files first.",
                    signature: "sig1",
                  },
                  {
                    type: "tool-call",
                    toolCallId: "call-abc-0",
                    toolName: "Shell",
                    args: { command: "npm test", description: "Run tests" },
                  },
                ],
                "as1",
              ),
              toolResultMsg("call-abc-0", "Shell", "3 passed"),
            ],
          },
          {
            ts: now,
            messages: [
              assistantMsg(
                [
                  {
                    type: "reasoning",
                    text: "Tests are green.",
                    signature: "sig2",
                  },
                  {
                    type: "text",
                    text: "All three tests passed, nothing to fix.",
                  },
                ],
                "as2",
              ),
            ],
          },
        ],
      });
    });

    it("materializes the full 3-node chain in order", () => {
      const acts = parseCursorSessionActivities("actproj/chat-act");
      const user = acts.find((a) => a.type === "user");
      const thinking = acts.filter((a) => a.type === "thinking");
      const tool = acts.find((a) => a.type === "tool");
      const response = acts.find((a) => a.type === "response");
      expect(user?.detail).toBe("list the files and run the tests");
      expect(thinking).toHaveLength(2);
      expect(thinking[0].detail).toBe("I should list files first.");
      expect(tool).toBeDefined();
      expect(response?.detailBody).toBe(
        "All three tests passed, nothing to fix.",
      );
    });

    it("attaches tool results to their calls", () => {
      const acts = parseCursorSessionActivities("actproj/chat-act");
      const tool = acts.find((a) => a.type === "tool")!;
      expect(tool.label).toBe("Bash"); // Shell → canonical Bash
      expect(tool.detail).toBe("npm test");
      expect(tool.detailBody).toContain("3 passed");
    });

    it("routes through the synthetic path in parseSessionHistory", () => {
      const path = cursorSessionPath(PROJ, CHAT);
      expect(path).toBe("cursor:actproj/chat-act");
      const acts = parseSessionHistory(path);
      expect(acts.length).toBeGreaterThan(0);
      // no system / user_info noise rows
      expect(
        acts.some((a) => (a.detailBody ?? "").includes("<user_info>")),
      ).toBe(false);
    });
  },
);

describe.skipIf(!sqliteAvailable)(
  "real-data shape: root holds all messages, opaque field8 successor",
  () => {
    const buildFixture = () => {
      const now = Date.now();
      buildChat({
        projHash: "realshape",
        chatId: "chat-r",
        name: "New Agent",
        cwd: "/Users/neo/realshape",
        createdAtMs: now - 9000,
        updatedAtMs: now,
        context: { used: 1000, window: 180000 },
        // root's field8 → opaque 616B payload blob (as in the live corpus)
        danglingNextBytes: 616,
        nodes: [
          {
            ts: now - 4000,
            messages: [
              sysMsg("Cursor Grok 4.6"),
              userInfoMsg(),
              userQueryMsg("do the thing"),
              assistantMsg(
                [
                  {
                    type: "tool-call",
                    toolCallId: "call-r-0",
                    toolName: "Glob",
                    args: { pattern: "*.ts" },
                  },
                ],
                "asr1",
              ),
              toolResultMsg("call-r-0", "Glob", "3 files found"),
              assistantMsg(
                [{ type: "text", text: "Done — three files matched." }],
                "asr2",
              ),
            ],
          },
        ],
      });
    };
    beforeEach(buildFixture);

    it("walks past the opaque successor and extracts all messages", () => {
      const acts = parseCursorSessionActivities("realshape/chat-r");
      const user = acts.find((a) => a.type === "user");
      // <user_query> content survives, <timestamp> noise does not
      expect(user?.detail).toBe("do the thing");
      expect(acts.find((a) => a.type === "tool")?.label).toBe("Glob");
      expect(acts.find((a) => a.type === "response")?.detailBody).toBe(
        "Done — three files matched.",
      );
    });

    it("keeps the gauge from the root state node", () => {
      const s = cursorProvider.discoverSessions(config).projects[0].sessions[0];
      expect(s.contextUsage).toEqual({
        used: 1000,
        total: 180000,
        percent: 1, // 0.55% rounds to 1
      });
    });
  },
);

describe.skipIf(!sqliteAvailable)("parseCursorActivities (unit)", () => {
  const line = (o: object) => JSON.stringify(o);
  const T = 1_800_000_000_000;

  it("maps user text to a user activity", () => {
    const r = parseCursorActivities([
      line({
        role: "user",
        content: [{ type: "text", text: "hello world" }],
        t: T,
      }),
    ]);
    expect(r.activities).toHaveLength(1);
    expect(r.activities[0].type).toBe("user");
    expect(r.activities[0].detail).toBe("hello world");
  });

  it("skips user_info / timestamp noise", () => {
    const r = parseCursorActivities([
      line({
        role: "user",
        content: "<user_info>\nOS: mac\n</user_info>",
        t: T,
      }),
      line({
        role: "user",
        content: [
          { type: "text", text: "<timestamp>Friday, Sep 4</timestamp>" },
        ],
        t: T,
      }),
    ]);
    expect(r.activities).toHaveLength(0);
  });

  it("maps assistant reasoning + text to thinking + response", () => {
    const r = parseCursorActivities([
      line({
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking hard about it", signature: "s" },
          { type: "text", text: "here is the answer to your question" },
        ],
        t: T,
      }),
    ]);
    expect(r.activities.map((a) => a.type)).toEqual(["thinking", "response"]);
  });

  it("skips system messages but recovers the model name", () => {
    const r = parseCursorActivities([
      line({
        role: "system",
        content:
          "You are an AI coding assistant, powered by Composer 2.5. More.",
        t: T,
      }),
      line({ role: "user", content: "hi there friend", t: T }),
    ]);
    expect(r.activities).toHaveLength(1);
    expect(r.modelName).toBe("Composer 2.5");
  });

  it("maps tool-call blocks to tool activities with args detail", () => {
    const r = parseCursorActivities([
      line({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "Glob",
            args: { pattern: "*.ts" },
          },
        ],
        t: T,
      }),
    ]);
    expect(r.activities).toHaveLength(1);
    expect(r.activities[0].type).toBe("tool");
    expect(r.activities[0].label).toBe("Glob");
    expect(r.activities[0].detail).toBe("*.ts");
  });

  it("extracts the real query from a <user_query>-wrapped block", () => {
    const r = parseCursorActivities([
      line({
        role: "user",
        content: [
          {
            type: "text",
            text: "<timestamp>Friday, Sep 4</timestamp>\n<user_query>\nList the files, then write 200 words\n</user_query>",
          },
        ],
        t: T,
      }),
    ]);
    expect(r.activities).toHaveLength(1);
    expect(r.activities[0].detail).toContain(
      "List the files, then write 200 words",
    );
    expect(r.activities[0].detail).not.toContain("<timestamp>");
  });

  it("tolerates malformed lines", () => {
    const r = parseCursorActivities(["not json", "{}", ""]);
    expect(r.activities).toHaveLength(0);
  });
});
