from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from seraphine.lab.animation_prompt import build_animation_prompt_block, BUILTIN_ANIMATION_TAGS


@pytest.fixture(autouse=True)
def _tmp(tmp_path: Path):
    with patch("seraphine.lab.routes._ANIMATIONS_FILE", tmp_path / "animations.json"):
        yield


def test_block_includes_builtin_tags():
    block = build_animation_prompt_block()
    assert block is not None
    for tag, _desc in BUILTIN_ANIMATION_TAGS:
        assert f"- {tag}" in block
    assert "[anim:TAG]" in block


def test_block_includes_uploaded_tags():
    with patch("seraphine.lab.animation_prompt._read_animations",
               return_value=[{"label": "Comemorar", "tags": ["comemorar"]}]):
        block = build_animation_prompt_block()
    assert "- comemorar" in block


def test_block_none_when_no_tags_at_all():
    with patch("seraphine.lab.animation_prompt.BUILTIN_ANIMATION_TAGS", []), \
         patch("seraphine.lab.animation_prompt._read_animations", return_value=[]):
        assert build_animation_prompt_block() is None
