"""Read-only facts for an unregistered datastore-backed golden image."""

import hashlib
import re
from dataclasses import dataclass

from vmkit import Connection
from vmkit.datastore import read_datastore_file
from vmkit.esxi import get_datacenter
from vmkit.vmx import parse_guest_os


_VMX_ASSIGNMENT_RE = re.compile(
    r'^\s*([A-Za-z0-9_.:]+)\s*=\s*"([^"]*)"\s*$',
    re.MULTILINE,
)
_ETHERNET_NETWORK_RE = re.compile(r"^(ethernet\d+)\.networkname$", re.IGNORECASE)


@dataclass(frozen=True)
class DatastoreVmxFacts:
    path: str
    revision: str
    guest_os: str | None
    networks: frozenset[str]


def parse_datastore_vmx(path: str, text: str) -> DatastoreVmxFacts:
    """Extract preflight facts without registering the VM in inventory."""

    assignments = {
        key.lower(): value for key, value in _VMX_ASSIGNMENT_RE.findall(text)
    }
    networks: set[str] = set()
    for key, value in assignments.items():
        match = _ETHERNET_NETWORK_RE.match(key)
        if not match or not value:
            continue
        present = assignments.get(f"{match.group(1).lower()}.present", "true")
        if present.lower() != "false":
            networks.add(value)

    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return DatastoreVmxFacts(
        path=path,
        revision=f"vmx-sha256:{digest}",
        guest_os=parse_guest_os(text),
        networks=frozenset(networks),
    )


def read_datastore_vmx(
    conn: Connection,
    datastore: str,
    base: str,
) -> DatastoreVmxFacts:
    """Download and inspect ``<base>/<base>.vmx`` from the datastore."""

    remote_path = f"{base}/{base}.vmx"
    datacenter = get_datacenter(conn.content)
    text = read_datastore_file(
        conn.host,
        conn.user,
        conn.password,
        conn.port,
        datastore,
        datacenter.name,
        remote_path,
    )
    return parse_datastore_vmx(f"[{datastore}] {remote_path}", text)
