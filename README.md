# Projeto Seraphine

Assistente pessoal **100% local** rodando em Mac (Apple Silicon), com:

- 🧠 **LLM multimodal local** — Gemma 3n E4B via Ollama (texto + áudio + imagem)
- 🎙️ **STT** — usando o próprio Gemma 3n (sem pipeline separado)
- 🗣️ **TTS realtime** — MOSS-TTS com voice cloning
- 🧍 **Avatar VTuber** — VRM 3D no navegador (three-vrm), com lip-sync
- 🛠️ **Tool use com gate humano** — acesso ao shell/filesystem com confirmação no UI
- 🧠 **Memória de longo prazo** — SQLite + ChromaDB, aprende e evolui entre sessões

## Stack

| Camada | Escolha |
|---|---|
| LLM runtime | Ollama (`gemma3n:e4b`) |
| TTS | MOSS-TTS (serviço Python) |
| Backend | Python 3.11 + FastAPI + WebSocket |
| Frontend | React + Vite + TypeScript + Three.js |
| Memória | SQLite + ChromaDB (embeddings via `nomic-embed-text`) |
| Metodologia | Spec-Driven Development (specs em `specs/`) |

## Estrutura

```
specs/        # specs SDD (contratos antes do código)
backend/      # FastAPI orchestrator
frontend/     # webapp React + avatar
services/     # serviços externos (MOSS-TTS)
scripts/      # bootstrap, clonagem de voz, etc.
data/         # runtime (gitignored)
```

## Rodando

```bash
# Bootstrap (uma vez)
./scripts/bootstrap-mac.sh

# Backend
cd backend && uv run uvicorn seraphine.main:app --reload

# Frontend (em outro terminal)
cd frontend && pnpm dev
```

Veja `specs/` para os contratos de cada feature e o roadmap detalhado em `.claude/plans/abstract-wibbling-toast.md`.
