/**
 * Spec 067: adopted machines. Any machine reachable over SSH (macOS, Omarchy
 * and other Linux distributions, a NAS) can be adopted: Stolos knows it,
 * checks it, and can prove it, but does not own it. Nothing on it is
 * converged; a read-only probe answers for it.
 *
 * In the fleet repository, per machine:
 * - `fleets/<fleet>/adopted/<name>/machine.ts`: what you declare (how to reach
 *   it, its SSH host keys pinned at adoption, its owner, an end date);
 * - `fleets/<fleet>/adopted/<name>/observed.ts`: what the probe found last
 *   (written by Stolos; `git log -p` is its history).
 *
 * The probe key lives in the vault (`adopted/<name>/probe_key`), so every
 * backup holds it. Its line in the machine's authorized_keys runs only the
 * probe (see probe.ts).
 *
 * ```mermaid
 * flowchart LR
 *   adopt["stolos host adopt"] -->|"your own SSH, once"| install["install the probe,<br/>authorize the probe key"]
 *   observe["stolos host observe"] -->|"probe key: facts only"| m["the machine"]
 *   m --> obs["observed.ts"] --> check["stolos host check<br/>(policies, SCF controls)"]
 * ```
 *
 * @module
 */

import { errors, fs, path, proc, stdio, toError } from "@intellectual-frontiers/commons/ts/runtime";
import { compact, tsLiteral } from "@intellectual-frontiers/commons/ts/kernel";
import { run } from "../core/exec.ts";
import { P } from "../core/paths.ts";
import { ownerOnly, writeSecret } from "../core/secrets.ts";
import { authorizedLine, parseProbe, PROBE_SCRIPT, type ProbeOutput } from "./probe.ts";

/** An adopted machine, as the fleet declares it (machine.ts). */
export type AdoptedDef = {
  /** Its name in the fleet (a DNS label). */
  name: string;
  /** What it is, for people ("Shahid's MacBook Pro"). */
  title?: string;
  /** Who it belongs to (a person, a team). */
  owner?: string;
  /** How Stolos reaches it: an account and an address. */
  ssh: { user: string; address: string; port?: number };
  /** Its SSH host keys, pinned when it was adopted ("ssh-ed25519 AAAA..."). */
  hostKeys: string[];
  /** When adoption ends (YYYY-MM-DD): after it, Stolos stops observing and says so. */
  until?: string;
  /** When it was adopted (ISO time). */
  adopted: string;
  /**
   * Risks the owner accepted, each for a while: a policy that fails is shown
   * as accepted (not as passing) until the date, with who and why (for an
   * auditor). Written by `stolos host accept`.
   */
  accepted?: Acceptance[];
};

/** One accepted risk: a policy that may fail, why, who said so, and until when. */
export type Acceptance = {
  /** The policy's id (disk-encryption, firewall, ...). */
  policy: string;
  /** Why, in words an auditor reads. */
  reason: string;
  /** Who accepted it. */
  by: string;
  /** Until when (YYYY-MM-DD); after it the policy fails again. */
  until: string;
};

/** What the probe found on an adopted machine (observed.ts). */
export type Observed = {
  /** When (ISO time) and with which probe version. */
  at: string;
  /** The probe's version. */
  probe: string;
  /** The operating system. */
  os: {
    family: string;
    name: string;
    version: string;
    kernel: string;
    arch: string;
    hostname: string;
    model?: string;
    serial?: string;
    flavor?: string;
    wsl?: boolean;
  };
  /** Hardware: CPUs, memory, the root disk. */
  hardware: { cpus?: number; memoryMB?: number; diskTotalGB?: number; diskUsedPct?: number };
  /** Security settings: on, off, manual, or unknown. */
  security: {
    diskEncryption: string;
    firewall: string;
    autoUpdates: string;
    sshPasswordAuth?: string;
    /** Real-time anti-malware (Windows Defender), when the probe can tell. */
    antivirus?: string;
    admins: string[];
  };
  /** Software: the package manager, how many packages, updates waiting, osquery's version. */
  software: {
    manager?: string;
    packages?: number;
    brewPackages?: number;
    pendingUpdates?: number;
    osquery?: string;
  };
  /** TCP ports listening. */
  listening: number[];
};

const num = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : undefined;
};

/** The probe's output as an observation. */
export function toObserved(p: ProbeOutput): Observed {
  const os = p["os"] ?? {};
  const sec = p["security"] ?? {};
  const sw = p["software"] ?? {};
  const hw = p["hardware"] ?? {};
  return {
    at: p["probe"]?.["at"] ?? new Date().toISOString(),
    probe: p["probe"]?.["version"] ?? "?",
    os: {
      family: os["family"] || "unknown",
      name: os["name"] || os["family"] || "unknown",
      version: os["version"] || "",
      kernel: os["kernel"] || "",
      arch: os["arch"] || "",
      hostname: os["hostname"] || "",
      ...(os["model"] ? { model: os["model"] } : {}),
      ...(os["serial"] ? { serial: os["serial"] } : {}),
      ...(os["flavor"] ? { flavor: os["flavor"] } : {}),
      ...(os["wsl"] ? { wsl: true } : {}),
    },
    hardware: compact({
      cpus: num(hw["cpus"]),
      memoryMB: num(hw["memory_mb"]),
      diskTotalGB: num(hw["disk_total_gb"]),
      diskUsedPct: num(hw["disk_used_pct"]),
    }),
    security: {
      diskEncryption: sec["disk_encryption"] || "unknown",
      firewall: sec["firewall"] || "unknown",
      autoUpdates: sec["auto_updates"] || "unknown",
      ...(sec["ssh_password_auth"] ? { sshPasswordAuth: sec["ssh_password_auth"] } : {}),
      ...(sec["antivirus"] ? { antivirus: sec["antivirus"] } : {}),
      admins: (sec["admins"] ?? "").split(/\s+/).filter(Boolean).sort(),
    },
    software: compact({
      manager: sw["manager"] || undefined,
      packages: num(sw["packages"]),
      brewPackages: num(sw["brew_packages"]),
      pendingUpdates: num(sw["pending_updates"]),
      osquery: sw["osquery"] || undefined,
    }),
    listening: (p["listening"]?.["ports"] ?? "")
      .split(/\s+/)
      .map(Number)
      .filter((n) => n > 0),
  };
}

/** Where an adopted machine's files are in the fleet repository. */
export function adoptedDir(name: string): string {
  return path.join(P.fleetDir, "adopted", name);
}

/** Where its probe key is in the vault. */
export function probeKeyPath(name: string): string {
  return path.join(P.secrets, "adopted", name, "probe_key");
}

/** A name that can be one (a DNS label). */
export const MACHINE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** Every adopted machine's declaration and last observation. */
export async function loadAdopted(): Promise<Array<{ machine: AdoptedDef; observed?: Observed }>> {
  const dir = path.join(P.fleetDir, "adopted");
  const out: Array<{ machine: AdoptedDef; observed?: Observed }> = [];
  if (!(await fs.exists(dir))) return out;
  const { fleetExport } = await import("../model/load.ts");
  const names: string[] = [];
  for await (const e of fs.readDir(dir)) if (e.isDirectory) names.push(e.name);
  for (const n of names.sort()) {
    const mf = path.join(dir, n, "machine.ts");
    if (!(await fs.exists(mf))) continue;
    const machine = await fleetExport<AdoptedDef>(mf, "machine", true);
    if (!machine) continue;
    const of = path.join(dir, n, "observed.ts");
    const observed = (await fs.exists(of))
      ? await fleetExport<Observed>(of, "observed", true)
      : undefined;
    out.push({ machine, ...(observed ? { observed } : {}) });
  }
  return out;
}

/** machine.ts's text. */
export function machineSource(m: AdoptedDef): string {
  return `// An adopted machine (spec 067): Stolos observes and checks it; it does not manage it.
// Written by \`stolos host adopt\`; edit title, owner, and until freely.

import type { AdoptedDef } from "@intellectual-frontiers/stolos/archon/adopt/adopt";

export const machine: AdoptedDef = ${tsLiteral(m)};
`;
}

/** observed.ts's text. */
export function observedSource(o: Observed): string {
  return `// GENERATED by \`stolos host observe\` (spec 067): what the probe found. Never edit by hand;
// \`git log -p\` on this file is the machine's history.

import type { Observed } from "@intellectual-frontiers/stolos/archon/adopt/adopt";

export const observed: Observed = ${tsLiteral(o)};
`;
}

/** A known_hosts file for ssh from the machine's pinned keys. */
async function knownHostsFor(m: AdoptedDef): Promise<string> {
  const f = await fs.makeTempFile({ prefix: "stolos-adopted-known-" });
  const host = m.ssh.port && m.ssh.port !== 22 ? `[${m.ssh.address}]:${m.ssh.port}` : m.ssh.address;
  await fs.writeTextFile(f, m.hostKeys.map((k) => `${host} ${k}`).join("\n") + "\n");
  return f;
}

/** ssh's options to reach an adopted machine, checking its pinned host keys. */
function sshOpts(m: AdoptedDef, known: string, batch: boolean): string[] {
  return [
    "-o",
    `UserKnownHostsFile=${known}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    ...(batch ? ["-o", "BatchMode=yes"] : []),
    ...(m.ssh.port ? ["-p", String(m.ssh.port)] : []),
  ];
}

/** Run one probe with the probe key; its output, or why not. */
export async function probe(
  m: AdoptedDef,
  request: string,
): Promise<{ ok: boolean; out: string; err: string }> {
  const known = await knownHostsFor(m);
  try {
    const r = await run([
      "ssh",
      ...sshOpts(m, known, true),
      "-o",
      "IdentitiesOnly=yes",
      "-i",
      probeKeyPath(m.name),
      `${m.ssh.user}@${m.ssh.address}`,
      request,
    ]);
    return { ok: r.ok, out: r.stdout, err: r.stderr.trim() };
  } finally {
    await fs.remove(known).catch((e: unknown) => {
      if (!(e instanceof errors.NotFound)) {
        stdio.stderr.writeSync(`warning: ${known}: ${toError(e).message}\n`);
      }
    });
  }
}

/** The host keys a machine offers (ssh-keyscan), preferring ed25519. */
export async function scanHostKeys(address: string, port?: number): Promise<string[]> {
  const r = await run(["ssh-keyscan", "-T", "8", ...(port ? ["-p", String(port)] : []), address]);
  const keys = r.stdout
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/).slice(1, 3).join(" "));
  return [...new Set(keys)].sort((a, b) =>
    a.startsWith("ssh-ed25519") ? -1 : b.startsWith("ssh-ed25519") ? 1 : 0,
  );
}

/** The install script: the probe, and the probe key's line (replacing an older one). */
export function installScript(publicKey: string, fleet: string): string {
  const line = authorizedLine(publicKey, fleet);
  return `set -e
umask 077
mkdir -p "$HOME/.local/bin" "$HOME/.ssh"
cat > "$HOME/.local/bin/stolos-probe" <<'STOLOS_PROBE_EOF'
${PROBE_SCRIPT}STOLOS_PROBE_EOF
chmod 755 "$HOME/.local/bin/stolos-probe"
touch "$HOME/.ssh/authorized_keys"
grep -v 'stolos-probe@${fleet}$' "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.stolos" || true
printf '%s\\n' '${line}' >> "$HOME/.ssh/authorized_keys.stolos"
mv "$HOME/.ssh/authorized_keys.stolos" "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
echo "stolos-probe installed"
`;
}

/** The release script: the probe key's line and the probe go. */
export function releaseScript(fleet: string): string {
  return `set -e
if [ -f "$HOME/.ssh/authorized_keys" ]; then
  grep -v 'stolos-probe@${fleet}$' "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.stolos" || true
  mv "$HOME/.ssh/authorized_keys.stolos" "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"
fi
rm -f "$HOME/.local/bin/stolos-probe"
echo "stolos-probe removed"
`;
}

/** Run a script on the machine over your own SSH (it may ask your password or key passphrase). */
export async function runAsYou(m: AdoptedDef, script: string): Promise<boolean> {
  const known = await knownHostsFor(m);
  try {
    const r = await proc.output(
      ["ssh", ...sshOpts(m, known, false), `${m.ssh.user}@${m.ssh.address}`, "sh -s"],
      { input: script, stdout: "inherit", stderr: "inherit" },
    );
    return r.success;
  } finally {
    await fs.remove(known).catch((e: unknown) => {
      if (!(e instanceof errors.NotFound)) {
        stdio.stderr.writeSync(`warning: ${known}: ${toError(e).message}\n`);
      }
    });
  }
}

/** Make the machine's probe key in the vault (once); its public half. */
export async function ensureProbeKey(name: string, fleet: string): Promise<string> {
  const key = probeKeyPath(name);
  if (!(await fs.exists(key))) {
    const dir = await fs.makeTempDir({ prefix: "stolos-probe-key-" });
    try {
      const tmp = path.join(dir, "k");
      const r = await run([
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        `stolos-probe@${fleet}`,
        "-f",
        tmp,
      ]);
      if (!r.ok) throw new Error(`ssh-keygen: ${r.stderr.trim()}`);
      await writeSecret(key, await fs.readTextFile(tmp));
      await writeSecret(`${key}.pub`, await fs.readTextFile(`${tmp}.pub`));
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  }
  if (proc.build.os === "windows") await ownerOnly(key);
  return ((await fs.readTextOr(`${key}.pub`)) ?? "").trim();
}

/** Observe a machine now: its observation, or why not. */
export async function observe(m: AdoptedDef): Promise<{ observed?: Observed; why?: string }> {
  const r = await probe(m, "facts");
  if (!r.ok) return { why: r.err.split("\n").pop() || "the probe did not answer" };
  const p = parseProbe(r.out);
  if (!p["os"]) return { why: "the probe answered without facts (an old or edited stolos-probe?)" };
  return { observed: toObserved(p) };
}
