import pytest

from aura.alexa.intents import dispatch, build_response, to_ssml


def test_to_ssml_wraps_and_escapes():
    assert to_ssml("hi & bye") == "<speak>hi &amp; bye</speak>"
    assert to_ssml("<a>") == "<speak>&lt;a&gt;</speak>"


def test_build_response_shape():
    r = build_response(speech="Olá", end_session=False)
    assert r["version"] == "1.0"
    assert r["response"]["outputSpeech"]["type"] == "SSML"
    assert r["response"]["outputSpeech"]["ssml"] == "<speak>Olá</speak>"
    assert r["response"]["shouldEndSession"] is False


def test_build_response_link_account_card():
    r = build_response(speech="Vincule sua conta", end_session=True, link_account=True)
    assert r["response"]["card"] == {"type": "LinkAccount"}


class FakeService:
    async def process_query(self, *, user_id, session_id, query_text):
        return f"echo {query_text}"


@pytest.mark.asyncio
async def test_dispatch_launch_request():
    env = {"request": {"type": "LaunchRequest"}, "session": {"sessionId": "s1"}}
    r = await dispatch(svc=FakeService(), envelope=env, user_id="u1")
    assert r["response"]["shouldEndSession"] is False
    assert "aura" in r["response"]["outputSpeech"]["ssml"].lower()


@pytest.mark.asyncio
async def test_dispatch_perguntar_intent():
    env = {
        "request": {
            "type": "IntentRequest",
            "intent": {"name": "PerguntarIntent", "slots": {"query": {"value": "agenda de hoje"}}},
        },
        "session": {"sessionId": "s1"},
    }
    r = await dispatch(svc=FakeService(), envelope=env, user_id="u1")
    assert "echo agenda de hoje" in r["response"]["outputSpeech"]["ssml"]
    assert r["response"]["shouldEndSession"] is False


@pytest.mark.asyncio
async def test_dispatch_stop_intent_ends_session():
    env = {
        "request": {"type": "IntentRequest", "intent": {"name": "AMAZON.StopIntent"}},
        "session": {"sessionId": "s1"},
    }
    r = await dispatch(svc=FakeService(), envelope=env, user_id="u1")
    assert r["response"]["shouldEndSession"] is True


@pytest.mark.asyncio
async def test_dispatch_unknown_intent_falls_back():
    env = {
        "request": {"type": "IntentRequest", "intent": {"name": "UnknownIntent"}},
        "session": {"sessionId": "s1"},
    }
    r = await dispatch(svc=FakeService(), envelope=env, user_id="u1")
    assert r["response"]["shouldEndSession"] is False
    assert "não entendi" in r["response"]["outputSpeech"]["ssml"].lower()
