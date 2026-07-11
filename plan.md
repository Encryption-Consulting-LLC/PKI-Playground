# Phase L: Full two-tier ADCS lab, deployable from one Deploy click

## Context

The platform can clone VMs, bundle the orchestrator agent into their firstboot ISO, and
auto-run a single provisioning command per template (`certificateAuthority → ca.install`,
root only). Everything past a lone VM is still a stub: the four non-`createVm` plan ops
(`domainJoin`/`domainLeave`/`caConnect`/`webServerCert`) are `_simulate_op` sleep-and-fake-
phases, and the agent has only 8 commands (`ca.install` rejects subordinate CAs, there is no
domain-join / DNS / IIS / OCSP / cross-sign / file-transfer capability at all).

The goal of this phase is to make the two-tier Microsoft ADCS lab in
`pki-lab-guides/vm-building.md` — DC01, CA01 (offline root), CA02 (issuing), SRV1 (web +
OCSP), WIN11 (client) — deploy end to end from a single canvas **Deploy**, ending with
`certutil -verify -urlfetch` on WIN11 showing OCSP/CRL/AIA all verified. That doc is the
authoritative spec; nearly every step there has copy-paste PowerShell that is the
implementation source for the agent commands below.

### Locked decisions (from user)
1. **Offline root** — CA01 keeps a management NIC and phones home like every VM; it is *presented*
   as offline (badge, hidden IP, dashed edges), and all cross-VM file movement goes through the
   backend relay (the "sneakernet" fiction). It is never domain-joined and takes no lab-network role.
2. **GUI-only steps** — automate the OCSP revocation config (via `CertAdm.OCSPAdmin` COM) and the
   template ACL grant (via PowerShell AD ACL editing); **drop the GPO cert-import step entirely**
   (it only helps pre-existing certs; a from-scratch lab has none).
3. **Execution model** — the deploy plan does everything. The five staged op kinds stay the
   vocabulary; each expands backend-side into a sequence of agent commands. The disabled Inspector
   stub buttons ("Promote to DC", "Install … CA") are **removed**, not promoted to the primary path.
4. **Domain admin password** — an operator-entered password field on the DC template, with
   frontend AD-complexity strength validation, stored AES-GCM-encrypted (same pattern as the ESXi
   password), injected into join/enroll steps as a secret command param, never logged or echoed.

## Design

### Agent stays a pure executor
No lab logic in Rust. All sequencing, cross-node parameter resolution, artifact relay, and
reboot handling live in the backend. New Rust commands are small, single-purpose, `param()`-block
PowerShell (never string interpolation), `MockPowerShell`-tested, registered in
`build_default_registry` (`pki-orchestrator/src/commands/mod.rs`), following `src/commands/ca.rs`.

### Worker↔agent dispatch bridge (`core/agentbus.py`, new)
Plan execution stays in the Celery worker (`task_acks_late` + IP-pool idempotency precedent;
`createVm` is an hour-scale blocking vmkit call that must not live in the API process). But agent
sockets live in the **FastAPI** process (`core/agents.py`), so the worker can't reach them
directly. Bridge:
- **Worker side (sync redis-py, db0):** `dispatch_and_wait(vm_id, command, params, *, job_id, role,
  timeout_s, secret_keys)` — checks the `jobs:{job_id}:snapshot` for an already-terminal result
  (redelivery-safe), checks agent liveness key `agent-conn:{vm_id}`, `SUBSCRIBE jobs:{job_id}`
  *before* publishing the dispatch request onto channel `agent-dispatch`, then awaits the terminal
  frame (agent progress already relays onto `jobs:{job_id}` via the connect handler's
  `_relay_progress` — no new return path).
- **API side (async):** a lifespan task in `main.py` subscribes to `agent-dispatch`; whichever
  process holds the socket (`agents.resolve_agent`) forwards the frame; the rest stay silent. The
  existing single-live-connection-per-vm_id takeover already guarantees exactly one holder.
- **Liveness:** the connect handler writes `agent-conn:{vm_id}` with a TTL heartbeat and
  `$set agent.lastConnectedAt` on the `vm_registry` doc (the worker's reboot-resume signal).

### Reboot-spanning sequences (`core/sequences/`, new package)
Rebooting cmdlets never self-reboot (`Install-ADDSForest -NoRebootOnCompletion`, `Add-Computer`
without `-Restart`); a separate `system.reboot` step (`shutdown /r /t 10`, lets the done-frame
flush) is marked `expects_disconnect`. The engine then polls Mongo until
`agent.lastConnectedAt > dispatch_time` (timestamp compare, immune to fast-reboot races), then runs
a **verify probe with retry backoff** (`dc.verify → Get-ADDomain`, `domain.verify → PartOfDomain`)
inside a ~10-min window (ADWS / template propagation is slow). Step definitions are declarative
(`model.py` `Step`), per-template provision sequences and per-op-kind sequences in
`definitions.py`, walked by `engine.py`. **`createVm` now waits for `provisionState=applied`** so a
`domainJoin` depending on the DC genuinely runs after promotion — DAG deps become honest. The
connect-handler auto-provisioning (`_start_provisioning`/`_PROVISION_COMMAND`) is **removed**; one
orchestration model (the plan) replaces two.

### Persisted run state (`plan_runs` collection, new)
Keyed on the plan `job_id`. Holds the cross-VM `context` (node → {vmName, agentVmId, templateConfig,
hostname, ip}), the per-op/per-step `cursor` (resume after worker redelivery: completed steps skip),
and the `artifacts` map. TTL index on `updatedAt` (~7d). Per-step job ids are deterministic
(`{plan_job_id}-{op_id}-{step_id}`) — both the idempotency key and a free Inspector drill-down later.
`vm_registry.agent.provisionState` stays as the Inspector-facing summary.

### Artifact relay (cross-sign handshake)
New agent commands `file.read` / `file.write` (base64 in params/result, 256 KB cap, path-prefix
allowlist: `C:\Transfer\`, the CertEnroll dir, the configured `certEnrollPath`). Backend stores
artifacts in `plan_runs.artifacts` (1–5 KB each, well under the 16 MB doc cap — no GridFS). A step
declares `produces=[...]` / `consumes=[...]`; the engine lifts `result.contentB64` into the map and
injects it into later steps' params. This *is* the CA01 sneakernet path (CSR out, signed cert back,
root cert/CRL to CA02+SRV1) — no SMB needed for the relay.

### Cross-node parameter resolution
`PlanOp` gains an additive `secondary: str | None` wire field (frontend already tracks
`secondaryNodeId` but drops it in `buildOpPayload` — add it there). `validate_plan` gains per-kind
checks and enforces cross-op ordering the client shouldn't be trusted for (e.g. `caConnect` depends
on SRV1's `domainJoin` so the share exists before UNC CRL publish; WIN11's join depends on
`caConnect`+`webServerCert`). A context builder joins the plan's own `createVm` ops with
`vm_registry` lookups by app name (== node id) to resolve `domainName`, `netbios`,
`pki_host = pki.<domain>`, and — critically — every other node's real guest-namespaced hostname via
`firstboot.hostname_for(vmName)` (all URLs/CNAME/UNC/ACL names must use it, not the display name).

### Run-as credentials (one `powershell.rs` addition)
The agent service runs as LocalSystem. On DC01 that is directory-privileged, so `cert.dspublish` and
`template.grant_access` run **on DC01**. But `Install-AdcsCertificationAuthority
EnterpriseSubordinateCA` on CA02 needs Enterprise Admin — handled via the cmdlet's own `-Credential`
(operator password param). This is the highest-risk new mechanism; prototype on a real VM first
(fallback: scheduled-task-as-user trampoline).

## Command catalog (agent, all `Capability::VmProvision` unless noted; reads are `VmRead`)

Grounded step-by-step in `vm-building.md`. New handler files: `system.rs`, `dc.rs`, `dns.rs`,
`domain.rs`, `file.rs`, `iis.rs`, `ocsp.rs`; extended `ca.rs`.

| Command | Implements (lab step) | Reboots | Verify |
|---|---|---|---|
| `dc.install_forest` | DC01 `Install-ADDSForest -InstallDns -NoRebootOnCompletion` | yes | `dc.verify` |
| `dc.verify` (VmRead) | post-reboot `Get-ADDomain` retry probe | — | — |
| `dns.set_client` | point NIC DNS at DC pool IP (pre-join) / self (DC) | no | `ip.read` |
| `dns.create_record` | DC01 PKI CNAME → srv1 (idempotent) | no | echoes record |
| `domain.join` | CA02/SRV1/WIN11 rename+`Add-Computer -Credential` (no `-Restart`) | yes | `domain.verify` |
| `domain.verify` (VmRead) | `Win32_ComputerSystem.PartOfDomain` | — | — |
| `ca.install` **(extended)** | root (as today, +renewal/altsig lines) **and** issuing (CPS CAPolicy, `EnterpriseSubordinateCA -Credential -OutputCertRequestFile`; allowlist expected "not started" warning; returns CSR path) | no | `ca.verify` |
| `ca.verify` (VmRead) | `Get-Service certsvc` + `certutil -ping` | — | — |
| `ca.configure_settings` | CA01/CA02 `-setreg` batch (CRL periods, validity, DSConfigDN, `AuditFilter 127`, `auditpol`) + restart | no | `ca.verify` |
| `ca.configure_cdp_aia` **(replaced)** | full flag-prefixed AIA/CDP arrays (3 AIA/3 CDP root; 3 AIA incl. `32:` OCSP + 4 CDP incl. UNC issuing); `klist purge` + restart | no | `ca.verify` |
| `ca.publish_crl` | `certutil -crl` | no | result |
| `ca.sign_request` | CA01 `certreq -submit`→`certutil -resubmit`→`certreq -retrieve` (parse RequestId) | no | downstream install |
| `ca.install_cert` | CA02 `certutil -installcert` + `Start-Service` | no | `ca.verify` |
| `ca.publish_template` | CA02 `Add-CATemplate OCSPResponseSigning,Workstation` | no | result |
| `cert.dspublish` | **on DC01** `certutil -f -dspublish` (RootCA + CRL) | no | health check |
| `cert.addstore` | CA02 `certutil -addstore -f root` | no | thumbprint |
| `template.grant_access` | **on DC01** AD ACL: grant SRV1$ Read+Enroll on OCSPResponseSigning | no | ACL readback |
| `iis.setup_certenroll` | SRV1 IIS + share (+Cert Publishers ACL) + vdir + dir-browsing + double-escaping | no | readback |
| `ocsp.install` | SRV1 `Install-AdcsOnlineResponder` | no | `ocsp.verify` |
| `cert.enroll` | SRV1 OCSP signing cert / WIN11 Workstation cert (`Get-Certificate`, optional `gpupdate`+`certutil -pulse`, optional DER export) | no | `cert.verify` |
| `ocsp.configure_revocation` | SRV1 revocation config via `CertAdm.OCSPAdmin` COM (see risk) | no | `ocsp.verify` |
| `ocsp.verify` (VmRead) | COM readback + `http://localhost/ocsp` probe | — | — |
| `file.read` / `file.write` | every cross-VM carry (relay) | no | digest check |

Each new command needs a hand-mirrored entry in `routers/orchestrator.py` `_COMMAND_CAPABILITIES`
(grows 8→~28 — add a shared parity fixture test). `hostname.rename` stays but is unused by the lab
path. The `ocsp.configure_revocation` COM script must be frozen against a hand-configured
`ocsp.msc` dump before merge (see risks).

## Op → command-sequence expansions (backend)

- **createVm** (all): clone (DC ISO also carries `25-password.ps1` = operator password) → wait-for-agent.
- **createVm(DC) tail:** `dc.install_forest` → reboot-wait → `dc.verify` → `dns.set_client(self)` →
  `dns.create_record(pki CNAME)` (deferred to webServerCert if no web node yet).
- **createVm(root CA) tail:** `ca.install(Root)` → `ca.configure_settings(52w/10y/DSConfigDN)` →
  `ca.configure_cdp_aia(3/3)` → `ca.publish_crl` → `file.read` root crt/crl into relay.
- **domainJoin:** `dns.set_client(DC IP)` → `domain.join` → reboot-wait → `domain.verify`
  (+ webServer tail: `iis.setup_certenroll` share/ACL half).
- **caConnect (issuing→root):** CA02 `file.write`+`cert.addstore` root → DC01 `cert.dspublish` ×2 →
  SRV1 `file.write` root → CA02 `ca.install(Issuing)`→`file.read` CSR → CA01 `file.write`+`ca.sign_request`→`file.read` cert →
  CA02 `file.write`+`ca.install_cert`→`ca.configure_settings`→`ca.configure_cdp_aia(+OCSP AIA)`→`ca.publish_crl`→`file.read` issuing crt→`file.write` to SRV1→`ca.publish_template` →
  DC01 `template.grant_access(OCSPResponseSigning→SRV1$)`.
- **webServerCert (CA→web):** `iis.setup_certenroll` → `ocsp.install` → `cert.enroll(OCSPResponseSigning)` →
  `file.write` issuing crt → `ocsp.configure_revocation` → `ocsp.verify` (+ deferred DNS CNAME).
- **client enrollment rides the plan:** a `domainJoin` targeting a `client` node with an issuing CA
  present appends `cert.enroll(Workstation, export C:\win11.cer)` → `cert.verify` — the Deploy ends
  at lab step 9's verified chain.

## Frontend changes

- New `ConfigField` type `"password"` (masked input + inline AD-complexity checklist via
  `lib/passwordPolicy.ts`, mirrored in `template_config.py`; masked in stored-config, drift diff,
  never in op labels). Validation: ≥12 chars, ≥3 of 4 classes, not containing "Administrator"/vmName.
- Template fields (`templates.ts` + `template_config.py` mirror): DC `+domainAdminPassword`; CA
  `+cpsUrl` (`hideWhen caType=Root`); web `+ocspRefreshMinutes` (`hideWhen enableOcsp=Disabled`);
  caType-conditional `validityYears` default (20 root / 10 issuing).
- Offline-root presentation for `caTier==="root"` nodes: air-gap badge replacing the IP row,
  operator-only IP in the Orchestrator panel, dashed root `caHierarchy` edges with a "manual
  transfer" tooltip.
- Remove the "Promote to DC" / "Install … CA" disabled stubs. Keep `powershell.exec_arbitrary` and
  "Retry deploy" as escape hatches; add an "Enroll workstation cert" Orchestrator row.
- Add `secondary` to the deploy payload in `buildOpPayload`. New phase strings only (no
  `applyPlanState` contract change — phases are opaque display strings).

## Ordered slices (independently committable; single-line commits, no trailers)

Rust command surface first — each slice is `MockPowerShell`-tested and manually dispatchable from the
Inspector, so the command set is itself a useful intermediate product (manual lab assembly) before
the orchestration spine exists. Each Rust slice pairs with a one-line backend capability-map commit.

1. `feat(commands): add dc/domain/ca verify reads and dns.set_client` — low risk.
2. `feat(commands): add DNS record, cert store, dspublish and template ACL commands` — medium (AD ACL).
3. `feat(commands): add forest install and domain join with reboot reporting` — **high** (reboot contract).
4. `feat(commands): extend ca.install for issuing CAs and add CA settings/CDP-AIA/CRL commands` — med-high.
5. `feat(commands): add cross-signing, cert install and template publish commands` — medium (RequestId parse).
6. `feat(commands): add IIS CertEnroll, online responder install and cert enroll commands` — medium.
7. `feat(commands): add OCSP revocation configuration via CertAdm COM` — **highest** (canary protocol below).
8. `feat: operator-set domain admin password for the DC template` (backend+frontend lockstep) — secret-handling review.
9. `feat(orchestrator): plan-driven command dispatch relay and agent wait` — **high** (new IPC path; removes `_PROVISION_COMMAND`).
10. `feat(deploy): execute domain joins for real` — high (first reboot-spanning op).
11. `feat(deploy): execute forest promotion and CA cross-signing for real` — **high** (needs slices 3–5 + file relay).
12. `feat(deploy): execute web host, OCSP and client enrollment for real` — high (needs slice 7).
13. `feat(canvas): lab-complete template config and offline root presentation` — low.
14. `test: full two-tier lab deploy verification notes` — the sign-off.

(Per standing rule, this commit list/count is not changed without user consent.)

## Risks
1. **Run-as-credential exec from a SYSTEM service** (session-0 `-Credential`) gates every CA02
   enterprise step — prototype on a real VM first; fallback scheduled-task trampoline.
2. **OCSP COM automation** — spec is not copy-paste-ready. Canary protocol: hand-configure one
   revocation config in `ocsp.msc`, dump `$ocsp.OCSPCAConfigurationCollection | Format-List *` +
   provider properties, freeze the script to reproduce it, `ocsp.verify` asserts the readback,
   end-to-end proof is WIN11 `cert.verify -urlfetch`. Degrade to best-effort so it can't poison
   WIN11 verification (decide: does verify success require OCSP, or accept CRL-only?).
3. **AD timing** — ADWS post-promotion, template/enrollment propagation — every post-reboot/publish
   step needs retry windows tuned on real hardware.
4. **Long single Celery task** (60–90 min) — broker visibility timeout / worker restart triggers
   redelivery mid-run; the `plan_runs` cursor + deterministic job ids must be airtight; test
   redelivery deliberately (**never on broker db1** — stale tasks fire real clones).
5. **Secret residual exposure** — password transits the Celery payload, the firstboot ISO, and the
   `agent-dispatch` channel (same trust domain as the agent token already on the ISO). Verify
   progress-frame redaction end-to-end.
6. **Hostname-derivation coupling** — every URL/CNAME/UNC/ACL uses `hostname_for(vmName)` of *other*
   nodes; a missing node must degrade gracefully (dangling CNAME fine; UNC CDP not).
7. **Capability parity** — `_COMMAND_CAPABILITIES` mirror grows 8→~28; add a shared fixture test.

## Verification
No real Windows VM exists in this environment, so per-slice verification is:
- **Rust:** `cargo test` (MockPowerShell unit tests incl. canned-output parse tests), `cargo clippy
  --all-targets -- -D warnings`, `cargo fmt --check`; then manual dispatch of each new command from
  the Inspector Orchestrator panel against a real VM (the canary column above).
- **Backend:** OpenAPI route check; a scripted single-op plan (clone → `hostname.read` via the relay)
  to prove the dispatch bridge; deliberate Celery redelivery test on isolated dbs (12/13/14, blank
  `ESXI_*`), never db1.
- **Full-lab sign-off (slice 14):** 5-node canvas → Deploy → the lab's own "Health Verification"
  (`certutil -verify -urlfetch` on WIN11 shows OCSP/CRL/AIA verified; `pkiview.msc` containers OK).
