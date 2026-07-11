"""Domain-admin password: AD-complexity policy + at-rest encryption round-trip
(Phase L slice 8). The policy mirrors ``frontend/src/lib/passwordPolicy.ts``.
"""

import os

import pytest

# The settings module fail-fasts without these; set before importing anything
# that pulls in core.secrets. A throwaway 32-byte key is fine for the test.
os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault("SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")

from app.core.template_config import (  # noqa: E402
    decrypt_config_secrets,
    encrypt_config_secrets,
    extract_template_config,
    password_policy_errors,
    secret_config_keys,
    validate_template_config,
)


def test_password_policy_accepts_a_strong_password():
    assert password_policy_errors("Str0ng-Lab-Pass!", "dc01") == []


@pytest.mark.parametrize(
    "value",
    [
        "short1!A",  # < 12 chars
        "alllowercaseletters",  # only one class
        "Administrator-1234!",  # contains "administrator"
    ],
)
def test_password_policy_rejects_weak_passwords(value):
    assert password_policy_errors(value) != []


def test_password_policy_rejects_the_machine_name():
    assert password_policy_errors("Guest-abc12-dc01-Xy9!", "guest-abc12-dc01") != []


def test_validate_rejects_weak_dc_password():
    with pytest.raises(ValueError):
        validate_template_config(
            "domainController",
            {"vmName": "dc01", "template": "domainController", "domainAdminPassword": "weak"},
        )


def test_validate_accepts_strong_dc_password():
    validate_template_config(
        "domainController",
        {"vmName": "dc01", "template": "domainController", "domainAdminPassword": "Str0ng-Lab-Pass!"},
    )


def test_domain_admin_password_is_a_secret_key():
    assert "domainAdminPassword" in secret_config_keys("domainController")
    assert secret_config_keys("certificateAuthority") == frozenset()


def test_encrypt_then_decrypt_round_trips_the_password():
    config = extract_template_config(
        "domainController",
        {"vmName": "dc01", "domainAdminPassword": "Str0ng-Lab-Pass!"},
    )
    stored = encrypt_config_secrets("domainController", config)
    # At rest the plaintext is gone — the value is an AES-GCM blob.
    assert stored["domainAdminPassword"] != "Str0ng-Lab-Pass!"
    assert set(stored["domainAdminPassword"]) == {"keyId", "nonce", "ciphertext"}
    # Non-secret fields pass through unchanged.
    assert stored["domainName"] == "EncryptionConsulting.com"

    recovered = decrypt_config_secrets("domainController", stored)
    assert recovered["domainAdminPassword"] == "Str0ng-Lab-Pass!"


def test_blank_secret_is_dropped_not_encrypted():
    config = extract_template_config("domainController", {"domainAdminPassword": ""})
    stored = encrypt_config_secrets("domainController", config)
    assert "domainAdminPassword" not in stored
