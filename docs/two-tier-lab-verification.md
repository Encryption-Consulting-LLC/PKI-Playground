# Two-tier ADCS lab: verification notes

The sign-off (`plan.md`): the full two-tier Microsoft ADCS lab from
`pki-lab-guides/vm-building.md` — DC01, CA01 (offline root), CA02 (issuing),
SRV1 (web + OCSP), WIN11 (client) — deployable end to end from a single canvas
**Deploy**, ending with `certutil -verify -urlfetch` on WIN11 showing OCSP/CRL/
AIA all verified.

## What shipped (by slice)

| # | Commit | What it delivers |
|---|--------|------------------|
| 1 | `feat(commands): add dc/domain/ca verify reads and dns.set_client` | Read probes (`dc.verify`, `domain.verify`, `ca.verify`) + `dns.set_client` |
| 2 | `feat(commands): add DNS record, cert store, dspublish and template ACL commands` | `dns.create_record`, `cert.addstore`, `cert.dspublish`, `template.grant_access` |
| 3 | `feat(commands): add forest install and domain join with reboot reporting` | `dc.install_forest`, `domain.join`, `system.reboot` (reboot contract) |
| 4 | `feat(commands): extend ca.install for issuing CAs and add CA settings/CDP-AIA/CRL commands` | Issuing-CA install (`-Credential`, CSR out), `ca.configure_settings`, flag-prefixed `ca.configure_cdp_aia`, `ca.publish_crl` |
| 5 | `feat(commands): add cross-signing, cert install, template publish and file relay commands` | `ca.sign_request`, `ca.install_cert`, `ca.publish_template`, `file.read`/`file.write` relay |
| 6 | `feat(commands): add IIS CertEnroll, online responder install and cert enroll commands` | `iis.setup_certenroll`, `ocsp.install`, `cert.enroll` |
| 7 | `feat(commands): add OCSP revocation configuration via CertAdm COM` | `ocsp.configure_revocation`, `ocsp.verify` (COM canary) |
| 8 | `feat: operator-set domain admin password for the DC template` | `password` config field, AD-complexity policy, AES-GCM at rest |
| 9 | `feat(orchestrator): plan-driven command dispatch relay and agent wait` | `core/agentbus` bridge, `core/sequences` engine, `plan_runs`, removed connect-handler auto-provisioning |
| 10 | `feat(deploy): execute domain joins for real` | `domainJoin` → dns/join/reboot/verify; `secondary` wire field; cross-node context |
| 11 | `feat(deploy): execute forest promotion and CA cross-signing for real` | DC + root-CA createVm tails; the `caConnect` cross-sign handshake |
| 12 | `feat(deploy): execute web host, OCSP and client enrollment for real` | `webServerCert`; client-enrollment tail on `domainJoin`; deferred PKI CNAME |
| 13 | `feat(canvas): lab-complete template config and offline root presentation` | `cpsUrl`/`ocspRefreshMinutes` fields, offline-root air-gap UI, stub removal, enroll-cert row |
| 14 | `feat(topology): model explicit DNS record resources` | Backend-validated A/PTR/CNAME resources derived from the final canvas topology |
| 15 | `feat(deploy): apply and verify planned DNS resources` | Conflict-safe DNS application; A/PTR/SRV/CNAME and HTTP verification |

The agent command surface includes `dns.apply_resources` and `dns.verify`
(`pki-orchestrator/src/commands/`),
each `param()`-block PowerShell (never string-interpolated), `MockPowerShell`-
tested, and mirrored in the backend's `_COMMAND_CAPABILITIES` under a shared
parity fixture.

## Automated verification (this environment — no Windows VM)

Per `plan.md`, per-slice verification here is limited to the static gates; the
runtime lab is verified separately on real hardware (below).

- **Rust** (`pki-orchestrator`): `cargo fmt --check`, `cargo clippy --all-targets
  -- -D warnings`, `cargo test --all-targets` — **144 tests pass**, clippy clean,
  fmt clean. Includes `MockPowerShell` unit tests per command (validation +
  canned-output parse) and the `tests/command_catalog.rs` parity fixture.
- **Backend** (`EC-PKI-Playground/backend`): `uv run pytest tests/` — **55 tests
  pass**. Covers the command-catalog parity mirror, the password policy +
  AES-GCM round-trip, the sequence engine (reboot waits, verify backoff,
  artifact relay, resume-skip), and every op-kind expansion's shape + param
  resolution (domainJoin, caConnect, webServerCert, DC/root tails, client
  enrollment). OpenAPI builds with 33 routes.
- **Frontend** (`EC-PKI-Playground/frontend`): `npx tsc -b` clean, `pnpm lint`
  clean.

## Op → command-sequence mapping (as built)

Sequences live in `core/sequences/definitions.py`, resolved against a
`RunContext` built in `core/sequences/context.py` (each node's real
guest-namespaced identity + domain facts), walked by `core/sequences/engine.py`,
and wired to the agentbus + `plan_runs` in `core/sequences/worker.py`.

- **createVm(DC)**: `dc.install_forest` → `system.reboot` → `dc.verify` (retry) →
  `dns.set_client(self)` → apply the DC A/PTR resources → verify them and the
  forest's AD SRV records.
- **createVm(root CA)**: `ca.install(Root)` → `ca.configure_settings`
  (52w CRL / 10y issued / DSConfigDN / AuditFilter 127) → `ca.configure_cdp_aia`
  (3 AIA / 3 CDP) → `ca.publish_crl` → `file.read` root crt + crl into the relay.
- **createVm(issuing CA)**: empty tail — it can't stand up until the handshake.
- **domainJoin**: `dns.set_client(DC)` → `domain.join` → `system.reboot` →
  `domain.verify` (retry) → apply and verify the member's planned A/PTR records.
  Web target adds the CertEnroll share/ACL half; client target (with an issuing
  CA present) adds `cert.enroll(Workstation)` + `cert.verify`.
- **caConnect**: relay root crt/crl to CA02 + AD (`cert.dspublish` ×2) + web;
  `ca.install(Issuing)` → `file.read` CSR → CA01 `ca.sign_request` → `file.read`
  cert → CA02 `ca.install_cert` → settings → CDP/AIA (+OCSP) → CRL → publish
  templates → DC `template.grant_access(OCSPResponseSigning → SRV1$)`.
- **webServerCert**: `iis.setup_certenroll(web)` → `ocsp.install` →
  `cert.enroll(OCSPResponseSigning)` → `ocsp.configure_revocation` →
  `ocsp.verify` → apply the planned PKI CNAME on the DC → verify DNS and HTTP
  CertEnroll reachability from SRV1 and CA02.
- **domainLeave**: no plan sequence — retains the timed simulation stub.

## Canaries — must be validated on a real golden image before production

These are grounded in the lab guide but cannot be confirmed without a Windows
Server 2025 VM; each is flagged in-code.

1. **Run-as-credential from a SYSTEM service** — `ca.install(Issuing)` and
   `domain.join`/`dc.install_forest` pass an operator credential to session-0
   cmdlets via `-Credential` / a `PSCredential`. Prototype on a real VM; the
   fallback is a scheduled-task-as-user trampoline.
2. **OCSP COM automation** (`ocsp.configure_revocation`) — the `CertAdm.OCSPAdmin`
   property set (SigningFlags `0x175`, provider CLSID, `RefreshTimeOut`) is not
   copy-paste-ready in the guide. Freeze the script against a hand-configured
   `ocsp.msc` dump; `ocsp.verify` asserts the readback. It is best-effort in the
   plan so a COM mismatch can't poison WIN11 verification (CRL-only still
   verifies). **Decision pending:** does WIN11 sign-off require OCSP, or accept
   CRL-only?
3. **CertEnroll filenames** — `_sanitized_cn_file` / `_crl_url_name` derive the
   published cert/CRL paths from the CA common name; certutil's exact
   sanitization of CNs *with spaces* (the issuing CA) is unverified. The root CA
   default (`EC-Root-CA`, no spaces) is safe.
4. **ML-DSA-87 provider string** (`ca.rs` `MLDSA_PROVIDER`) — carried over
   unchanged, still unverified against the 2025 CNG KSP.
5. **AD timing** — post-promotion ADWS and template/enrollment propagation
   windows (`verify_window_s`) are tuned by guess; re-tune on real hardware.

## Full-lab sign-off procedure (real hardware)

1. On a canvas with `AUTH_MODE` configured and a reachable ESXi target + guest
   IP range, drop the five templates: Domain Controller, two Certificate
   Authorities (Root offline + Issuing), Web Server, Client.
2. Configure DC01 with a domain admin password that meets the AD-complexity
   checklist. Wire CA01→CA02 (CA hierarchy), CA02→SRV1 (web cert), and
   domain-join CA02/SRV1/WIN11 into DC01's region.
3. **Deploy.** The plan runner clones each VM, waits for its agent, and walks
   the op sequences above in DAG order.
4. Confirm on WIN11: `certutil -verify -urlfetch C:\win11.cer` shows **OCSP (from
   AIA)**, **CRLs (from CDP)**, and **Certs (from AIA)** all *Verified*.
5. Confirm on CA02: `pkiview.msc` containers (NTAuth, AIA, CDP, Certification
   Authorities, Enrollment Services) all **OK**.

## Redelivery / safety

- The long single Celery task (60–90 min) is redelivery-safe: deterministic
  per-step job ids (`{plan_job_id}-{op_id}-{step_id}`) let `dispatch_and_wait`
  reuse an already-terminal result, and the `plan_runs` cursor skips completed
  steps. Test redelivery deliberately on **isolated dbs (12/13/14) with blank
  `ESXI_*`** — never broker db1 (stale tasks fire real clones).
- Secrets (domain admin password) are AES-GCM encrypted at rest, decrypted
  just-in-time for dispatch, and redacted from progress/error frames
  (`secret_keys`). Verify redaction end-to-end on the real run.
