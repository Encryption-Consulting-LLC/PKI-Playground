"""Application-level field encryption for secrets stored in Mongo.

The one consumer today is the shared ESXi target's password in the settings
document. Threat model: a Mongo dump (or read-only DB access) alone must not
leak the credential — decryption additionally requires ``SETTINGS_ENC_KEY``
from the app host's environment. This deliberately reverses the pre-Phase-B
tenet that ESXi credentials are never persisted server-side; the stored form
is AES-256-GCM ciphertext, never plaintext.

Stored shape (camelCase, embedded in the parent document):
    {"keyId": ..., "nonce": ..., "ciphertext": ...}   # all base64 strings

``keyId`` is a fingerprint of the encryption key so a future key rotation can
re-encrypt selectively; a mismatch on decrypt fails loudly instead of
producing GCM garbage. Swapping the key *source* (env → Vault/KMS) only
touches ``_key()`` here.
"""

import base64
import hashlib
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.settings import settings


class SecretDecryptionError(Exception):
    """Wrong key, corrupted ciphertext, or a key-id mismatch."""


def _key() -> bytes:
    raw = base64.b64decode(settings.settings_enc_key)  # type: ignore[arg-type] — fail-fast validated
    if len(raw) != 32:
        raise ValueError(
            "SETTINGS_ENC_KEY must decode to exactly 32 bytes (openssl rand -base64 32)."
        )
    return raw


def _key_id(key: bytes) -> str:
    return hashlib.sha256(key).hexdigest()[:16]


def encrypt_secret(plaintext: str) -> dict[str, str]:
    """Encrypt *plaintext* into the stored ``{keyId, nonce, ciphertext}`` shape."""
    key = _key()
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext.encode(), None)
    return {
        "keyId": _key_id(key),
        "nonce": base64.b64encode(nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }


def decrypt_secret(stored: dict[str, str]) -> str:
    """Decrypt a stored ``{keyId, nonce, ciphertext}`` blob back to plaintext."""
    key = _key()
    if stored.get("keyId") != _key_id(key):
        raise SecretDecryptionError(
            "Stored secret was encrypted with a different SETTINGS_ENC_KEY."
        )
    try:
        plaintext = AESGCM(key).decrypt(
            base64.b64decode(stored["nonce"]),
            base64.b64decode(stored["ciphertext"]),
            None,
        )
    except (InvalidTag, KeyError, ValueError) as exc:
        raise SecretDecryptionError("Stored secret failed to decrypt.") from exc
    return plaintext.decode()
