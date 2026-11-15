/**
 * Spec 056: the boot machine's backup is one ZIP file. `deno task stolos vault
 * backup` writes it into the backup folder where archon keeps its data
 * (Windows: `%LOCALAPPDATA%\stolos\backup`; Linux: `~/.local/share/stolos/backup`),
 * reads it back to check every file, and tells you to put it wherever you keep
 * important things safe. It holds everything this PC would need again after a
 * disaster: every fleet's secrets (the admin password's hash, each server's SSH
 * host keys and deploy key, the Cloudflare tokens, carried certificates) and
 * your signing key (both halves; the private half stays locked by its
 * passphrase). On a freshly cloned PC, `vault restore <zip>` (spec 061) puts it
 * all back; `RESTORE.txt` in every ZIP says the same, with the steps by hand.
 *
 * ```mermaid
 * flowchart LR
 *   secrets["%APPDATA%\stolos\secrets\&lt;fleet&gt;\*"] --> zip["stolos-backup-&lt;pc&gt;-&lt;time&gt;.zip<br/>manifest.json, RESTORE.txt"]
 *   key["your signing key<br/>(git config user.signingkey)"] --> zip
 *   zip --> check["read back: every SHA-256"]
 *   check --> you["you move it somewhere safe<br/>(encrypted: OneDrive Personal Vault, a password manager)"]
 * ```
 *
 * @module
 */

import { bootstrapOneLiner, repoSlug } from "../fleet/bootstrap.ts";
import { unzipSync, zipSync } from "npm:fflate@0.8.2";
import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { listFleets, P } from "../core/paths.ts";
import { ownerOnly } from "../core/secrets.ts";
import { liveSecrets, markBackedUp, sha256 } from "./state.ts";

/** Where backups are written (beside the boot cache, in stolos's data folder). */
export const BACKUP_DIR: string = join(P.bootCache, "..", "backup");

/** The ZIP's format, in its manifest. */
export const ZIP_FORMAT = "stolos-backup/1";

/** What a backup ZIP holds, in its manifest.json (names, sizes, and hashes; never a value). */
export interface ZipManifest {
  /** {@link ZIP_FORMAT}. */
  format: string;
  /** The PC it was made on. */
  pc: string;
  /** When (ISO time). */
  created: string;
  /** Every file: its path in the ZIP, SHA-256, and size. */
  files: Array<{ name: string; sha256: string; size: number }>;
}

/** One file to put in the ZIP. */
interface Entry {
  name: string;
  data: Uint8Array<ArrayBuffer>;
}

/** Every fleet's secrets on this PC (not the ephemeral ones), as ZIP entries under secrets/<fleet>/. */
async function secretEntries(): Promise<{ entries: Entry[]; active: Record<string, string> }> {
  const root = join(P.secrets, "..");
  const entries: Entry[] = [];
  const active: Record<string, string> = {};
  let fleets: string[] = [];
  try {
    fleets = [...Deno.readDirSync(root)].filter((e) => e.isDirectory).map((e) => e.name).sort();
  } catch { /* no secrets yet */ }
  for (const fleet of fleets) {
    for (const s of await liveSecrets(join(root, fleet))) {
      if (s.ref?.ephemeral) continue;
      entries.push({ name: `secrets/${fleet}/${s.name}`, data: await Deno.readFile(s.path) });
      if (join(root, fleet) === P.secrets) active[s.name] = s.sha256;
    }
  }
  return { entries, active };
}

/** Your signing key's two files, from `git config user.signingkey` (when it is a file). */
async function signingEntries(): Promise<{ entries: Entry[]; key?: string }> {
  // Spec 057 sets it for the fleet repository only: ask Git there.
  const k = (await run(["git", "-C", P.repo, "config", "--get", "user.signingkey"])).stdout.trim();
  if (!k || k.startsWith("key::")) return { entries: [] };
  const priv = k.replace(/\.pub$/, "");
  const entries: Entry[] = [];
  for (const p of [priv, `${priv}.pub`]) {
    if (await exists(p)) {
      entries.push({ name: `signing/${p.split(/[\\/]/).pop()}`, data: await Deno.readFile(p) });
    }
  }
  return { entries, key: priv };
}

/**
 * The recovery key (spec 057): everything in the key store (the current key,
 * any retired one), and any loose fleet-recovery folder an earlier version left
 * on the Desktop or in the home folder, all under signing/recovery/.
 */
async function recoveryEntries(): Promise<{ entries: Entry[]; loose: string[] }> {
  const { keyPaths } = await import("../identity/keys.ts");
  const paths = keyPaths();
  const entries: Entry[] = [];
  const loose: string[] = [];
  for (
    const [dir, isLoose] of [[paths.recoveryDir, false], [paths.looseRecoveryDir, true]] as const
  ) {
    let names: string[] = [];
    try {
      names = [...Deno.readDirSync(dir)].filter((e) => e.isFile).map((e) => e.name).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (entries.some((e) => e.name === `signing/recovery/${n}`)) continue;
      entries.push({ name: `signing/recovery/${n}`, data: await Deno.readFile(join(dir, n)) });
      if (isLoose) loose.push(join(dir, n));
    }
  }
  return { entries, loose };
}

/** After a verified backup: move loose recovery key files into the key store, then remove their folder. */
async function adoptLooseRecovery(loose: string[]): Promise<string | undefined> {
  if (!loose.length) return undefined;
  const { keyPaths } = await import("../identity/keys.ts");
  const paths = keyPaths();
  await Deno.mkdir(paths.recoveryDir, { recursive: true });
  for (const f of loose) {
    const to = join(paths.recoveryDir, f.split(/[\\/]/).pop()!);
    if (!(await exists(to))) await Deno.copyFile(f, to);
    await Deno.remove(f);
  }
  try {
    await Deno.remove(paths.looseRecoveryDir); // empty now; left alone if something else is in it
  } catch { /* other files in it: not ours to remove */ }
  return paths.recoveryDir;
}

/** The restore instructions: printed by `vault restore`, and RESTORE.txt in every ZIP. */
export function restoreText(fleets: string[] = [], repo = ""): string {
  const fl = fleets.length ? fleets.join(", ") : "<fleet>";
  return `How to restore a stolos backup
=============================

This ZIP holds what a boot machine needs again after a disaster:
  secrets/<fleet>/...   each fleet's secrets (${fl}): the admin password's hash,
                        each server's SSH host keys and deploy key, the Cloudflare
                        tokens (mail.json, web.json), carried certificates
  signing/...           your daily signing key (both halves; the private half is
                        locked by its passphrase, which is not in here)
  signing/recovery/...  your recovery key (locked by its own passphrase), and any
                        retired one: this one ZIP holds everything a disaster needs
  manifest.json         every file's name, size, and SHA-256

On the new or rebuilt PC (Windows, in PowerShell):

 1-2. Bootstrap: Deno, Git, gh, your GitHub sign-in, and your fleet repository
    cloned into $HOME\\fleet, in one line (spec 062):
        ${bootstrapOneLiner("windows", repo)}
    (Linux or macOS, in a terminal:
        ${bootstrapOneLiner("posix", repo)})
 3. Restore this ZIP, in one command (it checks the ZIP, never overwrites, and
    asks for your daily key's passphrase once, for a test signature):
        cd $HOME\\fleet
        deno task stolos vault restore <path to this ZIP>
    Then check everything: deno task stolos boot doctor. That is all.

By hand instead (the same as step 3 does):

 3. Unzip this file somewhere private, for example your Desktop.
 4. Put the secrets back, only readable by you:
        New-Item -ItemType Directory -Force $env:APPDATA\\stolos\\secrets
        Copy-Item -Recurse <unzipped>\\secrets\\* $env:APPDATA\\stolos\\secrets\\
        icacls $env:APPDATA\\stolos\\secrets /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F"
    (Linux: mkdir -p ~/.config/stolos/secrets && cp -r <unzipped>/secrets/* ~/.config/stolos/secrets/
     && chmod -R go-rwx ~/.config/stolos)
 5. Put both keys back, then let stolos set up Git's signing (it keeps the keys):
        Copy-Item <unzipped>\\signing\\fleet-signing* $HOME\\.ssh\\
        New-Item -ItemType Directory -Force $env:APPDATA\\stolos\\keys
        Copy-Item <unzipped>\\signing\\recovery\\* $env:APPDATA\\stolos\\keys\\
        cd $HOME\\fleet
        deno task stolos keys setup
    (Linux and macOS: cp <unzipped>/signing/fleet-signing* ~/.ssh/;
     mkdir -p ~/.config/stolos/keys && cp <unzipped>/signing/recovery/* ~/.config/stolos/keys/)
 6. Delete the unzipped folder (the ZIP itself stays wherever you keep it safe).
 7. Check, in the fleet repository:
        deno task stolos vault status      every secret, back where it belongs
        deno task stolos                 where you are, and what next
        deno task stolos keys            your signing works

If you forgot the daily key's passphrase, the recovery key (in this ZIP) replaces the
daily key: deno task stolos keys lost. If you forgot both passphrases, a person at
each server must trust a new key there (archon signers trust). See the engine's
"deno task stolos docs disaster-recovery".
`;
}

/** Write the backup ZIP, read it back, and record it; returns its path and manifest. */
export async function writeBackupZip(
  pc: string,
  now = new Date(),
): Promise<{
  path: string;
  manifest: ZipManifest;
  signingKey?: string;
  recovery: boolean;
  movedRecoveryTo?: string;
  fleets: string[];
}> {
  const { entries: secrets, active } = await secretEntries();
  const { entries: signing, key } = await signingEntries();
  const fleets = [...new Set(secrets.map((e) => e.name.split("/")[1]))].sort();
  const { entries: recovery, loose } = await recoveryEntries();
  const files = [...secrets, ...signing, ...recovery];
  const manifest: ZipManifest = {
    format: ZIP_FORMAT,
    pc,
    created: now.toISOString(),
    files: await Promise.all(
      files.map(async (f) => ({ name: f.name, sha256: await sha256(f.data), size: f.data.length })),
    ),
  };
  const enc = new TextEncoder();
  const zip = zipSync({
    ...Object.fromEntries(files.map((f) => [f.name, f.data])),
    "manifest.json": enc.encode(JSON.stringify(manifest, null, 2) + "\n"),
    "RESTORE.txt": enc.encode(
      restoreText(fleets.length ? fleets : listFleets(P.repo), await repoSlug(P.repo)),
    ),
  }, { level: 9 });
  // Read it back: every file in the manifest, with its SHA-256, before saying it worked.
  const back = unzipSync(zip);
  for (const f of manifest.files) {
    const d = back[f.name];
    if (!d || (await sha256(new Uint8Array(d))) !== f.sha256) {
      throw new Error(`the backup does not read back correctly (${f.name}); nothing was recorded`);
    }
  }
  await Deno.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  // Spec 082: a provider's client's backup says whose it is (it holds that client's secrets only).
  const whose = P.clientId ? `${pc}-${P.clientId}` : pc;
  const path = join(BACKUP_DIR, `stolos-backup-${whose}-${stamp}.zip`);
  await Deno.writeFile(path, zip, { mode: 0o600 });
  if (Deno.build.os === "windows") await ownerOnly(path);
  else await Deno.chmod(path, 0o600);
  await markBackedUp(path.split(/[\\/]/).pop()!, active, manifest.created, BACKUP_DIR);
  // Backed up and verified: a loose recovery key moves into the key store, so every later
  // backup holds it too, and its old folder goes.
  const movedRecoveryTo = await adoptLooseRecovery(loose);
  return {
    path,
    manifest,
    ...(key ? { signingKey: key } : {}),
    recovery: recovery.some((e) => !e.name.endsWith(".pub")),
    ...(movedRecoveryTo ? { movedRecoveryTo } : {}),
    fleets,
  };
}

/** The manifest inside a backup ZIP, or undefined (not one, or unreadable). */
export async function readZipManifest(path: string): Promise<ZipManifest | undefined> {
  try {
    const files = unzipSync(await Deno.readFile(path), {
      filter: (f) => f.name === "manifest.json",
    });
    const m = JSON.parse(new TextDecoder().decode(files["manifest.json"])) as ZipManifest;
    return Array.isArray(m.files) ? m : undefined;
  } catch {
    return undefined;
  }
}

/** The backup ZIPs still in the backup folder, newest first. */
export async function backupZips(
  dir = BACKUP_DIR,
): Promise<Array<{ path: string; name: string; files: number; size: number; created: string }>> {
  const out = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !/^stolos-backup-.*\.zip$/.test(e.name)) continue;
      const path = join(dir, e.name);
      const m = await readZipManifest(path);
      if (!m) continue;
      out.push({
        path,
        name: e.name,
        files: m.files.length,
        size: (await Deno.stat(path)).size,
        created: m.created,
      });
    }
  } catch { /* no folder yet */ }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export { readTextOr };
