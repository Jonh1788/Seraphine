"""Failure classification shared by the engines (phase 1b: park instead of fail).

An engine marks a failed turn with one of three reasons (``EngineResult.wait_kind``):
``auth`` (login expired / credential missing), ``outage`` (the provider is down,
overloaded, refused for too many calls, or the connection dropped) and
``plan_limit`` (the plan's usage limit ran out). Everything else stays an ordinary
failure, so the rules here are deliberately conservative: stable signals only
(HTTP status codes and generic phrases such as "overloaded"); no vendor message
that was never seen is matched verbatim.

``Failure.retry_at`` is an ISO 8601 UTC instant when the failure text carries the
moment the plan limit resets (an absolute timestamp with a time zone, an epoch
in a ``resets_at`` style key, or a relative "try again in 2 hours 5 minutes");
wall-clock times without a zone ("at 3:45 PM") are NOT guessed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

OUTAGE = "outage"
PLAN_LIMIT = "plan_limit"
AUTH = "auth"
WAIT_KINDS = (OUTAGE, PLAN_LIMIT, AUTH)


@dataclass(frozen=True)
class Failure:
    kind: str
    retry_at: str | None = None


PLAN_LIMIT_RE = re.compile(
    r"usage[ _]limit|(?:hit|reached) your (?:\w+ ){0,3}limit|limit reached", re.IGNORECASE)

OUTAGE_RE = re.compile(
    r"overloaded|service[ _]unavailable|bad gateway|gateway time-?out|internal server error|"
    r"temporarily unavailable|connection (?:refused|reset|closed|aborted|error)|"
    r"timed out|network is unreachable|"
    r"\b(?:status|http|api error)\W{0,3}5\d\d\b|"
    r"\b5\d\d (?:internal server error|bad gateway|service unavailable|gateway time-?out)",
    re.IGNORECASE)

#: Extra wording that means "too many calls" for API-key providers (``chat``).
RATE_LIMIT_RE = re.compile(r"rate[ _-]?limit|too many requests", re.IGNORECASE)

_UNIT_SECONDS = {"d": 86400, "h": 3600, "m": 60, "s": 1}
_PART_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s)\b", re.IGNORECASE)
_REL_RE = re.compile(
    r"(?:try again|retry|resets?|renews?|available again)\s+(?:in|after)\s+"
    r"((?:\d+(?:\.\d+)?\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s)\b[\s,]*(?:and\s+)?)+)",
    re.IGNORECASE)
_ISO_RE = re.compile(
    r"\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))")
_RESETS_IN_RE = re.compile(r"resets_in_seconds\W{1,4}(\d{1,9})\b", re.IGNORECASE)
_RESETS_AT_RE = re.compile(r"resets_?at\W{1,4}(\d{9,13})\b", re.IGNORECASE)


def iso_utc(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="microseconds")


def epoch_to_iso(value: float) -> str | None:
    """Epoch seconds (or milliseconds) as an ISO UTC instant; None when absurd."""
    try:
        seconds = value / 1000 if value >= 1e12 else value
        return iso_utc(datetime.fromtimestamp(seconds, tz=timezone.utc))
    except (OverflowError, OSError, ValueError):
        return None


def reset_hint(text: str, now: datetime | None = None) -> str | None:
    """The instant a plan limit resets, when ``text`` says so (see module docstring)."""
    if not text:
        return None
    now = now or datetime.now(timezone.utc)
    if m := _RESETS_AT_RE.search(text):
        return epoch_to_iso(float(m.group(1)))
    if m := _RESETS_IN_RE.search(text):
        return iso_utc(now + timedelta(seconds=int(m.group(1))))
    if m := _ISO_RE.search(text):
        try:
            stamp = datetime.fromisoformat(m.group(1).replace("Z", "+00:00"))
        except ValueError:
            stamp = None
        if stamp is not None and stamp.tzinfo is not None:
            return iso_utc(stamp)
    if m := _REL_RE.search(text):
        total = sum(float(n) * _UNIT_SECONDS[u[0].lower()] for n, u in _PART_RE.findall(m.group(1)))
        if total > 0:
            return iso_utc(now + timedelta(seconds=total))
    return None


def classify_text(text: str, now: datetime | None = None) -> Failure | None:
    """Plan limit first (its text may also say "rate"), then outage; else None."""
    if not text:
        return None
    if PLAN_LIMIT_RE.search(text):
        return Failure(PLAN_LIMIT, reset_hint(text, now))
    if OUTAGE_RE.search(text):
        return Failure(OUTAGE)
    return None


def outage_from_status(status: int) -> Failure | None:
    """HTTP 429 and 5xx from an API-key / local provider are outages."""
    if status == 429 or 500 <= status <= 599:
        return Failure(OUTAGE)
    return None


def chat_outage_text(text: str) -> Failure | None:
    """Wording that means outage / too many calls for the ``chat`` runtime."""
    if text and (OUTAGE_RE.search(text) or RATE_LIMIT_RE.search(text)):
        return Failure(OUTAGE)
    return None
