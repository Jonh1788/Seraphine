"""Startup orchestration for Seraphine.

Reads `.env` via `seraphine.config.settings`, decides which LLM/TTS
backends to use, starts or kills the corresponding external services
(vMLX, cloudflared), verifies remote endpoints are reachable, and
finally execs uvicorn.

Invoked via `uv run python -m seraphine.bootstrap` (typically from
`backend/scripts/start.sh`).
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx

from seraphine.config import settings


def _log(msg: str, status: str = "→") -> None:
    print(f"  {status} {msg}", flush=True)


def _header(msg: str) -> None:
    bar = "━" * 60
    print(f"\n{bar}\n  {msg}\n{bar}", flush=True)


def _check_url(url: str, timeout: float = 3.0) -> bool:
    try:
        r = httpx.get(url, timeout=timeout)
        return r.status_code < 500
    except Exception:
        return False


def _pgrep(pattern: str) -> list[int]:
    try:
        out = subprocess.check_output(["pgrep", "-f", pattern], text=True)
        return [int(p) for p in out.strip().splitlines() if p]
    except subprocess.CalledProcessError:
        return []


def _spawn_detached(cmd: list[str], log_path: str) -> None:
    with open(log_path, "w") as log:
        subprocess.Popen(
            cmd,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )


def _start_frontend() -> None:
    if _check_url("http://127.0.0.1:5173"):
        _log("Vite dev server already running on :5173", "✓")
        return
    frontend_dir = Path(__file__).resolve().parent.parent.parent / "frontend"
    if not (frontend_dir / "package.json").exists():
        _log(f"Frontend dir not found at {frontend_dir} — skipping", "⚠")
        return
    _log("Starting Vite dev server (pnpm dev)")
    with open("/tmp/vite.log", "w") as log:
        subprocess.Popen(
            ["pnpm", "dev"],
            cwd=str(frontend_dir),
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    for _ in range(15):  # up to 30s
        time.sleep(2)
        if _check_url("http://127.0.0.1:5173"):
            _log("Vite ready at http://127.0.0.1:5173", "✓")
            return
    _log("Vite did not come up within 30s — check /tmp/vite.log", "⚠")


def _start_cloudflared() -> None:
    if _pgrep("cloudflared tunnel"):
        _log("Cloudflared already running", "✓")
        return
    if not settings.cloudflared_tunnel_id:
        _log("SERAPHINE_CLOUDFLARED_TUNNEL_ID empty — skipping tunnel", "⚠")
        return
    _log("Starting cloudflared tunnel")
    _spawn_detached(
        ["cloudflared", "tunnel", "run", settings.cloudflared_tunnel_id],
        "/tmp/cloudflared.log",
    )


def _start_vmlx() -> None:
    if _check_url("http://127.0.0.1:1234/v1/models"):
        _log("vMLX already running", "✓")
        return
    script = Path(__file__).resolve().parent.parent / "scripts" / "start-vmlx.sh"
    if not script.exists():
        _log(f"start-vmlx.sh not found at {script}", "✗")
        sys.exit(1)
    _log(f"Starting vMLX ({settings.llm_model})")
    _spawn_detached(["bash", str(script)], "/tmp/vmlx.log")
    for _ in range(20):  # up to 60s
        time.sleep(3)
        if _check_url("http://127.0.0.1:1234/v1/models"):
            _log("vMLX ready", "✓")
            return
    _log("vMLX did not come up within 60s — check /tmp/vmlx.log", "✗")
    sys.exit(1)


def _kill_vmlx_if_running() -> None:
    pids = _pgrep("vmlx serve")
    if not pids:
        return
    _log(f"Killing local vMLX (pid {','.join(map(str, pids))}) to free RAM")
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    time.sleep(1)


def _check_anthropic() -> None:
    if not settings.anthropic_api_key:
        _log("SERAPHINE_LLM_BACKEND=anthropic but ANTHROPIC_API_KEY empty", "✗")
        sys.exit(1)
    try:
        r = httpx.get(
            f"{settings.anthropic_base_url}/v1/models",
            headers={
                "x-api-key": settings.anthropic_api_key,
                "anthropic-version": "2023-06-01",
            },
            timeout=5.0,
        )
        if r.status_code == 200:
            _log(f"Anthropic API reachable ({settings.anthropic_model})", "✓")
            return
        _log(f"Anthropic API returned {r.status_code}: {r.text[:120]}", "✗")
        sys.exit(1)
    except Exception as e:
        _log(f"Anthropic API check failed: {e}", "✗")
        sys.exit(1)


def _check_qwen3_tts() -> None:
    # Qwen3-TTS server doesn't expose /health; hit the root and accept
    # any non-5xx response as "up".
    if _check_url(settings.tts_base_url):
        _log(f"Qwen3-TTS reachable at {settings.tts_base_url}", "✓")
    else:
        _log(f"Qwen3-TTS at {settings.tts_base_url} unreachable — voice will fail", "⚠")


def _check_elevenlabs() -> None:
    if not settings.elevenlabs_api_key:
        _log("SERAPHINE_TTS_BACKEND=elevenlabs but ELEVENLABS_API_KEY empty", "✗")
        sys.exit(1)
    if not settings.elevenlabs_voice_id:
        _log("SERAPHINE_ELEVENLABS_VOICE_ID empty", "✗")
        sys.exit(1)
    # Hit the actual TTS endpoint with 2 chars. Can't use /v1/user or
    # /v1/voices/{id} because scoped keys (with only text_to_speech
    # permission) return 401 on those — but the actual TTS endpoint is
    # what we care about validating anyway.
    try:
        r = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{settings.elevenlabs_voice_id}",
            headers={
                "xi-api-key": settings.elevenlabs_api_key,
                "content-type": "application/json",
            },
            json={"text": "oi", "model_id": settings.elevenlabs_model_id},
            timeout=10.0,
        )
        if r.status_code == 200:
            _log(
                f"ElevenLabs TTS valid (voice={settings.elevenlabs_voice_id[:8]}…, "
                f"model={settings.elevenlabs_model_id})",
                "✓",
            )
        elif r.status_code == 401:
            _log(
                "ElevenLabs key rejected for TTS — check permissions/credits",
                "✗",
            )
            sys.exit(1)
        else:
            _log(f"ElevenLabs returned {r.status_code}: {r.text[:120]} — proceeding", "⚠")
    except Exception as e:
        _log(f"ElevenLabs check failed: {e} — proceeding", "⚠")


def _print_access_banner() -> None:
    try:
        out = subprocess.check_output(["ifconfig"], text=True)
        ips = [
            line.split()[1]
            for line in out.splitlines()
            if line.strip().startswith("inet ") and "127.0.0.1" not in line
        ]
    except Exception:
        ips = []
    print("\n  Local:   http://127.0.0.1:8000")
    for ip in ips:
        print(f"  Rede:    http://{ip}:8000")
    print("  Health:  http://127.0.0.1:8000/health")
    print("  WS:      ws://<ip>:8000/ws/conversation")
    if settings.cloudflared_tunnel_id:
        print("  Tunnel:  https://sera.jonhdev.io")
    print()


def _check_ollama_embeddings() -> None:
    if _check_url(f"{settings.ollama_base_url}/api/tags"):
        _log(f"Ollama reachable ({settings.embedding_model} for memory)", "✓")
    else:
        _log("Ollama not running — memory recall will be degraded", "⚠")


def bootstrap() -> None:
    _header(
        f"Seraphine startup  ·  LLM={settings.llm_backend}  ·  TTS={settings.tts_backend}"
    )

    _start_frontend()
    _start_cloudflared()

    # ── LLM backend ────────────────────────────────────────────────
    if settings.llm_backend == "openai":
        _start_vmlx()
    elif settings.llm_backend == "anthropic":
        _kill_vmlx_if_running()
        _check_anthropic()
    elif settings.llm_backend == "ollama":
        _check_ollama_embeddings()
    else:
        _log(f"Unknown llm_backend: {settings.llm_backend}", "✗")
        sys.exit(1)

    # ── TTS backend ────────────────────────────────────────────────
    if settings.tts_backend == "qwen3":
        _check_qwen3_tts()
    elif settings.tts_backend == "elevenlabs":
        _check_elevenlabs()
    else:
        _log(f"Unknown tts_backend: {settings.tts_backend}", "✗")
        sys.exit(1)

    # Ollama is always needed for embeddings (memory recall), regardless
    # of which LLM backend is active.
    if settings.llm_backend != "ollama":
        _check_ollama_embeddings()

    _print_access_banner()
    _header("Bootstrap OK — launching uvicorn on :8000")

    # Replace this process with uvicorn. All child processes we spawned
    # (cloudflared, vmlx) were detached via start_new_session=True and
    # will survive.
    os.execvp(
        "uv",
        [
            "uv",
            "run",
            "uvicorn",
            "seraphine.main:app",
            "--host",
            "0.0.0.0",
            "--port",
            "8000",
            "--reload",
        ],
    )


if __name__ == "__main__":
    bootstrap()
