# Anexos (imagem + PDF) no avatar companion + chat — pipeline compartilhado

**Data:** 2026-06-27
**Status:** Aprovado (aguardando review da spec)

## Problema

O **avatar companion** (`AvatarCompanion.tsx`) não aceita anexo nenhum: o composer só tem mic, thinking e realtime, e o payload WS que ele manda nem inclui `images[]`. O usuário quer "jogar PDF/imagem nele" pra processar e responder.

Hoje:
- **Imagem** já funciona ponta-a-ponta, mas só no **chat de texto** (`ChatView.tsx` → `images[]` base64 → `engine.py:1029` monta bloco de visão → Claude vê). O avatar não usa esse caminho.
- **PDF** não vai pro modelo automaticamente em lugar nenhum. Existe a tool `document_read` (pdfplumber, **sem OCR**, capo em 30k chars, exige caminho de arquivo) e `import_financial_pdf`. O usuário se incomoda que é "só texto, sem OCR" e que "nem pergunta".

## Objetivo

Pipeline de anexo **compartilhado no backend** (avatar + chat), aceitando **imagem e PDF**, com PDF processado em **alta fidelidade via document block nativo da Anthropic** (Claude lê o PDF de verdade: escaneado, tabelas, layout) e **fallback de extração de texto** quando o provider ativo for OpenRouter.

## Decisões tomadas (brainstorm)

1. **Escopo:** pipeline compartilhado — avatar + chat usam o mesmo fluxo de backend.
2. **PDF:** **híbrido** — document block nativo no Claude/cliproxy; fallback pra `extract_pdf_text` (pdfplumber) no OpenRouter ou PDF gigante.
3. **Transporte:** **upload multipart + referência por id** — endpoint HTTP devolve um `id`; a mensagem WS referencia o id (não trafega base64 grande no frame WS; follow-ups reusam o id).
4. **Caminho de imagem do chat:** opção recomendada — backend 100% compartilhado; avatar usa o pipeline novo (imagem+PDF por id); no chat **só o PDF** entra pelo pipeline novo, **imagem do chat fica no caminho `images[]` base64 atual** (migração futura). Risco mínimo no fluxo de imagem que já funciona.

## Arquitetura

```
[Front: avatar + chat]
  └─ POST /attachments (multipart)  ──►  staging store (id, bytes, meta, TTL)
  └─ ws user_message { content, attachments:[{id,kind,mime,filename}], speak, think }
           │
           ▼
  ConversationEngine.handle_user_message(..., attachments=[...])
           │  1) resolve provider PRIMEIRO (_resolve_chat_llm — hoje roda tarde demais)
           │  2) busca bytes pelo id no staging store
           ├─ Claude/cliproxy ─► parts: image_url (imagem) | NOVO part "pdf" (document block nativo)
           └─ OpenRouter ──────► pré-extrai texto (mod_vision) e injeta como texto
           ▼
  AnthropicClient._convert_content_part — novo branch "pdf" → {type:document, source:{base64, application/pdf}}
```

### Ponto-chave de integração (já mapeado no código)

`engine.py:1029-1037` é o **único lugar** onde tanto o avatar quanto o chat montam o conteúdo do usuário. Adicionar o tratamento de anexo aqui propaga pras duas superfícies. `ChatMessage.content` (`types.py:10`) já aceita lista de blocos `dict`, então um novo part type cabe sem mudança de tipo.

## Backend

### 1. Endpoint de upload + staging store (novo módulo `seraphine/attachments/`)

- **`POST /attachments`** (multipart/form-data). Reaproveita o parser in-tree do Aura `_parse_multipart` (`apps/aura/backend/aura/chat/routes.py:1651`) e `_extract_boundary` (`:1711`) — **fatorar pra um helper compartilhado** (`packages/` ou util) em vez de duplicar.
  - MIME aceito: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `application/pdf`.
  - Cap: **imagem 10MB**, **PDF 32MB** (limite do document nativo da Anthropic; 1M-context aceita até ~600 páginas).
  - Resposta: `{ id, kind: "image"|"pdf", mime, filename, size }`.
- **Staging store** keyed por `uuid`, seguindo a convenção do **cv_triage** (`cv_triage/models.py:54` `staging_dir`, `cv_triage/housekeeping.py`, agendado em `main.py:1114`) — **não** o `save_user_upload` (`images/uploads.py:50`, que é image-only e grava na tabela `generated_images`).
  - Bytes efêmeros: persistir em dir de staging com **TTL (~24h)** + job de housekeeping (espelhar cv_triage).
  - Metadados: `{id, filename, mime, kind, size, created_at}`.
  - VPS: respeitar o volume persistente quando aplicável (lab data já persiste em `/data`), mas anexo é efêmero — temp dir com TTL basta.
- Opcional: **`GET /attachments/{id}`** pra preview no front.

### 2. WS + engine

- `user_message` ganha campo **`attachments: [{id, kind, mime, filename}]`** (parse em `ws/routes.py:767-774`, junto de `content/speak/think/images`).
- `ConversationEngine.handle_user_message(...)` ganha param **`attachments`** (assinatura em `engine.py:811-819`); WS chama em `ws/routes.py:894-902`.
- **Resolver o provider antes de montar o conteúdo.** Hoje `_resolve_chat_llm()` (`engine.py:1445-1475`) roda em `engine.py:1061`, *depois* do build em `1029`. Mover a resolução pra antes do build, pra decidir nativo-vs-texto. Gate: `settings.llm_backend in ("anthropic","claude_max")` ou novo `EngineInfo.supports_pdf` (`packages/llm-adapters/.../engine.py:21-55`).
- No build (`engine.py:1029`): pra cada anexo, buscar bytes pelo id e montar:
  - **Claude/cliproxy:** imagem → `{"type":"image_url","image_url":{"url": data_url}}` (caminho atual); PDF → novo part `{"type":"pdf","data_url": "data:application/pdf;base64,..."}`.
  - **OpenRouter:** PDF → `extract_pdf_text(bytes)` (pdfplumber, **capar em ~30k chars**); imagem → `describe_image(image_bytes=bytes, llm=self.llm)` usando o **AnthropicClient como pré-processador de visão** (`self.llm` é sempre o `AnthropicClient` quando backend é anthropic; o `OpenRouterChatClient._stringify_content` em `providers.py:152-171` joga fora bloco não-texto). Injeta o resultado como texto, estilo Aura (`routes.py:1862-1885`).
- **Compat com tools que consomem imagem anexada:** manter populado o ContextVar `_current_user_images` (`engine.py:359-366`, resetado em `1356`; feeds `_exec_one_tool` `774-796` pras tools `consumes_attached_image` — `image_gen`, `appearance`). Ao resolver anexos de imagem por id, expor uma URL resolvível (via `/attachments/{id}` ou `save_user_upload`) no ContextVar.

### 3. Adapter (`packages/llm-adapters/src/llm_adapters/anthropic.py`)

- Novo branch em **`_convert_content_part`** (`anthropic.py:66-108`) pro part `pdf`/`document` → `{type:document, source:{type:base64, media_type:"application/pdf", data}}`. Reusa o parse de data-URL das imagens (`:87-103`). **Tem que vir antes** do branch `image_url` (senão um `data:application/pdf` cai no branch de imagem e vira `image`).
- Se o endpoint cliproxy exigir, adicionar header `anthropic-beta: pdfs-2024-09-25` no header set do `__init__` (`anthropic.py:288-307`). PDF base64 é GA na API direta da Anthropic, mas cliproxy pode estar pinado — checar na implementação.
- **Fallback:** se o document block for rejeitado pelo endpoint → cair pra extração de texto (`extract_pdf_text`) e reenviar como texto.

### 4. mod_vision (reuso, sem mudança)

- `extract_pdf_text(pdf_bytes, *, password=None) -> str` (`packages/mod-vision/.../pdf.py:15`, pdfplumber, sync, sem OCR).
- `describe_image(*, image_bytes, mime_type, prompt, llm, model="claude-sonnet-4-5", max_tokens=800) -> str` (`.../image.py:14`, async, depende do `llm` ser `AnthropicClient` com `._client` httpx).

## Frontend

Hook/componente de anexo **compartilhado** (botão + drag-drop + paste), ícones SVG inline (`Icons.tsx` — **sem emoji**, regra do design system):
- Ao selecionar/soltar/colar: `POST /attachments` → guarda `{id, kind, filename}` em estado de **anexos pendentes** (chips com remover + preview).
- Ao enviar: inclui `attachments` no payload `ws.send` do `user_message`.

### Avatar (`AvatarCompanion.tsx`)
- Botão de anexo + faixa de chips no composer (`:624-726`, hoje só mic/thinking/realtime).
- **Anexo fica staged e gruda na PRÓXIMA mensagem — inclusive de voz**: solta o PDF, fala "resume isso", o anexo vai junto na turn transcrita.
- Upgrade do drag-drop Tauri (`:486-514`): ler os bytes do arquivo e subir via `/attachments`, em vez de mandar só o texto do caminho.

### Chat (`ChatView.tsx`)
- Adicionar **PDF** ao composer existente (hoje "Anexar imagem", `:1474-1494`, `accept="image/*"`), roteando **PDF** pelo novo `/attachments` + anexos pendentes.
- **Imagem do chat permanece** no caminho `images[]` base64 atual (`:923-930`) — migração futura.

## Efemeridade / tokens

- Anexo entra no LLM **só na turn em que é referenciado** (estilo Aura — token-sano). Histórico guarda só o chip de metadado.
- Re-referência por id e **prompt-caching do document block** ficam como otimização futura (pra re-leitura barata em follow-ups).

## Erros / limites

- Upload: MIME inválido → 415; oversize → 413; vazio → 400.
- PDF escaneado no OpenRouter (sem OCR) → `extract_pdf_text` retorna vazio → mensagem clara ("PDF parece escaneado; sem OCR no provider atual; troque pro Claude").
- Document block rejeitado no Claude → fallback texto automático.

## Testes

- **Unit:** branch `document` do `_convert_content_part`; gate de provider; staging store + TTL; parser multipart compartilhado; cap de 30k chars na extração.
- **Integração:** upload → ws message com id → engine monta conteúdo correto por provider (Claude vs OpenRouter).
- **E2E manual:** avatar — soltar PDF e perguntar **por voz**; chat — anexar PDF; imagem do avatar; PDF escaneado (verifica nativo vs fallback).

## Fora de escopo

- Migrar a imagem do chat pro pipeline por id (futuro).
- Prompt-caching / re-leitura persistente de anexo em múltiplas turns (futuro).
- Outros tipos de arquivo (docx, planilha) além de imagem/PDF.
