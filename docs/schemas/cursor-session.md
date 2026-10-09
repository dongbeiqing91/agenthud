# Cursor Agent Chats — On-Disk Schema

Empirical schema from a live Cursor install on macOS (Cursor 2.5 /
`cursor-cli` chats), verified against every local chat by recursive
decoding of all blobs. **Undocumented format** — fields were reverse-
engineered; re-run the verification commands below after Cursor updates.

> ⚠️ The `meta` record carries a `blobEncryptionKey` field that is
> currently UNUSED (all message blobs are plain JSON). If Cursor starts
> populating it, the provider must refuse to parse (agenthud treats an
> undecodable corpus as unavailable rather than rendering garbage).

## File layout

One directory per chat, grouped under a per-project hash:

```
~/.cursor/chats/<projectHash>/<chatId>/
├── meta.json    # plain JSON, chat metadata
└── store.db     # SQLite, all messages + chain structure
```

- `<projectHash>` — opaque per-workspace hash (e.g.
  `ec84bc79c3eeae4b831757302fbf099f`). Do not derive it; the workspace
  comes from `meta.json.cwd`.
- `<chatId>` — UUIDv4; identical to `agentId` inside `store.db`.
- Override the root with `CURSOR_CHATS_DIR` for tests.

## `meta.json`

```json
{"schemaVersion":1,"createdAtMs":1788529172086,"hasConversation":false,
 "updatedAtMs":1788529178889,"cwd":"/Users/bedong/Everything"}
```

| Field           | Type   | Notes                                                        |
|-----------------|--------|--------------------------------------------------------------|
| `schemaVersion` | number | agenthud's version gate — bump handling when it changes     |
| `createdAtMs`   | number | epoch ms                                                     |
| `updatedAtMs`   | number | epoch ms; used for status windows (hot/warm/cool/cold)      |
| `hasConversation` | boolean | `false` → no `store.db` exists yet; chat is skipped     |
| `cwd`           | string | workspace directory (the project key in the tree)            |

## `store.db` tables

```sql
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);
```

### `meta` — key `'0'`

`value` is the **hex encoding of a JSON string**:

```json
{"agentId":"<chatId>","latestRootBlobId":"<64-hex>",
 "name":"New Agent","mode":"default","isRunEverything":false,
 "createdAt":1788529172086,"blobEncryptionKey":"<64-hex, unused>"}
```

- `latestRootBlobId` — the **current state node** of the chat. It
  carries field 1 refs to *all* conversation message blobs (in order),
  the context gauge (field 5), and a field 8 successor that points at
  a diff/state blob (payload shape unverified — agenthud follows it,
  extracts nothing, and stops).
- `name` — the chat's display name; almost always the generic
  `"New Agent"`, so agenthud titles chats from the first user query.

### `blobs` — two content-addressed kinds

`id` = SHA-256 of the blob bytes, hex (64 chars). Inside protobuf refs
the same id appears as **raw 32 bytes**.

**Message blobs** — plain JSON:

```json
{"role":"assistant",
 "content":[{"type":"text","text":"..."}],
 "id":"as1","providerOptions":{"cursor":{"modelProviderMessageId":"msg_as1"}}}
```

| `role`      | `content` shape                                              |
|-------------|--------------------------------------------------------------|
| `system`    | string — the system prompt; model name embedded as `powered by <Model>` |
| `user`      | string (injected noise) or array of blocks (real query)     |
| `assistant` | array of blocks: `reasoning` / `text` / `tool-call`         |
| `tool`      | array of `tool-result` blocks (result for a prior call)     |

Block fields:

- `text`: `{type:"text", text}`
- `reasoning`: `{type:"reasoning", text, signature}`
- `tool-call`: `{type:"tool-call", toolCallId, toolName, args}` —
  `toolName` is CamelCase (`Shell`, `Glob`, …); `args` is
  Claude-shaped (`{command}`, `{pattern}`, …) and feeds agenthud's
  `summarizeToolDetail` pipeline after lowercasing.
- `tool-result`: `{type:"tool-result", toolCallId, toolName, result,
  experimental_content}` — `result` is the plain result text.

**User-message noise** — cursor-cli injects context around the real
query. The actual query is wrapped in a `<user_query>…</user_query>`
tag, usually prefixed by a `<timestamp>…</timestamp>` block inside the
same text block:

```
<timestamp>Friday, Sep 4, 2026, 10:19 PM (UTC+8)</timestamp>
<user_query>
List the files in the current directory, then write 200 words
</user_query>
```

A separate leading user message carries `<user_info>…</user_info>`
(OS, shell, workspace path, date) plus `<agent_transcripts>` context —
pure noise for display.

**Node blobs** — undocumented protobuf linking messages into a chain.
Observed fields (all verified; unknown fields are skipped by the
reader, so Cursor may add fields without breaking agenthud):

| Field | Wire type | Meaning                                   |
|-------|-----------|-------------------------------------------|
| `1`   | bytes (32, repeated) | message blob refs (raw sha256) |
| `8`   | bytes (32) | successor node ref; absent on the last node |
| `9`   | string   | workspace as `file://<cwd>`               |
| `10`  | varint   | unknown (observed: 1)                      |
| `22`  | string   | source (`cli` observed)                    |
| `26`  | varint   | epoch ms — timestamp applied to the node's messages |
| `27`  | string   | IANA timezone (e.g. `Asia/Shanghai`)       |
| `5`   | nested message | context gauge: `{1: usedTokens (varint), 2: windowTokens (varint), 3: repeated breakdown}` — see below |
| `2`   | nested message | opaque config blob (observed); not needed for display |

**Context gauge (node field 5)** — nested message:

| Field | Wire type | Meaning                          |
|-------|-----------|----------------------------------|
| `1`   | varint    | used tokens (current state)      |
| `2`   | varint    | context window of the active model |
| `3`   | repeated nested | per-component breakdown (`system_prompt`, `rules`, `skills`, `mcp`, `subagents`, `summarized_conversation`, `conversation`) — agenthud does not use it |

Observed: `used=26040, window=256000` for a Grok 4.6 chat. Older state
snapshots of the same chat (also in `blobs`) carry their own field 5; the
provider takes the gauge from the latest state node that has one.

**Chain semantics** — `latestRootBlobId` → `field8` → … . The root holds
the full conversation, so the field 8 successor is normally an opaque
diff blob; the walker follows at most a bounded chain (cycle-guarded via
a visited set) and only 32-byte field 1 payloads count as message refs,
so opaque payloads are skipped harmlessly.

## What the agenthud `cursor` provider consumes

- **Discovery**: `meta.json` (cwd, updatedAtMs, schemaVersion,
  hasConversation) + a chain walk for title/model. mtime-cached
  (store.db mtime key) since `lineDelimited` is false — the blob chain
  has no append-only log for tail parsing.
- **Titles**: first `<user_query>` text (noise stripped), falling back
  to the generic `meta.name`.
- **Model**: `powered by <Model>` extracted from the system prompt.
  Message blobs carry no model field (`providerOptions` only has the
  provider message id).
- **Activities**: user text → `user`; `reasoning` → `thinking`;
  `text` → `response`; `tool-call` → `tool` (canonical label, args
  detail); `tool`-role results merge into the call's `detailBody`.
- **Context gauge**: node field 5 `{used, window}` → `contextUsage`
  (used / total / percent). Chats whose state nodes carry no readable
  gauge show no gauge (never an error).
- **Sub-agents**: NOT mapped in the MVP — cursor-cli sub-agent runs
  (`agent.taskToolCallHandler` traces exist in the app) have no
  verified on-disk shape in the local corpus yet.

## Verify the schema yourself

```bash
# node with node:sqlite (Node 22+) — one-liner audit of every chat
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const root = join(homedir(), ".cursor", "chats");
for (const p of readdirSync(root)) {
  const pd = join(root, p);
  if (!statSync(pd).isDirectory()) continue;
  for (const c of readdirSync(pd)) {
    const dbp = join(pd, c, "store.db");
    if (!statSync(join(pd, c)).isDirectory() || !statSync(dbp).isFile()) continue;
    const db = new DatabaseSync(dbp, { readOnly: true });
    const rows = db.prepare("SELECT data FROM blobs").all();
    const roles = {}, kinds = {};
    for (const r of rows) {
      let m; try { m = JSON.parse(Buffer.from(r.data).toString()); } catch { kinds["proto"] = (kinds["proto"] ?? 0) + 1; continue; }
      roles[m.role] = (roles[m.role] ?? 0) + 1;
    }
    console.log(c, JSON.stringify({ roles, kinds, blobs: rows.length }));
    db.close();
  }
}'
# meta record (key '0') of one chat: hex-decode the JSON
sqlite3 ~/.cursor/chats/<proj>/<chat>/store.db \
  "SELECT value FROM meta WHERE key='0';" | \
  python3 -c 'import sys; print(bytes.fromhex(sys.stdin.read().strip()).decode())'
```

## Notes / caveats

- The local corpus is 100% `cursor-cli` chats (`field22 = "cli"`).
  IDE-origin chats (if `field22 = "ide"` or similar) are presumed
  same-shaped but unverified.
- `blobEncryptionKey` is present but unused in every local blob. Treat
  its future population as a breaking change for this provider.
- `meta.json.schemaVersion` is the version gate; the parser degrades
  to skipping a chat (not crashing) when expected fields are missing.
- Node timestamps (`field26`) are per-node, not per-message — long
  turns share one timestamp.
