# Triagem automática de currículos (CV Triage) — Design

**Status:** aprovado para implementação
**Data:** 2026-05-23
**Owner:** Jonathan
**Backend executor:** `apps/seraphine/backend/` (host VPS CassinoAPI 147.93.15.221, exposto em `sera.jonhdev.io`)

## 1. Problema

Triagem manual de pastas com dezenas de currículos é lenta. O usuário tem uma pasta no Mac com ~87 PDFs (volume típico, ~19 MB no total) e quer:

1. Selecionar a pasta no Seraphine (Mac).
2. Descrever a vaga em texto livre.
3. Escolher um grupo/contato do WhatsApp como destino.
4. Receber no WhatsApp um resumo dos 5 melhores candidatos + os 5 PDFs anexos.
5. Acompanhar progresso por um cartão interativo no chat do Seraphine (permanece atualizando mesmo se a conversa continuar para outros tópicos), com link para uma aba "Trabalhos" onde o detalhe completo (todos os 87 ranqueados) fica disponível.
6. Robustez: PDFs escaneados/imagem precisam ser lidos também — alvo é "ler todos".

## 2. Arquitetura geral

```
┌───────────────────────┐        multipart            ┌──────────────────────────┐
│ Seraphine (Tauri Mac) │  POST /cv_triage/jobs       │ Seraphine backend        │
│                       │  (zip + rubric + chatId)    │ (FastAPI @ CassinoAPI)   │
│ • wizard pasta        │ ─────────────────────────►  │                          │
│ • lista chats         │                             │ • salva zip /data/...    │
│ • cartão de progresso │ ◄─── WS cv_triage_progress  │ • cria job no SQLite     │
│ • aba "Trabalhos"     │ ◄─── WS cv_triage_finished  │ • dispara worker async   │
└───────────────────────┘                             └──────────┬───────────────┘
                                                                 │
                                                                 ▼
                                              ┌────────────────────────────────┐
                                              │ Worker: cv_triage              │
                                              │  1. unzip → /data/cv_triage/N/ │
                                              │  2. extract: pdfplumber        │
                                              │     fallback → tesseract (PT)  │
                                              │     fallback → Claude Vision   │
                                              │  3. rank: Claude por CV        │
                                              │     (concorrência = 5)         │
                                              │  4. top 5 → resumo + arquivos  │
                                              └──────────┬─────────────────────┘
                                                         │
                                ┌────────────────────────┴───────────────────┐
                                ▼                                            ▼
                ┌─────────────────────────┐                  ┌────────────────────────────┐
                │ chat (turn no DB +      │                  │ whatsapp-bridge:3001       │
                │ WS broadcast pro Mac)   │                  │  POST /api/send (texto)    │
                └─────────────────────────┘                  │  POST /api/send-media (×5) │
                                                             └────────────────────────────┘
```

Componentes novos:

1. **Mac Tauri** — wizard "Triagem de CV", componente `<JobProgressCard>` (vive como turn persistente no chat), aba "Trabalhos".
2. **Backend Seraphine** — módulo `cv_triage/` (rotas REST, worker, schema SQLite, broadcaster WS) + pipeline de extração em cascata.
3. **Bridge** — rota nova `POST /api/send-media` (mídia individual via `MessageMedia` da `whatsapp-web.js`).
4. **Infra** — Dockerfile do backend Seraphine ganha `tesseract-ocr`, `tesseract-ocr-por`, `poppler-utils`; nginx host bumpa `client_max_body_size` de 25 MB para 50 MB.

Bridge usado: o **do próprio Seraphine** (`whatsapp-bridge:3001` no compose `apps/seraphine/docker-compose.yml`), não o do Aura. Ambos estão na rede compartilhada `seraphine-net`, mas mantemos o stack isolado.

## 3. Decisões de produto (aprovadas)

| Aspecto | Decisão |
|---|---|
| Trigger | App Mac (Seraphine Tauri) — wizard com seleção de pasta |
| Critério de ranking | Texto livre descrevendo a vaga (não JD em PDF, não form estruturado) |
| Output WhatsApp | Resumo + os 5 PDFs como anexos |
| Destinatário | Selecionado de uma lista (grupos+contatos do bridge) |
| UX execução | Cartão no chat com progresso ao vivo, atualiza mesmo se a conversa avançar; aba "Trabalhos" para detalhe; ao final, resumo no chat **e** envio pelo WhatsApp |
| Processamento | Backend Seraphine no VPS (não Aura) |
| Pré-processamento | Pasta compactada em zip no Mac antes de subir |

## 4. Modelo de dados

Duas tabelas novas no SQLite do Seraphine backend (`/data/seraphine.sqlite`), com migrador no padrão `MemoryStore` existente.

```sql
CREATE TABLE cv_triage_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,        -- chat onde o cartão vive
  turn_id         INTEGER NOT NULL,        -- bubble persistente do cartão
  status          TEXT    NOT NULL,        -- queued|extracting|ranking|sending|done|failed|cancelled
  rubric          TEXT    NOT NULL,        -- descrição da vaga em texto livre
  target_chat_id  TEXT    NOT NULL,        -- ex: 5511...@g.us
  target_label    TEXT    NOT NULL,        -- "Time RH 2026" (cache p/ UI)
  total_cvs       INTEGER NOT NULL DEFAULT 0,
  processed_cvs   INTEGER NOT NULL DEFAULT 0,
  ocr_used_count  INTEGER NOT NULL DEFAULT 0,
  vision_used_count INTEGER NOT NULL DEFAULT 0,
  unreadable      INTEGER NOT NULL DEFAULT 0,
  staging_dir     TEXT    NOT NULL,        -- /data/cv_triage/<id>/
  top5_json       TEXT,                    -- snapshot final
  whatsapp_status TEXT,                    -- pending|text_sent|all_sent|failed
  error           TEXT,
  created_at      TEXT    NOT NULL,
  finished_at     TEXT
);

CREATE TABLE cv_triage_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES cv_triage_jobs(id) ON DELETE CASCADE,
  filename      TEXT    NOT NULL,
  candidate_name TEXT,                     -- extraído pelo tool score_candidate
  text_source   TEXT    NOT NULL,          -- pdfplumber|tesseract|vision|none
  text_chars    INTEGER NOT NULL DEFAULT 0,
  score         REAL,                      -- 0..100
  match_pct     REAL,                      -- 0..100
  justification TEXT,
  strengths     TEXT,                      -- JSON list[str]
  gaps          TEXT,                      -- JSON list[str]
  status        TEXT    NOT NULL,          -- pending|extracted|ranked|failed
  error         TEXT,
  ranked_at     TEXT,
  UNIQUE(job_id, filename)
);
CREATE INDEX idx_results_job_score ON cv_triage_results(job_id, score DESC);
```

**Máquina de estados do job**:

```
queued ─► extracting ─► ranking ─► sending ─► done
                                            ╰─► failed
                                  cancelled (a qualquer momento)
```

**Ciclo de vida**:

1. `POST /cv_triage/jobs` valida (`zip ≤ 50 MB`, MIME `application/zip`, rubric ≥ 30 chars, chatId existe no bridge), resolve `target_label` via `/api/chats` (cache 5 min), cria turn `kind=cv_triage_card payload={job_id}` na conversa ativa, grava `source.zip` em `/data/cv_triage/<id>/`, retorna `201 {job_id, turn_id}` e dispara `asyncio.create_task(run_cv_triage(job_id))`.
2. Worker (semáforo global = 1 job de cada vez):
   - `extracting`: descompacta, lista `.pdf` válidos, popula `cv_triage_results`. Para cada PDF: extração em cascata, emite WS `cv_triage_progress {phase:"extracting", processed, total, current, ocr_used_count, vision_used_count}`.
   - `ranking`: por CV com `text_chars > 0`, dispara `rank_one(rubric, text)` via `asyncio.Semaphore(5)`. WS `phase:"ranking"`.
   - `sending`: pega top 5 (`ORDER BY score DESC LIMIT 5`), grava `top5_json`, monta resumo Markdown. `send_message(target, summary)` → marca `text_sent`. Para cada PDF do top 5, envia via `send_media` com delay 1.5 s entre envios. `whatsapp_status = all_sent | failed`.
   - Grava turn de resposta no chat com resumo final, emite WS `cv_triage_finished`, marca `done` + `finished_at`.
3. `POST /cv_triage/jobs/:id/cancel`: flag em memória; worker checa entre PDFs, antes de cada call Claude e entre cada send. Limpa staging.
4. **Cleanup**: `done`/`cancelled` mantém staging por 24 h; `failed` por 7 d. Job apscheduler diário `cv_triage_housekeeping` remove o que passou.

**Persistência do cartão**: ao reabrir uma conversa antiga, o frontend identifica `kind=cv_triage_card` no turn e renderiza `<JobProgressCard jobId={N}/>`. O componente faz `GET /cv_triage/jobs/:id` (idempotente, reconcilia) e, se ainda ativo, se inscreve no WS filtrando por `job_id`.

`total_cvs` só é conhecido após o unzip. Cartão começa em `queued` com label "Preparando arquivos..." (indeterminado) e vira percentual ao entrar em `extracting`.

## 5. Pipeline de extração robusta

Cada PDF passa por até 3 estágios; para no primeiro que produz texto utilizável.

```python
def extract_with_fallback(pdf_path) -> ExtractionResult:
    text = pdfplumber_extract(pdf_path)
    if is_usable(text):
        return ExtractionResult(text, source="pdfplumber")
    text = tesseract_extract(pdf_path, lang="por", dpi=250)
    if is_usable(text):
        return ExtractionResult(text, source="tesseract")
    text = claude_vision_extract(pdf_path, max_pages=2)
    if is_usable(text):
        return ExtractionResult(text, source="vision")
    return ExtractionResult("", source="none")  # incrementa unreadable
```

**`is_usable(text)`**: `len(text.strip()) >= 200` E razão alfanumérico/total ≥ 0.5 (evita declarar sucesso em `ÿÿÿ��`).

| Estágio | Lib | Custo | Tempo típico/PDF | Quando dispara |
|---|---|---|---|---|
| `pdfplumber` | `pdfplumber>=0.10` (já dep) | grátis, local | 0.3–1 s | sempre |
| `tesseract` | apt `tesseract-ocr` + `tesseract-ocr-por` + `poppler-utils`; py: `pytesseract>=0.3.13`, `pdf2image>=1.17` | grátis, local | 6–15 s | text-layer vazio ou lixo |
| `claude vision` | AnthropicClient existente, `claude-sonnet-4-5` | ~$0.01/CV | 3–5 s | Tesseract também falhou |

**Render OCR**: `pdf2image.convert_from_path(pdf, dpi=250)` → PIL → `pytesseract.image_to_string(img, lang="por")` página a página, concatenado. 250 DPI é o sweet spot acurácia/tempo para CVs. Timeout 30 s por PDF — se estourar, marca `tesseract_timeout` e cai para Vision.

**Vision fallback**: passa apenas as 2 primeiras páginas como imagens base64 com prompt "Extraia todo o texto deste currículo. Não interprete, só transcreva". CVs com >2 páginas ficam documentados como `vision_truncated` no `text_source`.

**Container changes** (Dockerfile do backend Seraphine):

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-por poppler-utils \
 && rm -rf /var/lib/apt/lists/*
```

## 6. Ranking com Claude

**Modelo**: `claude-sonnet-4-5` (via env `SERAPHINE_ANTHROPIC_SMART_MODEL`, que já existe). Default do Seraphine é Haiku para chat barato; aqui queremos mais nuance. Override documentado.

**Tool com schema forçado** (elimina parsing frágil de JSON solto):

```python
TOOL = {
  "name": "score_candidate",
  "description": "Avalia um currículo contra a vaga.",
  "input_schema": {
    "type": "object",
    "required": ["candidate_name", "score", "match_pct", "strengths", "gaps", "justification"],
    "properties": {
      "candidate_name": {"type": "string", "maxLength": 120},
      "score":         {"type": "number", "minimum": 0, "maximum": 100},
      "match_pct":     {"type": "number", "minimum": 0, "maximum": 100},
      "strengths":     {"type": "array", "items": {"type": "string"}, "maxItems": 5},
      "gaps":          {"type": "array", "items": {"type": "string"}, "maxItems": 5},
      "justification": {"type": "string", "maxLength": 400}
    }
  }
}
```

`candidate_name` alimenta o caption "Top N · Nome · score X" no envio WhatsApp.

**Prompt cache no rubric**: rubric idêntica nas 87 chamadas → `cache_control: {type: "ephemeral"}` no bloco system+rubric. Após o primeiro hit, os outros 86 pagam ~10% do input.

**Concorrência**: `asyncio.Semaphore(5)`. Conservador, fica abaixo de rate limits Anthropic em qualquer tier; também não monopoliza o cliproxy compartilhado.

**Retry**: `AnthropicClient` já tem backoff exponencial para 429/529. Para 5xx persistente num CV: 3 tentativas, depois marca `status=failed` e segue.

**Custo & tempo estimados** (87 CVs, 19 MB):

| Fase | Tempo | Custo |
|---|---|---|
| Upload zip (Mac→VPS, rede caseira) | ~10 s | — |
| Extração (mistura típica: 85 pdfplumber, 2 OCR) | ~2 min | ~$0.01 (1 fallback Vision) |
| Ranking (Sonnet, paralelismo=5, cache hit) | ~1.5 min | ~$0.40–0.80 (com cache) |
| Envio WhatsApp (texto + 5 PDFs) | ~10 s | — |
| **Total** | **~4 min** | **~$1** |

## 7. UI do Mac

### 7.1 Wizard "Triagem de CV"

Acessível por um botão dedicado no chat input do Seraphine (ícone "anexar pasta" ao lado do botão de áudio). Se houver suporte a slash-commands no app, também responde a `/triagem`. Modal de 3 passos:

| Passo | Conteúdo | Validação |
|---|---|---|
| 1. Pasta | Botão "Escolher pasta..." (`@tauri-apps/plugin-dialog`) + drop zone. Lista colapsável de PDFs detectados. Filtra `.pdf` (ignora `__MACOSX/`, `.DS_Store`, outros formatos). | ≥1 PDF |
| 2. Vaga | `<textarea>` grande, auto-resize, placeholder *"Cargo, nível, skills obrigatórias, diferenciais, localização..."*. | ≥30 chars |
| 3. Destino | Dropdown searchable de chats (grupos primeiro, contatos depois, ícone distinto). Puxa de `GET /whatsapp/chats` (proxy do bridge), cache 5 min em `sessionStorage`. | chat válido |

**Submit**: novo comando Tauri `zip_folder_pdfs(folder_path) -> Vec<u8>` em Rust (lib `zip` já é dep transitivo). Gera zip em memória apenas com os `.pdf` filtrados. Frontend faz `POST /cv_triage/jobs` multipart `(zip + rubric + target_chat_id + target_label)`. Ao receber `{job_id, turn_id}`, fecha wizard. O cartão aparece na conversa via o broadcaster WS existente, que já notifica novos turns para clientes conectados (`ws.app.state.ws_clients`); se chegar antes do response, o frontend deduplica por `turn_id`.

### 7.2 `<JobProgressCard>`

```
┌─────────────────────────────────────────────────────┐
│ 📄 Triagem de CV — 87 currículos          ▸        │
│ ─────────────────────────────────────────────────── │
│ ████████████░░░░░░  47/87                          │
│ Avaliando contra a vaga · OCR usado em 3            │
│ → Time RH 2026                                      │
└─────────────────────────────────────────────────────┘
```

Estados:

| Status | Aparência |
|---|---|
| `queued` | Spinner + "Preparando arquivos..." |
| `extracting` | Barra `processed/total` + "Lendo CVs (47/87)" + contagem OCR/Vision live |
| `ranking` | Barra reinicia 0→total + "Avaliando contra a vaga (62/87)" |
| `sending` | Spinner + "Enviando pelo WhatsApp..." (texto → 1/5 → 2/5...) |
| `done` | ✓ verde + top 5 inline (rank · nome · score) + chevron "Ver completo" + "Resumo enviado pra Time RH 2026" |
| `failed` | ⚠ + erro curto + botão "Tentar novamente" |
| `cancelled` | × cinza + "Cancelado" |

Colapsável (header clicado → 1 linha `📄 Triagem · 47/87 · extraindo` com barra mini). Persiste no histórico — ao recarregar, renderiza estado final do `GET /cv_triage/jobs/:id`.

### 7.3 Aba "Trabalhos"

Rota nova no frontend Tauri. Lista vertical de todos os jobs (cv_triage + futuros tipos), agrupada por dia (`Hoje`, `Ontem`, `Esta semana`...). Cada linha: ícone, título, status badge, timestamp relativo, link "abrir cartão na conversa".

Click → painel de detalhe:

- Header: rubric completa (colapsível), destino, status, timestamps.
- Tabela completa de todos os ranqueados, ordenada por score desc. Colunas: rank, filename, candidate_name, score, match%, strengths (chips), gaps (chips), `text_source`, botão "Abrir PDF" (Tauri `open_path_local` no caminho original conhecido pelo Mac).
- Linhas vermelhas para `failed`/`unreadable` com motivo.
- Botões: "Reenviar pra outro grupo" (refaz só `sending`), "Exportar CSV", "Cancelar" (se ativo).

Aba não-bloqueante — pode voltar ao chat a qualquer momento, WS continua atualizando o cartão.

## 8. Nova rota no bridge — `POST /api/send-media`

`services/whatsapp-bridge/src/routes/send.ts` ganha uma rota nova; `/api/send` existente fica intocada.

```typescript
router.post("/send-media",
  multer({ dest: "/tmp", limits: { fileSize: 25 * 1024 * 1024 } }).single("file"),
  async (req, res) => {
    const { chatId, caption } = req.body;
    if (!chatId || !req.file) return res.status(400).json({ error: "missing chatId or file" });
    if (getStatus() !== "ready") return res.status(503).json({ error: "bridge not ready" });
    try {
      const media = MessageMedia.fromFilePath(req.file.path);
      media.filename = req.file.originalname;
      const sent = await getClient().sendMessage(chatId, media, caption ? { caption } : undefined);
      res.json({ ok: true, id: sent.id._serialized });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    } finally {
      fs.unlink(req.file.path).catch(() => {});
    }
  }
);
```

Decisões:

- **1 arquivo por request** (não array). Mantém bridge stateless; backend controla pacing e retry per-file.
- **multer `/tmp`** com cap 25 MB/arquivo. PDFs de CV raramente passam de 2 MB; cap evita abuso.
- `media.filename = originalname` preserva o nome real no WhatsApp.
- Sem novo entry-point público — rota fica na rede interna do docker, mesmo padrão da `/api/send`.

**Cliente Python** (no backend Seraphine):

```python
async with httpx.AsyncClient(timeout=60) as http:
    await http.post(f"{BRIDGE_URL}/api/send",
                    json={"chatId": job.target_chat_id, "message": summary})
    update_status(job, whatsapp_status="text_sent")

    for rank, result in enumerate(top5, start=1):
        caption = f"Top {rank} · {result.candidate_name} · score {result.score:.0f}"
        for attempt in range(3):
            try:
                with open(result.path, "rb") as f:
                    r = await http.post(
                        f"{BRIDGE_URL}/api/send-media",
                        files={"file": (result.filename, f, "application/pdf")},
                        data={"chatId": job.target_chat_id, "caption": caption},
                    )
                r.raise_for_status()
                break
            except Exception:
                if attempt == 2: raise
                await asyncio.sleep(2 ** attempt)
        await asyncio.sleep(1.5)

    update_status(job, whatsapp_status="all_sent")
```

## 9. Endpoints novos

| Método | Path | Onde | Propósito |
|---|---|---|---|
| `POST` | `/cv_triage/jobs` | Seraphine backend | Criar job (multipart zip+rubric+chatId+label) |
| `GET` | `/cv_triage/jobs` | Seraphine backend | Listar jobs (aba Trabalhos) |
| `GET` | `/cv_triage/jobs/:id` | Seraphine backend | Estado + resultados completos |
| `POST` | `/cv_triage/jobs/:id/cancel` | Seraphine backend | Cancelar job ativo |
| `POST` | `/cv_triage/jobs/:id/resend` | Seraphine backend | Refazer só fase `sending` |
| `GET` | `/whatsapp/chats` | Seraphine backend | Proxy do `/api/chats` do bridge |
| `POST` | `/api/send-media` | whatsapp-bridge | Enviar 1 arquivo via WhatsApp |

**Frames WS novos** no canal `/ws/conversation` existente:

- `cv_triage_progress` `{job_id, phase, processed, total, current_filename?, ocr_used_count, vision_used_count}`
- `cv_triage_finished` `{job_id, top5, whatsapp_status, unreadable}`

## 10. Falhas e recuperação

| Falha | Comportamento |
|---|---|
| Backend reinicia mid-job | Startup varre `status IN ('extracting','ranking','sending')` → marca `failed`, `error="interrupted_by_restart"`. UI mostra "Tentar novamente". Sem resume parcial. |
| Zip malformado / bomba | `zipfile.is_zipfile()`; `ZipFile.infolist()` rejeitado se `..`, `\0`, absolute path; cap **total descompactado = 100 MB**. |
| PDF individual ilegível | `text_source="none"`, `status="failed"`, `unreadable++`. Listado no resumo final por nome. |
| Anthropic 429/5xx | Adapter retém backoff; após 3 tentativas no CV: marca esse CV `failed`, segue com os outros. |
| Bridge offline | `GET /api/status` antes; texto/mídia falham → `whatsapp_status="failed"`. Job em si fica `done` (ranking visível), botão "Reenviar pra WhatsApp" no detalhe. |
| Disco cheio | `shutil.disk_usage(staging_root)` requer `zip_size × 3` livre; senão 507 + `error="disk_full"`. |
| WS desconectado | Frontend reconecta `/ws/conversation`; ao reconectar, cartão faz `GET /cv_triage/jobs/:id` pra reconciliar. |

## 11. Segurança

- **Auth**: rotas novas usam o middleware `SERAPHINE_API_KEY` existente. Sem nova superfície.
- **Path traversal no unzip**: `ZipFile.extract()` resolve cada destino e checa `os.path.commonpath([staging_dir, dest]) == staging_dir`.
- **PDFs contêm PII**: logs guardam apenas `filename`, `text_chars`, `text_source`, `score`. Conteúdo do CV nunca em logs.
- **TTL dos arquivos**: `done`/`cancelled` = 24 h; `failed` = 7 d. Job apscheduler `cv_triage_housekeeping` diário.
- **Bridge `/api/send-media`**: rede interna do docker, não exposta no nginx.

## 12. Observabilidade

Eventos JSON estruturados (logger atual do backend), todos com `job_id`:

| Evento | Campos extras |
|---|---|
| `cv_triage.job_created` | `total_cvs?, target_chat_id, rubric_chars` |
| `cv_triage.extract_done` | `filename, text_source, text_chars, duration_ms` |
| `cv_triage.extract_failed` | `filename, reason` |
| `cv_triage.rank_done` | `filename, score, input_tokens, output_tokens, cached_tokens, duration_ms` |
| `cv_triage.rank_failed` | `filename, error_code, attempts` |
| `cv_triage.send_text` | `chat_id, duration_ms` |
| `cv_triage.send_media_done` | `rank, filename, duration_ms` |
| `cv_triage.send_media_failed` | `rank, filename, error, attempt` |
| `cv_triage.job_done` | `total, ranked, unreadable, ocr_used, vision_used, total_duration_ms, total_input_tokens, total_output_tokens, cached_tokens, est_cost_usd` |

Sem novo stack de métricas — `docker logs aura-... seraphine-...` já é suficiente.

## 13. Testes

Stack: `pytest`, `httpx.AsyncClient`, `respx` para mockar Anthropic e bridge. Diretório novo: `apps/seraphine/backend/tests/cv_triage/`.

**Unit**

| Teste | Validação |
|---|---|
| `test_is_usable` | texto normal=True; vazio=False; lixo binário=False; <200 chars=False; só números/símbolos=False |
| `test_extract_cascade_pdfplumber_ok` | pdfplumber bom → não chama tesseract/vision |
| `test_extract_cascade_falls_through_to_tesseract` | pdfplumber vazio → tesseract ok |
| `test_extract_cascade_falls_through_to_vision` | pdfplumber + tesseract vazios → vision ok |
| `test_extract_all_failed_marks_unreadable` | três stages falham → `text_source="none"` |
| `test_zip_rejects_path_traversal` | zip com `../../etc/passwd` rejeitado |
| `test_zip_rejects_oversized_uncompressed` | zip bomb 1 KB→200 MB rejeitado |
| `test_score_candidate_tool_parse` | tool_use response → dataclass com bounds checking |
| `test_state_machine_transitions` | transições válidas/inválidas |
| `test_top5_with_fewer_than_5_ranked` | só 3 ranqueados → top3 + aviso no resumo |

**Integration** (FastAPI `TestClient`, Anthropic/bridge mockados via `respx`)

| Teste | Cenário |
|---|---|
| `test_full_happy_path_3_cvs` | zip 3 PDFs → POST job → aguarda done → verifica top3 + chamadas bridge (texto + 3 mídia) |
| `test_cancel_during_extraction` | POST job → POST cancel após 1 PDF → `status=cancelled`, staging removido |
| `test_restart_marks_active_jobs_failed` | seed job em `ranking` → startup hook → `failed`, error contém "interrupted" |
| `test_bridge_offline` | bridge mock 503 → job termina `done` + `whatsapp_status=failed`, ranking visível |
| `test_anthropic_5xx_one_cv_still_succeeds` | 1 de 3 CVs sempre falha no Anthropic → job done com 2 ranqueados, 1 failed |
| `test_ws_progress_emitted` | WS test client → recebe `cv_triage_progress` frames com `phase/processed` corretos |
| `test_send_media_route_streams_file` | unit do bridge: POST multipart → `MessageMedia` mocked, `client.sendMessage` chamado, `filename` preservado |

**E2E manual** (não automatizado): 3 PDFs reais no Mac (1 nativo, 1 scan, 1 corrompido) → wizard real → backend real → bridge real (grupo de teste). Checklist no spec antes do release.

## 14. Fora de escopo (explícito)

- Sem deduplicação de candidatos (mesma pessoa em duas inscrições).
- Sem persistência cross-job (banco de talentos).
- Sem editar rubric e re-rankear sem refazer.
- Sem `.docx`/`.txt`/`.rtf` — só `.pdf`. Outros formatos no zip são ignorados (logged `skipped_non_pdf`).
- Sem OCR multi-idioma — só PT-BR. CV totalmente em inglês via OCR pode degradar; pdfplumber + Vision já cobrem o caso comum.
- Sem Anthropic Message Batches API (50% desconto, mas latência de horas — incompatível com o UX exigido).

## 15. Resumo executivo

- 5 endpoints novos no backend Seraphine + 1 endpoint novo no bridge
- 2 tabelas SQLite + 1 modificação no Dockerfile (Tesseract+poppler) + 1 no nginx (50 MB)
- 4 superfícies de UI no Mac: wizard, cartão no chat, aba Trabalhos, detalhe do job
- 2 frames WS novos sobre o canal `/ws/conversation` existente
- Pipeline de extração em cascata pdfplumber → Tesseract → Vision para "ler todos"
- ~4 min e ~$1 por triagem de 87 CVs
