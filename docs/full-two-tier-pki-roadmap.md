# Full Two-Tier PKI Roadmap

## Goal

Stage the four-machine PKI infrastructure described by `two-tier-pki.html` and
`vm-building.md`, replace the guides' classical CA keys with ML-DSA-87, and
deploy it to ESXi from one reviewed plan without manual repair:

```text
DC01  Active Directory + DNS + LDAP CDP/AIA
CA01  standalone offline Root CA (ML-DSA-87)
CA02  enterprise Issuing CA (ML-DSA-87)
SRV1  IIS HTTP CDP/AIA + Online Responder
```

The completion gate is not merely "four VMs exist." A deployment is complete
only when a probe certificate issued to SRV1 reports the certificate chain,
OCSP, CDP, and AIA as verified, and CA02's enterprise PKI containers are healthy.

## Distance From The Goal

| Area | Current position | Readiness |
|---|---|---:|
| Canvas and local staging | Role catalog, CA hierarchy, growing domain circle, staged operations, persistence, one Deploy action | 75% |
| Guide command coverage | Forest, joins, CA install/config, relay, IIS, OCSP, templates, enrollment, CNAME, and verification commands exist | 80% |
| Correct orchestration | The backend validates planned/realized resources and compiles a canonical dependency DAG from the final topology | 80% |
| Exact scoped parity | Incomplete DNS lifecycle, weak final assertions, and simulated domain leave | 60% |
| ESXi one-shot confidence | Clone and agent paths exist, but ML-DSA, OCSP COM, SYSTEM credential use, timing, and filenames remain hardware canaries | 35% |

The implementation is therefore roughly **three quarters code-complete**, but
only **one third operationally proven**. A credible estimate is **8-12 focused
engineering weeks plus repeated real-ESXi soak runs**. Hardware or Windows
image problems can extend the calendar even when the code is complete.

## What Already Works

- Nodes can be configured and connected while staged; deployment is no longer
  required before a CA hierarchy edge can exist.
- A preconfigured four-node project can be created and sent as one deploy plan.
- Root and issuing CA installation accepts ML-DSA-87 and the agent supplies the
  Windows provider, fixed key length, and `NoHash` parameters.
- DC promotion, member DNS configuration, domain join, CA cross-sign relay,
  CA registry settings, AIA/CDP arrays, CRL publication, template publication,
  IIS CertEnroll setup, OCSP setup, probe enrollment, and the PKI CNAME all
  have backend/agent command paths.
- Root-to-issuing artifact movement is relayed through the backend, preserving
  the offline-root/sneakernet model.
- SRV1 enrolls a dedicated health certificate and the terminal `lab.verify`
  gate reports structured ML-DSA, chain, AIA, CDP, OCSP, AD PKI, publication,
  CA service, DNS, agent, and runtime identity evidence.
- Operations stream phases and progress and retain enough state to retry or
  tear down failed clones.

## Blocking Bugs And Gaps

### Completed: Authoritative plan correctness

The backend ignores client-supplied `dependsOn` values for known operations and
compiles the final topology into the guide's semantic dependency graph. It also
rejects missing operations for planned resources and replayed operations for
resources already marked realized. A fully staged canvas can no longer run:

- `caConnect` before CA02 is domain joined;
- `caConnect` before SRV1 has joined and created the CertEnroll share;
- SRV1 probe enrollment before CA02 publishes its required template;
- final verification before SRV1's HTTP and OCSP services are healthy.

The dry-run endpoint returns the authoritative operations, semantic diagnostics,
resource summary, duration estimates, and critical path for preview.

Required critical path:

```text
clone DC01 -> promote forest
clone CA01 -> install/configure root -> export root artifacts
clone CA02 ------------------------------------+
clone SRV1 ------------------------------------+-> join CA02 and SRV1
                                               +-> cross-sign/install CA02
                                                   -> publish CRL/AIA/templates
                                                   -> configure IIS + OCSP + PKI CNAME
                                                   -> enroll/verify SRV1 probe
                                                   -> final lab health gate
```

Regression tests cover arbitrary staging order, persisted projects, retries
with realized create operations removed, missing relationships and operations,
replayed realized operations, and cycle diagnostics.

### Completed: Golden image readiness

The four scoped roles can share the patched `ws-2025-base`, but one-shot deploy
still requires the image to be treated as a validated resource:

- DC01, CA01, CA02, and SRV1 -> patched Windows Server 2025 image;
- compatible firstboot runner and current orchestrator agent;
- required Windows update and ML-DSA provider availability.

The operator settings screen selects a role-specific image, datastore, port
group, CPU, memory, disk reservation, and usage ceiling for every PKI machine.
Deploy preflight proves each base exists, matches its qualified image revision
and guest OS, has its network mapping, has aggregate reserved capacity, and
does not collide with a requested VM name. Qualification also pins the Windows
build, runner, agent digest, ML-DSA provider, SYSTEM execution canary, time/update
state, backend callback, and OCSP reference dump where required.

### Completed: Strong end-to-end success criteria

`cert.verify` now reports separate facts instead of treating a generic
successful `certutil` marker as the whole sign-off:

- chain build successful;
- root and issuing certificates fetched through AIA;
- base and delta CRLs fetched through CDP;
- OCSP response fetched and verified;
- expected ML-DSA signature OIDs/algorithms are present;
- certificate validity and revocation freshness are acceptable.

The final `lab.verify` aggregate also checks AD PKI containers, CA services,
DNS records, HTTP artifacts, OCSP configuration, template publication, agent
health, and expected VM/OS identities. Its evidence survives worker redelivery.
Deploy is green only if this gate passes; CRL-only success is not sufficient.

### Completed: DNS as an explicit resource

The semantic topology now carries symbolic A/PTR/CNAME resources owned by an
authoritative DC. The canvas derives A records for DC01, CA02, and SRV1 plus
the PKI CNAME, and exposes an optional reverse-zone override that enables PTR
resources. Runtime resolution uses the allocated IPs and real guest hostnames.

Deployment verifies AD SRV records after promotion, A/PTR registration after
each join, and the CNAME plus HTTP CertEnroll path from CA02 and SRV1. Matching
pre-existing records are retained; conflicting values fail instead of being
overwritten. DNS cleanup/retention remains part of dependency-aware teardown.

### Completed: Connection meaning and missing-service guidance

Connections now model capabilities instead of generic lines through typed ports:

- CA parent: `issues CA certificate`;
- CA publication: `HTTP CDP`, `HTTP AIA`, `OCSP URL`;
- domain boundary: `AD membership`, `DNS resolver`, `LDAP publication`;
- web host: `CertEnroll share`, `HTTP CertEnroll`, `Online Responder`;
- probe certificate: `enrollment`, `chain validation`, `revocation validation`.

Every connection exposes three layers of labeling:

1. **Intent** before deploy: what the edge will provide.
2. **Requirements** on hover/select: prerequisites and generated operations.
3. **Health** after deploy: planned, applying, verified, degraded, or broken.

The canvas and backend topology linters produce actionable messages including:

- "CA02 has a parent but is not inside an AD domain."
- "CA02 publishes HTTP CDP/AIA, but no web host is connected."
- "SRV1 has OCSP enabled, but no issuing CA grants its enrollment template."
- "SRV1 can enroll its probe, but no verified OCSP path reaches its certificate."
- "PKI CNAME is planned, but its target has no A record."

### Completed: Real lifecycle operations

- [x] Implement `domainLeave` with membership and owned-DNS absence verification.
- [x] Implement reconcile jobs that reapply persisted convergent desired state.
- [x] Add teardown ordering for CA roles, DNS records, domain membership, IP
  leases, registry documents, and ESXi VMs.
- [x] Add cancellation checkpoints at safe step and operation boundaries.
- [x] Give transient ADWS, DNS, template, enrollment, CRL, and OCSP operations
  bounded redispatch policies with stable resume cursors.

### Completed: Operator configuration and preflight

The settings API and visible Settings dialog now provide a complete setup flow for:

- [x] ESXi endpoint and credential test;
- [x] datastore, network/port-group, and role-specific image mappings;
- [x] Windows Server golden image and immutable revision qualification;
- [x] guest IP range, gateway, DNS, suffix, and reverse-zone policy;
- [x] worker, Mongo, Valkey, agent binary, and backend callback reachability;
- [x] time synchronization and Windows update prerequisites;
- [x] ML-DSA provider availability on both CA images.

Deploy should begin with a fast immutable preflight snapshot. If any prerequisite
changes after preflight, the job should fail before the first clone.

## Phased Delivery

### Phase 0 - Stabilize staging and visual semantics [complete]

- [x] Fix node width and progress overflow.
- [x] Keep staged nodes connectable and add a regression test.
- [x] Add typed edge labels, legends, tooltips, and missing-relationship warnings.
- [x] Make the supplied project use DC01/CA01/CA02/SRV1, the guide's forest
  level, and ML-DSA-87.

**Exit:** the complete intended topology can be built in any interaction order
without deployment and has no unexplained line or warning.

### Phase 1 - Authoritative topology compiler [complete]

- [x] Introduce a versioned topology document separate from executable operations.
- [x] Compile topology -> resources -> operations -> dependency DAG on the backend.
- [x] Add semantic validation, critical-path output, duration estimates, and a dry run.
- [x] Preserve operation IDs across recompilation so resume and metrics remain useful.

**Exit:** arbitrary staging order produces the same safe guide order.

### Phase 2 - Infrastructure and DNS resources [implementation complete]

- [x] Add template-specific golden images and ESXi/network mappings.
- [x] Implement explicit A/PTR/CNAME resources and DNS verification.
- [x] Complete operator settings and environmental preflight.
- [x] Add VM hardware sizing and aggregate datastore-capacity reservations.

**Exit:** deploy can prove all external prerequisites before cloning.

### Phase 3 - Complete and harden PKI execution [implementation complete]

- [x] Require ML-DSA-87 root and subordinate canary qualifications on the exact
  patched golden-image revisions selected for deploy.
- [x] Freeze the OCSP COM configuration against a hand-configured reference dump.
- [x] Require credentialed ADCS/domain canaries from the SYSTEM agent context.
- [x] Fix CA publication filename derivation using observed certutil output, not
  common-name guessing.
- [x] Add retry policies for ADWS, DNS, template replication, enrollment, CRL,
  and OCSP.

**Exit:** three consecutive fresh full-lab deploys pass on ESXi without repair.

**Hardware acceptance pending:** the code now refuses unqualified images, but
the three fresh ESXi runs must still be performed and attached as evidence
bundles in the target environment.

### Phase 4 - Verification, recovery, and teardown [implementation complete]

- [x] Add structured `lab.verify`.
- [x] Add a downloadable, access-controlled, redacted evidence bundle.
- [x] Implement real domain leave, reconciles, cancellation, and
  dependency-aware teardown.
- [x] Test restart/redelivery boundaries around destructive and rebooting steps.
- [x] Add restore-from-project and resume-from-job acceptance tests.

**Exit:** failures are diagnosable, resumable, and cleanly removable.

### Phase 5 - Product-quality UI

- Ship the visual direction below.
- Add keyboard-accessible non-spatial alternatives for every drag interaction.
- Add topology import/export, compare, and change review.
- Add guided and expert modes without hiding validation truth.

**Exit:** a new user can build the guide correctly without reading the guide,
while an expert can inspect every generated setting and command.

## Bold UI Direction

### 1. Living domain bubbles [complete]

Keep the growing circle, but turn it into a real boundary object:

- empty domains breathe subtly; members create soft gravitational wells;
- the bubble expands to fit committed members but previews its future shape
  while dragging;
- the rim carries domain/DNS health, member count, and forest state;
- dropping an eligible node into the bubble previews the exact join operations;
- invalid drops make the rim repel the node and explain why;
- nested overlays show DNS, LDAP publication, and authentication reach separately.

Provide an accessible `Join domain` action that produces the same preview.

### 2. PKI trust gravity [complete]

Render CAs as weighted trust bodies. A root sits at the top/center, issuing CAs
orbit by tier, and workloads sit downstream. Creating a hierarchy edge visibly
pulls the child into a stable tier. Cycles or second parents resist the gesture
rather than failing only after drop.

The offline root has a broken orbit: requests and certificates animate as a
small sealed package crossing the gap through the backend relay, never as live
network traffic.

### 3. Service sockets instead of anonymous handles [complete]

Replace tiny unlabeled handles with discoverable sockets that appear on focus:

- amber shield socket: CA issuance;
- green document socket: CDP/AIA publication;
- violet pulse socket: OCSP;
- blue boundary socket: domain membership/DNS;
- white certificate socket: enrollment.

Dragging from a socket highlights only compatible destinations and previews the
edge label, required operations, and anything still missing.

### 4. Deploy compiler view

Deploy opens a review sheet rather than immediately posting the list:

- left: topology requirements and warnings;
- center: compiled dependency timeline with the critical path;
- right: resource changes, secrets used, VM/image/IP assignments, and estimates.

Users can click any timeline step to highlight the responsible nodes and edges.
The final button reads `Deploy 4 VMs / 38 verified steps` rather than just Deploy.

### 5. Certificate journey lens

A toggle changes the canvas from infrastructure view to the path of one sample
certificate:

```text
SRV1 probe enrolls -> CA02 issues -> AIA builds chain -> CDP/OCSP checks status
```

Each hop shows its concrete URL, DNS resolution, artifact, signature algorithm,
last verification time, and failure reason. This makes CDP/AIA/OCSP understandable
as a user journey rather than abstract acronyms.

### 6. Health heatmap and evidence mode

After deployment, edges become live probes and nodes become compact health cards.
Failures color the exact service segment, not the entire machine. Evidence mode
freezes the canvas into a shareable audit snapshot containing topology, ML-DSA
parameters, certificate fingerprints, CRL/OCSP freshness, and verification output.

### 7. Stable compact nodes

Nodes keep a fixed compact width. Long phases truncate on the card and expand in
a hover/focus popover or the deployment timeline. A node shows only identity,
lifecycle, strongest warning, and two key facts; configuration belongs in the
Inspector. This prevents `Step 1/6 - ca-install...` from changing the graph layout.

## Acceptance Matrix

| Gate | Required evidence |
|---|---|
| Topology | Four exact roles/names, root not domain joined, no missing required services |
| Images | All four roles use the validated Server 2025 base with the current agent |
| ML-DSA | Root and issuing CA keys/certificates report ML-DSA-87 parameters |
| AD/DNS | Forest healthy; A/PTR/SRV/CNAME records resolve from members |
| Publication | Root and issuing certs/CRLs present in file, LDAP, HTTP, and required stores |
| OCSP | Responder configuration healthy and an actual issued cert receives a verified response |
| Enrollment | SRV1 receives a dedicated health-probe certificate from CA02 |
| Verification | OCSP, CRL/CDP, certificate/AIA, chain, and enterprise PKI checks all pass |
| Recovery | Worker restart resumes; failed plans can retry; teardown removes owned resources |
| UX | Plan is fully stageable locally, explains every missing dependency, and never changes node width |

## Recommended Next Work Order

1. ~~Backend semantic compiler and topology validator.~~
2. ~~Fix the supplied template's compiled dependency order and add regression tests.~~
3. ~~Windows Server golden-image validation and preflight.~~
4. ~~Explicit DNS A/PTR/CNAME resources and verification.~~
5. ~~Structured ML-DSA/OCSP/CDP/AIA final health gate.~~
6. ~~Real operator settings/preflight UI.~~
7. Real-ESXi canary matrix, then three-run soak acceptance with evidence bundles.
8. Deploy compiler, certificate journey, and evidence UI.
