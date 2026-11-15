/**
 * Spec 067 (clouds): `stolos connect | observe | check | assets | disconnect`.
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
  type Asset,
  type Connector,
  connectorCredPath,
  type Http,
  type Observation,
  observationFile,
  observationSource,
  realHttp,
} from "./connector.ts";
import { cloudflare } from "./cloudflare.ts";
import { github } from "./github.ts";
import { google } from "./google.ts";
import { bamboohr, rippling } from "./hris.ts";
import { okta } from "./okta.ts";
import { hetzner } from "./hetzner.ts";
import { microsoft } from "./microsoft.ts";

/** Every provider, in the fleet's order of importance. */
export const CONNECTORS: Connector[] = [
  cloudflare,
  microsoft,
  google,
  okta,
  github,
  bamboohr,
  rippling,
  aws,
  hetzner,
];

const fail = (): number => ui.problems.some((x) => x.level === "fail") ? 1 : 0;

function provider(id: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

function unknown(id: string): number {
  ui.phase("Cloud").fail(`no cloud ${id}`, `one of: ${CONNECTORS.map((c) => c.id).join(", ")}`);
  return fail();
}

/** Each provider's last observation, from the fleet repository. */
export async function loadObservations(): Promise<Observation[]> {
  const out: Observation[] = [];
  for (const c of CONNECTORS) {
    const f = observationFile(c.id);
    if (await exists(f)) {
      out.push((await import(toFileUrl(f).href + `?t=${Date.now()}`)).observed as Observation);
    }
  }
  return out;
}

/** Mark the assets that belong to a fleet machine: a DNS record or server named after it. */
export function joinFleet(o: Observation, machines: string[], domain?: string): Observation {
  const names = new Set(machines);
  const assets = o.assets.map((a): Asset => {
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
  const t = await readSecret(connectorCredPath(id));
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
async function observeOne(c: Connector, http: Http): Promise<Observation | undefined> {
  const p = ui.phase(c.title);
  const cred = await readCred(c.id);
  if (!cred) {
    p.done(`not connected (deno task stolos connect ${c.id})`);
    return undefined;
  }
  try {
    const { names, domain } = await fleetNames();
    const o = joinFleet(await c.observe(cred, http, new Date()), names, domain);
    await Deno.mkdir(dirname(observationFile(c.id)), { recursive: true });
    await Deno.writeTextFile(observationFile(c.id), observationSource(o));
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
      `check the credential: deno task stolos connect ${c.id}`,
    );
    return undefined;
  }
}

/** `stolos connect <provider>`: how to make a read-only credential, then type it (hidden). */
export async function connectorConnect(id: string, http: Http = realHttp): Promise<number> {
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
      let v = f.secret && !f.file
        ? await readSecret(`  ${f.hint}: `)
        : (prompt(`  ${f.hint}:`) ?? "");
      if (f.file && v.trim()) {
        // A key file: its content goes to the vault; delete the file after (the next line says so).
        v = await Deno.readTextFile(v.trim().replace(/^["']|["']$/g, ""));
        console.log(
          "  read it into the vault: delete that file now, so the vault is its only copy",
        );
      }
      if (!v.trim()) {
        ui.resume();
        ui.phase("Connect").fail(`no ${f.hint}`, `deno task stolos connect ${id}`);
        return fail();
      }
      cred[f.name] = v.trim();
    }
  } finally {
    ui.resume();
  }
  const { writeSecret } = await import("../core/secrets.ts");
  await writeSecret(connectorCredPath(id), JSON.stringify(cred, null, 2) + "\n");
  ui.phase("Connect").done(
    `${c.title}: the credential is in the vault (${join("connectors", id)})`,
  );
  const o = await observeOne(c, http);
  if (o) {
    ui.next.push(`keep the observation: deno task stolos apply -m "067-adopt: ${id} observed"`);
  }
  return fail();
}

/** `stolos estate observe [provider]`. */
export async function estateObserve(id?: string, http: Http = realHttp): Promise<number> {
  if (id && !provider(id)) return unknown(id);
  for (const c of CONNECTORS.filter((x) => !id || x.id === id)) await observeOne(c, http);
  ui.next.push(`keep the observations: deno task stolos apply -m "067-adopt: clouds observed"`);
  return fail();
}

/** `stolos estate check [provider] [--json]`. */
export async function estateCheck(id?: string, json = false): Promise<number> {
  const { report } = await import("../adopt/commands.ts");
  const now = Date.now();
  const all = (await loadObservations()).filter((o) => !id || o.provider === id);
  const results = all.map((o) => ({
    provider: o.provider,
    account: o.account,
    results: provider(o.provider)!.policies(o, now),
  }));
  // Spec 085: what no single source can say, across every source.
  const { estatePolicies } = await import("./estate.ts");
  const across = id ? [] : estatePolicies(await loadEstate());
  if (json) console.log(JSON.stringify({ accounts: results, acrossSystems: across }, null, 2));
  else {
    if (!all.length) {
      ui.phase("Estate").done("no account observed yet (deno task stolos connect cloudflare)");
    }
    for (const r of results) report(`${r.provider} (${r.account})`, r.results);
    if (across.length) report("across systems", across);
  }
  return [...results.flatMap((r) => r.results), ...across].some((x) => x.status === "fail") ? 1 : 0;
}

/** `stolos estate assets [provider] [--kind k] [--json]`: one table of everything observed. */
export async function estateAssets(id?: string, kind?: string, json = false): Promise<number> {
  const rows = (await loadObservations())
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

/** `stolos disconnect <provider>`: the credential goes from the vault; the last observation stays in Git. */
export async function connectorDisconnect(id: string): Promise<number> {
  const c = provider(id);
  if (!c) return unknown(id);
  const { removeSecret } = await import("../core/secrets.ts");
  await removeSecret(connectorCredPath(id));
  ui.phase("Disconnect").done(`${c.title}: the credential is gone from this PC's vault`);
  ui.next.push(
    `revoke it in ${c.title} too; the last observation stays in ${
      observationFile(id).replace(P.repo + "/", "")
    } (delete it to forget)`,
  );
  return 0;
}

/**
 * Links from accounts known by login only to people's work emails:
 * `fleets/<fleet>/estate/links.ts` exports `links`, as `{ "github:alice": "alice@example.org" }`.
 */
export async function loadLinks(): Promise<Record<string, string>> {
  const f = join(P.fleetDir, "estate", "links.ts");
  if (!(await exists(f))) return {};
  return ((await import(toFileUrl(f).href + `?t=${Date.now()}`)).links ?? {}) as Record<
    string,
    string
  >;
}

/** Spec 085: the estate graph, from every observation and the fleet's own machines. */
export async function loadEstate(): Promise<import("./estate.ts").Estate> {
  const { buildEstate } = await import("./estate.ts");
  // Accounts a system knows by login only (github:alice) are linked to people in estate/links.ts.
  const links = await loadLinks();
  const sources = (await loadObservations()).map((o) => {
    const e = o.entities ?? {};
    return {
      ...e,
      accounts: (e.accounts ?? []).map((
        a,
      ) => (a.email
        ? a
        : links[`${a.system}:${a.name}`]
        ? { ...a, email: links[`${a.system}:${a.name}`] }
        : a)
      ),
    };
  });
  const devices: import("./entities.ts").Device[] = [];
  const { loadHosts } = await import("../model/load.ts");
  for (const h of await loadHosts().catch(() => [])) {
    devices.push({ source: "stolos", id: h.name, name: h.name, managed: true, os: "Ubuntu" });
  }
  const { loadAdopted } = await import("../adopt/adopt.ts");
  for (const { machine, observed } of await loadAdopted()) {
    const enc = observed?.security.diskEncryption;
    devices.push({
      source: "adopted",
      id: machine.name,
      name: machine.name,
      managed: false,
      ...(machine.owner ? { owner: machine.owner } : {}),
      ...(observed
        ? { os: `${observed.os.name} ${observed.os.version}`.trim(), seen: observed.at }
        : {}),
      ...(observed?.os.serial ? { serial: observed.os.serial } : {}),
      ...(enc === "on" || enc === "off" ? { encrypted: enc === "on" } : {}),
    });
  }
  const { loadDevices } = await import("../device/device.ts");
  for (const { device, observed } of await loadDevices()) {
    devices.push({
      source: "snmp",
      id: device.name,
      name: device.name,
      managed: false,
      ...(device.owner ? { owner: device.owner } : {}),
      ...(observed?.model ? { os: observed.model } : {}),
      ...(observed?.serial ? { serial: observed.serial } : {}),
      ...(observed ? { seen: observed.at } : {}),
    });
  }
  return buildEstate([...sources, { devices }]);
}

/** `stolos estate query "<sql>"`: one SELECT across every source (people, accounts, devices, repositories). */
export async function estateQueryCommand(sql: string, json = false): Promise<number> {
  const { estateQuery, estateRefusal } = await import("./estate.ts");
  const why = estateRefusal(sql);
  if (why) {
    ui.phase("Query").fail(
      `refused: ${why}`,
      `for example: deno task stolos estate query "select system, name from accounts where admin = 1"`,
    );
    return 1;
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = estateQuery(await loadEstate(), sql);
  } catch (e) {
    ui.phase("Query").fail((e as Error).message, "tables: people, accounts, devices, repositories");
    return 1;
  }
  if (json) console.log(JSON.stringify(rows, null, 2));
  else {
    const { table } = await import("../state/query.ts");
    if (rows.length) console.log(table(rows));
    console.log(`\n${rows.length} row(s)`);
  }
  return 0;
}
