"""Web search tool via DuckDuckGo HTML.

No API key needed — scrapes the lite (HTML) version of DuckDuckGo
which is stable and lightweight. Returns a list of result titles,
URLs, and snippets that the LLM can use to answer questions or
decide which page to web_fetch for deeper reading.

SSRF protection: inherits the same private-IP blocking from the
web module since we resolve DuckDuckGo's hostname before connecting.
"""

from __future__ import annotations

import ssl
from typing import Any
from urllib.parse import quote_plus

import httpx
import truststore
from bs4 import BeautifulSoup

from seraphine.tools.base import Tool, ToolResult

DEFAULT_NUM_RESULTS = 5
DEFAULT_TIMEOUT = 15.0
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
DDG_LITE_URL = "https://lite.duckduckgo.com/lite/"


class WebSearchTool(Tool):
    name = "web_search"
    description = (
        "Search the web using DuckDuckGo and return the top results "
        "(title, URL, snippet). Use this when you need to find "
        "information, look up current events, find documentation, "
        "or answer questions that require up-to-date web knowledge. "
        "Follow up with web_fetch on specific URLs for full content."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query string.",
            },
            "num_results": {
                "type": "integer",
                "description": (
                    f"Number of results to return (default {DEFAULT_NUM_RESULTS}, max 10)."
                ),
            },
        },
        "required": ["query"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.timeout = timeout

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        # Accept both "query" (string) and "queries" (array) — Gemma 4 uses
        # plural array form natively. Join multiple queries with " OR ".
        query = str(args.get("query", "")).strip()
        if not query:
            queries = args.get("queries")
            if isinstance(queries, list) and queries:
                query = " OR ".join(str(q).strip() for q in queries if q)
            elif isinstance(queries, str):
                query = queries.strip()
        if not query:
            return ToolResult(ok=False, error="query is required")
        num = min(int(args.get("num_results") or DEFAULT_NUM_RESULTS), 10)

        ssl_ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "text/html",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        }

        try:
            async with httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
                max_redirects=5,
                headers=headers,
                verify=ssl_ctx,
            ) as client:
                resp = await client.post(
                    DDG_LITE_URL,
                    data={"q": query, "kl": "br-pt"},
                )
                resp.raise_for_status()
        except httpx.HTTPError as e:
            return ToolResult(ok=False, error=f"search failed: {e}")

        results = _parse_ddg_lite(resp.text, num)
        if not results:
            return ToolResult(
                ok=True,
                output=f"No results found for: {query}",
                metadata={"query": query, "count": 0},
            )

        lines = [f"Search results for: {query}\n"]
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. {r['title']}")
            lines.append(f"   {r['url']}")
            if r["snippet"]:
                lines.append(f"   {r['snippet']}")
            lines.append("")

        return ToolResult(
            ok=True,
            output="\n".join(lines),
            metadata={
                "query": query,
                "count": len(results),
                "results": results,
            },
        )


def _parse_ddg_lite(html: str, max_results: int) -> list[dict[str, str]]:
    """Parse DuckDuckGo Lite HTML results page.

    DDG Lite uses a table layout where each result is 3 consecutive <tr>s:
      1. Link row: contains <a class="result-link">
      2. Snippet row: plain text description
      3. URL row: display URL (we skip this)
    """
    soup = BeautifulSoup(html, "html.parser")
    results: list[dict[str, str]] = []

    for link in soup.select("a.result-link"):
        if len(results) >= max_results:
            break
        href = str(link.get("href", ""))
        title = link.get_text(strip=True)
        if not href or not title or not href.startswith("http"):
            continue
        # Skip DuckDuckGo ad/tracking redirects
        if "duckduckgo.com/y.js" in href or "ad_provider" in href:
            continue
        snippet = ""
        parent_tr = link.find_parent("tr")
        if parent_tr:
            next_tr = parent_tr.find_next_sibling("tr")
            if next_tr:
                snippet = next_tr.get_text(strip=True)[:300]
        results.append({"title": title, "url": href, "snippet": snippet})

    return results
