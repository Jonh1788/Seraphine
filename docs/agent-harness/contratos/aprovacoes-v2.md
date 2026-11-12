# Seraphine agent harness: approvals v2 (wire contract)

This file is the contract between the backend and the frontend for the hardened
approval flow. Backend and frontend are implemented by different people at the
same time, so neither side may deviate from it. If something here is impossible,
stop and report instead of inventing a variant.

## Why

Today an agent ends a turn with an `approval-request` block, the harness stores
`{title, command, reason}`, the owner clicks Approve, and the harness runs the
stored command with PowerShell in the project folder with the backend's full
environment. Weak points being fixed:

1. Nothing tells the owner how dangerous a command is.
2. Nothing ties the decision to the exact command the owner saw on screen.
3. A request stays approvable forever.
4. There is no record of who decided, and a denial cannot carry a reason back to the agent.
5. The approved command inherits every environment variable of the backend (API keys included).

## Approval object (every place an approval is returned)

Existing fields stay: `id, run_id, agent_id, project_id, title, command, reason,
status, output, created_at, decided_at`.

New fields, always present (never missing; `null` only where stated):

| field | type | meaning |
|---|---|---|
| `risk_level` | `"low" \| "medium" \| "high"` | result of the command classifier |
| `risk_reasons` | `string[]` | short pt-BR sentences, one per finding; `[]` for low |
| `command_digest` | `string` | lowercase hex SHA-256 of `"v1\n" + run_id + "\n" + id + "\n" + command` (UTF-8) |
| `expires_at` | `string` (ISO 8601 UTC, same format as `created_at`) | after this instant the request can no longer be approved |
| `decided_by` | `"owner" \| "harness" \| null` | `null` while pending |
| `decision_note` | `string \| null` | optional reason given with a denial, or the automatic reason |

`status` is one of `"pending" | "approved" | "denied" | "expired"`.

`GET /agents/approvals?status=` accepts the four statuses (default stays `pending`).

## Deciding

`POST /agents/approvals/{id}/decide`

```json
{ "decision": "approve" | "deny",
  "digest": "<command_digest shown to the owner>",
  "confirm_high_risk": true,
  "note": "optional text, max 500 chars" }
```

- `digest` is required for `approve` (422 when absent). It must equal the stored
  `command_digest`, otherwise 409 with code `digest_mismatch`. Optional for `deny`.
- When `risk_level` is `high`, `approve` needs `confirm_high_risk: true`,
  otherwise 409 with code `high_risk_unconfirmed`.
- `note` is stored as `decision_note` (trimmed, max 500 chars). On a denial it is
  passed to the agent in the message that resumes the session.
- Deciding after `expires_at`: 409 with code `approval_expired`; the approval
  becomes `expired` and its run ends `failed` with error code `approval_expired`.
- Existing 409 codes stay: `already_decided`, `run_not_waiting`.
- `decided_by` is `"owner"` for every decision that arrives through this route.

The error body keeps the shape the harness already uses for conflicts (a human
message plus the machine `code`); the frontend reads the `code`.

## Expiry

- `expires_at = created_at + agents_approval_ttl_s` (new setting, default 86400 seconds).
- Overdue pending approvals are expired by the harness itself (not only when
  someone tries to decide): status `expired`, `decided_by: "harness"`, run
  `failed` with error code `approval_expired`, a short pt-BR message in the
  project channel, and the usual live frames so open pages update.

## Automatic refusal

Some commands are never offered to the owner (encoded PowerShell, disk and boot
tools, anything that points at Seraphine's own data folder or database). For
those the harness still records the approval, but already decided:
`status: "denied"`, `decided_by: "harness"`, `decision_note: "<pt-BR reason>"`,
`risk_level: "high"`. The run does not wait: the agent is told the request was
refused and why, exactly as with an owner denial. It counts toward the
per-run approval limit.

## Run events

- `approval_request` payload: existing `approval_id, title, command, reason`
  plus `risk_level, risk_reasons, digest, expires_at`.
- `approval_result` payload: existing `approval_id, decision, title` plus
  `decided_by` and `note` (string or null). `decision` may now also be `"expired"`.
- `command` event (the harness running an approved command) keeps its payload.

## Run error codes (new)

`approval_expired`, `approval_tampered` (the stored command no longer matches
its digest at execution time; the command is not run).

## Execution of an approved command (backend only)

- Recompute the digest from the stored row right before running; on mismatch do
  not run, fail the run with `approval_tampered`.
- The child process gets a minimal environment built from an allow-list of
  ordinary system variables. Nothing named like a secret and no `SERAPHINE_*`
  variable reaches it.
- Before the output is stored, sent to the page or handed back to the agent,
  values of the backend's secret-looking environment variables are replaced
  with `[oculto]`.
