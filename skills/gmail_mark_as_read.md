# Skill: gmail_mark_as_read

- **Slug**: `gmail_mark_as_read`
- **Status**: pending
- **Created at**: 2026-04-13T17:51:21+00:00

## Capability

Mark one or more Gmail messages as read (remove the UNREAD label) given a list of message IDs.

## Suggested approach

Use the Gmail API PATCH /gmail/v1/users/me/messages/{id}/modify endpoint with removeLabelIds: ['UNREAD']. Accept a list of message_ids so multiple messages can be marked at once.

## Triggers

- `2026-04-13T17:51:21+00:00` — Marca como lido o email 'Claude Incident - Claude.ai down - 13 April 2026' de noreply@statuspage.io
