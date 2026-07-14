"""Golden-image settings are validated and exposed with stable wire names."""

import os

import pytest
from pydantic import ValidationError

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
)

from app.core.db.models import SettingsDoc  # noqa: E402
from app.core.infrastructure import (  # noqa: E402
    infrastructure_profiles_from_doc,
    role_for_template,
)
from app.routers.settings import SettingsUpdate  # noqa: E402


def test_golden_image_settings_use_camel_case_wire_fields():
    update = SettingsUpdate(
        cloneBase="ws-2025-patched",
        cloneDatastore="fast-store",
        cloneGuestOs="windows2022srvNext-64",
        cloneMaxUsagePct=75,
    )

    assert update.model_dump(by_alias=True, exclude_unset=True) == {
        "cloneBase": "ws-2025-patched",
        "cloneDatastore": "fast-store",
        "cloneGuestOs": "windows2022srvNext-64",
        "cloneMaxUsagePct": 75.0,
    }


@pytest.mark.parametrize("limit", [0, 100.1])
def test_golden_image_usage_limit_must_be_a_percentage(limit):
    with pytest.raises(ValidationError):
        SettingsUpdate(cloneMaxUsagePct=limit)


def test_settings_document_has_safe_golden_image_defaults():
    doc = SettingsDoc(updatedAt=1)

    assert doc.clone_base == "ws-2025-base"
    assert doc.clone_datastore == "datastore1"
    assert doc.clone_guest_os == "windows2022srvNext-64"
    assert doc.clone_max_usage_pct == 80.0


def test_legacy_settings_expand_to_all_guided_pki_roles():
    profiles = infrastructure_profiles_from_doc(
        {"cloneBase": "patched", "cloneDatastore": "fast", "cloneNetwork": "PKI"}
    )

    assert set(profiles) == {"domainController", "rootCa", "issuingCa", "webServer"}
    assert all(profile.base == "patched" for profile in profiles.values())
    assert all(profile.network == "PKI" for profile in profiles.values())
    assert profiles["issuingCa"].memory_mb == 8192


def test_role_specific_profile_overrides_legacy_image():
    profiles = infrastructure_profiles_from_doc(
        {
            "cloneBase": "legacy",
            "infrastructureProfiles": [
                {
                    "role": "rootCa",
                    "base": "offline-root-image",
                    "datastore": "secure",
                    "expectedGuestOs": "windows2022srvNext-64",
                    "network": "Offline",
                    "cpus": 2,
                    "memoryMb": 4096,
                    "systemDiskGb": 60,
                    "maxUsagePct": 70,
                    "qualification": {
                        "baseChangeVersion": "17",
                        "windowsBuild": 26100,
                        "runnerVersion": "2.0.0",
                        "agentSha256": "a" * 64,
                        "validatedAt": 1,
                        "mlDsa87Available": True,
                        "systemContextValidated": True,
                    },
                }
            ],
        }
    )

    assert profiles["rootCa"].base == "offline-root-image"
    assert profiles["rootCa"].network == "Offline"
    assert profiles["rootCa"].qualification.ml_dsa_87_available is True
    assert profiles["webServer"].base == "legacy"


def test_template_configuration_selects_infrastructure_role():
    assert role_for_template("domainController") == "domainController"
    assert role_for_template("certificateAuthority", "Root") == "rootCa"
    assert role_for_template("certificateAuthority", "Issuing") == "issuingCa"
    assert role_for_template("webServer") == "webServer"
