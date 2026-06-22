"""Regression test for the curiosity web-search API mismatch.

Before the fix, `_search` called `tool.run(query=, max_results=)` and read
`result.content` — but the tool API is `execute({query, num_results})` returning
a `ToolResult` whose structured list is under `metadata["results"]`. Every search
threw + was swallowed → `tick()` inserted 0 discoveries forever.
"""

import pytest

from seraphine.curiosity.service import CuriosityService


class FakeToolResult:
    def __init__(self, results):
        self.metadata = {"results": results}
        self.output = ""


class FakeSearchTool:
    def __init__(self):
        self.calls = []

    async def execute(self, args):
        self.calls.append(args)
        return FakeToolResult([
            {"title": "Novidade X", "url": "https://x.com", "snippet": "resumo"},
        ])


class FakeRegistry:
    def __init__(self, tool):
        self._tool = tool

    def get(self, name):
        return self._tool if name == "web_search" else None


@pytest.mark.asyncio
async def test_search_uses_execute_and_reads_metadata_results():
    tool = FakeSearchTool()
    svc = CuriosityService(store=None, llm=None, tools_registry=FakeRegistry(tool))
    out = await svc._search("python novidade 48h")
    assert out == [{"title": "Novidade X", "url": "https://x.com", "snippet": "resumo"}]
    # called execute (not the nonexistent run) with query + num_results
    assert tool.calls[0]["query"] == "python novidade 48h"
    assert tool.calls[0]["num_results"] == 3


@pytest.mark.asyncio
async def test_search_no_tools_returns_empty():
    svc = CuriosityService(store=None, llm=None, tools_registry=None)
    assert await svc._search("x") == []


@pytest.mark.asyncio
async def test_search_tolerates_missing_metadata():
    class NoMeta:
        output = "text"

    class T:
        async def execute(self, args):
            return NoMeta()

    svc = CuriosityService(store=None, llm=None, tools_registry=FakeRegistry(T()))
    assert await svc._search("x") == []
