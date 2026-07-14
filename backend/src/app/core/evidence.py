"""Redacted persistence and downloadable evidence bundles for plan runs."""

import base64
import hashlib
import io
import json
import zipfile
from typing import Any


_SECRET_PARTS = ("password", "secret", "contentb64", "token")
_BINARY_ARTIFACTS = {
    "root_crt": "root-ca.crt",
    "root_crl": "root-ca.crl",
    "issuing_csr": "issuing-ca.req",
    "issuing_crt": "issuing-ca.crt",
    "issuing_pub_crt": "issuing-ca-publication.crt",
}


def redact_evidence(value: Any, key: str = "") -> Any:
    """Recursively mask secrets before a plan snapshot reaches Mongo."""

    if any(part in key.lower() for part in _SECRET_PARTS):
        return "***"
    if isinstance(value, dict):
        return {name: redact_evidence(item, name) for name, item in value.items()}
    if isinstance(value, list):
        return [redact_evidence(item) for item in value]
    return value


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, indent=2, sort_keys=True, default=str).encode("utf-8")


def build_evidence_bundle(run: dict) -> tuple[bytes, str]:
    """Create a ZIP and return ``(bytes, aggregate_sha256)``."""

    files: dict[str, bytes] = {
        "topology.json": _json_bytes(run.get("topology") or {}),
        "operations.json": _json_bytes(run.get("operations") or []),
        "preflight.json": _json_bytes(run.get("preflight") or {}),
        "verification.json": _json_bytes(run.get("results") or {}),
        "cursor.json": _json_bytes(run.get("cursor") or {}),
    }
    artifact_index: dict[str, Any] = {}
    for key, value in sorted((run.get("artifacts") or {}).items()):
        filename = _BINARY_ARTIFACTS.get(key)
        if filename and isinstance(value, str):
            try:
                files[f"artifacts/{filename}"] = base64.b64decode(value, validate=True)
            except ValueError:
                artifact_index[key] = {"invalidBase64": True}
            else:
                artifact_index[key] = {"file": f"artifacts/{filename}"}
        else:
            artifact_index[key] = value
    files["artifacts/index.json"] = _json_bytes(artifact_index)

    file_digests = {
        name: hashlib.sha256(content).hexdigest()
        for name, content in sorted(files.items())
    }
    aggregate = hashlib.sha256(_json_bytes(file_digests)).hexdigest()
    manifest = {
        "schemaVersion": 1,
        "jobId": run.get("jobId"),
        "owner": run.get("owner"),
        "createdAt": run.get("createdAt"),
        "updatedAt": run.get("updatedAt"),
        "evidenceSha256": aggregate,
        "files": file_digests,
    }
    files["manifest.json"] = _json_bytes(manifest)

    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(files.items()):
            archive.writestr(name, content)
    return output.getvalue(), aggregate
