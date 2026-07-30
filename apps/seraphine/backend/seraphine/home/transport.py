"""Transporte para os aparelhos da casa, que vivem na rede local.

O backend roda no VPS e não alcança a LAN. Toda requisição é empacotada
e enviada ao cliente Tauri pelo WebSocket de proxy de tools que já
existe; quem abre a conexão é o comando `lan_request`, de dentro de casa.

`lan_request` **não** é registrado no ToolRegistry de propósito: o LLM
nunca pode enxergar um escape hatch de HTTP genérico. É uma capacidade
do cliente, invocada só daqui.

Trocar este arquivo por um bridge outbound (v2, que funciona fora de
casa) é a migração inteira — adaptadores e tools não mudam.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any

logger = logging.getLogger("seraphine.home.transport")

DEFAULT_BASE = "http://espmusic.local:8080"

# Precisa bater com ALLOWED em
# apps/seraphine/frontend/src-tauri/src/home.rs — o relé recusa
# qualquer outra base.


class HomeUnreachable(Exception):
    """Não deu para falar com a casa: sem cliente conectado, sem rede,
    ou o aparelho não respondeu."""


class HomeHTTPError(Exception):
    """A casa respondeu, mas com status de erro."""

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"HTTP {status}: {body[:200]}")
        self.status = status
        self.body = body


class LanTransport:
    def __init__(self, app_state: Any, base: str = DEFAULT_BASE) -> None:
        self._app_state = app_state
        self._base = base.rstrip("/")

    async def request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        audio: bytes | None = None,
        audio_filename: str = "aviso.wav",
    ) -> Any:
        """Executa a chamada dentro de casa e devolve o JSON decodificado.

        Levanta HomeHTTPError quando o aparelho respondeu com erro e
        HomeUnreachable quando a chamada nem chegou lá.
        """
        # Import local: o engine importa tools, que importam este módulo.
        # Importar no topo fecharia o ciclo. Também é o que permite o
        # monkeypatch nos testes.
        from seraphine.conversation.engine import _proxy_tool_via_client

        args: dict[str, Any] = {
            "base": self._base,
            "method": method.upper(),
            "path": path,
        }
        if audio is not None:
            args["audio_b64"] = base64.b64encode(audio).decode("ascii")
            args["audio_filename"] = audio_filename
        elif json_body is not None:
            args["json"] = json_body

        result = await _proxy_tool_via_client(self._app_state, "lan_request", args)

        meta = result.metadata or {}
        status = int(meta.get("status") or 0)
        # Ordem importa: um 404 também chega com ok=False, e ele é um
        # erro do aparelho, não uma falha de alcance. O corte é 300 e não
        # 400 porque o relé não segue redirect: um 3xx é resposta do
        # aparelho, não sinal de que a casa está fora de alcance.
        if status >= 300:
            raise HomeHTTPError(status, result.output or "")
        if not result.ok:
            logger.warning("lan_request falhou: %s", result.error)
            raise HomeUnreachable(result.error or "relay failed")

        body = result.output or ""
        if not body:
            return {}
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {"raw": body}
