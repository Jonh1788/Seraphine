"""One-shot OAuth flow for Google Workspace.

The flow is driven by a short-lived stdlib ``http.server`` bound only
to ``localhost`` on ``settings.google_oauth_port`` (default 8765). It
handles a single ``/callback`` request, captures the ``code`` query
parameter, responds with a friendly HTML page, then tears itself down.

We use stdlib HTTP instead of aiohttp to avoid pulling in another dep
just for a 10-line callback handler. The server runs in a daemon
thread; the asyncio side polls a ``Future`` for the captured code.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Optional
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from seraphine.google.token_store import TokenBundle

logger = logging.getLogger(__name__)

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

_SUCCESS_HTML = """<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Seraphine</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif;
           background: #111; color: #eee; display: flex;
           align-items: center; justify-content: center;
           height: 100vh; margin: 0; }
    .card { background: #1b1b1b; padding: 32px 48px; border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,.4); text-align: center; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p  { margin: 0; color: #aaa; }
  </style>
</head>
<body>
  <div class="card">
    <h1>OK! Pode fechar essa aba.</h1>
    <p>Seraphine já tem acesso ao seu Google.</p>
  </div>
</body>
</html>
"""

_ERROR_HTML = """<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Seraphine</title></head>
<body style="font-family:system-ui;background:#111;color:#eee;padding:40px;">
  <h1>Erro no login do Google</h1>
  <p>{error}</p>
</body>
</html>
"""


class _CallbackHandler(BaseHTTPRequestHandler):
    """Single-shot handler: accept /callback, stash the code, respond."""

    # Set by the OAuthFlow before serving.
    future: "asyncio.Future[str]"
    loop: asyncio.AbstractEventLoop

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        # Silence the default stderr access log.
        logger.debug("oauth-callback: " + format, *args)

    def _set_result(self, result: str | Exception) -> None:
        def _resolve() -> None:
            if self.future.done():
                return
            if isinstance(result, Exception):
                self.future.set_exception(result)
            else:
                self.future.set_result(result)

        self.loop.call_soon_threadsafe(_resolve)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        qs = parse_qs(parsed.query)
        err = qs.get("error", [None])[0]
        code = qs.get("code", [None])[0]

        if err:
            body = _ERROR_HTML.format(error=err).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self._set_result(RuntimeError(f"google oauth error: {err}"))
            return

        if not code:
            body = _ERROR_HTML.format(error="no code parameter").encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self._set_result(RuntimeError("google oauth: no code in callback"))
            return

        body = _SUCCESS_HTML.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self._set_result(code)


class OAuthFlow:
    """One-shot Google OAuth2 flow with a local callback server."""

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        scopes: list[str],
        port: int = 8765,
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.scopes = list(scopes)
        self.port = port
        self._server: Optional[HTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._future: Optional[asyncio.Future[str]] = None

    @property
    def redirect_uri(self) -> str:
        return f"http://localhost:{self.port}/callback"

    async def start(self) -> str:
        """Start the local callback server and return the consent URL."""
        if not self.client_id or not self.client_secret:
            raise RuntimeError("google_client_id/google_client_secret not set")
        if self._server is not None:
            raise RuntimeError("oauth flow already started")

        loop = asyncio.get_running_loop()
        self._future = loop.create_future()

        # Build the handler class on the fly so it carries the future + loop.
        future = self._future

        class _H(_CallbackHandler):
            pass

        _H.future = future
        _H.loop = loop

        try:
            self._server = HTTPServer(("127.0.0.1", self.port), _H)
        except OSError as e:
            raise RuntimeError(
                f"failed to bind oauth callback on localhost:{self.port}: {e}"
            ) from e

        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="google-oauth-callback",
            daemon=True,
        )
        self._thread.start()

        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "scope": " ".join(self.scopes),
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
        }
        return f"{GOOGLE_AUTH_URL}?{urlencode(params)}"

    async def wait_for_callback(self, timeout: float = 300.0) -> str:
        """Wait until the callback handler captures the auth code."""
        if self._future is None:
            raise RuntimeError("oauth flow not started")
        try:
            code = await asyncio.wait_for(self._future, timeout=timeout)
            return code
        finally:
            self._shutdown()

    def _shutdown(self) -> None:
        if self._server is not None:
            try:
                self._server.shutdown()
                self._server.server_close()
            except Exception as e:  # pragma: no cover
                logger.warning("error shutting down oauth callback server: %s", e)
        self._server = None
        self._thread = None

    async def exchange_code(self, code: str) -> TokenBundle:
        """Exchange an auth code for access + refresh tokens."""
        data = {
            "code": code,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "redirect_uri": self.redirect_uri,
            "grant_type": "authorization_code",
        }
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(GOOGLE_TOKEN_URL, data=data)
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"google token exchange failed: {resp.status_code} {resp.text}"
                )
            payload = resp.json()

        expires_in = int(payload.get("expires_in", 3600))
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
        scope_str = payload.get("scope", " ".join(self.scopes))
        return TokenBundle(
            access_token=payload["access_token"],
            refresh_token=payload.get("refresh_token", ""),
            expires_at=expires_at,
            scopes=scope_str.split(),
        )
