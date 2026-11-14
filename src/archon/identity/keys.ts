/**
 * Spec 057: your signing keys, checked and fixed by one command. This module
 * gathers the facts (no prompt, nothing written) and turns them into checks,
 * each with a stable code (`archon explain E057-...`) and the one command
 * that fixes it. `stolos keys`, `stolos keys setup`, `boot doctor`, `archon`
 * (where am I), and `stolos signers` all use the same checks.
 *
 * Two keys, both OpenSSH ed25519 key pairs (spec 047):
 * - the **daily** key (`~/.ssh/fleet-signing`) signs your commits; it stays on
 *   this PC, locked by a passphrase you type each time, never in an ssh-agent;
 * - the **recovery** key replaces a lost daily key; it is made once and kept
 *   apart (never on this PC, never in the backup ZIP).
 *
 * ```mermaid
 * flowchart LR
 *   facts["collectKeyFacts()<br/>files, Git settings, signers.ts,<br/>ssh-agent, the pre-push check"] --> checks["keyChecks()<br/>ok, or a problem with<br/>its code and its fix"]
 *   checks --> keys["stolos keys"]
 *   checks --> doctor["boot doctor"]
 *   checks --> where["archon (where am I)"]
 *   checks --> signers["stolos signers"]
 * ```
 *
 * @module
 */

import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { P } from "../core/paths.ts";
import type { SignerDef } from "../model/types.ts";
import { allowedSignersText, loadSigners } from "./signers.ts";

/** How long a recovery check counts, in days (about six months). */
export const RECOVERY_CHECK_DAYS = 183;

/** OpenSSH's first version with `ssh-keygen -Y sign` (Git's SSH signing needs it). */
export const MIN_OPENSSH: [number, number] = [8, 2];

/** Where this PC's keys and their settings live. */
export interface KeyPaths {
  /** Your home folder. */
  home: string;
  /** The daily key's private file (its public half is the same path plus .pub). */
  daily: string;
  /**
   * This PC's key store (%APPDATA%\\stolos\\keys; ~/.config/stolos/keys): where the
   * recovery key lives, beside the secrets, so every backup ZIP holds it.
   */
  recoveryDir: string;
  /** The recovery key's private file, in the key store. */
  recovery: string;
  /** Where earlier versions left the recovery key (Desktop or home, fleet-recovery): moved into the store by vault backup. */
  looseRecoveryDir: string;
  /** Git's allowed signers for this checkout (so `git log --show-signature` works). */
  allowedSigners: string;
  /** This PC's record of key checks (when the recovery key was last checked). */
  state: string;
  /** The checkout's pre-push hook. */
  hook: string;
}

/** The user's home folder (HOME, or USERPROFILE on Windows). */
export function homeFolder(): string {
  return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
}

/** This PC's key paths; the daily key is Git's signing key when one is set. */
export function keyPaths(signingKey = "", repo = P.repo): KeyPaths {
  const home = homeFolder();
  const desktop = join(home, "Desktop");
  let hasDesktop = false;
  try {
    hasDesktop = Deno.statSync(desktop).isDirectory;
  } catch { /* none */ }
  // Spec 057: the recovery key lives in the key store, beside the secrets, so that every
  // backup holds 100% of what a disaster needs (both keys, each locked by its passphrase).
  const recoveryDir = join(P.secrets, "..", "..", "keys");
  const looseRecoveryDir = join(hasDesktop ? desktop : home, "fleet-recovery");
  return {
    home,
    daily: signingKey && !signingKey.startsWith("key::")
      ? signingKey.replace(/\.pub$/, "")
      : join(home, ".ssh", "fleet-signing"),
    recoveryDir,
    recovery: join(recoveryDir, "fleet-recovery"),
    looseRecoveryDir,
    allowedSigners: join(repo, ".git", "stolos", "allowed_signers"),
    state: join(P.bootCache, "..", "keys", "state.json"),
    hook: join(repo, ".git", "hooks", "pre-push"),
  };
}

/** This PC's record of key checks. */
export interface KeyState {
  /** When the recovery key was last proven to work (ISO time). */
  recoveryCheckedAt?: string;
  /** When the last "check your recovery key" email went out (ISO time). */
  recoveryRemindedAt?: string;
}

/** Read this PC's record of key checks ({} when there is none). */
export async function readKeyState(path = keyPaths().state): Promise<KeyState> {
  try {
    return JSON.parse((await readTextOr(path)) ?? "{}") as KeyState;
  } catch {
    return {};
  }
}

/** Write this PC's record of key checks. */
export async function writeKeyState(s: KeyState, path = keyPaths().state): Promise<void> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(s, null, 2) + "\n");
}

/** A public key's "type base64" (the comment dropped), or undefined. */
export function pubOf(text: string | undefined): string | undefined {
  const parts = text?.trim().split(/\s+/) ?? [];
  const typed = parts[0]?.startsWith("ssh-") || parts[0]?.startsWith("sk-ssh-");
  return parts.length >= 2 && typed ? parts.slice(0, 2).join(" ") : undefined;
}

/** The OpenSSH version from `ssh -V` ("OpenSSH_9.6p1 ..."), or undefined. */
export function parseOpenSshVersion(text: string): [number, number] | undefined {
  const m = text.match(/OpenSSH[_a-zA-Z]*_(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** Whether a version is at least {@link MIN_OPENSSH}. */
export function opensshOk(v: [number, number] | undefined): boolean {
  return !!v && (v[0] > MIN_OPENSSH[0] || (v[0] === MIN_OPENSSH[0] && v[1] >= MIN_OPENSSH[1]));
}

/** The signers in a signers.ts text in its fixed form (from any commit, without running it). */
export function parseSignersSource(text: string): SignerDef[] {
  const out: SignerDef[] = [];
  const re =
    /name:\s*"([^"]+)",\s*role:\s*"(daily|recovery)",\s*key:\s*"([^"]+)",\s*added:\s*"([^"]*)"/g;
  for (const m of text.matchAll(re)) {
    out.push({ name: m[1], role: m[2] as SignerDef["role"], key: m[3], added: m[4] });
  }
  return out;
}

/** Everything the checks look at, gathered without a prompt and without writing anything. */
export interface KeyFacts {
  /** The paths in use. */
  paths: KeyPaths;
  /** The checkout is a Git repository. */
  repo: boolean;
  /** The active fleet's id ("" when none). */
  fleetId: string;
  /** OpenSSH: found, its version, and whether it can sign. */
  ssh: { found: boolean; version?: string; ok: boolean };
  /** The daily key: whether its private file exists, its public key, passphrase, ssh-agent. */
  daily: { exists: boolean; pub?: string; passphrase?: boolean; inAgent?: boolean };
  /** Git's effective settings in this checkout. */
  git: { format: string; signingKey: string; gpgsign: string; allowedSignersFile: string };
  /** The allowed signers file matches signers.ts. */
  allowedSignersCurrent: boolean;
  /** The fleet's signers (signers.ts in the working tree). */
  signers: SignerDef[];
  /** The signer whose key is this PC's daily key, if listed. */
  dailySigner?: SignerDef;
  /** Private files of a listed recovery key outside the key store (not in backups until vault backup moves them). */
  recoveryLoose: string[];
  /** A listed recovery key's private file is in the key store (so every backup holds it). */
  recoveryInStore: boolean;
  /** The pre-push check is installed. */
  hook: boolean;
  /** This PC's record of key checks. */
  state: KeyState;
}

/** The pre-push hook archon installs (spec 057 checks signatures; spec 029 reminds about backups). */
export const PRE_PUSH_HOOK = `#!/bin/sh
# Installed by archon (specs 029 and 057). Checks that what you push is signed
# by a key the fleet trusts, so servers will accept it; then reminds you to back
# up when a secret changed. Skip it once with: git push --no-verify
deno task stolos keys check-push || exit 1
deno task stolos vault status --hook >&2 || true
exit 0
`;

/** Whether the private file at `path` is locked by a passphrase (no prompt: an empty one is tried). */
export async function hasPassphrase(path: string): Promise<boolean> {
  const r = await run(["ssh-keygen", "-y", "-P", "", "-f", path]);
  return !r.ok;
}

/** Private key files next to .pub files under `dirs` whose public key is one of `pubs`. */
async function privateFilesFor(pubs: string[], dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const d of dirs) {
    let entries: Deno.DirEntry[] = [];
    try {
      entries = [...Deno.readDirSync(d)];
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile || !e.name.endsWith(".pub")) continue;
      const pub = pubOf(await readTextOr(join(d, e.name)));
      const priv = join(d, e.name.slice(0, -4));
      if (pub && pubs.includes(pub) && (await exists(priv))) out.push(priv);
    }
  }
  return out.sort();
}

/** Gather the facts (no prompt; nothing is written). */
export async function collectKeyFacts(repo = P.repo): Promise<KeyFacts> {
  const git = (args: string[]) => run(["git", "-C", repo, ...args]);
  const cfg = async (k: string) => (await git(["config", "--get", k])).stdout.trim();
  const isRepo = (await git(["rev-parse", "--git-dir"])).ok;
  const g = {
    format: await cfg("gpg.format"),
    signingKey: await cfg("user.signingkey"),
    gpgsign: await cfg("commit.gpgsign"),
    allowedSignersFile: await cfg("gpg.ssh.allowedSignersFile"),
  };
  const paths = keyPaths(g.signingKey, repo);
  const v = await run(["ssh", "-V"]);
  const version = parseOpenSshVersion(v.stderr + v.stdout);
  const ssh = {
    found: v.ok || /OpenSSH/.test(v.stderr),
    ...(version ? { version: version.join(".") } : {}),
    ok: opensshOk(version),
  };
  const dailyExists = await exists(paths.daily);
  const pub = pubOf(await readTextOr(paths.daily + ".pub"));
  const daily: KeyFacts["daily"] = { exists: dailyExists, ...(pub ? { pub } : {}) };
  if (dailyExists) {
    daily.passphrase = await hasPassphrase(paths.daily);
    if (pub) {
      const agent = await run(["ssh-add", "-L"]);
      daily.inAgent = agent.ok && agent.stdout.includes(pub);
    }
  }
  const signers = await loadSigners().catch(() => [] as SignerDef[]);
  const allowed = (await readTextOr(paths.allowedSigners)) ?? "";
  const recoveryPubs = signers.filter((s) => s.role === "recovery").map((s) => s.key.trim());
  return {
    paths,
    repo: isRepo,
    fleetId: P.fleetId,
    ssh,
    daily,
    git: g,
    allowedSignersCurrent: allowed === allowedSignersText(signers),
    signers,
    ...(pub ? { dailySigner: signers.find((s) => s.key.trim() === pub) } : {}),
    recoveryLoose: await privateFilesFor(recoveryPubs, [
      join(paths.home, ".ssh"),
      paths.looseRecoveryDir,
    ]),
    recoveryInStore: (await privateFilesFor(recoveryPubs, [paths.recoveryDir])).length > 0,
    hook: (await readTextOr(paths.hook)) === PRE_PUSH_HOOK,
    state: await readKeyState(paths.state),
  };
}

/** One check of your keys. */
export interface KeyCheck {
  /** Its stable code (archon explain <code>). */
  code: string;
  /** Whether all is well. */
  ok: boolean;
  /** How bad a problem is: fail (signing does not work, or is unsafe) or warn. */
  level: "fail" | "warn";
  /** What it found, in plain words. */
  what: string;
  /** The one command (or step) that fixes it. */
  fix: string;
}

const SETUP = "deno task stolos keys setup";

/** The checks, in the order to fix them; `now` is for the recovery check's age. */
export function keyChecks(f: KeyFacts, now = Date.now()): KeyCheck[] {
  const out: KeyCheck[] = [];
  const add = (code: string, ok: boolean, level: KeyCheck["level"], what: string, fix: string) =>
    out.push({ code, ok, level, what, fix });
  add(
    "E057-SSH",
    f.ssh.ok,
    "fail",
    f.ssh.ok
      ? `OpenSSH ${f.ssh.version} can sign`
      : f.ssh.found
      ? `OpenSSH ${f.ssh.version ?? "(unknown version)"} is too old to sign commits (8.2 or newer)`
      : "OpenSSH (ssh, ssh-keygen) is not installed",
    Deno.build.os === "windows"
      ? "Settings > System > Optional features > OpenSSH Client, or: winget install Microsoft.OpenSSH.Preview"
      : Deno.build.os === "darwin"
      ? "brew install openssh"
      : "sudo apt install -y openssh-client",
  );
  add(
    "E057-NO-KEY",
    f.daily.exists && !!f.daily.pub,
    "fail",
    f.daily.exists
      ? f.daily.pub ? `your daily signing key: ${f.paths.daily}` : `${f.paths.daily}.pub is missing`
      : `no daily signing key at ${f.paths.daily}`,
    SETUP,
  );
  if (f.daily.exists) {
    add(
      "E057-NO-PASSPHRASE",
      f.daily.passphrase === true,
      "fail",
      f.daily.passphrase
        ? "it is locked by a passphrase"
        : "it has NO passphrase: anyone who copies the file can approve changes",
      `ssh-keygen -p -f ${f.paths.daily}`,
    );
    add(
      "E057-AGENT",
      !f.daily.inAgent,
      "fail",
      f.daily.inAgent
        ? "it is loaded in an ssh-agent: anything running as you could sign without asking"
        : "it is not in an ssh-agent (each signature asks for your passphrase)",
      `ssh-add -d ${f.paths.daily}`,
    );
  }
  const gitOk = f.repo && f.git.format === "ssh" && f.git.gpgsign === "true" &&
    f.git.signingKey.replace(/\.pub$/, "") === f.paths.daily &&
    f.git.allowedSignersFile === f.paths.allowedSigners && f.allowedSignersCurrent;
  add(
    "E057-GIT",
    gitOk,
    "fail",
    gitOk
      ? "Git signs every commit here with it"
      : !f.repo
      ? "this folder is not a Git checkout of the fleet repository"
      : f.git.gpgsign !== "true" || f.git.format !== "ssh"
      ? "Git does not sign your commits here: servers would refuse them"
      : "Git's signing settings here are not the ones archon expects",
    SETUP,
  );
  add(
    "E057-NOT-LISTED",
    !!f.dailySigner,
    "fail",
    f.dailySigner
      ? `signers.ts lists it as ${f.dailySigner.name} (${f.dailySigner.role})`
      : f.daily.pub
      ? "signers.ts does not list your daily key: servers would refuse your commits"
      : "signers.ts cannot list a daily key that does not exist yet",
    SETUP,
  );
  const recovery = f.signers.filter((s) => s.role === "recovery");
  add(
    "E057-NO-RECOVERY",
    recovery.length > 0,
    "warn",
    recovery.length
      ? `recovery key: ${recovery.map((s) => s.name).join(", ")}`
      : "no recovery key: losing the daily key would freeze the fleet",
    SETUP,
  );
  if (recovery.length) {
    add(
      "E057-RECOVERY-LOOSE",
      f.recoveryLoose.length === 0,
      "warn",
      f.recoveryLoose.length
        ? `the recovery key is outside the key store, so backups miss it: ${
          f.recoveryLoose.join(", ")
        }`
        : "the recovery key is in the key store (every backup holds it)",
      "deno task stolos vault backup (it backs the key up, then moves it into the key store)",
    );
    if (!f.recoveryLoose.length) {
      add(
        "E057-RECOVERY-MISSING",
        f.recoveryInStore,
        "warn",
        f.recoveryInStore
          ? `the recovery key is in ${f.paths.recoveryDir}`
          : `the recovery key's private file is not in ${f.paths.recoveryDir}: backups cannot hold it`,
        `put it back from your latest backup ZIP (signing/recovery/), or make a new one: deno task stolos keys rotate-recovery --old-lost`,
      );
    }
    const at = f.state.recoveryCheckedAt ? Date.parse(f.state.recoveryCheckedAt) : 0;
    const fresh = now - at < RECOVERY_CHECK_DAYS * 86_400_000;
    add(
      "E057-RECOVERY-CHECK",
      fresh,
      "warn",
      fresh
        ? `the recovery key was checked on ${f.state.recoveryCheckedAt!.slice(0, 10)}`
        : at
        ? `the recovery key was last checked on ${
          f.state.recoveryCheckedAt!.slice(0, 10)
        } (over six months ago)`
        : "the recovery key has never been checked here",
      "deno task stolos keys check-recovery",
    );
  }
  add(
    "E057-HOOK",
    f.hook,
    "warn",
    f.hook
      ? "every push is checked here first (pre-push)"
      : "pushes are not checked here first: a commit servers refuse is only found after the push",
    SETUP,
  );
  return out;
}

/** The problems only, in order. */
export function keyProblems(checks: KeyCheck[]): KeyCheck[] {
  return checks.filter((c) => !c.ok);
}
