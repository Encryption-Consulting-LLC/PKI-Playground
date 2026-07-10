"""Server-side schema for per-template Inspector config (Phase F).

The frontend spreads a node's ``config`` map flat into a ``createVm`` op's
``params`` (``store/staging.ts::buildOpPayload``). Those values (CA algorithm,
key length, common name, …) are what the backend later dispatches to the
orchestrator as command params once the agent phones home. This module is the
**authoritative** validator for them — the client map is never trusted:

* ``validate_template_config`` rejects (422) any unknown config key (the
  key-injection gate) and any bad value for a known key;
* ``extract_template_config`` returns the provisioning-relevant subset with
  defaults filled, ready to persist on the VM registry and later dispatch.

Hand-mirrors ``frontend/src/constants/templates.ts`` (the same documented-mirror
convention as ``core.firstboot.TEMPLATE_IDS``): when a template's ``configFields``
change there, update the matching entry here.
"""

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass

#: Keys that always ride in a createVm op's params but are not template config.
RESERVED_PARAM_KEYS = frozenset({"vmName", "template", "isoId"})

# Free-text value shapes. Deliberately strict: these values are later
# interpolated by orchestrator PowerShell (via param() blocks), so quotes,
# semicolons, backticks and `$` are excluded even though the param-block layer
# already neutralizes them — defence in depth.
_DNS = re.compile(
    r"^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$"
)
_NETBIOS = re.compile(r"^[A-Za-z0-9-]{1,15}$")
_COMMON_NAME = re.compile(r"^[A-Za-z0-9 ._-]{1,64}$")
_CERT_PATH = re.compile(r"^[A-Za-z]:\\[A-Za-z0-9 ._\\-]{1,120}$")


def _one_of(*options: str) -> Callable[[str], bool]:
    allowed = frozenset(options)
    return lambda v: v in allowed


def _matches(pattern: re.Pattern[str]) -> Callable[[str], bool]:
    return lambda v: bool(pattern.match(v))


def _int_between(lo: int, hi: int) -> Callable[[str], bool]:
    def check(v: str) -> bool:
        try:
            return lo <= int(v) <= hi
        except ValueError:
            return False

    return check


@dataclass(frozen=True)
class FieldSpec:
    validate: Callable[[str], bool]
    default: str
    #: Whether this field is dispatched to the orchestrator. Display-only fields
    #: (e.g. the CA ``keyLengthFixed`` label) are accepted but never provisioned.
    provision: bool = True


# Mirror of the CA/DC/webServer ``configFields`` in templates.ts. Templates with
# no configurable fields (client, standalone) map to an empty schema, so any
# stray config key on them is rejected.
TEMPLATE_CONFIG_FIELDS: dict[str, dict[str, FieldSpec]] = {
    "domainController": {
        "domainName": FieldSpec(_matches(_DNS), "EncryptionConsulting.com"),
        "netbiosName": FieldSpec(_matches(_NETBIOS), "ENCRYPTIONCONSU"),
        "forestLevel": FieldSpec(
            _one_of(
                "Windows Server 2016",
                "Windows Server 2019",
                "Windows Server 2022",
                "Windows Server 2025",
            ),
            "Windows Server 2016",
        ),
    },
    "certificateAuthority": {
        "caType": FieldSpec(_one_of("Root", "Issuing"), "Root"),
        "commonName": FieldSpec(_matches(_COMMON_NAME), "EC-Root-CA"),
        "keyAlgorithm": FieldSpec(_one_of("RSA", "ECDSA", "ML-DSA-87"), "RSA"),
        "keyLength": FieldSpec(_one_of("2048", "4096"), "2048"),
        # Display-only label shown for ML-DSA-87 (fixed key size) — accepted so
        # the frontend can send it, but never dispatched.
        "keyLengthFixed": FieldSpec(lambda v: len(v) <= 32, "2,592 bytes", provision=False),
        "hashAlgorithm": FieldSpec(_one_of("SHA256", "SHA384", "SHA512"), "SHA256"),
        "validityYears": FieldSpec(_int_between(1, 50), "20"),
    },
    "webServer": {
        "certEnrollPath": FieldSpec(_matches(_CERT_PATH), "C:\\CertEnroll"),
        "enableOcsp": FieldSpec(_one_of("Enabled", "Disabled"), "Enabled"),
    },
    "client": {},
    "standalone": {},
}


def validate_template_config(template: str, params: Mapping[str, str]) -> None:
    """Raise ``ValueError`` on any unknown config key or bad known value.

    ``params`` is the whole createVm param map; reserved keys (vmName/template/
    isoId) are skipped. An unknown template is treated as having no config
    fields, so any config key on it is rejected.
    """
    schema = TEMPLATE_CONFIG_FIELDS.get(template, {})
    for key, value in params.items():
        if key in RESERVED_PARAM_KEYS:
            continue
        spec = schema.get(key)
        if spec is None:
            raise ValueError(f"unknown config field '{key}' for template '{template}'")
        if not spec.validate(value):
            raise ValueError(f"invalid value for config field '{key}'")


def extract_template_config(
    template: str, params: Mapping[str, str]
) -> dict[str, str]:
    """The provisioning-relevant config for ``template``, defaults filled.

    Returns only provisionable fields (drops display-only ones and reserved
    keys), so it is exactly what gets persisted and later dispatched to the
    orchestrator. Assumes ``validate_template_config`` has already passed.
    """
    schema = TEMPLATE_CONFIG_FIELDS.get(template, {})
    return {
        key: params.get(key, spec.default)
        for key, spec in schema.items()
        if spec.provision
    }
