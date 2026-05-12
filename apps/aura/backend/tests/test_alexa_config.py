from aura.config import Settings


def test_alexa_configured_false_when_missing(monkeypatch):
    for var in (
        "AURA_ALEXA_SKILL_ID",
        "AURA_ALEXA_CLIENT_ID",
        "AURA_ALEXA_CLIENT_SECRET",
        "AURA_ALEXA_VENDOR_ID",
    ):
        monkeypatch.delenv(var, raising=False)
    s = Settings()
    assert s.alexa_configured is False


def test_alexa_configured_true_when_all_set(monkeypatch):
    monkeypatch.setenv("AURA_ALEXA_SKILL_ID", "amzn1.ask.skill.fake")
    monkeypatch.setenv("AURA_ALEXA_CLIENT_ID", "cid")
    monkeypatch.setenv("AURA_ALEXA_CLIENT_SECRET", "csecret")
    monkeypatch.setenv("AURA_ALEXA_VENDOR_ID", "M2AO04EAJRY9HC")
    s = Settings()
    assert s.alexa_configured is True
    assert s.alexa_skill_id == "amzn1.ask.skill.fake"
    assert s.alexa_client_id == "cid"
    assert s.alexa_client_secret == "csecret"
    assert s.alexa_vendor_id == "M2AO04EAJRY9HC"
    assert s.alexa_oauth_issuer == "https://app.minha-aura.com"
