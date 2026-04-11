# Skill: web_news_search

- **Slug**: `web_news_search`
- **Status**: implemented
- **Created at**: 2026-04-10T04:32:59+00:00
- **Implemented by**: `search_news` tool (`backend/seraphine/tools/news.py`)

## Capability

Fetch and summarize current news articles from specified URLs or search terms.

Implemented by the `SearchNewsTool`, which queries DuckDuckGo's news vertical
with a time filter (day/week/month) and returns recent headlines, sources,
URLs and snippets. For full article content, chain with `web_fetch` on the
returned URLs.

## Triggers

- `2026-04-10T04:32:59+00:00` — pesquise as últimas notícias
