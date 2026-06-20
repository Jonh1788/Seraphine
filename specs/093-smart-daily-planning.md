# 093 - Smart Daily Planning

## Objetivo

Transformar o briefing matinal passivo em um planejador interativo que sugere blocos de tempo, permite ajustes com um toque, e cria calendar events + reminders automaticamente.

## Motivacao

- O briefing (GET /briefing) ja agrega tasks, calendar events, habits em risco, weather.
- Mas e texto corrido — o usuario le e esquece.
- Falta a acao: "sugiro focus das 9-11h" deveria virar um calendar block com 1 clique.
- Context-aware: se dormiu mal (HealthKit), sugerir manhã mais leve.

## Entregas

1. **Plano diario estruturado**
   - `GET /planning/today` retorna:
     - `time_blocks: TimeBlock[]` — sugestoes de blocos de tempo.
     - `priorities: Task[]` — top 3 tasks para hoje.
     - `at_risk: { habits: Habit[], goals: Goal[] }` — streaks/goals em risco.
     - `context: { sleep_hours, energy_estimate, meetings_count, free_slots_min }`.
   - Cada `TimeBlock`: `{ start, end, type, title, linked_id?, reason }`.
   - `type`: focus, meeting (do Google Calendar), break, exercise, admin, free.
   - `reason`: "Voce tem 3 tasks pendentes de alta prioridade" ou "Streak de exercicio em risco".

2. **Gerador de plano (backend)**
   - Input: Google Calendar events, tasks com due_date, habits com streak em risco, health snapshot, hora atual.
   - Heuristicas:
     - Meetings ja fixas no calendario -> blocos imutaveis.
     - Focus blocks entre meetings (minimo 1h contiguos).
     - Exercicio sugerido se streak em risco e nao ha workout hoje.
     - Breaks a cada 2h de focus.
     - Se sleep < 6h: menos focus blocks, mais breaks.
   - LLM refina o plano: ajusta prioridades, adiciona razoes em linguagem natural.

3. **Planning UI**
   - Modal ou view que abre ao clicar no briefing do dashboard.
   - Timeline visual vertical (estilo agenda) mostrando blocos sugeridos.
   - Cada bloco: arrastavel para reposicionar, clicavel para editar/remover.
   - Botao "Aceitar plano" -> cria Google Calendar events para focus blocks + reminders para tasks prioritarias.
   - Botao "Ajustar" -> chat abre com contexto do plano para refinamento por voz/texto.

4. **Acoes rapidas**
   - Tap em task prioritaria -> marcar como in_progress.
   - Tap em habit em risco -> toggle completion.
   - Tap em focus block -> inicia Pomodoro timer com as tasks vinculadas.

5. **Feedback loop**
   - Ao final do dia (day_review), comparar plano vs executado.
   - Metricas: % de blocos executados, tasks completadas vs planejadas.
   - Persistir em `daily_plans(id, date, blocks_planned, blocks_executed, tasks_planned, tasks_done)`.
   - Alimentar o gerador: se usuario sempre ignora exercicio as 12h, parar de sugerir nesse horario.

6. **API**
   - `GET /planning/today` -> plano do dia.
   - `POST /planning/accept` -> cria calendar events + reminders.
   - `PATCH /planning/blocks/{id}` -> ajustar bloco.
   - `POST /planning/feedback` -> registrar execucao.
   - `GET /planning/history?days=N` -> historico de planos.

## Limites

- Nao substituir Google Calendar como fonte de verdade — Planning cria events la, nao mantém calendario proprio.
- Nao bloquear o usuario se ele ignorar o plano.
- Nao implementar planning para semana inteira (apenas o dia atual).
- Sugestoes sao heuristicas + LLM, nao ML treinado.

## Criterios de aceite

- GET /planning/today retorna blocos que respeitam meetings existentes.
- Aceitar plano cria events no Google Calendar.
- Focus block aceito inicia Pomodoro ao clicar.
- Plano com sleep < 6h tem menos focus blocks.
- Day review reporta aderencia ao plano.
