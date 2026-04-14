from __future__ import annotations

from unittest.mock import patch

import httpx
import pytest

from seraphine.tools.web import WebFetchTool, _extract_title_and_text, _validate_url


def test_validate_url_accepts_normal_http() -> None:
    # These require DNS but should resolve to public IPs
    assert _validate_url("https://example.com/") is None
    assert _validate_url("http://example.com/news") is None


def test_validate_url_rejects_non_http_schemes() -> None:
    assert "scheme" in (_validate_url("file:///etc/passwd") or "")
    assert "scheme" in (_validate_url("ftp://example.com") or "")
    assert "scheme" in (_validate_url("javascript:alert(1)") or "")


def test_validate_url_rejects_missing_host() -> None:
    assert "hostname" in (_validate_url("http://") or "")


def test_validate_url_rejects_private_ip_literals() -> None:
    cases = [
        "http://127.0.0.1/",
        "http://10.0.0.1/",
        "http://192.168.1.1/",
        "http://172.16.0.1/",
        "http://[::1]/",
        "http://0.0.0.0/",
        "http://169.254.169.254/latest/meta-data",  # AWS IMDS
    ]
    for u in cases:
        err = _validate_url(u)
        assert err is not None, f"expected rejection of {u}"
        assert "blocked" in err or "loopback" in err or "private" in err


def test_validate_url_rejects_hostname_that_resolves_to_private_ip() -> None:
    # Patch socket.getaddrinfo to return a private IP for a fake hostname
    fake_addrinfo = [(2, 1, 6, "", ("10.0.0.1", 0))]
    with patch("seraphine.tools.web.socket.getaddrinfo", return_value=fake_addrinfo):
        err = _validate_url("http://evil.example.com/")
        assert err is not None
        assert "10.0.0.1" in err or "private" in err


def test_extract_title_and_text_strips_noise() -> None:
    html = b"""<!DOCTYPE html>
    <html><head><title>Test Page</title></head>
    <body>
      <nav>Home | About | Contact</nav>
      <script>var evil='xss';</script>
      <style>body{color:red}</style>
      <main>
        <h1>Headline</h1>
        <p>First paragraph content.</p>
        <p>Second paragraph content.</p>
      </main>
      <footer>Copyright 2026</footer>
    </body></html>"""
    title, text = _extract_title_and_text(html, "text/html")
    assert title == "Test Page"
    assert "Headline" in text
    assert "First paragraph content." in text
    assert "Second paragraph content." in text
    # Noise should be stripped
    assert "evil" not in text
    assert "color:red" not in text
    assert "Home | About | Contact" not in text
    assert "Copyright 2026" not in text


def test_extract_title_and_text_plain_text() -> None:
    title, text = _extract_title_and_text(b"just some text", "text/plain")
    assert title == ""
    assert text == "just some text"


@pytest.mark.asyncio
async def test_web_fetch_happy_path(monkeypatch) -> None:
    html = b"""<html><head><title>Example</title></head>
    <body><h1>Hello</h1><p>World paragraph.</p></body></html>"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=html, headers={"content-type": "text/html; charset=utf-8"})

    # Patch validation (it tries DNS resolution for public hostnames in
    # test environments) AND force httpx.AsyncClient to use our mock transport.
    monkeypatch.setattr("seraphine.tools.web._validate_url", lambda _: None)
    real_ac = httpx.AsyncClient

    def patched_ac(*args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_ac(*args, **kwargs)

    monkeypatch.setattr("httpx.AsyncClient", patched_ac)

    tool = WebFetchTool()
    result = await tool.execute({"url": "https://example.com/page"})
    assert result.ok, result.error
    assert "Hello" in (result.output or "")
    assert "World paragraph." in (result.output or "")
    assert result.metadata["title"] == "Example"
    assert result.metadata["bytes_fetched"] == len(html)
    assert result.metadata["truncated"] is False


@pytest.mark.asyncio
async def test_web_fetch_rejects_private_ip() -> None:
    tool = WebFetchTool()
    result = await tool.execute({"url": "http://127.0.0.1:8000/"})
    assert not result.ok
    assert result.error and ("blocked" in result.error or "loopback" in result.error)


@pytest.mark.asyncio
async def test_web_fetch_rejects_bad_scheme() -> None:
    tool = WebFetchTool()
    result = await tool.execute({"url": "file:///etc/passwd"})
    assert not result.ok
    assert result.error and "scheme" in result.error


@pytest.mark.asyncio
async def test_web_fetch_handles_http_error(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="not found")

    monkeypatch.setattr("seraphine.tools.web._validate_url", lambda _: None)
    real_ac = httpx.AsyncClient

    def patched_ac(*args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_ac(*args, **kwargs)

    monkeypatch.setattr("httpx.AsyncClient", patched_ac)

    tool = WebFetchTool()
    result = await tool.execute({"url": "https://example.com/missing"})
    assert not result.ok
    assert "404" in (result.error or "")


@pytest.mark.asyncio
async def test_web_fetch_truncates_long_text(monkeypatch) -> None:
    long_text = "paragraph " * 2000  # ~18 KB
    html = f"<html><head><title>Long</title></head><body><p>{long_text}</p></body></html>".encode()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=html, headers={"content-type": "text/html"})

    monkeypatch.setattr("seraphine.tools.web._validate_url", lambda _: None)
    real_ac = httpx.AsyncClient

    def patched_ac(*args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_ac(*args, **kwargs)

    monkeypatch.setattr("httpx.AsyncClient", patched_ac)

    tool = WebFetchTool()
    result = await tool.execute({"url": "https://example.com/", "max_chars": 500})
    assert result.ok
    assert result.metadata["truncated"] is True
    assert result.metadata["chars_returned"] <= 520  # 500 + "\n…[truncated]"
    assert "[truncated]" in (result.output or "")
