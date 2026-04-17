# 055 — Sticky Notes

## Scope

Floating post-its que vivem na tela, independent de chat. Cada nota
é uma micro-window Tauri transparent.

## Backend schema

```sql
CREATE TABLE desktop_notes (
  id TEXT PRIMARY KEY,
  text TEXT,
  color TEXT DEFAULT 'yellow',
  x INTEGER,
  y INTEGER,
  width INTEGER DEFAULT 180,
  height INTEGER DEFAULT 120,
  created_at TEXT,
  dismissed_at TEXT
);
```

## Tool

`sticky_note_create(text, color?)` — LLM chama quando user pede
"cria um post-it pra X" ou quando nudge de open loop precisa
persistir visualmente.

## UI

- Rust cmd `sticky_note_open(id, text, x, y)` cria uma janela pequena
  transparente arrastável com texto estilo post-it (amarelo/rosa/azul).
- X no canto superior direito dismissa (chama DELETE + fecha window).
- Na startup, recarrega todas as notes not dismissed.
