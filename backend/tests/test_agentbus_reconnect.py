"""Post-reboot agent gate: historical reconnects must not count as live."""

import pytest

from app.core.agentbus import ReconnectTimeoutError, wait_for_reconnect


class _Clock:
    def __init__(self):
        self.t = 0.0

    def monotonic(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


class _Environment:
    """Timeline entries are ``(start_s, last_connected_at, live)``."""

    def __init__(self, clock, timeline):
        self.clock = clock
        self.timeline = timeline

    def state(self):
        state = (None, False)
        for start, last_connected_at, live in self.timeline:
            if self.clock.t >= start:
                state = (last_connected_at, live)
        return state


class _Redis:
    def __init__(self, environment):
        self.environment = environment

    def get(self, _key):
        _, live = self.environment.state()
        return b"1" if live else None


class _Database:
    def __init__(self, environment):
        self.environment = environment

    def __getitem__(self, _name):
        environment = self.environment

        class _Collection:
            def find_one(self, *_args, **_kwargs):
                last_connected_at, _ = environment.state()
                if last_connected_at is None:
                    return {}
                return {"agent": {"lastConnectedAt": last_connected_at}}

        return _Collection()


def _wait(environment, clock, *, timeout_s=30):
    return wait_for_reconnect(
        "vm-1",
        since_ms=1_000,
        timeout_s=timeout_s,
        db=_Database(environment),
        client=_Redis(environment),
        sleep=clock.sleep,
        monotonic=clock.monotonic,
        poll_interval_s=1.0,
    )


def test_dropped_reconnect_does_not_release_the_next_sequence_step():
    clock = _Clock()
    environment = _Environment(
        clock,
        [
            # Mongo records a post-reboot connection, but that socket is gone.
            (0, 2_000, False),
            # The agent reconnects again and is actually dispatchable.
            (4, 3_000, True),
        ],
    )

    _wait(environment, clock)

    assert clock.t == 4.0


def test_historical_reconnect_times_out_while_agent_stays_offline():
    clock = _Clock()
    environment = _Environment(clock, [(0, 2_000, False)])

    with pytest.raises(ReconnectTimeoutError, match="did not reconnect"):
        _wait(environment, clock, timeout_s=5)

    assert clock.t == 5.0
