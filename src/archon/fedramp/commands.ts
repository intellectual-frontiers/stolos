/**
 * Spec 076: `stolos compliance fedramp [--class A|B] [--out <file>]
 * [--overview <uri>]`: each FedRAMP 20x Key Security Indicator the class
 * asks for, with its status from the evidence this PC already knows, or why
 * Stolos cannot observe it; `--out` writes the Security Decision Record in
 * FedRAMP's JSON format, and `--json` prints the whole package.
 *
 * @module
 */

import { fs, stdio } from "@intellectual-frontiers/system";
import { ui } from "../core/ui.ts";

const print = (text: string): void => {
  stdio.stdout.writeSync(`${text}\n`);
};

/** Print the package for a class; with `out`, write its Security Decision Record. Exit 1 when a KSI's checks fail. */
export async function fedrampCommand(
  o: { cls?: string; out?: string; overview?: string; json?: boolean } = {},
): Promise<number> {
  const cls = (o.cls ?? "B").toUpperCase();
  if (cls !== "A" && cls !== "B") {
    ui.phase("FedRAMP 20x").fail(`no Class ${o.cls}`, "A or B");
    return 1;
  }
  if (o.overview) {
    try {
      new URL(o.overview);
    } catch {
      ui.phase("FedRAMP 20x").fail(`not a URI: ${o.overview}`, "--overview https://...");
      return 1;
    }
  }
  const { pcFacts } = await import("../console/pc.ts");
  const { loadScf } = await import("../compliance/catalog.ts");
  const { VERSION } = await import("../version.ts");
  const { fedrampPackage } = await import("./package.ts");
  const catalog = await loadScf();
  const pkg = fedrampPackage(await pcFacts(), cls, {
    ...(catalog ? { catalog } : {}),
    ...(o.overview ? { overviewUri: o.overview } : {}),
    stolosVersion: VERSION,
  });
  const failing = pkg.ksis.some((k) => k.status === "fail");
  if (o.out) {
    await fs.writeTextFile(o.out, JSON.stringify(pkg.sdr, null, 2) + "\n");
  }
  if (o.json) {
    print(JSON.stringify(pkg, null, 2));
    return failing ? 1 : 0;
  }
  const { table } = await import("../state/query.ts");
  print(
    table(
      pkg.ksis.map((k) => ({
        ksi: k.ksi.id,
        name: k.ksi.name,
        applies: k.applies,
        status: k.status,
        checks: k.tests.length,
        newest: k.observed?.newest.slice(0, 10) ?? "",
      })),
    ) + "\n",
  );
  const p = ui.phase(`FedRAMP 20x Class ${cls}`);
  for (const k of pkg.ksis.filter((x) => x.status === "fail")) {
    for (const e of k.evidence.filter((x) => x.status === "fail")) {
      p.warn(`${k.ksi.id} ${e.subject}: ${e.check} (${e.detail})`, e.fix ?? "");
    }
  }
  if (!o.overview) {
    p.warn(
      "the record names a placeholder Certification Package Overview",
      "--overview <your overview's URI>",
    );
  }
  if (o.out) p.ok(`Security Decision Record: ${o.out}`);
  p.done(
    `${pkg.counts.ksis} KSI(s): ${pkg.counts.covered} covered by Stolos's checks, ${pkg.counts.notObservable} not observable (the provider supplies them); rules ${pkg.rules.version}`,
  );
  const c = pkg.cadence;
  ui.next.push(
    `${c.machineValidation.rule} (${c.machineValidation.force}): validate machines at least every ${c.machineValidation.every?.count} ${c.machineValidation.every?.unit}; ${c.packageMaintenance.rule} (${c.packageMaintenance.force}): keep the package current every ${c.packageMaintenance.every?.count} ${c.packageMaintenance.every?.unit}`,
  );
  if (!o.out) {
    ui.next.push(
      `the record in FedRAMP's JSON format: bun run stolos compliance fedramp --class ${cls} --out sdr-class-${cls.toLowerCase()}.json`,
    );
  }
  return failing ? 1 : 0;
}
