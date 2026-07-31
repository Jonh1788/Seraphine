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
from seraphine.home.transport import (
    HomeAppClosed,
    HomeDeviceUnreachable,
    HomeHTTPError,
    HomeRelayRejected,
)
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
    # `home_status` inclusive: "o que está tocando?" sem cômodo é sobre o
    # Mac, e sem o portão essa pergunta cai na casa.
    svc = FakeService()
    for tool in (
        HomePlayTool(svc),
        HomeControlTool(svc),
        HomeAnnounceTool(svc),
        HomeStatusTool(svc),
    ):
        assert "APENAS quando o usuário citar um cômodo" in tool.description

    for tool in (HomePlayTool(svc), HomeControlTool(svc)):
        assert "play_music" in tool.description

    # A alternativa certa para o estado do Mac não é `play_music` (que
    # tocaria algo), é `now_playing`.
    assert "now_playing" in HomeStatusTool(svc).description

    # `play_music` procura no YouTube Music: não sabe falar um aviso.
    # Mandar o modelo para lá num "avisa que o jantar chegou" faria ele
    # buscar a frase como música.
    assert "play_music" not in HomeAnnounceTool(svc).description


def test_the_control_description_warns_that_a_room_moves_the_music() -> None:
    # `room` não filtra: `/api/device` religa o áudio (core.py:743). Sem
    # esse aviso no texto, "aumenta o volume do quarto" teleporta a
    # música que tocava na sala e o LLM não tem como saber disso.
    text = HomeControlTool(FakeService()).description.lower()
    assert "move" in text
    assert "uma caixa por vez" in text


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


async def test_play_rejects_a_mode_outside_the_enum() -> None:
    # Simétrico ao `action` de home_control: um modo desconhecido não
    # pode degradar para "now", que é justamente o que corta a faixa
    # tocando. Nada chega ao adaptador.
    svc = FakeService()
    result = await HomePlayTool(svc).execute({"query": "djavan", "mode": "agora"})
    assert not result.ok
    assert "agora" in (result.error or "")
    assert svc.music.calls == []


async def test_an_absent_mode_still_defaults_to_now() -> None:
    svc = FakeService()
    result = await HomePlayTool(svc).execute({"query": "djavan"})
    assert result.ok
    assert svc.music.calls[0][1]["mode"] == "now"


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


# As três falhas de alcance pedem ações diferentes: abrir o app, ligar o
# PC, alinhar a allowlist. Cada teste confere o token da sua frase E a
# ausência dos tokens das outras duas — uma asserção que casa com dois
# ramos não prende nenhum.
_APP_TOKEN = "precisa estar aberto"
_DEVICE_TOKEN = "não respondeu"
_DRIFT_TOKEN = "allowlist"


async def test_no_client_connected_becomes_a_speakable_sentence() -> None:
    svc = FakeService()
    svc.music.raises = HomeAppClosed("no Tauri WebSocket is connected")
    result = await HomePlayTool(svc).execute({"query": "x"})
    assert not result.ok
    error = result.error or ""
    assert _APP_TOKEN in error
    assert _DEVICE_TOKEN not in error
    assert _DRIFT_TOKEN not in error
    # Nem o erro genérico (que vazaria "WebSocket"), nem o do aparelho.
    assert "WebSocket" not in error
    assert "HTTP" not in error


async def test_the_device_being_off_does_not_blame_the_app() -> None:
    """A falha mais provável do dia a dia: o PC Windows desligado.

    Mandar abrir um app que já está aberto — foi ele que tentou e não
    alcançou — é a pior das trocas possíveis aqui.
    """
    svc = FakeService()
    svc.music.raises = HomeDeviceUnreachable("rede: error trying to connect")
    result = await HomeStatusTool(svc).execute({})
    assert not result.ok
    error = result.error or ""
    assert _DEVICE_TOKEN in error
    assert _APP_TOKEN not in error
    assert _DRIFT_TOKEN not in error
    # E não vaza o erro cru do reqwest.
    assert "rede:" not in error


async def test_an_allowlist_drift_names_the_mismatch() -> None:
    svc = FakeService()
    svc.music.raises = HomeRelayRejected(
        "host não permitido: http://espmusic.local:9000/api/status"
    )
    result = await HomeControlTool(svc).execute({"action": "pause"})
    assert not result.ok
    error = result.error or ""
    assert _DRIFT_TOKEN in error
    assert _APP_TOKEN not in error
    assert _DEVICE_TOKEN not in error
    # Sem o endereço, a frase não diz o que consertar.
    assert "espmusic.local:9000" in error


async def test_a_404_from_play_says_the_song_was_not_found() -> None:
    svc = FakeService()
    svc.music.raises = HomeHTTPError(404, '{"error": "nada encontrado"}')
    result = await HomePlayTool(svc).execute({"query": "x"})
    assert not result.ok
    assert "não achei" in (result.error or "").lower()
    # Nem o status cru nem o corpo do aparelho vazam para o usuário.
    assert "404" not in (result.error or "")
    assert "nada encontrado" not in (result.error or "")


async def test_a_404_from_announce_is_not_a_missing_song() -> None:
    """O `_failure` é compartilhado pelas quatro tools.

    Um 404 no `/api/announce` significa que aquele servidor não tem a
    rota (o PC pode estar numa versão anterior), e responder "não achei
    essa música" para "avisa que o jantar chegou" é incompreensível.
    """
    svc = FakeService(tts=FakeOggTTS())
    svc.music.raises = HomeHTTPError(404, "Not Found")
    result = await HomeAnnounceTool(svc).execute({"text": "o jantar chegou"})
    assert not result.ok
    assert "não achei" not in (result.error or "").lower()
    assert "aviso" in (result.error or "").lower()


async def test_a_404_from_status_falls_back_to_the_generic_device_error() -> None:
    # Sem dica, um 404 é só mais um erro do aparelho — nunca uma música
    # que não existe.
    svc = FakeService()
    svc.music.raises = HomeHTTPError(404, "Not Found")
    result = await HomeStatusTool(svc).execute({})
    assert not result.ok
    assert "não achei" not in (result.error or "").lower()
    assert "HTTP 404" in (result.error or "")


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
