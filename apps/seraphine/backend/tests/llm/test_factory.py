from types import SimpleNamespace

from seraphine.llm.factory import build_engine
from llm_adapters.client import OllamaClient, OpenAICompatClient
from llm_adapters.apple_fm import AppleFoundationModelsClient
from llm_adapters.anthropic import AnthropicClient


def _settings(**kw):
    base = dict(llm_backend="openai", llm_base_url="http://localhost:1234", llm_model="gemma",
                ollama_base_url="http://localhost:11434", anthropic_api_key="k",
                anthropic_model="claude-haiku", anthropic_base_url="http://127.0.0.1:8317")
    base.update(kw)
    return SimpleNamespace(**base)


def test_openai_backend():
    e, info = build_engine(_settings(llm_backend="openai"))
    assert isinstance(e, OpenAICompatClient) and info.backend == "openai" and info.is_local


def test_ollama_backend():
    e, info = build_engine(_settings(llm_backend="ollama"))
    assert isinstance(e, OllamaClient) and info.backend == "ollama"


def test_apple_fm_backend():
    e, info = build_engine(_settings(llm_backend="apple_fm"))
    assert isinstance(e, AppleFoundationModelsClient) and info.name == "Apple FM"


def test_anthropic_cliproxy_forwards_telemetry():
    def sink(rec):
        return None

    e, info = build_engine(_settings(llm_backend="anthropic"), telemetry=sink)
    assert isinstance(e, AnthropicClient) and info.backend == "cliproxy"
    assert e._telemetry is sink


def test_unknown_backend_falls_through_to_ollama():
    e, info = build_engine(_settings(llm_backend="weird"))
    assert isinstance(e, OllamaClient)
