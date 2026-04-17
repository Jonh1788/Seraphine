# 035 — Screen Automation (cliclick)

## Context

033 trouxe `screen_capture` via proxy. Falta o braço: click, type,
scroll. Fecha o loop "vê → age → verifica" pra automação de app
GUI-only sem API.

## Dependência

Requer `cliclick` instalado no Mac (`brew install cliclick`). Se
ausente, tools retornam erro explicativo.

## Escopo

Rust cmds em `mac_tools.rs`:
- `screen_click_local(x: f32, y: f32, button: Option<String>)`
- `screen_type_local(text: String)`
- `screen_key_local(combo: String)` — ex: "cmd+w"
- `screen_scroll_local(x: f32, y: f32, delta: i32)`

Todos wrappers de `Command::new("cliclick")` com args corretos. cliclick
opera em pontos lógicos (não pixels) — o backend já converte
coordenadas do screenshot pra pontos (screen.py tem a lógica).

Backend tools `screen_click`, `screen_type`, `screen_key` já existem em
`screen.py`. Já estão marcadas `proxy_to_client=True` no 033. Só
precisam dos handlers frontend.

## Riscos

- **cliclick não instalado**: catch + erro "instale via brew".
- **Coordenada errada → clique na coisa errada**: approval gate
  obrigatório (requires_confirmation já True).
- **Accessibility permission**: o `.app` precisa ser autorizado em
  Privacy > Accessibility. Docs incluem screenshot do toggle.
