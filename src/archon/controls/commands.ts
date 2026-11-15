/**
 * Spec 078: `stolos controls list | run | test`, on the controller PC: the
 * fleet's control packs, listed, run now, or tested with `deno test`.
 *
 * @module
 */

import { ui } from "../core/ui.ts";
import { P } from "../core/paths.ts";
import type { FleetInputs, PackRun } from "./run.ts";

const fail = (): number => ui.problems.some((x) => x.level === "fail") ? 1 : 0;

/** What the fleet's packs read: the estate graph, and the observations in Git (each part on its own). */
export async function fleetPackInputs(): Promise<Omit<FleetInputs, "live" | "only">> {
  const warn = (what: string) => (e: unknown) => {
    ui.phase("Controls").warn(`${what}: ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  };
  const { loadAdopted } = await import("../adopt/adopt.ts");
  const { loadDevices } = await import("../device/device.ts");
  const { loadObservations } = await import("../connect/commands.ts");
  const { loadEstate } = await import("../estate/commands.ts");
  const estate = await loadEstate().catch(warn("the estate graph"));
  return {
    ...(estate ? { estate } : {}),
    adopted: (await loadAdopted().catch(warn("adopted machines"))) ?? [],
    devices: (await loadDevices().catch(warn("devices"))) ?? [],
    connectors: ((await loadObservations().catch(warn("observations"))) ?? []).map((o) => ({
      connector: o.provider,
      observed: o,
    })),
  };
}

/** `stolos controls list`: each pack and its controls. */
export async function controlsList(json = false): Promise<number> {
  const { loadControlPacks, controlsDir } = await import("./run.ts");
  const { packs, problems } = await loadControlPacks();
  if (json) {
    console.log(JSON.stringify(
      packs.map(({ pack }) => ({
        id: pack.id,
        title: pack.title,
        version: pack.version,
        controls: pack.controls.map((c) => ({
          id: c.id,
          title: c.title,
          subject: c.subject === "observation" ? `observation (${c.of})` : c.subject,
          scf: c.scf,
        })),
      })),
      null,
      2,
    ));
    return problems.length ? 1 : 0;
  }
  const p = ui.phase("Controls");
  for (const x of problems) p.fail(x, "fix the pack, then deno task stolos controls test");
  const { table } = await import("../state/query.ts");
  for (const { pack } of packs) {
    console.log(`\n${pack.title} (${pack.id} ${pack.version})`);
    console.log(table(pack.controls.map((c) => ({
      control: `${pack.id}/${c.id}`,
      subject: c.subject === "observation" ? `observation (${c.of})` : c.subject,
      scf: c.scf.join(" "),
      title: c.title,
    }))));
  }
  p.done(
    packs.length
      ? `${packs.length} pack(s), ${
        packs.reduce((n, x) => n + x.pack.controls.length, 0)
      } control(s)`
      : `no packs in ${controlsDir()}`,
  );
  if (!packs.length) {
    ui.next.push("add one: fleets/<fleet>/controls/<pack>/pack.ts (stolos docs controls)");
  }
  return fail();
}

/** `stolos controls run [pack]`: run every pack now (osquery controls ask the adopted machines). */
export async function controlsRun(only?: string, json = false): Promise<number> {
  const { runFleetPacks } = await import("./run.ts");
  const { runs, problems } = await runFleetPacks({
    ...(await fleetPackInputs()),
    live: true,
    ...(only ? { only } : {}),
  });
  const failing = (rs: PackRun[]) => rs.some((r) => r.results.some((x) => x.status === "fail"));
  if (json) {
    console.log(JSON.stringify({ runs, problems }, null, 2));
    return problems.length || failing(runs) ? 1 : 0;
  }
  const p = ui.phase("Controls");
  for (const x of problems) p.fail(x);
  const { table } = await import("../state/query.ts");
  for (const r of runs) {
    console.log(`\n${r.pack.title} (${r.pack.id} ${r.pack.version})`);
    if (r.results.length) {
      console.log(table(r.results.map((x) => ({
        control: x.id,
        subject: x.subject,
        status: x.status,
        detail: x.detail,
      }))));
    }
    for (const x of r.results.filter((x) => x.status === "fail")) {
      p.fail(`${x.id} on ${x.subject}: ${x.detail}`, x.fix);
    }
  }
  const all = runs.flatMap((r) => r.results);
  p.done(
    `${runs.length} pack(s): ${all.filter((x) => x.status === "pass").length} pass, ${
      all.filter((x) => x.status === "fail").length
    } fail, ${all.length} result(s); they show in deno task stolos compliance`,
  );
  return fail();
}

/** `stolos controls test`: run the packs' tests (deno test) in the fleet repository. */
export async function controlsTest(): Promise<number> {
  const { controlsDir } = await import("./run.ts");
  const { exists } = await import("../core/fsx.ts");
  const dir = controlsDir();
  if (!(await exists(dir))) {
    ui.phase("Controls").done(`no packs in ${dir}`);
    return 0;
  }
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["test", "-A", dir],
    cwd: P.repo,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return r.code;
}
