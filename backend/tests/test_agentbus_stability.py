"""Boot-settle gate (`wait_for_stable_agent`) — the dwell must ride through the
firstboot finalize reboot and only accrue on the final, stable boot. Driven with
an injected clock + fake redis/Mongo, no real backends."""

import pytest

from app.core.agentbus import AgentUnreachableError, wait_for_stable_agent


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def monotonic(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


class _Env:
    """Returns (live, lastConnectedAt) as a function of the current clock time,
    from a timeline of (start_time, live, lca) segments (last match wins)."""

    def __init__(self, clock, timeline):
        self.clock = clock
        self.timeline = timeline

    def state(self):
        cur = (False, None)
        for start, live, lca in self.timeline:
            if self.clock.t >= start:
                cur = (live, lca)
        return cur


class _FakeRedis:
    def __init__(self, env):
        self.env = env

    def get(self, key):
        live, _ = self.env.state()
        return b"1" if live else None


class _FakeDb:
    def __init__(self, env):
        self.env = env

    def __getitem__(self, _name):
        env = self.env

        class _Col:
            def find_one(self, *_a, **_k):
                _, lca = env.state()
                return {"agent": {"lastConnectedAt": lca}} if lca is not None else {}

        return _Col()


def _wait(env, clock, **kw):
    return wait_for_stable_agent(
        "vm-1",
        db=_FakeDb(env),
        client=_FakeRedis(env),
        sleep=clock.sleep,
        monotonic=clock.monotonic,
        poll_interval_s=3.0,
        **kw,
    )


def test_settles_only_after_the_final_boot():
    clock = FakeClock()
    # Boot B connect (lca=1000) at t=0; finalize reboot drops the agent at t=80;
    # Boot C reconnect (lca=2000) at t=130, stable thereafter.
    env = _Env(clock, [(0, True, 1000), (80, False, None), (130, True, 2000)])
    _wait(env, clock, settle_s=180, timeout_s=10_000)
    # Returns only after Boot C (t=130) + settle_s (180); the reboot at t=80
    # preempted Boot B's dwell, so it never fired at t=180 on the first boot.
    assert clock.monotonic() >= 130 + 180
    assert clock.monotonic() < 130 + 180 + 6  # within a poll of the target


def test_times_out_when_never_stable():
    clock = FakeClock()
    env = _Env(clock, [(0, False, None)])
    with pytest.raises(AgentUnreachableError):
        _wait(env, clock, settle_s=180, timeout_s=300)
