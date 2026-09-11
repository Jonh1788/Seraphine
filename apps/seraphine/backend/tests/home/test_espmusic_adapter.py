"""Testes do adaptador do EspMusic.

O transporte é falso: cada teste declara o que o /api/status devolve e
depois confere a rota e o corpo que o adaptador montou.
"""

from __future__ import annotations

from typing import Any

import pytest

from seraphine.home.espmusic import (
    EspMusicAdapter,
    UnknownRoom,
    pct_to_db,
    slugify_room,
)
from seraphine.home.transport import HomeHTTPError

SNAPSHOT = {
    "devices": ["espmusic-banheiro", "espmusic-sala"],
    "device": "espmusic-sala",
    "device_label": "sala",
    "playing": {"title": "Flor de Lis", "artist": "Djavan"},
    "paused": False,
    "queue_len": 12,
    "radio": True,
    "volume": 0.5,
    "muted": False,
}


class FakeTransport:
    """Grava (método, path, corpo) e devolve respostas combinadas."""

    def __init__(self, responses: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self.responses = responses or {}
        self.raise_on: dict[str, Exception] = {}

    async def request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        audio: bytes | None = None,
        audio_filename: str = "aviso.wav",
    ) -> Any:
        self.calls.append((method, path, audio if audio is not None else json_body))
        if path in self.raise_on:
            raise self.raise_on[path]
        return self.responses.get(path, {"ok": True})


@pytest.fixture()
def transport() -> FakeTransport:
    return FakeTransport({"/api/status": SNAPSHOT})


@pytest.fixture()
def adapter(transport: FakeTransport) -> EspMusicAdapter:
    return EspMusicAdapter(transport)


# ------------------------------------------------------------ helpers


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("sala", "sala"),
        ("Sala", "sala"),
        ("Sala de Estar", "sala-de-estar"),
        ("Cozinha ", "cozinha"),
        ("Quarto do João", "quarto-do-joao"),
        ("BANHEIRO", "banheiro"),
    ],
)
def test_slugify_room(raw: str, expected: str) -> None:
    assert slugify_room(raw) == expected


@pytest.mark.parametrize(
    "pct,expected",
    [
        (100.0, 0.0),
        (50.0, -6.02),
        (10.0, -20.0),
        (150.0, 0.0),  # acima de 100 satura em 0 dB
    ],
)
def test_pct_to_db(pct: float, expected: float) -> None:
    assert pct_to_db(pct) == pytest.approx(expected, abs=0.01)


def test_pct_to_db_clamps_zero_to_practical_silence() -> None:
    # log10(0) é -inf; o adaptador precisa devolver um número finito.
    assert pct_to_db(0.0) == -60.0


# ------------------------------------------------------------ cômodos


async def test_play_without_a_room_does_not_switch_speakers(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    await adapter.play("djavan")
    paths = [p for _, p, _ in transport.calls]
    assert "/api/device" not in paths
    assert ("POST", "/api/play", {"query": "djavan", "mode": "now"}) in transport.calls


async def test_play_with_a_room_selects_the_speaker_first(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    await adapter.play("djavan", room="Sala")
    assert transport.calls[0] == ("GET", "/api/status", None)
    assert transport.calls[1] == ("POST", "/api/device", {"name": "espmusic-sala"})
    assert transport.calls[2] == ("POST", "/api/play", {"query": "djavan", "mode": "now"})


async def test_an_unknown_room_lists_the_ones_that_exist(
    adapter: EspMusicAdapter,
) -> None:
    with pytest.raises(UnknownRoom) as exc:
        await adapter.play("djavan", room="garagem")
    assert "banheiro" in str(exc.value)
    assert "sala" in str(exc.value)


async def test_queue_mode_is_forwarded(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    await adapter.play("djavan", mode="queue")
    assert ("POST", "/api/play", {"query": "djavan", "mode": "queue"}) in transport.calls


async def test_a_404_from_play_becomes_a_readable_message(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    transport.raise_on["/api/play"] = HomeHTTPError(404, '{"error": "nada encontrado"}')
    with pytest.raises(HomeHTTPError):
        await adapter.play("uma música que não existe")


# ------------------------------------------------------------ controle


@pytest.mark.parametrize(
    "action,path,body",
    [
        ("pause", "/api/pause", {"on": True}),
        ("resume", "/api/pause", {"on": False}),
        ("next", "/api/next", {}),
        ("stop", "/api/stop", {}),
        ("mute", "/api/mute", {}),
        ("volume_up", "/api/volume", {"delta_db": 2.0}),
        ("volume_down", "/api/volume", {"delta_db": -2.0}),
        ("radio_on", "/api/radio", {"on": True}),
        ("radio_off", "/api/radio", {"on": False}),
    ],
)
async def test_control_maps_each_action(
    adapter: EspMusicAdapter, transport: FakeTransport,
    action: str, path: str, body: dict[str, Any],
) -> None:
    await adapter.control(action)
    assert ("POST", path, body) in transport.calls


async def test_control_with_a_room_selects_the_speaker_first(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    # "aumenta o volume da sala" não pode mexer na caixa que estava
    # selecionada antes — e aqui o erro é invisível: nada começa a tocar
    # para denunciar o cômodo errado.
    await adapter.control("volume_up", room="Sala")
    assert transport.calls[0] == ("GET", "/api/status", None)
    assert transport.calls[1] == ("POST", "/api/device", {"name": "espmusic-sala"})
    assert transport.calls[2] == ("POST", "/api/volume", {"delta_db": 2.0})


async def test_control_with_a_room_says_where_it_acted(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    """`/api/device` religa o áudio (core.py:743): a música vai junto.

    Sem o cômodo na resposta, "aumenta o volume do quarto" com música
    tocando na sala move o som de cômodo e a Seraphine responde
    "aumentei o volume" — nada denuncia a mudança.
    """
    assert await adapter.control("volume_up", room="Sala") == (
        "aumentei o volume na Sala"
    )
    transport.responses["/api/mute"] = {"muted": True}
    assert await adapter.control("mute", room="Sala") == "mudo ligado na Sala"
    assert await adapter.control("pause", room="Sala") == "pausado na Sala"


async def test_control_without_a_room_does_not_invent_a_place(
    adapter: EspMusicAdapter,
) -> None:
    # Sem `room` nada foi movido: a frase não pode sugerir cômodo.
    assert await adapter.control("volume_up") == "aumentei o volume"


async def test_mute_reports_the_resulting_state(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    # /api/mute é um alternador; a frase de volta precisa dizer onde
    # o som parou, não que "algo foi alternado".
    # Igualdade, e não `"ligado" in ...`: "ligado" é substring de
    # "desligado", então a versão com `in` passaria mesmo se o adaptador
    # devolvesse sempre "mudo desligado".
    transport.responses["/api/mute"] = {"ok": True, "muted": True}
    assert await adapter.control("mute") == "mudo ligado"

    transport.responses["/api/mute"] = {"ok": True, "muted": False}
    assert await adapter.control("mute") == "mudo desligado"


async def test_volume_set_converts_percent_to_db(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    await adapter.control("volume_set", value=50)
    assert ("POST", "/api/volume", {"db": -6.02}) in transport.calls


@pytest.mark.parametrize(
    "value,db,said",
    [
        (500, 0.0, "volume em 100%"),
        (-20, -60.0, "volume em 0%"),
        (100, 0.0, "volume em 100%"),
        (0, -60.0, "volume em 0%"),
    ],
)
async def test_volume_set_reports_the_volume_that_was_applied(
    adapter: EspMusicAdapter, transport: FakeTransport,
    value: float, db: float, said: str,
) -> None:
    # O aparelho satura; a frase precisa saturar junto. Dizer
    # "volume em 500%" para um som que foi a 100% ensina o usuário (e o
    # LLM, que lê a resposta) uma escala que não existe.
    assert await adapter.control("volume_set", value=value) == said
    assert ("POST", "/api/volume", {"db": db}) in transport.calls


async def test_volume_set_without_a_value_is_rejected(
    adapter: EspMusicAdapter,
) -> None:
    with pytest.raises(ValueError):
        await adapter.control("volume_set")


async def test_volume_up_ignores_a_stray_value(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    # O passo é fixo: 'value' só vale em volume_set.
    await adapter.control("volume_up", value=40)
    assert ("POST", "/api/volume", {"delta_db": 2.0}) in transport.calls


async def test_an_unknown_action_is_rejected(adapter: EspMusicAdapter) -> None:
    with pytest.raises(ValueError):
        await adapter.control("explodir")


# ------------------------------------------------------------ aviso


async def test_announce_posts_the_audio(
    adapter: EspMusicAdapter, transport: FakeTransport
) -> None:
    await adapter.announce(b"OggS...", filename="aviso.ogg")
    assert ("POST", "/api/announce", b"OggS...") in transport.calls


# ------------------------------------------------------------ estado


async def test_status_summarises_what_matters(adapter: EspMusicAdapter) -> None:
    text = await adapter.status()
    assert "sala" in text
    assert "Flor de Lis" in text
    assert "50%" in text
    assert "12" in text
    assert "rádio ligado" in text


async def test_status_says_when_nothing_is_playing(transport: FakeTransport) -> None:
    transport.responses["/api/status"] = {**SNAPSHOT, "playing": None}
    text = await EspMusicAdapter(transport).status()
    assert "nada tocando" in text


# --------------------------------------------- cômodo sem roubar a música

# O SNAPSHOT do topo é de um servidor ANTIGO: não anuncia `features`. Isso é
# de propósito — os testes acima continuam exercitando o caminho de queda.
SNAPSHOT_NOVO = {**SNAPSHOT, "features": ["device_scoped_control"]}


@pytest.fixture()
def novo() -> FakeTransport:
    """Transporte com um EspMusic que sabe mirar a caixa."""
    return FakeTransport({"/api/status": SNAPSHOT_NOVO})


def _rotas(t: FakeTransport) -> list[str]:
    return [path for _, path, _ in t.calls]


def _corpo(t: FakeTransport, path: str) -> Any:
    for _, p, body in t.calls:
        if p == path:
            return body
    raise AssertionError(f"não chamou {path}")


async def test_volume_in_another_room_no_longer_moves_the_music(novo) -> None:
    """A regressão que motivou tudo isto.

    "aumenta o volume no banheiro" com música na sala trocava o cômodo do som,
    porque o único jeito de alcançar a outra caixa era `/api/device` — e ele
    chama `rewire`. A ausência de `/api/device` aqui é a asserção forte.
    """
    await EspMusicAdapter(novo).control("volume_up", room="banheiro")

    assert "/api/device" not in _rotas(novo)
    assert _corpo(novo, "/api/volume")["device"] == "espmusic-banheiro"


@pytest.mark.parametrize(
    "action,path",
    [
        ("volume_up", "/api/volume"),
        ("volume_down", "/api/volume"),
        ("mute", "/api/mute"),
    ],
)
async def test_every_setting_action_is_aimed_not_moved(novo, action, path) -> None:
    await EspMusicAdapter(novo).control(action, room="banheiro")
    assert "/api/device" not in _rotas(novo)
    assert _corpo(novo, path)["device"] == "espmusic-banheiro"


async def test_volume_set_keeps_aiming_and_still_converts_to_db(novo) -> None:
    out = await EspMusicAdapter(novo).control("volume_set", value=30, room="banheiro")
    corpo = _corpo(novo, "/api/volume")
    assert corpo["device"] == "espmusic-banheiro"
    # A tradução de % para dB não pode ter se perdido no caminho.
    assert corpo["db"] == pct_to_db(30)
    assert "30%" in out


@pytest.mark.parametrize("action", ["pause", "next", "stop", "radio_on"])
async def test_transport_actions_still_move_the_audio(novo, action) -> None:
    """E DEVEM mover: só existe um pipeline.

    Pedir "pausa no banheiro" com música na sala não tem leitura sensata que
    não seja mover o áudio para lá. O que era surpresa no volume é a semântica
    correta aqui — por isso `/api/device` continua sendo chamado.
    """
    await EspMusicAdapter(novo).control(action, room="banheiro")
    assert "/api/device" in _rotas(novo)


async def test_an_old_server_falls_back_to_switching_devices(transport) -> None:
    """O EspMusic do PC é atualizado à mão; a versão dele não acompanha.

    Sem a marca `device_scoped_control`, mandar `device` seria pior que o
    comportamento antigo: o FastAPI ignora campo desconhecido, então o volume
    iria para a caixa ERRADA em silêncio. A queda é para `/api/device`.
    """
    await EspMusicAdapter(transport).control("volume_up", room="banheiro")

    assert "/api/device" in _rotas(transport)
    assert "device" not in (_corpo(transport, "/api/volume") or {})


async def test_no_room_sends_no_device_and_no_switch(novo) -> None:
    await EspMusicAdapter(novo).control("volume_up")
    assert "/api/device" not in _rotas(novo)
    assert "device" not in (_corpo(novo, "/api/volume") or {})


async def test_an_unknown_room_is_named_before_any_request_goes_out(novo) -> None:
    """A frase que lista as caixas vale mais que um 404 cru do EspMusic."""
    with pytest.raises(UnknownRoom) as e:
        await EspMusicAdapter(novo).control("volume_up", room="garagem")

    assert "garagem" in str(e.value)
    assert "banheiro" in str(e.value) and "sala" in str(e.value)
    # Ausência afirmada: nada foi alterado em caixa nenhuma.
    assert "/api/volume" not in _rotas(novo)
