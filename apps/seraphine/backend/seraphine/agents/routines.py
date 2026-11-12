"""Agent routines (phase 6b): the schedule language and the rules around it, as pure functions.

Nothing here touches the database, the clock or the network. Schedule arithmetic works on NAIVE local
datetimes (the wall clock of this PC); ``LocalTime`` is the one place that converts to and from UTC, so a
test can inject a fixed offset (``FixedOffset``) and the ``zoneinfo`` database is never needed.

Two ways in for a routine, like the agent drafts:

* ``validate_routine`` / ``check_schedule`` -- strict, for what the page sends: ``Invalid`` (422) in pt-BR.
* ``normalize_routine`` -- lenient, for text a model wrote (untrusted): never raises, cuts the text to
  the limits, drops unknown schedule fields and returns ``None`` when the routine is not usable.
"""

from __future__ import annotations

import calendar
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from seraphine.agents.errors import Invalid

TITLE_MAX = 120
PROMPT_MAX = 2000
REPORTS = ("news", "always")
DEFAULT_REPORT = "news"
KINDS = ("daily", "weekdays", "weekly", "monthly", "interval", "once")
#: Fields each kind accepts besides ``kind``.
KIND_FIELDS: dict[str, tuple[str, ...]] = {
    "daily": ("time",), "weekdays": ("time",), "weekly": ("time", "days"), "monthly": ("time", "day"),
    "interval": ("every_minutes",), "once": ("at",),
}
DEFAULT_MIN_INTERVAL_MIN = 15
MAX_INTERVAL_MIN = 1440
#: Most routines one agent draft may carry, from the page and kept from a model.
PAGE_ROUTINES_MAX = 3
MODEL_ROUTINES_MAX = 2
#: What a routine run answers when there is nothing new (report ``news``).
NO_NEWS = "SEM_NOVIDADE"
COPY_SUFFIX = " (cópia)"

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_EDGES_RE = re.compile(r"^[\W_]+|[\W_]+$")
DAY_NAMES = ("segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo")
_MASCULINE = (5, 6)  # sábado, domingo
KIND_HELP = ("Tipo de horário desconhecido: use daily, weekdays, weekly, monthly, interval ou once.")


# -- local time -----------------------------------------------------------------------------------


class LocalTime:
    """The PC's local time, without a timezone database: it asks the operating system."""

    def to_local(self, moment: datetime) -> datetime:
        """A UTC (or any aware) instant as a naive local datetime."""
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return moment.astimezone().replace(tzinfo=None)

    def to_utc(self, naive: datetime) -> datetime:
        """A naive local datetime as an aware UTC instant."""
        return naive.astimezone(timezone.utc)


class FixedOffset(LocalTime):
    """A fixed offset from UTC, in hours (tests)."""

    def __init__(self, hours: float) -> None:
        self.tz = timezone(timedelta(hours=hours))

    def to_local(self, moment: datetime) -> datetime:
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return moment.astimezone(self.tz).replace(tzinfo=None)

    def to_utc(self, naive: datetime) -> datetime:
        return naive.replace(tzinfo=self.tz).astimezone(timezone.utc)


SYSTEM_LOCAL = LocalTime()


# -- schedule validation ---------------------------------------------------------------------------


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_time(raw: Any) -> str:
    if not isinstance(raw, str) or not _TIME_RE.match(raw):
        raise Invalid("A hora precisa estar no formato HH:MM, de 00:00 a 23:59.")
    return raw


def _minute(moment: datetime) -> datetime:
    return moment.replace(second=0, microsecond=0)


def check_schedule(raw: Any, *, now_local: datetime | None = None,
                   min_interval: int = DEFAULT_MIN_INTERVAL_MIN, require_future: bool = True,
                   local: LocalTime = SYSTEM_LOCAL) -> dict[str, Any]:
    """The schedule in its stored form, or ``Invalid`` (pt-BR). Any field the kind does not use, and any
    value out of range, is refused. ``once`` must lie in the future unless ``require_future`` is off;
    its ``at`` is stored as naive local ``YYYY-MM-DDTHH:MM`` (an ``at`` with an offset is converted)."""
    if not isinstance(raw, dict):
        raise Invalid("O horário precisa ser um objeto com o tipo de horário (kind).")
    kind = raw.get("kind")
    if kind not in KINDS:
        raise Invalid(KIND_HELP)
    for name in raw:
        if name != "kind" and name not in KIND_FIELDS[kind]:
            raise Invalid(f"O campo «{name}» não vale para o horário «{kind}».")
    out: dict[str, Any] = {"kind": kind}
    if kind in ("daily", "weekdays", "weekly", "monthly"):
        if "time" not in raw:
            raise Invalid("Faltou a hora (time), no formato HH:MM.")
        out["time"] = _check_time(raw["time"])
    if kind == "weekly":
        days = raw.get("days")
        if (not isinstance(days, list) or not 1 <= len(days) <= 7
                or not all(_is_int(d) and 0 <= d <= 6 for d in days)):
            raise Invalid("Escolha de 1 a 7 dias da semana (days), de 0 (segunda) a 6 (domingo).")
        if len(set(days)) != len(days):
            raise Invalid("Os dias da semana não podem se repetir.")
        out["days"] = sorted(days)
    elif kind == "monthly":
        day = raw.get("day")
        if not (day == "last" or (_is_int(day) and 1 <= day <= 28)):
            raise Invalid("O dia do mês (day) vai de 1 a 28, ou «last» para o último dia.")
        out["day"] = day
    elif kind == "interval":
        every = raw.get("every_minutes")
        if not _is_int(every) or not min_interval <= every <= MAX_INTERVAL_MIN:
            raise Invalid(f"O intervalo (every_minutes) vai de {min_interval} a {MAX_INTERVAL_MIN} minutos.")
        out["every_minutes"] = every
    elif kind == "once":
        at = raw.get("at")
        if not isinstance(at, str) or not at.strip():
            raise Invalid("Faltou a data e a hora (at), em formato ISO, como 2026-11-14T10:00.")
        try:
            stamp = datetime.fromisoformat(at.strip().replace("Z", "+00:00"))
        except ValueError:
            raise Invalid("A data e a hora (at) precisam estar em formato ISO, como 2026-11-14T10:00.") from None
        if stamp.tzinfo is not None:
            stamp = local.to_local(stamp)
        stamp = _minute(stamp)
        if require_future and stamp <= _minute(now_local if now_local is not None else local.to_local(
                datetime.now(timezone.utc))):
            raise Invalid("Esse horário já passou. Escolha uma data e hora no futuro.")
        out["at"] = stamp.strftime("%Y-%m-%dT%H:%M")
    return out


def _hm(time_text: str) -> tuple[int, int]:
    return int(time_text[:2]), int(time_text[3:])


# -- phrases ------------------------------------------------------------------------------------------


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " e " + items[-1]


def schedule_text(schedule: dict[str, Any]) -> str:
    """The schedule in a pt-BR phrase: "Todo dia útil às 08:00", "A cada 30 minutos"..."""
    kind = schedule["kind"]
    if kind == "daily":
        return f"Todo dia às {schedule['time']}"
    if kind == "weekdays":
        return f"Todo dia útil às {schedule['time']}"
    if kind == "weekly":
        days = sorted(schedule["days"])
        if len(days) == 7:
            return f"Todo dia às {schedule['time']}"
        if days == [0, 1, 2, 3, 4]:
            return f"Todo dia útil às {schedule['time']}"
        names = [DAY_NAMES[d] for d in days]
        if all(d in _MASCULINE for d in days):
            lead = "Todo "
        elif not any(d in _MASCULINE for d in days):
            lead = "Toda "
        else:  # mixed genders: a bare list reads right with either
            lead = ""
            names[0] = names[0].capitalize()
        return f"{lead}{_join(names)} às {schedule['time']}"
    if kind == "monthly":
        if schedule["day"] == "last":
            return f"Todo último dia do mês às {schedule['time']}"
        return f"Todo dia {schedule['day']} às {schedule['time']}"
    if kind == "interval":
        n = schedule["every_minutes"]
        if n == 60:
            return "A cada hora"
        if n % 60 == 0:
            return f"A cada {n // 60} horas"
        return f"A cada {n} minutos"
    at = datetime.strptime(schedule["at"], "%Y-%m-%dT%H:%M")
    return f"Uma vez, em {at.strftime('%d/%m')} às {at.strftime('%H:%M')}"


# -- occurrences -----------------------------------------------------------------------------------


def _days_from(start: datetime, count: int):
    day = start.date()
    for i in range(count):
        yield day + timedelta(days=i)


def next_occurrence(schedule: dict[str, Any], after: datetime,
                    anchor: datetime | None = None) -> datetime | None:
    """The first time of the schedule STRICTLY after ``after`` (naive local), or ``None`` (a ``once``
    that already passed). ``anchor`` is where an ``interval`` starts counting (creation or last change);
    it defaults to ``after``."""
    kind = schedule["kind"]
    if kind == "once":
        at = datetime.strptime(schedule["at"], "%Y-%m-%dT%H:%M")
        return at if at > after else None
    if kind == "interval":
        step = timedelta(minutes=schedule["every_minutes"])
        base = anchor if anchor is not None else after
        gap = after - base
        n = 1 if gap < timedelta(0) else gap // step + 1
        return base + n * step
    hour, minute = _hm(schedule["time"])
    if kind == "monthly":
        year, month = after.year, after.month
        for _ in range(14):
            day = calendar.monthrange(year, month)[1] if schedule["day"] == "last" else schedule["day"]
            candidate = datetime(year, month, day, hour, minute)
            if candidate > after:
                return candidate
            month += 1
            if month == 13:
                year, month = year + 1, 1
        return None
    if kind == "daily":
        allowed = set(range(7))
    elif kind == "weekdays":
        allowed = {0, 1, 2, 3, 4}
    else:
        allowed = set(schedule["days"])
    for day in _days_from(after, 9):
        candidate = datetime(day.year, day.month, day.day, hour, minute)
        if candidate > after and day.weekday() in allowed:
            return candidate
    return None


def upcoming(schedule: dict[str, Any], after: datetime, anchor: datetime | None = None,
             count: int = 3) -> list[datetime]:
    """The next ``count`` times after ``after`` (fewer for a ``once``)."""
    out: list[datetime] = []
    cursor = after
    while len(out) < count:
        nxt = next_occurrence(schedule, cursor, anchor)
        if nxt is None:
            break
        out.append(nxt)
        cursor = nxt
    return out


# -- "nothing new" ----------------------------------------------------------------------------------


def is_no_news(text: Any) -> bool:
    """Is the whole answer ``SEM_NOVIDADE``? Case, spaces and punctuation at the ends do not matter."""
    cleaned = _EDGES_RE.sub("", str(text or "")).strip()
    return cleaned.casefold() == NO_NEWS.casefold()


# -- routines: strict (page) and lenient (model) ----------------------------------------------------------


def validate_routine(raw: dict[str, Any], *, now_local: datetime | None = None,
                     min_interval: int = DEFAULT_MIN_INTERVAL_MIN, local: LocalTime = SYSTEM_LOCAL,
                     require_future: bool = True) -> dict[str, Any]:
    """``{"title", "prompt", "schedule", "report"}`` checked strictly (``Invalid`` in pt-BR)."""
    title = str(raw.get("title") or "").strip()
    if not title:
        raise Invalid("O título da rotina é obrigatório.")
    if len(title) > TITLE_MAX:
        raise Invalid(f"O título da rotina pode ter até {TITLE_MAX} caracteres.")
    prompt = str(raw.get("prompt") or "").strip()
    if not prompt:
        raise Invalid("O pedido da rotina é obrigatório.")
    if len(prompt) > PROMPT_MAX:
        raise Invalid(f"O pedido da rotina pode ter até {PROMPT_MAX} caracteres.")
    report = raw.get("report") or DEFAULT_REPORT
    if report not in REPORTS:
        raise Invalid("O relato precisa ser «news» (só com novidade) ou «always» (sempre).")
    schedule = check_schedule(raw.get("schedule"), now_local=now_local, min_interval=min_interval,
                              local=local, require_future=require_future)
    return {"title": title, "prompt": prompt, "schedule": schedule, "report": report}


def _clip(value: Any, limit: int) -> str:
    return str(value if value is not None else "").strip()[:limit].strip()


def _known_fields(raw: Any) -> Any:
    """A model's schedule without the fields its kind does not use (they would only be ignored)."""
    if isinstance(raw, dict) and raw.get("kind") in KIND_FIELDS:
        keep = {"kind", *KIND_FIELDS[raw["kind"]]}
        return {k: v for k, v in raw.items() if k in keep}
    return raw


def normalize_routine(raw: Any, *, now_local: datetime | None = None,
                      min_interval: int = DEFAULT_MIN_INTERVAL_MIN,
                      local: LocalTime = SYSTEM_LOCAL) -> dict[str, Any] | None:
    """A routine from untrusted data (the model's JSON): text cut to the limits, unknown schedule fields
    dropped, ``report`` defaulting to ``news``; ``None`` when the title, the request or the schedule is
    not usable. Returns the draft shape, with ``schedule_text``."""
    if not isinstance(raw, dict):
        return None
    report = raw.get("report")
    try:
        out = validate_routine(
            {"title": _clip(raw.get("title"), TITLE_MAX), "prompt": _clip(raw.get("prompt"), PROMPT_MAX),
             "schedule": _known_fields(raw.get("schedule")),
             "report": report if report in REPORTS else DEFAULT_REPORT},
            now_local=now_local, min_interval=min_interval, local=local)
    except Invalid:
        return None
    out["schedule_text"] = schedule_text(out["schedule"])
    return out


def normalize_routines(raw: Any, *, now_local: datetime | None = None,
                       min_interval: int = DEFAULT_MIN_INTERVAL_MIN, local: LocalTime = SYSTEM_LOCAL,
                       limit: int = MODEL_ROUTINES_MAX) -> list[dict[str, Any]]:
    """The routines of a model's draft: invalid ones dropped, at most ``limit`` kept."""
    out: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        routine = normalize_routine(item, now_local=now_local, min_interval=min_interval, local=local)
        if routine is not None:
            out.append(routine)
            if len(out) == limit:
                break
    return out


def draft_routine(title: str, prompt: str, schedule: dict[str, Any], report: str = DEFAULT_REPORT
                  ) -> dict[str, Any]:
    """A routine as ready-made teams carry it: the draft shape with its phrase."""
    return {"title": title, "prompt": prompt, "schedule": schedule,
            "schedule_text": schedule_text(schedule), "report": report}
