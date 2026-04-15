from __future__ import annotations

import base64

import httpx
import pytest

from seraphine.tools.image_fetch import FetchImageTool


# 1x1 transparent PNG
_TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082"
)


def _patch_httpx(monkeypatch, handler) -> None:
    monkeypatch.setattr(
        "seraphine.tools.image_fetch._validate_url", lambda _: None
    )
    real_ac = httpx.AsyncClient

    def patched_ac(*args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_ac(*args, **kwargs)

    monkeypatch.setattr("httpx.AsyncClient", patched_ac)


@pytest.mark.asyncio
async def test_fetch_image_happy_path(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_TINY_PNG,
            headers={"content-type": "image/png"},
        )

    _patch_httpx(monkeypatch, handler)

    tool = FetchImageTool()
    result = await tool.execute(
        {"url": "https://example.com/pic.png", "caption": "um gatinho"}
    )

    assert result.ok, result.error
    assert result.output == "Imagem: um gatinho"
    data_url = result.metadata["image_data_url"]
    assert isinstance(data_url, str)
    assert data_url.startswith("data:image/png;base64,")
    b64 = data_url.split(",", 1)[1]
    assert base64.b64decode(b64) == _TINY_PNG
    assert result.metadata["content_type"] == "image/png"
    assert result.metadata["bytes"] == len(_TINY_PNG)
    assert result.metadata["caption"] == "um gatinho"


@pytest.mark.asyncio
async def test_fetch_image_rejects_non_image_content_type(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"<html>nope</html>",
            headers={"content-type": "text/html; charset=utf-8"},
        )

    _patch_httpx(monkeypatch, handler)

    tool = FetchImageTool()
    result = await tool.execute({"url": "https://example.com/not-an-image"})
    assert not result.ok
    assert result.error and "not an image" in result.error
    assert "text/html" in result.error


@pytest.mark.asyncio
async def test_fetch_image_rejects_private_ip() -> None:
    tool = FetchImageTool()
    result = await tool.execute({"url": "http://127.0.0.1/foo.png"})
    assert not result.ok
    assert result.error and (
        "blocked" in result.error or "loopback" in result.error
    )


@pytest.mark.asyncio
async def test_fetch_image_rejects_bad_scheme() -> None:
    tool = FetchImageTool()
    result = await tool.execute({"url": "file:///etc/passwd"})
    assert not result.ok
    assert result.error and "scheme" in result.error


@pytest.mark.asyncio
async def test_fetch_image_requires_url() -> None:
    tool = FetchImageTool()
    result = await tool.execute({})
    assert not result.ok
    assert result.error == "url is required"


@pytest.mark.asyncio
async def test_fetch_image_enforces_max_bytes(monkeypatch) -> None:
    big_body = b"x" * 2048

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=big_body, headers={"content-type": "image/jpeg"}
        )

    _patch_httpx(monkeypatch, handler)

    tool = FetchImageTool(max_bytes=1024)
    result = await tool.execute({"url": "https://example.com/big.jpg"})
    assert not result.ok
    assert result.error and "exceeded" in result.error


@pytest.mark.asyncio
async def test_fetch_image_handles_http_error(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="not found")

    _patch_httpx(monkeypatch, handler)

    tool = FetchImageTool()
    result = await tool.execute({"url": "https://example.com/missing.png"})
    assert not result.ok
    assert "404" in (result.error or "")


@pytest.mark.asyncio
async def test_fetch_image_caption_optional(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=_TINY_PNG, headers={"content-type": "image/png"}
        )

    _patch_httpx(monkeypatch, handler)

    tool = FetchImageTool()
    result = await tool.execute({"url": "https://example.com/a.png"})
    assert result.ok
    # Without a caption, output should fall back to the URL.
    assert result.output is not None
    assert "example.com/a.png" in result.output
    assert result.metadata["caption"] == ""
