"""Testes das tools da casa.

O adaptador é falso: aqui interessa o contrato com o LLM (schema,
descrição, args) e a tradução de exceção em frase que a Seraphine
consegue falar.
"""

from __future__ import annotations

import io
import wave
from typing import Any, AsyncIterator

from seraphine.home.espmusic import UnknownRoom
from seraphine.home.transport import HomeHTTPError, HomeUnreachable
from seraphine.tools.base import ToolResult
from seraphine.tools.home import (
    HomeAnnounceTool,
    HomeControlTool,
    HomePlayTool,
    HomeStatusTool,
)


class FakeAdapter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.raises: Exception | None = None

    async def _record(self, name: str, **kw: Any) -> str:
        self.calls.append((name, kw))
        if self.raises is not None:
            raise self.raises
        return f"{name} ok"

    async def play(self, query: str, *, room=None, mode="now") -> str:
        return await self._record("play", query=query, room=room, mode=mode)

    async def control(self, action: str, *, value=None, room=None) -> str:
        return await self._record("control", action=action, value=value, room=room)

    async def announce(self, audio: bytes, filename: str = "aviso.wav") -> str:
        return await self._record("announce", audio=audio, filename=filename)

    async def status(self) -> str:
        return await self._record("status")


class FakeOggTTS:
    async def synthesize_ogg(self, text: str, *, voice_id=None) -> bytes:
        return b"OggS-" + text.encode()


class FakeStreamTTS:
    """Sem ogg — só o stream PCM, como os adaptadores locais."""

    async def synthesize_ogg(self, text: str, *, voice_id=None) -> bytes:
        raise NotImplementedError

    async def synthesize_stream(self, text, *, voice_id=None) -> AsyncIterator[bytes]:
        yield b"\x01\x02" * 8
        yield b"\x03\x04" * 8


class FakeService:
    def __init__(self, tts: Any = None) -> None:
        self.music = FakeAdapter()
        self.tts = tts


# ------------------------------------------------------------- contrato


def test_every_tool_declares_a_valid_schema() -> None:
    svc = FakeService()
    for tool in (
        HomePlayTool(svc),
        HomeControlTool(svc),
        HomeAnnounceTool(svc),
        HomeStatusTool(svc),
    ):
        assert tool.name.startswith("home_")
        assert tool.json_schema["type"] == "object"
        assert tool.requires_confirmation is False


def test_descriptions_gate_on_a_room_and_send_music_to_play_music() -> None:
    # Sem isso o LLM confunde com as tools de navegador de tools/browser.py.
    svc = FakeService()
    for tool in (HomePlayTool(svc), HomeControlTool(svc), HomeAnnounceTool(svc)):
        assert "APENAS quando o usuário citar um cômodo" in tool.description

    for tool in (HomePlayTool(svc), HomeControlTool(svc)):
        assert "play_music" in tool.description

    # `play_music` procura no YouTube Music: não sabe falar um aviso.
    # Mandar o modelo para lá num "avisa que o jantar chegou" faria ele
    # buscar a frase como música.
    assert "play_music" not in HomeAnnounceTool(svc).description


def test_status_takes_no_arguments() -> None:
    assert HomeStatusTool(FakeService()).json_schema.get("properties") == {}


# ----------------------------------------------------------------- play


async def test_play_forwards_query_room_and_mode() -> None:
    svc = FakeService()
    result = await HomePlayTool(svc).execute(
        {"query": "djavan", "room": "sala", "mode": "queue"}
    )
    assert result.ok
    assert svc.music.calls == [
        ("play", {"query": "djavan", "room": "sala", "mode": "queue"})
    ]


async def test_play_requires_a_query() -> None:
    result = await HomePlayTool(FakeService()).execute({})
    assert not result.ok
    assert "query" in (result.error or "")


# -------------------------------------------------------------- control


async def test_control_forwards_action_and_value() -> None:
    svc = FakeService()
    result = await HomeControlTool(svc).execute({"action": "volume_set", "value": 40})
    assert result.ok
    assert svc.music.calls == [
        ("control", {"action": "volume_set", "value": 40, "room": None})
    ]


async def test_control_rejects_an_action_outside_the_enum() -> None:
    result = await HomeControlTool(FakeService()).execute({"action": "explodir"})
    assert not result.ok


# ------------------------------------------------------------- announce


async def test_announce_uses_ogg_when_the_backend_supports_it() -> None:
    svc = FakeService(tts=FakeOggTTS())
    result = await HomeAnnounceTool(svc).execute({"text": "o jantar chegou"})
    assert result.ok
    name, kw = svc.music.calls[0]
    assert name == "announce"
    assert kw["audio"].startswith(b"OggS-")
    assert kw["filename"].endswith(".ogg")


async def test_announce_falls_back_to_a_wav_built_from_the_pcm_stream() -> None:
    svc = FakeService(tts=FakeStreamTTS())
    result = await HomeAnnounceTool(svc).execute({"text": "oi"})
    assert result.ok
    _, kw = svc.music.calls[0]
    assert kw["filename"].endswith(".wav")
    # Precisa ser um WAV válido, mono, 16 bits, 24 kHz.
    with wave.open(io.BytesIO(kw["audio"]), "rb") as w:
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        assert w.getframerate() == 24_000
        assert w.getnframes() > 0


async def test_announce_without_tts_fails_clearly() -> None:
    svc = FakeService(tts=None)
    result = await HomeAnnounceTool(svc).execute({"text": "oi"})
    assert not result.ok
    assert "voz" in (result.error or "").lower()
    # E não o erro genérico de síntese: sem TTS a falha é de configuração,
    # não um estouro em cima de `None` — e nada chega às caixas.
    assert "NoneType" not in (result.error or "")
    assert svc.music.calls == []


async def test_announce_requires_text() -> None:
    result = await HomeAnnounceTool(FakeService(tts=FakeOggTTS())).execute({})
    assert not result.ok


# ---------------------------------------------------------------- erros


async def test_no_client_connected_becomes_a_speakable_sentence() -> None:
    svc = FakeService()
    svc.music.raises = HomeUnreachable("no Tauri WebSocket is connected")
    result = await HomePlayTool(svc).execute({"query": "x"})
    assert not result.ok
    assert "app" in (result.error or "").lower()
    # Nem o erro genérico (que vazaria "WebSocket"), nem o do aparelho.
    assert "WebSocket" not in (result.error or "")
    assert "HTTP" not in (result.error or "")


async def test_a_404_from_play_says_the_song_was_not_found() -> None:
    svc = FakeService()
    svc.music.raises = HomeHTTPError(404, '{"error": "nada encontrado"}')
    result = await HomePlayTool(svc).execute({"query": "x"})
    assert not result.ok
    assert "não achei" in (result.error or "").lower()
    # Nem o status cru nem o corpo do aparelho vazam para o usuário.
    assert "404" not in (result.error or "")
    assert "nada encontrado" not in (result.error or "")


async def test_an_unknown_room_keeps_the_list_of_rooms_in_the_error() -> None:
    svc = FakeService()
    exc = UnknownRoom(
        "não conheço o cômodo 'garagem'. Caixas disponíveis: banheiro, sala"
    )
    svc.music.raises = exc
    result = await HomePlayTool(svc).execute({"query": "x", "room": "garagem"})
    assert not result.ok
    assert "banheiro" in (result.error or "")
    # A frase do adaptador passa inteira, sem prefixo genérico na frente.
    assert result.error == str(exc)


async def test_a_500_from_the_device_is_reported_as_a_device_error() -> None:
    svc = FakeService()
    svc.music.raises = HomeHTTPError(500, "boom")
    result = await HomeStatusTool(svc).execute({})
    assert not result.ok
    assert "casa" in (result.error or "").lower()
    # A distinção que importa: o aparelho respondeu, então a culpa não é
    # do app fechado — e o status entra na frase, sem o corpo cru.
    assert "HTTP 500" in (result.error or "")
    assert "app" not in (result.error or "").lower()
    assert "boom" not in (result.error or "")


# --------------------------------------------------- contrato do serviço


def test_the_service_exposes_music_and_tts() -> None:
    # Contrato que main.py usa ao registrar as tools.
    from seraphine.home.service import HomeService

    svc = HomeService(app_state=object(), tts="fake-tts")
    assert svc.tts == "fake-tts"
    assert hasattr(svc.music, "play")
    assert hasattr(svc.music, "announce")


async def test_the_service_base_defaults_and_can_be_overridden(monkeypatch) -> None:
    """`base` é o parâmetro que precisa continuar concordando com ALLOWED
    em src-tauri/src/home.rs: o relé recusa qualquer outra base, e uma
    renomeação silenciosa só apareceria em produção.
    """
    from seraphine.home.service import HomeService
    from seraphine.home.transport import DEFAULT_BASE

    seen: list[dict[str, Any]] = []

    async def fake_proxy(app_state: Any, tool_name: str, args: dict[str, Any]):
        seen.append(args)
        return ToolResult(ok=True, output="{}", metadata={"status": 200})

    monkeypatch.setattr(
        "seraphine.conversation.engine._proxy_tool_via_client", fake_proxy
    )

    await HomeService(app_state=object()).music.status()
    assert seen[-1]["base"] == DEFAULT_BASE

    other = "http://outra.local:9000"
    await HomeService(app_state=object(), base=other).music.status()
    assert seen[-1]["base"] == other
