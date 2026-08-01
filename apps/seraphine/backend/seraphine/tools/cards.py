"""Escaping helpers shared by every tool that builds an HTML card.

A tool that returns ``metadata["html_card"]`` is writing into a sink that
renders raw HTML: the desktop chat feeds the card through ``rehype-raw``
with no sanitizer, and the phone runs a whitelist sanitizer that is a
second line of defence, not the first. Anything interpolated into that
string is markup unless it is escaped here.

Two contexts, two helpers. ``text`` covers text nodes and quoted
attribute values. ``css_color`` covers the one place a card puts data
inside ``style="..."`` -- escaping is not enough there, because a CSS
value stays a CSS value even after ``<`` and ``"`` are neutered, so the
value is whitelisted against a literal hex colour instead.
"""

from __future__ import annotations

import re
from html import escape as _html_escape
from typing import Any

# Card default (matches HabitService's own default colour).
DEFAULT_CARD_COLOR = "#22d3ee"

# `fullmatch`, not `match`: `re.match(r"...$", "#22d3ee\n")` succeeds
# because `$` also matches before a trailing newline. That is the exact
# hole in HabitService._validate_color, so this one must not copy it.
_HEX_COLOR_RE = re.compile(r"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")


def text(value: Any) -> str:
    """Escape ``value`` for a text node or a quoted attribute value."""
    return _html_escape(str(value), quote=True)


def css_color(value: Any, fallback: str = DEFAULT_CARD_COLOR) -> str:
    """Return ``value`` when it is a literal hex colour, else ``fallback``.

    Whitelist rather than escape: inside ``style="color:{...}"`` an
    attacker needs no angle bracket and no quote to do damage -- a bare
    ``;position:fixed;top:0;width:100vw;height:100vh`` is already a
    full-page overlay, and ``;background:url(...)`` is already an
    outbound request. Only values that cannot carry a second CSS
    declaration are allowed through.
    """
    candidate = str(value)
    if _HEX_COLOR_RE.fullmatch(candidate):
        return candidate
    return fallback
