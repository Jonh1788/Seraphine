# Skill: fetch_image

- **Slug**: `fetch_image`
- **Status**: implemented
- **Created at**: 2026-04-10T00:00:00+00:00
- **Implemented at**: 2026-04-10T00:00:00+00:00
- **Tool**: `fetch_image` (`backend/seraphine/tools/image_fetch.py`, `FetchImageTool`)

## Capability

Baixar uma imagem da internet e exibi-la inline no chat. Usada quando
o usuário pede "me mostre uma foto/imagem de X" ou quando uma resposta
se beneficia de um apoio visual.

## Flow

1. Usuário pede uma imagem.
2. LLM chama `web_search` (ou `search_news` com imagens) para localizar
   uma URL direta.
3. LLM escolhe uma URL que termine em `.jpg/.jpeg/.png/.webp/.gif` ou
   venha de um host de imagens conhecido e chama `fetch_image` com
   `{url, caption?}`.
4. O tool valida a URL (reusa `_validate_url` de `web.py`, bloqueando
   IPs privados/loopback/link-local), baixa via `httpx.AsyncClient`
   streaming, verifica que `Content-Type` começa com `image/`, aplica
   cap de 5 MB e devolve `ToolResult` com:
   - `output`: `"Imagem: <caption ou url>"`
   - `metadata`: `{image_data_url, url, caption, content_type, bytes}`
5. `ConversationEngine` emite `ToolResultEvent` incluindo o campo
   `metadata`.
6. `ChatView` detecta `tool_result.metadata.image_data_url` e anexa o
   data URL ao último turno do assistant, onde o bubble já renderiza
   thumbnails clicáveis com lightbox.

## Implementation notes

- Tool name in registry: `fetch_image`
- `requires_confirmation=False` (read-only network I/O, mesmo perfil de
  risco que `web_fetch`)
- `category="network"`
- SSL via `truststore` (system truststore) igual ao `web_fetch`
- Cap de 5 MB — imagens maiores são rejeitadas para proteger memória
  do browser e tamanho da mensagem WS
- Não decodifica a imagem no backend; só valida `Content-Type` e passa
  o base64 adiante. O browser faz a decodificação na tag `<img>`.
- SSRF: reusa `_validate_url` de `seraphine/tools/web.py`

## Engine / WS changes

- `ToolResultEvent` ganhou o campo opcional `metadata: dict[str, Any]`
  (`backend/seraphine/conversation/engine.py`) e o yield no loop de
  execução agora propaga `result.metadata`.
- `ToolResultMessage` no frontend (`frontend/src/ws/types.ts`) ganhou
  `metadata?: Record<string, unknown>`.
- `ChatView` (`frontend/src/chat/ChatView.tsx`) trata `tool_result`
  com `metadata.image_data_url` anexando a imagem ao último turno do
  assistant.

## Triggers

- (reserved)
