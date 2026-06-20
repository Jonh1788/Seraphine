# 092 - Journal / Diario Pessoal

## Objetivo

Expor o conteudo gerado automaticamente pelo day_review e weekly_reflection como um diario navegavel, complementado por entradas manuais via voz ou texto.

## Motivacao

- `day_review` (21h diario) e `weekly_reflection` (domingo 21h) ja geram texto rico via LLM.
- Esse conteudo fica enterrado em `conversation_narratives` e nao e acessivel ao usuario.
- Voice memos classificados como "diario" nao tem destino — ficam em voice_memos sem contexto.
- Um diario pessoal conecta o auto-conhecimento que a Seraphine ja produz.

## Entregas

1. **Modelo de journal entries**
   - Tabela: `journal_entries(id, date, type, title, content, mood_label, mood_valence, tags, source, source_id, created_at, updated_at)`
   - `type`: `day_review`, `weekly_reflection`, `manual`, `voice_memo`.
   - `source`: `proactive` (gerado automaticamente), `user` (escrito pelo usuario), `voice` (transcricao).
   - `source_id`: referencia ao turn/narrative/voice_memo original.

2. **Pipeline automatico**
   - Quando `day_review` executa, alem de persistir em narratives, cria journal entry tipo `day_review`.
   - Quando `weekly_reflection` executa, cria journal entry tipo `weekly_reflection`.
   - Voice memos classificados como `diary` -> auto-cria journal entry com transcricao.
   - Mood do dia (spec 088) anexado automaticamente.

3. **Entradas manuais**
   - Via chat: "Sera, quero escrever no diario" abre modo de journal (assistant nao responde, apenas transcreve/salva).
   - Via UI: botao "Nova entrada" no JournalView, editor markdown simplificado.
   - Via voice: "Sera, diario: hoje foi um dia longo mas produtivo..." -> transcreve e salva.

4. **Journal view**
   - Timeline vertical cronologica reversa.
   - Cards com: data, tipo (icone), titulo, preview do conteudo (2 linhas), mood badge.
   - Filtros: por tipo, por mes, busca textual.
   - Abrir entry mostra conteudo completo com markdown renderizado.
   - Entries automaticas marcadas com badge "Auto" para diferenciar.

5. **Busca semantica**
   - "Quando foi que eu decidi mudar de stack?" busca por embedding similarity.
   - Embeddings no ChromaDB collection `journal_entries`.

6. **API**
   - `GET /journal?month=&year=&type=&q=` -> lista paginada.
   - `GET /journal/{id}` -> entry completa.
   - `POST /journal` -> criar entry manual.
   - `PATCH /journal/{id}` -> editar entry manual (auto entries sao read-only).
   - `DELETE /journal/{id}` -> deletar entry manual.
   - `GET /journal/search?q=` -> busca semantica.

7. **Chat tool**
   - `journal_entry(content, title?, tags?)` — cria entrada.
   - `search_journal(query)` — busca no diario.

## Limites

- Entries automaticas (day_review, weekly_reflection) sao read-only.
- Nao implementar sharing/export do diario.
- Nao implementar lock/senha para o diario (ja e local).
- Maximo de 1 auto-entry por tipo por dia (idempotente).

## Criterios de aceite

- Day review das 21h cria journal entry automaticamente.
- Journal view mostra timeline com entries auto + manuais.
- Busca "quando eu decidi X" retorna entry relevante.
- Voice memo tipo diary aparece no journal.
- Entries manuais sao editaveis; automaticas nao.
