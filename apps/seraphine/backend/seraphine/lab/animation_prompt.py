"""Build the system-prompt block advertising playable avatar animations.

Seraphine triggers an animation by emitting ``[anim:<tag>]`` in her reply
text (parsed client-side). This block tells her which tags exist.
"""
from __future__ import annotations

from seraphine.lab.routes import _read_animations

# Tags for the built-in animations that ship in the frontend
# (apps/seraphine/frontend/src/avatar/animations.ts). Keep in sync when a
# built-in animation is added — this is the one backend source of truth.
BUILTIN_ANIMATION_TAGS: list[tuple[str, str]] = [
    ("acenar", "cumprimentar ou se despedir"),
]


def build_animation_prompt_block() -> str | None:
    """Return a compact prompt block listing available [anim:TAG]s, or None."""
    pairs: list[tuple[str, str]] = list(BUILTIN_ANIMATION_TAGS)
    for rec in _read_animations():
        label = str(rec.get("label", "")).strip()
        for tag in rec.get("tags", []) or []:
            pairs.append((str(tag), label))

    seen: dict[str, str] = {}
    for tag, desc in pairs:
        if tag and tag not in seen:
            seen[tag] = desc

    if not seen:
        return None

    lines = "\n".join(f"- {tag} — {desc}" if desc else f"- {tag}" for tag, desc in seen.items())
    return (
        "\n\nANIMAÇÕES (toque emitindo [anim:TAG] no meio da fala, com "
        "moderação e naturalidade):\n"
        f"{lines}\n"
        "(Se não houver tag adequada, não use nenhuma — não invente tags.)"
    )
