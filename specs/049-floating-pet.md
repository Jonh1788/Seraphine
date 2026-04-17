# 049 — Floating Pet Window

## Context

Avatar-companion window existe mas é 320×480 fixo, opaco, separado do
workflow. Vira "companion janela" de novo. Queremos "pet do desktop"
que vive sobre qualquer app, não rouba foco, reage a clique.

## Scope

- Dimensões 180×240 default, user-resizable.
- `transparent=true`, `decorations=false`, `alwaysOnTop=true`.
- `visibleOnAllWorkspaces=true` (macOS) e acompanha espaços/fullscreen.
- Click-through via `setIgnoresMouseEvents(true)` por default; quando
  user hover em cima da avatar, desliga para deixar clique passar.
- Snap em cantos: ao soltar drag perto de edge, snap magnético em
  {top-right, bottom-right, top-left, bottom-left}.
- Posição persiste em localStorage.
- Invisibilidade durante screen share é opcional (SRGGMethod TODO).
