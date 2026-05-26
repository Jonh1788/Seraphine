"""095 — Contextual shortcuts per active macOS app: data types."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ContextualAction:
    id: str
    label: str
    description: str
    tool_name: str
    tool_args: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "tool_name": self.tool_name,
            "tool_args": self.tool_args,
        }


@dataclass
class AppActions:
    """Maps a regex pattern to a list of contextual actions."""

    app_pattern: str  # regex string matched against app name
    actions: list[ContextualAction] = field(default_factory=list)
