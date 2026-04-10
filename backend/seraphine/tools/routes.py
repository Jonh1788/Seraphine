"""Route planning tool via OpenStreetMap + OSRM.

Uses free public APIs — no API key needed:
- Nominatim (OpenStreetMap) for geocoding addresses → coordinates
- OSRM (Open Source Routing Machine) for route calculation

Provides distance, duration, and turn-by-turn directions.
Supports driving, walking, and cycling profiles.
"""

from __future__ import annotations

import ssl
from typing import Any

import httpx
import truststore

from seraphine.tools.base import Tool, ToolResult

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OSRM_URL = "https://router.project-osrm.org/route/v1"
USER_AGENT = "SeraphineAssistant/0.1"
DEFAULT_TIMEOUT = 30.0


class RoutePlannerTool(Tool):
    name = "route_planner"
    description = (
        "Plan a route between two locations. Returns distance, estimated "
        "travel time, and turn-by-turn directions. Supports driving, "
        "walking, and cycling. Use addresses, city names, or landmarks "
        "as origin/destination. Examples: 'São Paulo to Rio de Janeiro', "
        "'Rua Augusta 100, SP to Aeroporto de Guarulhos'. "
        "IMPORTANT: This tool may take a few seconds. Before calling it, "
        "always tell the user you're calculating the route so they know "
        "you're working on it."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "origin": {
                "type": "string",
                "description": "Starting point (address, city, or landmark).",
            },
            "destination": {
                "type": "string",
                "description": "End point (address, city, or landmark).",
            },
            "mode": {
                "type": "string",
                "enum": ["driving", "walking", "cycling"],
                "description": "Travel mode (default: driving).",
            },
        },
        "required": ["origin", "destination"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.timeout = timeout

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        origin = str(args.get("origin", "")).strip()
        destination = str(args.get("destination", "")).strip()
        mode = str(args.get("mode", "driving")).strip().lower()

        if not origin:
            return ToolResult(ok=False, error="origin is required")
        if not destination:
            return ToolResult(ok=False, error="destination is required")
        if mode not in ("driving", "walking", "cycling"):
            mode = "driving"

        osrm_profile = {"driving": "driving", "walking": "foot", "cycling": "bike"}[mode]
        mode_label = {"driving": "Dirigindo", "walking": "A pé", "cycling": "Bicicleta"}[mode]

        ssl_ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}

        async with httpx.AsyncClient(
            timeout=self.timeout,
            follow_redirects=True,
            headers=headers,
            verify=ssl_ctx,
        ) as client:
            # Geocode origin
            origin_coords = await _geocode(client, origin)
            if origin_coords is None:
                return ToolResult(
                    ok=False,
                    error=f"Could not geocode origin: '{origin}'. Try a more specific address.",
                )

            # Geocode destination
            dest_coords = await _geocode(client, destination)
            if dest_coords is None:
                return ToolResult(
                    ok=False,
                    error=f"Could not geocode destination: '{destination}'. Try a more specific address.",
                )

            # Get route from OSRM
            route = await _get_route(
                client, origin_coords, dest_coords, osrm_profile
            )
            if route is None:
                return ToolResult(
                    ok=False,
                    error="Could not calculate route between the two locations.",
                )

        distance_km = route["distance"] / 1000
        duration_min = route["duration"] / 60
        duration_h = int(duration_min // 60)
        duration_m = int(duration_min % 60)

        if duration_h > 0:
            time_str = f"{duration_h}h{duration_m:02d}min"
        else:
            time_str = f"{duration_m}min"

        is_estimate = route.get("estimated", False)
        lines = [
            f"Rota: {origin} → {destination}",
            f"Modo: {mode_label}",
            f"Distância: {distance_km:.1f} km" + (" (estimativa)" if is_estimate else ""),
            f"Tempo estimado: {time_str}" + (" (aproximado)" if is_estimate else ""),
            "",
        ]
        if is_estimate:
            lines.append("⚠ Serviço de rotas indisponível. Distância e tempo são estimativas baseadas em linha reta.")
            lines.append("")

        # Turn-by-turn directions
        steps = route.get("steps", [])
        if steps:
            lines.append("Direções:")
            for i, step in enumerate(steps, 1):
                dist = step.get("distance", 0)
                name = step.get("name", "")
                maneuver = step.get("maneuver", "")
                modifier = step.get("modifier", "")
                instruction = _format_instruction(maneuver, name, modifier)
                if dist >= 1000:
                    dist_str = f"{dist / 1000:.1f} km"
                else:
                    dist_str = f"{int(dist)} m"
                lines.append(f"  {i}. {instruction} ({dist_str})")

        return ToolResult(
            ok=True,
            output="\n".join(lines),
            metadata={
                "origin": origin,
                "origin_coords": origin_coords,
                "destination": destination,
                "dest_coords": dest_coords,
                "distance_km": round(distance_km, 1),
                "duration_min": round(duration_min, 1),
                "mode": mode,
                "steps": len(steps),
            },
        )


async def _geocode(
    client: httpx.AsyncClient, query: str
) -> tuple[float, float] | None:
    """Geocode a text query to (lon, lat) via Nominatim."""
    try:
        resp = await client.get(
            NOMINATIM_URL,
            params={
                "q": query,
                "format": "json",
                "limit": 1,
                "addressdetails": 0,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        if not data:
            return None
        return (float(data[0]["lon"]), float(data[0]["lat"]))
    except Exception:
        return None


async def _get_route(
    client: httpx.AsyncClient,
    origin: tuple[float, float],
    dest: tuple[float, float],
    profile: str,
) -> dict[str, Any] | None:
    """Try OSRM first; fall back to Haversine estimate if OSRM is down."""
    route = await _get_route_osrm(client, origin, dest, profile)
    if route is not None:
        return route
    # Fallback: straight-line distance with estimated road factor
    return _haversine_estimate(origin, dest, profile)


async def _get_route_osrm(
    client: httpx.AsyncClient,
    origin: tuple[float, float],
    dest: tuple[float, float],
    profile: str,
) -> dict[str, Any] | None:
    """Get route from OSRM public API."""
    coords = f"{origin[0]},{origin[1]};{dest[0]},{dest[1]}"
    url = f"{OSRM_URL}/{profile}/{coords}"
    try:
        resp = await client.get(
            url,
            params={
                "overview": "false",
                "steps": "true",
                "geometries": "polyline",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != "Ok":
            return None
        routes = data.get("routes", [])
        if not routes:
            return None
        route = routes[0]
        legs = route.get("legs", [])
        steps = []
        for leg in legs:
            for step in leg.get("steps", []):
                maneuver = step.get("maneuver", {})
                steps.append({
                    "distance": step.get("distance", 0),
                    "duration": step.get("duration", 0),
                    "name": step.get("name", ""),
                    "maneuver": maneuver.get("type", ""),
                    "modifier": maneuver.get("modifier", ""),
                })
        return {
            "distance": route.get("distance", 0),
            "duration": route.get("duration", 0),
            "steps": steps,
        }
    except Exception:
        return None


def _haversine_estimate(
    origin: tuple[float, float],
    dest: tuple[float, float],
    profile: str,
) -> dict[str, Any]:
    """Straight-line distance with road factor estimate when OSRM is unavailable."""
    import math

    lon1, lat1 = math.radians(origin[0]), math.radians(origin[1])
    lon2, lat2 = math.radians(dest[0]), math.radians(dest[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    c = 2 * math.asin(math.sqrt(a))
    r = 6371000  # Earth radius in meters
    straight_line = r * c

    # Road factor: roads are ~1.3-1.4x longer than straight line
    road_factor = {"driving": 1.35, "walking": 1.25, "cycling": 1.3}[profile]
    distance = straight_line * road_factor

    # Average speed estimates
    avg_speed = {"driving": 60, "walking": 5, "cycling": 15}[profile]  # km/h
    duration = (distance / 1000) / avg_speed * 3600  # seconds

    return {
        "distance": distance,
        "duration": duration,
        "steps": [],
        "estimated": True,
    }


_MANEUVER_PT: dict[str, str] = {
    "depart": "Siga em frente",
    "arrive": "Chegou ao destino",
    "turn": "Vire",
    "merge": "Entre na via",
    "on ramp": "Pegue a rampa de acesso",
    "off ramp": "Saia pela rampa",
    "fork": "Mantenha-se",
    "end of road": "No fim da rua",
    "continue": "Continue",
    "roundabout": "Na rotatória",
    "rotary": "Na rotatória",
    "roundabout turn": "Na rotatória, vire",
    "new name": "Continue",
    "notification": "",
}

_MODIFIER_PT: dict[str, str] = {
    "left": "à esquerda",
    "right": "à direita",
    "sharp left": "acentuadamente à esquerda",
    "sharp right": "acentuadamente à direita",
    "slight left": "levemente à esquerda",
    "slight right": "levemente à direita",
    "straight": "em frente",
    "uturn": "retorno (meia-volta)",
}


def _format_instruction(maneuver: str, name: str, modifier: str = "") -> str:
    action = _MANEUVER_PT.get(maneuver, maneuver.replace("_", " ").capitalize())
    direction = _MODIFIER_PT.get(modifier, "")
    road = f" na {name}" if name else ""
    if direction:
        return f"{action} {direction}{road}"
    return f"{action}{road}" if action else name or "Continue"
