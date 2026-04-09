# 004 — Long-term Memory

## Context

Phase 5. Gives Seraphine the ability to remember facts and past
conversations across sessions, and to surface relevant memory automatically
when responding. This is what makes the assistant "learn and evolve".

Three layers:

1. **Episodic** — recent conversation turns embedded into a vector store
   (ChromaDB) for similarity recall.
2. **Semantic** — structured facts ("user's name is João", "user prefers
   PT-BR", "user's machine is a MacBook M3") in SQLite.
3. **Reflection** — a periodic job that compresses many episodes into
   higher-level insights, written back as semantic facts.

## Contracts

### MemoryManager

```python
class MemoryManager(Protocol):
    async def remember_episode(self, turn: Turn) -> None: ...
    async def recall(self, query: str, *, k: int = 5) -> list[Memory]: ...
    async def learn_fact(self, fact: Fact) -> None: ...
    async def forget(self, memory_id: str) -> None: ...
    async def reflect(self) -> int: ...   # returns # of new facts produced

class Memory(BaseModel):
    id: str
    kind: Literal["episode", "fact"]
    text: str
    score: float | None = None
    created_at: datetime
    metadata: dict = {}

class Fact(BaseModel):
    id: str
    text: str
    source: Literal["explicit", "reflection", "user_taught"]
    confidence: float           # 0..1
    created_at: datetime
```

JSON Schema: `schemas/memory.schema.json`.

### Storage

- **Episodic**: ChromaDB collection `seraphine_episodes`. Each document =
  one conversation turn (or short window of turns). Embeddings produced via
  Ollama `nomic-embed-text`.
- **Semantic facts**:

```sql
CREATE TABLE facts (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  source      TEXT NOT NULL,
  confidence  REAL NOT NULL,
  created_at  TEXT NOT NULL,
  superseded_by TEXT REFERENCES facts(id)
);
```

Updates to a fact create a new row with `superseded_by` pointing back, so
history is preserved (and `forget` is reversible if needed).

### Recall injection

Before each LLM call the `ConversationEngine` does:

1. `recall(latest_user_message, k=5)` over episodes.
2. Reads top-N facts (most recent, highest confidence) up to a budget.
3. Prepends a system message:

```
The following facts about the user may be relevant:
- ...
Recent related conversation excerpts:
- ...
```

Total memory budget per turn: 800 tokens (configurable).

### Reflection job

Trigger: every 50 new episodes, or manual `POST /reflect`.

Procedure: pull episodes since the last reflection, ask the LLM to extract
durable facts as JSON via a strict schema, deduplicate against existing
facts (embedding similarity > 0.92 means "same fact, maybe stronger
confidence"), insert new facts.

## Acceptance criteria (Gherkin)

```gherkin
Feature: Long-term memory

  Scenario: Remember a name across sessions
    Given a fresh database
    When the user says "meu nome é João"
    And the conversation ends
    And the backend is restarted
    And the user starts a new conversation and asks "qual é o meu nome?"
    Then the assistant replies with "João"

  Scenario: Forget a specific fact
    Given a fact "user's name is João" exists
    When the user says "esquece meu nome"
    And the LLM calls forget on the matching memory id
    Then the fact row gets superseded
    And in a new conversation, "qual é o meu nome?" no longer returns "João"

  Scenario: Reflection produces a fact
    Given 50 episodes mention "user is a software engineer"
    When the reflection job runs
    Then a new fact "user is a software engineer" exists with source="reflection"
    And subsequent recalls include it
```

## Open questions

- Embedding model upgrade path: keep behind config; reindex job needed.
- Privacy controls (export / wipe all): exposed in Phase 6 polish UI.
- Per-fact TTL: not in v1.
