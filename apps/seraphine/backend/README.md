# seraphine backend

FastAPI orchestrator for Projeto Seraphine.

## Setup

```bash
uv sync
```

## Run

```bash
uv run uvicorn seraphine.main:app --reload
```

## Test

```bash
uv run pytest
```

## Layout

```
seraphine/
  main.py             FastAPI app
  config.py           pydantic-settings
  ws/routes.py        /ws/conversation
  llm/                LLM client (Phase 1+)
  tts/                TTS adapters (Phase 2+)
  tools/              Tool ABC + registry (Phase 4)
  memory/             Memory manager (Phase 5)
  conversation/       Engine that ties everything together
tests/                pytest
```
