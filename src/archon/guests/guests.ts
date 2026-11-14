/**
 * `archon guest sync|list` (spec 017): create missing LXD instances from the
 * model and start stopped ones. Never deletes (Article 11).
 *
 * @module
 */

import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import type { GuestDef, HostDef } from "../model/types.ts";

interface Instance {
  name: string;
  status: string;
  type: string;
}

export async function instances(): Promise<Instance[]> {
  const r = await run(["lxc", "list", "--format", "json"]);
  if (!r.ok) {
    throw new Error(`lxc list failed: ${r.stderr.trim()} (is LXD initialized? archon apply)`);
  }
  return (JSON.parse(r.stdout) as Instance[]).map((i) => ({
    name: i.name,
    status: i.status,
    type: i.type,
  }));
}

export function launchArgs(g: GuestDef): string[] {
  return [
    "lxc",
    "launch",
    g.image,
    g.name,
    ...(g.kind === "vm" ? ["--vm"] : []),
    ...(g.cpus ? ["-c", `limits.cpu=${g.cpus}`] : []),
    ...(g.memory ? ["-c", `limits.memory=${g.memory}`] : []),
  ];
}

export async function guestSync(host: HostDef): Promise<boolean> {
  const p = ui.phase("Guests");
  const want = host.guests ?? [];
  const have = await instances();
  let ok = true;
  for (const [i, g] of want.entries()) {
    p.step(i + 1, want.length, g.name);
    const cur = have.find((x) => x.name === g.name);
    if (!cur) {
      p.status(`launching ${g.name} (${g.image}${g.kind === "vm" ? ", VM" : ""})`);
      const r = await run(launchArgs(g));
      if (r.ok) p.change(`launched ${g.name}`);
      else {
        ok = false;
        p.fail(`lxc launch ${g.name}: ${r.stderr.trim()}`, `lxc launch ${g.image} ${g.name}`);
      }
    } else if (cur.status !== "Running") {
      const r = await run(["lxc", "start", g.name]);
      if (r.ok) p.change(`started ${g.name}`);
      else {
        ok = false;
        p.fail(`lxc start ${g.name}: ${r.stderr.trim()}`);
      }
    }
  }
  const extra = have.filter((x) => !want.some((g) => g.name === x.name)).map((x) => x.name);
  p.done(
    `${want.length} guest(s) as modeled${
      extra.length ? ` · not in the model (kept): ${extra.join(", ")}` : ""
    }`,
  );
  return ok;
}
