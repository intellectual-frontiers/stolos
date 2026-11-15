/**
 * Spec 071: the fleet's compliance in OSCAL, NIST's machine-readable format,
 * so an assessor's or an agency's tools read it without retyping. Four
 * documents, all to NIST SP 800-53 Rev 5 (the controls FedRAMP and most
 * federal frameworks use), each control reached through SCF's own mappings:
 *
 * - a component definition: Stolos, and each source of evidence, with the
 *   controls each reaches;
 * - a system security plan (SSP): this fleet, its machines, and how each
 *   control is implemented, importing NIST's moderate baseline;
 * - assessment results: every observation Stolos made, and a finding per
 *   control (satisfied or not);
 * - a plan of action and milestones (POA&M): each failing check, open, and
 *   each accepted risk, as a deviation approved until its date; and (spec
 *   080) each open risk in the fleet's risk register, with its SP 800-30
 *   likelihood, impact, and level; and (spec 088) each open vulnerability a
 *   scanner's connector reported, with its CVE, severity, and asset.
 *
 * UUIDs are UUIDv5 of what they name, so the same fleet exported twice names
 * the same things the same way, and a diff shows only what changed.
 *
 * ```mermaid
 * flowchart LR
 *   ev["Evidence (verify, policies, posture, signatures)"] --> scf["SCF controls"]
 *   scf -- "SCF STRM" --> n53["NIST SP 800-53 Rev 5"]
 *   n53 --> cd["component definition"] & ssp["SSP"] & ar["assessment results"] & poam["POA&M"]
 * ```
 *
 * @module
 */

import { NIST_MODERATE_PROFILE, NIST_SOURCES, OSCAL_VERSION, SCF_SOURCE } from "./catalog.ts";
import type { ComplianceView, Coverage, Evidence } from "./report.ts";
import type { Risk } from "../risk/register.ts";
import type { OpenVulnerability } from "../connect/vulnerability.ts";

/** Stolos's UUIDv5 namespace (a fixed random UUID). */
const NAMESPACE = "6f1d0c52-7a39-4c1e-9d0b-3e5b8a2f4c71";

/** A UUIDv5 (SHA-1, RFC 9562) of a name in Stolos's namespace. */
export async function uuidFor(...name: string[]): Promise<string> {
  const ns = Uint8Array.from(NAMESPACE.replace(/-/g, "").match(/../g)!.map((h) => parseInt(h, 16)));
  const n = new TextEncoder().encode(name.join("\u0000"));
  const buf = new Uint8Array(ns.length + n.length);
  buf.set(ns);
  buf.set(n, ns.length);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", buf)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** An SP 800-53 id as SCF writes it (SC-28(01)) in OSCAL's form (sc-28.1), or undefined. */
export function oscal80053(id: string): string | undefined {
  const m = id.trim().match(/^([A-Z]{2})-0*(\d+)(?:\(0*(\d+)\))?$/);
  return m ? `${m[1].toLowerCase()}-${m[2]}${m[3] ? `.${m[3]}` : ""}` : undefined;
}

/** What the exports describe. */
export interface OscalInput {
  /** The compliance view, with the SCF catalog loaded. */
  view: ComplianceView;
  /** The fleet. */
  fleet: { id: string; title: string; repo: string };
  /** Its machines. */
  machines: Array<{ name: string; kind: string; os?: string }>;
  /** SP 800-53 control titles, by OSCAL id (when NIST's catalog is on this PC). */
  titles?: Record<string, string>;
  /** The Stolos version. */
  version: string;
  /** When. */
  now: Date;
  /** Spec 080: the risk register (fleets/<fleet>/risks.ts); its open risks go in the POA&M. */
  register?: readonly Risk[];
  /** Spec 088: the open vulnerabilities the scanners' connectors reported; each is an open POA&M item. */
  vulnerabilities?: readonly OpenVulnerability[];
}

/** An SP 800-53 control, with the SCF controls that map to it and their status. */
export interface NistControl {
  /** Its OSCAL id (ac-2.1). */
  id: string;
  /** Its title, when known. */
  title?: string;
  /** The SCF controls that map to it. */
  scf: string[];
  /** What their evidence adds up to. */
  status: Coverage;
}

/** The SP 800-53 controls the fleet's SCF controls reach, through SCF's STRM. */
export function nistControls(
  view: ComplianceView,
  titles?: Record<string, string>,
): NistControl[] {
  const by = new Map<string, string[]>();
  for (const c of view.controls) {
    for (const r of c.control.maps.nist80053) {
      const id = oscal80053(r);
      if (id && (!titles || id in titles)) by.set(id, [...(by.get(id) ?? []), c.control.id]);
    }
  }
  const status = (ids: string[]): Coverage => {
    const ss = ids.map((i) => view.controls.find((c) => c.control.id === i)!.status);
    if (ss.every((s) => s === "no evidence")) return "no evidence";
    if (ss.some((s) => s === "fail")) return "fail";
    return ss.every((s) => s === "pass") ? "pass" : "partial";
  };
  const order = (id: string) => id.replace(/\d+/g, (d) => d.padStart(4, "0"));
  return [...by].sort(([a], [b]) => order(a).localeCompare(order(b))).map(([id, scf]) => ({
    id,
    ...(titles?.[id] ? { title: titles[id] } : {}),
    scf,
    status: status(scf),
  }));
}

const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");

async function metadata(i: OscalInput, title: string) {
  return {
    title,
    "last-modified": iso(i.now),
    version: i.now.toISOString().slice(0, 10),
    "oscal-version": OSCAL_VERSION,
    parties: [{
      uuid: await uuidFor(i.fleet.id, "party", "fleet"),
      type: "organization",
      name: i.fleet.title,
    }],
    props: [{ name: "marking", value: "internal" }],
  };
}

async function backMatter(i: OscalInput) {
  return {
    resources: [
      {
        uuid: await uuidFor("resource", "scf", SCF_SOURCE.version),
        title: `${SCF_SOURCE.title} ${SCF_SOURCE.version} (the mappings, STRM)`,
        rlinks: [{
          href: SCF_SOURCE.url,
          hashes: [{ algorithm: "SHA-256", value: SCF_SOURCE.sha256 }],
        }],
      },
      {
        uuid: await uuidFor("resource", "nist80053"),
        title: NIST_SOURCES.nist80053.title,
        rlinks: [{
          href: NIST_SOURCES.nist80053.url,
          hashes: [{ algorithm: "SHA-256", value: NIST_SOURCES.nist80053.sha256 }],
        }],
      },
      {
        uuid: await uuidFor(i.fleet.id, "resource", "repository"),
        title:
          `The fleet repository (${i.fleet.repo}): the model, the observations, and their history`,
        rlinks: [{ href: `https://github.com/${i.fleet.repo}` }],
      },
    ],
  };
}

const scfProps = (ids: string[]) =>
  ids.map((id) => ({ name: "scf-control", ns: "https://securecontrolsframework.com", value: id }));

/** How Stolos meets an SP 800-53 control, in words: its SCF controls' "how". */
function how(view: ComplianceView, n: NistControl): string {
  return n.scf.map((id) => {
    const c = view.controls.find((x) => x.control.id === id)!.control;
    return `${id} (${c.name}): ${c.how}`;
  }).join("\n\n");
}

const SOURCE_TEXT: Record<Evidence["source"], string> = {
  managed:
    "Managed servers: each converges to its model in Git and verifies it (archon verify), every 15 minutes.",
  adopted:
    "Adopted machines: a read-only probe reports facts over SSH; the policy pack checks them.",
  device: "Devices: read over encrypted SNMPv3 (authPriv), read-only; their policies check them.",
  cloud: "a read-only credential reads the account's configuration; its posture policies check it.",
  estate:
    "Across systems: people, accounts, devices, and repositories from every connector, checked together.",
  repository:
    "The fleet repository: every change is a commit, signed by a fleet signer before servers apply it.",
  "control pack":
    "The fleet's own controls (spec 078): TypeScript in the fleet repository, tested like code, run over the estate graph, osquery, and observations.",
};

/** What produced a piece of evidence: a component of its own in the component definition. */
function evidenceComponent(e: Evidence): { key: string; title: string; description: string } {
  if (e.source === "cloud") {
    const title = e.subject.replace(/\s*\(.*\)$/, "");
    return { key: `cloud:${title}`, title, description: `${title}: ${SOURCE_TEXT.cloud}` };
  }
  const titles: Record<string, string> = {
    managed: "Managed servers (Archon)",
    adopted: "Adopted machines (the probe and policy pack)",
    device: "Devices (SNMPv3)",
    estate: "The estate graph (cross-system policies)",
    repository: "Signed changes (the fleet repository)",
    "control pack": "The fleet's control packs",
  };
  return { key: e.source, title: titles[e.source], description: SOURCE_TEXT[e.source] };
}

/**
 * The component definition: Stolos as a whole, and one component per source
 * of evidence (managed servers, adopted machines, devices, each connected
 * service, the estate graph, the repository), each implementing the SP 800-53
 * controls its checks reach.
 */
export async function componentDefinition(i: OscalInput): Promise<unknown> {
  const ns = nistControls(i.view, i.titles);
  const ev = allEvidence(i.view);
  const groups = new Map<string, { title: string; description: string; ev: Evidence[] }>();
  for (const e of ev) {
    const c = evidenceComponent(e);
    const g = groups.get(c.key) ?? { title: c.title, description: c.description, ev: [] };
    g.ev.push(e);
    groups.set(c.key, g);
  }
  const impl = async (key: string, n: NistControl[], text: (n: NistControl) => string) => ({
    uuid: await uuidFor("component", key, "nist80053"),
    source: NIST_SOURCES.nist80053.url,
    description:
      `SP 800-53 Rev 5 controls reached through ${SCF_SOURCE.title} ${SCF_SOURCE.version} (STRM).`,
    "implemented-requirements": await Promise.all(n.map(async (x) => ({
      uuid: await uuidFor("component", key, "req", x.id),
      "control-id": x.id,
      description: text(x),
      props: scfProps(x.scf),
    }))),
  });
  const sources = await Promise.all(
    [...groups].sort(([a], [b]) => a.localeCompare(b)).map(async ([key, g]) => {
      const cited = new Set(g.ev.flatMap((e) => e.scf));
      const mine = ns.filter((n) => n.scf.some((x) => cited.has(x)));
      return {
        uuid: await uuidFor("component", key),
        type: g.ev[0].source === "cloud" ? "service" : "software",
        title: g.title,
        description: g.description,
        ...(mine.length
          ? {
            "control-implementations": [
              await impl(key, mine, (n) =>
                [
                  ...new Set(
                    g.ev.filter((e) => e.scf.some((x) => n.scf.includes(x))).map((e) => e.check),
                  ),
                ]
                  .join("; ")),
            ],
          }
          : {}),
      };
    }),
  );
  return {
    "component-definition": {
      uuid: await uuidFor(i.fleet.id, "component-definition", iso(i.now)),
      metadata: await metadata(i, `Stolos ${i.version}: component definition`),
      components: [
        {
          uuid: await uuidFor("component", "stolos"),
          type: "software",
          title: "Stolos",
          description:
            "Fleet management and observability: managed servers converge to a model in Git and verify it; adopted machines, devices, and SaaS and cloud accounts are observed read-only; every change is a signed Git commit.",
          props: [{ name: "version", value: i.version }],
          ...(ns.length
            ? { "control-implementations": [await impl("stolos", ns, (n) => how(i.view, n))] }
            : {}),
        },
        ...sources,
      ],
      "back-matter": await backMatter(i),
    },
  };
}

/** The system security plan: this fleet, its machines, and each control's implementation. */
export async function systemSecurityPlan(i: OscalInput): Promise<unknown> {
  const ns = nistControls(i.view, i.titles);
  const thisSystem = await uuidFor(i.fleet.id, "component", "this-system");
  const stolos = await uuidFor("component", "stolos");
  const status = (s: Coverage) =>
    s === "pass" ? "implemented" : s === "no evidence" ? "planned" : "partial";
  return {
    "system-security-plan": {
      uuid: await uuidFor(i.fleet.id, "ssp", iso(i.now)),
      metadata: await metadata(i, `${i.fleet.title}: system security plan`),
      "import-profile": { href: NIST_MODERATE_PROFILE },
      "system-characteristics": {
        "system-ids": [{ "identifier-type": "https://ietf.org/rfc/rfc4122", id: thisSystem }],
        "system-name": i.fleet.title,
        "system-name-short": i.fleet.id,
        description:
          `The ${i.fleet.title} fleet: its servers, workstations, devices, and SaaS and cloud accounts, as its repository (${i.fleet.repo}) declares and observes them.`,
        "security-sensitivity-level": "fips-199-moderate",
        "system-information": {
          "information-types": [{
            uuid: await uuidFor(i.fleet.id, "information-type", "fleet"),
            title: "The organization's operational information",
            description: "What the fleet stores and processes; set its categorization here.",
            categorizations: [{
              system: "https://doi.org/10.6028/NIST.SP.800-60v2r1",
              "information-type-ids": ["C.3.5.8"],
            }],
            "confidentiality-impact": { base: "fips-199-moderate" },
            "integrity-impact": { base: "fips-199-moderate" },
            "availability-impact": { base: "fips-199-moderate" },
          }],
        },
        "security-impact-level": {
          "security-objective-confidentiality": "fips-199-moderate",
          "security-objective-integrity": "fips-199-moderate",
          "security-objective-availability": "fips-199-moderate",
        },
        status: { state: "operational" },
        "authorization-boundary": {
          description:
            "Every machine, device, and account in the fleet repository: managed servers, adopted machines, SNMP devices, and the connected SaaS and cloud accounts.",
        },
      },
      "system-implementation": {
        users: [{
          uuid: await uuidFor(i.fleet.id, "user", "operator"),
          title: "Fleet operator",
          description: "Approves changes with a signed commit (a fleet signer).",
        }],
        components: [
          {
            uuid: thisSystem,
            type: "this-system",
            title: i.fleet.title,
            description: "The fleet as a whole.",
            status: { state: "operational" },
          },
          {
            uuid: stolos,
            type: "software",
            title: "Stolos",
            description: "Manages and observes the fleet.",
            props: [{ name: "version", value: i.version }],
            status: { state: "operational" },
          },
        ],
        ...(i.machines.length
          ? {
            "inventory-items": await Promise.all(i.machines.map(async (m) => ({
              uuid: await uuidFor(i.fleet.id, "inventory-item", m.name),
              description: `${m.name} (${m.kind}${m.os ? `, ${m.os}` : ""})`,
              props: [
                { name: "asset-id", value: m.name },
                {
                  name: "asset-type",
                  value: m.kind === "device" ? "network" : m.kind === "cloud" ? "cloud" : "server",
                },
              ],
            }))),
          }
          : {}),
      },
      "control-implementation": {
        description:
          `How the fleet meets each SP 800-53 Rev 5 control Stolos has evidence for, reached through ${SCF_SOURCE.title} ${SCF_SOURCE.version}. Controls Stolos cannot observe (policies, training, contracts) need their own statements.`,
        "implemented-requirements": await Promise.all(ns.map(async (n) => ({
          uuid: await uuidFor(i.fleet.id, "ssp", "req", n.id),
          "control-id": n.id,
          props: [
            ...scfProps(n.scf),
            { name: "implementation-status", value: status(n.status) },
          ],
          "by-components": [{
            "component-uuid": stolos,
            uuid: await uuidFor(i.fleet.id, "ssp", "req", n.id, "stolos"),
            description: how(i.view, n),
            "implementation-status": { state: status(n.status) },
          }],
        }))),
      },
      "back-matter": await backMatter(i),
    },
  };
}

const KEYS = new WeakMap<Evidence, string>();

/**
 * Every piece of evidence once (one can support several SCF controls). Two
 * results of the same check on the same subject (rare, but possible) get
 * distinct keys (#2, #3, in order), so their UUIDs never collide.
 */
export function allEvidence(view: ComplianceView): Evidence[] {
  const ev = [...new Set(view.controls.flatMap((c) => c.evidence))];
  const n = new Map<string, number>();
  for (const e of ev) {
    const base = [e.source, e.subject, e.check].join("\u0000");
    const k = (n.get(base) ?? 0) + 1;
    n.set(base, k);
    KEYS.set(e, k === 1 ? base : `${base}#${k}`);
  }
  return ev;
}

const evidenceKey = (e: Evidence) => KEYS.get(e) ?? [e.source, e.subject, e.check].join("\u0000");

/** The UUID of a piece of evidence's OSCAL observation in the assessment results made at `now`. */
export function observationUuid(fleet: string, now: Date, e: Evidence): Promise<string> {
  return uuidFor(fleet, "observation", iso(now), evidenceKey(e));
}

async function observation(i: OscalInput, e: Evidence) {
  return {
    uuid: await observationUuid(i.fleet.id, i.now, e),
    title: `${e.subject}: ${e.check}`,
    description: `${e.status}: ${e.detail || "(no detail)"}`,
    props: [
      ...scfProps(e.scf),
      { name: "result", ns: "https://github.com/intellectual-frontiers/stolos", value: e.status },
      { name: "source", ns: "https://github.com/intellectual-frontiers/stolos", value: e.source },
    ],
    methods: [e.source === "repository" ? "EXAMINE" : "TEST"],
    types: ["finding"],
    collected: iso(i.now),
    ...(e.fix && e.status !== "pass" ? { remarks: `Fix: ${e.fix}` } : {}),
  };
}

/** The assessment results: every observation, and a finding per SP 800-53 control. */
export async function assessmentResults(i: OscalInput): Promise<unknown> {
  const ns = nistControls(i.view, i.titles).filter((n) => n.status !== "no evidence");
  const ev = allEvidence(i.view);
  const obs = await Promise.all(ev.map((e) => observation(i, e)));
  const obsFor = (scf: string[]) =>
    ev.flatMap((e, k) => e.scf.some((x) => scf.includes(x)) ? [obs[k].uuid] : []);
  const plan = await uuidFor(i.fleet.id, "resource", "assessment-plan");
  return {
    "assessment-results": {
      uuid: await uuidFor(i.fleet.id, "assessment-results", iso(i.now)),
      metadata: await metadata(i, `${i.fleet.title}: assessment results`),
      "import-ap": { href: `#${plan}` },
      results: [{
        uuid: await uuidFor(i.fleet.id, "result", iso(i.now)),
        title: `Stolos observations as of ${iso(i.now)}`,
        description:
          "What Stolos observed (managed servers' verify, adopted machines' and devices' policies, the SaaS and cloud accounts' posture, the repository's signatures), and what it says about each SP 800-53 control it reaches.",
        start: iso(i.now),
        "reviewed-controls": {
          "control-selections": [{
            "include-controls": ns.map((n) => ({ "control-id": n.id })),
          }],
        },
        ...(obs.length ? { observations: obs } : {}),
        ...(ns.length
          ? {
            findings: await Promise.all(ns.map(async (n) => ({
              uuid: await uuidFor(i.fleet.id, "finding", iso(i.now), n.id),
              title: `${n.id}${n.title ? ` ${n.title}` : ""}`,
              description: `SCF ${n.scf.join(", ")}: ${n.status}.`,
              props: scfProps(n.scf),
              target: {
                type: "objective-id",
                "target-id": `${n.id}_obj`,
                status: n.status === "pass"
                  ? { state: "satisfied" }
                  : { state: "not-satisfied", reason: n.status === "fail" ? "fail" : "other" },
              },
              "related-observations": obsFor(n.scf).map((u) => ({ "observation-uuid": u })),
            }))),
          }
          : {}),
      }],
      "back-matter": {
        resources: [
          {
            uuid: plan,
            title:
              "Assessment plan: Stolos observes continuously (verify every 15 minutes; observations on demand and on schedule) and records each observation as a Git commit.",
            props: [{ name: "type", value: "plan" }],
          },
          ...(await backMatter(i)).resources,
        ],
      },
    },
  };
}

const STOLOS_NS = "https://github.com/intellectual-frontiers/stolos";

/** NIST SP 800-30 Rev 1, the naming system of a register risk's facets. */
export const SP800_30 = "https://doi.org/10.6028/NIST.SP.800-30r1";

const registerProps = (r: Risk) => [
  { name: "risk-register-id", ns: STOLOS_NS, value: r.id },
  { name: "treatment", ns: STOLOS_NS, value: r.treatment },
  { name: "owner", ns: STOLOS_NS, value: r.owner },
  { name: "next-review", ns: STOLOS_NS, value: r.nextReview },
];

/**
 * A risk from the register (spec 080) as an OSCAL risk: its SP 800-30 Rev 1
 * likelihood, impact, and level as facets; accepted and transferred risks
 * are deviations approved, mitigated and avoided ones are being remediated.
 */
export async function registerRisk(i: OscalInput, r: Risk): Promise<Record<string, unknown>> {
  return {
    uuid: await uuidFor(i.fleet.id, "risk", "register", r.id),
    title: r.title,
    description: r.description,
    statement:
      `Level of risk ${r.level} (likelihood ${r.likelihood}, impact ${r.impact}; NIST SP 800-30 Rev 1). Treatment: ${r.treatment}. Owner: ${r.owner}. Next review: ${r.nextReview}.`,
    props: [...scfProps([...r.scf]), ...registerProps(r)],
    status: r.treatment === "accept" || r.treatment === "transfer"
      ? "deviation-approved"
      : "remediating",
    characterizations: [{
      origin: {
        actors: [{ type: "party", "actor-uuid": await uuidFor(i.fleet.id, "party", "fleet") }],
      },
      facets: [
        { name: "likelihood", system: SP800_30, value: r.likelihood },
        { name: "impact", system: SP800_30, value: r.impact },
        { name: "risk", system: SP800_30, value: r.level },
      ],
    }],
  };
}

const vulnProps = (v: OpenVulnerability) => [
  ...scfProps(["VPM-06"]),
  ...(v.cve ? [{ name: "vulnerability-id", ns: STOLOS_NS, value: v.cve }] : []),
  { name: "severity", ns: STOLOS_NS, value: v.severity },
  { name: "asset", ns: STOLOS_NS, value: v.asset },
  { name: "source", ns: STOLOS_NS, value: v.connector },
  ...(v.firstSeen ? [{ name: "first-seen", ns: STOLOS_NS, value: v.firstSeen }] : []),
];

/** A scanner's open vulnerability (spec 088) as an OSCAL risk: open, with its CVE, severity, and asset. */
export async function vulnerabilityRisk(
  i: OscalInput,
  v: OpenVulnerability,
): Promise<Record<string, unknown>> {
  const name = v.cve ?? v.title;
  return {
    uuid: await uuidFor(i.fleet.id, "risk", "vulnerability", v.connector, v.id),
    title: `${name} on ${v.asset}`,
    description: `${v.title}${v.package ? ` (${v.package})` : ""}, reported by ${v.connector}.`,
    statement: `An open ${v.severity} vulnerability${v.cve ? ` (${v.cve})` : ""} on ${v.asset}${
      v.firstSeen ? `, first seen ${v.firstSeen.slice(0, 10)}` : ""
    }${v.url ? `: ${v.url}` : ""}.`,
    props: vulnProps(v),
    status: "open",
  };
}

/** The POA&M: each failing check, open; each accepted risk, a deviation approved until its date. */
export async function poam(i: OscalInput): Promise<unknown> {
  const ev = allEvidence(i.view).filter((e) => e.status === "fail" || e.status === "accepted");
  const obs = await Promise.all(ev.map((e) => observation(i, e)));
  const risks = await Promise.all(ev.map(async (e, k) => ({
    uuid: await uuidFor(i.fleet.id, "risk", evidenceKey(e)),
    title: `${e.subject}: ${e.check}`,
    description: e.detail || e.check,
    statement: e.status === "accepted"
      ? `Accepted: ${e.detail}`
      : `Failing: ${e.detail}${e.fix ? `. Fix: ${e.fix}` : ""}`,
    props: scfProps(e.scf),
    status: e.status === "accepted" ? "deviation-approved" : "open",
    "related-observations": [{ "observation-uuid": obs[k].uuid }],
  })));
  // Spec 080: the register's open risks, each with its SP 800-30 levels as facets.
  const reg = (i.register ?? []).filter((r) => r.status === "open");
  const regRisks = await Promise.all(reg.map((r) => registerRisk(i, r)));
  // Spec 088: the scanners' open vulnerabilities.
  const vulns = i.vulnerabilities ?? [];
  const vulnRisks = await Promise.all(vulns.map((v) => vulnerabilityRisk(i, v)));
  const allRisks = [...risks, ...regRisks, ...vulnRisks];
  return {
    "plan-of-action-and-milestones": {
      uuid: await uuidFor(i.fleet.id, "poam", iso(i.now)),
      metadata: await metadata(i, `${i.fleet.title}: plan of action and milestones`),
      "system-id": {
        "identifier-type": "https://ietf.org/rfc/rfc4122",
        id: await uuidFor(i.fleet.id, "component", "this-system"),
      },
      ...(obs.length ? { observations: obs } : {}),
      ...(allRisks.length ? { risks: allRisks } : {}),
      "poam-items": [
        ...await Promise.all(ev.map(async (e, k) => ({
          uuid: await uuidFor(i.fleet.id, "poam-item", evidenceKey(e)),
          title: `${e.subject}: ${e.check}`,
          description: e.status === "accepted"
            ? `A risk accepted: ${e.detail}`
            : `${e.detail}${e.fix ? `. Fix: ${e.fix}` : ""}`,
          props: scfProps(e.scf),
          "related-observations": [{ "observation-uuid": obs[k].uuid }],
          "related-risks": [{ "risk-uuid": risks[k].uuid }],
        }))),
        ...await Promise.all(reg.map(async (r, k) => ({
          uuid: await uuidFor(i.fleet.id, "poam-item", "register", r.id),
          title: `Risk register: ${r.title}`,
          description: `${r.description} Treatment: ${r.treatment}; next review ${r.nextReview}.`,
          props: [...scfProps([...r.scf]), ...registerProps(r)],
          "related-risks": [{ "risk-uuid": regRisks[k].uuid }],
        }))),
        ...await Promise.all(vulns.map(async (v, k) => ({
          uuid: await uuidFor(i.fleet.id, "poam-item", "vulnerability", v.connector, v.id),
          title: `Vulnerability: ${v.cve ?? v.title} on ${v.asset}`,
          description: `${v.title}${v.package ? ` (${v.package})` : ""}. Severity ${v.severity}${
            v.firstSeen ? `, open since ${v.firstSeen.slice(0, 10)}` : ""
          }; remediate it, or accept it as a risk in risks.ts.`,
          props: vulnProps(v),
          "related-risks": [{ "risk-uuid": vulnRisks[k].uuid }],
        }))),
      ],
      "back-matter": await backMatter(i),
    },
  };
}

/**
 * OSCAL strings never start or end with white space and are never empty
 * (its StringDatatype): trim each, and say "none" for an empty one.
 */
export function tidyStrings<T>(x: T): T {
  if (typeof x === "string") return (x.trim() || "none") as T;
  if (Array.isArray(x)) return x.map(tidyStrings) as T;
  if (x && typeof x === "object") {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, tidyStrings(v)])) as T;
  }
  return x;
}

/** All four, by file name. */
export async function oscalExports(i: OscalInput): Promise<Record<string, unknown>> {
  return tidyStrings({
    "component-definition.json": await componentDefinition(i),
    "system-security-plan.json": await systemSecurityPlan(i),
    "assessment-results.json": await assessmentResults(i),
    "poam.json": await poam(i),
  });
}
