"""026-B — Temporal humanize.

Turns an absolute datetime into a natural Portuguese phrase like
"ontem", "há 3 dias", "semana passada". Used when stored items
(open loops, decisions, mentions, narratives) surface in the prompt
or UI so the model/user reads them in relative time.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Sao_Paulo")


def humanize(dt: datetime | str, ref: datetime | None = None) -> str:
    """Return a PT-BR relative-time string for *dt*. Accepts ISO string
    or datetime. Treats naive datetimes as UTC (common from SQLite)."""
    if isinstance(dt, str):
        try:
            dt = datetime.fromisoformat(dt.replace("Z", "+00:00"))
        except ValueError:
            return "há um tempo"
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    ref = ref or datetime.now(TZ)
    if ref.tzinfo is None:
        ref = ref.replace(tzinfo=TZ)

    delta = ref - dt.astimezone(TZ)
    total_min = int(delta.total_seconds() // 60)

    if total_min < 0:
        return "em breve"
    if total_min < 2:
        return "agorinha"
    if total_min < 60:
        return f"há {total_min}min"

    hours = total_min // 60
    if hours < 6:
        return f"há {hours}h"

    ref_local = ref.astimezone(TZ)
    dt_local = dt.astimezone(TZ)

    if hours < 18 and dt_local.date() == ref_local.date():
        return "hoje mais cedo"
    yesterday = (ref_local - timedelta(days=1)).date()
    if dt_local.date() == yesterday:
        return "ontem"
    days = delta.days
    if days < 7:
        return f"há {days} dias"
    if days < 14:
        return "semana passada"
    if days < 60:
        weeks = days // 7
        return f"há {weeks} semanas"
    if days < 365:
        months = days // 30
        return f"há {months} meses"
    years = days // 365
    return f"há {years} anos"
