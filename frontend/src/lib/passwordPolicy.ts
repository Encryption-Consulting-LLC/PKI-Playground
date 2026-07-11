/**
 * Active-Directory password-complexity policy — pure, React-free, mirrored
 * on the backend in `core/template_config.py::password_policy_errors`. The
 * operator-entered domain admin password (the DC template's
 * `domainAdminPassword` field) is validated against this before it can be
 * staged; the backend re-validates on deploy as the authoritative gate.
 *
 * Rules (a practical subset of AD's default complexity + the lab's needs):
 *   - at least 12 characters;
 *   - at least 3 of the 4 character classes (lower, upper, digit, symbol);
 *   - does not contain "Administrator" or the VM's own name (case-insensitive)
 *     — the two values an attacker guesses first.
 */

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MIN_CLASSES = 3

export interface PasswordRule {
  key: string
  label: string
  ok: boolean
}

function classCount(value: string): number {
  let count = 0
  if (/[a-z]/.test(value)) count++
  if (/[A-Z]/.test(value)) count++
  if (/[0-9]/.test(value)) count++
  // Anything that isn't a letter or digit counts as a symbol.
  if (/[^A-Za-z0-9]/.test(value)) count++
  return count
}

/**
 * Per-rule pass/fail for the inline checklist. `vmName` is the node's display
 * name (may be empty during editing); the "must not contain" rule only fires
 * for a non-trivial name so an empty name doesn't vacuously fail it.
 */
export function passwordRules(value: string, vmName?: string): PasswordRule[] {
  const lowered = value.toLowerCase()
  const name = (vmName ?? "").trim().toLowerCase()
  return [
    {
      key: "length",
      label: `At least ${PASSWORD_MIN_LENGTH} characters`,
      ok: value.length >= PASSWORD_MIN_LENGTH,
    },
    {
      key: "classes",
      label: `${PASSWORD_MIN_CLASSES} of: lowercase, uppercase, digit, symbol`,
      ok: classCount(value) >= PASSWORD_MIN_CLASSES,
    },
    {
      key: "forbidden",
      label: "No “Administrator” or the machine name",
      ok:
        value.length > 0 &&
        !lowered.includes("administrator") &&
        (name.length < 3 || !lowered.includes(name)),
    },
  ]
}

/** True when every rule passes. */
export function isPasswordValid(value: string, vmName?: string): boolean {
  return passwordRules(value, vmName).every((r) => r.ok)
}

/** Placeholder shown wherever a set password is displayed (never the value). */
export const PASSWORD_MASK = "••••••••"
