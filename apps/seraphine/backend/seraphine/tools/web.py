"""Web fetching / scraping tool.

Implements the `web_scraper` skill that the LLM auto-requested on
2026-04-10. The tool fetches an HTTP(S) URL, parses the HTML with
BeautifulSoup, strips noise (script/style/nav/footer/aside), and
returns the title + main text truncated to a configurable byte cap.

Security notes — this is an LLM-driven tool so SSRF via prompt
injection is a real threat:

- Only http:// and https:// schemes are accepted.
- Private / loopback / link-local / multicast IP ranges are rejected
  BEFORE the request leaves the process, so a malicious page cannot
  trick Seraphine into scanning the user's LAN or hitting
  http://localhost:8000 of the backend itself.
- A max response size (`max_bytes`, default 2 MB) aborts reads that
  try to exhaust memory.
- Redirects are followed but capped at 5.
- The adapter is `requires_confirmation=False` because it's read-only
  from the user's machine perspective. If you want a human gate on
  every web fetch, flip that flag in the subclass — the engine will
  route it through the approval loop like run_shell.
"""

from __future__ import annotations

import ipaddress
import socket
import ssl
from typing import Any
from urllib.parse import urlparse

import httpx
import truststore
from bs4 import BeautifulSoup

from seraphine.tools.base import Tool, ToolResult

DEFAULT_MAX_BYTES = 2 * 1024 * 1024  # 2 MB
DEFAULT_TEXT_EXCERPT = 8 * 1024  # 8 KB of extracted text
DEFAULT_TIMEOUT = 20.0
USER_AGENT = "SeraphineBot/0.1 (+local-assistant)"
_NOISE_TAGS = ("script", "style", "noscript", "template", "svg", "nav", "footer", "aside")


class WebFetchTool(Tool):
    name = "web_fetch"
    description = (
        "Fetch an HTTP(S) URL and return its page title + main text "
        "content (HTML noise stripped, truncated). Use this to read "
        "articles, check headlines, look up documentation, etc. Only "
        "http:// and https:// are allowed. Private/local addresses are "
        "blocked to prevent internal network access."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "Fully-qualified http(s) URL to fetch.",
            },
            "max_chars": {
                "type": "integer",
                "description": (
                    "Maximum characters of extracted text to return. "
                    f"Defaults to {DEFAULT_TEXT_EXCERPT}. Increase for "
                    "long articles, decrease to save context."
                ),
            },
        },
        "required": ["url"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(
        self,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        max_bytes: int = DEFAULT_MAX_BYTES,
        user_agent: str = USER_AGENT,
    ) -> None:
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.user_agent = user_agent

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        raw_url = str(args.get("url", "")).strip()
        if not raw_url:
            return ToolResult(ok=False, error="url is required")
        max_chars = int(args.get("max_chars") or DEFAULT_TEXT_EXCERPT)

        validation = _validate_url(raw_url)
        if validation is not None:
            return ToolResult(ok=False, error=validation)

        headers = {
            "User-Agent": self.user_agent,
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        }
        # Use the macOS system truststore via the `truststore` package.
        # certifi alone fails for sites that rely on AIA chasing for
        # intermediate certs (e.g. Cloudflare-fronted pages) — Python's
        # ssl module does not chase AIA by default, but the system
        # truststore on Mac has the intermediates already cached.
        ssl_ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
                max_redirects=5,
                headers=headers,
                verify=ssl_ctx,
            ) as client:
                try:
                    async with client.stream("GET", raw_url) as resp:
                        resp.raise_for_status()
                        body = bytearray()
                        async for chunk in resp.aiter_bytes():
                            body.extend(chunk)
                            if len(body) > self.max_bytes:
                                return ToolResult(
                                    ok=False,
                                    error=f"response exceeded {self.max_bytes} bytes",
                                )
                        final_url = str(resp.url)
                        content_type = resp.headers.get("content-type", "")
                except httpx.HTTPStatusError as e:
                    return ToolResult(
                        ok=False,
                        error=f"http {e.response.status_code} on {raw_url}",
                    )
                except httpx.HTTPError as e:
                    return ToolResult(ok=False, error=f"fetch failed: {e}")
        except Exception as e:
            return ToolResult(ok=False, error=f"unexpected error: {e}")

        title, text = _extract_title_and_text(bytes(body), content_type)
        truncated = len(text) > max_chars
        if truncated:
            text = text[:max_chars].rstrip() + "\n…[truncated]"

        header_lines = [f"URL: {final_url}"]
        if title:
            header_lines.append(f"Title: {title}")
        header_lines.append(f"Content-Type: {content_type or 'unknown'}")
        header_lines.append(f"Bytes: {len(body)} fetched, {len(text)} chars text")
        header_lines.append("")
        output = "\n".join(header_lines) + text

        return ToolResult(
            ok=True,
            output=output,
            metadata={
                "url": final_url,
                "title": title,
                "content_type": content_type,
                "bytes_fetched": len(body),
                "chars_returned": len(text),
                "truncated": truncated,
            },
        )


def _validate_url(raw: str) -> str | None:
    """Return an error string if the URL must be rejected, or None if OK.
    Blocks non-http schemes, missing hosts, and private IP ranges."""
    try:
        parsed = urlparse(raw)
    except ValueError:
        return "invalid URL"
    if parsed.scheme not in ("http", "https"):
        return f"scheme {parsed.scheme!r} not allowed (use http/https)"
    if not parsed.hostname:
        return "URL missing hostname"

    host = parsed.hostname
    # Block literal private / loopback / link-local IPs directly in the URL.
    try:
        ip = ipaddress.ip_address(host)
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return f"blocked IP address {host} (private/loopback/link-local)"
    except ValueError:
        # Not a literal IP — resolve and check all returned addresses.
        try:
            addrinfos = socket.getaddrinfo(host, None)
        except socket.gaierror as e:
            return f"DNS resolution failed for {host}: {e}"
        for fam, _type, _proto, _canon, sockaddr in addrinfos:
            try:
                ip = ipaddress.ip_address(sockaddr[0])
            except ValueError:
                continue
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_multicast
                or ip.is_reserved
                or ip.is_unspecified
            ):
                return f"blocked: {host} resolves to private/loopback address {ip}"
    return None


def _extract_title_and_text(body: bytes, content_type: str) -> tuple[str, str]:
    """Parse HTML out of `body` and return (title, text). For non-HTML
    content (JSON, plain text, XML), the body is decoded as UTF-8 and
    returned verbatim as text with an empty title."""
    ct = (content_type or "").lower()
    if "html" in ct or "xhtml" in ct or body[:256].lstrip().lower().startswith(b"<!doctype html"):
        try:
            soup = BeautifulSoup(body, "html.parser")
        except Exception:
            return "", body.decode("utf-8", errors="replace")

        # Title
        title = ""
        if soup.title and soup.title.string:
            title = soup.title.string.strip()

        # Strip noise tags
        for tag in soup(_NOISE_TAGS):
            tag.decompose()

        # Grab body text or fall back to whole doc
        root = soup.body or soup
        text = root.get_text(separator="\n", strip=True)
        # Collapse runs of blank lines
        lines = [line.strip() for line in text.splitlines()]
        compact = "\n".join(line for line in lines if line)
        return title, compact

    # Non-HTML content — return raw decoded text.
    try:
        return "", body.decode("utf-8")
    except UnicodeDecodeError:
        return "", body.decode("utf-8", errors="replace")
