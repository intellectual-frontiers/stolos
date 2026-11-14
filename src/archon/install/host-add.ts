/**
 * `stolos host add` (spec 004): write the host's model, give it its own
 * GitHub deploy key (read-only access to this repository (spec 048); the private half
 * stays in the boot machine's secret store), and arm it for one install.
 *
 * @module
 */

import { P, repoRel } from "../core/paths.ts";
import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { armHost, SECRETS, writeSecret } from "../core/secrets.ts";
import { ensureDir } from "../core/fsx.ts";
import { hostFile, loadFleet } from "../model/load.ts";
import { BOOT_PORT, bootUri, lanAddresses } from "../core/net.ts";
import { ensureHostKeys } from "./host-keys.ts";
import type { DiskDef } from "../model/types.ts";

/** What stolos host add is given. */
export interface HostAddOptions {
  /** The host's name. */
  name: string;
  /** Spec 051: exactly one of claim and macAddress (see recognize.ts). */
  claim?: boolean;
  /** Its network card (instead of --claim). */
  macAddress?: string;
  /** The host's name again: its install may erase disks that are not blank. */
  confirmDestroy?: string;
  /** The install disk. */
  disk?: DiskDef["match"];
  /** Ubuntu's guided layout. */
  layout?: DiskDef["layout"];
  /** Skip the GitHub deploy key (tests, or a host that should not push). */
  noDeployKey?: boolean;
  /** Rewrite an existing host.ts. */
  force?: boolean;
  /** Build, commit, and push the new model (default true; --no-push leaves it). */
  push?: boolean;
}

/** host.ts as host add writes it. */
export function hostSource(o: { name: string; disk: DiskDef }): string {
  return `// Host ${o.name} (spec 004). Written by \`stolos host add\`; edit freely, then
// \`stolos build\`. Capabilities come from foundation(); add more per spec.

import type { HostDef } from "@stolos/archon/model/types.ts";
import { foundation } from "@stolos/archon/capabilities/mod.ts";
import { PRIME } from "@stolos/archon/pg/config.ts";

export const host: HostDef = {
  name: ${JSON.stringify(o.name)},
  arch: "amd64",
  disk: { match: ${JSON.stringify(o.disk.match)}, layout: ${JSON.stringify(o.disk.layout)} },
  capabilities: foundation(),
  // Specs 038, 039: PostgreSQL 18 "prime" (off until an operator runs archon pg on).
  pg: { instances: [PRIME] },
  spec: "004-install",
};
`;
}

/** Create (once) the host's ed25519 deploy key with the OpenSSH that ships with Windows and Ubuntu. */
export async function ensureDeployKey(host: string): Promise<string> {
  const key = SECRETS.deployKey(host);
  if (!(await exists(key))) {
    // ssh-keygen writes into a private temporary folder; writeSecret stores
    // both halves (spec 029: every secret write is recorded for the vault).
    const tmp = await Deno.makeTempDir({ prefix: "archon-key-" });
    try {
      const r = await run([
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        `archon-${host}`,
        "-f",
        join(tmp, "key"),
      ]);
      if (!r.ok) throw new Error(`ssh-keygen failed: ${(r.stderr || r.stdout).trim()}`);
      await writeSecret(key, await Deno.readTextFile(join(tmp, "key")));
      await writeSecret(SECRETS.deployKeyPub(host), await Deno.readTextFile(join(tmp, "key.pub")));
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  }
  return (await readTextOr(SECRETS.deployKeyPub(host)))!.trim();
}

/** Register the key on the repository (read-only, spec 048), replacing an older key for this host. */
export async function registerDeployKey(slug: string, host: string, pub: string): Promise<string> {
  const title = `archon host ${host}`;
  const list = await run(["gh", "api", `repos/${slug}/keys`, "--paginate"]);
  if (!list.ok) throw new Error(`gh could not list deploy keys: ${list.stderr.trim()}`);
  const keys = JSON.parse(list.stdout || "[]") as Array<{ id: number; key: string; title: string }>;
  const bare = pub.split(" ").slice(0, 2).join(" ");
  if (keys.some((k) => k.key === bare)) return "already registered";
  for (const k of keys.filter((k) => k.title === title)) {
    await run(["gh", "api", "-X", "DELETE", `repos/${slug}/keys/${k.id}`]);
  }
  const add = await run([
    "gh",
    "api",
    `repos/${slug}/keys`,
    "-f",
    `title=${title}`,
    "-f",
    `key=${bare}`,
    "-F",
    "read_only=true",
  ]);
  if (!add.ok) {
    throw new Error(
      `gh could not add the deploy key: ${add.stderr.trim()} (you need admin rights on ${slug})`,
    );
  }
  return "registered";
}

/** stolos host add: the model, the registration, the deploy key, and one armed install. */
export async function hostAdd(o: HostAddOptions): Promise<number> {
  const fleet = await loadFleet();
  const name = o.name.trim().toLowerCase();
  const file = hostFile(name);
  // Spec 051: refused before anything is written.
  const { recognition, describeRecognition, CLAIM_MINUTES } = await import("./recognize.ts");
  const how = recognition(name, {
    claim: o.claim,
    macAddress: o.macAddress,
    command: "deno task stolos host add",
  });
  const c = ui.phase("Recognition");
  if ("refusal" in how) {
    c.fail(how.refusal, undefined, "E051-NO-RECOGNITION");
    return ui.finish();
  }
  const { destroyRefusal } = await import("../../archon-boot/reinstall.ts");
  if (o.confirmDestroy !== undefined) {
    const no = destroyRefusal(name, undefined, o.confirmDestroy);
    if (no) {
      c.fail(no);
      return ui.finish();
    }
  }
  const mac = how.kind === "mac" ? how.mac : undefined;
  c.done(
    describeRecognition(name, how) +
      (o.confirmDestroy ? "; its install may erase disks that are not blank" : ""),
  );
  // Spec 053: what this host will need from the fleet, said before it is armed.
  const { loadSigners } = await import("../identity/signers.ts");
  if (!(await loadSigners().catch(() => [])).some((x) => x.role === "daily")) {
    c.warn(
      `the fleet has no daily signer: ${name} will install, but refuse every change after`,
      "deno task stolos signers add <your name> --role daily --key <your public key file>",
      "E047-NO-SIGNERS",
    );
  }
  const m = ui.phase("Host model");
  if ((await exists(file)) && !o.force) {
    m.done(`fleets/${P.fleetId}/hosts/${name}/host.ts exists (kept; --force rewrites it)`);
  } else {
    await ensureDir(join(P.hosts, name));
    const disk: DiskDef = { match: o.disk ?? "largest", layout: o.layout ?? "lvm" };
    await Deno.writeTextFile(file, hostSource({ name, disk }));
    m.done(`fleets/${P.fleetId}/hosts/${name}/host.ts · ${disk.layout} on ${disk.match} disk`);
  }

  const k = ui.phase("Deploy key");
  if (o.noDeployKey) k.done("skipped (--no-deploy-key)");
  else {
    k.status("creating the host's key");
    const pub = await ensureDeployKey(name);
    k.status(`registering it on ${fleet.repository.slug}`);
    const how = await registerDeployKey(fleet.repository.slug, name, pub);
    k.done(`${how} on ${fleet.repository.slug} (read-only) · private key on this machine only`);
  }

  const hk = ui.phase("SSH identity");
  const keys = await ensureHostKeys(name);
  // Spec 047: who the host is, in Git: its public keys (operators trust these), its card, its deploy key.
  const { writeRegistration, loadRegistration } = await import("../fleet/registration.ts");
  const deployPub = await readTextOr(SECRETS.deployKeyPub(name));
  const fingerprint = deployPub
    ? (await run(["ssh-keygen", "-lf", "-"], { stdin: deployPub })).stdout.split(/\s+/)[1]
    : undefined;
  const before = await loadRegistration(name);
  const regFile = await writeRegistration(name, {
    sshHostKeys: keys.map((k) => k.public),
    // Spec 051: a MAC a person gave, or the one its machine reported (kept with --claim).
    ...(mac
      ? { mac, macSource: "operator" as const }
      : before?.mac
      ? { mac: before.mac, ...(before.macSource ? { macSource: before.macSource } : {}) }
      : {}),
    ...(fingerprint ? { deployKey: fingerprint } : {}),
    added: before?.added ?? new Date().toISOString().slice(0, 10),
  });
  hk.done(
    `${
      keys.map((k) => k.type).join(", ")
    } host keys; private halves on this machine only, public halves in ${regFile}`,
  );

  const a = ui.phase("Install");
  await armHost(name, how.kind === "claim" ? CLAIM_MINUTES : 0, mac, {
    confirmDestroy: o.confirmDestroy === name,
  });
  // Spec 025: a new host, to the shared mailbox (from the boot machine).
  const { notify } = await import("../notify/events.ts");
  await notify({
    event: `host added: ${name}`,
    what:
      `Host ${name} was added to the fleet (fleets/${P.fleetId}/hosts/${name}/host.ts) and armed for one install.`,
    todo: `Install it: network-boot it while the boot server runs (deno task stolos boot serve).`,
    key: `host-add:${name}`,
  });
  const uri = bootUri(lanAddresses()[0] ?? "<this-pc>", BOOT_PORT, name);
  a.done(`${name} is armed for one install`);
  // The install clones main: the new host's model must be there first.
  const { publishChange } = await import("./publish.ts");
  const published = o.push !== false &&
    await publishChange([repoRel(file), regFile], `004-install: add host ${name}`);
  ui.next.push(
    ...(published ? [] : [
      `next: deno task stolos apply -m "004-install: add host ${name}"`,
    ]),
    "then: deno task stolos boot serve (leave it running)",
    how.kind === "claim"
      ? `then: within ${CLAIM_MINUTES} minutes, power on ${name}'s machine and let it network-boot (re-open the window: deno task stolos boot arm ${name} --claim)`
      : `then: power on ${name}; it network-boots and is recognized by its network card (${mac})`,
    `  or, for UEFI HTTP Boot with a Boot URI field: ${uri}`,
  );
  return ui.finish();
}

/** Spec 045 (retire): remove the host's deploy key from the repository; how many were removed. */
export async function removeDeployKey(slug: string, host: string): Promise<number> {
  const title = `archon host ${host}`;
  const list = await run(["gh", "api", `repos/${slug}/keys`, "--paginate"]);
  if (!list.ok) throw new Error(`gh could not list deploy keys: ${list.stderr.trim()}`);
  const keys = JSON.parse(list.stdout || "[]") as Array<{ id: number; title: string }>;
  let n = 0;
  for (const k of keys.filter((k) => k.title === title)) {
    const del = await run(["gh", "api", "-X", "DELETE", `repos/${slug}/keys/${k.id}`]);
    if (!del.ok) throw new Error(`gh could not delete deploy key ${k.id}: ${del.stderr.trim()}`);
    n++;
  }
  return n;
}
