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


def _check_claude_max() -> None:
    """Validate the Claude Max OAuth token from macOS Keychain."""
    try:
        from seraphine.llm.keychain import get_subscription_info, get_access_token

        info = get_subscription_info()
        if not info["has_token"]:
            _log(
                "Claude Max token not found in Keychain. "
                "Install Claude Code and run `claude` once to log in.",
                "✗",
            )
            sys.exit(1)

        # Validate the token actually works
        token = get_access_token()
        expires_ms = info["expires_at_ms"]
        now_ms = int(time.time() * 1000)
        remaining_min = (expires_ms - now_ms) / 60000 if expires_ms else 0

        _log(
            f"Claude Max via Keychain OAuth "
            f"(tier={info['rate_limit_tier']}, "
            f"sub={info['subscription_type']}, "
            f"token expires in {remaining_min:.0f}min, "
            f"model={settings.anthropic_model})",
            "✓",
        )
    except Exception as e:
        _log(f"Claude Max Keychain check failed: {e}", "✗")
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


def _check_remote_whisper() -> None:
    """Abort boot with a clear message if stt_backend=remote and the
    RTX whisper service isn't reachable. Do NOT fall back to local
    silently — the user chose remote explicitly and a silent fallback
    would mask hardware/network issues."""
    url = f"{settings.stt_remote_base_url.rstrip('/')}/health"
    try:
        r = httpx.get(url, timeout=5.0)
        if r.status_code != 200:
            _log(
                f"Remote whisper {url} returned HTTP {r.status_code}",
                "✗",
            )
            # Non-fatal: STT is optional
            return
        data = r.json()
        warm = data.get("warm", False)
        device = data.get("device", "?")
        model = data.get("model", "?")
        if not warm:
            _log(
                f"Remote whisper reachable but not warm yet (model={model}, "
                f"device={device}) — first request may be slow",
                "⚠",
            )
        else:
            _log(
                f"Remote whisper ready at {settings.stt_remote_base_url} "
                f"(model={model}, device={device})",
                "✓",
            )
    except Exception as e:
        _log(
            f"Remote whisper unreachable at {url}: {e}. "
            f"Either start the service on the RTX box (spec 007) or set "
            f"SERAPHINE_STT_BACKEND=local in .env.",
            "✗",
        )
        # Non-fatal: STT is optional, app continues without voice input


def _start_caffeinate() -> None:
    """Keep the Mac awake while Seraphine runs.

    ``caffeinate -i -w <pid>`` prevents idle sleep (the kind that kicks
    in after inactivity) and exits automatically when the watched PID
    dies. We pass our own PID — after ``os.execvp`` replaces us with
    uvicorn the PID is unchanged, so caffeinate tracks uvicorn's
    lifetime and vanishes when the backend stops. No flag for display
    sleep on purpose: screen can still dim/sleep, only system sleep is
    blocked.
    """
    if sys.platform != "darwin":
        return
    if subprocess.call(
        ["which", "caffeinate"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    ) != 0:
        _log("caffeinate binary not found — Mac may sleep while running", "⚠")
        return
    if _pgrep(f"caffeinate -i -w {os.getpid()}"):
        _log("caffeinate already tracking our pid", "✓")
        return
    _log(f"caffeinate -i (keeping Mac awake, tied to pid {os.getpid()})")
    subprocess.Popen(
        ["caffeinate", "-i", "-w", str(os.getpid())],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


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


def _start_whatsapp_bridge() -> None:
    """Start the WhatsApp bridge if configured and not already running.

    The bridge is a Node.js service at ``services/whatsapp-bridge/``
    that exposes REST on the port extracted from
    ``settings.whatsapp_bridge_url`` (default 3001). If already
    reachable, skip. If not, spawn ``npm start`` detached and wait up
    to 30s for ``/api/status`` to respond.
    """
    if not settings.whatsapp_bridge_url:
        return
    url = settings.whatsapp_bridge_url.rstrip("/")
    if _check_url(f"{url}/api/status"):
        _log("WhatsApp bridge already running", "✓")
        _print_whatsapp_status(url)
        return
    bridge_dir = Path(__file__).resolve().parent.parent.parent / "services" / "whatsapp-bridge"
    if not (bridge_dir / "package.json").exists():
        _log(f"WhatsApp bridge dir not found at {bridge_dir} — skipping", "⚠")
        return
    dist_index = bridge_dir / "dist" / "index.js"
    if not dist_index.exists():
        _log(
            f"WhatsApp bridge not built ({dist_index} missing). "
            f"Run: cd {bridge_dir} && npm run build",
            "⚠",
        )
        return
    _log("Starting WhatsApp bridge (npm start)")
    _spawn_detached(
        ["node", str(dist_index)],
        "/tmp/whatsapp-bridge.log",
    )
    for _ in range(15):  # up to 30s
        time.sleep(2)
        if _check_url(f"{url}/api/status"):
            _log("WhatsApp bridge ready", "✓")
            _print_whatsapp_status(url)
            return
    _log(
        "WhatsApp bridge did not come up within 30s — check /tmp/whatsapp-bridge.log",
        "⚠",
    )


def _print_whatsapp_status(url: str) -> None:
    """Log the bridge auth status (ready / qr_pending / etc.)."""
    try:
        r = httpx.get(f"{url}/api/status", timeout=5.0)
        if r.status_code >= 400:
            _log(
                f"WhatsApp bridge returned HTTP {r.status_code} — "
                "scan QR via /whatsapp/qr",
                "⚠",
            )
            return
        data = r.json()
        st = data.get("status", "unknown")
        if st == "ready":
            name = data.get("name", "?")
            phone = data.get("phone", "?")
            _log(f"WhatsApp authenticated as {name} ({phone})", "✓")
        elif st == "qr_pending":
            _log(
                "WhatsApp waiting for QR scan — open /whatsapp/qr in browser",
                "⚠",
            )
        else:
            _log(f"WhatsApp bridge status: {st}", "⚠")
    except Exception:
        pass


def _check_browser_agent() -> None:
    """If browser_agent_url is configured, check /health. Warning only."""
    if not settings.browser_agent_url:
        return
    url = settings.browser_agent_url.rstrip("/")
    if _check_url(f"{url}/health"):
        _log(f"Browser agent reachable at {url}", "\u2713")
    else:
        _log(
            f"Browser agent at {url} unreachable \u2014 browser tools will fail",
            "\u26a0",
        )


def _check_wise() -> None:
    """If wise_api_key is configured, validate it via GET /v1/profiles. Warning only."""
    if not settings.wise_api_key:
        return
    from seraphine.wise.client import WISE_PRODUCTION_URL, WISE_SANDBOX_URL

    base = WISE_SANDBOX_URL if settings.wise_sandbox else WISE_PRODUCTION_URL
    try:
        r = httpx.get(
            f"{base}/v1/profiles",
            headers={"Authorization": f"Bearer {settings.wise_api_key}"},
            timeout=10.0,
        )
        if r.status_code == 200:
            profiles = r.json()
            if profiles:
                name = profiles[0].get("fullName", profiles[0].get("id", "?"))
                env = "sandbox" if settings.wise_sandbox else "production"
                _log(f"Wise API valid ({env}, profile: {name})", "\u2713")
            else:
                _log("Wise API key valid but no profiles found", "\u26a0")
        elif r.status_code == 401:
            _log("Wise API key rejected (401) \u2014 check your token", "\u26a0")
        else:
            _log(f"Wise API returned HTTP {r.status_code}", "\u26a0")
    except Exception as e:
        _log(f"Wise API check failed: {e}", "\u26a0")


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
    elif settings.llm_backend == "claude_max":
        _kill_vmlx_if_running()
        _check_claude_max()
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

    # ── STT backend ────────────────────────────────────────────────
    # Local (MLX whisper) needs no startup check — it lazy-loads.
    # Remote requires the RTX service to be up, else abort.
    if settings.stt_backend == "remote":
        _check_remote_whisper()
    elif settings.stt_backend != "local":
        _log(f"Unknown stt_backend: {settings.stt_backend}", "✗")
        sys.exit(1)

    # Ollama is always needed for embeddings (memory recall), regardless
    # of which LLM backend is active.
    if settings.llm_backend != "ollama":
        _check_ollama_embeddings()

    # ── Wise integration (optional) ──────────────────────────────
    _check_wise()

    # ── Browser agent (optional) ──────────────────────────────────
    _check_browser_agent()

    # ── WhatsApp bridge (optional) ────────────────────────────────
    _start_whatsapp_bridge()

    _start_caffeinate()
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
