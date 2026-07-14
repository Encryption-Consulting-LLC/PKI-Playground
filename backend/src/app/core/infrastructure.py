"""Role-specific infrastructure profiles for guided PKI deployments."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.settings import settings


PkiRole = Literal["domainController", "rootCa", "issuingCa", "webServer"]
PKI_ROLES: tuple[PkiRole, ...] = (
    "domainController",
    "rootCa",
    "issuingCa",
    "webServer",
)


class InfrastructureProfile(BaseModel):
    """Clone, placement, and sizing policy for one PKI machine role."""

    model_config = ConfigDict(populate_by_name=True)

    role: PkiRole
    base: str = Field(min_length=1, max_length=80)
    datastore: str = Field(min_length=1, max_length=80)
    expected_guest_os: str = Field(alias="expectedGuestOs", min_length=1, max_length=80)
    network: str = Field(min_length=1, max_length=80)
    cpus: int = Field(ge=1, le=64)
    memory_mb: int = Field(alias="memoryMb", ge=1024, le=262144)
    system_disk_gb: int = Field(alias="systemDiskGb", ge=32, le=4096)
    max_usage_pct: float = Field(alias="maxUsagePct", gt=0, le=100)


_DEFAULT_SIZING: dict[PkiRole, tuple[int, int, int]] = {
    "domainController": (2, 4096, 60),
    "rootCa": (2, 4096, 60),
    "issuingCa": (4, 8192, 80),
    "webServer": (4, 8192, 80),
}


def default_infrastructure_profiles() -> list[InfrastructureProfile]:
    """Build defaults from the legacy singleton image settings."""

    profiles: list[InfrastructureProfile] = []
    for role in PKI_ROLES:
        cpus, memory_mb, disk_gb = _DEFAULT_SIZING[role]
        profiles.append(
            InfrastructureProfile(
                role=role,
                base=settings.clone_base,
                datastore=settings.clone_datastore,
                expectedGuestOs=settings.clone_guest_os,
                network=settings.clone_network,
                cpus=cpus,
                memoryMb=memory_mb,
                systemDiskGb=disk_gb,
                maxUsagePct=settings.clone_max_usage_pct,
            )
        )
    return profiles


def infrastructure_profiles_from_doc(doc: dict | None) -> dict[PkiRole, InfrastructureProfile]:
    """Resolve the complete role map, backfilling legacy settings documents."""

    doc = doc or {}
    defaults = {profile.role: profile for profile in default_infrastructure_profiles()}
    legacy = {
        "base": doc.get("cloneBase") or settings.clone_base,
        "datastore": doc.get("cloneDatastore") or settings.clone_datastore,
        "expectedGuestOs": doc.get("cloneGuestOs") or settings.clone_guest_os,
        "network": doc.get("cloneNetwork") or settings.clone_network,
        "maxUsagePct": doc.get("cloneMaxUsagePct") or settings.clone_max_usage_pct,
    }
    for role, profile in list(defaults.items()):
        defaults[role] = profile.model_copy(update={
            "base": legacy["base"],
            "datastore": legacy["datastore"],
            "expected_guest_os": legacy["expectedGuestOs"],
            "network": legacy["network"],
            "max_usage_pct": legacy["maxUsagePct"],
        })
    for raw in doc.get("infrastructureProfiles") or []:
        profile = InfrastructureProfile(**raw)
        defaults[profile.role] = profile
    return defaults


def role_for_template(template: str, ca_type: str | None = None) -> PkiRole:
    """Map a staged template configuration to its infrastructure role."""

    if template == "domainController":
        return "domainController"
    if template == "webServer":
        return "webServer"
    if template == "certificateAuthority":
        return "issuingCa" if ca_type == "Issuing" else "rootCa"
    raise ValueError(f"template '{template}' has no guided PKI infrastructure profile")
