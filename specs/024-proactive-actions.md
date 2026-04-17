# 024 — Proactive Actions

## Context

Proactive opener (022-D) só dispara quando o usuário conecta. Isso
cobre retornos, mas não cobre momentos em que Seraphine deveria
aparecer **durante** o dia: 30min antes da reunião, em tarefa parada
há 12 dias, nos domingos de reflexão, quando a saúde piora por 3
dias seguidos.

Esta spec adiciona um **proactive scheduler** que dispara pushes +
abre conversa quando condições são atendidas.

## 024-A — Meeting Prep

### Trigger

APScheduler job que a cada 1min:

1. Busca eventos do calendário nos próximos 40min.
2. Para cada evento não-"prep-enviado":
   - Se faltam 30±5min, dispara.
3. Marca como prep-enviado no `event_timeline` (metadata).

### Ação

```python
async def send_meeting_prep(event):
    brief = await generate_brief(event)  # LLM curto: Haiku
    notification = PushNotificationPayload(
        title=f"⏰ {event.title} em 30min",
        body=brief,
        action_url="seraphine://open_chat?topic=meeting_prep"
    )
    await push.send_all(notification)
    # Se WS ativa, injetar como opener especial:
    await ws_broker.send_if_connected({
        "type": "assistant_opener",
        "text": brief,
        "source": "meeting_prep",
    })
```

### Generate brief

Haiku com contexto: evento título, descrição, local, notas linked por
título/fuzzy match, open loops relacionados.

> "[focused] Em 30min tem 'Call cliente X'. Últimas notas diziam que
> ficou pendente o orçamento. Quer que eu resuma?"

## 024-B — Stalled Task Nudges

### Trigger

Job diário (20:00):

1. `SELECT * FROM seraphine_tasks WHERE status != 'done' AND
    updated_at < NOW - 7 days`.
2. Para cada, checar se já foi nudged essa semana (`last_nudged_at`
   em nova coluna).
3. Se não, gerar comentário curto e enfileirar opener.

### Rate limit

Max 1 nudge por tarefa por 7 dias. Max 2 nudges no total por dia
(não virar lista de cobrança).

### Ação

Adiciona ao backlog do próximo opener. Na próxima sessão ativa, sai:

> "[curious] Aquela tarefa 'refatorar auth middleware' tá parada há
> 12 dias — ainda faz sentido ou arquiva?"

## 024-C — Weekly Reflection Push

### Trigger

Cron domingo 21:00 (configurável).

### Ação

1. Gera reflexão via LLM com contexto:
   - Tarefas fechadas na semana
   - Tarefas criadas vs fechadas (delta)
   - Health avg: sono, passos, peso
   - Open loops que ficaram
   - Emoções inferidas (insights)
   - Top 3 eventos do timeline
2. Formato: 4-6 bullets PT-BR + 1 frase de encerramento.
3. Envia via push + salva como nota ancorada `memory_note` (tag=weekly).

### Exemplo

> **Semana de 8–14 abril**
> - 3 deploys (Seraphine liveness + iOS fix + Aura patch)
> - 12 tarefas fechadas, 8 abriram — saldo positivo
> - Sono: média 6h30 (alvo 7h) — caiu quarta pro nível 4h
> - Open loop: testar build sim iOS segue em aberto
> - Você se sentiu sobrecarregado na quarta, recuperou sexta
>
> [warm] Semana forte em output. Descansa direito essa noite.

## 024-D — Health Anomaly Nudges

### Trigger

Job 07:00 diário. Roda insights engine existente (já tem `analyze_health`
em `insights/service.py`) e pega as nudges severity >= "medium".

### Ação

Injeta no primeiro opener do dia como contexto:

```python
# In openers/service.py, augment the context:
health_nudges = await insights.pending_health_nudges(max_age_hours=24)
if health_nudges:
    opener_extras += "\n- alerta de saúde: " + health_nudges[0].title
```

A tag "alerta de saúde" + contexto faz o opener sair mais provável
na direção de health. Sem exigir nova infra.

## 024-E — Scheduler Infra

### Localização

`seraphine/proactive/scheduler.py` — novo módulo. Reaproveita
APScheduler existente (já usado para reminders).

```python
class ProactiveScheduler:
    def __init__(self, store, push, ws_broker, llm, insights):
        ...

    def start(self):
        self._sched.add_job(self._tick_meetings, "interval", minutes=1)
        self._sched.add_job(self._tick_stalled_tasks,
                             "cron", hour=20, minute=0)
        self._sched.add_job(self._tick_weekly_reflection,
                             "cron", day_of_week="sun", hour=21)
```

Lifespan em `main.py` instancia + start/stop.

### WS Broker

Pequeno registry de WebSockets ativos para "send_if_connected" sem
bloquear se ninguém tá plugado:

```python
class WSBroker:
    def __init__(self):
        self._sockets: set[WebSocket] = set()

    def register(self, ws): self._sockets.add(ws)
    def unregister(self, ws): self._sockets.discard(ws)

    async def send_if_connected(self, msg):
        for ws in list(self._sockets):
            try: await ws.send_json(msg)
            except Exception: self._sockets.discard(ws)
```

## Entregáveis

- [ ] `seraphine/proactive/scheduler.py` + 4 ticks.
- [ ] `WSBroker` em `ws/broker.py`, registrada em todo ws_accept.
- [ ] Coluna `last_nudged_at` em `seraphine_tasks`.
- [ ] Gerador de meeting prep (Haiku call).
- [ ] Gerador de weekly reflection.
- [ ] Health nudges wire-up no opener.
- [ ] Config: `SERAPHINE_PROACTIVE_ENABLED=true`, timezones.
- [ ] Tests: scheduler firing, rate limits, dedup.

## Riscos

- **Spam**: Se ela dispara push toda hora, vira ignorada. Rate limit
  global: max 3 pushes proativos/dia. Per-feature rate limit também.
- **Duplicidade com opener 022-D**: se usuário conecta 25min antes
  da reunião, opener 022-D pode dar prep + depois meeting_prep
  repete. Dedup via flag no event_timeline.
- **Reflexão semanal virar chata**: começa só enviando se tem dados
  (>5 turnos na semana). Usuário offline 2 semanas não recebe 2
  reflexões acumuladas.
