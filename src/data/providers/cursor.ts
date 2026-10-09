/**
 * Cursor session provider — discovers agent chats from
 * `~/.cursor/chats/<projectHash>/<chatId>/` and parses their
 * `store.db` (SQLite) + `meta.json` pair.
 *
 * On-disk layout (verified against Cursor 2.5 / cursor-cli,
 * see docs/schemas/cursor-session.md):
 *
 *   ~/.cursor/chats/<projHash>/<chatId>/
 *   ├── meta.json  — {schemaVersion, createdAtMs, updatedAtMs,
 *   │                 hasConversation, cwd}
 *   └── store.db   — SQLite:
 *        meta(key='0', value=HEX(JSON)) with
 *          {agentId, latestRootBlobId, name, mode, createdAt,
 *           blobEncryptionKey}
 *        blobs(id=SHA256-hex, data=BLOB) — content-addressed:
 *          - message blobs: plain JSON {role, content, id,
 *            providerOptions}
 *          - node blobs: undocumented protobuf "state" nodes.
 *            latestRootBlobId is the CURRENT state of the chat:
 *            field 1 = repeated 32-byte refs to the conversation's
 *            message blobs (in order), field 5 = context gauge
 *            ({1: used tokens, 2: window tokens, 3: breakdown}),
 *            field 8 = successor/diff ref (followed, but only
 *            32-byte field-1 payloads count as messages),
 *            field 9 = workspace file:// URI, field 22 = source
 *            ("cli"), field 26 = ms timestamp, field 27 = timezone.
 *            Older state snapshots of the same chat live in the
 *            same table and are only reachable via field 8.
 *
 * Conventions followed (see docs/schemas/README.md):
 * - Sessions are grouped by the cwd from meta.json.
 * - No real file backs a chat (messages live in SQLite), so each
 *   SessionNode.filePath is a synthetic path:
 *   `cursor:<projectHash>/<chatId>` (opencode precedent). The
 *   session-history reader resolves it back to the store.db.
 * - `lineDelimited` is false: the blob chain is a linked list with no
 *   append-only log, so the tail cache cannot be used. An
 *   mtime-keyed parse cache inside this module makes the re-poll
 *   cheap instead.
 * - `node:sqlite` is loaded through a guarded require so agenthud
 *   still works on Node < 22 (the provider degrades to
 *   isAvailable() === false).
 * - Model name: Cursor stores no model field on messages; it is
 *   recovered from the system prompt ("powered by <Model>") when
 *   present, else null.
 * - Context gauge: a state node's field 5 is a nested payload
 *   `{1: usedTokens, 2: windowTokens, 3: breakdown}`; the provider
 *   takes the gauge from the latest state node that carries one.
 *   Chats without a readable gauge show no gauge (never an error).
 * - Sub-agents: not yet mapped (their on-disk shape is unverified);
 *   MVP lists top-level chats only.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  ActivityEntry,
  GlobalConfig,
  ProjectNode,
  SessionNode,
  SessionStatus,
  SessionTree,
} from "../../types/index.js";
import { ONE_HOUR_MS, THIRTY_MINUTES_MS } from "../../utils/timeConstants.js";
import { canonicalToolLabel, iconForCanonicalLabel } from "./toolLabels.js";
import type { DiscoverOptions, ParseResult, SessionProvider } from "./types.js";

// --- synthetic paths ---------------------------------------------------------
// A chat has no real backing file (its messages live in store.db), so the
// SessionNode.filePath is a synthetic id the history reader resolves back to
// the DB. Mirrors the opencode: convention.

export const CURSOR_PATH_PREFIX = "cursor:";

/** Synthetic filePath for a Cursor chat: `cursor:<projHash>/<chatId>`. */
export function cursorSessionPath(projHash: string, chatId: string): string {
  return `${CURSOR_PATH_PREFIX}${projHash}/${chatId}`;
}

/** Recover `"<projHash>/<chatId>"` from a synthetic cursor filePath. */
export function cursorSessionIdFromPath(filePath: string): string | null {
  return filePath.startsWith(CURSOR_PATH_PREFIX)
    ? filePath.slice(CURSOR_PATH_PREFIX.length)
    : null;
}

// --- env override ------------------------------------------------------------

/** Root holding per-project chat dirs; overridable for tests. */
export function getCursorChatsDir(): string {
  if (process.env.CURSOR_CHATS_DIR) return process.env.CURSOR_CHATS_DIR;
  return join(homedir(), ".cursor", "chats");
}

// --- node:sqlite guarded loader ----------------------------------------------
// Same pattern as opencode.ts: node:sqlite's types vary by Node version (and
// are absent < 22), so the DB handle is loosely typed and the require is
// deferred + caught so a missing built-in degrades to isAvailable() === false
// instead of failing the ESM module graph at import time.
type SqliteDb = any;
let sqliteMod:
  | {
      DatabaseSync: new (
        path: string,
        opts?: Record<string, unknown>,
      ) => SqliteDb;
    }
  | null
  | undefined;

function loadSqlite() {
  if (sqliteMod !== undefined) return sqliteMod;
  const originalEmit = process.emitWarning;
  const filtered: typeof process.emitWarning = (warning, ...rest) => {
    const opts = rest[0];
    const type =
      typeof opts === "string"
        ? opts
        : opts && typeof opts === "object" && "type" in opts
          ? (opts as { type?: string }).type
          : undefined;
    if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) {
      return;
    }
    return (originalEmit as (...a: unknown[]) => void)(warning, ...rest);
  };
  process.emitWarning = filtered;
  try {
    const req = createRequire(import.meta.url);
    sqliteMod = req("node:sqlite") as typeof sqliteMod;
  } catch {
    process.emitWarning = originalEmit;
    sqliteMod = null;
  }
  return sqliteMod;
}

/** Open a store.db read-only, or null if unavailable. Caller closes. */
function openDb(dbPath: string): SqliteDb | null {
  const mod = loadSqlite();
  if (!mod) return null;
  if (!existsSync(dbPath)) return null;
  try {
    return new mod.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

// --- protobuf reader -----------------------------------------------------------
// Minimal reader for the undocumented node-blob format. Only the wire types
// observed in the wild are handled: 0 (varint), 1 (64-bit), 2 (length-
// delimited), 5 (32-bit). Unknown fields are skipped, so Cursor adding
// fields does not break older agenthud builds.

interface CursorNode {
  refs: string[]; // field 1: message blob ids (32-byte hex)
  next: string | null; // field 8: successor node id
  workspace: string | null; // field 9: file:// URI
  source: string | null; // field 22: e.g. "cli"
  ts: number | null; // field 26: epoch ms
  tz: string | null; // field 27: IANA timezone
  // field 5: nested context gauge {1: used tokens, 2: window tokens}
  contextUsed: number | null;
  contextWindow: number | null;
}

/** Read a base-128 varint. Returns [value, nextPos]. Values stay < 2^53. */
function readVarint(buf: Buffer, pos: number): [number, number] {
  let value = 0;
  let shift = 0; // 7 bits per byte — the classic gotcha
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated varint");
    const b = buf[pos++];
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [value, pos];
    shift += 7;
  }
}

function decodeNode(buf: Buffer): CursorNode {
  const node: CursorNode = {
    refs: [],
    next: null,
    workspace: null,
    source: null,
    ts: null,
    tz: null,
    contextUsed: null,
    contextWindow: null,
  };
  let pos = 0;
  while (pos < buf.length) {
    const [header, nextPos] = readVarint(buf, pos);
    pos = nextPos;
    const field = header >>> 3;
    const wire = header & 0x07;
    switch (wire) {
      case 0: {
        const [value, p2] = readVarint(buf, pos);
        pos = p2;
        if (field === 26) node.ts = value;
        break;
      }
      case 1:
        pos += 8; // 64-bit — unused in observed nodes
        break;
      case 2: {
        const [len, p2] = readVarint(buf, pos);
        pos = p2;
        if (len < 0 || pos + len > buf.length)
          throw new Error("truncated length-delimited field");
        const data = buf.subarray(pos, pos + len);
        pos += len;
        switch (field) {
          case 1:
            // Only 32-byte payloads are message refs; longer field-1
            // payloads exist on diff blobs and would be junk lookups.
            if (data.length === 32) node.refs.push(data.toString("hex"));
            break;
          case 5:
            // Context gauge: nested {1: used varint, 2: window varint,
            // 3: breakdown (skipped)}. Malformed -> stays null.
            try {
              let p = 0;
              while (p < data.length) {
                const [h, p2] = readVarint(data, p);
                p = p2;
                const nf = h >>> 3;
                const nw = h & 0x07;
                if (nw === 0) {
                  const [v, p3] = readVarint(data, p);
                  p = p3;
                  if (nf === 1) node.contextUsed = v;
                  else if (nf === 2) node.contextWindow = v;
                } else if (nw === 2) {
                  const [l, p3] = readVarint(data, p);
                  p = p3 + l;
                } else if (nw === 1) p += 8;
                else if (nw === 5) p += 4;
                else break;
              }
            } catch {
              // malformed gauge — ignore
            }
            break;
          case 8:
            node.next = data.toString("hex");
            break;
          case 9:
            node.workspace = data.toString("utf-8");
            break;
          case 22:
            node.source = data.toString("utf-8");
            break;
          case 27:
            node.tz = data.toString("utf-8");
            break;
          // field 2/5: nested protos (config blobs) — skipped
        }
        break;
      }
      case 5:
        pos += 4; // 32-bit — unused in observed nodes
        break;
      default:
        throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return node;
}

// --- chain walk ------------------------------------------------------------------

interface WalkedChat {
  agentId: string;
  name: string | null;
  lines: string[]; // one JSON per message: {role, content, id, t}
  context: { used: number; window: number } | null;
}

const MAX_CHAIN_NODES = 10_000; // cycle / corruption guard

interface CursorMessage {
  role?: string;
  content?: unknown;
  id?: string;
}

function walkChat(db: SqliteDb): WalkedChat | null {
  const metaRow = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as
    | { value?: string }
    | undefined;
  if (!metaRow?.value) return null;
  let meta: {
    agentId?: string;
    latestRootBlobId?: string;
    name?: string;
  };
  try {
    meta = JSON.parse(
      Buffer.from(String(metaRow.value), "hex").toString("utf-8"),
    );
  } catch {
    return null;
  }
  if (
    typeof meta.agentId !== "string" ||
    typeof meta.latestRootBlobId !== "string"
  ) {
    return null;
  }

  const lines: string[] = [];
  const visited = new Set<string>([meta.latestRootBlobId]);
  let nodeId: string | null = meta.latestRootBlobId;
  let hops = 0;
  let contextUsed: number | null = null;
  let contextWindow: number | null = null;
  while (nodeId && hops < MAX_CHAIN_NODES) {
    hops++;
    const row = db.prepare("SELECT data FROM blobs WHERE id = ?").get(nodeId) as
      | { data?: Uint8Array }
      | undefined;
    if (!row?.data) break;
    let node: CursorNode;
    try {
      node = decodeNode(Buffer.from(row.data as Uint8Array));
    } catch {
      break; // corrupted node: keep what we have
    }
    // The gauge lives on state nodes; keep the last valid one seen in
    // walk order (root = current state on observed Cursor builds).
    if (
      node.contextUsed != null &&
      node.contextWindow != null &&
      node.contextWindow > 0
    ) {
      contextUsed = node.contextUsed;
      contextWindow = node.contextWindow;
    }
    const ts = node.ts ?? Date.now();
    for (const ref of node.refs) {
      if (visited.has(ref)) continue;
      visited.add(ref);
      const mrow = db.prepare("SELECT data FROM blobs WHERE id = ?").get(ref) as
        | { data?: Uint8Array }
        | undefined;
      if (!mrow?.data) continue;
      let msg: CursorMessage | null = null;
      try {
        const parsed: unknown = JSON.parse(
          Buffer.from(mrow.data as Uint8Array).toString("utf-8"),
        );
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as { role?: unknown }).role === "string"
        ) {
          msg = parsed as CursorMessage;
        }
      } catch {
        continue;
      }
      if (!msg) continue;
      lines.push(
        JSON.stringify({
          role: msg.role,
          content: msg.content ?? null,
          id: typeof msg.id === "string" ? msg.id : null,
          t: ts,
        }),
      );
    }
    nodeId = node.next && !visited.has(node.next) ? node.next : null;
    if (node.next) visited.add(node.next);
  }
  return {
    agentId: meta.agentId,
    name: typeof meta.name === "string" ? meta.name : null,
    lines,
    context:
      contextUsed != null && contextWindow != null
        ? { used: contextUsed, window: contextWindow }
        : null,
  };
}

// --- chat parse + mtime cache -----------------------------------------------------

interface CursorChat {
  agentId: string;
  name: string | null;
  cwd: string;
  schemaVersion: string | undefined;
  updatedAtMs: number;
  lines: string[];
  context: { used: number; window: number } | null;
}

// Re-polls (tree refresh + history view every ~2s) re-walk the chain unless
// store.db is untouched: cache keyed on the DB file's mtime.
const chatCache = new Map<
  string,
  { mtimeMs: number; value: CursorChat | null }
>();

function parseCursorChat(chatDir: string): CursorChat | null {
  let metaJson: {
    schemaVersion?: number;
    createdAtMs?: number;
    updatedAtMs?: number;
    hasConversation?: boolean;
    cwd?: string;
  };
  try {
    metaJson = JSON.parse(
      readFileSync(join(chatDir, "meta.json"), "utf-8"),
    ) as typeof metaJson;
  } catch {
    return null;
  }
  if (metaJson.hasConversation === false) return null;
  if (typeof metaJson.cwd !== "string" || !metaJson.cwd) return null;
  const dbPath = join(chatDir, "store.db");
  if (!existsSync(dbPath)) return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(dbPath).mtimeMs;
  } catch {
    return null;
  }

  const cached = chatCache.get(chatDir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;

  let value: CursorChat | null = null;
  const db = openDb(dbPath);
  if (db) {
    try {
      const walked = walkChat(db);
      if (walked) {
        value = {
          agentId: walked.agentId,
          name: walked.name,
          cwd: metaJson.cwd,
          schemaVersion:
            typeof metaJson.schemaVersion === "number"
              ? String(metaJson.schemaVersion)
              : undefined,
          updatedAtMs:
            typeof metaJson.updatedAtMs === "number"
              ? metaJson.updatedAtMs
              : mtimeMs,
          lines: walked.lines,
          context: walked.context,
        };
      }
    } catch {
      value = null; // one corrupt chat must not blank the tree
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  if (chatCache.size > 256) chatCache.clear();
  chatCache.set(chatDir, { mtimeMs, value });
  return value;
}

// --- activities ---------------------------------------------------------------------

/** Extract the human text of a user message, dropping injected noise.
 * Cursor wraps the real query in a `<user_query>…</user_query>` tag, often
 * prefixed by a `<timestamp>…</timestamp>` block; a separate leading message
 * carries `<user_info>…</user_info>` context. Prefer the tag's content;
 * otherwise keep text that is not pure injected noise. Null when nothing
 * remains. */
function userText(content: unknown): string | null {
  const blocks: string[] = [];
  const rawTexts: string[] = [];
  if (typeof content === "string") {
    rawTexts.push(content);
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (
        b &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
      ) {
        rawTexts.push((b as { text: string }).text);
      }
    }
  }
  for (const raw of rawTexts) {
    const t = raw.trim();
    if (!t) continue;
    // Real query wrapped in a tag — prefer its content over the noise prefix.
    const m = t.match(/<user_query>([\s\S]*?)<\/user_query>/);
    if (m) {
      const inner = m[1].trim();
      if (inner) blocks.push(inner);
      continue;
    }
    if (t.startsWith("<user_info>") || t.startsWith("<timestamp>")) continue;
    blocks.push(t);
  }
  if (blocks.length === 0) return null;
  return blocks.join("\n");
}

/** First string among a tool-call's common argument keys. */
function toolDetail(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const pick = (k: string) =>
    typeof o[k] === "string" && (o[k] as string).trim()
      ? (o[k] as string).trim()
      : null;
  return (
    pick("command") ??
    pick("pattern") ??
    pick("path") ??
    pick("file_path") ??
    pick("query") ??
    pick("url") ??
    null
  );
}

/** Best-effort model recovery from the Cursor system prompt:
 * "You are an AI coding assistant, powered by <Model>." The model name can
 * itself contain dots ("Cursor Grok 4.6"), so cut at the first sentence
 * terminator (punctuation followed by whitespace or end of text), not at the
 * first dot. */
function modelFromSystem(content: unknown): string | null {
  let text: string | null = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (
        b &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
      ) {
        text = (b as { text: string }).text;
        break;
      }
    }
  }
  if (!text) return null;
  const idx = text.toLowerCase().indexOf("powered by");
  if (idx < 0) return null;
  const rest = text.slice(idx + "powered by".length).replace(/^\s+/, "");
  const end = rest.search(/(?<=[A-Za-z0-9])[.!?](?=\s|$)/);
  const model = (end >= 0 ? rest.slice(0, end) : rest).trim();
  return model.length > 0 ? model : null;
}

/**
 * Parse pre-materialized Cursor message lines (one JSON per message:
 * {role, content, id, t}) into activities. Pure — no fs, no sqlite.
 * `tool`-role messages carry results for the preceding tool-call; they are
 * merged into the call's detailBody instead of producing their own row.
 */
export function parseCursorActivities(lines: string[]): ParseResult {
  const activities: ActivityEntry[] = [];
  let modelName: string | null = null;
  let sessionStartTime: Date | null = null;
  const toolResults = new Map<string, string>();

  // Pre-pass: index tool results by toolCallId.
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: { role?: string; content?: unknown };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      continue;
    }
    if (o.role === "tool" && Array.isArray(o.content)) {
      for (const b of o.content as object[]) {
        const r = b as { type?: string; toolCallId?: string; result?: string };
        if (r && r.type === "tool-result" && typeof r.toolCallId === "string") {
          const text =
            typeof r.result === "string"
              ? r.result
              : JSON.stringify(r.result ?? "");
          if (!toolResults.has(r.toolCallId))
            toolResults.set(r.toolCallId, text);
        }
      }
    }
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: { role?: string; content?: unknown; t?: number };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      continue;
    }
    const role = o.role;
    const content = o.content;
    const ts = typeof o.t === "number" ? new Date(o.t) : new Date();
    // The chain is chronological, so the first parsed line is the session start.
    if (sessionStartTime === null) sessionStartTime = ts;
    if (role === "user") {
      const text = userText(content);
      if (!text) continue; // injected user_info / timestamp noise
      activities.push({
        timestamp: ts,
        type: "user",
        icon: "👤",
        label: "User",
        detail: text.split("\n")[0],
        detailBody: text,
      });
      continue;
    }
    if (role === "system") {
      if (!modelName) modelName = modelFromSystem(content);
      continue;
    }
    if (role !== "assistant") continue; // tool results handled in pre-pass
    if (!Array.isArray(content)) continue;
    for (const block of content as object[]) {
      const b = block as {
        type?: string;
        text?: string;
        toolCallId?: string;
        toolName?: string;
        args?: unknown;
      };
      if (!b || typeof b.type !== "string") continue;
      if (b.type === "reasoning") {
        const text = (b.text ?? "").trim();
        if (!text) continue;
        activities.push({
          timestamp: ts,
          type: "thinking",
          icon: "💭",
          label: "Thinking",
          detail: text.split("\n")[0],
        });
      } else if (b.type === "text") {
        const text = (b.text ?? "").trim();
        if (!text) continue;
        activities.push({
          timestamp: ts,
          type: "response",
          icon: "💬",
          label: "Response",
          detail: text.split("\n")[0],
          detailBody: text,
        });
      } else if (b.type === "tool-call") {
        const label = canonicalToolLabel(b.toolName ?? "tool");
        const detail = toolDetail(b.args) ?? "";
        const body =
          typeof b.toolCallId === "string"
            ? toolResults.get(b.toolCallId)
            : undefined;
        const prev = activities[activities.length - 1];
        if (
          prev &&
          prev.type === "tool" &&
          prev.label === label &&
          prev.detail === detail
        ) {
          prev.count = (prev.count ?? 1) + 1;
        } else {
          activities.push({
            timestamp: ts,
            type: "tool",
            icon: iconForCanonicalLabel(label),
            label,
            detail,
            detailBody: body,
          });
        }
      }
    }
  }

  return { activities, tokenCount: 0, modelName, sessionStartTime };
}

/** Resolve a synthetic `cursor:<projHash>/<chatId>` id to activities. */
export function parseCursorSessionActivities(
  cursorId: string,
): ActivityEntry[] {
  const chatDir = join(getCursorChatsDir(), cursorId);
  const chat = parseCursorChat(chatDir);
  if (!chat) return [];
  return parseCursorActivities(chat.lines).activities;
}

// --- discovery ------------------------------------------------------------------------

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

const isDirAt = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

interface CursorMeta {
  agentId: string;
  name: string | null;
  cwd: string;
  schemaVersion: string | undefined;
  updatedAtMs: number;
  title: string | null;
  model: string | null;
  context: { used: number; window: number } | null;
}

function parseCursorMeta(chatDir: string): CursorMeta | null {
  const chat = parseCursorChat(chatDir);
  if (!chat) return null;
  const parsed = parseCursorActivities(chat.lines);
  const title =
    parsed.activities.find((a) => a.type === "user")?.detail ??
    chat.name ??
    null;
  return {
    agentId: chat.agentId,
    name: chat.name,
    cwd: chat.cwd,
    schemaVersion: chat.schemaVersion,
    updatedAtMs: chat.updatedAtMs,
    title,
    model: parsed.modelName,
    context: chat.context,
  };
}

function makeNode(
  meta: CursorMeta,
  projHash: string,
  chatId: string,
  hidden: boolean,
): SessionNode {
  const projectName = basename(meta.cwd);
  const node: SessionNode = {
    id: meta.agentId,
    hideKey: `${projectName}/${meta.agentId}`,
    filePath: cursorSessionPath(projHash, chatId),
    projectPath: meta.cwd,
    projectName,
    lastModifiedMs: meta.updatedAtMs,
    status: getSessionStatus(meta.updatedAtMs),
    modelName: meta.model,
    subAgents: [],
    nonInteractive: false,
    firstUserPrompt: meta.title,
    liveState: null,
    provider: "cursor",
    version: meta.schemaVersion,
  };
  // Context gauge: set only when the walk found a readable field-5
  // payload (used/window). Window = 0 means "no gauge" so we never
  // divide by zero or show a 0% bar.
  if (meta.context && meta.context.window > 0) {
    const { used, window } = meta.context;
    node.contextUsage = {
      used,
      total: window,
      percent: Math.min(100, Math.round((used / window) * 100)),
    };
  }
  if (hidden) node.hidden = true;
  return node;
}

function discoverCursorSessions(
  config: GlobalConfig,
  _options?: DiscoverOptions,
): SessionTree {
  const root = getCursorChatsDir();
  const empty: SessionTree = {
    projects: [],
    coldProjects: [],
    totalCount: 0,
    timestamp: new Date().toISOString(),
    hiddenStats: { total: 0, active: 0 },
  };
  if (!existsSync(root) || !loadSqlite()) return empty;

  const nodesById = new Map<string, SessionNode>();
  const byProject = new Map<string, SessionNode[]>();
  let hiddenTotal = 0;
  let hiddenActive = 0;

  for (const projHash of safeReadDir(root)) {
    const projDir = join(root, projHash);
    if (!isDirAt(projDir)) continue;
    for (const chatId of safeReadDir(projDir)) {
      const chatDir = join(projDir, chatId);
      if (!isDirAt(chatDir)) continue;
      const meta = parseCursorMeta(chatDir);
      if (!meta) continue;
      const projectName = basename(meta.cwd);
      const hidden =
        config.hiddenProjects.includes(projectName) ||
        config.hiddenSessions.includes(`${projectName}/${meta.agentId}`);
      const node = makeNode(meta, projHash, chatId, hidden);
      nodesById.set(node.id, node);
      if (hidden) {
        hiddenTotal++;
        if (node.status === "hot" || node.status === "warm") hiddenActive++;
      }
      const arr = byProject.get(meta.cwd) ?? [];
      arr.push(node);
      byProject.set(meta.cwd, arr);
    }
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

// --- provider object -----------------------------------------------------------------------

export const cursorProvider: SessionProvider = {
  name: "cursor",
  lineDelimited: false,
  isAvailable: (): boolean =>
    existsSync(getCursorChatsDir()) && loadSqlite() != null,
  discoverSessions: discoverCursorSessions,
  parseActivities: parseCursorActivities,
};
