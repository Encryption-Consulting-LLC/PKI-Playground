"""Connection-map takeover semantics (`core/agents.py`).

The connect handler's `finally` only clears the shared `agent-conn:{vm_id}`
liveness key when `disconnect_if` reports it removed the entry — so a socket
evicted by a 4409 takeover can't delete the key its replacement just set.
These tests pin that return-value contract.
"""

from app.core import agents


class _FakeWebSocket:
    """Stand-in for fastapi.WebSocket — the map never touches it directly."""


def _fresh(vm_id: str) -> None:
    agents._connected.pop(vm_id, None)


def test_disconnect_if_returns_true_for_the_current_owner():
    vm_id = "vm-takeover-a"
    _fresh(vm_id)
    conn = agents.connect_agent(vm_id, _FakeWebSocket())

    assert agents.disconnect_if(vm_id, conn) is True
    assert agents.resolve_agent(vm_id) is None


def test_evicted_connection_does_not_own_the_entry_after_takeover():
    vm_id = "vm-takeover-b"
    _fresh(vm_id)
    old = agents.connect_agent(vm_id, _FakeWebSocket())
    # A second connection for the same vm_id takes over (the router closes the
    # old socket with 4409 and re-registers).
    assert agents.pop_connection(vm_id) is old
    new = agents.connect_agent(vm_id, _FakeWebSocket())

    # The evicted socket's cleanup must be a no-op: not the owner anymore.
    assert agents.disconnect_if(vm_id, old) is False
    assert agents.resolve_agent(vm_id) is new

    # The replacement still cleans up normally when it dies.
    assert agents.disconnect_if(vm_id, new) is True
    assert agents.resolve_agent(vm_id) is None
