# 045 — Claude Code Approval Bridge

## Context

User runs `claude` CLI on VPSes; approval prompts require him to be
at the remote terminal. This creates friction and idle waits.

## Scope

- `seraphine-claude` wrapper installable on each VPS. Intercepts Claude
  approval via hooks (`PreToolUse`) or PTY wrap.
- Wrapper POSTs `{host, tool_call, diff, context}` to
  `sera.jonhdev.io/approvals/remote`.
- Backend pushes to Mac via WS + mobile push.
- Mac modal shows the tool + args + reason; approve/deny.
- Response travels WS → wrapper → injected as stdin into Claude.
- Timeout 5min default (Claude keeps waiting).

## Schema

```sql
CREATE TABLE remote_approvals (
  id TEXT PRIMARY KEY,
  host TEXT,
  payload_json TEXT,
  decision TEXT,
  decided_at TEXT,
  created_at TEXT
);
```
