/**
 * Spec 083: the export package, for an auditor who works remotely or
 * offline. `stolos audit export <id>` writes one ZIP an auditor can check
 * with nothing but the package (and, by hand, `sha256sum`, `ssh-keygen`, and
 * a shell):
 *
 * | In the package | What it is |
 * | --- | --- |
 * | `bundle/<file>.zip` | the evidence bundle (spec 072), unchanged: signed, hash-chained |
 * | `repo/fleets/<fleet>/audits/<id>/engagement.ts` | the engagement, and `.commit`: the raw commit that recorded it |
 * | `repo/.../trail/<n>-<kind>.md` | each request, response, and sample, each with its `.commit` |
 * | `allowed_signers` | the fleet's signers when the package was made |
 * | `populations.json` | each control's population: units, facts, evidence items, hash |
 * | `portal.html` | the portal as one static page |
 * | `index.json` | the package's format, and every file's SHA-256 |
 * | `README.txt` | how to check it |
 *
 * Nothing in the package needs a new signature: the bundle is signed, every
 * commit is signed, and the populations and samples are computed again from
 * the bundle and the seeds. The package is not time-boxed: giving it to
 * someone is the company's decision; the portal is.
 *
 * ```mermaid
 * flowchart LR
 *   case["the engagement, checked"] --> zip["export package (ZIP)"]
 *   zip --> v["stolos audit verify: offline"]
 *   v --> b["verifyBundle"] & c["each commit: trailer and signature"] & p["populations recomputed"] & s["samples redrawn"]
 * ```
 *
 * @module
 */

import { unzipSync, zipSync } from "npm:fflate@0.8.2";
import { sha256Hex } from "../evidence/bundle.ts";
import {
  assemble,
  type AuditCase,
  type AuditParts,
  caseProblems,
  type CommittedFile,
} from "./case.ts";
import { staticPortal } from "./portal.ts";
import { SAMPLE_METHOD, SAMPLE_METHOD_DOC } from "./sample.ts";

/** The package format. */
export const PACKAGE_FORMAT = "stolos-audit-package/1";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** index.json: what the package holds. */
export interface PackageIndex {
  /** PACKAGE_FORMAT. */
  format: string;
  /** The fleet. */
  fleet: string;
  /** The engagement's id. */
  engagement: string;
  /** When it was made. */
  created: string;
  /** The Stolos version that made it. */
  stolos: string;
  /** engagement.ts's path in the repository. */
  engagementPath: string;
  /** The trail entries' paths in the repository. */
  trail: string[];
  /** The bundle's file in the package. */
  bundle?: string;
  /** Every other file's SHA-256, by its path in the package. */
  files: Record<string, string>;
}

/** The README inside a package. */
export function packageReadme(c: AuditCase): string {
  const e = c.engagement;
  return `Audit package: ${e.title} (${e.id}), ${e.firm}, ${e.period.from} to ${e.period.to}

Check it with Stolos (offline):
  deno task stolos audit verify <this zip> [--signers <the fleet's allowed_signers>]

Or by hand, in the unzipped folder:
  1. The evidence bundle: unzip bundle/*.zip and follow its README.txt (sha256sum, ssh-keygen).
  2. Each file under repo/ has a .commit beside it: the raw Git commit that recorded it.
     Its message ends with "Audit-Entry: <path> sha256:<SHA-256 of the file>"; check it with
     sha256sum. The commit's SSH signature (the gpgsig header) verifies with
     ssh-keygen -Y verify -n git against allowed_signers, as the bundle's commits do.
  3. Each control's population (populations.json) is computed from the bundle's items; the
     queries are documented in the portal (portal.html) and in Stolos's audit guide.
  4. Each sample (a trail entry of kind "sample") is redrawn from its seed:
     ${SAMPLE_METHOD}: ${SAMPLE_METHOD_DOC}
     For each unit id in populations.json:
       printf '%s\\n%s' "$SEED" "$ID" | sha256sum
     sort the keys, and take the first n.

allowed_signers is the fleet's own when the package was made: it vouches for itself. Compare
it with the fleet's signers you have from elsewhere, and pass those with --signers.
`;
}

/** populations.json's content. */
export function populationsJson(c: AuditCase): unknown {
  return {
    method: { name: SAMPLE_METHOD, doc: SAMPLE_METHOD_DOC },
    bundleHead: c.bundle?.view.manifest.head ?? null,
    controls: c.engagement.controls.map((x) => {
      const p = c.populations.get(x.id);
      return {
        control: x.id,
        population: x.population,
        hash: p?.hash ?? null,
        units: p?.units ?? [],
      };
    }),
  };
}

/** The package's bytes for a checked engagement. */
export async function buildPackage(
  c: AuditCase,
  o: { now: Date; version: string },
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, text: string | Uint8Array) =>
    files[path] = typeof text === "string" ? enc.encode(text) : text;
  const committed = (f: CommittedFile) => {
    put(`repo/${f.path}`, f.text);
    if (f.raw) put(`repo/${f.path}.commit`, f.raw);
  };
  committed(c.engagementFile);
  for (const t of c.trail) committed(t.file);
  put("allowed_signers", c.allowedSigners);
  put("populations.json", JSON.stringify(populationsJson(c), null, 2) + "\n");
  put("portal.html", staticPortal(c, o.now));
  put("README.txt", packageReadme(c));
  const bundle = c.bundle && c.engagement.bundle ? `bundle/${c.engagement.bundle.file}` : undefined;
  if (bundle) put(bundle, c.bundle!.zip);
  const hashes: Record<string, string> = {};
  for (const [p, b] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    hashes[p] = await sha256Hex(b);
  }
  const index: PackageIndex = {
    format: PACKAGE_FORMAT,
    fleet: c.fleet,
    engagement: c.engagement.id,
    created: o.now.toISOString().replace(/\.\d+Z$/, "Z"),
    stolos: o.version,
    engagementPath: c.engagementFile.path,
    trail: c.trail.map((t) => t.file.path),
    ...(bundle ? { bundle } : {}),
    files: hashes,
  };
  put("index.json", JSON.stringify(index, null, 2) + "\n");
  return zipSync(files, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") });
}

/** What checking a package found. */
export interface PackageResult {
  /** True when nothing is wrong. */
  ok: boolean;
  /** Each problem, with where it is. */
  problems: string[];
  /** The engagement, checked, when the package could be read. */
  case?: AuditCase;
}

/** Check a package, offline; `allowedSigners` replaces the package's own when given. */
export async function verifyPackage(
  zip: Uint8Array,
  o: { allowedSigners?: string } = {},
): Promise<PackageResult> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch (e) {
    return { ok: false, problems: [`not a ZIP: ${(e as Error).message}`] };
  }
  if (!files["index.json"]) return { ok: false, problems: ["no index.json"] };
  let index: PackageIndex;
  try {
    index = JSON.parse(dec.decode(files["index.json"])) as PackageIndex;
  } catch {
    return { ok: false, problems: ["index.json is not JSON"] };
  }
  if (index.format !== PACKAGE_FORMAT) {
    return { ok: false, problems: [`format ${index.format}, not ${PACKAGE_FORMAT}`] };
  }
  const problems: string[] = [];
  for (const [p, h] of Object.entries(index.files ?? {})) {
    if (!files[p]) problems.push(`${p}: missing`);
    else if ((await sha256Hex(files[p])) !== h) problems.push(`${p}: changed (its SHA-256)`);
  }
  for (const p of Object.keys(files)) {
    if (p !== "index.json" && !(p in (index.files ?? {}))) problems.push(`${p}: not in index.json`);
  }
  const file = (path: string): CommittedFile | undefined => {
    const t = files[`repo/${path}`];
    if (!t) return undefined;
    const raw = files[`repo/${path}.commit`];
    return { path, text: dec.decode(t), ...(raw ? { raw: dec.decode(raw) } : {}) };
  };
  const engagement = file(index.engagementPath);
  if (!engagement) return { ok: false, problems: [...problems, "no engagement.ts"] };
  const parts: AuditParts = {
    fleet: index.fleet,
    engagement,
    trail: (index.trail ?? []).map(file).filter((f): f is CommittedFile => !!f),
    ...(index.bundle && files[index.bundle] ? { bundle: files[index.bundle] } : {}),
    bundleMissing: "the package holds no evidence bundle",
    allowedSigners: o.allowedSigners ??
      (files["allowed_signers"] ? dec.decode(files["allowed_signers"]) : ""),
  };
  if ((index.trail ?? []).length !== parts.trail.length) problems.push("a trail entry is missing");
  let c: AuditCase;
  try {
    c = await assemble(parts);
  } catch (e) {
    return { ok: false, problems: [...problems, (e as Error).message] };
  }
  problems.push(...caseProblems(c));
  // populations.json is a convenience: it must say what the bundle says.
  try {
    const stated = JSON.parse(dec.decode(files["populations.json"] ?? enc.encode("{}"))) as {
      controls?: Array<{ control: string; hash: string | null }>;
    };
    for (const x of stated.controls ?? []) {
      const p = c.populations.get(x.control);
      if (p && p.hash !== x.hash) {
        problems.push(`populations.json: ${x.control}'s population is not the bundle's`);
      }
    }
  } catch {
    problems.push("populations.json is not JSON");
  }
  return { ok: problems.length === 0, problems, case: c };
}
