# 083 - Calendario Unificado com Heatmap

## Objetivo

Transformar o CalendarView minimalista em um calendario unificado que agrega tasks, habits, health, water e Google Calendar em uma unica visualizacao com heatmap de atividade.

## Motivacao

- CalendarView atual mostra apenas eventos do Google Calendar.
- Tasks com due date, habits completados, health snapshots e water logs ja existem no backend mas nao aparecem no calendario.
- Um heatmap de atividade (estilo GitHub contributions) daria visao rapida de dias produtivos vs vazios.

## Entregas

1. **API de agregacao**
   - `GET /calendar/aggregate?start=YYYY-MM-DD&end=YYYY-MM-DD`
   - Retorna por dia: `{ date, tasks: [], habits: [], health: {}, water: {}, events: [], score: number }`
   - Score calculado: +1 por task concluida, +1 por habit completado, +1 se meta de agua atingida, +1 se steps > 8000, +1 se sleep > 7h. Max 5.

2. **Heatmap mensal**
   - Grid de dias do mes com intensidade de cor baseada no score (0=cinza, 1-2=roxo claro, 3-4=roxo medio, 5=roxo forte).
   - Tooltip no hover mostra breakdown do score.
   - Navegacao mes anterior/proximo.

3. **Day detail panel**
   - Clicar em um dia abre painel lateral com:
     - Google Calendar events do dia
     - Tasks com due date nesse dia (com status)
     - Habits toggleados
     - Health snapshot (steps, sleep, calories)
     - Water intake vs meta
   - Acoes rapidas: criar task, toggle habit, log water.

4. **Drag-to-reschedule**
   - Arrastar uma task de um dia para outro atualiza o `due_date` via `PATCH /tasks/{id}`.
   - Visual feedback: ghost card durante drag, highlight no dia destino.

5. **Recurring rules overlay**
   - Recurring rules exibidas como barras semi-transparentes nos dias em que se materializam.

## Limites

- Nao substituir Google Calendar view — agregar junto.
- Nao implementar criacao de Google Calendar events por drag (apenas tasks).
- Heatmap so considera dados locais, nao Google Calendar events no score.

## Contratos

- `GET /calendar/aggregate?start=&end=` -> `{ days: DayAggregate[] }`
- `DayAggregate`: `{ date: str, tasks: TaskSummary[], habits: HabitLog[], health: HealthSnapshot | null, water: { intake_ml, goal_ml }, events: CalendarEvent[], score: int }`

## Criterios de aceite

- Heatmap renderiza o mes corrente com cores corretas.
- Clicar em um dia mostra todos os dados agregados.
- Drag de task entre dias atualiza due_date no backend.
- Mes sem dados mostra heatmap todo cinza (nao quebra).
- Navegacao entre meses carrega dados sob demanda.
