# 023 — Ambient Awareness

## Context

Seraphine hoje só "sabe" o que entra via memória (facts, perfil, open
loops). Ela não tem consciência ambiente: não lembra que o próximo
evento é em 20min, que você dormiu 4h ontem, nem que você falou baixo
e cansado agora. Isso faz ela parecer desconectada da realidade
presente.

Esta spec adiciona duas camadas de percepção:

- **023-A** — Ambient context block: injeção de sinais estáveis do
  presente (calendário, saúde, clima, tarefas de hoje) no prompt.
- **023-B** — Prosody awareness: metadados do áudio Whisper passam
  pro prompt como dica emocional.

Tudo sem novas UIs. Infra já existe (calendar, health, weather via
web_search, whisper). O que falta é ligar.

## 023-A — Ambient Context Block

### Fonte

Nova função em `seraphine/conversation/ambient.py`:

```python
async def build_ambient_block(store, settings, whisper_meta=None) -> str | None:
    now = datetime.now(TZ)
    blocks: list[str] = []

    # Próximo evento (<2h) do calendário
    ev = await store.next_calendar_event(within=timedelta(hours=2))
    if ev:
        blocks.append(f"- próximo evento: {ev.title} em {ev.minutes_until}min")

    # Último health snapshot (sono, passos)
    h = await store.latest_health_snapshot()
    if h:
        blocks.append(f"- ontem: {h.sleep_hours:.1f}h sono, {h.steps} passos")

    # Tarefas pro dia
    tasks = await store.list_tasks_due_today(limit=3)
    if tasks:
        blocks.append(f"- hoje: {', '.join(t.title for t in tasks)}")

    # Clima atual (cache 30min, via IP geoloc)
    w = await weather_cache.current()
    if w:
        blocks.append(f"- clima: {w.temp}°C, {w.condition}")

    if not blocks:
        return None
    return "AMBIENT (context que você acabou de 'perceber' — NÃO lista "
           "pra ele, só usa quando relevante):\n" + "\n".join(blocks)
```

### Injeção

No `ConversationEngine.handle_user_message`, logo após o `mood_line`
(já que mood é dinâmico também):

```python
ambient = await build_ambient_block(self.store, settings)
if ambient:
    messages.append(ChatMessage(role="system", content=ambient))
```

### Cache

- Calendar: cache 5min (next_event é acessado por turno).
- Health: cache 10min.
- Weather: cache 30min.
- Tasks: sem cache (cheap SQLite).

Todos dentro de um `AmbientCache` singleton no `app.state`.

## 023-B — Prosody Awareness

### Sinais

Quando o cliente envia audio PCM, o backend (ou o whisper embedado no
Tauri) já tem:

- `duration_s` (length of segment)
- `rms_avg` (energy)
- `pitch_variance` (F0 std, opcional — requer feature extractor leve)

Hoje só o texto transcrito é usado. Adicionar um campo `audio_meta` ao
`user_message`:

```json
{
  "type": "user_message",
  "content": "...",
  "audio_meta": {
    "duration_s": 1.8,
    "rms_avg": 0.06,
    "rate_wpm": 120
  }
}
```

### Derivação

```python
def prosody_hint(meta: dict) -> str | None:
    if not meta:
        return None
    parts: list[str] = []
    if meta.get("duration_s", 0) > 0 and meta.get("rate_wpm", 0) < 90:
        parts.append("fala lenta")
    if meta.get("rms_avg", 1) < 0.05:
        parts.append("tom baixo")
    if meta.get("rate_wpm", 0) > 180:
        parts.append("fala rápida/agitada")
    if not parts:
        return None
    return f"VOZ ATUAL: {', '.join(parts)} — ajuste sua energia em cima disso."
```

Injeta junto com mood/ambient se não-nulo.

### Frontend

`realtime/RealtimeController.tsx` já calcula RMS no analyser. Basta
passar no payload `user_message`. O `rate_wpm` deriva de
`text.split().length / duration_s * 60`.

## Entregáveis

- [ ] `seraphine/conversation/ambient.py` com `build_ambient_block`.
- [ ] `AmbientCache` singleton na `app.state`.
- [ ] `store.next_calendar_event`, `store.latest_health_snapshot`,
      `store.list_tasks_due_today` (checar se já existem).
- [ ] Weather cache (fetch via `web_search` uma vez/30min com geoloc).
- [ ] `audio_meta` field em `user_message` WS client/server.
- [ ] `prosody_hint` function + injeção.
- [ ] Tests: ambient block renders only when signals exist;
      prosody hint correct on edge cases.

## Riscos

- **Prompt bloat**: ambient pode chegar a 300 tokens se tudo presente.
  Solução: soft cap — se >250 tokens, corta os menos relevantes
  primeiro (clima, depois tasks, mantém calendário e saúde).
- **Weather API cost**: web_search não é free em latência. Cache
  agressivo + fallback "sem dado" se erro.
- **Prosody false positives**: tom baixo natural do usuário vira
  sinal de cansaço. Mitigação: comparar com baseline móvel (média
  dos últimos 50 turnos).
