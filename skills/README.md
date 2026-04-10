# Skills backlog

This directory is the **automatic backlog** of capabilities the assistant
realised it was missing. It is NOT written by a human — Seraphine writes
here herself, via the `request_skill` meta-tool, whenever the user asks
for something the current tool registry cannot do.

## Flow

1. User asks Seraphine to do X (e.g. "procura as notícias de hoje").
2. Seraphine has no `web_access` tool.
3. Instead of refusing, the LLM calls
   `request_skill(name="web_access", capability="Fetch HTTP URLs…",
   user_intent="procurar as notícias de hoje")`.
4. The `RequestSkillTool` writes `skills/web_access.md` with a structured
   payload and an initial trigger entry.
5. Seraphine replies to the user: "Ainda não tenho essa capacidade, mas
   registrei a skill — ela vai ficar disponível assim que implementada."
6. If the same gap is hit again, the existing file gets a new trigger
   line appended (deduplication by slug). Frequency-of-triggers becomes a
   natural prioritisation signal.

## File format

```markdown
# Skill: <friendly name>

- **Slug**: `web_access`
- **Status**: pending | in_progress | implemented
- **Created at**: 2026-04-09T21:00:00+00:00

## Capability

One sentence describing what the skill should do.

## Suggested approach

Optional implementation hints (libraries, APIs, caveats).

## Triggers

- `2026-04-09T21:00:00+00:00` — "procurar as notícias de hoje"
- `2026-04-10T10:22:13+00:00` — "lê o site x.com pra mim"
```

## Implementing a skill

When you pick one up:

1. Flip `Status` to `in_progress`
2. Add a new `Tool` class in `backend/seraphine/tools/`
3. Register it in `build_default_registry` in
   `backend/seraphine/tools/registry.py`
4. Add unit tests under `backend/tests/`
5. Restart the backend (lifespan rebuilds the registry)
6. Flip `Status` to `implemented` (or move the file to a `done/`
   subdirectory — your call)

## Why one file per skill instead of a single `task.md`

- Natural deduplication by slug
- Append-only trigger history per skill
- `ls skills/` gives you the whole backlog at a glance
- `grep -l pending skills/*.md` filters by status
- Easier to pick a single skill to work on without merge conflicts
