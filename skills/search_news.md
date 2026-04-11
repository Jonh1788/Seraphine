# Skill: search_news

- **Slug**: `search_news`
- **Status**: implemented
- **Created at**: 2026-04-10T12:49:45+00:00
- **Implemented by**: `search_news` tool (`backend/seraphine/tools/news.py`)

## Capability

Buscar e retornar as notícias mais recentes de fontes confiáveis na internet.

Implementado pelo `SearchNewsTool`, que usa o DuckDuckGo Lite com filtro
temporal (`df=d|w|m`) para retornar artigos recentes com título, fonte,
URL e resumo. Padrão: idioma PT-BR, últimos 7 dias.

## Triggers

- `2026-04-10T12:49:45+00:00` — Traga para mim as últimas notícias
