# 067 — Spaced Repetition Companion

## Context

Usuário diz "quero aprender X" e esquece em 2 dias. Spaced repetition
(SM-2) transforma curiosidade passiva em retenção real. Seraphine gera
deck automaticamente do tópico, agenda reviews, surface via bubble.

## Schema

```sql
CREATE TABLE flashcards (
  id            TEXT PRIMARY KEY,
  topic         TEXT NOT NULL,
  front         TEXT NOT NULL,
  back          TEXT NOT NULL,
  interval_days INTEGER NOT NULL DEFAULT 1,
  ease          REAL NOT NULL DEFAULT 2.5,
  reps          INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  next_due_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_flashcards_due ON flashcards(next_due_at);
CREATE TABLE flashcard_reviews (
  id         TEXT PRIMARY KEY,
  card_id    TEXT NOT NULL,
  rating     INTEGER NOT NULL,  -- 0 (again) .. 5 (easy)
  created_at TEXT NOT NULL
);
```

## SM-2 algoritmo

Input: previous `(ease, interval)`, rating `q` (0..5):
- If q < 3: reset reps=0, interval=1, ease unchanged.
- Else: ease ← max(1.3, ease + 0.1 − (5−q)·(0.08 + (5−q)·0.02));
  reps++; interval ← reps=1?1 : reps=2?6 : interval·ease.

Next due = now + interval_days.

## Ferramentas

- `flashcard_create_deck(topic, count=10)` — LLM gera pares Q/A
- `flashcard_review(card_id, rating)` — aplica SM-2
- `flashcard_list_due(limit=20)` — cartões vencidos hoje

## Surfacing

Opener service (022-D) checa `count(flashcards WHERE next_due_at <= now)`
— se ≥3 cartões devidos, inclui como opener_extras:

> "[curious] tem 4 cards vencidos pra revisar. quer passar rápido?"

Bubble durante deep_focus é suprimida.

## Routes

- `GET /flashcards/due` → lista
- `POST /flashcards/review` body `{card_id, rating}`
- `POST /flashcards/decks` body `{topic, count}`
- `DELETE /flashcards/:id`
