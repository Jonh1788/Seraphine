"""033 — Tool proxy broker.

Bridges in-flight tool calls from the server-side engine to the Mac
`.app` via the shared WebSocket. Each pending proxy is an asyncio
Future keyed by request_id. When the client sends
`tool_proxy_response`, the broker resolves the corresponding future.

Timeouts are enforced at the caller level (dispatcher uses
`asyncio.wait_for`).
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from seraphine.tools.base import ToolResult

logger = logging.getLogger("seraphine.proxy_broker")


class ProxyBroker:
    def __init__(self) -> None:
        self._pending: dict[str, asyncio.Future[ToolResult]] = {}

    def new_request_id(self) -> str:
        return str(uuid.uuid4())

    def register(self, request_id: str) -> asyncio.Future[ToolResult]:
        loop = asyncio.get_event_loop()
        fut: asyncio.Future[ToolResult] = loop.create_future()
        self._pending[request_id] = fut
        return fut

    def resolve(self, request_id: str, result: ToolResult) -> bool:
        fut = self._pending.pop(request_id, None)
        if fut is None or fut.done():
            return False
        fut.set_result(result)
        return True

    def cancel(self, request_id: str, error: str) -> None:
        fut = self._pending.pop(request_id, None)
        if fut is None or fut.done():
            return
        fut.set_result(ToolResult(ok=False, error=error))

    def clients_for(self, app_state: Any, tool_name: str) -> list[Any]:
        """Clientes que podem atender ``tool_name``, do melhor para o pior.

        Substitui o `pool[0]` de um **set**, cuja ordem de iteração é
        arbitrária: com o Mac e o iPhone conectados ao mesmo tempo, o pedido
        caía em qualquer um dos dois a cada chamada. Para o relé da casa isso
        é a diferença entre funcionar e não funcionar — o aparelho que está
        fora de casa não alcança a LAN.

        Ordem:

        1. quem DECLAROU o handler no `client_hello` (`tools`);
        2. quem é Tauri mas não declarou nada — cliente de uma versão anterior
           ao campo, que provavelmente atende; tentar é melhor que ignorar;
        3. o resto, só se não sobrou ninguém.

        Devolve LISTA, e não um cliente: quem despacha pode tentar o próximo
        quando o primeiro não responde. Um aparelho conectado mas fora de casa
        (ou com o app em segundo plano) não pode condenar o comando quando há
        outro capaz do lado.
        """
        ws_clients = list(getattr(app_state, "ws_clients", None) or [])

        declarou: list[Any] = []
        tauri_mudo: list[Any] = []
        resto: list[Any] = []
        for ws in ws_clients:
            tools = getattr(ws, "_proxy_tools", None)
            if tools and tool_name in tools:
                declarou.append(ws)
            elif getattr(ws, "_is_tauri", False) and not tools:
                tauri_mudo.append(ws)
            elif not getattr(ws, "_is_tauri", False):
                resto.append(ws)
            # Tauri que declarou uma lista SEM esta tool fica de fora: ele já
            # disse que não sabe atender, e mandar assim mesmo só gastaria o
            # timeout para receber "no handler for ...".

        return declarou + tauri_mudo + (resto if not (declarou or tauri_mudo) else [])

    def any_client(self, app_state: Any) -> Any | None:
        """Compat: o primeiro cliente Tauri conectado, ou None.

        Preservada para quem só precisa saber SE há cliente. Quem despacha
        tool deve usar `clients_for`, que filtra por capacidade e devolve
        alternativas.
        """
        ws_clients = getattr(app_state, "ws_clients", None) or set()
        tauri_first = [
            ws for ws in ws_clients if getattr(ws, "_is_tauri", False)
        ]
        pool = tauri_first or list(ws_clients)
        return pool[0] if pool else None
