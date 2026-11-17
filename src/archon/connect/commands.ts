/**
 * Spec 067 (clouds): `stolos connect | observe | check | assets | disconnect`.
 * Read-only visibility into the fleet's cloud accounts; managing them is out of scope.
 *
 * @module
 */
// Spec: 067-adopt
// Spec: 109-integrations-api FR-006, FR-012, FR-018

import { json, record, string } from "@intellectual-frontiers/commons/ts/kernel";
import { fs, http, path, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { aws } from "./aws.ts";
import {
  type Asset,
  type Connector,
  connectorCredPath,
  type Observation,
  observationFile,
  observationSource,
} from "./connector.ts";
import { cloudflareFamily } from "./cloudflare-integration.ts";
import { unifi } from "./unifi.ts";
import { github } from "./github.ts";
import { google } from "./google.ts";
import { bamboohr, rippling } from "./hris.ts";
import { bitbucket } from "./bitbucket.ts";
import { deel } from "./deel.ts";
import { gitlab } from "./gitlab.ts";
import { gusto } from "./gusto.ts";
import { jumpcloud } from "./jumpcloud.ts";
import { jamf } from "./jamf.ts";
import { kandji } from "./kandji.ts";
import { crowdstrike } from "./crowdstrike.ts";
import { sentinelone } from "./sentinelone.ts";
import { defender, intune } from "./microsoft-endpoint.ts";
import { justworks } from "./justworks.ts";
import { okta } from "./okta.ts";
import { jira } from "./jira.ts";
import { linear } from "./linear.ts";
import { slack } from "./slack.ts";
import { onepassword } from "./onepassword.ts";
import { bitwarden } from "./bitwarden.ts";
import { hetzner } from "./hetzner.ts";
import { microsoft } from "./microsoft.ts";
import { snyk } from "./snyk.ts";
import { tenable } from "./tenable.ts";
import { knowbe4 } from "./knowbe4.ts";
import { checkr } from "./checkr.ts";
import { gcp } from "./gcp.ts";
import { digitalocean } from "./digitalocean.ts";

/** Every provider, in the fleet's order of importance. */
export const CONNECTORS: Connector[] = [
  cloudflareFamily,
  microsoft,
  google,
  okta,
  jumpcloud,
  intune,
  defender,
  jamf,
  kandji,
  crowdstrike,
  sentinelone,
  github,
  gitlab,
  bitbucket,
  bamboohr,
  rippling,
  gusto,
  deel,
  justworks,
  jira,
  linear,
  slack,
  onepassword,
  bitwarden,
  snyk,
  tenable,
  knowbe4,
  checkr,
  aws,
  gcp,
  digitalocean,
  hetzner,
  unifi,
];

const warned = new Set<string>();

/**
 * Spec 088: the engine's connectors and the fleet's added ones
 * (`fleets/<fleet>/connectors.ts`, the connector registry). One that does
 * not load or does not suit this engine is left out, with a warning.
 */
export async function allConnectors(): Promise<Connector[]> {
  let fleetDir: string;
  try {
    fleetDir = P.fleetDir;
  } catch {
    return CONNECTORS;
  }
  const { loadRegistry } = await import("./registry.ts");
  const { VERSION } = await import("../version.ts");
  const r = await loadRegistry(
    fleetDir,
    VERSION,
    CONNECTORS.map((c) => c.id),
  );
  for (const p of r.problems.filter((p) => !warned.has(p))) {
    warned.add(p);
    ui.problem("warn", "Connectors", `added connector left out: ${p}`);
  }
  return [...CONNECTORS, ...r.connectors];
}

const fail = (): number => (ui.problems.some((x) => x.level === "fail") ? 1 : 0);

/** The live transport connectors read through: it sends their credentials, as a generic client. */
export function liveHttp(): http.Transport {
  return http.liveTransport({ credentials: "allow", userAgent: "stolos" });
}

async function provider(id: string): Promise<Connector | undefined> {
  return (await allConnectors()).find((c) => c.id === id);
}

async function unknown(id: string): Promise<number> {
  ui.phase("Cloud").fail(
    `no cloud ${id}`,
    `one of: ${(await allConnectors()).map((c) => c.id).join(", ")}`,
  );
  return fail();
}

/** Each provider's last observation, from the fleet repository. */
export async function loadObservations(): Promise<Observation[]> {
  const out: Observation[] = [];
  for (const c of await allConnectors()) {
    const f = observationFile(c.id);
    if (await fs.exists(f)) {
      const m: unknown = await import(path.toFileUrl(f).href + `?t=${Date.now()}`);
      // The file is the one `observationSource` writes: its `observed` is an Observation.
      if (typeof m === "object" && m !== null && "observed" in m)
        out.push(m.observed as Observation);
    }
  }
  return out;
}

/** Mark the assets that belong to a fleet machine: a DNS record or server named after it. */
export function joinFleet(o: Observation, machines: string[], domain?: string): Observation {
  const names = new Set(machines);
  const assets = o.assets.map((a): Asset => {
    const label = a.name.split(".")[0] ?? a.name;
    const inDomain =
      !domain ||
      a.kind !== "dns-record" ||
      a.name === `${label}.${domain}` ||
      a.name.endsWith(`.${domain}`);
    const hit =
      ["dns-record", "server", "ec2-instance", "azure-resource", "client"].includes(a.kind) &&
      names.has(label) &&
      inDomain;
    return hit ? { ...a, fleetMachine: label } : a;
  });
  return { ...o, assets };
}

async function readCred(id: string): Promise<Record<string, string> | undefined> {
  const { readSecret } = await import("../core/secrets.ts");
  const t = await readSecret(connectorCredPath(id));
  if (!t) return undefined;
  const cred = json(t, record(string));
  return cred.kind === "ok" ? { ...cred.value } : undefined;
}

async function fleetNames(): Promise<{ names: string[]; domain?: string | undefined }> {
  const { loadFleet, loadHosts } = await import("../model/load.ts");
  const { loadAdopted } = await import("../adopt/adopt.ts");
  const hosts = await loadHosts().catch((e) => {
    ui.problem("warn", "Estate", `hosts not loaded: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  });
  const fleet = await loadFleet().catch((e) => {
    ui.problem("warn", "Estate", `fleet not loaded: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  });
  const adopted = (await loadAdopted()).map((a) => a.machine.name);
  return {
    names: [...hosts.map((h) => h.name), ...adopted],
    domain: fleet?.web?.domain,
  };
}

/** Observe one provider and write its file; the observation, or undefined after a failure. */
async function observeOne(c: Connector, t: http.Transport): Promise<Observation | undefined> {
  const p = ui.phase(c.title);
  const cred = await readCred(c.id);
  if (!cred) {
    p.done(`not connected (bun run stolos connect ${c.id})`);
    ui.outcome(`${c.title}: not connected (bun run stolos connect ${c.id})`);
    return undefined;
  }
  try {
    const { names, domain } = await fleetNames();
    const o = joinFleet(await c.observe(cred, t, new Date()), names, domain);
    await fs.mkdir(path.dirname(observationFile(c.id)), { recursive: true });
    await fs.writeTextFile(observationFile(c.id), observationSource(o));
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
      `${c.title} did not answer: ${e instanceof Error ? e.message : String(e)}`,
      `check the credential: bun run stolos connect ${c.id}`,
    );
    return undefined;
  }
}

/** `stolos connect <provider>`: how to make a read-only credential, then type it (hidden). */
export async function connectorConnect(
  id: string,
  t: http.Transport = liveHttp(),
): Promise<number> {
  const c = await provider(id);
  if (!c) return await unknown(id);
  ui.say(`${c.title}: make a read-only credential (Stolos never changes a cloud):`);
  c.connectHelp.forEach((s, i) => ui.say(`${i + 1}. ${s}`));
  const { readSecret } = await import("../pg/connections.ts");
  const cred: Record<string, string> = {};
  ui.pause();
  try {
    for (const f of c.fields) {
      let v =
        f.secret && !f.file
          ? await readSecret(`  ${f.hint}: `)
          : ((await ui.ask(`  ${f.hint}:`)) ?? "");
      if (f.file && v.trim()) {
        // A key file: its content goes to the vault; delete the file after (the next line says so).
        v = await fs.readTextFile(v.trim().replace(/^["']|["']$/g, ""));
        ui.say("read it into the vault: delete that file now, so the vault is its only copy");
      }
      if (!v.trim()) {
        // Spec 109: a setting with a default may be left empty (never a secret).
        if (f.optional && !f.secret) continue;
        ui.resume();
        ui.phase("Connect").fail(`no ${f.hint}`, `bun run stolos connect ${id}`);
        return fail();
      }
      cred[f.name] = v.trim();
    }
    // Spec 109 FR-012: before the credential is kept, the connector makes sure the person trusts what it will read from.
    if (c.trust) {
      const decided = await c.trust(cred, {
        say: (line) => ui.say(line),
        ask: (q) => ui.ask(`  ${q}`),
      });
      if (!decided.ok) {
        ui.resume();
        ui.phase("Connect").fail(decided.why, `bun run stolos connect ${id}`);
        return fail();
      }
      Object.assign(cred, decided.cred);
    }
  } finally {
    ui.resume();
  }
  const { writeSecret } = await import("../core/secrets.ts");
  await writeSecret(connectorCredPath(id), JSON.stringify(cred, null, 2) + "\n");
  ui.phase("Connect").done(
    `${c.title}: the credential is in the vault (${path.join("connectors", id)})`,
  );
  const o = await observeOne(c, t);
  if (o) {
    ui.next.push(`keep the observation: bun run stolos apply -m "067-adopt: ${id} observed"`);
  }
  return fail();
}

/** `stolos estate observe [provider]`. */
export async function estateObserve(id?: string, t: http.Transport = liveHttp()): Promise<number> {
  if (id && !(await provider(id))) return await unknown(id);
  for (const c of (await allConnectors()).filter((x) => !id || x.id === id)) {
    await observeOne(c, t);
  }
  ui.next.push(`keep the observations: bun run stolos apply -m "067-adopt: clouds observed"`);
  ui.next.push("the estate graph as SQL and SQLite: bun run stolos estate build");
  return fail();
}

/** `stolos estate check [provider] [--json]`. */
export async function estateCheck(id?: string, asJson = false): Promise<number> {
  const { report } = await import("../adopt/commands.ts");
  const now = Date.now();
  const all = (await loadObservations()).filter((o) => !id || o.provider === id);
  const known = await allConnectors();
  const results = all.map((o) => ({
    provider: o.provider,
    account: o.account,
    results: known.find((c) => c.id === o.provider)?.policies(o, now) ?? [],
  }));
  // Spec 085: what no single source can say, across every source.
  const { estatePolicies } = await import("../estate/graph.ts");
  const { loadEstate } = await import("../estate/commands.ts");
  const across = id ? [] : estatePolicies(await loadEstate());
  if (asJson) {
    stdio.stdout.writeSync(
      `${JSON.stringify({ accounts: results, acrossSystems: across }, null, 2)}\n`,
    );
  } else {
    if (!all.length) {
      ui.phase("Estate").done("no account observed yet (bun run stolos connect cloudflare)");
    }
    for (const r of results) report(`${r.provider} (${r.account})`, r.results);
    if (across.length) report("across systems", across);
  }
  return [...results.flatMap((r) => r.results), ...across].some((x) => x.status === "fail") ? 1 : 0;
}

/** `stolos estate assets [provider] [--kind k] [--json]`: one table of everything observed. */
export async function estateAssets(id?: string, kind?: string, asJson = false): Promise<number> {
  const rows = (await loadObservations())
    .filter((o) => !id || o.provider === id)
    .flatMap((o) => o.assets.map((a) => ({ provider: o.provider, ...a })))
    .filter((a) => !kind || a.kind === kind);
  if (asJson) {
    stdio.stdout.writeSync(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  const { table } = await import("../state/query.ts");
  stdio.stdout.writeSync(
    `${table(
      rows.map((a) => ({
        provider: a.provider,
        kind: a.kind,
        name: a.name,
        where: a.where ?? "",
        fleet: a.fleetMachine ?? "",
        facts: Object.entries(a.facts ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
          .slice(0, 60),
      })),
    )}\n\n${rows.length} asset(s)\n`,
  );
  return 0;
}

/** `stolos disconnect <provider>`: the credential goes from the vault; the last observation stays in Git. */
export async function connectorDisconnect(id: string): Promise<number> {
  const c = await provider(id);
  if (!c) return await unknown(id);
  const { removeSecret } = await import("../core/secrets.ts");
  await removeSecret(connectorCredPath(id));
  ui.phase("Disconnect").done(`${c.title}: the credential is gone from this PC's vault`);
  ui.outcome(`${c.title}: the credential is gone from this PC's vault`);
  ui.next.push(
    `revoke it in ${c.title} too; the last observation stays in ${observationFile(id).replace(
      P.repo + "/",
      "",
    )} (delete it to forget)`,
  );
  return 0;
}
