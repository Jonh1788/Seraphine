"""Phase 1d: every frame of ``/agents/ws`` carries ``boot`` and a per-connection ``seq``.

The numbers are given by the service when it queues a frame for a connection, so a frame
it drops for a slow connection still uses up its number and the page sees the gap.
"""

from __future__ import annotations

import time

from seraphine.agents.engines.fake import FakeEngine
from seraphine.agents.service import AgentHarnessService, LiveSub

from .conftest import ORIGIN, make_settings
from .test_ws import Env, env  # noqa: F401  (the fixture)


def _publish(env: Env, n: int, tag: str = "x") -> None:
    async def go() -> None:
        for i in range(n):
            env.svc._publish({"type": "probe", "tag": tag, "i": i})

    env.run(go)


def _frames(ws, n: int) -> list[dict]:
    return [ws.receive_json() for _ in range(n)]


def test_every_frame_has_boot_and_a_gap_free_seq_from_one(env: Env) -> None:
    with env.client.websocket_connect("/agents/ws", headers={"origin": ORIGIN}) as ws:
        env.auth(ws)
        ready = ws.receive_json()
        assert ready["type"] == "ready" and ready["seq"] == 1 and ready["boot"] == env.svc.boot_id
        env.wait_subs(1)
        _publish(env, 3)
        ws.send_text('{"type":"ping"}')
        got = [ready] + _frames(ws, 4)  # 3 probes + the pong (queued after them)
        time.sleep(0.5)  # idle: heartbeats follow (heartbeat_s = 0.2)
        ws.send_text('{"type":"ping"}')
        got += _frames(ws, 3)
        types = [f["type"] for f in got]
        assert types[:5] == ["ready", "probe", "probe", "probe", "pong"]
        assert "heartbeat" in types[5:] and types[-1] in ("pong", "heartbeat")
        assert [f["seq"] for f in got] == list(range(1, len(got) + 1))
        assert {f["boot"] for f in got} == {env.svc.boot_id}


def test_two_connections_are_numbered_independently(env: Env) -> None:
    with env.client.websocket_connect("/agents/ws") as a:
        env.auth(a)
        assert a.receive_json()["seq"] == 1
        env.wait_subs(1)
        _publish(env, 4)
        assert [f["seq"] for f in _frames(a, 4)] == [2, 3, 4, 5]
        with env.client.websocket_connect("/agents/ws") as b:
            env.auth(b)
            assert b.receive_json()["seq"] == 1  # its own count, not A's 5
            env.wait_subs(2)
            _publish(env, 2)
            assert [f["seq"] for f in _frames(b, 2)] == [2, 3]
            assert [f["seq"] for f in _frames(a, 2)] == [6, 7]
            b.close(1000)
            env.wait_subs(1)
        time.sleep(0.1)
        a.close(1000)
        env.wait_subs(0)


async def test_a_dropped_frame_still_uses_its_number_so_the_page_sees_a_gap(store) -> None:
    svc = AgentHarnessService(store, make_settings(), engines={"fake": FakeEngine()})
    svc.live_queue_max = 3
    sub, ready = svc.open_live()
    assert ready["seq"] == 1 and isinstance(sub, LiveSub)
    for i in range(6):  # nobody reads: the queue holds 3, the other 3 are dropped
        svc._publish({"type": "probe", "i": i})
    got = [sub.get_nowait() for _ in range(sub.qsize())]
    assert [f["seq"] for f in got] == [2, 3, 4]  # frames 5, 6, 7 were dropped
    svc._publish({"type": "probe", "i": 6})
    nxt = sub.get_nowait()
    assert nxt["seq"] == 8 and nxt["i"] == 6  # 4 -> 8: the missing 5..7 are the visible gap
    svc.close_live(sub)
    assert sub not in svc._global_subs


async def test_a_pong_that_cannot_be_queued_is_a_gap_too(store) -> None:
    svc = AgentHarnessService(store, make_settings(), engines={"fake": FakeEngine()})
    svc.live_queue_max = 1
    sub, _ = svc.open_live()
    svc._publish({"type": "probe"})  # fills the queue (seq 2)
    svc.live_pong(sub)  # dropped (seq 3)
    svc._publish({"type": "probe"})  # dropped (seq 4)
    assert sub.get_nowait()["seq"] == 2
    svc._publish({"type": "probe"})
    assert sub.get_nowait()["seq"] == 5


async def test_boot_is_stable_inside_a_process_and_new_for_a_new_service_instance(store) -> None:
    one = AgentHarnessService(store, make_settings(), engines={"fake": FakeEngine()})
    two = AgentHarnessService(store, make_settings(), engines={"fake": FakeEngine()})
    assert one.boot_id and two.boot_id and one.boot_id != two.boot_id
    first, ready1 = one.open_live()
    second, ready2 = one.open_live()
    other, ready3 = two.open_live()
    assert ready1["boot"] == ready2["boot"] == one.boot_id and ready3["boot"] == two.boot_id != one.boot_id
    assert first.boot == one.boot_id and other.boot == two.boot_id


async def test_ndjson_subscribers_and_plain_queues_get_unnumbered_frames(svc) -> None:
    import asyncio

    plain: asyncio.Queue = asyncio.Queue()
    svc._global_subs.add(plain)
    svc._publish({"type": "probe"})
    assert plain.get_nowait() == {"type": "probe"}
    svc._global_subs.discard(plain)
