/**
 * Spec 071: the Secure Controls Framework (SCF) controls Stolos gives
 * evidence for, and what it looks at for each. That is all Stolos writes
 * itself: each control's official name, description, and its mappings to
 * SOC 2, HIPAA, PCI DSS, CMMC, NIST SP 800-53 and 800-171, and FedRAMP are
 * the SCF Council's own (its Set Theory Relationship Mapping, STRM), read
 * from the pinned SCF release by `catalog.ts`. The names here are SCF's,
 * kept for when the catalog is not on this PC yet; a test checks them
 * against the workbook.
 *
 * @module
 */

/** The frameworks, in the order the consoles show them; each maps through SCF's STRM. */
export const FRAMEWORKS = [
  {
    id: "soc2",
    title: "SOC 2 (AICPA Trust Services Criteria 2017, 2022 points of focus)",
    short: "SOC 2",
  },
  { id: "hipaa", title: "HIPAA Security Rule (45 CFR 164)", short: "HIPAA" },
  { id: "pci", title: "PCI DSS v4.0.1", short: "PCI DSS" },
  { id: "cmmc", title: "CMMC 2.0 Level 2", short: "CMMC" },
  { id: "nist80053", title: "NIST SP 800-53 Rev 5", short: "800-53" },
  { id: "nist800171", title: "NIST SP 800-171 Rev 3", short: "800-171" },
  { id: "fedramp", title: "FedRAMP Rev 5 Moderate baseline", short: "FedRAMP" },
] as const;

/** A framework's id. */
export type FrameworkId = typeof FRAMEWORKS[number]["id"];

/** One SCF control Stolos gives evidence for. */
export interface ScfControl {
  /** The SCF identifier (for example CRY-07). */
  id: string;
  /** The SCF control's name, as SCF has it. */
  name: string;
  /** What Stolos looks at, in plain words. */
  how: string;
}

/** The controls, by SCF id. */
export const SCF: ScfControl[] = [
  {
    id: "AST-04",
    name: "Asset Inventories",
    how: "Every managed, adopted, and cloud machine is listed in Git and observed recently.",
  },
  {
    id: "AST-07.1",
    name: "Technology Assets, Applications, Services and/or Data (TAASD) Ownership Assignment",
    how: "Every device has someone responsible for it and a known location.",
  },
  {
    id: "MON-02",
    name: "Continuous Monitoring",
    how: "Machines are observed and verified on a schedule; osquery answers questions fleet-wide.",
  },
  {
    id: "CHG-03",
    name: "Configuration Change Control",
    how: "Every change is a Git commit; servers apply only commits a fleet signer signed.",
  },
  {
    id: "CFG-04",
    name: "Secure Baseline Configurations",
    how:
      "Managed servers converge to their model and verify it; adopted machines are checked against the policy pack.",
  },
  {
    id: "CRY-05",
    name: "Encrypting Data In Transit",
    how:
      "Web traffic is TLS only, with certificates verified (Cloudflare Full strict, TLS 1.2 or later).",
  },
  {
    id: "CRY-07",
    name: "Encrypting Data At Rest",
    how:
      "Disks are encrypted: adopted machines are checked (FileVault, LUKS); managed servers are listed as not checked yet.",
  },
  {
    id: "END-04",
    name: "Malicious Code Protection (Antimalware)",
    how: "Windows machines run real-time anti-malware protection (Microsoft Defender or another).",
  },
  {
    id: "END-07",
    name: "Software Firewall",
    how: "Adopted workstations run their own firewall.",
  },
  {
    id: "NET-02",
    name: "Network Security Controls (NSC)",
    how:
      "A firewall in front of every machine (the router, a cloud firewall, the workstation's own); S3 blocks public access.",
  },
  {
    id: "NET-13",
    name: "Domain Name Service (DNS) Resolution",
    how: "The fleet's zones are signed (DNSSEC).",
  },
  {
    id: "NET-37",
    name: "Safeguarding Data Over Open Networks",
    how:
      "Cloudflare verifies the origin's certificate, so the open internet leg is encrypted end to end.",
  },
  {
    id: "VPM-08",
    name: "Software & Firmware Patching",
    how: "Security updates install by themselves, and few wait.",
  },
  {
    id: "VPM-12",
    name: "Vulnerability Scanning",
    how: "Code is scanned for leaked secrets and vulnerable dependencies.",
  },
  {
    id: "AST-39",
    name: "Unsupported Technology Assets, Applications and/or Services (TAAS)",
    how: "Every operating system is still supported by its maker.",
  },
  {
    id: "IAC-37",
    name: "Multi-Factor Authentication (MFA)",
    how: "Microsoft 365 enforces MFA and everyone registered it; the AWS root user has MFA.",
  },
  {
    id: "IAC-04",
    name: "User Provisioning & De-Provisioning",
    how:
      "People who left (the HR system) have no active account anywhere (identity, code, clouds).",
  },
  {
    id: "IAC-14",
    name: "Authenticator Management",
    how:
      "SSH accepts keys, not passwords; signing keys are per person, with an offline recovery key.",
  },
  {
    id: "IAC-08",
    name: "Account Management",
    how: "Every active account belongs to a person on the roster, or is a known service account.",
  },
  {
    id: "IAC-10",
    name: "Privileged Account Management (PAM)",
    how: "The AWS root user has no access keys.",
  },
  {
    id: "IAC-30",
    name: "Least Privilege",
    how: "Few administrators on each machine; two to four Global Administrators in Microsoft 365.",
  },
  {
    id: "BCD-24",
    name: "Data Backups",
    how: "Cloud servers have backups; the vault is backed up off the PC.",
  },
  {
    id: "BCD-02",
    name: "Business Continuity Management System (BCMS)",
    how: "Cloud servers are protected from deletion by mistake.",
  },
  {
    id: "DCH-02",
    name: "Data Protection",
    how: "Storage is not public by default (S3 Block Public Access).",
  },
];

/** A control by id. */
export function scf(id: string): ScfControl | undefined {
  return SCF.find((c) => c.id === id);
}
