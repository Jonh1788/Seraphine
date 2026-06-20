# 089 - Focus Analytics Dashboard

## Objetivo

Migrar o Pomodoro timer do localStorage para o backend e criar um dashboard de produtividade com metricas de deep focus, correlacoes com apps usados, e streaks de concentracao.

## Motivacao

- O focus timer persiste ciclos apenas no localStorage — dados perdidos ao limpar cache.
- Nao ha historico de sessoes de focus, impossibilitando analise de produtividade ao longo do tempo.
- O `activeAppReactor` ja detecta qual app esta ativo, mas nao correlaciona com sessoes de focus.

## Entregas

1. **Backend de sessoes de focus**
   - Nova tabela: `focus_sessions(id, started_at, ended_at, duration_sec, type, completed, interruptions, notes)`
   - `type`: `work` (25min), `short_break` (5min), `long_break` (15min).
   - `completed`: booleano — true se o timer chegou ao fim sem cancelamento.
   - `interruptions`: contador de vezes que o usuario saiu do focus mode.

2. **API**
   - `POST /focus/sessions` -> registra sessao finalizada.
   - `GET /focus/sessions?start=&end=` -> lista sessoes no periodo.
   - `GET /focus/stats?period=week|month` -> `{ total_focus_min, completed_sessions, avg_session_min, streak_days, interruption_rate, by_day: [] }`
   - `GET /focus/apps?start=&end=` -> apps mais usados durante sessoes de focus (top 10).

3. **App tracking durante focus**
   - Quando focus timer esta ativo e `activeAppReactor` detecta troca de app, registrar em `focus_app_logs(session_id, app_name, started_at, duration_sec)`.
   - Troca para app nao-produtivo (browser, Slack, Messages) conta como interrupcao.
   - Lista de apps produtivos configuravel: VS Code, Terminal, Cursor, Xcode, Figma.

4. **Focus Analytics view**
   - Nova view ou sub-tab no dashboard.
   - Metricas:
     - Horas de deep focus hoje / semana / mes.
     - Sessoes completadas vs canceladas (pie chart).
     - Focus streak (dias consecutivos com >= 1 sessao completa).
     - Top apps durante focus (bar chart horizontal).
     - Interrupcoes por dia (sparkline).
   - Heatmap semanal: grade 7x24 com intensidade de focus por hora/dia.

5. **Integracao com InsightEngine**
   - Nova serie temporal `focus_minutes` para o correlation engine (spec 085).
   - Correlacoes: focus_minutes vs tasks_completed, focus_minutes vs sleep_hours.

6. **Focus music integracao**
   - Ao iniciar sessao de focus, trigger automatico de `POST /music/focus-start` (ja existe).
   - Ao finalizar, log da playlist tocada no session metadata.

## Limites

- Nao implementar bloqueio de apps durante focus (apenas tracking).
- Nao adicionar notificacoes de "volte ao focus" quando sai do app produtivo (invasivo demais).
- App tracking depende do activeAppReactor (Tauri only) — PWA registra sessoes sem app data.

## Criterios de aceite

- Sessao de focus finalizada persiste no backend.
- Focus Analytics mostra horas de focus da semana com breakdown por dia.
- Top apps durante focus mostra dados corretos.
- Focus streak conta dias consecutivos.
- Dados alimentam o correlation engine.
