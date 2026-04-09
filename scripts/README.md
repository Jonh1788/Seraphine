# scripts/

Operational scripts for Projeto Seraphine.

## bootstrap-mac.sh

Idempotent setup for a fresh Mac (Apple Silicon, macOS 15+). Installs:

- Homebrew packages: `uv`, `node`, `pnpm`
- Ollama (cask), and starts the service
- Models via Ollama: `gemma3n:e4b`, `nomic-embed-text`
- Runtime dirs: `data/`, `data/chroma/`, `data/voice-samples/`

Each step checks for existing installation and skips if present, so the script is safe to re-run after partial failures or upgrades.

```bash
./scripts/bootstrap-mac.sh
```

Does not require `sudo`. If a step needs elevated permissions the script will tell you what to do instead.

## clone-voice.py (Phase 2)

Will be added when the voice phase begins. It will take samples from `data/voice-samples/` and produce the cloned voice profile consumed by the MOSS-TTS service.
