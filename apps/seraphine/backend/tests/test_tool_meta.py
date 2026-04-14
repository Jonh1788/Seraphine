from __future__ import annotations

from pathlib import Path

import pytest

from seraphine.tools.meta import RequestSkillTool, _slug


def test_slug_normalises_spaces_and_punctuation() -> None:
    assert _slug("Web Access") == "web_access"
    assert _slug("Send SMS!!") == "send_sms"
    assert _slug("read.pdf") == "read_pdf"
    assert _slug("   ") == "unnamed"
    assert _slug("multi   spaces") == "multi_spaces"
    # Long names get truncated
    long_name = "a" * 200
    assert len(_slug(long_name)) <= 48


@pytest.mark.asyncio
async def test_request_skill_creates_file(tmp_path: Path) -> None:
    tool = RequestSkillTool(tmp_path)
    result = await tool.execute(
        {
            "name": "web_access",
            "capability": "Fetch arbitrary HTTP URLs and return text",
            "user_intent": "check today's news",
            "suggested_approach": "httpx + BeautifulSoup",
        }
    )
    assert result.ok
    assert result.metadata["created"] is True
    assert result.metadata["skill_slug"] == "web_access"
    path = tmp_path / "web_access.md"
    assert path.exists()
    content = path.read_text(encoding="utf-8")
    assert "# Skill: web_access" in content
    assert "Fetch arbitrary HTTP URLs" in content
    assert "check today's news" in content
    assert "httpx + BeautifulSoup" in content
    assert "Status**: pending" in content


@pytest.mark.asyncio
async def test_request_skill_dedupes_by_slug_and_appends_trigger(
    tmp_path: Path,
) -> None:
    tool = RequestSkillTool(tmp_path)
    # First hit
    r1 = await tool.execute(
        {
            "name": "web_access",
            "capability": "Fetch URLs",
            "user_intent": "first ask",
        }
    )
    assert r1.ok and r1.metadata["created"] is True

    # Second hit, same slug but different form ("Web access" normalises
    # to the same slug). Should NOT create a new file.
    r2 = await tool.execute(
        {
            "name": "Web access",
            "capability": "Fetch URLs (duplicate cap is ignored)",
            "user_intent": "second ask",
        }
    )
    assert r2.ok and r2.metadata["created"] is False
    assert r2.metadata["skill_slug"] == "web_access"

    files = list(tmp_path.glob("*.md"))
    assert len(files) == 1
    content = files[0].read_text(encoding="utf-8")
    # Both triggers should be recorded
    assert "first ask" in content
    assert "second ask" in content
    # The ORIGINAL capability text stays; the dedup only appends a trigger
    assert "Fetch URLs (duplicate cap is ignored)" not in content


@pytest.mark.asyncio
async def test_request_skill_rejects_incomplete_input(tmp_path: Path) -> None:
    tool = RequestSkillTool(tmp_path)
    r = await tool.execute({"name": "web_access", "capability": "x"})
    assert not r.ok
    assert "user_intent" in (r.error or "")

    r = await tool.execute({"name": "", "capability": "x", "user_intent": "y"})
    assert not r.ok


@pytest.mark.asyncio
async def test_request_skill_creates_directory(tmp_path: Path) -> None:
    nested = tmp_path / "nested" / "skills"
    tool = RequestSkillTool(nested)
    r = await tool.execute(
        {
            "name": "read_pdf",
            "capability": "Extract text from PDF files",
            "user_intent": "open a local pdf",
        }
    )
    assert r.ok
    assert nested.is_dir()
    assert (nested / "read_pdf.md").exists()


@pytest.mark.asyncio
async def test_request_skill_listed_in_default_registry(tmp_path: Path) -> None:
    """build_default_registry should expose the request_skill tool only
    when skills_dir is passed."""
    from seraphine.tools.registry import build_default_registry

    reg_without = build_default_registry(allowed_roots=[tmp_path])
    assert "request_skill" not in reg_without

    reg_with = build_default_registry(allowed_roots=[tmp_path], skills_dir=tmp_path)
    assert "request_skill" in reg_with
    t = reg_with.get("request_skill")
    assert t is not None
    assert t.requires_confirmation is False
    assert t.category == "meta"
