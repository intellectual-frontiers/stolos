/**
 * Spec 067 (clouds): `stolos cloud connect | observe | check | assets | disconnect`.
 * Read-only visibility into the fleet's cloud accounts; managing them is out of scope.
 *
 * @module
 */

import { exists } from "../core/fsx.ts";
import { dirname, join, toFileUrl } from "../core/path.ts";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { aws } from "./aws.ts";
import {
  type CloudAsset,
  cloudCredPath,
  cloudFile,
  type CloudObserved,
  type CloudProvider,
  cloudSource,
  type Http,
  realHttp,
} from "./cloud.ts";
import { cloudflare } from "./cloudflare.ts";
import { hetzner } from "./hetzner.ts";
import { microsoft } from "./microsoft.ts";

/** Every provider, in the fleet's order of importance. */
export const CLOUDS: CloudProvider[] = [cloudflare, microsoft, aws, hetzner];

const fail = (): number => ui.problems.some((x) => x.level === "fail") ? 1 : 0;

function provider(id: string): CloudProvider | undefined {
  return CLOUDS.find((c) => c.id === id);
}

function unknown(id: string): number {
  ui.phase("Cloud").fail(`no cloud ${id}`, `one of: ${CLOUDS.map((c) => c.id).join(", ")}`);
  return fail();
}

/** Each provider's last observation, from the fleet repository. */
export async function loadClouds(): Promise<CloudObserved[]> {
  const out: CloudObserved[] = [];
  for (const c of CLOUDS) {
    const f = cloudFile(c.id);
    if (await exists(f)) {
      out.push((await import(toFileUrl(f).href + `?t=${Date.now()}`)).observed as CloudObserved);
    }
  }
  return out;
}

/** Mark the assets that belong to a fleet machine: a DNS record or server named after it. */
export function joinFleet(o: CloudObserved, machines: string[], domain?: string): CloudObserved {
  const names = new Set(machines);
  const assets = o.assets.map((a): CloudAsset => {
    const label = a.name.split(".")[0];
    const inDomain = !domain || a.kind !== "dns-record" || a.name === `${label}.${domain}` ||
      a.name.endsWith(`.${domain}`);
    const hit = ["dns-record", "server", "ec2-instance", "azure-resource"].includes(a.kind) &&
      names.has(label) && inDomain;
    return hit ? { ...a, fleetMachine: label } : a;
  });
  return { ...o, assets };
}

async function readCred(id: string): Promise<Record<string, string> | undefined> {
  const { readSecret } = await import("../core/secrets.ts");
  const t = await readSecret(cloudCredPath(id));
  return t ? JSON.parse(t) : undefined;
}

async function fleetNames(): Promise<{ names: string[]; domain?: string }> {
  const { loadFleet, loadHosts } = await import("../model/load.ts");
  const { loadAdopted } = await import("../adopt/adopt.ts");
  const hosts = await loadHosts().catch((e) => {
    console.error(`warning: hosts not loaded: ${(e as Error).message}`);
    return [];
  });
  const fleet = await loadFleet().catch((e) => {
    console.error(`warning: fleet not loaded: ${(e as Error).message}`);
    return undefined;
  });
  const adopted = (await loadAdopted()).map((a) => a.machine.name);
  return {
    names: [...hosts.map((h) => h.name), ...adopted],
    domain: (fleet as { domain?: string } | undefined)?.domain,
  };
}

/** Observe one provider and write its file; the observation, or undefined after a failure. */
async function observeOne(c: CloudProvider, http: Http): Promise<CloudObserved | undefined> {
  const p = ui.phase(c.title);
  const cred = await readCred(c.id);
  if (!cred) {
    p.done(`not connected (deno task stolos cloud connect ${c.id})`);
    return undefined;
  }
  try {
    const { names, domain } = await fleetNames();
    const o = joinFleet(await c.observe(cred, http, new Date()), names, domain);
    await Deno.mkdir(dirname(cloudFile(c.id)), { recursive: true });
    await Deno.writeTextFile(cloudFile(c.id), cloudSource(o));
    const mine = o.assets.filter((a) => a.fleetMachine).length;
    for (const g of o.gaps) p.note(`not readable: ${g}`);
    p.done(
      `${o.account}: ${o.assets.length} assets${
        mine ? `, ${mine} of them the fleet's machines` : ""
      }`,
    );
    return o;
  } catch (e) {
    p.fail(
      `${c.title} did not answer: ${(e as Error).message}`,
      `check the credential: deno task stolos cloud connect ${c.id}`,
    );
    return undefined;
  }
}

/** `stolos cloud connect <provider>`: how to make a read-only credential, then type it (hidden). */
export async function cloudConnect(id: string, http: Http = realHttp): Promise<number> {
  const c = provider(id);
  if (!c) return unknown(id);
  console.log(`\n  ${c.title}: make a read-only credential (Stolos never changes a cloud):\n`);
  c.connectHelp.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log("");
  const { readSecret } = await import("../pg/connections.ts");
  const cred: Record<string, string> = {};
  ui.pause();
  try {
    for (const f of c.fields) {
      const v = f.secret ? await readSecret(`  ${f.hint}: `) : (prompt(`  ${f.hint}:`) ?? "");
      if (!v.trim()) {
        ui.resume();
        ui.phase("Connect").fail(`no ${f.hint}`, `deno task stolos cloud connect ${id}`);
        return fail();
      }
      cred[f.name] = v.trim();
    }
  } finally {
    ui.resume();
  }
  const { writeSecret } = await import("../core/secrets.ts");
  await writeSecret(cloudCredPath(id), JSON.stringify(cred, null, 2) + "\n");
  ui.phase("Connect").done(`${c.title}: the credential is in the vault (${join("clouds", id)})`);
  const o = await observeOne(c, http);
  if (o) {
    ui.next.push(`keep the observation: deno task stolos apply -m "067-adopt: ${id} observed"`);
  }
  return fail();
}

/** `stolos cloud observe [provider]`. */
export async function cloudObserve(id?: string, http: Http = realHttp): Promise<number> {
  if (id && !provider(id)) return unknown(id);
  for (const c of CLOUDS.filter((x) => !id || x.id === id)) await observeOne(c, http);
  ui.next.push(`keep the observations: deno task stolos apply -m "067-adopt: clouds observed"`);
  return fail();
}

/** `stolos cloud check [provider] [--json]`. */
export async function cloudCheck(id?: string, json = false): Promise<number> {
  const { report } = await import("../adopt/commands.ts");
  const now = Date.now();
  const all = (await loadClouds()).filter((o) => !id || o.provider === id);
  const results = all.map((o) => ({
    provider: o.provider,
    account: o.account,
    results: provider(o.provider)!.policies(o, now),
  }));
  if (json) console.log(JSON.stringify(results, null, 2));
  else {
    if (!all.length) {
      ui.phase("Cloud").done("no cloud observed yet (deno task stolos cloud connect cloudflare)");
    }
    for (const r of results) report(`${r.provider} (${r.account})`, r.results);
  }
  return results.some((r) => r.results.some((x) => x.status === "fail")) ? 1 : 0;
}

/** `stolos cloud assets [provider] [--kind k] [--json]`: one table of everything observed. */
export async function cloudAssets(id?: string, kind?: string, json = false): Promise<number> {
  const rows = (await loadClouds())
    .filter((o) => !id || o.provider === id)
    .flatMap((o) => o.assets.map((a) => ({ provider: o.provider, ...a })))
    .filter((a) => !kind || a.kind === kind);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  const { table } = await import("../state/query.ts");
  console.log(table(rows.map((a) => ({
    provider: a.provider,
    kind: a.kind,
    name: a.name,
    where: a.where ?? "",
    fleet: a.fleetMachine ?? "",
    facts: Object.entries(a.facts ?? {}).map(([k, v]) => `${k}=${v}`).join(" ").slice(0, 60),
  }))));
  console.log(`\n${rows.length} asset(s)`);
  return 0;
}

/** `stolos cloud disconnect <provider>`: the credential goes from the vault; the last observation stays in Git. */
export async function cloudDisconnect(id: string): Promise<number> {
  const c = provider(id);
  if (!c) return unknown(id);
  const { removeSecret } = await import("../core/secrets.ts");
  await removeSecret(cloudCredPath(id));
  ui.phase("Disconnect").done(`${c.title}: the credential is gone from this PC's vault`);
  ui.next.push(
    `revoke it in ${c.title} too; the last observation stays in ${
      cloudFile(id).replace(P.repo + "/", "")
    } (delete it to forget)`,
  );
  return 0;
}
