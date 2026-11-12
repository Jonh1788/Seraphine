"""Provider catalog for the agent harness.

Vocabulary:

- *runtime* (``engine`` in the DB/API): WHO runs the agent loop. ``codex`` and
  ``claude_code`` act on files (sandboxed); ``chat`` only converses.
- *provider*: WHICH LLM/plan/key the runtime thinks with.

API keys are read ONLY from the backend process environment (or the backend's
``.env`` file) by environment-variable NAME. They are never stored in the
database, never returned by the API, never logged and never put in argv: the
``chat`` runtime sends them in an HTTP header and nothing else touches them.
``child_env`` also strips them from the environment of the Codex / Claude Code
child processes.

Documentation each API-key built-in was verified against (base URL + key
variable), fetched while building this module:

- openrouter  https://openrouter.ai/docs/quickstart  (https://openrouter.ai/api/v1, OPENROUTER_API_KEY)
- deepseek    https://api-docs.deepseek.com/  (https://api.deepseek.com, DEEPSEEK_API_KEY)
- moonshot    https://platform.kimi.ai/docs/guide/start-using-kimi-api  (https://api.moonshot.ai/v1, MOONSHOT_API_KEY)
- xai         https://docs.x.ai/docs/guides/chat-completions  (https://api.x.ai/v1, XAI_API_KEY; legacy chat endpoint)
- gemini      https://aistudio.google.com/docs/openai  (https://generativelanguage.googleapis.com/v1beta/openai/, GEMINI_API_KEY)
- groq        https://console.groq.com/docs/openai  (https://api.groq.com/openai/v1, GROQ_API_KEY)

Not shipped (documentation does not define a key variable): Z.ai
(https://docs.z.ai/guides/overview/quick-start). It can be added through
``agents_extra_providers``.

Codex custom providers (``[model_providers.<id>]`` with ``env_key`` and
``base_url``) are documented at https://learn.chatgpt.com/docs/config-file/config-advanced,
but that page only shows ``wire_api = "responses"``; the providers above are
OpenAI-compatible *chat completions* endpoints, so API-key providers are
``chat`` runtime only (see ``notes``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

logger = logging.getLogger(__name__)

RUNTIME_CODEX = "codex"
RUNTIME_CLAUDE = "claude_code"
RUNTIME_CHAT = "chat"
RUNTIMES = (RUNTIME_CODEX, RUNTIME_CLAUDE, RUNTIME_CHAT)

#: ``ollama`` is the legacy name of the ``chat`` runtime (stored rows / API).
LEGACY_ENGINE_ALIASES = {"ollama": RUNTIME_CHAT}

DEFAULT_PROVIDER = {
    RUNTIME_CODEX: "openai",
    RUNTIME_CLAUDE: "anthropic",
    RUNTIME_CHAT: "ollama",
}

KINDS = ("plan", "api_key", "local")
EFFORTS = ("low", "medium", "high")
PROBE_TTL_S = 30.0
PROBE_TIMEOUT_S = 1.0

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
_ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,99}$")


def canon_engine(name: str | None) -> str | None:
    """Map the legacy ``ollama`` runtime name to ``chat``."""
    if name is None:
        return None
    return LEGACY_ENGINE_ALIASES.get(name, name)


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    kind: str  # plan | api_key | local
    runtimes: tuple[str, ...]
    base_url: str | None = None  # OpenAI-compatible root (``.../v1``), used by ``chat``
    env_key: str | None = None  # NAME of the env var holding the key
    default_model: str | None = None
    notes: str = ""
    #: Local servers: full URL used for the reachability probe (default
    #: ``<base_url>/models``).
    probe_url: str | None = None
    #: Codex ``--local-provider`` value when the runtime ``codex`` is allowed.
    codex_local_id: str | None = None

    def supports(self, runtime: str) -> bool:
        return runtime in self.runtimes


# -- environment / keys -------------------------------------------------------

_dotenv_cache: dict[str, Any] = {"path": None, "mtime": None, "values": {}}


def _dotenv_values() -> dict[str, str]:
    """Values of the backend's ``.env`` (cwd), cached by mtime. Never logged."""
    path = Path(".env")
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return {}
    cache = _dotenv_cache
    if cache["path"] == str(path.resolve()) and cache["mtime"] == mtime:
        return cache["values"]
    values: dict[str, str] = {}
    try:
        from dotenv import dotenv_values  # pydantic-settings dependency

        values = {k: v for k, v in dotenv_values(path).items() if isinstance(v, str)}
    except Exception:  # noqa: BLE001
        values = {}
    cache.update(path=str(path.resolve()), mtime=mtime, values=values)
    return values


def read_env(name: str | None) -> str:
    """Value of environment variable ``name`` (process env first, then ``.env``)."""
    if not name:
        return ""
    value = os.environ.get(name)
    if value is None or not value.strip():
        value = _dotenv_values().get(name, "")
    return (value or "").strip()


def reason_is_auth(reason: str) -> bool:
    """Is a ``ProviderRegistry.status`` reason about the login / API key (not
    about a missing program or a server that is down)? Phase 1b parks those."""
    return "não está conectado" in (reason or "") or "falta a chave" in (reason or "")


def redact(text: str, secret: str | None) -> str:
    """Remove ``secret`` from ``text`` (defence in depth for error messages)."""
    if secret and len(secret) >= 6:
        return text.replace(secret, "***")
    return text


# -- catalog ------------------------------------------------------------------


def _openai_compat(pid: str, label: str, base_url: str, env_key: str, default_model: str | None,
                   note: str = "") -> Provider:
    notes = "Só conversa (runtime \"chat\"): o Codex exige API Responses nos provedores customizados."
    if note:
        notes = f"{note} {notes}"
    return Provider(pid, label, "api_key", (RUNTIME_CHAT,), base_url, env_key, default_model, notes)


def builtin_providers(settings: Any) -> list[Provider]:
    ollama_root = str(getattr(settings, "ollama_base_url", "") or "http://localhost:11434").rstrip("/")
    lm_root = str(getattr(settings, "agents_lmstudio_base_url", "") or "http://localhost:1234").rstrip("/")
    return [
        Provider(
            "openai", "OpenAI (login do Codex)", "plan", (RUNTIME_CODEX,),
            default_model=None,
            notes="Usa o plano/login do Codex CLI neste computador. Modelo em branco = padrão do Codex.",
        ),
        Provider(
            "anthropic", "Anthropic (login do Claude Code)", "plan", (RUNTIME_CLAUDE,),
            default_model=None,
            notes="Usa o plano/login do Claude Code neste computador. Modelo em branco = padrão do Claude Code.",
        ),
        Provider(
            "ollama", "Ollama (local)", "local", (RUNTIME_CHAT, RUNTIME_CODEX),
            base_url=ollama_root + "/v1", default_model=(getattr(settings, "llm_model", "") or None),
            probe_url=ollama_root + "/api/tags", codex_local_id="ollama",
            notes="Modelo local. No Codex usa --oss --local-provider ollama (não verificado de ponta a ponta); "
                  "o Codex usa o endereço padrão do Ollama.",
        ),
        Provider(
            "lmstudio", "LM Studio (local)", "local", (RUNTIME_CHAT, RUNTIME_CODEX),
            base_url=lm_root + "/v1", default_model=None, codex_local_id="lmstudio",
            notes="Modelo local. No Codex usa --oss --local-provider lmstudio (não verificado de ponta a ponta).",
        ),
        _openai_compat("openrouter", "OpenRouter", "https://openrouter.ai/api/v1",
                       "OPENROUTER_API_KEY", None),
        _openai_compat("deepseek", "DeepSeek", "https://api.deepseek.com",
                       "DEEPSEEK_API_KEY", "deepseek-chat"),
        _openai_compat("moonshot", "Kimi (Moonshot)", "https://api.moonshot.ai/v1",
                       "MOONSHOT_API_KEY", None),
        _openai_compat("xai", "xAI (Grok)", "https://api.x.ai/v1", "XAI_API_KEY", None,
                       "Usa o endpoint legado /chat/completions da xAI."),
        _openai_compat("gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai",
                       "GEMINI_API_KEY", None),
        _openai_compat("groq", "Groq", "https://api.groq.com/openai/v1", "GROQ_API_KEY", None),
    ]


def parse_extra_providers(raw: Any, taken: set[str]) -> list[Provider]:
    """Providers from ``agents_extra_providers`` (JSON text or list). Invalid
    entries are skipped with a warning (never an exception: bad config must not
    take the harness down)."""
    if raw is None or raw == "":
        return []
    data = raw
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except ValueError:
            logger.warning("agents_extra_providers is not valid JSON; ignored")
            return []
    if not isinstance(data, list):
        logger.warning("agents_extra_providers must be a JSON list; ignored")
        return []
    out: list[Provider] = []
    for item in data:
        try:
            if not isinstance(item, dict):
                raise ValueError("entrada não é um objeto")
            pid = str(item.get("id") or "").strip().lower()
            if not _ID_RE.match(pid):
                raise ValueError("id inválido")
            if pid in taken or any(p.id == pid for p in out):
                raise ValueError("id repetido")
            kind = str(item.get("kind") or "api_key")
            if kind not in ("api_key", "local"):
                raise ValueError("kind deve ser api_key ou local")
            base_url = str(item.get("base_url") or "").strip().rstrip("/")
            if not re.match(r"^https?://", base_url):
                raise ValueError("base_url precisa ser http(s)")
            env_key = item.get("env_key")
            env_key = str(env_key).strip() if env_key else None
            if env_key and not _ENV_RE.match(env_key):
                raise ValueError("env_key inválido (use só o NOME da variável)")
            if kind == "api_key" and not env_key:
                raise ValueError("api_key exige env_key")
            out.append(Provider(
                pid, str(item.get("label") or pid), kind, (RUNTIME_CHAT,), base_url, env_key,
                (str(item["default_model"]).strip() or None) if item.get("default_model") else None,
                str(item.get("notes") or "Provedor extra (OpenAI-compatível): só no runtime \"chat\"."),
            ))
        except ValueError as exc:
            logger.warning("agents_extra_providers: entrada ignorada (%s)", exc)
    return out


def build_catalog(settings: Any) -> dict[str, Provider]:
    providers = builtin_providers(settings)
    taken = {p.id for p in providers}
    providers += parse_extra_providers(getattr(settings, "agents_extra_providers", ""), taken)
    return {p.id: p for p in providers}


def child_env(catalog: dict[str, Provider]) -> dict[str, str]:
    """Environment for Codex / Claude Code children without the API keys of
    the catalog's ``api_key`` providers."""
    env = dict(os.environ)
    for p in catalog.values():
        if p.kind == "api_key" and p.env_key:
            env.pop(p.env_key, None)
    return env


# -- configured / probes ------------------------------------------------------

CliProbe = Callable[[str], Awaitable[tuple[bool | None, str]]]


@dataclass
class _Cached:
    at: float
    value: tuple[bool, str]


class ProviderRegistry:
    """Catalog + cheap, cached "is it usable" checks (no model calls)."""

    def __init__(self, settings: Any, *, transport: httpx.AsyncBaseTransport | None = None,
                 cli_probe: CliProbe | None = None, clock: Callable[[], float] = time.monotonic) -> None:
        self.settings = settings
        self.catalog = build_catalog(settings)
        self._transport = transport
        self._cli_probe = cli_probe or self._default_cli_probe
        self._clock = clock
        self._cache: dict[str, _Cached] = {}

    # -- lookup ---------------------------------------------------------------

    def get(self, provider_id: str | None) -> Provider | None:
        return self.catalog.get(provider_id) if provider_id else None

    def default_for(self, runtime: str) -> str | None:
        return DEFAULT_PROVIDER.get(runtime)

    def allowed(self, runtime: str, provider_id: str) -> bool:
        p = self.get(provider_id)
        return p is not None and p.supports(runtime)

    def child_env(self) -> dict[str, str]:
        return child_env(self.catalog)

    # -- configured -----------------------------------------------------------

    async def status(self, provider_id: str) -> tuple[bool, str]:
        """``(configured, reason)``; ``reason`` is empty when configured."""
        p = self.get(provider_id)
        if p is None:
            return False, "provedor desconhecido"
        if p.kind == "api_key":
            if read_env(p.env_key):
                return True, ""
            return False, f"falta a chave {p.env_key} no .env do backend"
        hit = self._cache.get(p.id)
        now = self._clock()
        if hit is not None and now - hit.at < PROBE_TTL_S:
            return hit.value
        value = await (self._plan_status(p) if p.kind == "plan" else self._local_status(p))
        self._cache[p.id] = _Cached(now, value)
        return value

    async def _local_status(self, p: Provider) -> tuple[bool, str]:
        url = p.probe_url or f"{(p.base_url or '').rstrip('/')}/models"
        try:
            async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_S, transport=self._transport) as client:
                resp = await client.get(url)
            if resp.status_code < 400:
                return True, ""
            return False, f"o servidor local respondeu {resp.status_code}"
        except httpx.HTTPError:
            return False, f"o servidor de {p.label.split(' (')[0]} não está respondendo"

    async def _plan_status(self, p: Provider) -> tuple[bool, str]:
        which = "codex" if p.id == "openai" else "claude" if p.id == "anthropic" else None
        if which is None:
            return True, ""
        ok, reason = await self._cli_probe(which)
        if ok is None:  # could not tell: do not block, the run reports auth errors
            return True, ""
        return ok, "" if ok else reason

    async def _default_cli_probe(self, which: str) -> tuple[bool | None, str]:
        """``codex login status`` / ``claude auth status``: local, no model call."""
        from seraphine.agents.engines.claude_code import resolve_claude_exe
        from seraphine.agents.procutil import spawn_kwargs

        if which == "codex":
            exe = shutil.which(str(getattr(self.settings, "codex_executable", "") or "codex"))
            if exe is None:
                return False, "Codex não encontrado neste computador"
            args = [exe, "login", "status"]
            missing = "Codex não está conectado (rode `codex login`)"
        else:
            path = resolve_claude_exe(str(getattr(self.settings, "agents_claude_path", "") or ""))
            if path is None:
                return False, "Claude Code não encontrado neste computador"
            args = [str(path), "auth", "status"]
            missing = "Claude Code não está conectado (rode `claude auth login`)"
        try:
            proc = await asyncio.create_subprocess_exec(
                *args, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, **spawn_kwargs())
            out, _err = await asyncio.wait_for(proc.communicate(), timeout=8)
        except (OSError, asyncio.TimeoutError):
            return None, ""
        text = out.decode("utf-8", "replace")
        if which == "claude":
            try:
                logged = json.loads(text).get("loggedIn")
                if isinstance(logged, bool):
                    return logged, missing
            except (ValueError, AttributeError):
                pass
        if proc.returncode == 0:
            return True, ""
        return (False, missing) if proc.returncode == 1 else (None, "")

    # -- read model -----------------------------------------------------------

    @staticmethod
    def how_to_ready(p: Provider, configured: bool, reason: str) -> str:
        """One plain sentence on what the owner does to make this provider usable (``""`` when it already
        is). Never asks for a secret on screen and never carries a command to paste: it only names the
        program to open or the setting to fill."""
        if configured:
            return ""
        missing = "não encontrado" in (reason or "")
        if p.kind == "plan":
            who, plan = (("o Codex", "do ChatGPT") if p.id == "openai" else ("o Claude Code", ""))
            account = f"a sua conta {plan}".replace("  ", " ") if plan else "a sua conta"
            if missing:
                return f"Instale {who} neste PC, abra-o e entre com {account}."
            return f"Abra {who} neste PC e entre com {account}."
        if p.kind == "api_key":
            return ("Ponha a chave no arquivo de configuração do servidor, na variável "
                    f"{p.env_key}, e reinicie a Seraphine.")
        name = p.label.split(" (")[0]
        return f"Abra o {name} neste PC e deixe o servidor ligado."

    async def info(self) -> list[dict[str, Any]]:
        """Public provider list. No secrets, no URLs."""
        ids = list(self.catalog)
        results = await asyncio.gather(*(self.status(i) for i in ids))
        out = []
        for pid, (ok, reason) in zip(ids, results):
            p = self.catalog[pid]
            out.append({
                "id": p.id, "label": p.label, "kind": p.kind, "runtimes": list(p.runtimes),
                "configured": bool(ok), "reason": reason, "default_model": p.default_model,
                "notes": p.notes, "how": self.how_to_ready(p, bool(ok), reason),
            })
        return out

    def resolved(self, provider_id: str | None, **over: Any) -> Provider | None:
        p = self.get(provider_id)
        return replace(p, **over) if p is not None and over else p


__all__ = [
    "DEFAULT_PROVIDER", "EFFORTS", "LEGACY_ENGINE_ALIASES", "Provider", "ProviderRegistry",
    "RUNTIMES", "RUNTIME_CHAT", "RUNTIME_CLAUDE", "RUNTIME_CODEX", "build_catalog", "canon_engine",
    "child_env", "read_env", "reason_is_auth", "redact",
]
