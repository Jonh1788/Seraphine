from llm_adapters.engine import EngineInfo, InferenceEngine, describe_engine


def test_anthropic_cloud():
    e = describe_engine(backend="anthropic", model="claude-haiku", base_url="https://api.anthropic.com")
    assert isinstance(e, EngineInfo)
    assert e.name == "Claude" and e.backend == "anthropic"
    assert not e.is_local and not e.is_flat_cost and e.supports_tools and e.supports_vision


def test_cliproxy_is_local_flat():
    e = describe_engine(backend="anthropic", model="x", base_url="http://127.0.0.1:8317")
    assert e.backend == "cliproxy" and e.name == "Claude (cliproxy)"
    assert e.is_local and e.is_flat_cost


def test_claude_max_flat_not_local():
    e = describe_engine(backend="claude_max", model="x", base_url="https://api.anthropic.com")
    assert e.is_flat_cost and not e.is_local and e.name == "Claude Max"


def test_openai_local():
    e = describe_engine(backend="openai", model="gemma", base_url="http://localhost:1234")
    assert e.is_local and e.is_flat_cost and e.supports_tools and not e.supports_vision
    assert e.name == "Local (MLX/LM Studio)"


def test_ollama_local():
    e = describe_engine(backend="ollama", model="llama", base_url="http://localhost:11434")
    assert e.is_local and e.is_flat_cost


def test_apple_fm():
    e = describe_engine(backend="apple_fm", model="apple-fm")
    assert e.is_local and e.is_flat_cost and not e.supports_tools and not e.supports_vision
    assert e.name == "Apple FM"


def test_runtime_checkable():
    class Good:
        async def chat(self, messages, **kw): ...
        async def aclose(self): ...

    class Bad:
        async def chat(self, messages, **kw): ...

    assert isinstance(Good(), InferenceEngine)
    assert not isinstance(Bad(), InferenceEngine)
