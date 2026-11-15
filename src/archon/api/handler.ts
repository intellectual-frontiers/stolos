/**
 * Spec 094: the REST API's request handler, mounted under `/v1/` in the
 * Stolos Console (`../console/stolos-server.ts`), on this PC only. The
 * console has already checked the Host (127.0.0.1 or localhost) and the
 * signed-in session before a request reaches it; it opens no listener of its
 * own.
 *
 * - `GET /v1/`: what it serves; `GET /v1/openapi.json`: the OpenAPI 3.1 document.
 * - `GET /v1/<table or view>`: a page of rows (`limit`, `offset`, equality filters).
 * - `GET /v1/finding?format=ocsf` (or `Accept: application/vnd.ocsf+json`):
 *   the findings as OCSF Compliance Findings.
 * - `GET /v1/oscal/<document>`: an OSCAL document.
 * - `GET /v1/evidence/`, `GET /v1/evidence/<bundle>`: the evidence bundles.
 *
 * Only GET and HEAD: anything else is 405.
 *
 * @module
 */

import type { ScfCatalog } from "../compliance/catalog.ts";
import type { Evidence } from "../compliance/report.ts";
import type { PolicyResult } from "../adopt/policy.ts";
import type { Estate } from "../estate/graph.ts";
import { errors, fs, path as paths } from "@intellectual-frontiers/ifc-ts/runtime";
import { complianceFindings } from "../ocsf/finding.ts";
import { VERSION } from "../version.ts";
import { ui } from "../core/ui.ts";
import { OCSF_MEDIA_TYPE, openApiDocument, OSCAL_DOCUMENTS } from "./openapi.ts";
import { listQuery, listRows, type Page, resourceNamed, RESOURCES } from "./resources.ts";

/** What the API reads: the console supplies it (fakes in tests). */
export interface ApiSource {
  /** The fleet's id (OCSF tenant_uid, file names). */
  fleet: string;
  /** The console's port (the OpenAPI document's server). */
  port: number;
  /** The estate graph, with its findings. */
  estate(): Promise<Estate>;
  /** The OSCAL documents by file name (`assessment-results.json`, ...), or none without the SCF catalog. */
  oscal(): Promise<Record<string, unknown>>;
  /** The SCF catalog, when it is on this PC (the OCSF findings' framework requirements). */
  catalog?(): Promise<ScfCatalog | undefined>;
  /** The directory that holds this PC's evidence bundles. */
  evidenceDir: string;
}

/** The API's path prefix. */
export const API_PREFIX = "/v1/";

/** A safe evidence bundle file name: no separators, no leading dot, a .zip. */
export const BUNDLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.zip$/;

const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** A JSON response. */
export function apiJson(body: unknown, status = 200, type = "application/json"): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": type, ...HEADERS },
  });
}

/** An error, as JSON. */
export function apiError(status: number, error: string, headers: HeadersInit = {}): Response {
  const r = apiJson({ error }, status);
  for (const [k, v] of new Headers(headers)) r.headers.set(k, v);
  return r;
}

/** The answer to a request without a signed-in session. */
export function apiUnauthorized(): Response {
  return apiError(
    401,
    "sign in first: open the launch link `bun run stolos console` prints; the API answers the console's session (its cookie)",
  );
}

/** The evidence list's paging (it has no columns to filter on). */
const paging = (params: URLSearchParams): ReturnType<typeof listQuery> =>
  listQuery({ name: "evidence", kind: "view", doc: "", columns: [], order: [] }, params);

/** Every evidence bundle in a directory, newest first. */
export async function evidenceBundles(
  dir: string,
): Promise<Array<{ name: string; size: number; modified: string | null; href: string }>> {
  const out = [];
  try {
    for await (const e of fs.readDir(dir)) {
      if (!e.isFile || !BUNDLE_NAME.test(e.name)) continue;
      const st = await fs.lstat(paths.join(dir, e.name));
      if (!st.isFile) continue;
      out.push({
        name: e.name,
        size: st.size,
        modified: st.mtime ? st.mtime.toISOString() : null,
        href: `${API_PREFIX}evidence/${e.name}`,
      });
    }
  } catch (x) {
    if (!(x instanceof errors.NotFound)) throw x;
  }
  return out.sort(
    (a, b) => (b.modified ?? "").localeCompare(a.modified ?? "") || a.name.localeCompare(b.name),
  );
}

/** A finding row as the evidence OCSF's mapping reads (spec 089). */
function findingEvidence(row: Record<string, unknown>, fleet: string): Evidence {
  return {
    scf: [cell(row["scf_control"]) ?? ""],
    subject: cell(row["subject_uid"]) ?? fleet,
    source: "estate",
    check: cell(row["policy_id"]) ?? "",
    status: (cell(row["status"]) ?? "") as PolicyResult["status"],
    detail: cell(row["detail"]) ?? "",
    ...((fix) => (fix === undefined ? {} : { fix }))(cell(row["fix"])),
  };
}

/** A database cell as text, or undefined where it is null. */
function cell(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

const wantsOcsf = (req: Request, params: URLSearchParams): boolean =>
  params.get("format") === "ocsf" ||
  (params.get("format") === null &&
    (req.headers.get("accept") ?? "")
      .split(",")
      .some((t) => (t.trim().split(";")[0] ?? "").toLowerCase() === OCSF_MEDIA_TYPE));

async function answer(req: Request, url: URL, src: ApiSource): Promise<Response> {
  const path = url.pathname === "/v1" ? API_PREFIX : url.pathname;
  const rest = path.slice(API_PREFIX.length);
  const params = url.searchParams;
  if (rest === "") {
    return apiJson({
      version: VERSION,
      openapi: `${API_PREFIX}openapi.json`,
      resources: RESOURCES.map((r) => ({
        name: r.name,
        kind: r.kind,
        doc: r.doc,
        href: `${API_PREFIX}${r.name}`,
      })),
      oscal: OSCAL_DOCUMENTS.map((d) => `${API_PREFIX}oscal/${d}`),
      evidence: `${API_PREFIX}evidence/`,
    });
  }
  if (rest === "openapi.json") return apiJson(openApiDocument({ port: src.port }));
  if (rest.startsWith("oscal/")) {
    const name = rest.slice("oscal/".length).replace(/\.json$/, "");
    if (!OSCAL_DOCUMENTS.includes(name)) {
      return apiError(404, `no such OSCAL document (${OSCAL_DOCUMENTS.join(", ")})`);
    }
    const docs = await src.oscal();
    const doc = docs[`${name}.json`];
    if (!doc) {
      return apiError(
        404,
        "the OSCAL documents need the SCF catalog on this PC: bun run stolos compliance --download",
      );
    }
    return apiJson(doc);
  }
  if (rest === "evidence" || rest === "evidence/") {
    const q = paging(params);
    if ("error" in q) return apiError(400, q.error);
    const all = await evidenceBundles(src.evidenceDir);
    const page: Page = {
      items: all.slice(q.offset, q.offset + q.limit),
      limit: q.limit,
      offset: q.offset,
      total: all.length,
    };
    return apiJson(page);
  }
  if (rest.startsWith("evidence/")) {
    let name: string;
    try {
      name = decodeURIComponent(rest.slice("evidence/".length));
    } catch {
      return apiError(400, "not a bundle's file name");
    }
    if (!BUNDLE_NAME.test(name) || name.includes("..")) {
      return apiError(400, "not a bundle's file name (letters, digits, . - _, ending in .zip)");
    }
    const listed = (await evidenceBundles(src.evidenceDir)).find((b) => b.name === name);
    if (!listed) return apiError(404, `no evidence bundle ${name} on this PC`);
    const file = await fs.open(paths.join(src.evidenceDir, name), { read: true });
    return new Response(file.readable, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(listed.size),
        "content-disposition": `attachment; filename="${name}"`,
        ...HEADERS,
      },
    });
  }
  const r = resourceNamed(rest);
  if (!r) return apiError(404, `no such resource: ${rest} (GET ${API_PREFIX} lists them)`);
  const format = params.get("format");
  if (format !== null && format !== "json" && !(format === "ocsf" && r.name === "finding")) {
    return apiError(400, r.name === "finding" ? "format is json or ocsf" : "format is json");
  }
  const q = listQuery(r, params);
  if ("error" in q) return apiError(400, q.error);
  const e = await src.estate();
  const page = listRows(e, r, q);
  if (r.name === "finding" && wantsOcsf(req, params)) {
    const catalog = await src.catalog?.();
    return apiJson(
      {
        ...page,
        items: page.items.flatMap((row) =>
          complianceFindings(findingEvidence(row, src.fleet), {
            now: new Date(Date.parse(cell(row["observed_at"]) ?? "") || Date.now()),
            fleet: src.fleet,
            ...(catalog ? { catalog } : {}),
          }),
        ),
      },
      200,
      OCSF_MEDIA_TYPE,
    );
  }
  return apiJson(page);
}

/** The API's answer to a request from a signed-in session (GET and HEAD only). */
export async function apiHandler(req: Request, src: ApiSource): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return apiError(405, "the API is read-only: GET and HEAD", { allow: "GET, HEAD" });
  }
  let r: Response;
  try {
    r = await answer(req, new URL(req.url), src);
  } catch (e) {
    ui.say(
      `api: ${new URL(req.url).pathname}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    r = apiError(500, `${(e as Error).message} (the console's terminal has the details)`);
  }
  if (req.method === "HEAD") {
    await r.body?.cancel();
    return new Response(null, { status: r.status, headers: r.headers });
  }
  return r;
}
