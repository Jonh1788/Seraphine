# 046 — Declarative Runbooks

## Context

Recurring multi-step procedures (deploy, backup, migrate) live as
documented shell scripts or in her head. Declarative YAML in
`~/.seraphine/runbooks/*.yml` turns them into first-class objects
she can run with approval gates.

## Shape

```yaml
name: deploy-aura
steps:
  - host: CassinoAPI
    run: cd /var/www/... && git pull
  - host: CassinoAPI
    run: docker compose up -d --build
  - approval: "rebuildou, rodo migration?"
  - host: CassinoAPI
    run: docker compose exec backend alembic upgrade head
```

Tool: `runbook_run(name)` — executes sequentially, stops on approval
step until user responds, logs each step to `runbook_runs`.
