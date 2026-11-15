/**
 * Spec 071: the fleet's compliance in OSCAL, NIST's machine-readable format,
 * so an assessor's or an agency's tools read it without retyping. Four
 * documents, all to NIST SP 800-53 Rev 5 (the controls FedRAMP and most
 * federal frameworks use), each control reached through SCF's own mappings:
 *
 * - a component definition: what Stolos does for each control;
 * - a system security plan (SSP): this fleet, its machines, and how each
 *   control is implemented, importing NIST's moderate baseline;
 * - assessment results: every observation Stolos made, and a finding per
 *   control (satisfied or not);
 * - a plan of action and milestones (POA&M): each failing check, open, and
 *   each accepted risk, as a deviation approved until its date.
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

/** The component definition: Stolos, and what it does for each SP 800-53 control. */
export async function componentDefinition(i: OscalInput): Promise<unknown> {
  const ns = nistControls(i.view, i.titles);
  return {
    "component-definition": {
      uuid: await uuidFor(i.fleet.id, "component-definition", iso(i.now)),
      metadata: await metadata(i, `Stolos ${i.version}: component definition`),
      components: [{
        uuid: await uuidFor("component", "stolos"),
        type: "software",
        title: "Stolos",
        description:
          "Fleet management and observability: managed servers converge to a model in Git and verify it; adopted machines, devices, and SaaS and cloud accounts are observed read-only; every change is a signed Git commit.",
        props: [{ name: "version", value: i.version }],
        "control-implementations": [{
          uuid: await uuidFor("component", "stolos", "nist80053"),
          source: NIST_SOURCES.nist80053.url,
          description:
            `SP 800-53 Rev 5 controls reached through ${SCF_SOURCE.title} ${SCF_SOURCE.version} (STRM).`,
          "implemented-requirements": await Promise.all(ns.map(async (n) => ({
            uuid: await uuidFor("component", "stolos", "req", n.id),
            "control-id": n.id,
            description: how(i.view, n),
            props: scfProps(n.scf),
          }))),
        }],
      }],
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

/** Every piece of evidence once (one can support several SCF controls). */
function allEvidence(view: ComplianceView): Evidence[] {
  return [...new Set(view.controls.flatMap((c) => c.evidence))];
}

const evidenceKey = (e: Evidence) => [e.source, e.subject, e.check].join("\u0000");

async function observation(i: OscalInput, e: Evidence) {
  return {
    uuid: await uuidFor(i.fleet.id, "observation", iso(i.now), evidenceKey(e)),
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
  return {
    "plan-of-action-and-milestones": {
      uuid: await uuidFor(i.fleet.id, "poam", iso(i.now)),
      metadata: await metadata(i, `${i.fleet.title}: plan of action and milestones`),
      "system-id": {
        "identifier-type": "https://ietf.org/rfc/rfc4122",
        id: await uuidFor(i.fleet.id, "component", "this-system"),
      },
      ...(obs.length ? { observations: obs, risks } : {}),
      "poam-items": await Promise.all(ev.map(async (e, k) => ({
        uuid: await uuidFor(i.fleet.id, "poam-item", evidenceKey(e)),
        title: `${e.subject}: ${e.check}`,
        description: e.status === "accepted"
          ? `A risk accepted: ${e.detail}`
          : `${e.detail}${e.fix ? `. Fix: ${e.fix}` : ""}`,
        props: scfProps(e.scf),
        "related-observations": [{ "observation-uuid": obs[k].uuid }],
        "related-risks": [{ "risk-uuid": risks[k].uuid }],
      }))),
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
