import {
  Building2,
  Globe,
  Monitor,
  Server,
  ShieldCheck,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

/**
 * Hide this field based on another field's current value: while it `equals`
 * the given value, or (the inverse) while it does not equal `notEquals`.
 */
export interface HideWhen {
  key: string
  equals?: string
  notEquals?: string
}

export type ConfigField =
  | {
      key: string
      label: string
      type: "text"
      default: string
      placeholder?: string
      hideWhen?: HideWhen
    }
  | {
      key: string
      label: string
      type: "select"
      options: string[]
      default: string
      hideWhen?: HideWhen
    }
  | {
      // Read-only value the user can't change (e.g. a fixed key size).
      key: string
      label: string
      type: "fixed"
      default: string
      hideWhen?: HideWhen
    }
  | {
      // Masked secret with an inline AD-complexity checklist
      // (see lib/passwordPolicy.ts). Stored/diffed masked, never in op labels.
      key: string
      label: string
      type: "password"
      default: string
      placeholder?: string
      hideWhen?: HideWhen
    }

export interface TemplateDef {
  id: string
  label: string
  short: string
  icon: LucideIcon
  accent: string
  description: string
  configFields?: ConfigField[]
}

export const TEMPLATE_CATALOG: TemplateDef[] = [
  {
    id: "domainController",
    label: "Domain Controller",
    short: "DC",
    icon: Building2,
    accent: "text-blue-500",
    description: "AD DS · DNS",
    configFields: [
      {
        key: "domainName",
        label: "Domain Name",
        type: "text",
        default: "EncryptionConsulting.com",
        placeholder: "EncryptionConsulting.com",
      },
      {
        key: "netbiosName",
        label: "NetBIOS Name",
        type: "text",
        default: "ENCRYPTIONCONSU",
        placeholder: "ENCRYPTIONCONSU",
      },
      {
        key: "forestLevel",
        label: "Forest Level",
        type: "select",
        options: [
          "Windows Server 2016",
          "Windows Server 2019",
          "Windows Server 2022",
          "Windows Server 2025",
        ],
        default: "Windows Server 2016",
      },
      {
        key: "domainAdminPassword",
        label: "Domain Admin Password",
        type: "password",
        default: "",
        placeholder: "used to join members + install the issuing CA",
      },
    ],
  },
  {
    id: "certificateAuthority",
    label: "Certificate Authority",
    short: "CA",
    icon: ShieldCheck,
    accent: "text-amber-500",
    description: "AD CS",
    configFields: [
      {
        key: "caType",
        label: "Type",
        type: "select",
        options: ["Root", "Issuing"],
        default: "Root",
      },
      {
        key: "commonName",
        label: "Common Name",
        type: "text",
        default: "EC-Root-CA",
        placeholder: "EC-Root-CA",
      },
      {
        key: "keyAlgorithm",
        label: "Key Algorithm",
        type: "select",
        options: ["RSA", "ECDSA", "ML-DSA-87"],
        default: "RSA",
      },
      {
        key: "keyLength",
        label: "Key Length",
        type: "select",
        options: ["2048", "4096"],
        default: "2048",
        hideWhen: { key: "keyAlgorithm", equals: "ML-DSA-87" },
      },
      {
        // ML-DSA-87 has a fixed 2,592-byte public key — not user-selectable.
        key: "keyLengthFixed",
        label: "Key Length",
        type: "fixed",
        default: "2,592 bytes",
        hideWhen: { key: "keyAlgorithm", notEquals: "ML-DSA-87" },
      },
      {
        key: "hashAlgorithm",
        label: "Hash Algorithm",
        type: "select",
        options: ["SHA256", "SHA384", "SHA512"],
        default: "SHA256",
        // ML-DSA is a standalone signature scheme with no separate hash choice.
        hideWhen: { key: "keyAlgorithm", equals: "ML-DSA-87" },
      },
      {
        key: "validityYears",
        label: "Validity (years)",
        type: "text",
        default: "20",
        placeholder: "20",
      },
    ],
  },
  {
    id: "webServer",
    label: "Web Server",
    short: "IIS",
    icon: Globe,
    accent: "text-emerald-500",
    description: "IIS · CDP/AIA · OCSP",
    configFields: [
      {
        key: "certEnrollPath",
        label: "CertEnroll Path",
        type: "text",
        default: "C:\\CertEnroll",
        placeholder: "C:\\CertEnroll",
      },
      {
        key: "enableOcsp",
        label: "Online Responder",
        type: "select",
        options: ["Enabled", "Disabled"],
        default: "Enabled",
      },
    ],
  },
  {
    id: "client",
    label: "Client",
    short: "WIN11",
    icon: Monitor,
    accent: "text-violet-400",
    description: "Windows 11 workstation",
  },
  {
    id: "standalone",
    label: "Standalone",
    short: "SRV",
    icon: Server,
    accent: "text-slate-400",
    description: "Generic Windows Server",
  },
]

export const TEMPLATE_BY_ID = Object.fromEntries(
  TEMPLATE_CATALOG.map((t) => [t.id, t]),
) as Record<string, TemplateDef>

export const AUTO_NAME_PREFIX: Record<string, string> = {
  domainController: "dc",
  certificateAuthority: "ca",
  webServer: "web",
  client: "client",
  standalone: "srv",
}
