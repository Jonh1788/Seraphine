"""FastAPI router for the unified WhatsApp Manager UI.

Aggregates the Seraphine and Aura whatsapp-web.js bridges behind a
single ``/wa-manager/*`` surface that the SPA at
``sera.jonhdev.io/wa`` consumes. Bridges are reached over the shared
docker network (Aura's bridge joins ``seraphine-net`` as a secondary).

Endpoints:
- GET  /wa-manager/bridges                 list bridges + status
- GET  /wa-manager/{bridge}/qr             current QR (data url) when pending
- GET  /wa-manager/{bridge}/recent         last N inbound/outbound messages
- POST /wa-manager/{bridge}/logout?wipe=   end session (?wipe=true clears auth)

Bridges are addressed by short slug — ``seraphine`` or ``aura``. Empty
bridge URLs in settings hide the corresponding card. No auth on top
of Seraphine's normal deploy gating (single-user, behind its own
domain).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/wa-manager", tags=["wa-manager"])

DEFAULT_TIMEOUT = 10.0


@dataclass(frozen=True)
class BridgeRef:
    slug: str
    label: str
    base_url: str


def _bridges(request: Request) -> list[BridgeRef]:
    s = request.app.state.settings
    refs: list[BridgeRef] = []
    if getattr(s, "whatsapp_bridge_url", ""):
        refs.append(BridgeRef("seraphine", "Seraphine", s.whatsapp_bridge_url))
    if getattr(s, "whatsapp_aura_bridge_url", ""):
        refs.append(BridgeRef("aura", "Aura", s.whatsapp_aura_bridge_url))
    return refs


def _resolve(request: Request, slug: str) -> BridgeRef:
    for ref in _bridges(request):
        if ref.slug == slug:
            return ref
    raise HTTPException(status_code=404, detail=f"unknown bridge: {slug}")


async def _get(url: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.json()


async def _post(url: str, *, params: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        resp = await client.post(url, params=params)
        resp.raise_for_status()
        return resp.json()


@router.get("/bridges")
async def list_bridges(request: Request) -> dict[str, Any]:
    """Status snapshot for every configured bridge.

    Returns ``{bridges: [{slug, label, status, phone, name, uptime_s,
    error}, ...]}``. ``error`` is filled when the bridge is unreachable
    so the UI can render a degraded card instead of the whole page
    erroring.
    """
    out: list[dict[str, Any]] = []
    for ref in _bridges(request):
        entry: dict[str, Any] = {
            "slug": ref.slug,
            "label": ref.label,
            "base_url": ref.base_url,
            "status": "unreachable",
            "phone": None,
            "name": None,
            "uptime_s": 0,
            "error": None,
        }
        try:
            data = await _get(f"{ref.base_url}/api/status")
            entry["status"] = data.get("status") or "unknown"
            entry["phone"] = data.get("phone")
            entry["name"] = data.get("name")
            entry["uptime_s"] = data.get("uptime_s") or 0
        except Exception as e:
            entry["error"] = str(e)[:200]
        out.append(entry)
    return {"bridges": out}


@router.get("/{slug}/qr")
async def get_qr(slug: str, request: Request) -> dict[str, Any]:
    ref = _resolve(request, slug)
    try:
        data = await _get(f"{ref.base_url}/api/qr")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"bridge unreachable: {e}")
    # bridge shape: {qr: <data:image/png;base64,...>|null, expires_in_s, message?}
    return {
        "qr": data.get("qr"),
        "expires_in_s": data.get("expires_in_s"),
        "message": data.get("message"),
    }


@router.get("/{slug}/recent")
async def get_recent(
    slug: str, request: Request, limit: int = 20,
) -> dict[str, Any]:
    ref = _resolve(request, slug)
    try:
        data = await _get(f"{ref.base_url}/api/recent?limit={limit}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"bridge unreachable: {e}")
    return {"messages": data.get("messages") or []}


@router.post("/{slug}/logout")
async def logout(
    slug: str, request: Request, wipe: bool = False,
) -> dict[str, Any]:
    ref = _resolve(request, slug)
    try:
        data = await _post(
            f"{ref.base_url}/api/logout",
            params={"wipe": "true"} if wipe else None,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"bridge unreachable: {e}")
    return data
