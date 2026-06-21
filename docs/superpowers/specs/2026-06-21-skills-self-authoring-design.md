# Agent Self-Authoring Skills Loop — Design

**Date:** 2026-06-21
**Status:** Future — not scheduled
**Inspiration:** Odysseus skill registry. Analysis at `/tmp/ds/odysseus__skills.md`. Reference files: `services/memory/skill_extractor.py`, `src/teacher_escalation.py` (`:147-229`), `services/memory/skills.py` (`get_relevant_skills` `:645-716`, dedup `:327-350`), `src/agent_loop.py` (`:1204-1311` relevance injection + untrusted boundary), `routes/skills_routes.py` (`run_scheduled_skill_audit` `:1035`).
**Builds on:** Maestro Phase 1 (supervisor + headless agents) and Phase 3 (self-improve worktree/gate/sandbox policy). Reuses the existing superpowers `SKILL.md` format and skills dir.

## Vision / scope

Today Seraphine's skills (superpowers `SKILL.md` files) are **human-written**. The novel idea worth stealing from Odysseus is the **closed learning loop**: an agent that **writes its own skills from its run traces** — distilling a reusable procedure when a multi-step task succeeds, and having a strong teacher draft a procedure when a cheaper agent fails. Over time the local library grows from what Seraphine actually does on this machine, with no human authoring in the inner loop.

We adopt **only** the lifecycle/loop. We do **not** port Odysseus' `SKILL.md` schema, its hand-rolled YAML parser, its sidecar/registry, or its `manage_skills` tool — Seraphine already has the superpowers `SKILL.md` format, the `Skill` tool as the invocation surface, and Maestro for orchestration. We layer the self-authoring loop **on top of** that existing stack.

## What to adopt (the recommended subset)

1. **The self-authoring loop** (the standout idea):
   - **Extract-on-success** — after a run with **≥2 tool calls** (or ≥2 rounds), a background LLM call distills the trace into a draft skill, gated by **confidence ≥ 0.6**. Ref: `skill_extractor.py` (`SKILL_EXTRACT_PROMPT`, `MIN_CONFIDENCE = 0.6`), triggered from `routes/chat_helpers.py:1116` (`maybe_extract_skill`).
   - **Teacher-escalation-on-failure** — when the cheaper/local **student** agent fails a task, a strong **Opus teacher** agent writes a `SKILL.md` **draft** so the student finds it on the very next turn. Ref: `teacher_escalation.py:147-229` (prompt + the **"PORTABILITY — CRITICAL"** rules: no hardcoded hosts/paths/session-names, since skills are shared).
2. **Confidence-gated relevance injection** as a *middle tier* between "always in prompt" (the one-line index) and "fully on-demand" (`Skill` invocation): **Jaccard token-match** the user's message against `name + description + when-to-use + tags + procedure`, inject the **top-N full procedures** inline, let the model open the rest on demand. Cheap, no embeddings, tunable (`skill_max_injected` ~3, `skill_min_confidence`). Ref: `agent_loop.py:1204-1311`, `skills.py:645-716`.
3. **Treat skill bodies as UNTRUSTED context** — auto-authored/user-editable skill text is **never** concatenated into the system role. Inject it as a `trusted=false` user-role message wrapped in an untrusted-context envelope, with a prompt-injection test guarding it. Ref: `agent_loop.py:1288-1307`, `tests/test_skill_index_prompt_injection.py`.
4. **Dedup-at-creation + scheduled necessity/audit pass** — on create, reject near-duplicates (**Jaccard ≥ ~0.82**, `skills.py:327-350`); a scheduled audit records a verdict/necessity per skill so an auto-growing library doesn't rot (`skills_routes.py:1035`).

## How it maps onto Maestro / superpowers

- **Teacher = an Opus Maestro agent; student = a cheaper/local Maestro agent.** Teacher-escalation is just a Maestro hand-off: on student failure, the supervisor spawns an owned Opus agent whose job is to write one draft `SKILL.md`, then re-runs the student turn with that skill now present. Reuses the Phase 1 supervisor and Phase 3's input-aware **sandbox permission policy** (skill writes go only to the skills dir; escalate elsewhere).
- **Format = existing superpowers `SKILL.md`** (`--- name / description ---` frontmatter + `## When to Use / ## Procedure / ## Pitfalls / ## Verification` body). We **reuse** it verbatim. The only additions are a few **optional** frontmatter fields the loop needs (`status: draft|published`, `confidence: 0..1`, `source: learned|taught`, `teacher_model`, `created`) — purely additive, ignored by the human-written skills.
- **Invocation = unchanged.** Skills are still discovered by directory scan and invoked via the `Skill` tool / progressive disclosure. Relevance-injection is an *additive middle tier*, not a replacement.
- **Storage = the existing superpowers skills directory** (`~/.claude/skills/`, per the writing-skills convention). Auto-authored skills land there as `status: draft`; promotion to `published` is the gate for them to surface like a normal skill.

## Sketch of the pieces

- **Where skills get written:** a small **skill-authoring service** invoked by Maestro's supervisor at two hooks — (a) **post-run**, when a completed agent turn had ≥2 tool calls → run the extract prompt; (b) **on-failure**, when a student agent reports failure → spawn the Opus teacher. Both write a `status: draft` `SKILL.md` into the superpowers dir via an atomic write, after the dedup check.
- **Extract prompt (post-success):** input = the run trace (user goal + tool calls + outcome); output = a single `SKILL.md` body + a `confidence` score. Discard if `confidence < 0.6` or dedup Jaccard ≥ 0.82 against an existing skill. Writes `source: learned`.
- **Teacher prompt (on-failure):** input = the failed trace + error; output = a portable `SKILL.md` draft (the PORTABILITY rules: no machine-specific hosts/paths). Writes `source: taught`, `teacher_model: claude-opus-*`. The student's next turn picks it up via relevance-injection.
- **Relevance injector:** a turn-time step that Jaccard-matches the message, pulls top-N full draft+published procedures, and emits them as one `trusted=false` untrusted-context message.
- **Dedup + audit:** dedup at create-time; a scheduled (cron) audit pass LLM-reviews each skill for necessity/correctness and records a verdict, surfacing rot-candidates for human/auto pruning.

## Out of scope (the format/storage port)

- **Do NOT port** Odysseus' `SKILL.md` schema, its self-rolled minimal YAML parser, the `_usage.json` sidecar, the `data/skills/` registry layout, the `manage_skills` tool, the legacy `skills.json` back-compat, or the **GitHub bundle importer** (`skill_importer.py`). All redundant with superpowers / the `Skill` tool.
- No seed/catalog: like Odysseus, the auto-authored library is **100% grown at runtime**; we ship zero auto-skills.
- No new multi-user ownership model (Seraphine is single-user); skip the owner-scoping machinery.

## Open questions

1. **Promotion policy:** do `status: draft` skills auto-surface to the human-facing `Skill` list, or only via relevance-injection until a human (or the audit pass) promotes them to `published`? Leaning: drafts are relevance-inject-only; publish is the gate.
2. **Where the extract/teacher LLM call runs:** inside Maestro (Rust supervisor spawns a headless authoring agent) vs. a Python sidecar reusing Seraphine's LLM client. Maestro-native is cleaner given teacher = an owned agent already.
3. **Untrusted-injection mechanics in this harness:** the superpowers `Skill` flow assumes trusted skill bodies; auto-authored bodies are not. Need to confirm where a `trusted=false` envelope can be injected in the Maestro agent loop without fighting the harness's own skill plumbing.
4. **Confidence calibration:** is a single self-reported `confidence` from the extract prompt trustworthy enough to gate at 0.6, or do we want a cheap second-pass check before a draft is written?
5. **Sandbox boundary for skill writes:** confirm the Phase 3 input-aware policy cleanly allows writes to the skills dir while still escalating everything else — including blocking a malicious auto-skill from rewriting *other* skills or the loop's own code.
6. **Audit cadence + pruning authority:** how often the necessity pass runs, and whether it may auto-delete (vs. only flag) low-necessity/failed-audit skills.
