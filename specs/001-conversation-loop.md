# 001 — Conversation Loop (text-only)

## Context

Phase 1 of Projeto Seraphine. Establish the minimal end-to-end conversation loop:
the user types a message in the webapp, the backend forwards it to Gemma 4 via
Ollama, tokens stream back over WebSocket and are persisted as conversation
turns in SQLite.

This spec is the contract for the LLM client, the WS protocol, and the turn
storage. Voice and tools are out of scope (specs 002 and 003).

## Contracts

### LLMClient

```python
class LLMClient(Protocol):
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
    ) -> AsyncIterator[Token]: ...

class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str

class Token(BaseModel):
    text: str
    done: bool = False
```

Initial implementation: `OllamaClient` calling `POST /api/chat` with
`stream=true` against `gemma4:e4b`.

### WebSocket protocol — `/ws/conversation`

Client → server:

```json
{ "type": "user_message", "conversation_id": "uuid", "content": "olá" }
```

Server → client (multiple frames per turn):

```json
{ "type": "token", "conversation_id": "uuid", "turn_id": "uuid", "text": "Oi" }
{ "type": "turn_end", "conversation_id": "uuid", "turn_id": "uuid" }
```

Errors:

```json
{ "type": "error", "code": "llm_unavailable", "message": "..." }
```

JSON Schema: see `schemas/ws-messages.schema.json`.

### SQLite turn schema

```sql
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);

CREATE TABLE turns (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  token_count     INTEGER
);
CREATE INDEX idx_turns_conv ON turns(conversation_id, created_at);
```

A turn is persisted **after** the assistant stream completes (single row per
side of the exchange).

## Acceptance criteria (Gherkin)

```gherkin
Feature: Text conversation loop

  Scenario: User sends a message and receives a streamed reply
    Given the backend is running and Ollama is reachable
    And a fresh conversation
    When the client sends a user_message "olá, quem é você?"
    Then the client receives at least one token frame
    And eventually receives a turn_end frame
    And the SQLite database contains one user turn and one assistant turn
    And both turns belong to the same conversation_id

  Scenario: Ollama is unreachable
    Given Ollama is not running
    When the client sends a user_message
    Then the client receives an error frame with code "llm_unavailable"
    And no assistant turn is persisted
```

## Open questions

- Per-turn token_count: should we count from the model response (Ollama
  exposes `eval_count`) or estimate? Decision deferred to implementation.
- Conversation lifecycle: implicit creation on first message vs explicit
  `start_conversation` frame. Default: implicit.
