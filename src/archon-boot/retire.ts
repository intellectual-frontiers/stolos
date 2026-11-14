/**
 * `deno task stolos boot retire <host> --confirm-destroy <host>` (spec 045): a
 * server leaves the fleet, the reverse of `stolos host add`. From the boot
 * machine, with the name repeated by a person:
 *   1. asks the host, if it answers, whether it is durable (archon data), and
 *      says so before anything is removed;
 *   2. removes its DNS records in Cloudflare (<host>.<domain>, *.<host>.<domain>);
 *   3. removes its deploy key from the repository on GitHub (gh);
 *   4. forgets it on this PC: its install token, its secrets (deploy key, SSH
 *      host keys, the carried Let's Encrypt store), and its known_hosts lines;
 *   5. removes its model and its recorded state from this checkout, builds,
 *      commits, and pushes that (--no-push leaves it for you).
 * The machine itself is not touched: power it off, or install it as a new host.
 * What the router holds (its local DNS record) is the owner's to change
 * (Article 21). The vault backup keeps the old secrets until it is renewed.
 *
 * @module
 */

import { ui } from "../archon/core/ui.ts";
import { P, repoRel } from "../archon/core/paths.ts";
import { join } from "../archon/core/path.ts";
import { exists, readTextOr } from "../archon/core/fsx.ts";
import { loadTokens, readSecret, saveTokens, SECRETS } from "../archon/core/secrets.ts";
import { hostFile, loadFleet, loadServers } from "../archon/model/load.ts";
import { forgetHostKeys } from "../archon/install/host-keys.ts";
import { describeData, hostData } from "../archon/model/durable.ts";
import { parseData } from "./reinstall.ts";

/** Why retiring NAME cannot go ahead, or undefined (the name repeated, by a person). */
export function retireRefusal(
  name: string,
  confirm: string | undefined,
  agent = Deno.env.get("ARCHON_AGENT"),
): string | undefined {
  if (confirm !== undefined && agent) {
    return `--confirm-destroy is typed by a person, not an agent (${agent})`;
  }
  if (confirm === name) return undefined;
  return confirm === undefined
    ? `Retiring ${name} removes it from the fleet for good (its DNS, deploy key, SSH identity, model, and records): repeat its name with --confirm-destroy ${name}`
    : `--confirm-destroy ${confirm} does not name ${name}`;
}

/** The DNS names a server publishes (spec 032). */
export const publishedNames = (host: string, domain: string): string[] => [
  `${host}.${domain}`,
  `*.${host}.${domain}`,
];

/** The host's model is gone from this checkout but still in its last commit. */
async function removedButCommitted(name: string): Promise<boolean> {
  const rel = repoRel(hostFile(name));
  if (await exists(hostFile(name))) return false;
  const r = await new Deno.Command("git", {
    args: ["-C", P.repo, "cat-file", "-e", `HEAD:${rel}`],
    stdout: "null",
    stderr: "null",
  }).output().catch(() => ({ code: 1 }));
  return r.code === 0;
}

async function askData(target: string): Promise<string | undefined> {
  try {
    const r = await new Deno.Command("ssh", {
      args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, "archon data --json"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    return r.code === 255 ? undefined : new TextDecoder().decode(r.stdout);
  } catch {
    return undefined;
  }
}

/**
 * `deno task stolos boot retire <host> --confirm-destroy <host>`: remove a server
 * from the fleet in the steps the module describes. `push` false leaves the
 * commit for the owner to push (--no-push). Returns the exit code (2 for an
 * unknown host).
 */
export async function retire(
  name: string | undefined,
  confirm: string | undefined,
  push = true,
): Promise<number> {
  const hosts = await loadServers();
  const host = hosts.find((h) => h.name === name);
  if (name && !host && push && await removedButCommitted(name)) {
    // Run again after a retirement left uncommitted: finish it.
    ui.header("Archon retire", name);
    const refusal = retireRefusal(name, confirm);
    if (refusal) {
      ui.phase("Repository").fail(refusal);
      return ui.finish();
    }
    ui.phase("Repository").done(`${name} is already removed here; committing and pushing it`);
    const { publishChange } = await import("../archon/install/publish.ts");
    await publishChange(
      [repoRel(join(P.hosts, name))],
      `045-retire: retire ${name}`,
    );
    return ui.finish();
  }
  if (!name || !host) {
    console.error(
      `usage: deno task stolos boot retire <host> --confirm-destroy <host>  (known: ${
        hosts.map((h) => h.name).join(", ") || "none"
      })`,
    );
    return 2;
  }
  ui.header("Archon retire", name);
  const fleet = await loadFleet();
  const tokens = await loadTokens().catch(() => []);
  const addresses = tokens.find((t) => t.host === name)?.addresses ?? [];

  const d = ui.phase("Data");
  let data: { class: string; reasons: string[] } | undefined;
  for (const addr of [name, ...(host.ip ? [host.ip] : []), ...addresses]) {
    data = parseData((await askData(`${fleet.admin.user}@${addr}`))?.trim());
    if (data) break;
  }
  const recorded = hostData(host);
  const what = data
    ? (data.class === "durable"
      ? describeData({ class: "durable", reasons: data.reasons })
      : "ephemeral")
    : `not answering; its records say ${describeData(recorded)}`;
  const refusal = retireRefusal(name, confirm);
  if (refusal) {
    d.fail(`${name} is ${what}. ${refusal}`, `ssh ${name} archon data (what it holds)`);
    return ui.finish();
  }
  if (data?.class === "durable" || (!data && recorded.class === "durable")) {
    d.warn(`${name} is ${what}: its data is lost with it unless it is copied elsewhere`);
  } else d.done(`${name} is ${what}`);

  const dns = ui.phase("DNS");
  const cred = await readSecret(SECRETS.web);
  if (!fleet.web) dns.done("no web domain in the fleet: nothing published");
  else if (!cred) {
    dns.warn(
      "no Cloudflare token on this PC: its records stay",
      `remove ${publishedNames(name, fleet.web.domain).join(" and ")} in Cloudflare`,
    );
  } else {
    try {
      const { deleteRecords } = await import("../archon/web/cloudflare.ts");
      const { zoneOf } = await import("../archon/web/config.ts");
      const gone = await deleteRecords(
        (JSON.parse(cred) as { token: string }).token,
        zoneOf(fleet.web),
        publishedNames(name, fleet.web.domain),
      );
      dns.done(gone.length ? `removed ${gone.join(", ")}` : "no records to remove");
    } catch (e) {
      dns.warn(`Cloudflare: ${(e as Error).message}`, "remove the records in Cloudflare");
    }
  }

  const k = ui.phase("Deploy key");
  try {
    const { removeDeployKey } = await import("../archon/install/host-add.ts");
    const n = await removeDeployKey(fleet.repository.slug, name);
    k.done(n ? `removed from ${fleet.repository.slug}` : "none registered");
  } catch (e) {
    k.warn(
      (e as Error).message,
      `GitHub, ${fleet.repository.slug}, Settings, Deploy keys: delete "archon host ${name}"`,
    );
  }

  const pc = ui.phase("This PC");
  await saveTokens(tokens.filter((t) => t.host !== name));
  const secrets = join(P.secrets, "hosts", name);
  if (await exists(secrets)) await Deno.remove(secrets, { recursive: true });
  const forgot = await forgetHostKeys([
    name,
    ...(host.dnsName ? [host.dnsName] : []),
    ...(host.ip ? [host.ip] : []),
    ...addresses,
  ]);
  pc.done(
    `install token and secrets removed${
      forgot.length ? ` · known_hosts: ${forgot.join(", ")}` : ""
    }`,
  );

  const r = ui.phase("Repository");
  const model = join(P.hosts, name);
  if (await exists(model)) await Deno.remove(model, { recursive: true });
  // Spec 048: what this machine last heard from the host goes too.
  const { removeRecords } = await import("../archon/state/store.ts");
  await removeRecords(name).catch(() => {});
  const removed = [repoRel(model)];
  r.done(`removed ${removed.join(" and ")} from this checkout`);
  const { publishChange } = await import("../archon/install/publish.ts");
  const published = push && await publishChange(removed, `045-retire: retire ${name}`);

  const { notify } = await import("../archon/notify/events.ts");
  await notify({
    event: `${name} retired`,
    level: "warn",
    what:
      `deno task stolos boot retire ${name}: its DNS records, deploy key, install token, SSH identity, model, and records were removed (it was ${what}). The machine itself was not touched.`,
    todo: "Remove its local DNS record in the router, then its line in fleets/<fleet>/site.ts.",
    key: `retire:${name}`,
  }).catch(() => {});

  const site = (await readTextOr(join(P.fleetDir, "site.ts"))) ?? "";
  return ui.finish({
    next: [
      ...(published ? [] : [
        `build, commit, and push the removal: deno task stolos build, then git add -A ${
          removed.join(" ")
        } .mcp.json, git commit, git push`,
      ]),
      ...(host.dnsName && site.includes(host.dnsName)
        ? [
          `the router: remove the local DNS record ${host.dnsName}, then its line in fleets/<fleet>/site.ts (Article 21)`,
        ]
        : []),
      "deno task stolos vault backup  (the vault still holds its old secrets until then)",
      `the machine still runs ${name}'s install: power it off, or install it as a new host (stolos host add)`,
    ],
  });
}
