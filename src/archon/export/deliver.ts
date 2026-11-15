/**
 * Delivery of exports (spec 092, part B): where a job's documents go, by the
 * owner's rule.
 *
 * 1. **The fleet's OpenTelemetry collector** (`telemetry.collector` in
 *    `fleets/<id>/fleet.ts`), over OTLP/HTTP, when one is configured and the
 *    job does not say `otlp: false`. A document that already is OTLP JSON
 *    goes to its own signal (`/v1/logs`, `/v1/traces`, `/v1/metrics`); any
 *    other is one log record whose body is the document, with its name, type,
 *    and SHA-256 as attributes.
 * 2. **Otherwise a file** in this PC's state directory,
 *    `exports/<job>/<time>/<file>` (also when the collector does not answer).
 * 3. **A file can then be emailed** (`email` in the job): send-only, through
 *    the fleet's mail setup (spec 027) or the job's own send-only credential,
 *    each recipient getting a copy encrypted to their own certificate
 *    (smime.ts). A job with recipients always keeps the file too.
 *
 * Every run writes `exports/<job>/last-run.json` (what was made, where it
 * went, what failed), which never holds a secret: errors are redacted with
 * the credential in use.
 *
 * ```mermaid
 * flowchart TD
 *   job["export job<br/>(estate.exports)"] --> src["sources by kind<br/>(OSCAL now; OCSF, OTLP, CycloneDX, in-toto)"]
 *   src --> docs["ExportDocument[]"]
 *   docs --> q{"collector configured?"}
 *   q -->|yes| otlp["OTLP/HTTP POST"]
 *   q -->|no| file["file in the state directory"]
 *   otlp -->|fails| file
 *   docs --> e{"email recipients?"}
 *   e -->|yes| file
 *   file --> mail["S/MIME per recipient<br/>send-only SMTP over TLS"]
 * ```
 *
 * The document formats themselves are produced elsewhere, each behind an
 * ExportSource; this module only needs ExportDocument.
 *
 * @module
 */

import type { Estate } from "../estate/graph.ts";
import type { ExportJobDef, ExportKind, FleetDef } from "../model/types.ts";
import type { ExportInput, ExportKind as ExportFormat } from "./exports.ts";
import {
  type cms,
  type JsonObject,
  otlp,
  sha256 as kernelSha256,
} from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, path } from "@intellectual-frontiers/ifc-ts/runtime";
import { type Attachment, escapeHtml, headerValue, mimeEntity } from "../notify/mime.ts";
import { redact } from "../notify/redact.ts";
import {
  type Credential,
  DEFAULT_RELAY,
  secretsOf,
  type SmtpOptions,
} from "../notify/transport.ts";
import { smimeMessage } from "./smime.ts";
import { jobSender, readRecipients, tenantFilter } from "./jobs.ts";

/** One document to deliver: what the exporters produce (spec 092 part A's `buildExports`). */
export interface ExportDocument {
  /** Its file name (no folders), for example `assessment-results.json`. */
  fileName: string;
  /** Its media type, for example `application/json` or `application/vnd.cyclonedx+json`. */
  mediaType: string;
  /** Its content. */
  bytes: Uint8Array;
}

/** What a source is given: the fleet, the job, its tenant filter, and the time. */
export interface ExportContext {
  /** The fleet's model. */
  fleet: FleetDef;
  /** The job being run. */
  job: ExportJobDef;
  /** Whether a tenant uid (`<connector>:<account>`) is in the job. */
  tenant: (uid: string) => boolean;
  /** The time of this run. */
  now: Date;
}

/** Makes one kind's documents for a job (none when the job's tenants have nothing of it). */
export type ExportSource = (ctx: ExportContext) => Promise<ExportDocument[]>;

/** A document with the kind that made it. */
export interface KindDocument {
  /** The kind. */
  kind: ExportKind;
  /** The document. */
  doc: ExportDocument;
}

/**
 * OSCAL (spec 071): the fleet's four documents, for the fleet's own tenant
 * (`fleet:<id>`). Nothing when the job's tenants leave it out.
 */
export const oscalSource: ExportSource = async (ctx: ExportContext): Promise<ExportDocument[]> => {
  if (!ctx.tenant(`fleet:${ctx.fleet.id}`)) return [];
  const { oscalDocuments } = await import("../compliance/commands.ts");
  const r = await oscalDocuments(ctx.now);
  if (!r.ok) throw new Error(`${r.error} (${r.fix})`);
  return Object.entries(r.docs).map(([name, doc]) => ({
    fileName: `oscal-${name}`,
    mediaType: "application/json",
    bytes: new TextEncoder().encode(JSON.stringify(doc, null, 2) + "\n"),
  }));
};

/**
 * The estate graph limited to a job's tenants: nodes, labels, and gaps of
 * other tenants are dropped; people and machines (the fleet's own) stay only
 * when the fleet's tenant is in the job.
 */
export function estateForTenants(e: Estate, ctx: ExportContext): Estate {
  const allowed = (
    e.db.prepare("SELECT tenant_uid FROM tenant").all() as Array<{ tenant_uid: string }>
  )
    .map((r) => r.tenant_uid)
    .filter((t) => ctx.tenant(t));
  const keep = JSON.stringify(allowed);
  e.db.exec("PRAGMA foreign_keys = OFF");
  e.db
    .prepare(
      "DELETE FROM node_label WHERE node_uid IN (SELECT node_uid FROM node WHERE tenant_uid NOT IN (SELECT value FROM json_each(?)))",
    )
    .run(keep);
  e.db
    .prepare("DELETE FROM node WHERE tenant_uid NOT IN (SELECT value FROM json_each(?))")
    .run(keep);
  e.db
    .prepare("DELETE FROM observation WHERE tenant_uid NOT IN (SELECT value FROM json_each(?))")
    .run(keep);
  if (!ctx.tenant(`fleet:${ctx.fleet.id}`)) {
    for (const t of [
      "party_fixed_asset_assignment",
      "fixed_asset",
      "party_relationship",
      "party_role",
      "party_contact_mechanism",
      "person",
    ]) {
      e.db.exec(`DELETE FROM ${t}`);
    }
  }
  return e;
}

/** What the standard formats are made from, for a job (spec 092 part A's `buildExports`). */
async function exportInput(
  ctx: ExportContext,
  need: { estate?: boolean; bundle?: boolean },
): Promise<ExportInput> {
  const { pcFacts } = await import("../console/pc.ts");
  const { loadScf } = await import("../compliance/catalog.ts");
  const { complianceView, fleetEvidence } = await import("../compliance/report.ts");
  const f = await pcFacts();
  const catalog = await loadScf();
  const input: ExportInput = {
    fleet: f.fleet,
    now: ctx.now,
    view: complianceView(fleetEvidence(f), catalog),
    ...(catalog ? { catalog } : {}),
  };
  if (need.estate) {
    const { loadEstate } = await import("../estate/commands.ts");
    input.estate = estateForTenants(await loadEstate(), ctx);
  }
  if (need.bundle) {
    const { newestBundle } = await import("./commands.ts");
    const { bundleInfo } = await import("./intoto.ts");
    const file = await newestBundle();
    if (file) input.bundle = await bundleInfo(file, await fs.readFile(file));
  }
  return input;
}

/** A source made from one of spec 092 part A's formats. */
function formatSource(
  format: ExportFormat,
  need: { estate?: boolean; bundle?: boolean; requireBundle?: boolean },
): ExportSource {
  return async (ctx) => {
    const input = await exportInput(ctx, need);
    if (need.requireBundle && !input.bundle) return [];
    const { buildExports } = await import("./exports.ts");
    const f = await buildExports(format, input);
    return [{ fileName: f.fileName, mediaType: f.mediaType, bytes: f.bytes }];
  };
}

const SOURCES = new Map<ExportKind, ExportSource>([
  ["oscal", oscalSource],
  ["ocsf", formatSource("ocsf-jsonl", { estate: true })],
  ["otlp", formatSource("otlp-json", { estate: true })],
  ["cyclonedx", formatSource("cyclonedx-attestation", { bundle: true })],
  ["in-toto", formatSource("intoto-statement", { bundle: true, requireBundle: true })],
]);

/** Register (or replace) the source of a kind: how the exporters plug in. */
export function registerExportSource(kind: ExportKind, source: ExportSource): void {
  SOURCES.set(kind, source);
}

/** The source of a kind, or undefined when this version cannot make it yet. */
export const exportSource = (kind: ExportKind): ExportSource | undefined => SOURCES.get(kind);

// ------------------------------------------------------------------ plan

/** Where a job's documents go this run. */
export interface DeliveryPlan {
  /** The collector's base URL (OTLP/HTTP), when the fleet configures one and the job allows it. */
  otlp?: string;
  /** Write files in the state directory (no collector, or recipients to email). */
  file: boolean;
  /** Email the files. */
  email: boolean;
}

/** The owner's rule: the collector when configured, else a file; a file also when it is emailed. */
export function deliveryPlan(fleet: FleetDef, job: ExportJobDef): DeliveryPlan {
  const collector = job.otlp === false ? undefined : fleet.telemetry?.collector;
  const email = !!job.email?.to?.length;
  return {
    ...(collector ? { otlp: collector.replace(/\/+$/, "") } : {}),
    file: !collector || email,
    email,
  };
}

// ------------------------------------------------------------------ OTLP

/** Whether a media type is text (sent as a string body), else bytes. */
export const isText = (mediaType: string): boolean =>
  /^text\/|[/+]json\b|[/+]xml\b|jsonl|ndjson/i.test(mediaType);

/**
 * The OTLP signal path of a document that already is OTLP JSON
 * (`resourceLogs`, `resourceSpans`, `resourceMetrics`), or undefined.
 */
export function otlpSignal(doc: ExportDocument): string | undefined {
  if (!/json/i.test(doc.mediaType)) return undefined;
  if (!/otlp/i.test(doc.mediaType + doc.fileName)) return undefined;
  try {
    const j: unknown = JSON.parse(new TextDecoder().decode(doc.bytes));
    if (typeof j !== "object" || j === null) return undefined;
    if ("resourceLogs" in j) return "/v1/logs";
    if ("resourceSpans" in j) return "/v1/traces";
    if ("resourceMetrics" in j) return "/v1/metrics";
  } catch {
    // Not one JSON document (JSON Lines): wrapped as a log record like any other.
  }
  return undefined;
}

/**
 * One OTLP/JSON logs request carrying these documents, one log record each:
 * the body is the document (a string, or bytes in base64), the attributes
 * name it (`stolos.export.*`).
 */
export async function otlpLogs(
  docs: KindDocument[],
  meta: { fleet: string; job: string; now: Date },
): Promise<JsonObject> {
  const t = BigInt(meta.now.getTime()) * 1_000_000n;
  const records = [];
  for (const { kind, doc } of docs) {
    records.push({
      time: t,
      observedTime: t,
      severityNumber: 9 as const,
      severityText: "INFO",
      eventName: "stolos.export.document",
      body: isText(doc.mediaType) ? new TextDecoder().decode(doc.bytes) : doc.bytes,
      attributes: {
        "stolos.export.job": meta.job,
        "stolos.export.kind": kind,
        "stolos.export.file_name": doc.fileName,
        "stolos.export.media_type": doc.mediaType,
        "stolos.export.sha256": await kernelSha256(doc.bytes),
      },
      droppedAttributesCount: 0,
    });
  }
  return otlp.encodeLogs([
    {
      resource: { attributes: { "service.name": "stolos", "stolos.fleet": meta.fleet } },
      scope: { name: "stolos.export" },
      records,
    },
  ]);
}

/**
 * Send the documents to the collector: OTLP documents to their own signal,
 * the rest as one logs request. Throws on the first refusal.
 */
export async function postOtlp(
  base: string,
  docs: KindDocument[],
  meta: { fleet: string; job: string; now: Date },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const post = async (path: string, body: BodyInit) => {
    const r = await fetchFn(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    await r.body?.cancel();
    if (!r.ok) throw new Error(`${base}${path} answered ${r.status}`);
  };
  const rest: KindDocument[] = [];
  for (const d of docs) {
    const signal = otlpSignal(d.doc);
    if (signal) await post(signal, new Uint8Array(d.doc.bytes));
    else rest.push(d);
  }
  if (rest.length) await post("/v1/logs", JSON.stringify(await otlpLogs(rest, meta)));
}

// ------------------------------------------------------------------ files

/** A file name safe in any folder: no separators, no leading dots. */
export const safeName = (n: string): string =>
  [...n]
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? "_" : c))
    .join("")
    .replace(/^\.+/, "_") || "export";

/** The folder for one run: `exports/<job>/<UTC time, colons as dashes>`. */
export const runDir = (stateDir: string, job: string, now: Date): string =>
  path.join(
    stateDir,
    "exports",
    job,
    now
      .toISOString()
      .replace(/\.\d+Z$/, "Z")
      .replace(/:/g, "-"),
  );

/** Write each document into `dir`; returns the paths. */
export async function writeFiles(dir: string, docs: ExportDocument[]): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true });
  const out: string[] = [];
  for (const d of docs) {
    const p = path.join(dir, safeName(d.fileName));
    await fs.writeFile(p, d.bytes);
    out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ email

/** The most a message may attach, in bytes before base64 (relays refuse much larger mail). */
export const MAX_EMAIL_BYTES = 15_000_000;

/** The plain text of an export message: what is attached, with sizes and SHA-256. */
export async function mailText(
  docs: ExportDocument[],
  o: { fleet: string; job: ExportJobDef; pc: string; now: Date },
): Promise<string> {
  const lines = [
    `Stolos export "${o.job.title ?? o.job.id}" for the fleet ${o.fleet}, ${o.now.toISOString()}.`,
    "",
    "Attached:",
  ];
  for (const d of docs) {
    lines.push(
      `- ${d.fileName} (${d.mediaType}, ${d.bytes.length} bytes, SHA-256 ${await kernelSha256(d.bytes)})`,
    );
  }
  lines.push(
    "",
    `Tenants: ${(o.job.tenants ?? ["all"]).join(", ")}.`,
    "This message was encrypted to your certificate only (S/MIME); your mail program opens it with your private key.",
    `Sent by "stolos export run ${o.job.id}" on ${o.pc}. Please do not reply: this address only sends.`,
  );
  return lines.join("\n") + "\n";
}

/** How one send went. */
export interface SendResult {
  /** The recipient. */
  to: string;
  /** Accepted by the relay. */
  ok: boolean;
  /** Why not (redacted). */
  error?: string;
}

/** What `emailFiles` needs besides the documents. */
export interface EmailDeps {
  /** The fleet. */
  fleet: FleetDef;
  /** The fleet's folder (certificate paths are relative to it). */
  fleetDir: string;
  /** This PC's short name (the sender's subaddress). */
  pc: string;
  /** The time of the run. */
  now: Date;
  /** The sending credential (send-only). */
  credential: Credential;
  /** Sends one message (transport.ts sendSmtp by default). */
  smtp: (
    c: Credential,
    o: Omit<SmtpOptions, "file"> & { from: string; to: string },
    mime: string,
  ) => Promise<string>;
  /** Extra SMTP options (tests: their own CA, STARTTLS). */
  smtpExtra?: Pick<SmtpOptions, "cacert" | "tls">;
  /** Fixed content key and nonce (tests). */
  random?: cms.CmsKeys;
  /** Reads a certificate file. */
  readFile?: (path: string) => Promise<string>;
}

/**
 * Email the documents to each of the job's recipients, one message each,
 * encrypted to that recipient's certificate (a recipient without a usable
 * certificate gets nothing). Returns one result per recipient.
 */
export async function emailFiles(
  job: ExportJobDef,
  docs: ExportDocument[],
  d: EmailDeps,
): Promise<SendResult[]> {
  const secrets = secretsOf(d.credential);
  const { ready, problems } = await readRecipients(job, d.fleetDir, d.now, d.readFile);
  const out: SendResult[] = problems.map((p) => ({ to: p.address, ok: false, error: p.error }));
  const size = docs.reduce((n, x) => n + x.bytes.length, 0);
  const from = jobSender(d.fleet, job, d.pc);
  const relay = job.email?.relay ?? d.fleet.mail?.relay ?? DEFAULT_RELAY;
  const text = await mailText(docs, { fleet: d.fleet.id, job, pc: d.pc, now: d.now });
  const html = `<pre style="font-family:sans-serif">${escapeHtml(text)}</pre>`;
  const attachments: Attachment[] = docs.map((x) => ({
    name: safeName(x.fileName),
    type: x.mediaType,
    data: x.bytes,
  }));
  const subject = job.email?.subject ?? `[Stolos] ${d.fleet.id} export ${job.id}`;
  for (const r of ready) {
    if (size > MAX_EMAIL_BYTES) {
      out.push({
        to: r.address,
        ok: false,
        error: `the files are ${size} bytes, too large to email (at most ${MAX_EMAIL_BYTES}); they are in the state directory`,
      });
      continue;
    }
    try {
      const inner = mimeEntity({ text, html, attachments });
      const mime = await smimeMessage(
        {
          from: `"Stolos" <${from}>`,
          to: r.address,
          subject: headerValue(subject),
          extra: { "X-Stolos-Export": job.id },
        },
        inner,
        [r.cert],
        ...(d.random ? [d.random] : []),
      );
      await d.smtp(
        d.credential,
        {
          relay,
          ipv4: d.fleet.network?.ipv6 === false,
          from,
          to: r.address,
          ...d.smtpExtra,
        },
        mime,
      );
      out.push({ to: r.address, ok: true });
    } catch (e) {
      out.push({ to: r.address, ok: false, error: redact((e as Error).message, secrets) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ a run

/** What one run did: written to `exports/<job>/last-run.json` (no secrets). */
export interface RunReport {
  /** The job's id. */
  job: string;
  /** When it ran (ISO 8601). */
  at: string;
  /** The documents made. */
  documents: Array<{ kind: ExportKind; fileName: string; mediaType: string; bytes: number }>;
  /** The collector, when tried. */
  otlp?: { endpoint: string; ok: boolean; error?: string };
  /** The files written, when written. */
  files?: string[];
  /** Each email sent or refused. */
  email: SendResult[];
  /** Everything that went wrong, in plain words (redacted). */
  problems: string[];
  /** Nothing went wrong. */
  ok: boolean;
}

/** Everything a run needs from outside, so tests replace each part. */
export interface RunDeps extends Omit<EmailDeps, "credential"> {
  /** This PC's state directory (P.state). */
  stateDir: string;
  /** POSTs to the collector. */
  fetch: typeof fetch;
  /** The send-only credential: the fleet's (no name) or a job's own. */
  credential: (name?: string) => Promise<Credential | undefined>;
  /** The source of a kind (default: exportSource). */
  source?: (kind: ExportKind) => ExportSource | undefined;
}

/** Run one job: make its documents, deliver them by the plan, record what happened. */
export async function runJob(job: ExportJobDef, d: RunDeps): Promise<RunReport> {
  const problems: string[] = [];
  const docs: KindDocument[] = [];
  const ctx: ExportContext = { fleet: d.fleet, job, tenant: tenantFilter(job), now: d.now };
  for (const kind of job.kinds) {
    const src = (d.source ?? exportSource)(kind);
    if (!src) {
      problems.push(`${kind}: this version of Stolos cannot make it yet`);
      continue;
    }
    try {
      for (const doc of await src(ctx)) docs.push({ kind, doc });
    } catch (e) {
      problems.push(`${kind}: ${(e as Error).message}`);
    }
  }
  const report: RunReport = {
    job: job.id,
    at: d.now.toISOString(),
    documents: docs.map(({ kind, doc }) => ({
      kind,
      fileName: doc.fileName,
      mediaType: doc.mediaType,
      bytes: doc.bytes.length,
    })),
    email: [],
    problems,
    ok: false,
  };
  if (!docs.length) {
    problems.push("nothing to deliver: no document was made for this job's tenants and kinds");
  } else {
    const plan = deliveryPlan(d.fleet, job);
    let file = plan.file;
    if (plan.otlp) {
      try {
        await postOtlp(plan.otlp, docs, { fleet: d.fleet.id, job: job.id, now: d.now }, d.fetch);
        report.otlp = { endpoint: plan.otlp, ok: true };
      } catch (e) {
        const error = redact((e as Error).message);
        report.otlp = { endpoint: plan.otlp, ok: false, error };
        problems.push(`the collector: ${error}; kept as a file instead`);
        file = true;
      }
    }
    const plain = docs.map((x) => x.doc);
    if (file) report.files = await writeFiles(runDir(d.stateDir, job.id, d.now), plain);
    if (plan.email) {
      const cred = await d.credential(job.email?.credential);
      if (!cred) {
        problems.push(
          job.email?.credential
            ? `no credential named ${job.email.credential} on this PC: bun run stolos export credential ${job.email.credential}`
            : "no mail credential on this PC: bun run stolos boot mail-setup",
        );
      } else {
        report.email = await emailFiles(job, plain, { ...d, credential: cred });
        for (const r of report.email.filter((x) => !x.ok)) problems.push(`email: ${r.error}`);
      }
    }
  }
  report.ok = !problems.length;
  const dir = path.join(d.stateDir, "exports", job.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeTextFile(path.join(dir, "last-run.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
