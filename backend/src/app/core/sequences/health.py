"""Pure aggregation for the terminal two-tier PKI deployment health gate."""

from collections.abc import Mapping
from typing import Any

from app.core.sequences.model import StepRuntime

ML_DSA_87_SIGNATURE_OID = "2.16.840.1.101.3.4.3.19"


def _nested(result: Mapping[str, Any], *path: str) -> Any:
    value: Any = result
    for key in path:
        if not isinstance(value, Mapping):
            return None
        value = value.get(key)
    return value


def aggregate_lab_health(
    runtime: StepRuntime, results: Mapping[str, dict[str, Any]]
) -> dict[str, Any]:
    """Combine fresh remote facts from all four machines into one verdict."""

    failures: list[str] = []

    def check(
        name: str,
        ok: bool,
        failure: str,
        detail: Any = None,
    ) -> dict[str, Any]:
        if not ok:
            failures.append(failure)
        item: dict[str, Any] = {"ok": ok}
        if detail is not None:
            item["detail"] = detail
        return item

    cert = results.get("certificate-health", {})
    certificate = {
        "chain": check(
            "chain",
            _nested(cert, "chain", "ok") is True,
            "certificate chain did not build successfully",
        ),
        "aia": check(
            "aia",
            _nested(cert, "aia", "ok") is True,
            "root and issuing certificates were not both verified through AIA",
            cert.get("aia"),
        ),
        "cdp": check(
            "cdp",
            _nested(cert, "cdp", "ok") is True,
            "required base and delta CRLs were not both verified through CDP",
            cert.get("cdp"),
        ),
        "ocsp": check(
            "ocsp",
            _nested(cert, "ocsp", "ok") is True,
            "the issued probe did not receive a verified OCSP response",
            cert.get("ocsp"),
        ),
        "mlDsa": check(
            "mlDsa",
            _nested(cert, "ml_dsa", "ok") is True
            and _nested(cert, "ml_dsa", "expected_oid") == ML_DSA_87_SIGNATURE_OID,
            "the probe chain does not use ML-DSA-87 signatures throughout",
            cert.get("ml_dsa"),
        ),
        "validity": check(
            "validity",
            _nested(cert, "validity", "ok") is True,
            "one or more probe-chain certificates are outside their validity window",
            cert.get("certificates"),
        ),
        "revocationFreshness": check(
            "revocationFreshness",
            _nested(cert, "revocation_freshness", "ok") is True,
            "revocation evidence is stale or unavailable",
            cert.get("revocation_freshness"),
        ),
    }

    enterprise = results.get("enterprise-pki-health", {})
    containers = enterprise.get("containers", {})
    required_containers = (
        "nt_auth",
        "aia",
        "cdp",
        "certification_authorities",
        "enrollment_services",
    )
    enterprise_pki = {
        "containers": check(
            "containers",
            all(containers.get(name) is True for name in required_containers),
            "one or more AD enterprise PKI containers are unhealthy",
            containers,
        ),
        "templates": check(
            "templates",
            _nested(enterprise, "templates", "ok") is True,
            "required enrollment templates are not published",
            enterprise.get("templates"),
        ),
        "httpArtifacts": check(
            "httpArtifacts",
            _nested(enterprise, "http_artifacts", "ok") is True,
            "one or more required HTTP AIA/CDP artifacts are unavailable",
            enterprise.get("http_artifacts"),
        ),
    }

    ca_services = {}
    for role, step_id in (
        ("root", "root-ca-health"),
        ("issuing", "issuing-ca-health"),
    ):
        result = results.get(step_id, {})
        ca_services[role] = check(
            role,
            result.get("ping_ok") is True
            and str(result.get("service", "")).casefold() == "running",
            f"{role} CA service is not running and responsive",
            {"service": result.get("service"), "pingOk": result.get("ping_ok")},
        )

    ocsp_result = results.get("ocsp-health", {})
    responder = check(
        "responder",
        ocsp_result.get("configured") is True,
        "Online Responder configuration is missing or unreadable",
        ocsp_result.get("configurations"),
    )

    dns = {}
    for role, step_id in (
        ("web", "dns-health-web"),
        ("issuing", "dns-health-issuing"),
    ):
        result = results.get(step_id, {})
        dns[role] = check(
            role,
            result.get("all_verified") is True
            and result.get("ad_srv_ok") is True
            and result.get("http_ok") is True,
            f"DNS/HTTP publication verification failed from the {role} host",
            result,
        )

    identities = {}
    for role, alias in (
        ("dc", "dc"),
        ("root", "root"),
        ("issuing", "ca"),
        ("web", "web"),
    ):
        result = results.get(f"identity-{role}", {})
        expected = runtime.ctx.node(alias).hostname
        actual = str(result.get("hostname", ""))
        identities[role] = check(
            role,
            actual.casefold() == expected.casefold()
            and result.get("server") is True
            and "windows server" in str(result.get("operating_system", "")).casefold(),
            f"{role} agent is not running on expected Windows Server host {expected}",
            {
                "expectedHostname": expected,
                "hostname": actual,
                "operatingSystem": result.get("operating_system"),
                "version": result.get("version"),
            },
        )

    return {
        "healthy": not failures,
        "failures": failures,
        "checks": {
            "certificate": certificate,
            "enterprisePki": enterprise_pki,
            "caServices": ca_services,
            "ocspResponder": responder,
            "dnsPublication": dns,
            "runtimeIdentities": identities,
        },
    }
