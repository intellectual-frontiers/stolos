/**
 * Spec 092: the exports API. One function, {@link buildExports}, turns what
 * Stolos knows into a document in a standard format, as bytes with a file
 * name and a media type, so delivery code (OTLP sending, files, email,
 * schedules) needs to know nothing about the formats.
 *
 * | Kind | Format | Needs |
 * | --- | --- | --- |
 * | `ocsf-jsonl` | OCSF 1.9.0 events, JSON Lines | estate and/or compliance view |
 * | `otlp-json` | OTLP/HTTP JSON logs request (the OCSF events) | estate and/or compliance view |
 * | `cyclonedx-attestation` | CycloneDX 1.6 attestation (CDXA) | compliance view (bundle optional) |
 * | `intoto-statement` | in-toto Statement v1 for an evidence bundle | bundle |
 * | `oscal-component-definition`, `oscal-ssp`, `oscal-assessment-results`, `oscal-poam` | OSCAL 1.2.3 (spec 071) | compliance view with the SCF catalog |
 *
 * ```mermaid
 * flowchart LR
 *   in["ExportInput: fleet, time, estate, compliance view, bundle"] --> build["buildExports(kind, input)"]
 *   build --> file["ExportFile: fileName, mediaType, bytes"]
 *   file --> cli["stolos export &lt;kind&gt;"] & delivery["delivery (OTLP, files, email)"]
 * ```
 *
 * Every document is a function of its input: the same input gives the same
 * bytes (the time is part of the input).
 *
 * @module
 */

import type { ScfCatalog } from "../compliance/catalog.ts";
import { oscalExports } from "../compliance/oscal.ts";
import type { ComplianceView } from "../compliance/report.ts";
import type { Estate } from "../estate/graph.ts";
import { VERSION } from "../version.ts";
import { cdxAttestation } from "./cyclonedx.ts";
import { type BundleInfo, evidenceStatement } from "./intoto.ts";
import { complianceEvents, estateEvents, type OcsfEvent, toJsonl } from "./ocsf.ts";
import { otlpLogsRequest } from "./otlp.ts";

/** The kinds of export, in the order `stolos export` lists them. */
export const EXPORT_KINDS = [
  "ocsf-jsonl",
  "otlp-json",
  "cyclonedx-attestation",
  "intoto-statement",
  "oscal-component-definition",
  "oscal-ssp",
  "oscal-assessment-results",
  "oscal-poam",
] as const;

/** One kind of export. */
export type ExportKind = typeof EXPORT_KINDS[number];

/** Whether a string names a kind of export. */
export function isExportKind(s: string): s is ExportKind {
  return (EXPORT_KINDS as readonly string[]).includes(s);
}

/** What an export is made from; each kind uses what it needs and says what is missing. */
export interface ExportInput {
  /** The fleet. */
  fleet: { id: string; title: string; repo: string };
  /** The time the documents are stamped with. */
  now: Date;
  /** The estate graph (people, accounts, machines, other nodes). */
  estate?: Estate;
  /** The compliance view (every control with its evidence). */
  view?: ComplianceView;
  /** The SCF catalog (framework mappings in findings; needed by OSCAL). */
  catalog?: ScfCatalog;
  /** The fleet's machines, for the OSCAL SSP's inventory. */
  machines?: Array<{ name: string; kind: string; os?: string }>;
  /** SP 800-53 titles by OSCAL id (when NIST's catalog is on this PC). */
  nistTitles?: Record<string, string>;
  /** A spec 072 evidence bundle. */
  bundle?: BundleInfo;
  /** The fleet signer to name in an attestation (default: the bundle's signer). */
  signer?: string;
  /** OTLP: also send inventory as OpenTelemetry entity events (Development status; default off). */
  entityEvents?: boolean;
}

/** One exported document. */
export interface ExportFile {
  /** Its file name (no directory). */
  fileName: string;
  /** Its media type. */
  mediaType: string;
  /** Its bytes. */
  bytes: Uint8Array;
}

const enc = new TextEncoder();
const json = (x: unknown) => enc.encode(JSON.stringify(x, null, 2) + "\n");

/** Every OCSF event the input gives: the estate's inventory, then the compliance findings. */
export function ocsfEvents(i: ExportInput): OcsfEvent[] {
  if (!i.estate && !i.view) {
    throw new Error("nothing to export: neither the estate graph nor the compliance view");
  }
  const o = { fleet: i.fleet.id, fleetTitle: i.fleet.title, now: i.now };
  return [
    ...(i.estate ? estateEvents(i.estate, o) : []),
    ...(i.view
      ? complianceEvents(i.view, { ...o, ...(i.catalog ? { catalog: i.catalog } : {}) })
      : []),
  ];
}

const OSCAL_FILES: Record<string, string> = {
  "oscal-component-definition": "component-definition.json",
  "oscal-ssp": "system-security-plan.json",
  "oscal-assessment-results": "assessment-results.json",
  "oscal-poam": "poam.json",
};

/** Build one export. Throws, saying what is missing, when the input cannot make it. */
export async function buildExports(kind: ExportKind, i: ExportInput): Promise<ExportFile> {
  const id = i.fleet.id;
  switch (kind) {
    case "ocsf-jsonl":
      return {
        fileName: `${id}-ocsf.jsonl`,
        mediaType: "application/x-ndjson",
        bytes: enc.encode(toJsonl(ocsfEvents(i))),
      };
    case "otlp-json":
      return {
        fileName: `${id}-otlp-logs.json`,
        mediaType: "application/json",
        bytes: json(
          otlpLogsRequest(ocsfEvents(i), {
            fleet: id,
            now: i.now,
            ...(i.entityEvents ? { entities: true } : {}),
          }),
        ),
      };
    case "cyclonedx-attestation": {
      if (!i.view) throw new Error("a CycloneDX attestation needs the compliance view");
      return {
        fileName: `${id}-attestation.cdx.json`,
        mediaType: "application/vnd.cyclonedx+json; version=1.6",
        bytes: json(
          await cdxAttestation({
            view: i.view,
            fleet: i.fleet,
            now: i.now,
            ...(i.signer ? { signer: i.signer } : {}),
            ...(i.bundle ? { bundle: i.bundle } : {}),
          }),
        ),
      };
    }
    case "intoto-statement": {
      if (!i.bundle) throw new Error("an in-toto statement is about an evidence bundle: give one");
      return {
        fileName: `${i.bundle.fileName.replace(/\.zip$/i, "")}.intoto.json`,
        mediaType: "application/vnd.in-toto+json",
        bytes: json(await evidenceStatement(i.bundle)),
      };
    }
    default: {
      if (!i.view?.catalog) {
        throw new Error(
          "OSCAL reaches NIST through the SCF catalog, which is not on this PC (deno task stolos compliance catalog)",
        );
      }
      const docs = await oscalExports({
        view: i.view,
        fleet: i.fleet,
        machines: i.machines ?? [],
        ...(i.nistTitles ? { titles: i.nistTitles } : {}),
        version: VERSION,
        now: i.now,
      });
      const name = OSCAL_FILES[kind];
      return { fileName: `${id}-${name}`, mediaType: "application/json", bytes: json(docs[name]) };
    }
  }
}
