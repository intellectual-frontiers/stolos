/**
 * Spec 061: `bun run stolos vault restore <zip>` makes a freshly cloned PC
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
 * `--destroy-existing` restores clean instead: the secrets of every fleet, the
 * key store, and the backup's daily key files in `.ssh` are removed first, so
 * what is left is exactly the backup. Anything there that the backup does not
 * hold identically is first saved as a backup ZIP of its own (nothing is lost),
 * and only after the ZIP to restore has been read and checked.
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
// Spec: 056-zip-backup
// Spec: 061-vault-restore

import { formatDecodeError, json } from "@intellectual-frontiers/core";
import { sha256, unzip } from "@intellectual-frontiers/commons/ts/kernel";
import { errors, fs, path as paths, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import { listFleets, P } from "../core/paths.ts";
import { ownerOnly } from "../core/secrets.ts";
import { ui } from "../core/ui.ts";
import { markBackedUp } from "./state.ts";
import { ZIP_FORMAT, zipManifest, type ZipManifest } from "./zip.ts";

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
    secrets: paths.join(P.secrets, ".."),
    ssh: paths.join(homeFolder(), ".ssh"),
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
  data: Uint8Array;
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
  const [top, second, third] = parts;
  if (top === "secrets" && second !== undefined && parts.length >= 3) {
    return { to: paths.join(roots.secrets, ...parts.slice(1)), fleet: second };
  }
  if (top === "signing" && second !== undefined && parts.length === 2) {
    return { to: paths.join(roots.ssh, second) };
  }
  if (top === "signing" && second === "recovery" && third !== undefined && parts.length === 3) {
    return { to: paths.join(roots.keys, third) };
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
    raw = await fs.readFile(zipPath);
  } catch {
    throw new Error(`cannot read ${zipPath}`);
  }
  const unzipped = await unzip(raw);
  if (unzipped.kind === "err") throw new Error(`${zipPath} is not a ZIP file (or is damaged)`);
  const entries = unzipped.value;
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new Error(`${zipPath} has no manifest.json: not a stolos backup`);
  const decoded = json(new TextDecoder().decode(manifestBytes), zipManifest);
  if (decoded.kind === "err") {
    throw new Error(
      `${zipPath} is not a stolos backup (its manifest.json: ${formatDecodeError(decoded.error)})`,
    );
  }
  const manifest: ZipManifest = decoded.value;
  if (manifest.format !== ZIP_FORMAT) {
    throw new Error(`${zipPath} is not a stolos backup (format ${manifest.format})`);
  }
  const files: RestoreFile[] = [];
  const fleets = new Set<string>();
  for (const f of manifest.files) {
    const bytes = entries.get(f.name);
    if (!bytes) throw new Error(`the backup is incomplete: ${f.name} is missing`);
    if ((await sha256(bytes)) !== f.sha256) {
      throw new Error(`the backup is damaged: ${f.name} does not match its SHA-256`);
    }
    const t = targetOf(f.name, roots);
    if (!t) throw new Error(`the backup holds ${f.name}, which stolos does not restore`);
    if (t.fleet) fleets.add(t.fleet);
    let state: RestoreFile["state"] = "new";
    if (await fs.exists(t.to)) state = same(await fs.readFile(t.to), bytes) ? "same" : "differs";
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
  const dir = paths.join(f.to, "..");
  await fs.mkdir(dir, { recursive: true });
  if (proc.build.os !== "windows") await fs.chmod(dir, 0o700).catch(() => {});
  await fs.writeFile(f.to, f.data, { mode: f.secret ? 0o600 : 0o644 });
  if (proc.build.os !== "windows") await fs.chmod(f.to, f.secret ? 0o600 : 0o644);
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

/** Every file a clean restore removes: the secrets of every fleet, the key store, the backup's .ssh files. */
export async function existingFiles(plan: RestorePlan, roots: RestoreRoots): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    try {
      for await (const e of fs.readDir(d)) {
        const p = paths.join(d, e.name);
        if (e.isDirectory) await walk(p);
        else out.push(p);
      }
    } catch {
      /* not there */
    }
  };
  await walk(roots.secrets);
  await walk(roots.keys);
  for (const f of plan.files) {
    if (f.to.startsWith(roots.ssh) && (await fs.exists(f.to))) out.push(f.to);
  }
  return out.sort();
}

/**
 * Remove what a clean restore replaces (see {@link existingFiles}), and forget
 * the secrets' change history; returns how many files went. A key file in
 * `.ssh` that differs from the backup is moved aside (`<file>.replaced-<date>`),
 * never deleted; no other file in `.ssh` (a GitHub key, say) is touched.
 */
export async function destroyExisting(
  plan: RestorePlan,
  roots: RestoreRoots,
  now = new Date(),
): Promise<{ removed: number; movedAside: string[] }> {
  const removed = (await existingFiles(plan, roots)).length;
  for (const d of [roots.secrets, roots.keys]) {
    try {
      await fs.remove(d, { recursive: true });
    } catch (e) {
      if (!(e instanceof errors.NotFound)) throw e; // already gone is fine; anything else is not
    }
  }
  const movedAside: string[] = [];
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  for (const f of plan.files) {
    if (!f.to.startsWith(roots.ssh) || !(await fs.exists(f.to))) continue;
    if (f.state === "differs") {
      await fs.rename(f.to, `${f.to}.replaced-${stamp}`);
      movedAside.push(`${f.to}.replaced-${stamp}`);
    } else await fs.remove(f.to);
  }
  const { writeLedger } = await import("../core/secret-ledger.ts");
  await writeLedger({ changes: {} });
  for (const f of plan.files) f.state = "new";
  return { removed, movedAside };
}

const done = (): number => (ui.problems.some((x) => x.level === "fail") ? 1 : 0);

/**
 * `vault restore <zip>`: check the ZIP, choose the fleet, put the files back,
 * then (unless --files-only) set up signing and VS Code. Without a ZIP: the
 * steps, to read (they are RESTORE.txt in every ZIP too).
 */
export async function vaultRestoreZip(
  zip: string,
  o: { filesOnly?: boolean; destroyExisting?: boolean } = {},
): Promise<number> {
  const name = zip.split(/[\\/]/).pop() ?? zip;
  const roots = await restoreRoots();

  // 1. The ZIP, read and checked before anything is written.
  const b = ui.phase("Backup");
  b.status(`reading ${name}`);
  let plan: RestorePlan;
  try {
    plan = await planRestore(zip, roots);
  } catch (e) {
    b.fail((e as Error).message, "give the path of a backup ZIP from bun run stolos vault backup");
    return done();
  }
  b.done(
    `${plan.files.length} files from ${plan.manifest.pc}, made ${new Date(
      plan.manifest.created,
    ).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    })}; every SHA-256 checked`,
  );

  // 2. The fleet: the backup must be for this repository.
  const f = ui.phase("Fleet");
  const here = listFleets(P.repo);
  const common = plan.fleets.filter((x) => here.includes(x));
  if (!here.length) {
    f.fail(
      `${P.repo} holds no fleet`,
      "clone your fleet repository, cd into it (for example $HOME\\fleet on Windows, ~/fleet elsewhere), then run this again",
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
  const [only] = common;
  if (!P.fleetId && only !== undefined && common.length === 1) {
    const { chooseFleet } = await import("../fleet/use.ts");
    if ((await chooseFleet(only)) === "chosen") f.note(`now using fleet ${only} here`);
  }
  if (!P.fleetId) {
    f.warn(
      `several fleets here (${here.join(", ")}) and none chosen`,
      `bun run stolos fleet use <id>, then run this again`,
    );
    return done();
  }
  f.done(
    plan.fleets.length
      ? `${P.fleetId} (the backup holds ${plan.fleets.join(", ")})`
      : `${P.fleetId} (the backup holds keys only)`,
  );

  // 3. A clean restore: what is here goes first (saved in a ZIP of its own when the backup lacks any of it).
  if (o.destroyExisting) {
    const x = ui.phase("Existing");
    const here = await existingFiles(plan, roots);
    const identical = new Set(plan.files.filter((f) => f.state === "same").map((f) => f.to));
    // .ssh files that differ are moved aside, not removed: only the rest needs saving first.
    const unique = here.filter((p) => !identical.has(p) && !p.startsWith(roots.ssh));
    let savedTo = "";
    if (unique.length) {
      x.status("saving what is here first");
      const { writeBackupZip } = await import("./zip.ts");
      const { pcName } = await import("./reminder.ts");
      try {
        const saved = await writeBackupZip(pcName());
        savedTo = saved.path;
      } catch (e) {
        x.fail(
          `could not save what is here first (${(e as Error).message}); nothing was removed`,
          "run this again, or without --destroy-existing",
        );
        return done();
      }
    }
    let gone: Awaited<ReturnType<typeof destroyExisting>>;
    try {
      gone = await destroyExisting(plan, roots);
    } catch (e) {
      x.fail(
        `could not remove what is here: ${(e as Error).message}`,
        "close anything using those files (an editor, a terminal in that folder), then run this again",
      );
      return done();
    }
    const { removed, movedAside } = gone;
    for (const m of movedAside) x.note(`a different key was moved aside: ${m}`);
    x.done(
      removed
        ? `removed ${removed - movedAside.length} file(s)${
            movedAside.length ? `, moved ${movedAside.length} aside` : ""
          }${
            savedTo ? ` (${unique.length} not in the backup as they were: saved in ${savedTo})` : ""
          }: secrets, the key store, the daily key in .ssh`
        : "nothing here: already clean",
    );
  }

  // 4. The files: never overwrite.
  const w = ui.phase("Files");
  const differs = plan.files.filter((x) => x.state === "differs");
  if (differs.length) {
    const shown = differs.slice(0, 5).map((x) => x.to);
    w.fail(
      `${differs.length} file(s) already here differ from the backup (nothing was written): ${shown.join(
        ", ",
      )}${differs.length > shown.length ? ", ..." : ""}`,
      "they may be newer than the backup: keep them (no restore needed), or restore clean: add --destroy-existing (what is here is saved first)",
    );
    return done();
  }
  const written = await applyRestore(plan);
  const kept = plan.files.length - written;
  w.done(
    `${written} put back${kept ? `, ${kept} already here` : ""}: secrets in ${paths.join(
      P.secrets,
      "..",
    )}, keys in .ssh and the key store`,
  );
  // The ZIP holds every secret as it is now: it counts as the last backup.
  const prefix = `secrets/${P.fleetId}/`;
  const names = Object.fromEntries(
    plan.manifest.files
      .filter((x) => x.name.startsWith(prefix))
      .map((x) => [x.name.slice(prefix.length), x.sha256]),
  );
  await markBackedUp(name, names, plan.manifest.created);
  if (!plan.daily) {
    w.warn(
      "the backup holds no daily key",
      "keys setup makes a new one; a key already listed must approve it",
    );
  }

  if (o.filesOnly) {
    ui.next.push("set up signing: bun run stolos keys setup");
    ui.next.push("then check everything: bun run stolos boot doctor");
    return done();
  }

  // 5. Signing, for this checkout: Git uses the restored daily key.
  if (plan.daily && plan.daily !== "fleet-signing") {
    const set = await run(["git", "-C", P.repo, "config", "--local", "--get", "user.signingkey"]);
    const to = plan.files.find((x) => x.name === `signing/${plan.daily}`)?.to;
    if (!set.stdout.trim() && to !== undefined) {
      await run(["git", "-C", P.repo, "config", "--local", "user.signingkey", to]);
    }
  }
  const { keysSetup } = await import("../identity/keys-commands.ts");
  await keysSetup();
  if (plan.daily && plan.recovery) {
    // Both keys came from the backup: nothing new to back up.
    ui.next = ui.next.filter((l) => !l.startsWith("back up:"));
  }

  // 6. VS Code: the engine's types.
  const e = ui.phase("Editor");
  const { installEngine } = await import("../fleet/scaffold.ts");
  const c = await installEngine(P.repo);
  if (c.ok) e.done("VS Code has the engine's types");
  else e.warn(`could not install the engine: ${c.why}`, "bun install --frozen-lockfile");

  ui.next.push("check everything: bun run stolos boot doctor");
  ui.next.push(
    "keep the ZIP where you keep it safe; delete any copy you unzipped. If this PC replaces the boot machine: its address and firewall (bun run stolos docs disaster-recovery)",
  );
  return done();
}
