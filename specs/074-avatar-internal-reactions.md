# 074 — Avatar Reactivity to Internal App Events

## Context

Seraphine hoje tem dois sistemas de reatividade no avatar:

- **025 / 050** — Avatar reage ao contexto *externo*: app ativo do macOS,
  retorno do usuário após ausência, glance em direção a notificações.
- **011 (persona)** — Avatar ajusta mood durante a conversa (thinking,
  happy, worried) reagindo ao fluxo da fala e ao LLM.

O que está **faltando** é reação a eventos **internos do app**: quando
o usuário completa uma task, revisa um flashcard, uma imagem termina de
gerar, um background task falha, uma entrada financeira é registrada.
Hoje esses eventos acontecem em silêncio absoluto — o avatar não sabe.

O resultado é que as features se sentem desconectadas do "assistente
vivo". O pet/companion continua idle quando o usuário acabou de fazer
algo relevante.

## Escopo

Eventos que devem disparar reação (mapeamento inicial):

| Origem                         | Evento                  | Expression   | Gesture opcional |
|--------------------------------|-------------------------|--------------|------------------|
| `mod_tasks`                    | `task.completed`        | `happy`      | `nod`            |
| `mod_tasks`                    | `task.created`          | `warm`       | —                |
| `seraphine.flashcards`         | `flashcard.rated_good`  | `confident`  | —                |
| `seraphine.flashcards`         | `flashcard.rated_bad`   | `warm`       | —                |
| `seraphine.flashcards`         | `flashcard.session_complete` | `excited` | `thumbs_up`  |
| `seraphine.images`             | `image.generated`       | `Sparkly_Eyes` (excited) | —    |
| `seraphine.images`             | `image.failed`          | `Sorrow`     | —                |
| `seraphine.background_tasks`   | `bg_task.completed`     | `happy`      | —                |
| `seraphine.background_tasks`   | `bg_task.failed`        | `worried`    | —                |
| `mod_finance`                  | `finance.entry_created` | `confident`  | —                |
| `seraphine.habits`             | `habit.streak_milestone` (7/30/100) | `excited` | `thumbs_up` |
| `seraphine.water`              | `water.goal_reached`    | `happy`      | —                |

Hold curto (800–1500 ms), fade 300 ms. Reset automático pro idle depois.

## Canal

Reusar o broadcast já estabelecido em `app.state.ws_clients`
(precedentes: `reminders/notify.py`, `whatsapp/task_detector.py`,
`proactive/scheduler.py`).

Formato da mensagem WS:

```json
{
  "type": "avatar_event",
  "source": "flashcards",
  "event": "session_complete",
  "expression": "excited",
  "hold_ms": 1200,
  "gesture": "thumbs_up"
}
```

Frontend: `App.tsx` consome `avatar_event` no socket já aberto,
despacha pra `VrmAvatarController` (via `avatarRef`). Avatar Companion
window recebe a mesma mensagem (ela tem WS próprio) e reflete a
expressão em paralelo — main + companion ficam sincronizados.

## Arquitetura

### Backend

Helper único em `seraphine/avatar_bus.py`:

```python
async def broadcast_avatar_event(
    app_state,
    *,
    source: str,
    event: str,
    expression: str,
    hold_ms: int = 1000,
    gesture: str | None = None,
) -> None:
    """Best-effort broadcast to all WS clients. Swallows send errors."""
```

Cada serviço que dispara um evento chama esse helper. Mantém os
serviços acoplados só a `app_state`, não ao transporte.

Serviços tocados (um lugar de emissão cada):

- `mod_tasks/service.py`: `update_task` quando status vai pra `done`.
- `seraphine/flashcards/service.py`: `rate()` (rating ≥ 3 → good, < 3 →
  bad) e ao esvaziar a queue (session_complete).
- `seraphine/images/service.py`: no fim do job (ok/erro).
- `seraphine/background_tasks/runner.py`: transições pra `completed` /
  `failed`.
- `mod_finance/service.py`: `create_entry`.
- `seraphine/habits/service.py`: detectar passagem por milestone no
  incremento do streak.
- `seraphine/water/service.py`: detectar meta atingida na primeira
  intake do dia que cruza.

**Todos** os emissores devem:
1. Executar *depois* do commit da mudança (nunca num try que possa
   reverter).
2. Ser envolvidos em `try/except` — falha de broadcast nunca pode
   quebrar a feature.

### Frontend

1. `avatar/avatarEventHandler.ts` — mapeia `avatar_event` → chamada
   `controller.setExpression(...) + controller.playGesture(...)`.
   Expressions que não existirem no `EMOTION_MAP` caem pro fallback
   `soft`.
2. Hook em `App.tsx` dentro do handler WS existente:
   ```ts
   if (msg.type === 'avatar_event') {
     avatarEventHandler(avatarRef.current, msg);
   }
   ```
3. `avatar-companion/main.tsx` faz o mesmo no seu próprio WS. Um único
   handler compartilhado (exportado de `avatar/avatarEventHandler.ts`).

### Debounce

Usuário pode disparar muitos eventos em sequência (revisar 20 cards
seguidos). Regra: se `setExpression` for chamado enquanto um hold
anterior está ativo, o novo **substitui** o atual (não empilha). A API
do `VrmAvatarController` já tem esse comportamento — nada a adicionar.

## Sem-escopo

- Som / TTS vinculado ao evento (seria ruído; user já tem contexto visual).
- Persistência: eventos são efêmeros. Não gravar no banco.
- Rate limiting sofisticado: broadcast é barato, debounce natural do
  hold_ms já evita spam visual.
- Feature flag ou toggle no settings — se o usuário odiar, remove a
  feature inteira em vez de criar knob.

## Testes

- `tests/test_avatar_bus.py`: helper envia dict correto pra cada ws
  client, swallows send errors, não quebra quando `ws_clients` é set
  vazio.
- `tests/test_flashcards_service.py` (novo): rate de card emite
  `flashcard.rated_good`/`rated_bad`; ao zerar queue, emite
  `session_complete`. Usa `AsyncMock` pra `app_state.ws_clients`.
- `tests/test_background_tasks_runner.py` (novo): completed/failed
  emitem eventos com expression correta.
- Frontend: `avatar/__tests__/avatarEventHandler.test.ts` — mapeamento
  de expression → chamadas, fallback pra expression desconhecida.

## Dependências

- 011 (persona & mood)
- 019 (avatar companion window)
- 049 / 050 (floating pet + reactive anims)
- 067 (flashcards), 068 (image gen), 073 (background tasks) — eventos
  emitidos nos serviços dessas specs
- `app.state.ws_clients` broadcast pattern (já em uso)

## Entrega sugerida

Um PR único:

1. `avatar_bus.py` + teste
2. `avatarEventHandler.ts` + teste
3. Emissores nos 7 serviços (1 commit por serviço se quiser granular)
4. Handler em `App.tsx` e `avatar-companion/main.tsx`

Estimativa: 3–4 h de trabalho. Baixo risco — toda infra já existe,
todas as falhas são swallows.
