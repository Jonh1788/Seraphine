# 003 — Tool Use with Human Approval Gate

## Context

Phase 4. Gives Seraphine the ability to read the filesystem and run shell
commands on the user's Mac, **always behind an explicit human approval gate
in the UI** for any operation that mutates state or runs arbitrary code.

This is the highest-risk feature in the project. The gate is non-negotiable
and audited.

## Contracts

### Tool

```python
class Tool(Protocol):
    name: str
    description: str
    json_schema: dict       # JSON Schema for arguments
    requires_confirmation: bool

    async def execute(self, args: dict) -> ToolResult: ...

class ToolResult(BaseModel):
    ok: bool
    output: str | None = None
    error: str | None = None
    metadata: dict = {}
```

JSON Schema for `Tool` declarations: `schemas/tool.schema.json`.

### Initial tool registry

| Tool          | requires_confirmation | Notes                                       |
|---------------|-----------------------|---------------------------------------------|
| `read_file`   | false                 | Read text file under allowed roots          |
| `list_dir`    | false                 | List entries under allowed roots            |
| `write_file`  | true                  | Diff shown in approval panel                |
| `run_shell`   | true                  | Full command shown; cwd and env displayed   |

`read_file` / `list_dir` are still bounded by an `allowed_roots` setting
(default: `~/`, excluding `~/Library` and dotfiles unless explicitly added).

### WebSocket events

Server → client (LLM requests a tool):

```json
{
  "type": "tool_request",
  "request_id": "uuid",
  "tool": "run_shell",
  "args": { "command": "ls ~/Desktop", "cwd": "/Users/jonh1788" },
  "requires_confirmation": true
}
```

Client → server (user approves or rejects):

```json
{ "type": "tool_approval", "request_id": "uuid", "approved": true }
```

Server → client (after execution):

```json
{
  "type": "tool_result",
  "request_id": "uuid",
  "ok": true,
  "output": "Desktop  Documents  ...",
  "error": null
}
```

If `requires_confirmation` is `false`, the backend executes immediately and
emits only `tool_result`. If `true`, the backend blocks until it receives
`tool_approval`.

### Audit log

Every tool invocation is appended to `tool_audit` regardless of approval
outcome:

```sql
CREATE TABLE tool_audit (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL,
  tool          TEXT NOT NULL,
  args_json     TEXT NOT NULL,
  approved      INTEGER,           -- 1, 0, or NULL (no gate)
  ok            INTEGER,
  output_excerpt TEXT,             -- first 4KB
  error         TEXT,
  created_at    TEXT NOT NULL
);
```

## Acceptance criteria (Gherkin)

```gherkin
Feature: Tool use with approval gate

  Scenario: Read-only tool runs without confirmation
    Given the assistant decides to call list_dir on ~/Desktop
    When the tool is dispatched
    Then no tool_request prompt appears in the UI
    And the result is sent back to the LLM
    And tool_audit has one row with approved=NULL and ok=1

  Scenario: Shell command requires approval
    Given the assistant decides to call run_shell with "rm tmp.txt"
    When the backend emits tool_request
    Then the UI shows the command and cwd
    And no execution occurs until the user clicks Approve
    When the user approves
    Then the command runs and tool_result is sent
    And tool_audit has one row with approved=1

  Scenario: User rejects a destructive command
    Given a tool_request is pending
    When the user clicks Reject
    Then no command is executed
    And the LLM receives a tool_result with ok=false and error="rejected by user"
    And tool_audit has one row with approved=0
```

## Open questions

- Per-session approval memory ("trust this command for the next 10 minutes"):
  out of scope for v1; can be added later behind a flag.
- Sandboxing of `run_shell` (chroot, sandbox-exec): not in v1; gate is the
  primary control.
