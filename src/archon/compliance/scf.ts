/**
 * Spec 068: the Secure Controls Framework (SCF) controls Stolos gives
 * evidence for, and a starter mapping of each to the frameworks the fleet
 * cares about first: HIPAA (the Security Rule, 45 CFR 164), PCI DSS v4.0,
 * CMMC 2.0 Level 2 (NIST SP 800-171 r2), and SOC 2 (the 2017 Trust Services
 * Criteria, Type 1 and Type 2 alike: Type 2 is the same criteria held over a
 * period, which `git log` on the evidence files shows).
 *
 * This is a starter mapping written for orientation, not an audit: check
 * every line against the SCF's own Set Theory Relationship Mapping (STRM)
 * for each framework before an auditor relies on it.
 *
 * @module
 */

/** The frameworks, in the fleet's order of interest. */
export const FRAMEWORKS = [
  { id: "hipaa", title: "HIPAA Security Rule", short: "HIPAA" },
  { id: "pci", title: "PCI DSS v4.0", short: "PCI DSS" },
  { id: "cmmc", title: "CMMC 2.0 Level 2", short: "CMMC" },
  { id: "soc2", title: "SOC 2 (Trust Services Criteria)", short: "SOC 2" },
] as const;

/** A framework's id. */
export type FrameworkId = typeof FRAMEWORKS[number]["id"];

/** One SCF control: its name, and the requirements it maps to in each framework. */
export interface ScfControl {
  /** The SCF identifier (for example CRY-05). */
  id: string;
  /** The SCF control's name. */
  name: string;
  /** What Stolos looks at, in plain words. */
  how: string;
  /** Requirements per framework (empty: no direct requirement). */
  maps: Record<FrameworkId, string[]>;
}

/** The controls, by SCF id. */
export const SCF: ScfControl[] = [
  {
    id: "AST-02",
    name: "Asset Inventories",
    how: "Every managed, adopted, and cloud machine is listed in Git and observed recently.",
    maps: { hipaa: ["164.310(d)(1)"], pci: ["12.5.1"], cmmc: ["CM.L2-3.4.1"], soc2: ["CC6.1"] },
  },
  {
    id: "AST-03",
    name: "Asset Ownership Assignment",
    how: "Every device has someone responsible for it and a known location.",
    maps: { hipaa: ["164.310(d)(1)"], pci: ["12.5.1"], cmmc: ["CM.L2-3.4.1"], soc2: ["CC6.1"] },
  },
  {
    id: "MON-01",
    name: "Continuous Monitoring",
    how: "Machines are observed and verified on a schedule; osquery answers questions fleet-wide.",
    maps: {
      hipaa: ["164.308(a)(1)(ii)(D)"],
      pci: ["10.2.1"],
      cmmc: ["AU.L2-3.3.1"],
      soc2: ["CC7.2"],
    },
  },
  {
    id: "CHG-02",
    name: "Configuration Change Control",
    how: "Every change is a Git commit; servers apply only commits a fleet signer signed.",
    maps: {
      hipaa: ["164.308(a)(1)(ii)(B)"],
      pci: ["6.5.1"],
      cmmc: ["CM.L2-3.4.3"],
      soc2: ["CC8.1"],
    },
  },
  {
    id: "CFG-02",
    name: "System Hardening Through Baseline Configurations",
    how:
      "Managed servers converge to their model and verify it; adopted machines are checked against the policy pack.",
    maps: {
      hipaa: ["164.308(a)(1)(ii)(B)"],
      pci: ["2.2.1"],
      cmmc: ["CM.L2-3.4.1", "CM.L2-3.4.2"],
      soc2: ["CC7.1"],
    },
  },
  {
    id: "CRY-03",
    name: "Transmission Confidentiality",
    how:
      "Web traffic is TLS only, with certificates verified (Cloudflare Full strict, TLS 1.2 or later).",
    maps: { hipaa: ["164.312(e)(1)"], pci: ["4.2.1"], cmmc: ["SC.L2-3.13.8"], soc2: ["CC6.7"] },
  },
  {
    id: "CRY-05",
    name: "Encrypting Data At Rest",
    how:
      "Disks are encrypted: adopted machines are checked (FileVault, LUKS); managed servers are listed as not checked yet.",
    maps: {
      hipaa: ["164.312(a)(2)(iv)"],
      pci: ["3.5.1"],
      cmmc: ["SC.L2-3.13.16"],
      soc2: ["CC6.1"],
    },
  },
  {
    id: "END-04",
    name: "Anti-Malware Technologies",
    how: "Windows machines run real-time anti-malware protection (Microsoft Defender or another).",
    maps: {
      hipaa: ["164.308(a)(5)(ii)(B)"],
      pci: ["5.2.1"],
      cmmc: ["SI.L1-3.14.2"],
      soc2: ["CC6.8"],
    },
  },
  {
    id: "END-05",
    name: "Software Firewall",
    how: "Adopted workstations run their own firewall.",
    maps: { hipaa: ["164.312(e)(1)"], pci: ["1.5.1"], cmmc: ["SC.L2-3.13.1"], soc2: ["CC6.6"] },
  },
  {
    id: "NET-01",
    name: "Network Security Controls",
    how:
      "A firewall in front of every machine (the router, a cloud firewall, the workstation's own); S3 blocks public access.",
    maps: { hipaa: ["164.312(e)(1)"], pci: ["1.2.1"], cmmc: ["SC.L2-3.13.1"], soc2: ["CC6.6"] },
  },
  {
    id: "NET-10",
    name: "Domain Name Service (DNS) Resolution",
    how: "The fleet's zones are signed (DNSSEC).",
    maps: { hipaa: [], pci: [], cmmc: [], soc2: ["CC6.6"] },
  },
  {
    id: "NET-12",
    name: "Safeguarding Data Over Open Networks",
    how:
      "Cloudflare verifies the origin's certificate, so the open internet leg is encrypted end to end.",
    maps: { hipaa: ["164.312(e)(1)"], pci: ["4.2.1"], cmmc: ["SC.L2-3.13.8"], soc2: ["CC6.7"] },
  },
  {
    id: "VPM-05",
    name: "Software & Firmware Patching",
    how: "Security updates install by themselves, and few wait.",
    maps: {
      hipaa: ["164.308(a)(5)(ii)(B)"],
      pci: ["6.3.3"],
      cmmc: ["SI.L1-3.14.1"],
      soc2: ["CC7.1"],
    },
  },
  {
    id: "TDA-17",
    name: "Unsupported Systems",
    how: "Every operating system is still supported by its maker.",
    maps: {
      hipaa: ["164.308(a)(1)(ii)(B)"],
      pci: ["12.3.4"],
      cmmc: ["SI.L1-3.14.1"],
      soc2: ["CC7.1"],
    },
  },
  {
    id: "IAC-06",
    name: "Multi-Factor Authentication (MFA)",
    how: "Microsoft 365 enforces MFA and everyone registered it; the AWS root user has MFA.",
    maps: { hipaa: ["164.312(d)"], pci: ["8.4.2"], cmmc: ["IA.L2-3.5.3"], soc2: ["CC6.1"] },
  },
  {
    id: "IAC-10",
    name: "Authenticator Management",
    how:
      "SSH accepts keys, not passwords; signing keys are per person, with an offline recovery key.",
    maps: { hipaa: ["164.312(d)"], pci: ["8.3.1"], cmmc: ["IA.L2-3.5.10"], soc2: ["CC6.1"] },
  },
  {
    id: "IAC-16",
    name: "Privileged Account Management (PAM)",
    how: "The AWS root user has no access keys.",
    maps: {
      hipaa: ["164.308(a)(4)(ii)(B)"],
      pci: ["8.2.2"],
      cmmc: ["AC.L2-3.1.6"],
      soc2: ["CC6.3"],
    },
  },
  {
    id: "IAC-21",
    name: "Least Privilege",
    how: "Few administrators on each machine; two to four Global Administrators in Microsoft 365.",
    maps: {
      hipaa: ["164.308(a)(4)(ii)(B)"],
      pci: ["7.2.1"],
      cmmc: ["AC.L2-3.1.5"],
      soc2: ["CC6.3"],
    },
  },
  {
    id: "BCD-11",
    name: "Data Backups",
    how: "Cloud servers have backups; the vault is backed up off the PC.",
    maps: { hipaa: ["164.308(a)(7)(ii)(A)"], pci: [], cmmc: ["MP.L2-3.8.9"], soc2: ["A1.2"] },
  },
  {
    id: "BCD-01",
    name: "Business Continuity Management System (BCMS)",
    how: "Cloud servers are protected from deletion by mistake.",
    maps: { hipaa: ["164.308(a)(7)(i)"], pci: [], cmmc: [], soc2: ["A1.2"] },
  },
  {
    id: "DCH-01",
    name: "Data Protection",
    how: "Storage is not public by default (S3 Block Public Access).",
    maps: { hipaa: ["164.306(a)"], pci: ["3.1.1"], cmmc: ["MP.L2-3.8.1"], soc2: ["CC6.1"] },
  },
];

/** A control by id. */
export function scf(id: string): ScfControl | undefined {
  return SCF.find((c) => c.id === id);
}
