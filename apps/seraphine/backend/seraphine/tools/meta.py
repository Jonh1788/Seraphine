"""Meta-tools: tools that operate on Seraphine itself rather than the
outside world.

Right now the only one is `RequestSkillTool`, which lets the LLM log a
capability gap when the user asks for something that can't be done with
the existing tool registry. Instead of refusing or hallucinating, the
assistant files a structured markdown request under `skills/` for the
developer (or a future meta-agent) to pick up and implement.

Each skill is its own file `skills/<slug>.md`, never a single shared
task list — that way we get natural dedup by slug, append-only trigger
history, and easy `ls skills/` / `grep` over the backlog.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from seraphine.tools.base import Tool, ToolResult

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_MAX_SLUG_LEN = 48


def _slug(name: str) -> str:
    s = _SLUG_RE.sub("_", name.strip().lower()).strip("_")
    if not s:
        return "unnamed"
    if len(s) > _MAX_SLUG_LEN:
        s = s[:_MAX_SLUG_LEN].rstrip("_")
    return s


def _render_new_skill_md(
    *,
    slug: str,
    name: str,
    capability: str,
    user_intent: str,
    suggested_approach: str,
    created_at: str,
) -> str:
    lines = [
        f"# Skill: {name}",
        "",
        f"- **Slug**: `{slug}`",
        "- **Status**: pending",
        f"- **Created at**: {created_at}",
        "",
        "## Capability",
        "",
        capability,
        "",
    ]
    if suggested_approach:
        lines += ["## Suggested approach", "", suggested_approach, ""]
    lines += [
        "## Triggers",
        "",
        f"- `{created_at}` — {user_intent}",
        "",
    ]
    return "\n".join(lines)


class RequestSkillTool(Tool):
    """Log a request for a capability the assistant currently lacks.

    This tool ALWAYS succeeds on well-formed input. It is deliberately
    non-destructive (only writes a local markdown file under the
    configured skills directory) so `requires_confirmation` is False —
    the gate is reserved for operations that touch the user's system.
    """

    name = "request_skill"
    description = (
        "Log a request for a new capability that Seraphine currently lacks. "
        "Call this WHENEVER the user asks for something you cannot do with "
        "your existing tools (e.g. access the internet, send email, query "
        "a calendar, control hardware) INSTEAD OF refusing or inventing a "
        "capability. After calling this tool, tell the user that you have "
        "logged a skill request and that the capability will be available "
        "once a developer implements it."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": (
                    "Short identifier for the skill in snake_case, e.g. "
                    "'web_access', 'send_sms', 'read_pdf'. Used as the "
                    "filename under skills/."
                ),
            },
            "capability": {
                "type": "string",
                "description": (
                    "One clear sentence describing what the skill should "
                    "do. e.g. 'Fetch arbitrary HTTP URLs and return the "
                    "response body as text'."
                ),
            },
            "user_intent": {
                "type": "string",
                "description": (
                    "The specific user request that revealed the gap, in "
                    "the user's own words if possible."
                ),
            },
            "suggested_approach": {
                "type": "string",
                "description": (
                    "Optional hint for how to implement it — libraries, "
                    "APIs, local vs remote, caveats."
                ),
            },
        },
        "required": ["name", "capability", "user_intent"],
    }
    requires_confirmation = False
    category = "meta"

    def __init__(self, skills_dir: Path) -> None:
        self.skills_dir = Path(skills_dir)

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        name = str(args.get("name", "")).strip()
        capability = str(args.get("capability", "")).strip()
        user_intent = str(args.get("user_intent", "")).strip()
        suggested = str(args.get("suggested_approach") or "").strip()

        if not name or not capability or not user_intent:
            return ToolResult(
                ok=False,
                error="name, capability and user_intent must all be non-empty",
            )

        slug = _slug(name)
        try:
            self.skills_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            return ToolResult(ok=False, error=f"cannot create skills dir: {e}")

        path = self.skills_dir / f"{slug}.md"
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")

        if path.exists():
            # Append a new trigger entry to the existing file. The user or
            # LLM hit this same gap again — useful prioritisation signal.
            try:
                existing = path.read_text(encoding="utf-8")
            except OSError as e:
                return ToolResult(ok=False, error=f"cannot read existing skill: {e}")
            if not existing.endswith("\n"):
                existing += "\n"
            addition = f"- `{now}` — {user_intent}\n"
            new_content = existing + addition
            try:
                path.write_text(new_content, encoding="utf-8")
            except OSError as e:
                return ToolResult(ok=False, error=f"cannot write skill file: {e}")
            return ToolResult(
                ok=True,
                output=f"updated existing skill request: {path.name}",
                metadata={
                    "skill_slug": slug,
                    "path": str(path),
                    "created": False,
                },
            )

        body = _render_new_skill_md(
            slug=slug,
            name=name,
            capability=capability,
            user_intent=user_intent,
            suggested_approach=suggested,
            created_at=now,
        )
        try:
            path.write_text(body, encoding="utf-8")
        except OSError as e:
            return ToolResult(ok=False, error=f"cannot write skill file: {e}")
        return ToolResult(
            ok=True,
            output=f"logged skill request: {path.name}",
            metadata={
                "skill_slug": slug,
                "path": str(path),
                "created": True,
            },
        )
