# 051 — Speech Bubbles

## Scope

Small bubble rendered next to avatar with short text. Non-modal,
fade after 5s, clickable → opens main chat window.

## Sources

Any of these becomes a bubble instead of (or in addition to) a full chat:
- `assistant_opener` (022-D) — if main window is hidden.
- Discovery surface (030-A) — low-urgency.
- Mood transition notice.
- Remote approval request (045) — highest priority, stays until click.

## Implementation

- New component `<BubbleLayer>` inside `AvatarCompanion.tsx`
- State: queue of `{id, text, priority, expiresAt}`
- One bubble at a time; priority=high preempts existing.
- CSS animation: slide + fade.
