# 040 — Scheduler Inspector

## Context

`ProactiveScheduler` tem 7 jobs: stalled_tasks, weekly_reflection,
day_review, curiosity, finance_ambient, anticipation, metalearning.
Todo mundo voando cego — se um falha, você só vê nos logs do container.

## Escopo

### Backend

- `GET /proactive/jobs` — `{id, name, next_run_time, last_fired,
   last_status, last_error}` pra cada job.
- `POST /proactive/jobs/:name/run` — dispara manualmente (debug).
  Requires confirmation flag to avoid accidental runs.

APScheduler já expõe `_sched.get_jobs()`. Para last_fired/status vou
adicionar listener `JOB_EXECUTED`/`JOB_ERROR` que persiste em uma
nova tabela `scheduler_runs(id, job_name, started_at, finished_at,
ok, error)`.

### Frontend

Nova aba "Scheduler" em Settings ou Memory:
- Lista dos jobs com next_run relativo ("em 4h") e cor do last_status
- Botão "run now" per job

## Riscos

- **Manual run pode custar $$$ em LLM**: confirm modal obrigatório
  pros que chamam LLM (curiosity, weekly_reflection, day_review).
