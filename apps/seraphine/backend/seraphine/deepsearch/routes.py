"""Deep Research (deepsearch) HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from seraphine.deepsearch.service import DeepSearchService

router = APIRouter(prefix="/deepsearch", tags=["deepsearch"])
logger = logging.getLogger(__name__)


def _service_or_503(request: Request) -> DeepSearchService:
    svc: Optional[DeepSearchService] = getattr(
        request.app.state, "deepsearch_service", None,
    )
    if svc is None:
        raise HTTPException(
            status_code=503, detail="deepsearch service not configured",
        )
    return svc


@router.get("/config")
async def get_config(request: Request) -> dict[str, Any]:
    return await _service_or_503(request).get_config()
