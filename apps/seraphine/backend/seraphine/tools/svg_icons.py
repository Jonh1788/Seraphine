"""Inline SVG icons for rich HTML cards.

Lucide-style: 24px viewBox, 2px stroke, currentColor.
Matches the frontend Icons.tsx design system — no emojis.
"""

_ATTRS = (
    'xmlns="http://www.w3.org/2000/svg" width="16" height="16" '
    'viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
)


def _svg(inner: str) -> str:
    return f"<svg {_ATTRS}>{inner}</svg>"


# ── Finance ──────────────────────────────────────────────────────────────

WALLET = _svg(
    '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/>'
    '<path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/>'
    '<path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>'
)

TRENDING_UP = _svg(
    '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>'
    '<polyline points="16 7 22 7 22 13"/>'
)

TRENDING_DOWN = _svg(
    '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/>'
    '<polyline points="16 17 22 17 22 11"/>'
)

RECEIPT = _svg(
    '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/>'
    '<path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/>'
    '<path d="M12 17.5v-11"/>'
)

# Category icons
UTENSILS = _svg(
    '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/>'
    '<path d="M7 2v20"/>'
    '<path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/>'
)

CAR = _svg(
    '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/>'
    '<circle cx="7" cy="17" r="2"/>'
    '<path d="M9 17h6"/>'
    '<circle cx="17" cy="17" r="2"/>'
)

HOME = _svg(
    '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
    '<polyline points="9 22 9 12 15 12 15 22"/>'
)

HEART_PULSE = _svg(
    '<path d="M19.5 12.572l-7.5 7.428l-7.5-7.428A5 5 0 0 1 12 6.006a5 5 0 0 1 7.5 6.572"/>'
    '<path d="M12 6L12 12"/>'
)

GAMEPAD = _svg(
    '<line x1="6" x2="10" y1="12" y2="12"/>'
    '<line x1="8" x2="8" y1="10" y2="14"/>'
    '<line x1="15" x2="15.01" y1="13" y2="13"/>'
    '<line x1="18" x2="18.01" y1="11" y2="11"/>'
    '<rect width="20" height="12" x="2" y="6" rx="2"/>'
)

BOOK_OPEN = _svg(
    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>'
    '<path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'
)

BRIEFCASE = _svg(
    '<rect width="20" height="14" x="2" y="7" rx="2" ry="2"/>'
    '<path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>'
)

LAPTOP = _svg(
    '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>'
)

CHART_LINE = _svg(
    '<path d="M3 3v18h18"/>'
    '<path d="m19 9-5 5-4-4-3 3"/>'
)

SHOPPING_CART = _svg(
    '<circle cx="8" cy="21" r="1"/>'
    '<circle cx="19" cy="21" r="1"/>'
    '<path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>'
)

SETTINGS = _svg(
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>'
    '<circle cx="12" cy="12" r="3"/>'
)

PIN = _svg(
    '<line x1="12" x2="12" y1="17" y2="22"/>'
    '<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>'
)

# ── Weather ──────────────────────────────────────────────────────────────

SUN = _svg(
    '<circle cx="12" cy="12" r="4"/>'
    '<path d="M12 2v2"/><path d="M12 20v2"/>'
    '<path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>'
    '<path d="M2 12h2"/><path d="M20 12h2"/>'
    '<path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>'
)

CLOUD = _svg(
    '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>'
)

CLOUD_RAIN = _svg(
    '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>'
    '<path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/>'
)

WIND = _svg(
    '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/>'
    '<path d="M9.6 4.6A2 2 0 1 1 11 8H2"/>'
    '<path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>'
)

DROPLETS = _svg(
    '<path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z"/>'
    '<path d="M12.56 14.1c1.44 0 2.6-1.19 2.6-2.64 0-.76-.37-1.47-1.11-2.08S12.73 7.89 12.56 7c-.19.95-.74 1.85-1.49 2.44s-1.07 1.36-1.07 2.13c0 1.45 1.17 2.64 2.6 2.64z"/>'
)

THERMOMETER = _svg(
    '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>'
)

SUNRISE = _svg(
    '<path d="M12 2v8"/>'
    '<path d="m4.93 10.93 1.41 1.41"/>'
    '<path d="M2 18h2"/><path d="M20 18h2"/>'
    '<path d="m19.07 10.93-1.41 1.41"/>'
    '<path d="M22 22H2"/>'
    '<path d="m8 6 4-4 4 4"/>'
    '<path d="M16 18a4 4 0 0 0-8 0"/>'
)

SUNSET = _svg(
    '<path d="M12 10V2"/>'
    '<path d="m4.93 10.93 1.41 1.41"/>'
    '<path d="M2 18h2"/><path d="M20 18h2"/>'
    '<path d="m19.07 10.93-1.41 1.41"/>'
    '<path d="M22 22H2"/>'
    '<path d="m16 6-4 4-4-4"/>'
    '<path d="M16 18a4 4 0 0 0-8 0"/>'
)

UMBRELLA = _svg(
    '<path d="M22 12a10.06 10.06 0 0 0-20 0Z"/>'
    '<path d="M12 12v8a2 2 0 0 0 4 0"/>'
    '<path d="M12 2v2"/>'
)

CLOCK = _svg(
    '<circle cx="12" cy="12" r="10"/>'
    '<polyline points="12 6 12 12 16 14"/>'
)

CALENDAR_DAYS = _svg(
    '<rect width="18" height="18" x="3" y="4" rx="2" ry="2"/>'
    '<line x1="16" x2="16" y1="2" y2="6"/>'
    '<line x1="8" x2="8" y1="2" y2="6"/>'
    '<line x1="3" x2="21" y1="10" y2="10"/>'
    '<path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/>'
    '<path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/>'
)

# ── Tasks / Recurring ───────────────────────────────────────────────────

REPEAT = _svg(
    '<polyline points="17 1 21 5 17 9"/>'
    '<path d="M3 11V9a4 4 0 0 1 4-4h14"/>'
    '<polyline points="7 23 3 19 7 15"/>'
    '<path d="M21 13v2a4 4 0 0 1-4 4H3"/>'
)

CHECK_CIRCLE = _svg(
    '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>'
    '<polyline points="22 4 12 14.01 9 11.01"/>'
)

CLIPBOARD = _svg(
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'
    '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>'
)

CIRCLE = _svg(
    '<circle cx="12" cy="12" r="10"/>'
)

ALERT_TRIANGLE = _svg(
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>'
    '<line x1="12" x2="12" y1="9" y2="13"/>'
    '<line x1="12" x2="12.01" y1="17" y2="17"/>'
)

# ── Mappings ─────────────────────────────────────────────────────────────

CATEGORY_ICONS: dict[str, str] = {
    "alimentacao": UTENSILS,
    "transporte": CAR,
    "moradia": HOME,
    "saude": HEART_PULSE,
    "lazer": GAMEPAD,
    "educacao": BOOK_OPEN,
    "salario": BRIEFCASE,
    "freelance": LAPTOP,
    "investimento": CHART_LINE,
    "compras": SHOPPING_CART,
    "servicos": SETTINGS,
    "outros": PIN,
}
