"""Ponto de entrada para os aparelhos da casa.

Hoje só o som (EspMusic). Luzes, garagem e piscina viram cada uma outro
atributo aqui, compartilhando o mesmo transporte — sem tocar em Rust nem
em TypeScript.
"""

from __future__ import annotations

from typing import Any

from seraphine.home.espmusic import EspMusicAdapter
from seraphine.home.transport import DEFAULT_BASE, LanTransport


class HomeService:
    def __init__(
        self, app_state: Any, *, base: str = DEFAULT_BASE, tts: Any = None
    ) -> None:
        self._transport = LanTransport(app_state, base=base)
        self.music = EspMusicAdapter(self._transport)
        # Usado pelo aviso falado; None desabilita `home_announce`.
        self.tts = tts
