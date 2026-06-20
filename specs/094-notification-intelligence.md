# 094 - Notification Intelligence

## Objetivo

Tornar o sistema de notificacoes da Seraphine inteligente: DND automatico, batching de notificacoes nao-urgentes, e aprendizado de prioridade baseado no comportamento do usuario.

## Motivacao

- Push + WS notifications atuais sao rule-based: water reminder a cada intervalo, proactive opener 1x/hora, etc.
- Nao respeitam contexto: notificacao de agua durante reunião, reminder de task durante focus.
- Todas as notificacoes tem a mesma urgencia visual — o usuario aprende a ignorar todas.

## Entregas

1. **DND automatico**
   - Detectar estado de "nao perturbe" automaticamente:
     - Google Calendar: se ha meeting agora -> DND.
     - Focus timer: se Pomodoro ativo -> DND.
     - ActiveApp: se app de videoconferencia ativo (Zoom, Meet, Teams, FaceTime) -> DND.
     - Horario: respeitar janela de silencio configuravel (ex: 23h-7h).
   - Durante DND: notificacoes enfileiradas, nao descartadas.
   - Ao sair do DND: batch delivery (ver item 2).

2. **Notification batching**
   - Notificacoes nao-urgentes agrupadas e entregues juntas:
     - Ao sair de DND.
     - A cada 30 min se nao ha interacao (idle).
   - Batch renderizado como card unico: "Enquanto voce estava ocupado: 2 water reminders, 1 insight, 1 email novo".
   - Urgentes (reminder com horario, WhatsApp mention, task deadline hoje) furam o batch e entregam imediatamente.

3. **Priority scoring**
   - Cada notificacao recebe score 0-100:
     - Tipo base: reminder com horario=90, WhatsApp mention=80, task deadline=85, water=30, insight=20, opener=10.
     - Boost: se usuario interagiu com esse tipo nos ultimos 7 dias, +10.
     - Decay: se usuario dismissiu as ultimas 3 desse tipo, -20.
   - Score < 40: batched. Score >= 40: immediate.

4. **Aprendizado de prioridade**
   - Persistir acoes do usuario em `notification_feedback(id, notification_type, action, timestamp)`.
   - `action`: opened, dismissed, snoozed, ignored (nao interagiu em 1h).
   - Recalcular priority weights semanalmente baseado no feedback.
   - Log transparente: `GET /notifications/priority-weights` mostra pesos atuais.

5. **Configuracao**
   - Settings drawer: janela de silencio (start/end), apps de DND, toggle de batching.
   - Per-type toggle: desativar notificacoes especificas (water, opener, etc.).

6. **API**
   - `GET /notifications/settings` -> configuracao atual.
   - `PATCH /notifications/settings` -> atualizar.
   - `GET /notifications/queue` -> notificacoes enfileiradas (durante DND).
   - `POST /notifications/{id}/feedback` -> registrar acao.
   - `GET /notifications/priority-weights` -> pesos atuais por tipo.

## Limites

- Nao bloquear notificacoes do sistema operacional (apenas as da Seraphine).
- Nao implementar ML sofisticado — heuristicas com pesos ajustaveis.
- DND detecta apenas apps locais (Tauri), nao calendario de terceiros alem do Google.

## Criterios de aceite

- Notificacao de agua nao aparece durante meeting do Google Calendar.
- Focus mode ativo enfileira notificacoes.
- Ao sair de DND, batch com resumo aparece.
- Notificacao dismissida 3x seguidas reduz prioridade.
- Reminder com horario sempre fura DND.
