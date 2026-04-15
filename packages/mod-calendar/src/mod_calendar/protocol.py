"""Provider-agnostic calendar protocol + types.

The Protocol describes the surface that any concrete calendar backend
(Google, CalDAV, in-house) must support. Today only the Google client
in ``google_integration`` implements it, but Aura may later add an
in-house calendar that stores events directly in core-db.

Types mirror Google's RFC3339 / structured-time shape so the existing
client implementation already conforms without changes.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class CalendarProvider(Protocol):
    """Async calendar backend surface.

    Implementations: ``google_integration.client.GoogleClient`` (today),
    a future ``MyCalendar`` in mod-calendar/local.py (Aura), CalDAV, etc.
    """

    async def list_calendars(self) -> list[dict[str, Any]]:
        ...

    async def list_events(
        self,
        *,
        time_min: datetime,
        time_max: datetime | None = None,
        q: str | None = None,
        max_results: int = 50,
        calendar_id: str = "primary",
    ) -> list[dict[str, Any]]:
        ...

    async def create_event(
        self,
        *,
        summary: str,
        start: datetime,
        end: datetime,
        description: str | None = None,
        location: str | None = None,
        attendees: list[str] | None = None,
        calendar_id: str = "primary",
    ) -> dict[str, Any]:
        ...

    async def update_event(
        self, event_id: str, *, calendar_id: str = "primary", **fields: Any,
    ) -> dict[str, Any]:
        ...

    async def delete_event(
        self, event_id: str, *, calendar_id: str = "primary",
    ) -> None:
        ...
