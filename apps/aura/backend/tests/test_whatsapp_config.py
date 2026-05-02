"""Settings-level smoke for the new WhatsApp env vars.

Import ``aura.config`` lazily inside each test (and reload it after env
mutation) so a stale module-level ``settings`` instance is never shared
across tests — otherwise `aura.auth.routes`, which captures
`settings` at import time, would sign JWTs with whichever secret leaked
into the first import. That bites every later test that uses a
different `AURA_JWT_SECRET`.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path


def _fresh_settings_class():
    """Reload aura.config so .env / env vars are re-read, then return
    the Settings class bound to the freshly-loaded module."""
    if "aura.config" in sys.modules:
        importlib.reload(sys.modules["aura.config"])
    import aura.config as cfg  # noqa: WPS433
    return cfg.Settings


def test_evolution_settings_default_to_empty(monkeypatch, tmp_path):
    monkeypatch.setenv("AURA_SQLITE_PATH", str(tmp_path / "x.db"))
    Settings = _fresh_settings_class()
    s = Settings(_env_file=None)
    assert s.evolution_base_url == ""
    assert s.evolution_api_key == ""
    assert s.evolution_instance == ""
    assert s.evolution_webhook_token == ""
    assert s.whatsapp_admin_token == ""
    assert s.whatsapp_configured is False


def test_whatsapp_configured_helper(monkeypatch, tmp_path):
    monkeypatch.setenv("AURA_SQLITE_PATH", str(tmp_path / "x.db"))
    monkeypatch.setenv("AURA_EVOLUTION_BASE_URL", "http://e:8080")
    monkeypatch.setenv("AURA_EVOLUTION_API_KEY", "k")
    monkeypatch.setenv("AURA_EVOLUTION_INSTANCE", "main")
    monkeypatch.setenv("AURA_EVOLUTION_WEBHOOK_TOKEN", "w")
    Settings = _fresh_settings_class()
    s = Settings(_env_file=None)
    assert s.whatsapp_configured is True


def test_whatsapp_configured_false_when_any_required_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("AURA_SQLITE_PATH", str(tmp_path / "x.db"))
    monkeypatch.setenv("AURA_EVOLUTION_BASE_URL", "http://e:8080")
    monkeypatch.setenv("AURA_EVOLUTION_API_KEY", "k")
    monkeypatch.setenv("AURA_EVOLUTION_INSTANCE", "main")
    # webhook_token missing
    Settings = _fresh_settings_class()
    s = Settings(_env_file=None)
    assert s.whatsapp_configured is False


def test_app_boots_without_whatsapp_configured(monkeypatch, tmp_path):
    """The lifespan must not require WhatsApp env vars; app boots with
    whatsapp_service = None and /whatsapp/* returns 503."""
    monkeypatch.setenv("AURA_SQLITE_PATH", str(tmp_path / "x.db"))
    # Reload aura.config so settings reflect the test env, then reload
    # aura.main so its captured `settings` reference is fresh too.
    if "aura.config" in sys.modules:
        importlib.reload(sys.modules["aura.config"])
    if "aura.main" in sys.modules:
        importlib.reload(sys.modules["aura.main"])
    from aura.main import create_app
    app = create_app()
    # Verify the router is mounted even when WA is not configured.
    paths = {r.path for r in app.routes}
    assert "/whatsapp/webhook" in paths
    assert "/whatsapp/status" in paths


def test_app_boots_with_whatsapp_configured(monkeypatch, tmp_path):
    """When all four required Evolution env vars are set, the lifespan
    instantiates whatsapp_client + whatsapp_service onto app.state and
    /whatsapp/status (JWT-protected) returns 401, not 503."""
    monkeypatch.setenv("AURA_SQLITE_PATH", str(tmp_path / "x.db"))
    monkeypatch.setenv("AURA_EVOLUTION_BASE_URL", "http://e:8080")
    monkeypatch.setenv("AURA_EVOLUTION_API_KEY", "k")
    monkeypatch.setenv("AURA_EVOLUTION_INSTANCE", "main")
    monkeypatch.setenv("AURA_EVOLUTION_WEBHOOK_TOKEN", "w")

    # Mirror the reload pattern used by the other tests in this file
    # (auth/routes.py captures `settings` at module load, so reloading
    # aura.config + aura.main is required for env changes to land).
    import importlib
    import aura.config as cfg
    importlib.reload(cfg)
    import aura.main as main_mod
    importlib.reload(main_mod)

    from fastapi.testclient import TestClient
    app = main_mod.create_app()
    with TestClient(app) as client:
        assert app.state.whatsapp_service is not None
        assert app.state.whatsapp_client is not None
        # /whatsapp/status is JWT-protected; without auth → 401, not 503.
        resp = client.get("/whatsapp/status")
        assert resp.status_code == 401
