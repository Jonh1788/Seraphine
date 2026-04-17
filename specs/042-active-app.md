# 042 — Active App Context

## Context

Saber se você tá no VS Code, Slack ou Safari muda completamente o
que Seraphine deveria sugerir. Hoje ela não sabe.

## Escopo

- Rust cmd `active_app_local()` → retorna `{app_name, window_title}`.
  Implementação: `osascript -e 'tell application "System Events" to
  get name of first application process whose frontmost is true'` +
  AppleScript pra window title.
- Backend tool `active_app` (read-only, `requires_confirmation=False`,
  `proxy_to_client=True`).
- **Injection ambiente**: `build_ambient_block` (023) ganha linha
  "app ativo: X — janela: Y" com cache 60s.

## Riscos

- **osascript lento (~100ms)**: cache 60s mitiga spam.
- **Window title pode vazar info sensível** (ex: "Senha do banco —
  Gmail"): injetar só app_name, não title, por default. Flag
  SERAPHINE_REVEAL_WINDOW_TITLE=true pra quem quiser.
