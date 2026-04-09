from __future__ import annotations

import pytest

from seraphine.tools.shell import RunShellTool


@pytest.mark.asyncio
async def test_run_shell_ok() -> None:
    tool = RunShellTool()
    assert tool.requires_confirmation is True
    r = await tool.execute({"command": "echo hello"})
    assert r.ok is True
    assert r.output is not None
    assert "hello" in r.output


@pytest.mark.asyncio
async def test_run_shell_nonzero() -> None:
    tool = RunShellTool()
    r = await tool.execute({"command": "bash -c 'exit 7'"})
    assert r.ok is False
    assert r.error is not None
    assert "7" in r.error
