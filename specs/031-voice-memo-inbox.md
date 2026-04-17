# 031 — Voice Memo Inbox

## Context

Quando aparece uma ideia/preocupação/tarefa durante o dia, usuário não
quer abrir o app inteiro. Quer apertar um botão, falar 10-30s,
e confiar que Seraphine categoriza e arquiva.

## Fluxo

1. Global shortcut (Cmd+Shift+M) ativa "voice memo mode".
2. Tauri window minimalista aparece: botão record grande, timer.
3. Whisper local transcreve on-the-fly.
4. Usuário solta tecla ou clica stop.
5. Backend classifica via LLM leve:
   - **idea** → arquiva em `notes` (tag=idea)
   - **worry** → arquiva em `notes` (tag=worry) + se health tab
     habilitada, cria insight relacionado
   - **task** → cria em `seraphine_tasks` com due_date inferido
   - **reminder** → cria task com `remind` field
   - **note** → arquiva em notes (tag=general)
6. Window fecha mostrando: "classificada como tarefa pra amanhã" +
   undo button (5s).

## Implementação

### Frontend — `src/voice-memo/`

- `VoiceMemoWindow.tsx` — UI minimalista
- Nova window no tauri.conf: label `voice-memo`, 400x240, transparent,
  always-on-top, skip taskbar.
- Uses embedded whisper (já embarcado) pra transcrição local.

### Backend — novo tool classifier

```python
# seraphine/tools/voice_memo.py
async def classify_and_archive(transcript: str) -> dict:
    result = await llm.chat([
        ChatMessage(role="system", content=_MEMO_CLASSIFIER_PROMPT),
        ChatMessage(role="user", content=transcript),
    ])
    parsed = parse_memo_json(result)
    # parsed = {type: "task", title: "...", due_date: "...", tag: "..."}
    return await archive_by_type(parsed, transcript)
```

### Classifier prompt

```
Classifique o memo de voz em JSON:
{
  "type": "idea|worry|task|reminder|note",
  "title": "<resumo 3-8 palavras>",
  "detail": "<se complementar>",
  "due_date": "YYYY-MM-DD",       // só se type=task/reminder
  "due_time": "HH:MM",
  "remind": "at_time|1h_before|1d_before"
}

NÃO invente dados que não estão no texto. type=note é default.
```

### Routes

```
POST /voice_memos          { transcript: str } → { memo_id, classification }
GET /voice_memos           → list of last 50
POST /voice_memos/:id/undo → revert archive (only within 5min)
```

### Global shortcut

No Tauri `capabilities/default.json`, adicionar shortcut. Em
`src-tauri/src/lib.rs`:

```rust
#[cfg(not(any(target_os = "ios", target_os = "android")))]
{
    app.global_shortcut()
        .on_shortcut(Shortcut::new(Modifiers::SUPER_SHIFT, Code::KeyM), |app| {
            show_voice_memo_window(app);
        })?;
}
```

## Entregáveis

- [ ] Tabela `voice_memos` (id, transcript, classification,
      archived_to, archived_id, created_at).
- [ ] `VoiceMemoWindow.tsx` + window config.
- [ ] `src-tauri/src/voice_memo.rs` — shortcut + window launch.
- [ ] `tools/voice_memo.py` — classifier + archive.
- [ ] Routes POST/GET/undo.
- [ ] Tests: classifier on 10 sample transcripts.

## Riscos

- **Whisper lento em memo > 30s**: cap em 60s.
- **Classification errada**: ofertar correção no UI (trocar tipo e
  recategorizar).
- **Shortcut conflict**: Cmd+Shift+M pode colidir com outros apps.
  Permitir customização em settings.
