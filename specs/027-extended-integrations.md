# 027 — Extended Integrations

## Context

Google OAuth já existe (calendar + Gmail scope já solicitado no
onboarding). Temos `web_fetch`, `play_music` (YTM), `clipboard_assist`.
Faltam integrações que aumentam muito a utilidade diária:

- **027-A** — Email triage via Gmail
- **027-B** — PDF/Link reader conversacional
- **027-C** — Mood Music DJ (auto-play baseado em mood)

## 027-A — Email Triage

### Tool novo: `email_inbox_summary`

Retorna JSON:

```json
{
  "unread_total": 12,
  "priority": [
    {"from": "cliente X", "subject": "Orçamento pendente", "snippet": "...", "id": "..."},
    ...
  ],
  "other_categories": {"promotional": 4, "newsletter": 3, "notifications": 2}
}
```

Usa Gmail API (já tem token). Classifica priority via heurística +
LLM leve: não-promo, remetente conhecido (contacts do perfil ou
histórico de resposta), palavras de urgência, threads abertas.

### Tool: `email_reply_draft`

Input: `email_id, tom ('formal'|'casual'|'curto'), intent (texto)`.
Retorna draft, não envia (aprovação humana sempre). Cria o rascunho
em Gmail drafts via API (user pode editar no Gmail).

### Tool: `email_send`

Requer aprovação explicita (approval gate existente). Envia o draft.

### Triggers proativos

Morning opener pode citar: "[curious] você tem 3 emails importantes
não respondidos desde ontem — quer que eu passe por eles?"

## 027-B — PDF/Link Reader Conversacional

### Problema

Hoje `web_fetch` retorna texto cru da URL. PDFs não. Fluxo de
"lê esse pdf e me explica" é truncado.

### 027-B.1 — PDF extraction

Novo tool `document_read`:

- Input: `path` local ou `url`.
- Decide formato (PDF/html/docx/txt).
- PDF: `pypdf` extrai texto (ou `pdf2image` + OCR se scanned).
- HTML: reaproveita web_fetch com stripper já existente.
- Retorna `{text, page_count, title}`.

### 027-B.2 — Conversational wrapper

Quando usuário diz "explica esse pdf {path}", tool chain:

1. `document_read` → texto.
2. Se > 8k tokens, chunked summary em background (já tem compaction
   infra — reaproveitar).
3. Resposta conversacional com summary + pergunta de follow-up.

### 027-B.3 — Clipboard hook

Se clipboard tem URL e user diz "e esse aqui?", aplica
`document_read` automaticamente — sem user precisar colar a URL.

## 027-C — Mood Music DJ

### Problema

`play_music` (YTM) já toca. Mas só quando usuário pede. Mood (022-B)
já tá sendo derivado por turno — ligar os dois.

### Regra

Quando mood transita para:

- `focused` no horário de trabalho → ambient/lofi playlist
- `cozy` à noite → chill (Bonobo, Tycho, already in personality)
- `playful` → upbeat (user-picked alegres)
- `concerned` → não toca música (pode irritar)

### UX

Em vez de tocar automaticamente, ela **oferece**:

> "[soft] você tá bem focado agora — coloco um lofi de fundo?"

Resposta curta do user resolve. Se "sim", chama `play_music`. Tag de
preferência fica no facts ("quando focado prefere X").

### Storage

Nova tabela (ou coluna no facts):

```sql
CREATE TABLE IF NOT EXISTS mood_music_prefs (
  mood        TEXT PRIMARY KEY,
  playlist    TEXT NOT NULL,
  accepted_count INTEGER DEFAULT 0,
  rejected_count INTEGER DEFAULT 0
);
```

Aprende com aceitação/rejeição. Depois de N aceites, vira
auto-play (sem perguntar).

## Entregáveis

- [ ] `seraphine/integrations/gmail/` — adapter + tools (summary,
      draft, send).
- [ ] Tool registration no `ToolRegistry`.
- [ ] `seraphine/tools/document.py` com `document_read`.
- [ ] `pypdf` + `pdf2image` em pyproject.
- [ ] `seraphine/music/mood_dj.py` — hook no MoodTracker que dispara
      `offer_music` quando transição relevante.
- [ ] Tests: gmail summary classification, pdf text extraction,
      mood-music transition logic.

## Riscos

- **Gmail scope creep**: read + draft + send precisa escopo alto.
  Só ativa quando usuário confirma no onboarding (já feito).
- **PDF OCR pesado**: pdf2image + tesseract vira lento. Cap em 30
  páginas, OCR só se texto-extract retornar < 100 chars.
- **Mood music virar intrusivo**: começa só com OFFER, nunca auto.
  Acceptance rate < 20% depois de 10 tentativas → desativa pra
  aquele mood.
