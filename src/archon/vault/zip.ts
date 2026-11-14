/**
 * Spec 056: the boot machine's backup is one ZIP file. `deno task boot vault
 * backup` writes it into the backup folder where archon keeps its data
 * (Windows: `%LOCALAPPDATA%\archon\backup`; Linux: `~/.local/share/archon/backup`),
 * reads it back to check every file, and tells you to put it wherever you keep
 * important things safe. It holds everything this PC would need again after a
 * disaster: every fleet's secrets (the admin password's hash, each server's SSH
 * host keys and deploy key, the Cloudflare tokens, carried certificates) and
 * your signing key (both halves; the private half stays locked by its
 * passphrase). A restore is never done by a command: `vault restore` (and
 * `RESTORE.txt` in every ZIP) says what to do with the ZIP, by hand.
 *
 * ```mermaid
 * flowchart LR
 *   secrets["%APPDATA%\archon\secrets\&lt;fleet&gt;\*"] --> zip["archon-backup-&lt;pc&gt;-&lt;time&gt;.zip<br/>manifest.json, RESTORE.txt"]
 *   key["your signing key<br/>(git config user.signingkey)"] --> zip
 *   zip --> check["read back: every SHA-256"]
 *   check --> you["you move it somewhere safe<br/>(encrypted: OneDrive Personal Vault, a password manager)"]
 * ```
 *
 * @module
 */

import { unzipSync, zipSync } from "npm:fflate@0.8.2";
import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { listFleets, P } from "../core/paths.ts";
import { ownerOnly } from "../core/secrets.ts";
import { liveSecrets, markBackedUp, sha256 } from "./state.ts";

/** Where backups are written (beside the boot cache, in archon's data folder). */
export const BACKUP_DIR: string = join(P.bootCache, "..", "backup");

/** The ZIP's format, in its manifest. */
export const ZIP_FORMAT = "archon-backup/1";

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
  const k = (await run(["git", "config", "--get", "user.signingkey"])).stdout.trim();
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

/** The restore instructions: printed by `vault restore`, and RESTORE.txt in every ZIP. */
export function restoreText(fleets: string[] = []): string {
  const fl = fleets.length ? fleets.join(", ") : "<fleet>";
  return `How to restore an archon backup (by hand; no command does it for you)
==============================================================================

This ZIP holds what a boot machine needs again after a disaster:
  secrets/<fleet>/...   each fleet's secrets (${fl}): the admin password's hash,
                        each server's SSH host keys and deploy key, the Cloudflare
                        tokens (mail.json, web.json), carried certificates
  signing/...           your signing key (both halves; the private half is still
                        locked by its passphrase, which is not in here)
  manifest.json         every file's name, size, and SHA-256

On the new or rebuilt PC (Windows, in PowerShell):

 1. Install Deno, Git, and gh (GitHub's command line), sign in: gh auth login
 2. Clone your fleet repository, for example:
        git clone https://github.com/<owner>/<fleet repository>.git C:\\fleet
 3. Unzip this file somewhere private, for example your Desktop.
 4. Put the secrets back, only readable by you:
        New-Item -ItemType Directory -Force $env:APPDATA\\archon\\secrets
        Copy-Item -Recurse <unzipped>\\secrets\\* $env:APPDATA\\archon\\secrets\\
        icacls $env:APPDATA\\archon\\secrets /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F"
    (Linux: mkdir -p ~/.config/archon/secrets && cp -r <unzipped>/secrets/* ~/.config/archon/secrets/
     && chmod -R go-rwx ~/.config/archon)
 5. Put your signing key back and tell Git to use it:
        Copy-Item <unzipped>\\signing\\* $HOME\\.ssh\\
        git config --global gpg.format ssh
        git config --global user.signingkey $HOME\\.ssh\\<the key's file name, without .pub>
        git config --global commit.gpgsign true
 6. Delete the unzipped folder (the ZIP itself stays wherever you keep it safe).
 7. Check, in the fleet repository:
        deno task boot vault status      every secret, back where it belongs
        deno task archon                 where you are, and what next
        deno task archon signers         your signing works

If your daily signing key itself was lost (not in any backup), use your recovery key
(kept apart) to add a new daily key: deno task archon signers add ... in a commit
signed with the recovery key. See the engine's docs/disaster-recovery.md.
`;
}

/** Write the backup ZIP, read it back, and record it; returns its path and manifest. */
export async function writeBackupZip(
  pc: string,
  now = new Date(),
): Promise<{ path: string; manifest: ZipManifest; signingKey?: string; fleets: string[] }> {
  const { entries: secrets, active } = await secretEntries();
  const { entries: signing, key } = await signingEntries();
  const fleets = [...new Set(secrets.map((e) => e.name.split("/")[1]))].sort();
  const files = [...secrets, ...signing];
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
    "RESTORE.txt": enc.encode(restoreText(fleets.length ? fleets : listFleets(P.repo))),
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
  const path = join(BACKUP_DIR, `archon-backup-${pc}-${stamp}.zip`);
  await Deno.writeFile(path, zip, { mode: 0o600 });
  if (Deno.build.os === "windows") await ownerOnly(path);
  else await Deno.chmod(path, 0o600);
  await markBackedUp(path.split(/[\\/]/).pop()!, active, manifest.created, BACKUP_DIR);
  return { path, manifest, ...(key ? { signingKey: key } : {}), fleets };
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
      if (!e.isFile || !/^archon-backup-.*\.zip$/.test(e.name)) continue;
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
