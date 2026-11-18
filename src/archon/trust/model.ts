/**
 * Spec 081: what a Trust Center says, read from a verified evidence bundle
 * (spec 072) and nothing else. The bundle's OSCAL assessment results (spec
 * 071) give every check Stolos made and the SCF controls it is evidence for;
 * the bundle's other items (verify results, observations, commits) say when
 * each source was last observed; the SCF Council's mappings (STRM), from the
 * catalog release the bundle names, carry each control to each framework's
 * requirements. Freshness is spec 073's: each source held to its default
 * cadence as of the moment the bundle was signed, and the bundle as a whole
 * held to FedRAMP 20x's longest validation interval (7 days) as of the
 * moment the page is built.
 *
 * ```mermaid
 * flowchart LR
 *   zip["evidence bundle (verified)"] --> oscal["assessment-results.json: checks and SCF controls"]
 *   zip --> items["verify, observation, commit items: when each source was observed"]
 *   oscal & items --> fresh["spec 073: stale when signed"] --> ctl["each SCF control's status and age"]
 *   cat["SCF catalog (the release the bundle names)"] --> fw["each framework requirement's status"]
 *   ctl --> fw
 * ```
 *
 * Nothing here reads this PC's live state: a Trust Center built twice from
 * the same bundle (at the same time, with the same catalog) says the same.
 *
 * @module
 */

import { sha256 as sha256Hex, unzip } from "@intellectual-frontiers/commons/ts/kernel";
import type { Manifest, ManifestItem, VerifyResult } from "../evidence/bundle.ts";
import { SCF_SOURCE, type ScfCatalog, type ScfEntry } from "../compliance/catalog.ts";
import {
  applyFreshness,
  type ControlFreshness,
  controlFreshness,
  FEDRAMP_20X_VALIDATION,
  resolveCadences,
} from "../compliance/freshness.ts";
import { complianceView, type Coverage, type Evidence } from "../compliance/report.ts";
import { type FrameworkId, FRAMEWORKS, SCF } from "../compliance/scf.ts";
import { bundleItemsFor } from "../export/cyclonedx.ts";

const dec = new TextDecoder();
const STOLOS_NS = "https://github.com/intellectual-frontiers/stolos";

/** One check from the bundle's OSCAL assessment results, with the bundle items behind it. */
export interface TrustCheck extends Evidence {
  /** Its OSCAL observation's UUID. */
  observation: string;
  /** The bundle items that bear on it (the OSCAL results, and its source's own items). */
  items: ManifestItem[];
}

/** One SCF control, as the Trust Center shows it. */
export interface TrustControl {
  /** Its SCF id (CRY-07). */
  id: string;
  /** Its name (SCF's). */
  name: string;
  /** What Stolos looks at for it, in plain words. */
  how: string;
  /** Its status from its checks, stale checks counted as failing (spec 073). */
  status: Coverage;
  /** Its checks. */
  checks: TrustCheck[];
  /** How many checks have each result, and how many are stale. */
  counts: Record<Evidence["status"] | "stale", number>;
  /** Its evidence's age as of the bundle's signing. */
  freshness: ControlFreshness;
  /** The bundle items that back it, once each, in manifest order. */
  items: ManifestItem[];
}

/** One framework requirement and the SCF controls that reach it. */
export interface TrustRequirement {
  /** The requirement as its framework writes it (CC6.1, 164.312(a)(2)(iv)). */
  id: string;
  /** What its controls add up to. */
  status: Coverage;
  /** The SCF controls mapped to it. */
  controls: string[];
}

/** One framework, by its requirements. */
export interface TrustFramework {
  /** Its id (soc2). */
  id: FrameworkId;
  /** Its full title. */
  title: string;
  /** Its short name. */
  short: string;
  /** Its requirements. */
  requirements: TrustRequirement[];
}

/** Everything a Trust Center page says, from one bundle. */
export interface TrustModel {
  /** The company (the fleet's title). */
  company: string;
  /** The fleet's id (the bundle's hash chain starts from it). */
  fleetId: string;
  /** The fleet repository (owner/name): shown only behind access (gated). */
  repo: string;
  /** The period the evidence covers (ISO dates). */
  period: { from: string; to: string };
  /** When the bundle was made and signed. */
  created: string;
  /** The fleet signer who signed it (verified). */
  signer: string;
  /** The Stolos version that made the bundle. */
  stolos: string;
  /** The bundle itself. */
  bundle: { fileName: string; sha256: string; head: string; items: number; commits: number };
  /** The SCF release the bundle's mappings name, and where the framework mappings came from. */
  scf: { version: string; mappings: "catalog" | "bundle" };
  /** When the page was built (ISO). */
  asOf: string;
  /** The bundle's age when the page was built. */
  ageMs: number;
  /** Older than FedRAMP 20x's longest validation interval when the page was built: every status is stale. */
  bundleStale: boolean;
  /** That interval, in days. */
  maxAgeDays: number;
  /** Every SCF control Stolos gives evidence for, with or without evidence in this bundle. */
  controls: TrustControl[];
  /** The frameworks shown. */
  frameworks: TrustFramework[];
  /** Frameworks that cannot be shown from this bundle, and why. */
  unavailable: Array<{ id: FrameworkId; reason: string }>;
  /** Evidence the bundle says it could not include. */
  omitted: string[];
}

/** What a Trust Center is built from: a bundle, its verification, and the catalog. */
export interface TrustInput {
  /** The bundle's bytes. */
  zip: Uint8Array;
  /** The bundle's file name. */
  fileName: string;
  /** What `verifyBundle` found (it must be ok). */
  verified: VerifyResult;
  /** The SCF catalog, when this PC has it (only the release the bundle names is used). */
  catalog?: ScfCatalog;
  /** The frameworks to show (default: every one the mappings reach). */
  frameworks?: FrameworkId[];
  /** When the page is built. */
  now?: Date;
}

/** An OSCAL property, as Stolos reads it. */
export interface OscalProp {
  /** Its name. */
  name: string;
  /** Its value. */
  value: string;
  /** Its namespace. */
  ns?: string;
}

/** An OSCAL observation, as Stolos reads it. */
export interface OscalObservation {
  /** Its UUID. */
  uuid: string;
  /** "<subject>: <check>". */
  title: string;
  /** "<result>: <detail>". */
  description: string;
  /** Its SCF controls, result, and source. */
  props?: OscalProp[];
  /** When it was collected. */
  collected?: string;
  /** "Fix: ...", when failing. */
  remarks?: string;
}

/** An OSCAL finding, as Stolos reads it. */
export interface OscalFinding {
  /** "<control id> <title>". */
  title: string;
  /** Its SCF controls. */
  props?: OscalProp[];
}

/** The parts of an OSCAL assessment-results document a Trust Center reads. */
export interface OscalResults {
  /** The document. */
  "assessment-results"?: {
    results?: Array<{ observations?: OscalObservation[]; findings?: OscalFinding[] }>;
    "back-matter"?: { resources?: Array<{ title?: string }> };
  };
}

const SOURCES: readonly Evidence["source"][] = [
  "managed",
  "adopted",
  "device",
  "cloud",
  "estate",
  "repository",
  "control pack",
  "network",
];
const RESULTS: readonly Evidence["status"][] = ["pass", "fail", "warn", "unknown", "accepted"];

/** The SCF release an OSCAL document's back-matter names (its STRM resource), or undefined. */
export function scfVersionOf(ar: OscalResults): string | undefined {
  const esc = SCF_SOURCE.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc} (\\S+) \\(the mappings`);
  for (const r of ar["assessment-results"]?.["back-matter"]?.resources ?? []) {
    const m = r.title?.match(re);
    if (m) return m[1];
  }
  return undefined;
}

/** The checks an OSCAL assessment-results document records, as evidence. */
export function oscalChecks(ar: OscalResults): Array<Evidence & { observation: string }> {
  const out: Array<Evidence & { observation: string }> = [];
  for (const r of ar["assessment-results"]?.results ?? []) {
    for (const o of r.observations ?? []) {
      const props = o.props ?? [];
      const scf = props.filter((p) => p.name === "scf-control").map((p) => p.value);
      const result = props.find((p) => p.name === "result" && p.ns === STOLOS_NS)?.value;
      const source = props.find((p) => p.name === "source" && p.ns === STOLOS_NS)?.value;
      const status = (RESULTS as readonly string[]).includes(result ?? "")
        ? (result as Evidence["status"])
        : "unknown";
      const src = (SOURCES as readonly string[]).includes(source ?? "")
        ? (source as Evidence["source"])
        : "repository";
      const k = o.title.indexOf(": ");
      const subject = k < 0 ? o.title : o.title.slice(0, k);
      const check = k < 0 ? o.title : o.title.slice(k + 2);
      const detail = o.description.startsWith(`${status}: `)
        ? o.description.slice(status.length + 2)
        : o.description;
      out.push({
        scf,
        subject,
        source: src,
        check,
        status,
        detail: detail === "(no detail)" ? "" : detail,
        ...(o.remarks?.startsWith("Fix: ") ? { fix: o.remarks.slice(5) } : {}),
        observation: o.uuid,
      });
    }
  }
  return out;
}

/**
 * SP 800-53 mappings from the bundle's own OSCAL findings (each finding names
 * its control and the SCF controls that reach it), as a catalog with only
 * that framework: used when the SCF catalog of the bundle's release is not on
 * this PC.
 */
export function findingsCatalog(ar: OscalResults, version: string): ScfCatalog {
  const controls: Record<string, ScfEntry> = {};
  const empty = () =>
    Object.fromEntries(FRAMEWORKS.map((f) => [f.id, [] as string[]])) as unknown as Record<
      FrameworkId,
      string[]
    >;
  for (const r of ar["assessment-results"]?.results ?? []) {
    for (const f of r.findings ?? []) {
      const id = f.title.split(/\s+/)[0] ?? f.title;
      for (const p of (f.props ?? []).filter((x) => x.name === "scf-control")) {
        const known = SCF.find((c) => c.id === p.value);
        const e = (controls[p.value] ??= {
          domain: "",
          name: known?.name ?? p.value,
          description: "",
          maps: empty(),
        });
        if (!e.maps.nist80053.includes(id)) e.maps.nist80053.push(id);
      }
    }
  }
  return { format: 1, version, controls };
}

/** The bundle's assessment results (its newest "oscal" item named assessment-results.json). */
export function assessmentItem(m: Manifest): ManifestItem | undefined {
  return m.items
    .filter((i) => i.kind === "oscal" && i.name.endsWith("assessment-results.json"))
    .at(-1);
}

/** The items whose time says when a check's source was observed (not the OSCAL document or signers.ts, made at export). */
const timed = (i: ManifestItem) => i.kind !== "oscal" && i.kind !== "signers";

/**
 * The Trust Center's model of a verified bundle; throws with the reason when
 * the bundle cannot back one (not verified, no assessment results, a
 * framework asked for that its mappings do not reach).
 */
export async function trustModel(i: TrustInput): Promise<TrustModel> {
  const v = i.verified;
  if (!v.ok || !v.manifest || !v.signer) {
    throw new Error(`the bundle does not verify: ${v.problems.join("; ") || "no signer"}`);
  }
  const m = v.manifest;
  const unzipped = await unzip(i.zip);
  if (unzipped.kind === "err") throw new Error(`the bundle is not a ZIP (${unzipped.error.kind})`);
  const files = unzipped.value;
  const ai = assessmentItem(m);
  if (!ai) {
    throw new Error(
      "the bundle has no OSCAL assessment results (it was made without the SCF catalog): there is nothing to show",
    );
  }
  const ar = JSON.parse(
    dec.decode(files.get(`objects/${ai.sha256}`) ?? new Uint8Array()),
  ) as OscalResults;
  const version = scfVersionOf(ar) ?? SCF_SOURCE.version;
  const signedAt = Date.parse(m.created);
  const now = i.now ?? new Date();

  // Each check, with its items and the newest observation time among them.
  const raw = oscalChecks(ar).map((e) => {
    const items = bundleItemsFor(e, m.items);
    const times = items
      .filter(timed)
      .map((x) => x.at)
      .sort();
    const newest = times.at(-1);
    return { ...e, items, ...(newest ? { observedAt: newest } : {}) };
  });
  // Spec 073: stale when signed (the default cadences: the bundle carries no fleet.ts).
  // A stale check also counts against MON-02 (073); its items and observation come along.
  const fresh = applyFreshness(raw, resolveCadences(), signedAt) as TrustCheck[];

  // The mappings: the catalog of the bundle's release, else the bundle's own SP 800-53 findings.
  const own = i.catalog && i.catalog.version === version ? i.catalog : undefined;
  const useCatalog = own !== undefined;
  const catalog = own ?? findingsCatalog(ar, version);
  const view = complianceView(fresh, catalog);
  const unavailable: TrustModel["unavailable"] = [];
  const available = view.frameworks.filter((f) => {
    if (f.requirements.length) return true;
    unavailable.push({
      id: f.id,
      reason: useCatalog
        ? "no SCF control with evidence here maps to it"
        : i.catalog
          ? `this PC has SCF ${i.catalog.version}, the bundle's mappings are SCF ${version}`
          : `the SCF ${version} catalog is not on this PC (bun run stolos compliance catalog)`,
    });
    return false;
  });
  const want = i.frameworks;
  for (const id of want ?? []) {
    const u = unavailable.find((x) => x.id === id);
    if (u) throw new Error(`${id}: cannot be shown from this bundle: ${u.reason}`);
  }
  const frameworks = available.filter((f) => !want || want.includes(f.id));

  const order = new Map(m.items.map((x, k) => [x.sha256 + x.name, k]));
  const controls: TrustControl[] = view.controls.map((c) => {
    const checks = c.evidence as TrustCheck[];
    const counts = { pass: 0, fail: 0, warn: 0, unknown: 0, accepted: 0, stale: 0 };
    for (const e of checks) {
      counts[e.status]++;
      if (e.stale) counts.stale++;
    }
    const by = new Map<string, ManifestItem>();
    for (const e of checks) for (const x of e.items) by.set(x.sha256, x);
    return {
      id: c.control.id,
      name: c.control.name,
      how: c.control.how,
      status: c.status,
      checks,
      counts,
      freshness: controlFreshness(c, signedAt),
      items: [...by.values()].sort(
        (a, b) => (order.get(a.sha256 + a.name) ?? 0) - (order.get(b.sha256 + b.name) ?? 0),
      ),
    };
  });
  const ageMs = Math.max(0, now.getTime() - signedAt);
  const maxAgeDays = FEDRAMP_20X_VALIDATION.maxDays;
  return {
    company: m.fleet.title || m.fleet.id,
    fleetId: m.fleet.id,
    repo: m.fleet.repo,
    period: m.period,
    created: m.created,
    signer: v.signer,
    stolos: m.stolos,
    bundle: {
      fileName: i.fileName,
      sha256: await sha256Hex(i.zip),
      head: m.head,
      items: m.items.length,
      commits: v.commits.length,
    },
    scf: { version, mappings: useCatalog ? "catalog" : "bundle" },
    asOf: now.toISOString().replace(/\.\d+Z$/, "Z"),
    ageMs,
    bundleStale: ageMs > maxAgeDays * 86_400_000,
    maxAgeDays,
    controls,
    frameworks: frameworks.map((f) => ({
      id: f.id,
      title: f.title,
      short: f.short,
      requirements: f.requirements,
    })),
    unavailable: unavailable.filter((u) => !want || want.includes(u.id)),
    omitted: m.omitted ?? [],
  };
}
