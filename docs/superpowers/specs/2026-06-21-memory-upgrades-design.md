# Memory Upgrades — Design Spec

**Status:** Future — not scheduled
**Date:** 2026-06-21
**Scope:** `apps/seraphine/backend/seraphine/memory/` (`store.py`, `manager.py`, `embeddings.py`)

## Vision / scope

Seraphine's memory (SQLite facts + `fact_embeddings` BLOBs + FTS5 over `turns` + Chroma turn/window vectors, fused via RRF in `manager.recall()` ~L347) is already more capable than the Odysseus reference and **stays as-is**. This spec ports only the four genuinely-better ideas from Odysseus (`/tmp/ds/odysseus__memory.md`) that close real gaps: identity facts falling out of top-k, no whole-store consolidation pass, an unused `category` signal, and unguarded memory injection. No store swap, no fusion rewrite.

## The 4 upgrades

### 1. Pinned identity facts + always-injected "core facts" block

**What.** A `pinned BOOLEAN` (INTEGER 0/1) on `facts`. Identity-class facts (name, location, core relationships, durable preferences) are auto-pinned on write. Pinned facts are **always** prepended to context as a "Core facts about the user" block, independent of query similarity, so identity never depends on landing in top-k.

**Odysseus ref.** Auto-pin of identity facts (`memory_extractor.py:442`); always-injected pinned block separate from RAG-retrieved (`chat_processor.py:211-224`, `build_context_preface` @206).

**Seraphine integration point.**
- *Table column:* new idempotent migrator `_seraphine_facts_pinned_migrator` (clone `_seraphine_facts_category_migrator`, `store.py:426`), registered after `seraphine_facts_category`. `ALTER TABLE facts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`; backfill rows where `category = 'PESSOAS'/'LOCAL'` or identity-regex matches `text`. Add `pinned` to the `Fact` model (`store.py:92`) and to every `SELECT … FROM facts` projection. Add `store.list_pinned_facts()` and `store.set_fact_pinned(id, bool)`; auto-set `pinned` in `add_fact` for identity categories.
- *Recall path / injection:* pinned facts bypass `recall()` ranking — fetch them directly via `list_pinned_facts()` at context-build time and emit a dedicated block, distinct from the RRF top-k. Exclude already-injected pinned IDs from the RRF result to avoid duplication.

### 2. Scheduled consolidation / audit job

**What.** A periodic LLM pass over **all** active facts that merges paraphrases and drops junk, gated by two safety mechanisms: (a) refuse any audit whose proposed deletions exceed 50% of the store; (b) a fingerprint short-circuit that skips the LLM call entirely when the fact set is unchanged since the last run.

**Odysseus ref.** `audit_memories` (`memory_extractor.py:487`), >50%-deletion guard (`:620`), fingerprint sidecar `memory_tidy_state.json` (run every `AUDIT_INTERVAL`).

**Seraphine integration point.**
- *Scheduled job:* a new maintenance coroutine in `manager.py` (sibling to `reflect()`), triggered on a schedule rather than per-turn. Reuse `store.list_facts_for_decay()` (active, non-superseded) as input.
- *Mechanics:* compute a fingerprint = hash of sorted `(id, text)` active facts; persist it in the existing `kv` table (`store.set_kv("memory_audit_fingerprint", …)`, `store.py:544`) — no sidecar file needed. Skip if unchanged. Merges use the existing `supersede_fact(old, new)` chain (not hard delete) so history is preserved; junk drops use `delete_fact` + `delete_fact_embedding`. Re-embed merged survivors via `embeddings.py` and refresh `_fact_embedding_cache`. Abort and log if proposed removals > 50% of active count. Respect existing dedup (cosine > 0.98) and contradiction logic — the audit is a coarser, whole-store complement to per-write dedup.

### 3. Category as an RRF retrieval-boost signal

**What.** Detect identity / contact / preference intent in the query and bump matching facts in the re-rank, using the `category` column Seraphine already persists but does not consult at retrieval.

**Odysseus ref.** Category-aware retrieval boosts for identity/contact/preference queries (`chat_processor.py:121-136`).

**Seraphine integration point.**
- *Recall path:* in `recall()` (`manager.py:347`), after RRF fusion and before/within the time-weight rerank (~L534-551). Add a lightweight query classifier (PT-BR + EN regex over the query → a target category set, e.g. "qual meu nome / where do I live / quem é" → `PESSOAS`/`LOCAL`/`PREFERENCIA`). For fact-kind entries (`meta.kind == "fact"`) whose `category` is in the target set, apply a small multiplicative or additive boost to the fused score. Requires surfacing `fact.category` into the fact `info[...]["metadata"]` map (populated `manager.py:512-521`). Boost is bounded so it nudges ordering without overriding strong semantic/FTS hits.

### 4. "Do not reference unless asked" + untrusted-framing guard

**What.** Injected memory is wrapped in an untrusted-content frame and carries an instruction not to volunteer it: the assistant uses memory only when the user's message is about those topics, mitigating over-eager recall and prompt-injection via stored text.

**Odysseus ref.** `untrusted_context_message` framing + "Memory context. Do not reference unless the user asks about these topics." (`chat_processor.py:233`).

**Seraphine integration point.**
- *Injection point:* at the context-assembly site that consumes `recall()` output (and the new pinned block from upgrade 1). Wrap both blocks as untrusted system context with the guard sentence. The pinned "core facts" block is always-on identity grounding; the retrieved block carries the "do not reference unless relevant" caveat. No schema change — prompt/wrapper layer only.

## What NOT to change

- **FTS5** over `turns.content` + sync triggers (`store.py:452`) — native `bm25()`, keep it. Do not port Odysseus' Python-side BM25.
- **RRF fusion** across vector turns/windows + FTS + fact-cosine (`manager.py:468-493`) — cleaner than Odysseus' weighted sum. Augment (category boost) but do not replace.
- **Vector / semantic recall** — fact-level cosine over `_fact_embedding_cache` (`manager.py:454-466`) and Chroma turn/window recall are not a gap. No new vector store, no Chroma-for-facts.
- **Fact store** — SQLite `facts` + `fact_embeddings` BLOBs stay; do not adopt Odysseus' JSON flat file.
- **Per-write dedup / contradiction / freshness** logic — the audit job complements, does not replace, these.

## Testing notes

- *Migrator:* `pinned` ALTER is idempotent across double-registration; backfill marks identity rows; `Fact` round-trips `pinned`. Existing-DB upgrade preserves rows.
- *Pinned injection:* pinned facts appear in context even when query is unrelated (the core regression this fixes); pinned IDs are not double-injected via RRF.
- *Audit job:* fingerprint short-circuit skips the LLM when facts unchanged; >50%-deletion proposal is refused and logged; merges go through `supersede_fact` (history intact); cache + embeddings re-synced after a merge. Use `FakeEmbeddings` + a stubbed LLM for determinism.
- *Category boost:* identity/contact/preference queries rank matching-category facts higher than baseline RRF; non-matching queries are unaffected; boost never inverts a strong FTS/vector hit (bounded). Cover PT-BR and EN phrasings.
- *Guard framing:* injected blocks carry the untrusted frame + guard sentence; assistant does not volunteer memory on off-topic turns (prompt-level behavioral check).

## Open questions

- Audit cadence: fixed cron (e.g. nightly) vs. count-triggered (every N new facts, à la Odysseus `AUDIT_INTERVAL`)? Leaning nightly given Seraphine already has per-write dedup.
- Which model runs the audit — local Ollama vs. the configured chat model? Cost/latency vs. merge quality.
- Auto-pin source of truth: category-derived only, or a dedicated identity classifier (and should the user be able to pin/unpin from the Memory view UI)?
- Query-classifier scope for upgrade 3: regex (fast, matches existing `_FACT_CATEGORY_RULES` style) vs. embedding-based intent — start with regex.
- Cap on the pinned block size to protect the KV-cache-stable system prefix if pinned facts grow large.
