/**
 * Spec 047-intent-and-identity (Article 25): who a host is, in Git:
 * fleets/<id>/hosts/<host>/registration.ts, written by `stolos host add`, in
 * one fixed form. Its SSH host public keys are what an operator's machine
 * trusts: archon writes known_hosts.auto from them, so the first connection to
 * a host is checked against Git, never trusted on first use.
 *
 * @module
 */
// Spec: 047-intent-and-identity

import { fs, path as paths, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { lf } from "@intellectual-frontiers/commons/ts/kernel";
import { P, repoRel } from "../core/paths.ts";
import type { FleetDef, HostDef, HostRegistration } from "../model/types.ts";

const KEY = /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/;

/** fleets/<id>/hosts/<host>/registration.ts. */
export function registrationFile(host: string): string {
  return paths.join(P.hosts, host, "registration.ts");
}

/**
 * registration.ts's one form (sorted keys; checked by build), as `bun fmt` keeps it (width 100):
 * the keys on one line where they fit, else one per line.
 */
export function registrationSource(r: HostRegistration): string {
  const list = [...r.sshHostKeys].sort().map((k) => JSON.stringify(k));
  const one = `  sshHostKeys: [${list.join(", ")}],\n`;
  const keys =
    one.length <= 101 ? one : `  sshHostKeys: [\n${list.map((k) => `    ${k},\n`).join("")}  ],\n`;
  return `/**
 * Written by stolos host add (spec 047): who this host is. Public facts only.
 * Its SSH host public keys are what operators' machines trust (known_hosts.auto).
 *
 * @module
 */
import type { HostRegistration } from "@intellectual-frontiers/stolos/archon/model/types";

export default {
${keys}${r.mac ? `  mac: ${JSON.stringify(r.mac)},\n` : ""}${
    r.mac && r.macSource ? `  macSource: ${JSON.stringify(r.macSource)},\n` : ""
  }${r.deployKey ? `  deployKey: ${JSON.stringify(r.deployKey)},\n` : ""}  added: ${JSON.stringify(
    r.added,
  )},
} satisfies HostRegistration;
`;
}

/** A host's registration, or undefined. */
export async function loadRegistration(
  host: string,
  file = registrationFile(host),
): Promise<HostRegistration | undefined> {
  if (!(await fs.exists(file))) return undefined;
  const { fleetExport } = await import("../model/load.ts");
  return await fleetExport<HostRegistration>(file, "default", true);
}

/** Write a host's registration; returns its path in the repository. */
export async function writeRegistration(host: string, r: HostRegistration): Promise<string> {
  const file = registrationFile(host);
  await fs.ensureDir(paths.join(file, ".."));
  await fs.writeTextFile(file, registrationSource(r));
  return repoRel(file);
}

/** Problems with the hosts' registrations (build fails on them). */
export async function registrationProblems(
  hosts: string[],
): Promise<Array<{ where: string; message: string }>> {
  const out: Array<{ where: string; message: string }> = [];
  for (const h of hosts) {
    const file = registrationFile(h);
    const text = await fs.readTextOr(file);
    if (text === undefined) continue;
    const r = await loadRegistration(h, file);
    const where = repoRel(file);
    // Line endings are Git's business (CRLF on a Windows checkout): the form is the text.
    if (!r || lf(text) !== registrationSource(r)) {
      out.push({ where, message: "not in the form stolos host add writes" });
      continue;
    }
    if (!r.sshHostKeys.length) out.push({ where, message: "lists no SSH host key" });
    if (r.mac !== undefined && parseMac(r.mac) !== r.mac) {
      out.push({
        where,
        message: `mac ${JSON.stringify(r.mac)} is not a MAC address (aa:bb:cc:dd:ee:ff)`,
      });
    }
    for (const k of r.sshHostKeys) {
      if (!KEY.test(k)) out.push({ where, message: `not an SSH public key: ${k.slice(0, 30)}` });
    }
  }
  return out;
}

/**
 * A MAC address in any common spelling (aa:bb:cc:dd:ee:ff, AA-BB-CC-DD-EE-FF,
 * aabbccddeeff, aabb.ccdd.eeff) as lowercase with colons; undefined when it
 * is not one (spec 051: refused at once, before anything is written).
 */
export function parseMac(raw: string): string | undefined {
  const hex = raw.trim().toLowerCase().replace(/[:.-]/g, "");
  if (!/^[0-9a-f]{12}$/.test(hex)) return undefined;
  const sep = raw.trim().match(/[:.-]/g);
  // Mixed separators are a typo, not a spelling.
  if (sep && new Set(sep).size > 1) return undefined;
  return (hex.match(/../g) ?? []).join(":");
}

/** The names an operator reaches a host by. */
export function hostNames(fleet: FleetDef, h: HostDef): string[] {
  const web = fleet.web?.domain ? `${h.name}.${fleet.web.domain}` : undefined;
  return [...new Set([h.name, h.dnsName, h.ip, web].filter((x): x is string => !!x))];
}

/** known_hosts lines for every registered host (generated; never edited). */
export function knownHostsText(
  fleet: FleetDef,
  hosts: Array<HostDef & { registration?: HostRegistration }>,
): string {
  const lines = [
    "# GENERATED by archon from fleets/<id>/hosts/*/registration.ts (spec 047). Never edited.",
  ];
  for (const h of [...hosts].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const k of h.registration?.sshHostKeys ?? []) {
      lines.push(`${hostNames(fleet, h).join(",")} ${k}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** This machine's known_hosts.auto for the active fleet (in its state folder). */
export function knownHostsAutoFile(): string {
  // Root (a host's own runs) keeps it with the host's state; anyone else in
  // their own user data (a workstation's operator cannot write /var/lib/archon).
  return paths.join(
    proc.build.os !== "windows" && proc.uid() === 0 ? P.state : P.userState,
    "known_hosts.auto",
  );
}

/** Write known_hosts.auto from Git; return its path. */
export async function writeKnownHosts(): Promise<string> {
  const { loadFleet, loadHosts } = await import("../model/load.ts");
  const fleet = await loadFleet();
  const hosts = await loadHosts();
  const file = knownHostsAutoFile();
  await fs.ensureDir(paths.join(file, ".."));
  const text = knownHostsText(fleet, hosts);
  if ((await fs.readTextOr(file)) !== text) await fs.writeTextFile(file, text);
  return file;
}

/**
 * `stolos fleet trust`: put every registered host's keys from Git into this
 * user's known_hosts (for plain ssh and MCP clients), replacing older lines
 * for the same names.
 */
export async function fleetTrust(): Promise<number> {
  const { ui } = await import("../core/ui.ts");
  const { loadFleet, loadHosts } = await import("../model/load.ts");
  const { trustHost, knownHostsFile } = await import("../install/host-keys.ts");
  const fleet = await loadFleet();
  const p = ui.phase("known_hosts");
  let n = 0;
  for (const h of await loadHosts()) {
    if (!h.registration?.sshHostKeys.length) continue;
    await trustHost(
      h.name,
      hostNames(fleet, h),
      knownHostsFile(),
      h.registration.sshHostKeys.map((k) => ({ public: k })),
    );
    n++;
  }
  p.done(
    n ? `${n} host(s) trusted from Git in ${knownHostsFile()}` : "no host has a registration yet",
  );
  return ui.finish();
}
