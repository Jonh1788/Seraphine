# 039 — Multimodal Attachments

## Context

Já aceitamos images via `images` payload no user_message (e Anthropic
suporta vision). Mas a UX é ruim: user precisa buildar o base64 e
passar manualmente. Quero drag&drop direto no chat.

## Escopo

### Drop handler

- No componente de input do chat: `onDragOver` preventDefault +
  `onDrop` captura File[] (image/*, application/pdf).
- Limite: 5 arquivos, 10MB cada.
- Imagens → convert pra base64, adiciona preview na bar de composição,
  incluir no `images` do próximo user_message.
- PDFs → chama tool `document_read` (já existe em 027-B) com a URL do
  temp upload; insere o texto resumido como contexto.

### Paste handler

`onPaste` captura Clipboard API com image/png → mesma flow.

### UI

- Small thumbnails acima do input; X pra remover.
- Sem nova rota de backend; tudo passa pelo user_message existente.

## Riscos

- **PDFs grandes**: já temos cap 30k chars em document_read.
- **Image de qualidade alta viola 5MB de payload WS**: reamostrar pra
  max 1600px antes de base64.
