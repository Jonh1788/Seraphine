# Skill: buscar_noticias

- **Slug**: `buscar_noticias`
- **Status**: implemented
- **Created at**: 2026-04-10T01:45:53+00:00
- **Implemented by**: `search_news` tool (`backend/seraphine/tools/news.py`)

## Capability

Buscar e resumir as notícias mais recentes de fontes confiáveis.

Implementado pelo `SearchNewsTool`, que consulta o DuckDuckGo Lite com
filtro temporal (dia/semana/mês) e retorna manchetes recentes com fonte,
URL e resumo. Padrão: PT-BR, últimos 7 dias. Para conteúdo completo do
artigo, encadeie com `web_fetch` nas URLs retornadas.

## Triggers

- `2026-04-10T01:45:53+00:00` — Quais as últimas notícias?
