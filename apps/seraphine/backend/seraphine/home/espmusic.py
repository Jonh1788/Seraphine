"""Adaptador do EspMusic — o único lugar que conhece a API dele.

Duas traduções vivem aqui, e só aqui:

* cômodo → caixa. O usuário fala "sala de estar"; o EspMusic identifica
  as placas como `espmusic-sala-de-estar`.
* volume. A API trabalha em dB, o painel (e o usuário) em porcentagem.

Quando entrarem luzes, garagem e piscina, cada uma vira um módulo irmão
deste, compartilhando o mesmo transporte.
"""

from __future__ import annotations

import math
import unicodedata
from typing import Any

# Passo de um "aumenta o volume". Em dB de propósito: passo linear
# engana no volume baixo (5% → 10% dobra a potência).
VOLUME_STEP_DB = 2.0

# 0% seria log10(0) = -inf. -60 dB é silêncio na prática e continua um
# número que a API aceita. Não usamos /api/mute aqui porque ele é um
# alternador: chamá-lo com o som já mudo desmutaria.
SILENCE_DB = -60.0

DEVICE_PREFIX = "espmusic-"


class UnknownRoom(Exception):
    """O cômodo pedido não corresponde a nenhuma caixa conhecida."""


def slugify_room(name: str) -> str:
    """"Sala de Estar" -> "sala-de-estar" (sem acento, minúsculo)."""
    plain = unicodedata.normalize("NFKD", name)
    plain = "".join(c for c in plain if not unicodedata.combining(c))
    return "-".join(plain.strip().lower().split())


def clamp_pct(pct: float) -> float:
    """Prende o volume pedido na faixa que existe: 0 a 100.

    Precisa acontecer uma vez só, antes de tudo: o aparelho satura de
    qualquer jeito, então quem não clampar antes de montar a frase
    responde "volume em 500%" para um som que foi a 100%.
    """
    return max(0.0, min(float(pct), 100.0))


def pct_to_db(pct: float) -> float:
    """Porcentagem (como o painel mostra) para dB (como a API quer).

    Espelha `dbToPct` em web/src/api.js: pct = 10^(db/20) * 100.
    """
    safe = clamp_pct(pct)
    if safe <= 0:
        return SILENCE_DB
    return round(20.0 * math.log10(safe / 100.0), 2)


def _label(device: str) -> str:
    return device.replace(DEVICE_PREFIX, "")


class EspMusicAdapter:
    def __init__(self, transport: Any) -> None:
        self._t = transport

    # ------------------------------------------------------------ caixas

    async def _snapshot(self) -> dict[str, Any]:
        return await self._t.request("GET", "/api/status")

    async def select_room(self, room: str) -> str:
        """Aponta o EspMusic para a caixa de `room`; devolve o device."""
        wanted = f"{DEVICE_PREFIX}{slugify_room(room)}"
        devices = list((await self._snapshot()).get("devices") or [])
        if wanted not in devices:
            known = ", ".join(_label(d) for d in devices) or "nenhuma"
            raise UnknownRoom(
                f"não conheço o cômodo '{room}'. Caixas disponíveis: {known}"
            )
        await self._t.request("POST", "/api/device", json_body={"name": wanted})
        return wanted

    async def _maybe_select(self, room: str | None) -> None:
        if room:
            await self.select_room(room)

    # ------------------------------------------------------------ tocar

    async def play(
        self, query: str, *, room: str | None = None, mode: str = "now"
    ) -> str:
        await self._maybe_select(room)
        wanted_mode = "queue" if mode == "queue" else "now"
        data = await self._t.request(
            "POST", "/api/play", json_body={"query": query, "mode": wanted_mode}
        )
        added = [str(t) for t in (data.get("added") or [])]
        where = f" na {room}" if room else ""
        if not added:
            return f"pedido enviado{where}"
        head = added[0]
        if len(added) > 1:
            head += f" (+{len(added) - 1} faixas)"
        verb = "na fila" if wanted_mode == "queue" else "tocando"
        return f"{verb}{where}: {head}"

    # ---------------------------------------------------------- controle

    async def control(
        self, action: str, *, value: float | None = None, room: str | None = None
    ) -> str:
        await self._maybe_select(room)
        # `room` não é um filtro: `/api/device` religa o áudio na caixa
        # nova (core.py:743, `set_device` → `rewire`). "aumenta o volume
        # do quarto" com música na sala move a música junto, porque o
        # EspMusic toca em uma caixa por vez e o volume é guardado por
        # caixa. A frase de volta precisa dizer onde foi, senão o som
        # troca de cômodo em silêncio.
        where = f" na {room}" if room else ""

        if action == "pause":
            await self._t.request("POST", "/api/pause", json_body={"on": True})
            return f"pausado{where}"
        if action == "resume":
            await self._t.request("POST", "/api/pause", json_body={"on": False})
            return f"voltou a tocar{where}"
        if action == "next":
            await self._t.request("POST", "/api/next", json_body={})
            return f"pulei a faixa{where}"
        if action == "stop":
            await self._t.request("POST", "/api/stop", json_body={})
            return f"parei e limpei a fila{where}"
        if action == "mute":
            # /api/mute é um alternador: pedir "muta" com o som já mudo
            # desmutaria. Não dá para consertar isso aqui sem virar um
            # "set" — mas a resposta já traz o estado resultante, então
            # devolvemos ele em vez de "alternei", e quem leu a frase
            # (usuário ou LLM) enxerga o efeito no mesmo turno.
            data = await self._t.request("POST", "/api/mute", json_body={})
            state = "mudo ligado" if data.get("muted") else "mudo desligado"
            return f"{state}{where}"
        if action == "volume_up":
            await self._t.request(
                "POST", "/api/volume", json_body={"delta_db": VOLUME_STEP_DB}
            )
            return f"aumentei o volume{where}"
        if action == "volume_down":
            await self._t.request(
                "POST", "/api/volume", json_body={"delta_db": -VOLUME_STEP_DB}
            )
            return f"abaixei o volume{where}"
        if action == "volume_set":
            if value is None:
                raise ValueError("volume_set precisa de 'value' (0 a 100)")
            # Clampa uma vez e usa o mesmo número nos dois lugares: o que
            # vai em dB e o que a Seraphine fala.
            pct = clamp_pct(value)
            await self._t.request(
                "POST", "/api/volume", json_body={"db": pct_to_db(pct)}
            )
            return f"volume em {round(pct)}%{where}"
        if action in ("radio_on", "radio_off"):
            on = action == "radio_on"
            await self._t.request("POST", "/api/radio", json_body={"on": on})
            return ("rádio ligado" if on else "rádio desligado") + where

        raise ValueError(f"ação desconhecida: {action}")

    # ------------------------------------------------------------- aviso

    async def announce(self, audio: bytes, filename: str = "aviso.wav") -> str:
        await self._t.request(
            "POST", "/api/announce", audio=audio, audio_filename=filename
        )
        return "aviso tocado na casa"

    # ------------------------------------------------------------ estado

    async def status(self) -> str:
        s = await self._snapshot()
        parts: list[str] = []

        parts.append(f"cômodo: {s.get('device_label') or 'nenhum selecionado'}")

        cur = s.get("playing") or None
        if cur:
            state = "pausado" if s.get("paused") else "tocando"
            artist = cur.get("artist") or "desconhecido"
            parts.append(f"{state}: {cur.get('title')} — {artist}")
        else:
            parts.append("nada tocando")

        volume_pct = round(float(s.get("volume") or 0.0) * 100)
        parts.append(f"volume: {volume_pct}%" + (" (mudo)" if s.get("muted") else ""))
        parts.append(f"fila: {int(s.get('queue_len') or 0)} faixa(s)")
        parts.append("rádio ligado" if s.get("radio") else "rádio desligado")

        rooms = ", ".join(_label(str(d)) for d in (s.get("devices") or []))
        parts.append(f"caixas: {rooms or 'nenhuma'}")

        return " · ".join(parts)
