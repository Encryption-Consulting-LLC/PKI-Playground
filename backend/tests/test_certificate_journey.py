"""The canvas certificate lens receives concrete, redacted journey evidence."""

from app.core.sequences.journey import build_certificate_journey
from app.core.sequences.model import NodeContext, RunContext


def test_certificate_journey_projects_urls_dns_artifacts_and_failures() -> None:
    web = NodeContext("srv1", "srv1", "SRV1", ip="10.0.0.14")
    ca = NodeContext(
        "ca02",
        "ca02",
        "CA02",
        ip="10.0.0.13",
        template_config={"commonName": "EC Issuing CA"},
    )
    ctx = RunContext(
        nodes={"web": web, "ca": ca},
        domain_name="encon.pki",
        pki_host="pki.encon.pki",
        artifacts={
            "root_cert_filename": "root ca.crt",
            "issuing_cert_filename": "issuing ca.crt",
            "root_crl_filename": "root.crl",
            "issuing_crl_filename": "issuing.crl",
            "issuing_delta_crl_filename": "issuing+.crl",
        },
    )
    results = {
        "certificate-health": {
            "chain": {"ok": True},
            "aia": {"ok": True},
            "cdp": {"ok": False},
            "ocsp": {"ok": True},
            "ml_dsa": {"expected_oid": "2.16.840.1.101.3.4.3.19"},
        },
        "lab-health": {"healthy": False},
    }

    journey = build_certificate_journey(
        ctx, results, verified_at="2026-07-14T00:00:00+00:00"
    )

    assert [hop["id"] for hop in journey["hops"]] == [
        "enroll",
        "issue",
        "aia",
        "cdp",
        "ocsp",
    ]
    assert journey["hops"][2]["dns"] == {
        "hostname": "pki.encon.pki",
        "address": "10.0.0.14",
    }
    assert journey["hops"][2]["artifacts"][0].endswith("issuing%20ca.crt")
    assert journey["hops"][3]["failureReason"]
    assert journey["hops"][4]["url"] == "http://pki.encon.pki/ocsp"
    assert journey["signatureAlgorithm"] == "2.16.840.1.101.3.4.3.19"
