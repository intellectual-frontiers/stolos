/**
 * `archon guest sync|list` (spec 017): create missing LXD instances from the
 * model and start stopped ones, mailing the ones created (spec 025). Never deletes (Article 11).
 *
 * @module
 */
// Spec: 017-guests

import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import type { GuestDef, HostDef } from "../model/types.ts";

/** An LXD instance, as `lxc list` reports it. */
export interface Instance {
  /** The instance name. */
  name: string;
  /** LXD's status, such as "Running" or "Stopped". */
  status: string;
  /** "container" or "virtual-machine". */
  type: string;
}

/** The LXD instances on this host (lxc list); throws when lxc fails. */
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

/** The `lxc launch` command line for a guest, with its kind and CPU and memory limits. */
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

/**
 * Launches the host's missing guests and starts stopped ones; never deletes.
 * Returns false when any launch or start failed.
 */
export async function guestSync(host: HostDef): Promise<boolean> {
  const p = ui.phase("Guests");
  const want = host.guests ?? [];
  const have = await instances();
  let ok = true;
  const created: string[] = [];
  for (const [i, g] of want.entries()) {
    p.step(i + 1, want.length, g.name);
    const cur = have.find((x) => x.name === g.name);
    if (!cur) {
      p.status(`launching ${g.name} (${g.image}${g.kind === "vm" ? ", VM" : ""})`);
      const r = await run(launchArgs(g));
      if (r.ok) {
        p.change(`launched ${g.name}`);
        created.push(`${g.name} (${g.image}${g.kind === "vm" ? ", VM" : ""})`);
      } else {
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
  // Spec 017 FR-005 (spec 025): guests created are mailed. Sync never deletes one.
  if (created.length) {
    const { notify } = await import("../notify/events.ts");
    await notify(
      {
        event: `guests created: ${created.length}`,
        what: `archon guest sync created ${created.join(", ")} on ${host.name}.`,
        todo: `lxc list on ${host.name} shows them.`,
        key: `guests:created:${created.join(",")}`,
      },
      host.name,
    );
  }
  return ok;
}
