"""News search tool via DuckDuckGo Lite.

Dedicated news vertical for recent articles. Unlike `web_search`,
this tool applies a time filter (past day/week/month) so results
are fresh and relevant to current events. Uses the same stable
`lite.duckduckgo.com/lite/` endpoint and parser pattern as
`WebSearchTool`.

Defaults to Brazilian Portuguese (`kl=br-pt`) and past week (`df=w`).
"""

from __future__ import annotations

import ssl
from typing import Any
from urllib.parse import urlparse

import httpx
import truststore
from bs4 import BeautifulSoup

from seraphine.tools.base import Tool, ToolResult

DEFAULT_NUM_RESULTS = 5
MAX_NUM_RESULTS = 10
DEFAULT_TIMEOUT = 15.0
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
DDG_LITE_URL = "https://lite.duckduckgo.com/lite/"

_TIMEFRAME_MAP = {
    "day": "d",
    "week": "w",
    "month": "m",
    "any": "",
}


class SearchNewsTool(Tool):
    name = "search_news"
    description = (
        "Search for recent news articles on a topic. Returns headlines, "
        "sources, URLs, and brief summaries. Use this when the user asks "
        "about current events, recent happenings, today's news, or wants "
        "up-to-date information on a topic. Default language is PT-BR."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query (topic, event, person, etc)",
            },
            "num_results": {
                "type": "integer",
                "description": (
                    f"Max results (default {DEFAULT_NUM_RESULTS}, max {MAX_NUM_RESULTS})."
                ),
            },
            "timeframe": {
                "type": "string",
                "enum": ["day", "week", "month", "any"],
                "description": (
                    "How recent: 'day' (past 24h), 'week' (past 7 days, default), "
                    "'month' (past 30 days), 'any' (no filter)"
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
        # Accept both "query" (string) and "queries" (array), matching WebSearchTool.
        query = str(args.get("query", "")).strip()
        if not query:
            queries = args.get("queries")
            if isinstance(queries, list) and queries:
                query = " OR ".join(str(q).strip() for q in queries if q)
            elif isinstance(queries, str):
                query = queries.strip()
        if not query:
            return ToolResult(ok=False, error="query is required")

        try:
            num = int(args.get("num_results") or DEFAULT_NUM_RESULTS)
        except (TypeError, ValueError):
            num = DEFAULT_NUM_RESULTS
        num = max(1, min(num, MAX_NUM_RESULTS))

        timeframe = str(args.get("timeframe") or "week").lower().strip()
        if timeframe not in _TIMEFRAME_MAP:
            timeframe = "week"
        df_value = _TIMEFRAME_MAP[timeframe]

        ssl_ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "text/html",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        }

        form: dict[str, str] = {"q": query, "kl": "br-pt"}
        if df_value:
            form["df"] = df_value

        try:
            async with httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
                max_redirects=5,
                headers=headers,
                verify=ssl_ctx,
            ) as client:
                resp = await client.post(DDG_LITE_URL, data=form)
                resp.raise_for_status()
        except httpx.HTTPError as e:
            return ToolResult(ok=False, error=f"news search failed: {e}")

        results = _parse_ddg_lite_news(resp.text, num)
        if not results:
            return ToolResult(
                ok=True,
                output=f"No news found for: {query}",
                metadata={
                    "query": query,
                    "timeframe": timeframe,
                    "count": 0,
                    "results": [],
                },
            )

        timeframe_label = {
            "day": "past 24h",
            "week": "past 7 days",
            "month": "past 30 days",
            "any": "any time",
        }[timeframe]

        lines = [f"News results for: {query} ({timeframe_label})\n"]
        for i, r in enumerate(results, 1):
            source = r.get("source") or "unknown"
            lines.append(f"{i}. {r['title']} — {source}")
            lines.append(f"   {r['url']}")
            if r.get("snippet"):
                lines.append(f"   {r['snippet']}")
            lines.append("")

        return ToolResult(
            ok=True,
            output="\n".join(lines),
            metadata={
                "query": query,
                "timeframe": timeframe,
                "count": len(results),
                "results": results,
            },
        )


def _extract_source(url: str) -> str:
    """Return a human-friendly source name derived from the URL hostname."""
    try:
        host = urlparse(url).hostname or ""
    except ValueError:
        return ""
    if host.startswith("www."):
        host = host[4:]
    return host


def _parse_ddg_lite_news(html: str, max_results: int) -> list[dict[str, str]]:
    """Parse DuckDuckGo Lite HTML results page for news items.

    DDG Lite uses a table layout where each result is 3 consecutive <tr>s:
      1. Link row: contains <a class="result-link">
      2. Snippet row: plain text description
      3. URL row: display URL (we skip this)

    Same structure as general search; the news-ness comes from the
    `df` time-filter parameter sent in the POST body.
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
        # Skip DuckDuckGo ad/tracking redirects and "more info" ad disclosure links
        if (
            "duckduckgo.com/y.js" in href
            or "ad_provider" in href
            or "duckduckgo-help-pages/company/ads" in href
            or title.strip().lower() in {"more info", "mais informações", "mais informacoes"}
        ):
            continue
        snippet = ""
        parent_tr = link.find_parent("tr")
        if parent_tr:
            next_tr = parent_tr.find_next_sibling("tr")
            if next_tr:
                snippet = next_tr.get_text(strip=True)[:300]
        results.append(
            {
                "title": title,
                "url": href,
                "snippet": snippet,
                "source": _extract_source(href),
            }
        )

    return results
