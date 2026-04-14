from __future__ import annotations

from pathlib import Path

import pytest

from seraphine.tools.filesystem import ListDirTool, ReadFileTool, WriteFileTool


@pytest.mark.asyncio
async def test_read_file(tmp_path: Path) -> None:
    f = tmp_path / "a.txt"
    f.write_text("hello")
    tool = ReadFileTool([tmp_path])
    assert tool.requires_confirmation is False
    r = await tool.execute({"path": str(f)})
    assert r.ok is True
    assert r.output == "hello"


@pytest.mark.asyncio
async def test_list_dir(tmp_path: Path) -> None:
    (tmp_path / "b.txt").write_text("x")
    (tmp_path / "sub").mkdir()
    tool = ListDirTool([tmp_path])
    assert tool.requires_confirmation is False
    r = await tool.execute({"path": str(tmp_path)})
    assert r.ok is True
    assert r.output is not None
    lines = r.output.splitlines()
    assert lines == ["b.txt", "sub/"]


@pytest.mark.asyncio
async def test_write_file(tmp_path: Path) -> None:
    tool = WriteFileTool([tmp_path])
    assert tool.requires_confirmation is True
    target = tmp_path / "nested" / "c.txt"
    r = await tool.execute({"path": str(target), "content": "data"})
    assert r.ok is True
    assert target.read_text() == "data"


@pytest.mark.asyncio
async def test_reject_outside_roots(tmp_path: Path) -> None:
    other = tmp_path / "allowed"
    other.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("x")
    r1 = await ReadFileTool([other]).execute({"path": str(outside)})
    assert r1.ok is False
    r2 = await ListDirTool([other]).execute({"path": str(tmp_path)})
    assert r2.ok is False
    r3 = await WriteFileTool([other]).execute(
        {"path": str(tmp_path / "x.txt"), "content": "y"}
    )
    assert r3.ok is False
