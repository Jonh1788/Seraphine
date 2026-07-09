import seraphine.learning.evaluator as ev
from seraphine.learning.evaluator import EvalResult, evaluate_policy_repeated


async def test_repeated_averages_scores(monkeypatch):
    scores = iter([0.8, 0.9])

    async def _fake(llm_call, **kwargs):
        return EvalResult(score=next(scores), per_case=[{"id": "x", "score": 0.0}], n=1)

    monkeypatch.setattr(ev, "evaluate_policy", _fake)
    out = await evaluate_policy_repeated(
        None, behavior_addendum="", tool_guidance="", eval_cases=[{"id": "c"}], repeats=2,
    )
    assert abs(out.score - 0.85) < 1e-9  # mean of 0.8 and 0.9


async def test_repeated_one_is_single(monkeypatch):
    calls = {"n": 0}

    async def _fake(llm_call, **kwargs):
        calls["n"] += 1
        return EvalResult(score=0.7, per_case=[], n=0)

    monkeypatch.setattr(ev, "evaluate_policy", _fake)
    out = await evaluate_policy_repeated(
        None, behavior_addendum="", tool_guidance="", eval_cases=[{"id": "c"}], repeats=1,
    )
    assert out.score == 0.7 and calls["n"] == 1


async def test_repeated_clamps_repeats_to_min_one(monkeypatch):
    calls = {"n": 0}

    async def _fake(llm_call, **kwargs):
        calls["n"] += 1
        return EvalResult(score=0.5, per_case=[], n=0)

    monkeypatch.setattr(ev, "evaluate_policy", _fake)
    await evaluate_policy_repeated(
        None, behavior_addendum="", tool_guidance="", eval_cases=[{"id": "c"}], repeats=0,
    )
    assert calls["n"] == 1  # repeats<1 clamped to 1
