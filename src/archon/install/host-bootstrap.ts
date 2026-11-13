// `archon host bootstrap` (spec 005): finish a host whose Ubuntu was installed
// by hand (from Ubuntu's ISO, a cloud image, anything) instead of by network
// boot. From the boot machine it copies, over SSH, exactly what the network
// install would have handed cloud-init (the host name, GitHub's host keys, the
// first-boot script, and the host's deploy key), then runs the same first boot
// with sudo. Uses the OpenSSH client that ships with Windows and Linux.

import { join } from "../core/path.ts";
import { ui } from "../core/ui.ts";
import { readSecret, SECRETS } from "../core/secrets.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import { firstBootScript, GITHUB_KNOWN_HOSTS } from "../render/autoinstall.ts";
import { allowedSignersText } from "../identity/signers.ts";
import { ensureHostKeys } from "./host-keys.ts";

export interface HostBootstrapOptions {
  name: string;
  /** user@address of the freshly installed server. */
  ssh: string;
}

const INSTALL = `#!/bin/sh
# Rendered by archon host bootstrap (spec 005). Puts the files where the
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

async function ssh(args: string[], interactive = false): Promise<number> {
  const p = new Deno.Command("ssh", {
    args,
    stdin: interactive ? "inherit" : "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return (await p.status).code;
}

export async function hostBootstrap(o: HostBootstrapOptions): Promise<number> {
  const fleet = await loadFleet();
  const host = (await loadHosts()).find((h) => h.name === o.name);
  if (!host) {
    throw new Error(`no host model named '${o.name}': run archon host add ${o.name} first`);
  }

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
  if (code === 0) r.done(`${host.name} converged and pushed its first record`);
  else {r.fail(
      `first boot on ${host.name} failed (exit ${code})`,
      `ssh ${o.ssh} sudo tail -n 80 /var/log/archon-first-boot.log`,
    );}
  return code;
}
