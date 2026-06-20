# 090 - Goal System (OKRs Pessoais)

## Objetivo

Adicionar uma camada estrategica acima de tasks e habits, permitindo definir goals trimestrais/anuais com key results mensuráveis, vincular tasks/habits a goals, e acompanhar progresso automaticamente.

## Motivacao

- Tasks e habits sao taticos — o usuario sabe o que fazer hoje, mas nao sabe se esta avancando no que importa.
- Nao existe forma de definir "quero correr uma maratona" e ver progresso ao longo dos meses.
- Weekly review menciona tasks e habits, mas nao os relaciona a objetivos maiores.

## Entregas

1. **Modelo de Goals**
   - Nova tabela: `goals(id, title, description, area, timeframe, start_date, end_date, status, created_at, updated_at)`
   - `area`: saude, carreira, financas, pessoal, aprendizado, relacionamentos.
   - `timeframe`: quarterly, yearly, open-ended.
   - `status`: active, paused, completed, abandoned.

2. **Key Results**
   - Tabela: `key_results(id, goal_id, title, metric_type, target_value, current_value, unit, auto_source, created_at, updated_at)`
   - `metric_type`: numeric (ex: correr 500km), boolean (ex: publicar artigo), percentage.
   - `auto_source`: fonte automatica — `health.steps`, `habits.{habit_id}`, `tasks.completed`, `finance.savings`, `focus.minutes`, `null` (manual).
   - Auto-update: cron job diario calcula `current_value` a partir do `auto_source`.

3. **Vinculos goal <-> tasks/habits**
   - Tabela: `goal_links(id, goal_id, linked_type, linked_id)`
   - `linked_type`: task, habit, project.
   - Ao criar task ou habit, campo opcional "goal" para vincular.
   - Tasks vinculadas a goal completadas incrementam progresso implicitamente.

4. **Goals view**
   - Nova view acessivel via nav rail.
   - Cards por goal com:
     - Titulo, area (icone), timeframe.
     - Progress bar agregada (media dos key results).
     - Key results com barra individual.
     - Tasks/habits vinculados.
     - Dias restantes.
   - Filtro por area e status.
   - Criar/editar goal inline.

5. **API**
   - `GET /goals` -> `{ goals: Goal[] }`
   - `POST /goals` -> `{ goal: Goal }`
   - `PATCH /goals/{id}` -> update.
   - `DELETE /goals/{id}` -> soft delete (status=abandoned).
   - `POST /goals/{id}/key-results` -> add KR.
   - `PATCH /goals/{id}/key-results/{kr_id}` -> update KR.
   - `POST /goals/{id}/links` -> vincular task/habit/project.
   - `GET /goals/summary` -> dashboard summary (goals at risk, on track, completed).

6. **Integracao com rotinas**
   - Weekly review inclui secao "Progresso nos Goals" com KRs que avancaram e goals em risco.
   - Monthly review (nova rotina) faz retrospectiva completa com sugestoes de ajuste.

7. **Chat tools**
   - `create_goal`, `list_goals`, `update_goal_progress` para criacao e atualizacao via conversa.

## Limites

- Nao implementar OKR scoring (0.0-1.0) — progresso simples em porcentagem.
- Nao adicionar goals compartilhados (multi-user).
- Nao implementar AI goal suggestions na v1 — usuario define manualmente.

## Criterios de aceite

- Goal criado aparece na GoalsView com progress bar.
- Key result com auto_source atualiza automaticamente.
- Task vinculada a goal completada reflete no progresso.
- Weekly review menciona goals.
- Goal com 0% e prazo < 30 dias marcado como "em risco".
