"""Evidence snapshots mask credentials and package reproducible facts."""

import base64
import io
import json
import zipfile

from app.core.evidence import build_evidence_bundle, redact_evidence


def test_redaction_masks_nested_plan_credentials():
    redacted = redact_evidence(
        {
            "params": {"domainAdminPassword": "hunter2", "domainName": "encon.pki"},
            "nodes": [{"config": {"safeModePassword": "secret"}}],
        }
    )

    assert redacted["params"]["domainAdminPassword"] == "***"
    assert redacted["nodes"][0]["config"]["safeModePassword"] == "***"
    assert redacted["params"]["domainName"] == "encon.pki"


def test_bundle_contains_manifest_health_and_public_artifacts():
    payload, digest = build_evidence_bundle(
        {
            "jobId": "job-1",
            "owner": "alice",
            "topology": {"version": 1},
            "operations": [{"id": "verify"}],
            "preflight": {"ready": True},
            "results": {"publish": {"lab-health": {"healthy": True}}},
            "cursor": {"publish": ["lab-health"]},
            "artifacts": {
                "root_crt": base64.b64encode(b"root certificate").decode(),
                "root_cert_filename": "CA01_Root.crt",
            },
            "createdAt": 1,
            "updatedAt": 2,
        }
    )

    assert len(digest) == 64
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = set(archive.namelist())
        assert "manifest.json" in names
        assert "verification.json" in names
        assert "artifacts/root-ca.crt" in names
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["evidenceSha256"] == digest
        assert json.loads(archive.read("verification.json"))["publish"][
            "lab-health"
        ]["healthy"] is True
