/**
 * Spec 061: `deno task stolos vault restore <zip>` makes a freshly cloned PC
 * the boot machine again from one backup ZIP (spec 056). It reads the ZIP and
 * checks every file against its manifest, puts each file back where stolos
 * keeps it (the secrets, readable by you only; the daily key in `.ssh`; the
 * recovery key in the key store), records the ZIP as the last backup, then
 * runs `keys setup` (Git's signing for this checkout, and one test signature:
 * your daily passphrase) and gets VS Code its types.
 *
 * It never overwrites: a file already there with the same bytes is kept, and a
 * file that differs stops the restore before anything is written (it may be
 * newer than the backup). So it can be run again, and changes nothing the
 * second time.
 *
 * ```mermaid
 * flowchart LR
 *   zip["backup ZIP"] --> check["read it: format, every SHA-256"]
 *   check --> fleet["the fleet: one of this repository's"]
 *   fleet --> files["put files back<br/>(never overwrite)"]
 *   files --> keys["keys setup<br/>(one test signature)"]
 *   keys --> editor["VS Code's types"]
 * ```
 *
 * @module
 */

import { unzipSync } from "npm:fflate@0.8.2";
import { join } from "../core/path.ts";
import { exists } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { listFleets, P } from "../core/paths.ts";
import { ownerOnly } from "../core/secrets.ts";
import { ui } from "../core/ui.ts";
import { markBackedUp, sha256 } from "./state.ts";
import { ZIP_FORMAT, type ZipManifest } from "./zip.ts";

/** Where restored files go: the secrets root (holds one folder per fleet), `.ssh`, and the key store. */
export interface RestoreRoots {
  /** The folder holding `<fleet>/...` secrets. */
  secrets: string;
  /** The daily key's folder (`~/.ssh`). */
  ssh: string;
  /** The key store (the recovery key, and any retired one). */
  keys: string;
}

/** This PC's {@link RestoreRoots}. */
export async function restoreRoots(): Promise<RestoreRoots> {
  const { homeFolder, keyPaths } = await import("../identity/keys.ts");
  return {
    secrets: join(P.secrets, ".."),
    ssh: join(homeFolder(), ".ssh"),
    keys: keyPaths().recoveryDir,
  };
}

/** One file of the ZIP and where it goes. */
export interface RestoreFile {
  /** Its path in the ZIP. */
  name: string;
  /** Where it goes on this PC. */
  to: string;
  /** Its bytes. */
  data: Uint8Array<ArrayBuffer>;
  /** A private file (owner only); public halves (`.pub`) are not. */
  secret: boolean;
  /** "new": not here yet; "same": already here, identical; "differs": here, with other bytes. */
  state: "new" | "same" | "differs";
}

/** A checked backup ZIP, and what restoring it would do. */
export interface RestorePlan {
  /** The ZIP's manifest. */
  manifest: ZipManifest;
  /** The fleets it holds secrets for. */
  fleets: string[];
  /** Every file, with where it goes. */
  files: RestoreFile[];
  /** The daily key's private file name (under signing/), when the ZIP has one. */
  daily?: string;
  /** Whether it holds a recovery key's private half. */
  recovery: boolean;
}

/** A name safe to join under a folder: no empty part, no `.` or `..`, no drive or root. */
const safePart = (p: string) => p !== "" && p !== "." && p !== ".." && !/[:\\]/.test(p);

/** Where a ZIP entry goes (undefined: not one restore knows). */
export function targetOf(
  name: string,
  roots: RestoreRoots,
): { to: string; fleet?: string } | undefined {
  const parts = name.split("/");
  if (!parts.every(safePart)) return undefined;
  if (parts[0] === "secrets" && parts.length >= 3) {
    return { to: join(roots.secrets, ...parts.slice(1)), fleet: parts[1] };
  }
  if (parts[0] === "signing" && parts.length === 2) return { to: join(roots.ssh, parts[1]) };
  if (parts[0] === "signing" && parts[1] === "recovery" && parts.length === 3) {
    return { to: join(roots.keys, parts[2]) };
  }
  return undefined;
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Read a backup ZIP, check it (its format, every file against the manifest's
 * SHA-256, no file the manifest does not name), and work out where each file
 * goes and whether it is already there. Writes nothing; throws with the reason.
 */
export async function planRestore(zipPath: string, roots: RestoreRoots): Promise<RestorePlan> {
  let raw: Uint8Array;
  try {
    raw = await Deno.readFile(zipPath);
  } catch {
    throw new Error(`cannot read ${zipPath}`);
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(raw);
  } catch {
    throw new Error(`${zipPath} is not a ZIP file (or is damaged)`);
  }
  let manifest: ZipManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
  } catch {
    throw new Error(`${zipPath} has no manifest.json: not a stolos backup`);
  }
  if (manifest.format !== ZIP_FORMAT || !Array.isArray(manifest.files)) {
    throw new Error(`${zipPath} is not a stolos backup (format ${manifest.format ?? "unknown"})`);
  }
  const files: RestoreFile[] = [];
  const fleets = new Set<string>();
  for (const f of manifest.files) {
    const data = entries[f.name];
    if (!data) throw new Error(`the backup is incomplete: ${f.name} is missing`);
    const bytes = new Uint8Array(data);
    if ((await sha256(bytes)) !== f.sha256) {
      throw new Error(`the backup is damaged: ${f.name} does not match its SHA-256`);
    }
    const t = targetOf(f.name, roots);
    if (!t) throw new Error(`the backup holds ${f.name}, which stolos does not restore`);
    if (t.fleet) fleets.add(t.fleet);
    let state: RestoreFile["state"] = "new";
    if (await exists(t.to)) state = same(await Deno.readFile(t.to), bytes) ? "same" : "differs";
    files.push({ name: f.name, to: t.to, data: bytes, secret: !f.name.endsWith(".pub"), state });
  }
  const daily = files.find((f) => /^signing\/[^/]+$/.test(f.name) && f.secret)?.name.slice(8);
  return {
    manifest,
    fleets: [...fleets].sort(),
    files,
    ...(daily ? { daily } : {}),
    recovery: files.some((f) => f.name.startsWith("signing/recovery/") && f.secret),
  };
}

/** Write one restored file: its folder private, the file readable by its owner only when private. */
async function put(f: RestoreFile): Promise<void> {
  const dir = join(f.to, "..");
  await Deno.mkdir(dir, { recursive: true });
  if (Deno.build.os !== "windows") await Deno.chmod(dir, 0o700).catch(() => {});
  await Deno.writeFile(f.to, f.data, { mode: f.secret ? 0o600 : 0o644 });
  if (Deno.build.os !== "windows") await Deno.chmod(f.to, f.secret ? 0o600 : 0o644);
  else if (f.secret) await ownerOnly(f.to); // OpenSSH refuses a private key others can read
}

/** Put back every file not already there (nothing, when any differs); returns how many were written. */
export async function applyRestore(plan: RestorePlan): Promise<number> {
  if (plan.files.some((f) => f.state === "differs")) return 0;
  let n = 0;
  for (const f of plan.files.filter((f) => f.state === "new")) {
    await put(f);
    n++;
  }
  return n;
}

const done = (): number => ui.problems.some((x) => x.level === "fail") ? 1 : 0;

/**
 * `vault restore <zip>`: check the ZIP, choose the fleet, put the files back,
 * then (unless --files-only) set up signing and VS Code. Without a ZIP: the
 * steps, to read (they are RESTORE.txt in every ZIP too).
 */
export async function vaultRestoreZip(
  zip: string,
  o: { filesOnly?: boolean } = {},
): Promise<number> {
  const name = zip.split(/[\\/]/).pop()!;

  // 1. The ZIP, read and checked before anything is written.
  const b = ui.phase("Backup");
  b.status(`reading ${name}`);
  let plan: RestorePlan;
  try {
    plan = await planRestore(zip, await restoreRoots());
  } catch (e) {
    b.fail(
      (e as Error).message,
      "give the path of a backup ZIP from deno task stolos vault backup",
    );
    return done();
  }
  b.done(
    `${plan.files.length} files from ${plan.manifest.pc}, made ${
      new Date(plan.manifest.created).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    }; every SHA-256 checked`,
  );

  // 2. The fleet: the backup must be for this repository.
  const f = ui.phase("Fleet");
  const here = listFleets(P.repo);
  const common = plan.fleets.filter((x) => here.includes(x));
  if (!here.length) {
    f.fail(
      `${P.repo} holds no fleet`,
      "clone your fleet repository, cd into it (for example C:\\fleet), then run this again",
    );
    return done();
  }
  if (plan.fleets.length && !common.length) {
    f.fail(
      `the backup is for ${plan.fleets.join(", ")}; this repository has ${here.join(", ")}`,
      "run this in the fleet repository the backup was made for",
    );
    return done();
  }
  if (!P.fleetId && common.length === 1) {
    const { chooseFleet } = await import("../fleet/use.ts");
    if ((await chooseFleet(common[0])) === "chosen") f.note(`now using fleet ${common[0]} here`);
  }
  if (!P.fleetId) {
    f.warn(
      `several fleets here (${here.join(", ")}) and none chosen`,
      `deno task stolos fleet use <id>, then run this again`,
    );
    return done();
  }
  f.done(
    plan.fleets.length
      ? `${P.fleetId} (the backup holds ${plan.fleets.join(", ")})`
      : `${P.fleetId} (the backup holds keys only)`,
  );

  // 3. The files: never overwrite.
  const w = ui.phase("Files");
  const differs = plan.files.filter((x) => x.state === "differs");
  if (differs.length) {
    const shown = differs.slice(0, 5).map((x) => x.to);
    w.fail(
      `${differs.length} file(s) already here differ from the backup (nothing was written): ${
        shown.join(", ")
      }${differs.length > shown.length ? ", ..." : ""}`,
      "they may be newer than the backup: keep them (no restore needed), or move them aside and run this again",
    );
    return done();
  }
  const written = await applyRestore(plan);
  const kept = plan.files.length - written;
  w.done(
    `${written} put back${kept ? `, ${kept} already here` : ""}: secrets in ${
      join(P.secrets, "..")
    }, keys in .ssh and the key store`,
  );
  // The ZIP holds every secret as it is now: it counts as the last backup.
  const prefix = `secrets/${P.fleetId}/`;
  const names = Object.fromEntries(
    plan.manifest.files.filter((x) => x.name.startsWith(prefix)).map((x) => [
      x.name.slice(prefix.length),
      x.sha256,
    ]),
  );
  await markBackedUp(name, names, plan.manifest.created);
  if (!plan.daily) {
    w.warn(
      "the backup holds no daily key",
      "keys setup makes a new one; a key already listed must approve it",
    );
  }

  if (o.filesOnly) {
    ui.next.push("set up signing: deno task stolos keys setup");
    ui.next.push("then check everything: deno task stolos boot doctor");
    return done();
  }

  // 4. Signing, for this checkout: Git uses the restored daily key.
  if (plan.daily && plan.daily !== "fleet-signing") {
    const set = await run(["git", "-C", P.repo, "config", "--local", "--get", "user.signingkey"]);
    if (!set.stdout.trim()) {
      const to = plan.files.find((x) => x.name === `signing/${plan.daily}`)!.to;
      await run(["git", "-C", P.repo, "config", "--local", "user.signingkey", to]);
    }
  }
  const { keysSetup } = await import("../identity/keys-commands.ts");
  await keysSetup();
  if (plan.daily && plan.recovery) {
    // Both keys came from the backup: nothing new to back up.
    ui.next = ui.next.filter((l) => !l.startsWith("back up:"));
  }

  // 5. VS Code: the engine's types.
  const e = ui.phase("Editor");
  const { cacheEngine } = await import("../fleet/scaffold.ts");
  const c = await cacheEngine(P.repo);
  if (c.ok) e.done("VS Code has the engine's types");
  else e.warn(`could not download the engine: ${c.why}`, "deno task stolos update");

  ui.next.push("check everything: deno task stolos boot doctor");
  ui.next.push(
    "keep the ZIP where you keep it safe; delete any copy you unzipped. If this PC replaces the boot machine: its address and firewall (docs/disaster-recovery.md)",
  );
  return done();
}
