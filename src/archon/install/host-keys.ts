/**
 * Each host's SSH identity (spec 004): its host keys are made once on the boot
 * machine (ssh-keygen, as for the deploy key), kept in the secret store, and
 * installed by cloud-init at every install. A re-installed host keeps its
 * identity, and the boot machine's known_hosts holds the right keys from the
 * start: no "trust this host?" prompt, no "REMOTE HOST IDENTIFICATION HAS
 * CHANGED" after a re-install.
 *
 * @module
 */

import { run } from "../core/exec.ts";
import { join } from "../core/path.ts";
import { ensureDir, exists, readTextOr } from "../core/fsx.ts";
import { SECRETS, writeSecret } from "../core/secrets.ts";

/** Ubuntu's own host key types. */
export const HOST_KEY_TYPES = ["ed25519", "ecdsa", "rsa"] as const;
/** An SSH host key type. */
export type HostKeyType = typeof HOST_KEY_TYPES[number];

/** One SSH host key pair. */
export interface HostKey {
  /** Its type. */
  type: HostKeyType;
  /** The private half (kept on the boot machine only). */
  private: string;
  /** "ssh-ed25519 AAAA..." without a comment. */
  public: string;
}

/** Create (once) and read the host's SSH host keys. */
export async function ensureHostKeys(host: string): Promise<HostKey[]> {
  const keys: HostKey[] = [];
  for (const type of HOST_KEY_TYPES) {
    const path = SECRETS.hostKey(host, type);
    if (!(await exists(path))) {
      // A private temporary folder for ssh-keygen; writeSecret stores both halves (spec 029).
      const tmp = await Deno.makeTempDir({ prefix: "archon-hostkey-" });
      try {
        const r = await run([
          "ssh-keygen",
          "-q",
          "-t",
          type,
          ...(type === "rsa" ? ["-b", "3072"] : []),
          "-N",
          "",
          "-C",
          `root@${host}`,
          "-f",
          join(tmp, "key"),
        ]);
        if (!r.ok) throw new Error(`ssh-keygen (${type}) failed: ${(r.stderr || r.stdout).trim()}`);
        await writeSecret(path, await Deno.readTextFile(join(tmp, "key")));
        await writeSecret(`${path}.pub`, await Deno.readTextFile(join(tmp, "key.pub")));
      } finally {
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
      }
    }
    const priv = await readTextOr(path);
    const pub = await readTextOr(`${path}.pub`);
    if (!priv || !pub) throw new Error(`host key ${path} is incomplete`);
    keys.push({
      type,
      private: priv.trim() + "\n",
      public: pub.trim().split(/\s+/).slice(0, 2).join(" "),
    });
  }
  return keys;
}

/** The known_hosts OpenSSH uses for this user (Windows: %USERPROFILE%\.ssh). */
export function knownHostsFile(): string {
  const home = Deno.build.os === "windows"
    ? Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME") ?? "."
    : Deno.env.get("HOME") ?? ".";
  return join(home, ".ssh", "known_hosts");
}

/** Remove a host's entries from known_hosts; returns the names that were found. */
export async function forgetHostKeys(
  names: string[],
  file = knownHostsFile(),
): Promise<string[]> {
  const removed: string[] = [];
  if (!(await exists(file))) return removed;
  for (const n of [...new Set(names.filter(Boolean))]) {
    const r = await run(["ssh-keygen", "-f", file, "-R", n]);
    if (r.ok && /# Host .* found/.test(r.stdout + r.stderr)) removed.push(n);
  }
  // ssh-keygen keeps the previous file as known_hosts.old; nothing else changes.
  return removed;
}

/** Replace a host's entries with its real keys, for its name and every address it used. */
export async function trustHost(
  host: string,
  names: string[],
  file = knownHostsFile(),
  keys?: Array<Pick<HostKey, "public">>,
): Promise<string[]> {
  keys ??= await ensureHostKeys(host);
  const all = [...new Set([host, ...names].filter(Boolean))];
  await forgetHostKeys(all, file);
  await ensureDir(join(file, ".."));
  const before = (await readTextOr(file)) ?? "";
  const lines = keys.map((k) => `${all.join(",")} ${k.public}`).join("\n") + "\n";
  await Deno.writeTextFile(
    file,
    (before && !before.endsWith("\n") ? before + "\n" : before) + lines,
  );
  return all;
}

/** What `archon host-keys export` prints: the host's identities the boot machine keeps. */
export interface HostExport {
  /** The host's SSH host keys. */
  hostKeys: HostKey[];
  /** ops' GitHub deploy key (the one registered on the repository), when present. */
  deployKey?: { private: string; public: string };
}

/** The export, in the current form or the first one (a bare list of host keys). */
export function parseHostExport(text: string): HostExport {
  const j = JSON.parse(text);
  return Array.isArray(j) ? { hostKeys: j } : j as HostExport;
}

/**
 * `archon host-keys export` (spec 029): this host's SSH host keys and ops'
 * deploy key as JSON, for `deno task stolos vault recover-host-keys <host>` when
 * the boot machine lost its copies without a backup: the rebuilt boot machine
 * then holds the same identities, so nothing changes on GitHub or for SSH
 * clients. Root only (it elevates); never offered over MCP.
 */
export async function exportHostKeys(): Promise<number> {
  const keys: HostKey[] = [];
  for (const type of HOST_KEY_TYPES) {
    const priv = await readTextOr(`/etc/ssh/ssh_host_${type}_key`);
    const pub = await readTextOr(`/etc/ssh/ssh_host_${type}_key.pub`);
    if (priv && pub) {
      keys.push({
        type,
        private: priv.trim() + "\n",
        public: pub.trim().split(/\s+/).slice(0, 2).join(" "),
      });
    }
  }
  if (!keys.length) {
    console.error("no SSH host keys in /etc/ssh");
    return 1;
  }
  const out: HostExport = { hostKeys: keys };
  const deploy = "/home/ops/.ssh/archon_deploy_key";
  const priv = await readTextOr(deploy);
  if (priv) {
    const pub = await run(["ssh-keygen", "-y", "-f", deploy]);
    if (pub.ok) {
      out.deployKey = {
        private: priv.trim() + "\n",
        public: pub.stdout.trim().split(/\s+/).slice(0, 2).join(" "),
      };
    }
  }
  console.log(JSON.stringify(out));
  return 0;
}
