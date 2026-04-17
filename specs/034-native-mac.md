# 034 — Native Mac Integrations

## Context

Com o proxy (033) operando, ferramentas via AppleScript/Shortcuts.app
viram triviais. Esta spec adiciona 3 capacidades de alto valor diário.

## Escopo

- **osascript tool** — `osascript_run`: executa AppleScript arbitrário no
  Mac. Usado pra iMessage, Spotify, Notes.app, lembretes nativos.
- **shortcuts_run tool** — dispara qualquer Atalho do Shortcuts.app
  pelo nome. Usuário cria o Atalho uma vez, Seraphine chama sempre.
- **open tool** — `open_path`: abre arquivo/pasta/URL com app default.

Tudo via proxy. Zero infra nova, só:

- Rust cmd `osascript_local(script: String)` em `mac_tools.rs`
- Rust cmd `shortcuts_run_local(name: String, input: Option<String>)`
- Rust cmd `open_path_local(target: String)`
- Backend tools com `proxy_to_client = True`
- Frontend proxy handlers mapeando pros invokes

## Riscos

- **osascript pode fazer qualquer coisa**: requires_confirmation=True
  por default, aprovação humana nos comandos destrutivos.
- **Shortcuts inexistente**: retorna erro 'shortcut not found', LLM
  pode listar com `shortcuts list`.
