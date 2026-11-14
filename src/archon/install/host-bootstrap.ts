/**
 * `stolos host bootstrap` (spec 005): finish a host whose Ubuntu was installed
 * by hand (from Ubuntu's ISO, a cloud image, anything) instead of by network
 * boot. From the boot machine it copies, over SSH, exactly what the network
 * install would have handed cloud-init (the host name, GitHub's host keys, the
 * first-boot script, and the host's deploy key), then runs the same first boot
 * with sudo. Uses the OpenSSH client that ships with Windows and Linux.
 *
 * ```mermaid
 * sequenceDiagram
 *   actor P as Person
 *   participant A as stolos host bootstrap
 *   participant M as The machine (Ubuntu installed)
 *   P->>A: host bootstrap olympia --ssh user@address
 *   A->>M: its facts: release, RAM, network cards
 *   A->>A: refuse the wrong release or the wrong machine
 *   A->>M: fleet, signers, registered SSH host keys, first boot
 *   M->>M: the first boot
 *   A->>A: registration.ts: the card the machine reported
 * ```
 *
 * @module
 */

import { join } from "../core/path.ts";
import { ui } from "../core/ui.ts";
import { readSecret, SECRETS } from "../core/secrets.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import { firstBootScript, GITHUB_KNOWN_HOSTS } from "../render/autoinstall.ts";
import { allowedSignersText } from "../identity/signers.ts";
import { ensureHostKeys } from "./host-keys.ts";

/** What stolos host bootstrap is given. */
export interface HostBootstrapOptions {
  /** The host. */
  name: string;
  /** user@address of the freshly installed server. */
  ssh: string;
}

const INSTALL = `#!/bin/sh
# Rendered by stolos host bootstrap (spec 005). Puts the files where the
# network install would have, then runs the first boot.
set -eu
D=$(dirname "$0")
install -d -m 0755 /etc/archon
install -m 0644 "$D/host" /etc/archon/host
install -m 0644 "$D/fleet" /etc/archon/fleet
install -m 0644 "$D/allowed_signers" /etc/archon/allowed_signers
install -m 0644 "$D/github_known_hosts" /etc/archon/github_known_hosts
install -m 0755 "$D/archon-first-boot" /usr/local/sbin/archon-first-boot
[ -f "$D/deploy_key" ] && install -m 0600 "$D/deploy_key" /etc/archon/deploy_key
# The host's SSH identity, as registered in Git (spec 047), as a network install has it.
for t in ed25519 ecdsa rsa; do
  if [ -f "$D/ssh_host_\${t}_key" ]; then
    install -m 0600 "$D/ssh_host_\${t}_key" "/etc/ssh/ssh_host_\${t}_key"
    install -m 0644 "$D/ssh_host_\${t}_key.pub" "/etc/ssh/ssh_host_\${t}_key.pub"
  fi
done
systemctl try-reload-or-restart ssh.service 2>/dev/null || true
rm -rf "$D"
echo "archon: first boot running (log: /var/log/archon-first-boot.log)"
if /usr/local/sbin/archon-first-boot; then
  tail -n 25 /var/log/archon-first-boot.log
else
  tail -n 60 /var/log/archon-first-boot.log
  exit 1
fi
`;

/**
 * Spec 051: what the machine at the address says about itself, read before
 * anything is copied: its Ubuntu release, its facts (as the installer's guard
 * reports them), and its network cards (the default route's first).
 */
export const BOOTSTRAP_FACTS =
  `. /etc/os-release; echo "version_id=$VERSION_ID"; echo "hostname=$(hostname)"
for k in sys_vendor product_name product_serial; do echo "$k=$(cat /sys/class/dmi/id/$k 2>/dev/null)"; done
echo "mem_kib=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"; echo "cpus=$(nproc)"
d=$(ip -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p')
[ -n "$d" ] && echo "uplink=$(cat /sys/class/net/$d/address)"
for n in /sys/class/net/*; do [ -e "$n/device" ] && echo "nic=$(cat $n/address)"; done
exit 0`;

/** What the machine at the address says about itself. */
export interface BootstrapFacts {
  /** Its Ubuntu release. */
  versionId?: string;
  /** Its hostname. */
  hostname?: string;
  /** Its default route's network card. */
  uplink?: string;
  /** Every physical network card. */
  nics: string[];
  /** One line for people. */
  summary: string;
}

/** Parse the probe's key=value lines. */
export function parseBootstrapFacts(text: string): BootstrapFacts {
  const get = (k: string) => text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() || undefined;
  const nics = [...text.matchAll(/^nic=(.+)$/gm)].map((m) => m[1].trim().toLowerCase());
  const mem = Number(get("mem_kib") ?? 0);
  const who = [get("sys_vendor"), get("product_name")].filter(Boolean).join(" ") || "a machine";
  return {
    versionId: get("version_id"),
    hostname: get("hostname"),
    uplink: get("uplink")?.toLowerCase(),
    nics,
    summary: `${who}, Ubuntu ${get("version_id") ?? "?"}, ${get("cpus") ?? "?"} CPUs, ${
      mem ? (mem / 1048576).toFixed(1) : "?"
    } GiB RAM`,
  };
}

/** Why bootstrapping this machine as the host is refused, or undefined. */
export function bootstrapRefusal(
  host: string,
  f: BootstrapFacts,
  release: string,
  registeredMac?: string,
): string | undefined {
  if (f.versionId !== release) {
    return `the machine runs Ubuntu ${
      f.versionId ?? "(unknown)"
    }; the fleet is Ubuntu ${release}: install Ubuntu ${release} on it first`;
  }
  if (registeredMac && !f.nics.includes(registeredMac) && f.uplink !== registeredMac) {
    return `${host} is registered with network card ${registeredMac}, which this machine does not have (it has ${
      f.nics.join(", ") || "none"
    }): the wrong machine, or a typo in --mac-address. If it is ${host}: deno task stolos host add ${host} --mac-address ${
      f.uplink ?? "<mac>"
    } --force`;
  }
  return undefined;
}

async function ssh(args: string[], interactive = false): Promise<number> {
  const p = new Deno.Command("ssh", {
    args,
    stdin: interactive ? "inherit" : "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return (await p.status).code;
}

/** stolos host bootstrap: check the machine, copy what a network install would have handed it, run the first boot. */
export async function hostBootstrap(o: HostBootstrapOptions): Promise<number> {
  const fleet = await loadFleet();
  const host = (await loadHosts()).find((h) => h.name === o.name);
  if (!host) {
    throw new Error(`no host model named '${o.name}': run stolos host add ${o.name} first`);
  }

  // Spec 051: the machine first, from itself.
  const m = ui.phase("Machine");
  const probe = await new Deno.Command("ssh", {
    args: [o.ssh, "sh", "-s"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = probe.stdin.getWriter();
  await w.write(new TextEncoder().encode(BOOTSTRAP_FACTS + "\n"));
  await w.close();
  const out = await probe.output();
  if (!out.success) {
    const why = new TextDecoder().decode(out.stderr).trim().split("\n").pop() ?? "";
    // ssh's own failures are 255; anything else is the probe's.
    throw new Error(
      out.code === 255
        ? `cannot reach ${o.ssh} over SSH (${why}): check the address and that your key is installed`
        : `${o.ssh} answered, but reading its facts failed (exit ${out.code}${
          why ? `: ${why}` : ""
        })`,
    );
  }
  const facts = parseBootstrapFacts(new TextDecoder().decode(out.stdout));
  const { loadRegistration, writeRegistration } = await import("../fleet/registration.ts");
  const reg = await loadRegistration(host.name);
  const refusal = bootstrapRefusal(host.name, facts, fleet.ubuntu.release, reg?.mac);
  if (refusal) {
    m.fail(
      refusal,
      undefined,
      refusal.includes("network card") ? "E051-WRONG-MACHINE" : "E051-WRONG-RELEASE",
    );
    return 1;
  }
  m.done(`${facts.summary}${facts.uplink ? ` · network card ${facts.uplink}` : ""}`);

  const p = ui.phase("Files");
  const dir = await Deno.makeTempDir({ prefix: "archon-bootstrap-" });
  const files: Record<string, string> = {
    "host": `${host.name}\n`,
    // As the network install (specs 046, 047): which fleet, and whose signatures to trust.
    "fleet": `${fleet.id}\n`,
    "allowed_signers": allowedSignersText(fleet.signers ?? []),
    "github_known_hosts": GITHUB_KNOWN_HOSTS,
    "archon-first-boot": firstBootScript(fleet, host),
    "install.sh": INSTALL,
  };
  const key = await readSecret(SECRETS.deployKey(host.name));
  if (key) files["deploy_key"] = key + "\n";
  // Its registered SSH host keys (made by host add): the keys Git vouches for.
  for (const k of await ensureHostKeys(host.name)) {
    files[`ssh_host_${k.type}_key`] = k.private;
    files[`ssh_host_${k.type}_key.pub`] = `${k.public} root@${host.name}\n`;
  }
  for (const [n, c] of Object.entries(files)) {
    const secret = n === "deploy_key" || /^ssh_host_\w+_key$/.test(n);
    await Deno.writeTextFile(join(dir, n), c, { mode: secret ? 0o600 : 0o644 });
  }
  p.done(
    `first-boot files for ${host.name}, its registered SSH host keys${
      key ? ", its deploy key" : " (no deploy key: clones over HTTPS)"
    }`,
  );

  const c = ui.phase("Copy");
  const remote = `/tmp/archon-bootstrap-${host.name}`;
  if ((await ssh([o.ssh, `rm -rf ${remote} && mkdir -m 0700 ${remote}`])) !== 0) {
    throw new Error(
      `cannot reach ${o.ssh} over SSH: check the address and that your key is installed`,
    );
  }
  const scp = await new Deno.Command("scp", {
    args: ["-q", ...Object.keys(files).map((n) => join(dir, n)), `${o.ssh}:${remote}/`],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  await Deno.remove(dir, { recursive: true });
  if (!scp.success) throw new Error(`scp to ${o.ssh} failed`);
  c.done(`copied to ${o.ssh}:${remote} (removed after use)`);

  ui.pause();
  console.error(`   running first boot on ${o.ssh} with sudo (it may ask for your password):`);
  // A terminal only when there is one (sudo may ask for a password); not in automation.
  const code = await ssh(
    [...(Deno.stdin.isTerminal() ? ["-t"] : []), o.ssh, `sudo sh ${remote}/install.sh`],
    Deno.stdin.isTerminal(),
  );
  ui.resume();
  const r = ui.phase("First boot");
  if (code === 0) {
    r.done(`${host.name} converged and recorded its first install`);
    // Spec 051: its network card, as the machine reported it, is its registered MAC.
    if (reg && facts.uplink && (reg.mac !== facts.uplink || reg.macSource !== "installed")) {
      const file = await writeRegistration(host.name, {
        ...reg,
        mac: facts.uplink,
        macSource: "installed",
      });
      ui.next.push(
        `${file}: mac ${facts.uplink}, as the machine reported it; commit and push it (signed)`,
      );
    }
  } else {r.fail(
      `first boot on ${host.name} failed (exit ${code})`,
      `ssh ${o.ssh} sudo tail -n 80 /var/log/archon-first-boot.log`,
    );}
  return code;
}
