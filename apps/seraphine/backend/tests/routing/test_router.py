from seraphine.routing.router import (
    classify_complexity, RouteInputs, RouterConfig, select_model,
)


def _cfg(**kw):
    base = dict(fast_model="claude-haiku-4-5", smart_model="claude-sonnet-4-6",
               local_backend=False, daily_cap_usd=5.0, metered_spend_today=0.0)
    base.update(kw)
    return RouterConfig(**base)


def test_classify_simple_short_chat():
    assert classify_complexity(RouteInputs(prompt="oi tudo bem?", think=False,
        has_images=False, tool_iteration=0)) == "simple"


def test_classify_complex_on_think():
    assert classify_complexity(RouteInputs(prompt="x", think=True,
        has_images=False, tool_iteration=0)) == "complex"


def test_classify_complex_on_images():
    assert classify_complexity(RouteInputs(prompt="x", think=False,
        has_images=True, tool_iteration=0)) == "complex"


def test_classify_moderate_on_tool_iteration():
    assert classify_complexity(RouteInputs(prompt="x", think=False,
        has_images=False, tool_iteration=1)) == "moderate"


def test_classify_complex_on_long_prompt_with_code():
    p = "```python\n" + ("a = 1\n" * 60) + "```\nrefatora isso pra mim por favor"
    assert classify_complexity(RouteInputs(prompt=p, think=False,
        has_images=False, tool_iteration=0)) == "complex"


def test_select_simple_uses_fast_default_returns_none():
    assert select_model("simple", _cfg()) is None


def test_select_complex_escalates_to_smart():
    assert select_model("complex", _cfg()) == "claude-sonnet-4-6"


def test_select_smart_disabled_returns_none():
    assert select_model("complex", _cfg(smart_model="")) is None


def test_cost_guard_blocks_metered_escalation_over_cap():
    assert select_model("complex", _cfg(metered_spend_today=6.0)) is None


def test_cost_guard_allows_escalation_under_cap():
    assert select_model("complex", _cfg(metered_spend_today=1.0)) == "claude-sonnet-4-6"


def test_cost_guard_disabled_when_cap_zero():
    assert select_model("complex", _cfg(daily_cap_usd=0.0, metered_spend_today=999.0)) == "claude-sonnet-4-6"


def test_local_backend_never_escalates_to_cloud():
    assert select_model("complex", _cfg(local_backend=True, smart_model="")) is None
