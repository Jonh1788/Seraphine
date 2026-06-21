# Maestro agent stream-json fixtures

Real captured output of the local `claude` CLI (Claude Code **v2.1.183**) running in
headless bidirectional **stream-json** mode. These files are the source of truth for the
Rust supervisor's stream-json parser (a later Maestro task). Every shape below is quoted
from the actual captured `.jsonl` in this directory — not from docs or memory.

## How these were captured

Each capture ran in a throwaway `git init` directory, authenticated via the user's
existing OAuth (Claude Max) session — `apiKeySource` / `apiKeySource:"none"` in the init
line confirms no API key was used.

Two CLI behaviours we discovered (important, document them — the plan's commands needed
adjusting):

1. **Use a pipe, not a heredoc.** `claude ... <<< '{json}'` (the herestring in the
   original plan) caused the CLI to emit only the SessionStart hook lines and then stall —
   stdin wasn't closed in a way the CLI flushed a full turn. Feeding the prompt via
   `printf '%s\n' '{json}' | claude ...` (stdin closes cleanly) produces a complete run.

2. **Suppress hook noise with `--setting-sources ""`.** Without it, the user's global
   `SessionStart` hook (superpowers) prepends two huge `{"type":"system","subtype":"hook_started"|"hook_response"}`
   lines that drown the real protocol. `--setting-sources ""` loads no user/project/local
   settings (so no hooks) **while keeping OAuth auth**. (`--bare` also skips hooks but
   breaks OAuth — it forces `ANTHROPIC_API_KEY`-only auth and produced empty output, so we
   did **not** use it.) The Maestro Rust supervisor should likewise spawn with
   `--setting-sources ""` (or an explicit settings file) to get a clean, deterministic
   stream.

### `basic_run.jsonl` — non-permission run

```bash
cd "$(mktemp -d)" && git init -q
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with exactly: pong"}}' \
  | claude -p --output-format stream-json --input-format stream-json \
      --setting-sources "" --verbose \
  > basic_run.jsonl
```

### `permission_request.jsonl` — real `can_use_tool` permission round-trip

The original plan's `--permission-mode default` prompt does **not** emit a permission
event. In plain headless `-p` mode the CLI **auto-denies** the gated tool: it emits the
`tool_use`, then a synthetic `{"type":"user",...}` line whose `tool_result` has
`is_error:true` ("Claude requested permissions to write to … but you haven't granted it
yet"), and records the denial in the final `result` line under `permission_denials[]`.
No `control_request` is produced. `--permission-mode plan` likewise only produces an
`ExitPlanMode` **tool_use** (still auto-denied the same way), not a control event.

To get a **real** `can_use_tool` control_request the parent must spawn the CLI with
`--permission-prompt-tool stdio`. That sentinel value routes the permission decision back
to the parent over the stream-json control channel instead of auto-denying. (This is what
the Agent SDK does internally whenever a `canUseTool` callback is supplied — verified
against `@anthropic-ai/claude-agent-sdk`.) We then send an `initialize` control_request,
the user prompt, read the `can_use_tool` control_request, and reply with a `control_response`
(`behavior:"allow"`). The write then succeeds and the run completes — confirming a full
round-trip. Captured with a small Python driver:

```bash
cd "$(mktemp -d)" && git init -q
claude -p --output-format stream-json --input-format stream-json \
  --permission-mode default --permission-prompt-tool stdio \
  --setting-sources "" --verbose
# stdin (in order):
#   {"type":"control_request","request_id":"init-1","request":{"subtype":"initialize","hooks":{}}}
#   {"type":"user","message":{"role":"user","content":"Create a file notes.txt containing the word hello"}}
#   (after reading the can_use_tool request) ->
#   {"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"allow","updatedInput":{...}}}}
```

> Fixture note: line 1 of `permission_request.jsonl` is the CLI's `control_response` reply
> to our `initialize` request. Its real payload is ~8 KB (full `commands`/`agents`/`models`
> lists); for readability those four arrays were replaced with
> `["...truncated for fixture readability..."]`. The envelope (`type`, `response.subtype`,
> `response.request_id`) is verbatim. Every other line is unmodified.

---

## Line-by-line reference (the parser must match these)

`--verbose` makes the CLI emit one JSON object per line (JSONL). The parser reads a line,
`json.loads` it, and switches on the top-level `type`.

### `system` / `init` — first line of every run; carries `session_id`

`type:"system"`, `subtype:"init"`. **`session_id` is a top-level field on this line**
(also present on most subsequent lines). Also exposes `cwd`, `model`, `permissionMode`,
`tools` (array of available tool names), `mcp_servers`, `claude_code_version`,
`apiKeySource`. From `basic_run.jsonl` line 1 (abridged):

```json
{"type":"system","subtype":"init","cwd":"/private/var/folders/.../tmp.9pqv8tBjgu","session_id":"e6ce309f-b7f6-4ff7-a4b0-f2afaa4ce3bb","tools":["Task","AskUserQuestion","Bash", ...],"model":"claude-opus-4-8[1m]","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.183", ...}
```

Parser: treat `type=="system" && subtype=="init"` as session start; read `session_id`,
`model`, `tools`, `cwd`.

### `rate_limit_event` — usually line 2; non-essential

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1782030000,"rateLimitType":"five_hour", ...},"session_id":"e6ce309f-..."}
```

Parser: can ignore, or surface `rate_limit_info.status`.

### `assistant` — model output (text and/or tool_use)

`type:"assistant"`. The Anthropic message is nested under `message`; the content blocks are
in `message.content[]`. Text block (`basic_run.jsonl` line 3, abridged):

```json
{"type":"assistant","message":{"model":"claude-opus-4-8","id":"msg_01AAiXWPTefeB4B9fYwAmMJ3","role":"assistant","content":[{"type":"text","text":"pong"}],"stop_reason":null,"usage":{...}},"parent_tool_use_id":null,"session_id":"e6ce309f-...","uuid":"b04001c4-...","request_id":"req_011CcFn8xH1vn9RN5qiUcgUs"}
```

A **tool_use** comes as a separate `assistant` line whose `message.content[]` holds a
`{"type":"tool_use","id":"toolu_…","name":"Write","input":{…},"caller":{"type":"direct"}}`
block (`permission_request.jsonl` line 5). The `tool_use` `id` (e.g. `toolu_01RumGmejZFG…`)
is what later correlates to the permission request's `tool_use_id` and to the `tool_result`.

Parser: iterate `message.content[]`; dispatch per block `type` (`text`, `tool_use`,
`thinking`). Note multiple `assistant` lines can share one `message.id` (text then
tool_use streamed as separate lines).

### `user` — tool results fed back into the model

`type:"user"`. After a tool runs, its result returns as a `user` line with
`message.content[]` holding a `tool_result` block keyed by `tool_use_id`. Success example
(`permission_request.jsonl` line 7, after we allowed the Write):

```json
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01RumGmejZFGcVhFGHqqpPJQ","type":"tool_result","content":"File created successfully at: /…/notes.txt …"}]},"parent_tool_use_id":null,"session_id":"088fa7c9-...","uuid":"eb9238f1-...","tool_use_result":{"type":"create","filePath":"/…/notes.txt","content":"hello\n", ...}}
```

In the **auto-deny** path (no `--permission-prompt-tool stdio`) this same line type carries
`is_error:true` and the "you haven't granted it yet" message instead — see below.

### `result` — final line; terminal status + cost + denials

`type:"result"`, `subtype:"success"` (or an error subtype). Carries `result` (the final
assistant text), `is_error`, `num_turns`, `duration_ms`, `total_cost_usd`, `usage`,
`session_id`, `terminal_reason`, and crucially **`permission_denials[]`**. Success with no
denials (`basic_run.jsonl` line 4, abridged):

```json
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"pong","stop_reason":"end_turn","session_id":"e6ce309f-...","total_cost_usd":0.04588,"permission_denials":[],"terminal_reason":"completed", ...}
```

Parser: `type=="result"` ends the run. Check `is_error`/`subtype` for success vs failure;
`permission_denials[]` lists tools the CLI auto-denied (see below).

### `control_request` / `subtype:"can_use_tool"` — the REAL permission request

**This is the event Maestro's supervisor must intercept and answer.** Emitted only when the
CLI was spawned with `--permission-prompt-tool stdio`. Verbatim from
`permission_request.jsonl` line 6:

```json
{"type":"control_request","request_id":"28e3e0c5-e128-4d6f-bb52-f2b1f957b38b","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/…/notes.txt","content":"hello\n"},"description":"notes.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_01RumGmejZFGcVhFGHqqpPJQ"}}
```

Field map for the parser:

| Field | Location | Notes |
|---|---|---|
| message kind | top-level `type` == `"control_request"` | distinguishes from `assistant`/`user` |
| **request id** | top-level **`request_id`** | a UUID. Echo this back in the `control_response`. |
| permission subtype | **`request.subtype`** == `"can_use_tool"` | a `control_request` can have other subtypes too |
| **tool name** | **`request.tool_name`** (also `request.display_name`) | e.g. `"Write"` |
| tool input | `request.input` (object) | the args the model wants to run |
| correlating tool_use id | `request.tool_use_id` | matches the `tool_use` block's `id` |
| suggested auto-approve | `request.permission_suggestions[]` | e.g. `{"type":"setMode","mode":"acceptEdits","destination":"session"}` |
| human label | `request.description` | e.g. `"notes.txt"` |

### `control_response` — what the PARENT (Maestro) sends back

The supervisor writes this to the CLI's stdin to allow/deny. The `request_id` MUST equal
the `control_request`'s top-level `request_id`. The envelope `subtype` is `"success"` for
BOTH allow and deny (a deny is a *successful* control response carrying a deny `behavior`;
`subtype:"error"` is only for the callback itself throwing). Allow (what we sent in the
capture):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"28e3e0c5-…","response":{"behavior":"allow","updatedInput":{"file_path":"/…/notes.txt","content":"hello\n"}}}}
```

Deny shape (for the parser/tests — `message` carries the reason, optional `interrupt`):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"deny","message":"User denied this action","interrupt":false}}}
```

Note the inner `PermissionResult` is **camelCase** (`behavior`, `updatedInput`,
`updatedPermissions`, `toolUseID`) even though the inbound request used snake_case
(`tool_name`, `tool_use_id`, `input`). The SDK also appends `"toolUseID": "<tool_use_id>"`
to the inner object; the CLI primarily correlates on the outer `request_id`.

### `control_response` (init handshake) — line 1 of permission_request.jsonl

The CLI's reply to the parent's `initialize` `control_request`. Envelope:
`{"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":{…}}}`.
Its payload advertises `commands`, `agents`, `models`, `account`, etc. (truncated in the
fixture — see note above). The supervisor can largely ignore the body; it just confirms the
control channel is live.

---

## Auto-deny path (NO `--permission-prompt-tool stdio`) — for completeness

When the CLI is spawned WITHOUT `--permission-prompt-tool stdio`, a gated tool is
auto-denied. We did not keep a separate fixture for this (the canonical fixture is the
real round-trip above), but the observed shapes the parser may also encounter are:

- the gated `tool_use` (normal `assistant` line), then
- a synthetic `user` line: `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Claude requested permissions to write to /…/notes.txt, but you haven't granted it yet.","is_error":true,"tool_use_id":"toolu_…"}]}, "tool_use_result":"Error: Claude requested permissions to write to /…, but you haven't granted it yet."}`, then
- the final `result` line records it:
  `"permission_denials":[{"tool_name":"Write","tool_use_id":"toolu_…","tool_input":{"file_path":"/…/notes.txt","content":"hello\n"}}]`.

So the supervisor should treat a `result` with a non-empty `permission_denials[]` as
"agent hit a permission wall but the parent never got asked" — a signal the CLI wasn't
spawned with `--permission-prompt-tool stdio`.

---

## `fake_agent.sh` — replay harness

`fake_agent.sh <fixture.jsonl> [--wait-stdin-after <N>]` replays a captured fixture as if it
were `claude`, with NO API cost — for testing the Rust supervisor.

- Without flags: prints every line and exits 0.
- With `--wait-stdin-after N`: prints the first N lines, then blocks until one line arrives
  on stdin (simulating the permission round-trip — the supervisor's `control_response`),
  then prints the rest. For `permission_request.jsonl` the `can_use_tool` request is
  **line 6**, so `--wait-stdin-after 6` makes the fake agent pause right after asking for
  permission until the supervisor answers.
