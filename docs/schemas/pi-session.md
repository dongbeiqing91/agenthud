# pi (pi-coding-agent) Session Files — On-Disk Schema

Empirical schema from a live pi install on macOS
(`@earendil-works/pi-coding-agent`), including sessions with rollbacks
(branched trees) and compaction. Verification commands at the bottom.

## File layout

Sessions are append-only JSONL files, one per conversation:

```
~/.pi/agent/sessions/<sanitized-cwd>/<ISO>_<uuid>.jsonl
```

- `<sanitized-cwd>` is the resolved cwd with `/` and `:` replaced by `-`
  and wrapped in `--…--` (e.g.
  `/Users/neo/myapp` → `--Users-neo-myapp--`).
- `<ISO>` is the creation time with `:` and `.` replaced by `-`
  (e.g. `2026-10-09T08-38-43-648Z`).
- `<uuid>` is the session id (UUIDv7 — time-ordered), also in the header.
- Override the sessions root with `PI_SESSIONS_DIR`; the model registry
  file (below) follows `PI_MODELS_FILE`, defaulting to
  `<agentDir>/models.json` (the parent of the sessions root).
- A `.touches.json` sidecar file sits next to each session — pi's own
  bookkeeping; agenthud ignores it (only `*.jsonl` is scanned).

The agent dir (`~/.pi/agent/`) also holds `models.json` (per-provider
model registry) and `ephemeral-sessions/` (pi-subagents child runs,
cleaned up after the run — intentionally NOT discovered by agenthud).

## Record envelope

Every line after the header is an entry with `{type, id, parentId,
timestamp}`:

```ts
interface PiEntry {
  type: string;
  id: string; // 8-char hex, unique within the file
  parentId: string | null; // previous entry on the branch
  timestamp: string; // ISO 8601
}
```

**Entries form a tree, not a list.** `parentId` chains each entry to the
previous one, but pi's rollback forks within the same file: after
branching back to an earlier entry, new appends continue from there,
leaving the abandoned suffix as a **dead branch**. The active branch is
the path from the file's LAST entry (the live leaf) back to `parentId:
null`. The header (first line) is NOT part of the `parentId` chain — the
first real entry has `parentId: null`.

Forks (`fork` command / SDK `forkFrom`) write a NEW file whose header
carries `parentSession: "<source file path>"`; the fork may live in a
different `<sanitized-cwd>` dir.

## `session` — header (first line)

```json
{"type":"session","version":3,"id":"01a11fe5-9361-7153-8624-722dc5269510",
 "timestamp":"2026-10-09T09:01:41.601Z","cwd":"/Users/neo/myapp",
 "parentSession":"/path/to/source.jsonl"}
```

| Field | Notes |
|---|---|
| `version` | schema version (`3` observed; v1→v2→v3 migrations exist in pi) |
| `id` | full UUIDv7 session id |
| `cwd` | resolved working directory — the project key for agenthud |
| `parentSession` | only on forks; path of the source session file |

## `message` — transcript entries

`message.role` values (observed): `system`, `user`, `assistant`,
`toolResult`, `bashExecution` (pi-web-ui terminal runs).

- `system` — the preamble/tools/rules block; skip in activity views.
- `user` — `content` is a string OR an array of
  `{type:"text"|"image"}` blocks.
- `assistant` — `content` is an array of blocks:
  `{type:"thinking", thinking}`, `{type:"text", text}`,
  `{type:"toolCall", id, name, arguments}`. Also carries
  `provider`, `model` (full model id, e.g.
  `qwen3-8-27b-fp8-gpu/qwen3-8-27b-fp8`), `stopReason` (`stop` /
  `toolUse` / `aborted` / `error`), `usage`
  (`{input, output, cacheRead, cacheWrite, totalTokens, cost}`),
  `api`, `durationMs`, `thinkingLevel`.
- `toolResult` — a SEPARATE entry (like Claude's), keyed to its call by
  `toolCallId` + `toolName`; `content` is a string or text/image
  blocks; `isError` on failure.
- `bashExecution` — pi-web-ui terminal-backed runs: `command` + `output`
  strings, `excludeFromContext` flag.

Tool names are lowercase (`read`, `write`, `edit`, `bash`, `grep`,
`find`, `ls`, `mcp`, `subagent`, …) and args use `path` (NOT Claude's
`file_path`). agenthud normalizes `path` → `file_path` before the shared
summarizers and maps names through the canonical tool taxonomy.

## Control / metadata entries

| `type` | Purpose |
|---|---|
| `model_change` | `{provider, modelId}` — last one on the active branch wins |
| `thinking_level_change` | `{thinkingLevel}` |
| `session_info` | `{name}` — auto/user session title (last one wins) |
| `compaction` | `{summary, tokensBefore, firstKeptEntryId, usage, systemMessage?}` |
| `branch_summary` | `{fromId, summary}` — written when a rollback abandons a branch |
| `usage` | session-level usage notes |
| `label` | `{targetId, label}` — user labels on entries |
| `context_edit` | `{targetId, replacement}` — rewrite of an entry's content |
| `custom_message` | `{customType, content, display?}` — e.g. system reminders |

## Context-window usage (for a gauge)

`<agentDir>/models.json` (default `~/.pi/agent/models.json`):

```json
{"providers": {"<provider>": {"models": [
  {"id": "<modelId>", "contextWindow": 131072, "maxTokens": 32000, "reasoning": true}
]}}}
```

agenthud takes the last assistant `usage.totalTokens` on the active
branch (skipping `stopReason` `aborted`/`error`, mirroring pi's own
`getAssistantUsage`) and divides by `providers[<provider>].models[]`
matched on `<modelId>`. Unknown model → no gauge, never an error.

## What the agenthud `pi` provider consumes

- **Project grouping** — header `cwd` (no directory-name decoding).
- **Title** — last `session_info.name` on the active branch, falling
  back to the latest substantial user message.
- **Model** — last `model_change.modelId` on the active branch
  (fallback: assistant `message.model`).
- **Version** — header `version` (schema version; opaque string).
- **Gauge** — as above.
- **Activities** — user text, assistant thinking/text, tool calls
  (canonical labels, input-based detail, consecutive identical-call
  merge), `bashExecution`, `compaction` / `branch_summary` rows.
  `system`, `toolResult` (enriches its call), and control entries render
  no standalone row. Dead branches are excluded by the leaf→root walk.
- **Status** — file mtime (hot < 30 min, warm < 1 h, cool = today,
  cold). No live-state detection in the MVP.
- **Not yet** — pi-subagents child sessions (ephemeral root) and fork
  nesting across project dirs.

## Verify the schema yourself

```bash
SES=~/.pi/agent/sessions
# entry types across all sessions
cat $(find $SES -name '*.jsonl') | jq -s 'map(.type) | group_by(.) | map({(.[0]): length}) | add'
# message roles
cat $(find $SES -name '*.jsonl') | jq -s 'map(select(.type=="message").message.role) | group_by(.) | map({(.[0]): length}) | add'
# assistant content block types
cat $(find $SES -name '*.jsonl') | jq -s '[.[] | select(.type=="message" and .message.role=="assistant") | .message.content[] | .type] | group_by(.) | map({(.[0]): length}) | add'
# header fields (cwd + version)
for f in $(find $SES -name '*.jsonl' | head -5); do head -1 "$f" | jq '{version, cwd, parentSession}'; done
# model registry shape
jq '.providers | to_entries | map({key, count: (.value.models | length)})' ~/.pi/agent/models.json
```

## Notes / caveats

- pi's session files can be large (multi-MB over a long session); the
  provider caches discovery metadata by (path, mtime).
- Rollback leaves dead branches in the file — always walk from the
  last entry, never assume the file is a flat list.
- The header is excluded from `parentId` chains; don't expect the first
  entry to point at it.
- `context_edit` rewrites other entries' content but does NOT remove the
  originals — agenthud renders the original text (MVP).
