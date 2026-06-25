from fastapi import FastAPI
from fastapi.testclient import TestClient
from llm_adapters.engine import describe_engine
from seraphine.llm.routes import router


def _app(info=None):
    app = FastAPI()
    app.include_router(router)
    if info is not None:
        app.state.engine_info = info
    return app


def test_engine_info_route():
    info = describe_engine(backend="openai", model="gemma", base_url="http://localhost:1234")
    client = TestClient(_app(info))
    r = client.get("/llm/engine")
    assert r.status_code == 200
    body = r.json()
    assert body["is_local"] is True and body["name"] == "Local (MLX/LM Studio)" and body["model"] == "gemma"


def test_engine_info_fallback_when_unset():
    client = TestClient(_app(None))
    r = client.get("/llm/engine")
    assert r.status_code == 200 and r.json()["name"] == "unknown"
