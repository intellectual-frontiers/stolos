/**
 * Spec 092: `stolos export <kind> [--out <file>]` gathers what the kind
 * needs from this PC (the estate graph from the fleet repository, the
 * compliance view, an evidence bundle) and writes one document, by default
 * to this PC's state directory, `export/`. Without a kind (or with `rdf`) it
 * is the RDF export it always was (specs 002 and 014).
 *
 * @module
 */

import { ui } from "../core/ui.ts";
import { join } from "../core/path.ts";
import { P } from "../core/paths.ts";
import { VERSION } from "../version.ts";
import { buildExports, EXPORT_KINDS, type ExportInput, isExportKind } from "./exports.ts";
import { type BundleInfo, bundleInfo } from "./intoto.ts";

/** The newest evidence bundle in this PC's state directory, if any. */
export async function newestBundle(): Promise<string | undefined> {
  const dir = join(P.state, "evidence");
  const found: Array<{ path: string; mtime: number }> = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".zip")) continue;
      const path = join(dir, e.name);
      found.push({ path, mtime: (await Deno.stat(path)).mtime?.getTime() ?? 0 });
    }
  } catch (x) {
    if (!(x instanceof Deno.errors.NotFound)) throw x;
  }
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.path;
}

/** The fleet signer whose key Git signs with on this PC, if it is one. */
async function mySigner(): Promise<string | undefined> {
  try {
    const { run } = await import("../core/exec.ts");
    const { loadSigners } = await import("../identity/signers.ts");
    const { keyPaths, pubOf } = await import("../identity/keys.ts");
    const key = keyPaths(
      (await run(["git", "-C", P.repo, "config", "user.signingkey"])).stdout.trim(),
    ).daily;
    const pub = pubOf(await Deno.readTextFile(key + ".pub").catch(() => undefined));
    if (!pub) return undefined;
    return (await loadSigners()).find((s) =>
      s.key.trim().split(/\s+/).slice(0, 2).join(" ") === pub
    )?.name;
  } catch {
    return undefined;
  }
}

/** `stolos export [kind] [--out <file>] [--bundle <zip>] [--entities]`. */
export async function exportCommand(
  kind: string | undefined,
  o: { out?: string; bundle?: string; entities?: boolean } = {},
): Promise<number> {
  if (!kind || kind === "rdf") {
    const { exportRdf } = await import("../model/export.ts");
    for (const f of await exportRdf()) console.log(f);
    return 0;
  }
  const p = ui.phase("Export");
  if (!isExportKind(kind)) {
    p.fail(`no export ${kind}`, `one of: rdf, ${EXPORT_KINDS.join(", ")}`);
    return 1;
  }
  const { pcFacts } = await import("../console/pc.ts");
  const f = await pcFacts();
  if (!f.fleet.id) {
    p.fail("no fleet chosen", "deno task stolos fleet use <id>");
    return 1;
  }
  const input: ExportInput = { fleet: f.fleet, now: new Date() };
  const needsView = kind !== "intoto-statement";
  if (needsView) {
    const { loadScf } = await import("../compliance/catalog.ts");
    const { complianceView, fleetEvidence } = await import("../compliance/report.ts");
    const catalog = await loadScf();
    input.view = complianceView(fleetEvidence(f), catalog);
    if (catalog) input.catalog = catalog;
  }
  if (kind === "ocsf-jsonl" || kind === "otlp-json") {
    try {
      const { loadEstate } = await import("../estate/commands.ts");
      input.estate = await loadEstate();
    } catch (e) {
      p.warn(`the estate graph: ${(e as Error).message}`, "deno task stolos estate build");
    }
    if (o.entities) input.entityEvents = true;
  }
  if (kind.startsWith("oscal-")) {
    const { loadNist } = await import("../compliance/catalog.ts");
    const nist = await loadNist("nist80053");
    if (nist) input.nistTitles = nist.titles;
    input.machines = f.machines.filter((m) => m.kind !== "discovered");
  }
  if (kind === "intoto-statement" || kind === "cyclonedx-attestation") {
    const file = o.bundle ?? (kind === "intoto-statement" ? await newestBundle() : undefined);
    if (file) {
      let b: BundleInfo;
      try {
        b = await bundleInfo(file, await Deno.readFile(file));
      } catch (e) {
        p.fail(`${file}: ${(e as Error).message}`);
        return 1;
      }
      input.bundle = b;
      p.ok(`evidence bundle ${file}`);
    }
    if (kind === "cyclonedx-attestation" && !input.bundle) {
      const me = await mySigner();
      if (me) input.signer = me;
    }
  }
  let doc;
  try {
    doc = await buildExports(kind, input);
  } catch (e) {
    p.fail(
      (e as Error).message,
      kind === "intoto-statement"
        ? "deno task stolos evidence export --from <date> --to <date>, or --bundle <zip>"
        : "",
    );
    return 1;
  }
  const out = o.out ?? join(P.state, "export", doc.fileName);
  await Deno.mkdir(join(out, ".."), { recursive: true });
  await Deno.writeFile(out, doc.bytes);
  p.done(`${out} (${doc.mediaType}, ${doc.bytes.length} bytes, Stolos ${VERSION})`);
  return 0;
}
