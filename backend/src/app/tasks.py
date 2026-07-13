"""Celery tasks. Runs in the worker process — never inside the FastAPI app.

The clone task owns the blocking vmkit call and publishes progress over the Valkey
transport (``app.core.jobs.transport``). It reuses ``CloneProgressReducer`` and
``_clone_total_ops`` from the clone route unchanged, and ``map_vmkit_error`` for the
same error → status mapping the synchronous routes use.

The plan runner (``run_plan_task``) walks a validated deploy-plan DAG the same
way. Every ``createVm`` op is a real vmkit clone booted from a
per-VM firstboot ISO (``core.firstboot``) that bakes in an address claimed
from the guest IP pool (``core.ippool``); the other op kinds are timed stubs.
Like the clone task, it opens its own ESXi connection against the shared
org-wide target from the Mongo settings document (``core.esxi.load_target_sync``
— the async client is API-process-bound), so the worker needs Mongo +
``SETTINGS_ENC_KEY``, not ``ESXI_*`` env vars. Its Mongo writes (IP
allocation, vm_registry) go through one short-lived sync client per task
(``core.db.sync.worker_db``).
"""

import logging
import time
import uuid
from contextlib import nullcontext
from dataclasses import asdict
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING

from pyVim.connect import Disconnect
from vmkit import clone_workflow, destroy_workflow, open_connection
from vmkit.errors import VmExistsError, VmkitError, VmNotFoundError
from vmkit.esxi import get_vm_by_name

from configgen import OrchestratorAgentConfig, render_orchestrator_config

from app.celery_app import celery_app
from app.core import agents
from app.core.db.models import now_ms
from app.core.db.sync import worker_db
from app.core.errors import map_vmkit_error
from app.core.esxi import load_target_sync
from app.core.firstboot import AgentBundle, build_authored_iso, build_firstboot_iso
from app.core.ippool import (
    IpPoolExhaustedError,
    allocate_ip_sync,
    load_guest_network_sync,
    release_ip_sync,
)
from app.core.settings import settings
from app.core.template_config import encrypt_config_secrets, extract_template_config
from app.core.jobs import transport
from app.core.jobs.models import (
    DoneMsg,
    ErrorMsg,
    JobStatus,
    OpRunState,
    PlanStateMsg,
    ProgressMsg,
    RunningMsg,
)


logger = logging.getLogger(__name__)


def _open_worker_connection():
    """Shared-target connection for one task; raises if no target is configured
    (the API routes pre-check this, so hitting it here means the target was
    unset between enqueue and execution)."""
    target = load_target_sync()
    if target is None:
        raise RuntimeError("No shared ESXi target configured (settings document).")
    return open_connection(target.host, target.user, target.password, target.port)


def _live_worker_connection(conn):
    """Return a live worker connection, reopening it if the ESXi session died.

    A plan holds ONE raw connection across every clone, but provisioning steps
    between clones (``dc.install_forest`` / ``ca.install``, each up to 1800s)
    can outlast ESXi's session idle-timeout — the next clone would then fail
    with ``vim.fault.NotAuthenticated``. The API side handles this in
    ``core.esxi.ConnectionManager``; the worker mirrors it with a cheap
    ``CurrentTime`` probe before each clone (clones are infrequent and far more
    expensive than the round trip, so no rate-limiting is needed here)."""
    if conn is not None:
        try:
            conn.si.CurrentTime()
            return conn
        except Exception:  # noqa: BLE001 — expired/dead session; drop and reopen
            try:
                Disconnect(conn.si)
            except Exception:  # noqa: BLE001 — the old session may already be dead
                pass
    return _open_worker_connection()

if TYPE_CHECKING:
    from vmkit import Connection

    from app.routers.deploy import PlanOp

#: Server-side mirror of the frontend's STANDALONE_CLONE (constants/templates.ts /
#: the pre-staging topology.ts) — the backend does not accept arbitrary hardware
#: params from the client, only the per-VM name.
PLAN_CLONE_DEFAULTS = {
    "base": settings.clone_base,
    "datastore": "datastore1",
    "cpus": 2,
    "mem_mb": 4096,
}

#: Three named phases per simulated op kind, ticked at a fixed cadence.
#: ``createVm`` is deliberately absent — it is always a real clone.
_SIMULATED_PHASES: dict[str, tuple[str, str, str]] = {
    "domainJoin": ("Joining domain", "Rebooting", "Verifying membership"),
    "domainLeave": ("Leaving domain", "Rebooting", "Verifying removal"),
    "caConnect": ("Generating CSR", "Signing certificate", "Installing CA certificate"),
    "webServerCert": ("Requesting certificate", "Binding to IIS", "Publishing CDP/AIA"),
}
_SIMULATED_PERCENTS = (33.0, 66.0, 100.0)
_SIMULATED_STEP_SECONDS = 0.6


@celery_app.task(name="clone_vm")
def clone_vm_task(job_id: str, params: dict) -> None:
    # Imported lazily to avoid a hard import-time dependency between the worker
    # entrypoint and the FastAPI router module.
    from app.routers.vm import CloneProgressReducer, CloneRequest, _clone_total_ops

    transport.publish(job_id, RunningMsg(), status=JobStatus.running)

    try:
        req = CloneRequest(**params)
        conn = _open_worker_connection()
        reducer = CloneProgressReducer(transport.make_publisher(job_id), _clone_total_ops(req))
        result = clone_workflow(conn, progress=reducer, **params)
        transport.publish(
            job_id, DoneMsg(result=asdict(result)), status=JobStatus.done, terminal=True
        )
    except VmkitError as exc:
        status, detail = map_vmkit_error(exc)
        transport.publish(
            job_id, ErrorMsg(status=status, detail=detail), status=JobStatus.error, terminal=True
        )
    except Exception as exc:  # noqa: BLE001 — surface anything as a terminal error
        transport.publish(
            job_id, ErrorMsg(status=500, detail=str(exc)), status=JobStatus.error, terminal=True
        )


@celery_app.task(name="destroy_vm")
def destroy_vm_task(job_id: str, name: str) -> None:
    """Tear down a VM: power off + destroy, reclaim its guest IP, mark the
    registry entry deleted.

    A VM already absent from inventory (``VmNotFoundError``) still converges
    to success — the clone may have half-failed leaving only registry/IP
    state, and that must be cleanable through the same teardown call. Any
    other vmkit failure leaves the allocation in place (the VM still exists
    and may be using the address).
    """
    from app.routers.vm import CloneProgressReducer

    transport.publish(job_id, RunningMsg(), status=JobStatus.running)

    try:
        conn = _open_worker_connection()
        try:
            already_absent = False
            try:
                # Two ops: power off + destroy (the reducer only needs a total).
                reducer = CloneProgressReducer(transport.make_publisher(job_id), 2)
                destroy_workflow(conn, name=name, progress=reducer)
            except VmNotFoundError:
                already_absent = True
        finally:
            Disconnect(conn.si)

        with worker_db() as db:
            release_ip_sync(db, name)
            db["vm_registry"].update_one(
                {"vmName": name},
                {
                    "$set": {
                        "status": "deleted",
                        "powerState": None,
                        "ip": None,
                        # Revoke the agent identity: authenticate_persisted also
                        # excludes deleted VMs, but dropping the hash makes the
                        # revocation explicit and idempotent.
                        "agent": None,
                        "updatedAt": now_ms(),
                    }
                },
            )

        transport.publish(
            job_id,
            DoneMsg(result={"name": name, "alreadyAbsent": already_absent}),
            status=JobStatus.done,
            terminal=True,
        )
    except VmkitError as exc:
        status, detail = map_vmkit_error(exc)
        transport.publish(
            job_id, ErrorMsg(status=status, detail=detail), status=JobStatus.error, terminal=True
        )
    except Exception as exc:  # noqa: BLE001 — surface anything as a terminal error
        transport.publish(
            job_id, ErrorMsg(status=500, detail=str(exc)), status=JobStatus.error, terminal=True
        )


def _op_progress_publisher(state: dict[str, OpRunState], op_id: str, push):
    """``Publish``-shaped callable that folds ``ProgressMsg`` samples from
    ``CloneProgressReducer`` into this op's slot in the plan state, then pushes
    the whole snapshot."""

    def _publish(msg) -> None:
        if isinstance(msg, ProgressMsg):
            state[op_id] = OpRunState(status="running", percent=msg.percent, phase=msg.phase)
            push()

    return _publish


def _registry_upsert_sync(db, vm_name: str, **fields) -> None:
    """Worker-side mirror of ``routers/vm_registry.upsert_entry`` (same
    ``vmName`` key and ``$setOnInsert`` identity pinning, sync client)."""
    fields["updatedAt"] = now_ms()
    db["vm_registry"].update_one(
        {"vmName": vm_name},
        {
            "$set": fields,
            "$setOnInsert": {
                "_id": uuid.uuid4().hex,
                "createdAt": now_ms(),
                "schemaVersion": 1,
            },
        },
        upsert=True,
    )


#: Agents minted but never connected past this window (on a VM that errored or
#: was torn down) are swept — a backstop for a bricked firstboot or a wrong
#: backend URL leaving a dangling identity.
_STALE_AGENT_MS = 24 * 60 * 60 * 1000


def _sweep_stale_agents_sync(db) -> None:
    """Null out long-pending agent identities on failed/deleted VMs.

    Piggybacks on plan runs (like the ISO orphan sweep) rather than needing a
    scheduler. Only touches ``error``/``deleted`` registry entries, so a healthy
    VM whose agent is merely slow to phone home keeps its identity.
    """
    cutoff = now_ms() - _STALE_AGENT_MS
    db["vm_registry"].update_many(
        {
            "agent.provisionState": "pending",
            "agent.mintedAt": {"$lt": cutoff},
            "status": {"$in": ["error", "deleted"]},
        },
        {"$set": {"agent": None, "updatedAt": now_ms()}},
    )


def _cleanup_failed_clone(conn, db, vm_name: str, ip: str | None) -> None:
    """Roll back a failed createVm op without orphaning a live VM.

    The IP allocation and the just-minted agent identity are reclaimed only
    when the VM is provably absent from inventory. A clone that fails AFTER
    the VM was created (e.g. a vSphere fault while reading back the moid)
    leaves a booted VM holding both the address and the baked-in token —
    wiping them would strand the agent (403 forever, the hash is gone) and
    let a later clone claim an address still in use. When absence can't be
    proven (the inventory check itself fails), everything is kept; teardown
    is the reclaim path either way.
    """
    try:
        vm_absent = get_vm_by_name(conn.content, vm_name) is None
    except Exception:  # noqa: BLE001 — can't prove absence; keep identity + IP
        vm_absent = False
    if vm_absent:
        if ip is not None:
            release_ip_sync(db, vm_name)
        _registry_upsert_sync(db, vm_name, status="error", ip=None, agent=None)
    else:
        _registry_upsert_sync(db, vm_name, status="error")


def _set_provision_state(db, vm_name: str, provision_state: str) -> None:
    db["vm_registry"].update_one(
        {"vmName": vm_name},
        {"$set": {"agent.provisionState": provision_state, "updatedAt": now_ms()}},
    )


def _plan_domain_facts(ops: list["PlanOp"]) -> tuple[str | None, str | None]:
    """The forest's (domainName, netbiosName) read from the plan's DC createVm
    op — a constant decided up front, so the root CA's DSConfigDN / pki URLs
    resolve even when the DC VM isn't up yet (they may clone in parallel)."""
    from app.routers.deploy import PlanOpKind

    for op in ops:
        if op.kind is PlanOpKind.create_vm and op.params.get("template") == "domainController":
            return op.params.get("domainName"), op.params.get("netbiosName")
    return None, None


def _provision_cloned_vm(
    conn_db,
    op: "PlanOp",
    ops: list["PlanOp"],
    vm_id: str,
    ip: str | None,
    job_id: str,
    owner_role: str,
    state: dict[str, OpRunState],
    push,
) -> bool:
    """Run a freshly-cloned VM's per-template provision sequence.

    Waits for the baked-in agent to phone home, then walks the template's
    provision steps through the agentbus dispatch bridge (reboots + verify
    handled by the engine). Flips ``provisionState`` applied/failed and returns
    whether it succeeded. An empty sequence (nothing to self-provision on first
    boot — e.g. a member server or an issuing CA) still waits for phone-home —
    the op must never read ``done`` while the orchestrator has yet to connect,
    and later cross-node ops assume every clone in the plan has a live agent."""
    from app.core import agentbus
    from app.core.firstboot import hostname_for
    from app.core.sequences import NodeContext, RunContext, SequenceError
    from app.core.sequences.definitions import provision_steps
    from app.core.sequences.worker import run_op_sequence
    from app.core.template_config import extract_template_config

    template = op.params["template"]
    steps = provision_steps(template, ca_type=op.params.get("caType"))

    vm_name = op.params["vmName"]
    _set_provision_state(conn_db, vm_name, "applying")
    # Carried on every running push so the frontend learns the agent identity
    # (and can show its presence dot) long before the op finishes.
    partial = {"agentVmId": vm_id}
    state[op.id] = OpRunState(
        status="running", percent=100.0, phase="Waiting for agent", result=partial
    )
    push()
    op_started = time.monotonic()
    try:
        agentbus.wait_for_agent(vm_id, timeout_s=settings.agent_phone_home_timeout_s)
        logger.info(
            "op %s: agent %s phoned home after %.1fs",
            op.id, vm_id, time.monotonic() - op_started,
        )

        # A fresh clone phones home during an intermediate firstboot boot and
        # then reboots once more to finalize its hostname — probe boot_info
        # until the VM is provably on its final boot so we don't dispatch into
        # an agent that reboot is about to kill (legacy agents fall back to
        # the connection-stability dwell inside wait_for_settled_boot).
        def _boot_phase(phase: str) -> None:
            state[op.id] = OpRunState(
                status="running", percent=100.0, phase=phase, result=partial
            )
            push()

        _boot_phase("Waiting for boot to settle")
        settle_started = time.monotonic()
        agentbus.wait_for_settled_boot(
            vm_id,
            db=conn_db,
            timeout_s=settings.agent_phone_home_timeout_s,
            role=owner_role,
            job_key_prefix=f"{job_id}-{op.id}-bootprobe",
            on_phase=_boot_phase,
        )
        logger.info(
            "op %s: boot settled on %s after %.1fs",
            op.id, vm_id, time.monotonic() - settle_started,
        )
        if steps:
            state[op.id] = OpRunState(
                status="running", percent=0.0, phase="Provisioning", result=partial
            )
            push()
            node = NodeContext(
                node_id=op.target,
                vm_name=vm_name,
                hostname=hostname_for(vm_name),
                agent_vm_id=vm_id,
                ip=ip,
                template_id=template,
                template_config=extract_template_config(template, op.params),
            )
            # Domain facts from the plan's DC op so the root CA's DSConfigDN /
            # pki URLs resolve even when the DC VM isn't up yet.
            domain_name, netbios = _plan_domain_facts(ops)
            ctx = RunContext(
                nodes={"primary": node},
                domain_name=domain_name,
                netbios=netbios,
                pki_host=f"pki.{domain_name}" if domain_name else None,
            )
            on_step_complete, on_step_progress, on_step_tick = _sequence_progress(
                op.id, len(steps), state, push, result=partial,
                medians=_step_median_seconds(conn_db, steps),
            )
            run_op_sequence(
                conn_db, steps, ctx, plan_job_id=job_id, op_id=op.id, role=owner_role,
                on_step_complete=on_step_complete,
                on_step_progress=on_step_progress,
                on_step_tick=on_step_tick,
            )
    except (SequenceError, agentbus.AgentUnreachableError, agentbus.DispatchError,
            agentbus.ReconnectTimeoutError) as exc:
        _set_provision_state(conn_db, vm_name, "failed")
        state[op.id] = OpRunState(status="error", detail=f"provisioning failed: {exc}")
        push()
        return False

    logger.info(
        "op %s: provision of %s (%d steps) completed in %.1fs",
        op.id, vm_name, len(steps), time.monotonic() - op_started,
    )
    _set_provision_state(conn_db, vm_name, "applied")
    return True


def _run_clone_op(
    conn: "Connection",
    db,
    op: "PlanOp",
    ops: list["PlanOp"],
    job_id: str,
    state: dict[str, OpRunState],
    push,
    owner_role: str = "guest",
) -> bool:
    """Execute a ``createVm`` op for real, from one of three ISO sources:

    - default: claim a guest IP, render+pack the per-VM firstboot ISO;
    - inline authored files: pack exactly what the operator wrote;
    - uploaded ISO: fetch the GridFS file and attach it verbatim.

    Authored/uploaded ops deliberately claim NO pool address and render nothing
    — the authored content is the complete disc, so their op result carries no
    ``ip``. Returns False on failure — a claimed IP is released so a failed op
    never strands an address."""
    from app.routers.iso import delete_uploaded_iso_sync, fetch_uploaded_iso_sync
    from app.routers.vm import CloneProgressReducer, CloneRequest, _clone_total_ops

    vm_name = op.params["vmName"]
    # Golden-image guard, enforced here and not only in deploy.validate_plan:
    # run_plan_task trusts the plan payload's vmName verbatim (no re-validation,
    # no re-namespacing), so a plan that skipped the current route — a stale or
    # redelivered broker task, an old-code enqueue — could otherwise clone the
    # base image onto itself (`<base>/<base>.vmdk`, src == dst) and clobber the
    # golden template. Fail the op before any datastore write.
    if vm_name == settings.clone_base:
        state[op.id] = OpRunState(
            status="error",
            detail=(
                f"Refusing to clone a VM named '{settings.clone_base}' — it is the "
                "base image every clone copies from (stale/mis-routed plan?)."
            ),
        )
        push()
        return False
    iso_id = op.params.get("isoId")
    authored = bool(op.files) or bool(iso_id)
    bundling = settings.orchestrator_bundling_enabled and not authored
    state[op.id] = OpRunState(status="running", percent=0.0, phase="Starting")
    push()

    ip: str | None = None
    net = None
    vm_id: str | None = None  # set when an agent identity is minted
    if not authored:
        net = load_guest_network_sync(db)
        if net is None:
            # The route rejects plans without a configured range; hitting this
            # means it was cleared between enqueue and execution.
            state[op.id] = OpRunState(status="error", detail="Guest IP range is not configured.")
            push()
            return False
        # Fail cleanly BEFORE claiming an address if the agent binary is missing
        # on the worker host — an operator config error, not a per-VM one.
        if bundling and not Path(settings.orchestrator_agent_path).is_file():
            state[op.id] = OpRunState(
                status="error",
                detail=(
                    "Orchestrator agent binary not found on the worker host "
                    "(ORCHESTRATOR_AGENT_PATH)."
                ),
            )
            push()
            return False
        try:
            ip = allocate_ip_sync(db, vm_name, job_id)
        except IpPoolExhaustedError as exc:
            state[op.id] = OpRunState(status="error", detail=str(exc))
            push()
            return False

    _registry_upsert_sync(
        db, vm_name, appName=op.target, status="cloning", jobId=job_id, ip=ip
    )
    try:
        with TemporaryDirectory() as tmp:
            if iso_id:
                iso = fetch_uploaded_iso_sync(
                    db, iso_id, Path(tmp) / f"{vm_name}-config.iso"
                )
            elif op.files:
                iso = build_authored_iso(
                    [(f.name, f.content) for f in op.files],
                    vm_name=vm_name,
                    dest_dir=Path(tmp),
                )
            else:
                agent_bundle = None
                # Mint + bake an agent only when bundling is on AND the VM does
                # not already exist. A redelivery over a survivor (VmExists
                # below) must keep whatever token the running VM booted with —
                # so we never re-mint for it (we only hold the hash, not the
                # plaintext, and its throwaway ISO won't boot anyway).
                if bundling and get_vm_by_name(conn.content, vm_name) is None:
                    vm_id, token = agents.mint_identity()
                    # Persist the identity + the config the backend will dispatch
                    # after phone-home. Written before the ISO is built; the
                    # config never rides the ISO (backend-driven provisioning).
                    db["vm_registry"].update_one(
                        {"vmName": vm_name},
                        {
                            "$set": {
                                "agent": {
                                    "vmId": vm_id,
                                    "tokenHash": agents.hash_token(token),
                                    "role": owner_role,
                                    "templateId": op.params["template"],
                                    # Secrets (the DC's domainAdminPassword) are
                                    # AES-GCM encrypted before they touch Mongo;
                                    # the dispatch path decrypts them just in
                                    # time (core.template_config).
                                    "templateConfig": encrypt_config_secrets(
                                        op.params["template"],
                                        extract_template_config(
                                            op.params["template"], op.params
                                        ),
                                    ),
                                    "provisionState": "pending",
                                    "mintedAt": now_ms(),
                                }
                            }
                        },
                    )
                    agent_bundle = AgentBundle(
                        binary_path=Path(settings.orchestrator_agent_path),
                        config_toml=render_orchestrator_config(
                            OrchestratorAgentConfig(
                                vm_id=vm_id,
                                agent_token=token,
                                backend_url=settings.backend_public_url,
                                role=owner_role,
                            )
                        ),
                    )
                iso = build_firstboot_iso(
                    template=op.params["template"],
                    vm_name=vm_name,
                    ip=ip,
                    net=net,
                    dest_dir=Path(tmp),
                    agent=agent_bundle,
                )
            req = CloneRequest(
                name=vm_name,
                iso_path=str(iso),
                power_on=True,
                **PLAN_CLONE_DEFAULTS,
            )
            reducer = CloneProgressReducer(
                _op_progress_publisher(state, op.id, push), _clone_total_ops(req)
            )
            result = clone_workflow(conn, progress=reducer, **req.model_dump())

        vm = get_vm_by_name(conn.content, vm_name)
        _registry_upsert_sync(
            db,
            vm_name,
            status="ready",
            moid=vm._moId if vm is not None else None,
            powerState="poweredOn",
        )
        if iso_id:
            # Consumed — vmkit uploaded it to the datastore; the GridFS copy
            # has served its purpose (orphan sweep is the backstop).
            delete_uploaded_iso_sync(db, iso_id)

        # The clone is only half the createVm op. If an agent was
        # baked in, wait for it to phone home and run the template's provision
        # sequence through the dispatch bridge — the op isn't `done` until the
        # VM reaches provisionState=applied, so a dependent domainJoin genuinely
        # runs after (e.g.) the DC is promoted. A provisioning failure fails the
        # op (dependents cancel) but leaves the booted VM in place for teardown.
        if vm_id is not None:
            provisioned = _provision_cloned_vm(
                db, op, ops, vm_id, ip, job_id, owner_role, state, push
            )
            if not provisioned:
                return False

        state[op.id] = OpRunState(
            status="done",
            percent=100.0,
            phase="Done",
            # ip/vmName ride the op result so the frontend can label the node
            # and key teardown off the real inventory name. Authored clones
            # have no pool ip to report. agentVmId lets the Inspector
            # surface the auto-provisioned orchestrator identity.
            result={
                **asdict(result),
                "vmName": vm_name,
                **({"ip": ip} if ip else {}),
                **({"agentVmId": vm_id} if vm_id else {}),
            },
        )
        push()
        return True
    except VmExistsError as exc:
        # A VM by this name is already in inventory (redelivered task, or a
        # re-deploy over a survivor) — it may well be running with this very
        # address baked into its ISO, so the allocation is deliberately KEPT;
        # tearing the VM down is what releases it.
        status, detail = map_vmkit_error(exc)
        state[op.id] = OpRunState(status="error", detail=f"{status}: {detail}")
        push()
        return False
    except VmkitError as exc:
        status, detail = map_vmkit_error(exc)
        _cleanup_failed_clone(conn, db, vm_name, ip)
        state[op.id] = OpRunState(status="error", detail=f"{status}: {detail}")
        push()
        return False
    except Exception as exc:  # noqa: BLE001 — surface as an op-level failure, not a plan crash
        _cleanup_failed_clone(conn, db, vm_name, ip)
        state[op.id] = OpRunState(status="error", detail=str(exc))
        push()
        return False


#: Op kinds whose real command sequence (core.sequences.definitions) replaces
#: the timed stub. domainLeave has no plan sequence and stays simulated.
_REAL_SEQUENCE_KINDS = frozenset({"domainJoin", "caConnect", "webServerCert"})


#: Minimum gap between elapsed-heartbeat pushes for one step (the dispatch
#: poll ticks every ~1s; republishing that often is churn for no information).
_STEP_TICK_PUSH_GAP_S = 10.0
#: An estimated intra-step percent never claims more than this — the agent's
#: own frames (or step completion) take it the rest of the way.
_STEP_EST_PCT_CAP = 95.0


def _fmt_duration(seconds: float) -> str:
    s = int(seconds)
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m {s:02d}s" if s else f"{m}m"
    h, m = divmod(m, 60)
    return f"{h}h {m:02d}m"


def _step_median_seconds(db, steps) -> dict[str, float]:
    """step_id → median duration (seconds) of past runs of the step's command
    — the priors behind the estimated intra-step percent. Steps whose command
    has never completed are absent (their heartbeat shows elapsed time only)."""
    from app.core.sequences.worker import load_step_medians

    medians_ms = load_step_medians(db, [s.command for s in steps])
    return {
        s.id: medians_ms[s.command] / 1000.0
        for s in steps
        if s.command in medians_ms
    }


def _sequence_progress(
    op_id: str,
    total: int,
    state: dict[str, OpRunState],
    push,
    result: dict | None = None,
    medians: dict[str, float] | None = None,
):
    """Progress callbacks for one op's step sequence: a completed-step counter
    (``Step n/total``), the agent's own intra-step relay
    (``Step n/total · step-id: phase``, percent scaled into the step's slice),
    and an elapsed-time heartbeat for steps whose command goes silent for
    minutes (``Install-ADDSForest`` reports 10% once, then nothing) — throttled
    to ~10s, with a duration-estimated percent when ``medians`` (step_id →
    seconds, from ``step_metrics``) knows this command. ``result`` (if given)
    rides along on every running push so the frontend keeps partial facts —
    e.g. the agent's vm_id — before the op finishes."""
    done_count = {"n": 0}
    agent_progress: dict[str, tuple[str | None, float | None]] = {}
    last_tick_push: dict[str, float] = {}
    medians = medians or {}

    def _push_running(percent: float, phase: str) -> None:
        state[op_id] = OpRunState(
            status="running", percent=percent, phase=phase, result=result
        )
        push()

    def on_step_complete(_step_id: str) -> None:
        done_count["n"] += 1
        _push_running(
            round(100.0 * done_count["n"] / total, 1),
            f"Step {done_count['n']}/{total}",
        )

    def on_step_progress(step_id: str, phase: str | None, percent: float | None) -> None:
        agent_progress[step_id] = (phase, percent)
        n = done_count["n"]
        label = f"Step {n + 1}/{total} · {step_id}"
        if phase:
            label += f": {phase}"
        overall = round(100.0 * (n + (percent or 0.0) / 100.0) / total, 1)
        _push_running(overall, label)

    def on_step_tick(step_id: str, elapsed_s: float) -> None:
        if elapsed_s - last_tick_push.get(step_id, 0.0) < _STEP_TICK_PUSH_GAP_S:
            return
        last_tick_push[step_id] = elapsed_s
        phase, agent_pct = agent_progress.get(step_id, (None, None))
        n = done_count["n"]
        label = f"Step {n + 1}/{total} · {step_id}"
        if phase:
            label += f": {phase}"
        label += f" — {_fmt_duration(elapsed_s)}"
        pct = agent_pct or 0.0
        median_s = medians.get(step_id)
        if median_s:
            est = min(_STEP_EST_PCT_CAP, 100.0 * elapsed_s / median_s)
            pct = max(pct, est)
            label += f" (~{est:.0f}%, est. {_fmt_duration(median_s)})"
        overall = round(100.0 * (n + pct / 100.0) / total, 1)
        _push_running(overall, label)

    return on_step_complete, on_step_progress, on_step_tick


def _run_sequence_op(
    db,
    op: "PlanOp",
    ops: list["PlanOp"],
    job_id: str,
    owner_role: str,
    state: dict[str, OpRunState],
    push,
) -> bool | None:
    """Run a non-createVm op as a real command sequence.

    Returns True/False on success/failure, or ``None`` when this op kind has no
    real sequence yet (the caller then falls back to the timed simulation) —
    which is also how an op whose expansion is empty for the current topology
    degrades. A resolution/sequence failure fails the op (dependents cancel).
    """
    from app.core.sequences import SequenceError
    from app.core.sequences.context import ContextError, build_run_context
    from app.core.sequences.definitions import op_sequence
    from app.core.sequences.worker import run_op_sequence

    if op.kind.value not in _REAL_SEQUENCE_KINDS:
        return None

    state[op.id] = OpRunState(status="running", percent=0.0, phase="Resolving")
    push()
    try:
        ctx = build_run_context(db, op, ops)
        steps = op_sequence(op.kind.value, ctx)
    except ContextError as exc:
        state[op.id] = OpRunState(status="error", detail=str(exc))
        push()
        return False
    if not steps:
        return None  # nothing to do for this topology — let the caller simulate

    total = len(steps)
    on_step_complete, on_step_progress, on_step_tick = _sequence_progress(
        op.id, total, state, push, medians=_step_median_seconds(db, steps)
    )

    op_started = time.monotonic()
    try:
        run_op_sequence(
            db, steps, ctx,
            plan_job_id=job_id, op_id=op.id, role=owner_role,
            on_step_complete=on_step_complete,
            on_step_progress=on_step_progress,
            on_step_tick=on_step_tick,
        )
    except SequenceError as exc:
        state[op.id] = OpRunState(status="error", detail=str(exc))
        push()
        return False
    except Exception as exc:  # noqa: BLE001 — surface as an op-level failure
        state[op.id] = OpRunState(status="error", detail=str(exc))
        push()
        return False

    logger.info(
        "op %s: %s sequence (%d steps) completed in %.1fs",
        op.id, op.kind.value, total, time.monotonic() - op_started,
    )
    state[op.id] = OpRunState(
        status="done", percent=100.0, phase="Done", result={"steps": total}
    )
    push()
    return True


def _simulate_op(op: "PlanOp", state: dict[str, OpRunState], push) -> bool:
    """Advance a stubbed op through its 3 named phases. Always succeeds in v1."""
    phases = _SIMULATED_PHASES[op.kind.value]
    for phase, percent in zip(phases, _SIMULATED_PERCENTS):
        time.sleep(_SIMULATED_STEP_SECONDS)
        state[op.id] = OpRunState(status="running", percent=percent, phase=phase)
        push()
    state[op.id] = OpRunState(
        status="done", percent=100.0, phase=phases[-1], result={"simulated": True}
    )
    push()
    return True


@celery_app.task(name="run_plan")
def run_plan_task(job_id: str, plan: dict, owner_role: str = "guest") -> None:
    """Walk a validated deploy-plan DAG, running each op in dependency order.

    Sequential ready-set loop (Kahn-style): repeatedly pick the first remaining
    op whose dependencies have all finished. A dependency that ended in error or
    was itself cancelled poisons its dependents — they're marked ``cancelled``
    and skipped rather than executed, so one failed clone doesn't take down
    independent branches of the plan. The whole body is wrapped in one
    try/except mirroring ``clone_vm_task``: only plan-level infrastructure
    failures (bad payload) become a terminal ``ErrorMsg``; per-op failures —
    including a failed ``open_connection`` attempt, caught around just that
    call — are folded into the op's state and the plan always finishes with a
    ``DoneMsg``. The ESXi connection (opened lazily, at most once) is closed
    in a ``finally`` regardless of outcome.
    """
    from app.routers.deploy import DeployRequest, PlanOpKind

    try:
        ops = DeployRequest(**plan).ops
        state: dict[str, OpRunState] = {op.id: OpRunState(status="pending") for op in ops}

        def push() -> None:
            transport.publish(job_id, PlanStateMsg(ops=dict(state)), status=JobStatus.running)

        transport.publish(job_id, RunningMsg(), status=JobStatus.running)
        push()

        remaining = list(ops)
        finished: set[str] = set()
        blocked: set[str] = set()
        conn: "Connection | None" = None
        # One sync Mongo client for the whole plan, opened when there is a
        # createVm (IP allocation + registry writes) or a real command sequence
        # (cross-node context resolution + plan_runs cursor) to run.
        needs_db = any(
            op.kind is PlanOpKind.create_vm
            or op.kind.value in _REAL_SEQUENCE_KINDS
            for op in ops
        )
        db_ctx = worker_db() if needs_db else nullcontext(None)

        try:
            with db_ctx as db:
                if db is not None:
                    # Lazy GC for abandoned ISO uploads — piggybacks
                    # on plan runs instead of needing a scheduler.
                    from app.routers.iso import gc_orphan_isos

                    gc_orphan_isos(db)
                    _sweep_stale_agents_sync(db)
                while remaining:
                    for idx, op in enumerate(remaining):
                        if all(dep in finished for dep in op.depends_on):
                            del remaining[idx]
                            break
                    else:
                        # Unreachable given a validated (acyclic, all-deps-present) plan —
                        # guard against an infinite loop rather than hang the worker.
                        for op in remaining:
                            state[op.id] = OpRunState(
                                status="cancelled", detail="Unresolvable dependency ordering."
                            )
                            finished.add(op.id)
                            blocked.add(op.id)
                            push()
                        break

                    if any(dep in blocked for dep in op.depends_on):
                        state[op.id] = OpRunState(
                            status="cancelled", detail="Skipped: a dependency failed or was cancelled."
                        )
                        finished.add(op.id)
                        blocked.add(op.id)
                        push()
                        continue

                    if op.kind is PlanOpKind.create_vm:
                        try:
                            # Probe + reopen if a long provision between clones
                            # let the ESXi session idle-time out.
                            conn = _live_worker_connection(conn)
                        except Exception as exc:  # noqa: BLE001 — a connection failure blocks this op only, not the whole plan
                            state[op.id] = OpRunState(status="error", detail=str(exc))
                            push()
                            finished.add(op.id)
                            blocked.add(op.id)
                            continue
                        ok = _run_clone_op(conn, db, op, ops, job_id, state, push, owner_role)
                    else:
                        # Real command sequence where one exists (domainJoin,
                        # …); otherwise the timed stub. `None` = no sequence for
                        # this op/topology, so fall through to the simulation.
                        result = _run_sequence_op(
                            db, op, ops, job_id, owner_role, state, push
                        )
                        ok = _simulate_op(op, state, push) if result is None else result

                    finished.add(op.id)
                    if not ok:
                        blocked.add(op.id)
        finally:
            if conn is not None:
                Disconnect(conn.si)

        transport.publish(
            job_id,
            DoneMsg(result={"ops": {op_id: s.model_dump() for op_id, s in state.items()}}),
            status=JobStatus.done,
            terminal=True,
        )
    except VmkitError as exc:
        status, detail = map_vmkit_error(exc)
        transport.publish(
            job_id, ErrorMsg(status=status, detail=detail), status=JobStatus.error, terminal=True
        )
    except Exception as exc:  # noqa: BLE001 — surface anything as a terminal error
        transport.publish(
            job_id, ErrorMsg(status=500, detail=str(exc)), status=JobStatus.error, terminal=True
        )
