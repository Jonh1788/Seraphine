# 091 - Reading List / Knowledge Base

## Objetivo

Criar um sistema de bookmarks inteligente que salva URLs, gera resumos automaticos via LLM, armazena embeddings para busca semantica, e integra com flashcards para retencao.

## Motivacao

- `web_fetch` e `document_read` ja existem como tools — o backend ja sabe buscar e ler conteudo da web.
- Nao ha como salvar e organizar o que foi lido para consulta futura.
- ChromaDB ja esta disponivel para embeddings — busca semantica de artigos seria natural.
- Integracao com flashcards: gerar decks de revisao a partir de artigos salvos.

## Entregas

1. **Modelo de reading items**
   - Tabela: `reading_items(id, url, title, domain, summary, content_text, tags, status, saved_at, read_at, archived_at)`
   - `status`: unread, reading, read, archived.
   - `summary`: resumo de 3-5 frases gerado pelo LLM.
   - `content_text`: texto completo extraido (para busca full-text).
   - Embedding no ChromaDB com collection `reading_items`.

2. **Salvar via multiplos caminhos**
   - Chat: "Sera, salva esse artigo: [url]" -> tool `save_reading_item`.
   - Clipboard assist: detecta URL no clipboard, oferece "Salvar na reading list".
   - Quick capture: URL detectada no input vai para reading list.
   - API: `POST /reading/items` com body `{ url }`.

3. **Processing pipeline**
   - Ao salvar:
     1. `web_fetch` extrai o conteudo.
     2. LLM gera titulo (se nao detectado), summary, e tags sugeridas.
     3. Texto embedado no ChromaDB.
   - Pipeline assincrono — item salvo imediatamente como `processing`, atualizado quando LLM finaliza.

4. **Reading List view**
   - Nova view ou sub-tab.
   - Cards com: titulo, dominio (favicon), summary truncado, tags, status, data.
   - Filtros: status (unread/read/all), tags, busca textual.
   - Busca semantica: "artigos sobre state management em React" busca por embedding similarity.
   - Abrir: link externo no browser.

5. **Integracao com flashcards**
   - Botao "Gerar flashcards" no card de um reading item.
   - Usa o `content_text` como input para `POST /flashcards/decks` (ja existe).
   - Tag do deck referencia o reading item.

6. **API**
   - `POST /reading/items` -> `{ item: ReadingItem }` (async processing).
   - `GET /reading/items?status=&tag=&q=` -> lista com paginacao.
   - `GET /reading/items/{id}` -> item completo com summary.
   - `PATCH /reading/items/{id}` -> update status/tags.
   - `DELETE /reading/items/{id}` -> remove item + embedding.
   - `GET /reading/search?q=` -> busca semantica.

7. **Chat tool**
   - `save_reading_item(url, tags?)` — salva artigo.
   - `search_reading_list(query)` — busca semantica na base.

## Limites

- Nao implementar reader mode (ler artigo dentro da Seraphine).
- Nao implementar highlight/annotation no conteudo.
- Nao fazer scraping de sites que bloqueiam bots — respeitar robots.txt.
- Limite de 50KB de content_text por item (truncar artigos muito longos).

## Criterios de aceite

- "Sera, salva esse artigo: [url]" salva e gera summary.
- Reading list mostra items com resumo e tags.
- Busca semantica retorna resultados relevantes.
- Gerar flashcards a partir de artigo funciona.
- Item com URL invalida mostra erro, nao quebra.
