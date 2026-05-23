import pytest
from seraphine.cv_triage.broadcaster import broadcast_frame


class FakeWS:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_json(self, data):
        self.sent.append(data)


@pytest.mark.asyncio
async def test_broadcast_to_all_clients():
    a, b = FakeWS(), FakeWS()
    await broadcast_frame({a, b}, {"type": "cv_triage_progress", "job_id": 1, "processed": 5})
    assert a.sent[0]["type"] == "cv_triage_progress"
    assert b.sent[0]["job_id"] == 1


@pytest.mark.asyncio
async def test_broadcast_swallows_per_client_errors():
    good = FakeWS()
    bad = object()  # has no send_json
    await broadcast_frame({good, bad}, {"type": "x"})
    assert good.sent == [{"type": "x"}]
