/**
 * The boot machine's secret store (spec 003, Article 13): a per-user folder
 * outside the repository (%APPDATA%\stolos\secrets on Windows,
 * ~/.config/stolos/secrets elsewhere). Holds the admin password hash, each
 * host's deploy key, and install tokens. Nothing here is ever committed.
 *
 * @module
 */

import { P } from "./paths.ts";
import { join } from "./path.ts";
import { ensureDir, exists, readTextOr } from "./fsx.ts";
import { run } from "./exec.ts";
import { recordChange } from "./secret-ledger.ts";

// Spec 046: computed on each use, so they follow the fleet chosen for this run
// (--fleet, ARCHON_FLEET), not the one active when this module was loaded.
/** Where each secret lives on the boot machine (per fleet; never in Git). */
export const SECRETS = {
  get dir(): string {
    return P.secrets;
  },
  get adminPasswordHash(): string {
    return join(P.secrets, "admin-password.hash");
  },
  deployKey: (host: string) => join(P.secrets, "hosts", host, "deploy_key"),
  deployKeyPub: (host: string) => join(P.secrets, "hosts", host, "deploy_key.pub"),
  /** The server's Let's Encrypt store, carried across a re-install (spec 032). */
  acme: (host: string) => join(P.secrets, "hosts", host, "acme.json"),
  /** The host's SSH host keys (spec 004): its identity across re-installs. */
  hostKey: (host: string, type: string) => join(P.secrets, "hosts", host, `ssh_host_${type}_key`),
  /** The mail relay's credential (spec 027): a Cloudflare API token with Email Sending: Edit. */
  get mail(): string {
    return join(P.secrets, "mail.json");
  },
  /** The Cloudflare DNS token (spec 032): Zone Read and DNS Edit on the fleet's zone. */
  get web(): string {
    return join(P.secrets, "web.json");
  },
  get tokens(): string {
    return join(P.secrets, "install-tokens.json");
  },
};

/**
 * Write a secret readable only by this user (POSIX 0600; Windows: inheritance
 * removed and full control for this user only, icacls). Every secret write in
 * Archon goes through here (spec 029): it records the change in the ledger, so
 * the vault knows what is newer than the last backup. Unchanged content is not
 * rewritten (and is not a change).
 */
export async function writeSecret(path: string, content: string): Promise<void> {
  if ((await readTextOr(path)) === content) return;
  await ensureDir(join(path, ".."));
  if (Deno.build.os !== "windows") await Deno.chmod(join(path, ".."), 0o700).catch(() => {});
  await Deno.writeTextFile(path, content, { mode: 0o600 });
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
  else await ownerOnly(path);
  await recordChange(path);
}

/** Remove a secret (and record it, so the vault knows). */
export async function removeSecret(path: string): Promise<void> {
  if (!(await exists(path))) return;
  await Deno.remove(path);
  await recordChange(path, true);
}

/** Windows: this user only (no inherited access), the equivalent of 0600. */
export async function ownerOnly(path: string): Promise<void> {
  const user = Deno.env.get("USERNAME");
  if (!user) return;
  await run(["icacls", path, "/inheritance:r", "/grant:r", `${user}:F`]).catch(() => {});
}

/** A secret's content, or undefined. */
export async function readSecret(path: string): Promise<string | undefined> {
  return (await readTextOr(path))?.trim();
}

export { exists };

/** One armed install (the boot machine's own record). */
export interface InstallToken {
  /** The host. */
  host: string;
  /** The random token in its install URLs. */
  token: string;
  /** When the token was issued (ISO time). */
  armed: string;
  /** First time the host fetched its install config; the token then lives 2 hours. */
  firstUse?: string;
  /** The MAC the host network-booted from, as GRUB reported it. */
  mac?: string;
  /** Addresses the host was installed from (its old SSH host keys are forgotten for each). */
  addresses?: string[];
  /** `boot arm --claim`: until then, the next unknown machine to network-boot becomes this host. */
  claimUntil?: string;
  /** The installer reported completion; the token is spent. */
  done?: string;
  /**
   * Spec 051: a person repeated the host's name with --confirm-destroy: this one
   * install may erase disks that are not blank (otherwise the installer stops).
   */
  confirmDestroy?: true;
  /**
   * boot reinstall reached this host over SSH (its registered keys) and rebooted
   * it into this install: a machine with this MAC holds this host already.
   */
  reinstall?: true;
}

const TOKEN_LIFE_AFTER_USE_MS = 2 * 60 * 60 * 1000;

/** Every armed install. */
export async function loadTokens(): Promise<InstallToken[]> {
  const raw = await readTextOr(SECRETS.tokens);
  return raw ? JSON.parse(raw) as InstallToken[] : [];
}

/** Write them back. */
export async function saveTokens(tokens: InstallToken[]): Promise<void> {
  await writeSecret(SECRETS.tokens, JSON.stringify(tokens, null, 2) + "\n");
}

/** Arm a host for one install: any previous token for it is replaced. */
export async function armHost(
  host: string,
  claimMinutes = 0,
  knownMac?: string,
  o: { confirmDestroy?: boolean; reinstall?: boolean } = {},
): Promise<InstallToken> {
  const all = await loadTokens();
  const prev = all.find((t) => t.host === host);
  const mac = knownMac?.toLowerCase() ?? prev?.mac;
  const tokens = all.filter((t) => t.host !== host);
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const token = btoa(String.fromCharCode(...bytes)).replace(
    /[+/=]/g,
    (c) => c === "+" ? "-" : c === "/" ? "_" : "",
  );
  // Keep the MAC learned from an earlier install, for `boot status`.
  const t: InstallToken = {
    host,
    token,
    armed: new Date().toISOString(),
    ...(prev?.addresses?.length ? { addresses: prev.addresses } : {}),
    // A claim replaces the learned MAC: the host may be different hardware now.
    ...(claimMinutes
      ? { claimUntil: new Date(Date.now() + claimMinutes * 60_000).toISOString() }
      : mac
      ? { mac }
      : {}),
    ...(o.confirmDestroy ? { confirmDestroy: true as const } : {}),
    ...(o.reinstall ? { reinstall: true as const } : {}),
  };
  tokens.push(t);
  await saveTokens(tokens);
  // A running boot server shows it at once (it reads the token only when a machine boots).
  const { announce } = await import("./announce.ts");
  await announce({
    name: "boot.armed",
    host,
    message: `armed for one install${
      claimMinutes
        ? `; the next unknown machine to network-boot in ${claimMinutes} minutes becomes ${host}`
        : mac
        ? ` as the machine with network card ${mac}`
        : ""
    }${
      o.confirmDestroy
        ? "; its disks will be erased even if they are not blank (--confirm-destroy)"
        : ""
    }`,
  });
  return t;
}

/** The live token for a host: armed, not done, and not expired. */
export function liveToken(
  tokens: InstallToken[],
  host: string,
  now = Date.now(),
): InstallToken | undefined {
  const t = tokens.find((x) => x.host === host);
  if (!t || t.done) return undefined;
  if (t.firstUse && now - Date.parse(t.firstUse) > TOKEN_LIFE_AFTER_USE_MS) return undefined;
  return t;
}
