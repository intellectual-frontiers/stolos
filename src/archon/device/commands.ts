/**
 * Spec 069: `stolos device add | observe | check | remove`, on the controller PC.
 *
 * @module
 */

import { exists } from "../core/fsx.ts";
import { join } from "../core/path.ts";
import { ui } from "../core/ui.ts";
import { MACHINE_NAME } from "../adopt/adopt.ts";
import {
  DEVICE_KINDS,
  deviceCredPath,
  type DeviceDef,
  deviceDir,
  deviceObservedSource,
  devicePolicies,
  deviceSource,
  loadDevices,
  observeDevice,
} from "./device.ts";
import type { SnmpCredentials } from "./snmp.ts";

const fail = (): number => ui.problems.some((x) => x.level === "fail") ? 1 : 0;

/** How to make a read-only SNMPv3 user on common devices. */
export const SNMP_HELP = [
  "On the device's own admin page, turn on SNMPv3 and add a user for Stolos:",
  "  read-only; security level authPriv; authentication SHA-256 (or SHA); privacy AES (AES-128);",
  "  two passphrases of at least 8 characters; and allow this PC's address if it asks which may ask.",
  "Where it is on common devices:",
  "  UniFi: Settings > System > Advanced > SNMP (SNMPv3)   Synology: Control Panel > Terminal & SNMP > SNMP",
  "  HP or Brother printers: the printer's web page > Network > SNMP   pfSense/OPNsense: Services > SNMP",
  "Never SNMPv1 or v2c: their community strings travel in the clear.",
];

async function credOf(d: DeviceDef): Promise<SnmpCredentials | undefined> {
  const { readSecret } = await import("../core/secrets.ts");
  const t = await readSecret(deviceCredPath(d.name));
  if (!t) return undefined;
  const c = JSON.parse(t) as { authKey: string; privKey: string };
  return { user: d.snmp.user, auth: d.snmp.auth, authKey: c.authKey, privKey: c.privKey };
}

async function observeOne(d: DeviceDef): Promise<boolean> {
  const p = ui.phase(d.name);
  const cred = await credOf(d);
  if (!cred) {
    p.fail(
      "its SNMP passphrases are not in this PC's vault",
      `deno task stolos device add ${d.name} --address ${d.address} ... (again), or restore the vault`,
    );
    return false;
  }
  try {
    const o = await observeDevice(d, cred);
    await Deno.writeTextFile(join(deviceDir(d.name), "observed.ts"), deviceObservedSource(o));
    p.done(
      `${o.model ?? o.description.slice(0, 60)}${
        o.serial ? ` · serial ${o.serial}` : ""
      } · up ${o.uptimeDays} days`,
    );
    return true;
  } catch (e) {
    p.fail(
      `not observed: ${(e as Error).message}`,
      `is SNMPv3 on at ${d.address}${d.port ? `:${d.port}` : ""}, for this PC?`,
    );
    return false;
  }
}

/** `stolos device add <name> --address <a> --kind <k> --user <u>`: the passphrases are typed here, then it is read once. */
export async function deviceAdd(o: {
  name: string;
  address: string;
  kind: string;
  user: string;
  auth?: string;
  port?: string;
  title?: string;
  owner?: string;
  location?: string;
}): Promise<number> {
  const c = ui.phase("Device");
  if (!MACHINE_NAME.test(o.name)) {
    c.fail(
      `${o.name} is not a name (lowercase letters, digits, -)`,
      "for example: front-printer, core-switch",
    );
    return fail();
  }
  if (!(DEVICE_KINDS as readonly string[]).includes(o.kind)) {
    c.fail(`--kind ${o.kind}`, `one of: ${DEVICE_KINDS.join(", ")}`);
    return fail();
  }
  const port = o.port ? Number(o.port) : undefined;
  if (port !== undefined && !(port > 0 && port < 65536)) {
    c.fail(`--port ${o.port}`, "a UDP port, usually 161");
    return fail();
  }
  const prior = (await loadDevices()).find((x) => x.device.name === o.name)?.device;
  const d: DeviceDef = {
    name: o.name,
    kind: o.kind as DeviceDef["kind"],
    address: o.address,
    ...(port ? { port } : {}),
    ...(o.title ?? prior?.title ? { title: o.title ?? prior?.title } : {}),
    ...(o.owner ?? prior?.owner ? { owner: o.owner ?? prior?.owner } : {}),
    ...(o.location ?? prior?.location ? { location: o.location ?? prior?.location } : {}),
    snmp: { user: o.user, auth: o.auth === "sha" ? "sha" : "sha256" },
    added: prior?.added ?? new Date().toISOString(),
  };
  c.done(`${d.name}: ${d.kind} at ${d.address}${port ? `:${port}` : ""}, SNMPv3 user ${o.user}`);
  console.log("");
  for (const l of SNMP_HELP) console.log(`  ${l}`);
  console.log("");
  const { readSecret } = await import("../pg/connections.ts");
  ui.pause();
  let authKey = "", privKey = "";
  try {
    if (Deno.stdin.isTerminal()) {
      authKey = await readSecret(`  ${d.name}'s SNMPv3 authentication passphrase: `);
      privKey = await readSecret(`  ${d.name}'s SNMPv3 privacy passphrase: `);
    } else {
      // From a pipe (a script): two lines, the authentication passphrase, then the privacy one.
      [authKey = "", privKey = ""] = (await new Response(Deno.stdin.readable).text()).split(
        /\r?\n/,
      );
    }
  } finally {
    ui.resume();
  }
  if (authKey.length < 8 || privKey.length < 8) {
    ui.phase("Passphrases").fail(
      "SNMPv3 passphrases have at least 8 characters",
      `deno task stolos device add ${o.name} ... again`,
    );
    return fail();
  }
  const { writeSecret } = await import("../core/secrets.ts");
  await writeSecret(deviceCredPath(d.name), JSON.stringify({ authKey, privKey }, null, 2) + "\n");
  await Deno.mkdir(deviceDir(d.name), { recursive: true });
  await Deno.writeTextFile(join(deviceDir(d.name), "device.ts"), deviceSource(d));
  if (await observeOne(d)) {
    const { report } = await import("../adopt/commands.ts");
    const { observed } = (await loadDevices()).find((x) => x.device.name === d.name)!;
    report(d.name, devicePolicies(d, observed));
  }
  ui.next.push(`keep it: deno task stolos apply -m "069-integrate: device ${d.name}"`);
  ui.next.push("back up: deno task stolos vault backup (its passphrases are new)");
  return fail();
}

/** `stolos device observe [name]`. */
export async function deviceObserve(name?: string): Promise<number> {
  const all = (await loadDevices()).filter((x) => !name || x.device.name === name);
  if (name && !all.length) {
    ui.phase("Devices").fail(`no device ${name}`, "deno task stolos device check (lists them)");
    return fail();
  }
  if (!all.length) {
    ui.phase("Devices").done(
      "no devices yet (deno task stolos device add <name> --address <a> --kind <k> --user <u>)",
    );
  }
  for (const { device } of all) await observeOne(device);
  if (all.length) {
    ui.next.push(
      `keep the observations: deno task stolos apply -m "069-integrate: devices observed"`,
    );
  }
  return fail();
}

/** `stolos device check [name] [--json]`. */
export async function deviceCheck(name?: string, json = false): Promise<number> {
  const all = (await loadDevices()).filter((x) => !name || x.device.name === name);
  const results = all.map(({ device, observed }) => ({
    name: device.name,
    results: devicePolicies(device, observed),
  }));
  if (json) console.log(JSON.stringify(results, null, 2));
  else {
    const { report } = await import("../adopt/commands.ts");
    if (!all.length) ui.phase("Devices").done("no devices yet");
    for (const r of results) report(r.name, r.results);
  }
  return results.some((r) => r.results.some((x) => x.status === "fail")) ? 1 : 0;
}

/** `stolos device remove <name>`: its files and its passphrases go. */
export async function deviceRemove(name: string): Promise<number> {
  const p = ui.phase("Remove");
  if (!(await exists(deviceDir(name)))) {
    p.fail(`no device ${name}`, "deno task stolos device check (lists them)");
    return fail();
  }
  await Deno.remove(deviceDir(name), { recursive: true });
  const { removeSecret } = await import("../core/secrets.ts");
  await removeSecret(deviceCredPath(name));
  p.done(
    `${name}: its files and SNMP passphrases are gone (remove the SNMPv3 user on the device too)`,
  );
  ui.next.push(`keep it: deno task stolos apply -m "069-integrate: remove device ${name}"`);
  return 0;
}
