"""Best-effort WebSocket fan-out for cv_triage progress frames.

The worker calls `broadcast_frame(clients, frame)` to push a dict to every
connected client. Errors on individual clients are logged and swallowed —
a dead connection should never break the worker loop.
"""

import logging
from typing import Iterable, Any

logger = logging.getLogger(__name__)


async def broadcast_frame(clients: Iterable[Any], frame: dict) -> None:
    for ws in list(clients):
        try:
            await ws.send_json(frame)
        except Exception as e:
            logger.warning("ws broadcast failed: %s", e)
