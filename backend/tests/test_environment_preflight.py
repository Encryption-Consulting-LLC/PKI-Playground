"""Control-plane readiness preflight."""

import os

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
)

from app.core import environment_preflight as subject  # noqa: E402
from app.core.infrastructure import ImageQualification, infrastructure_profiles_from_doc  # noqa: E402


def test_control_plane_requires_callback_agent_broker_and_worker(monkeypatch, tmp_path):
    agent = tmp_path / "agent.exe"
    agent.write_bytes(b"qualified agent")
    digest = subject._agent_digest(agent)
    profiles = infrastructure_profiles_from_doc({})
    for profile in profiles.values():
        profile.qualification = ImageQualification(
            baseChangeVersion="1", windowsBuild=26100,
            runnerVersion="2", agentSha256=digest, validatedAt=1,
            mlDsa87Available=True, systemContextValidated=True,
            timeSynchronized=True, windowsUpdatesCurrent=True,
            backendCallbackReachable=True,
        )
    monkeypatch.setattr(subject.settings, "orchestrator_agent_path", str(agent))
    monkeypatch.setattr(subject.settings, "backend_public_url", "https://pki.example")
    monkeypatch.setattr(subject.transport._client, "ping", lambda: True)
    monkeypatch.setattr(
        subject.celery_app.control, "inspect",
        lambda timeout: type("Inspect", (), {"ping": lambda self: {"worker": {"ok": "pong"}}})(),
    )

    result = subject.preflight_control_plane(profiles, mongo_ready=True)

    assert result.ready is True
    assert {check.key for check in result.checks} == {
        "mongo", "valkey", "backendCallback", "agentBinary", "worker"
    }


def test_control_plane_reports_every_missing_prerequisite(monkeypatch):
    profiles = infrastructure_profiles_from_doc({})
    monkeypatch.setattr(subject.settings, "orchestrator_agent_path", None)
    monkeypatch.setattr(subject.settings, "backend_public_url", None)
    monkeypatch.setattr(subject.transport._client, "ping", lambda: False)
    monkeypatch.setattr(
        subject.celery_app.control, "inspect",
        lambda timeout: type("Inspect", (), {"ping": lambda self: {}})(),
    )

    result = subject.preflight_control_plane(profiles, mongo_ready=False)

    assert result.ready is False
    assert all(not check.ok for check in result.checks)
