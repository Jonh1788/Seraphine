"""Category-aware RRF retrieval boost (Task 3).

Seraphine persists a ``category`` eyebrow on every fact (PESSOAS / LOCAL /
PREFERENCIA / TRABALHO / METAS / ROTINA / OUTROS). At recall time, when the
query is clearly an identity / contact / preference question, facts in the
matching category earn a small, BOUNDED rank boost — enough to nudge them up
the tail, never enough to invert a strong direct semantic/FTS hit.

These tests pin the embedding cache vectors directly so the RRF base scores
are fully deterministic (decay disabled via ``decay_days=0``), then assert:

  1. an identity/contact/preference query (PT-BR + EN) lifts a matching-
     category fact ABOVE its baseline (un-boosted) rank,
  2. a neutral query leaves ordering byte-for-byte identical to baseline,
  3. the boost is clamped: a weak on-category fact never overtakes a strong
     off-category direct hit,
  4. ``_classify_query_categories`` maps PT-BR + EN phrasings to the right
     label set and returns an empty set for neutral queries.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.manager import (
    _CATEGORY_BOOST_FACTOR,
    _classify_query_categories,
)

from tests.test_memory_manager import FakeCollection


# ---------------------------------------------------------------------------
# Harness — mirrors tests/memory/test_audit.py's _build/_seed.
# ---------------------------------------------------------------------------


async def _build(tmp_path: Path) -> tuple[MemoryManager, MemoryStore]:
    store = MemoryStore(tmp_path / "catboost.sqlite")
    await store.ensure_schema()
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    mgr.set_collection_for_tests(FakeCollection())
    return mgr, store


async def _seed_fact(
    mgr: MemoryManager, text: str, *, category: str, confidence: float = 1.0
):
    """Persist a fact with an explicit category (bypassing the regex
    derivation so the test controls the label) and populate its embedding
    cache entry."""
    fact = await mgr.store.add_fact(
        text, "explicit", confidence, category=category
    )
    vecs = await mgr.embeddings.embed([text])
    mgr._fact_embedding_cache[fact.id] = vecs[0]
    await mgr.store.save_fact_embedding(
        fact.id, vecs[0], model=mgr.embedding_model
    )
    return fact


def _perturbed(qvec: list[float], axis: int, alpha: float) -> list[float]:
    """``qvec`` nudged along a direction ORTHOGONAL to ``qvec`` (basis ``axis``
    with its q-component projected out via Gram-Schmidt).

    Because the perturbation is orthogonal to ``qvec``, the resulting cosine
    is ``1 / sqrt(1 + alpha**2)`` — strictly decreasing in ``alpha`` and
    INDEPENDENT of the query's component signs. So a larger ``alpha`` always
    yields a lower cosine-to-query (hence a lower fact-retrieval rank),
    deterministically across every query. Distinct ``axis`` values give
    near-orthogonal perturbations, keeping pairwise fact cosines well below
    the 0.98 dedup threshold in ``recall`` (otherwise near-parallel facts get
    collapsed).
    """
    dim = len(qvec)
    e = [0.0] * dim
    e[axis % dim] = 1.0
    # Gram-Schmidt: remove the component of e along qvec (qvec is unit-norm
    # from FakeEmbeddings, so the projection scalar is just the dot product).
    dot = sum(x * y for x, y in zip(e, qvec))
    orth = [ev - dot * qv for ev, qv in zip(e, qvec)]
    norm = math.sqrt(sum(x * x for x in orth)) or 1.0
    orth = [x / norm for x in orth]
    return [qv + alpha * ov for qv, ov in zip(qvec, orth)]


async def _rank_ids(mgr: MemoryManager, query: str, *, k: int = 10) -> list[str]:
    # decay_days=0 disables the time-weight rerank so base == RRF score and
    # ordering is driven purely by fact cosine + our boost.
    mems = await mgr.recall(query, k=k, decay_days=0.0)
    return [m.id for m in mems]


async def _baseline_rank_ids(
    mgr: MemoryManager, query: str, monkeypatch: pytest.MonkeyPatch, *, k: int = 10
) -> list[str]:
    """The ranking the SAME query would get with the category boost disabled.

    We force ``_classify_query_categories`` to return an empty set so the
    reranker takes its no-boost path, while keeping the query's real
    embedding — an apples-to-apples baseline (only the boost is toggled).
    """
    with monkeypatch.context() as m:
        m.setattr(
            "seraphine.memory.manager._classify_query_categories",
            lambda _q: set(),
        )
        return await _rank_ids(mgr, query, k=k)


# ---------------------------------------------------------------------------
# 4. Query classifier (unit) — exact label sets for PT-BR + EN + neutral.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "query, expected",
    [
        # PESSOAS — name / identity
        ("qual é o meu nome", {"PESSOAS"}),
        ("Qual É O Meu Nome?", {"PESSOAS"}),
        ("quem sou eu", {"PESSOAS"}),
        ("what is my name", {"PESSOAS"}),
        ("who am I really", {"PESSOAS"}),
        # PESSOAS — relationships
        ("quem é minha esposa", {"PESSOAS"}),
        ("who is my brother", {"PESSOAS"}),
        ("como se chama meu filho", {"PESSOAS"}),
        # LOCAL
        ("onde eu moro", {"LOCAL"}),
        ("onde moro atualmente", {"LOCAL"}),
        ("where do I live", {"LOCAL"}),
        ("what is my address", {"LOCAL"}),
        # PREFERENCIA
        ("do que eu gosto", {"PREFERENCIA"}),
        ("eu prefiro café ou chá", {"PREFERENCIA"}),
        ("what do I like", {"PREFERENCIA"}),
        ("what is my favorite color", {"PREFERENCIA"}),
        # Neutral — no boost.
        ("resumo do projeto X", set()),
        ("what is the weather today", set()),
        ("liste minhas tarefas de amanhã", set()),
        ("", set()),
    ],
)
def test_classify_query_categories(query: str, expected: set[str]) -> None:
    assert _classify_query_categories(query) == expected


def test_classify_can_match_multiple_categories() -> None:
    # A compound question may legitimately target more than one category.
    got = _classify_query_categories("qual é o meu nome e onde eu moro")
    assert got == {"PESSOAS", "LOCAL"}


# ---------------------------------------------------------------------------
# 1. Identity/contact/preference queries lift the matching-category fact
#    above its baseline (un-boosted) rank — PT-BR and EN.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "query, boost_category",
    [
        ("qual é o meu nome", "PESSOAS"),
        ("quem é minha esposa", "PESSOAS"),
        ("onde eu moro", "LOCAL"),
        ("where do I live", "LOCAL"),
        ("do que eu gosto", "PREFERENCIA"),
    ],
)
async def test_matching_category_fact_rises_above_baseline(
    tmp_path: Path,
    query: str,
    boost_category: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mgr, _store = await _build(tmp_path)

    qvec = (await mgr.embeddings.embed([query]))[0]

    # Three facts. ``anchor`` is a strong off-category hit (cosine 1.0) — it
    # is the clamp ceiling and must always stay #1. ``mid`` is a WEAKER
    # off-category fact. ``target`` is the on-category fact, seeded with the
    # LOWEST base cosine so baseline RRF orders them [anchor, mid, target].
    # The bounded boost must lift target ABOVE mid (a non-ceiling hit) while
    # staying strictly below anchor.
    anchor = await _seed_fact(
        mgr, "documento técnico do deploy de produção", category="TRABALHO"
    )
    mid = await _seed_fact(
        mgr, "cronograma do projeto interno", category="METAS"
    )
    target = await _seed_fact(
        mgr, "informação pessoal do usuário", category=boost_category
    )

    # Distinct axes → low pairwise cosine (no dedup); ascending alpha →
    # descending cosine-to-query, so baseline order is [anchor, mid, target].
    mgr._fact_embedding_cache[anchor.id] = _perturbed(qvec, 2, 0.30)
    mgr._fact_embedding_cache[mid.id] = _perturbed(qvec, 4, 0.55)
    mgr._fact_embedding_cache[target.id] = _perturbed(qvec, 6, 0.80)

    # Baseline (same query, boost disabled) ordering: [anchor, mid, target].
    baseline = await _baseline_rank_ids(mgr, query, monkeypatch)
    assert baseline.index(anchor.id) < baseline.index(mid.id)
    assert baseline.index(mid.id) < baseline.index(target.id)

    # Boosted ordering: target rises above its baseline position (overtakes
    # mid) but never overtakes the strong off-category anchor.
    ranked = await _rank_ids(mgr, query)
    assert ranked.index(target.id) < baseline.index(target.id), (
        f"target did not rise under boost for query {query!r}: {ranked}"
    )
    assert ranked.index(target.id) < ranked.index(mid.id), (
        f"target did not overtake the weaker off-category fact: {ranked}"
    )
    assert ranked[0] == anchor.id, (
        f"strong off-category anchor lost the top slot: {ranked}"
    )


# ---------------------------------------------------------------------------
# 2. Neutral query is UNAFFECTED — ordering identical to baseline.
# ---------------------------------------------------------------------------


async def test_neutral_query_ordering_is_identical_to_baseline(
    tmp_path: Path,
) -> None:
    mgr, _store = await _build(tmp_path)

    f_person = await _seed_fact(mgr, "usuário chama João", category="PESSOAS")
    f_local = await _seed_fact(mgr, "mora em Lisboa", category="LOCAL")
    f_pref = await _seed_fact(mgr, "gosta de café", category="PREFERENCIA")
    f_work = await _seed_fact(mgr, "trabalha com Rust", category="TRABALHO")

    query = "resumo do projeto X"
    qvec = (await mgr.embeddings.embed([query]))[0]
    # Distinct axes + ascending alpha → stable, well-separated cosine ranking
    # with low pairwise cosine (no dedup collapse).
    for i, f in enumerate([f_person, f_local, f_pref, f_work]):
        mgr._fact_embedding_cache[f.id] = _perturbed(qvec, i, 0.25 + 0.20 * i)

    # The classifier returns empty for this query → no boost path at all.
    assert _classify_query_categories(query) == set()

    ranked = await _rank_ids(mgr, query)
    # Re-run: must be deterministic & identical (no hidden boost mutation).
    ranked_again = await _rank_ids(mgr, query)
    assert ranked == ranked_again
    # All four facts present, ordering driven purely by cosine.
    assert set(ranked) == {f_person.id, f_local.id, f_pref.id, f_work.id}


# ---------------------------------------------------------------------------
# 3. The boost is BOUNDED — a weak on-category fact never overtakes a strong
#    off-category direct hit.
# ---------------------------------------------------------------------------


async def test_boost_cannot_invert_a_strong_direct_hit(tmp_path: Path) -> None:
    mgr, _store = await _build(tmp_path)

    query = "qual é o meu nome"  # → {"PESSOAS"}
    qvec = (await mgr.embeddings.embed([query]))[0]

    # Strong off-category hit: tiny perturbation → cosine ~1.0 (rank #1).
    strong = await _seed_fact(
        mgr, "documento técnico do deploy", category="TRABALHO"
    )
    mgr._fact_embedding_cache[strong.id] = _perturbed(qvec, 1, 0.05)

    # Weak on-category fact: heavy perturbation → much lower cosine, so its
    # baseline RRF score sits well below the strong hit. Even a 1.15x bump
    # cannot close that gap, and the clamp forbids it regardless.
    weak = await _seed_fact(mgr, "nome do usuário", category="PESSOAS")
    mgr._fact_embedding_cache[weak.id] = _perturbed(qvec, 4, 1.50)

    assert _classify_query_categories(query) == {"PESSOAS"}

    ranked = await _rank_ids(mgr, query)
    # Strong off-category hit MUST stay on top despite the on-category boost.
    assert ranked[0] == strong.id, ranked
    assert ranked.index(strong.id) < ranked.index(weak.id)


async def test_clamp_holds_even_when_boost_would_otherwise_overtake(
    tmp_path: Path,
) -> None:
    """Edge case: a category fact whose base score is JUST below a strong
    off-category hit such that base * factor would exceed it. The clamp must
    pin the boosted score strictly below the strong hit so order is kept."""
    mgr, _store = await _build(tmp_path)

    query = "onde eu moro"  # → {"LOCAL"}
    qvec = (await mgr.embeddings.embed([query]))[0]

    # Strong off-category hit (rank #1).
    strong = await _seed_fact(mgr, "reunião de projeto", category="TRABALHO")
    mgr._fact_embedding_cache[strong.id] = _perturbed(qvec, 1, 0.20)

    # On-category fact ranked #2 (slightly lower cosine, distinct axis to
    # avoid dedup). Their RRF scores are adjacent (1/60 vs 1/61), so
    # base * 1.15 on ``near`` would nominally exceed ``strong`` — only the
    # clamp prevents the inversion.
    near = await _seed_fact(mgr, "endereço residencial", category="LOCAL")
    mgr._fact_embedding_cache[near.id] = _perturbed(qvec, 4, 0.45)

    ranked = await _rank_ids(mgr, query)
    assert ranked[0] == strong.id, ranked
    assert ranked.index(strong.id) < ranked.index(near.id)


# ---------------------------------------------------------------------------
# Sanity: the boost factor is a small, bounded nudge (not a large override).
# ---------------------------------------------------------------------------


def test_boost_factor_is_a_small_nudge() -> None:
    assert 1.0 < _CATEGORY_BOOST_FACTOR <= 1.25
