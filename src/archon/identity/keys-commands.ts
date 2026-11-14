/**
 * Spec 057: `stolos keys`, every step of your signing keys in one place, and
 * idempotent: each command looks at what is already there, does only what is
 * missing, and can be run again at any time (after a failure, it continues).
 *
 * - `keys`: the checks (nothing changes).
 * - `keys setup`: tools, the daily key, Git's settings, signers.ts, the
 *   recovery key, the pre-push check, and a test signature.
 * - `keys check-recovery --key <file>`: proves the recovery key still works.
 * - `keys rotate`: a new daily key, approved by the old one.
 * - `keys lost --recovery <file>`: a new daily key, approved by the recovery key.
 * - `keys check-push`: the pre-push check (Git runs it).
 *
 * Passphrases are typed into OpenSSH and Git themselves: archon never sees,
 * stores, or passes one, and never loads a key into an ssh-agent. None of these
 * commands is offered over MCP.
 *
 * ```mermaid
 * flowchart TD
 *   s["keys setup"] --> t{"OpenSSH 8.2+?"}
 *   t -->|no| tf["stop: how to install it"]
 *   t -->|yes| d{"daily key?"}
 *   d -->|no| dk["ssh-keygen (you type a passphrase)"]
 *   d -->|yes| g
 *   dk --> g["Git: sign every commit here"]
 *   g --> l{"signers.ts lists it?"}
 *   l -->|no| la["add it"]
 *   l -->|yes| r
 *   la --> r{"a recovery key listed?"}
 *   r -->|no| rk["make it in Desktop/fleet-recovery,<br/>list it, tell you to move it"]
 *   r -->|yes| h
 *   rk --> h["pre-push check"]
 *   h --> ts["test signature (one passphrase)"]
 * ```
 *
 * @module
 */

import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { P, repoRel } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import type { SignerDef } from "../model/types.ts";
import {
  allowedSignersText,
  checkTip,
  loadSigners,
  signersFile,
  signersSource,
} from "./signers.ts";
import {
  collectKeyFacts,
  hasPassphrase,
  keyChecks,
  type KeyFacts,
  keyPaths,
  parseSignersSource,
  PRE_PUSH_HOOK,
  pubOf,
  readKeyState,
  writeKeyState,
} from "./keys.ts";

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const today = () => new Date().toISOString().slice(0, 10);
const pc = () => Deno.hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "-");

/** Tests only (inside ARCHON_SANDBOX): a passphrase for new keys, so no one has to type it. */
function testPassphrase(): string | undefined {
  return Deno.env.get("ARCHON_SANDBOX") ? Deno.env.get("ARCHON_TEST_PASSPHRASE") : undefined;
}

/** Remove a temporary folder; one left behind (it holds no secret) is said, not hidden. */
async function dropTemp(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch (e) {
    console.error(`archon: could not remove the temporary folder ${dir}: ${(e as Error).message}`);
  }
}

/** Run a program that may ask the person something (a passphrase), with the terminal. */
async function interactive(argv: string[], capture = false): Promise<{ ok: boolean; out: string }> {
  ui.pause();
  try {
    const r = await new Deno.Command(argv[0], {
      args: argv.slice(1),
      stdin: "inherit",
      stdout: capture ? "piped" : "inherit",
      stderr: "inherit",
    }).output();
    return { ok: r.success, out: capture ? new TextDecoder().decode(r.stdout) : "" };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  } finally {
    ui.resume();
  }
}

/** Make an ed25519 key pair at `path` (OpenSSH asks for its passphrase twice). */
async function makeKey(path: string, comment: string): Promise<boolean> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  const pass = testPassphrase();
  const argv = ["ssh-keygen", "-q", "-t", "ed25519", "-C", comment, "-f", path];
  if (pass !== undefined) argv.push("-N", pass);
  else {
    console.log(
      `\n  Choose a passphrase for ${path}: a long phrase you will type for every signature.`,
    );
    console.log("  It is never stored anywhere. Type it twice.\n");
  }
  const r = await interactive(argv);
  // ssh-keygen writes the private file readable by you only.
  return r.ok;
}

/** The public half of a private key: its .pub file, else derived from it (asks the passphrase). */
async function publicOf(path: string): Promise<string | undefined> {
  const pub = pubOf(await readTextOr(path + ".pub"));
  if (pub) return pub;
  if (!(await exists(path))) return undefined;
  const r = await interactive(["ssh-keygen", "-y", "-f", path], true);
  return r.ok ? pubOf(r.out) : undefined;
}

/** Your signer name: the fleet's admin account, else this PC's user. */
async function yourName(): Promise<string> {
  const { loadFleet } = await import("../model/load.ts");
  const user = (await loadFleet().catch(() => undefined))?.admin?.user ??
    Deno.env.get("USER") ?? Deno.env.get("USERNAME") ?? "owner";
  const n = user.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return NAME.test(n) ? n : "owner";
}

/** Write signers.ts in its fixed form. */
async function writeSigners(list: SignerDef[]): Promise<void> {
  await Deno.mkdir(join(signersFile(), ".."), { recursive: true });
  await Deno.writeTextFile(signersFile(), signersSource(list));
}

/** Git in the fleet checkout. */
const git = (args: string[]) => run(["git", "-C", P.repo, ...args]);

/** Set a Git setting in this checkout only, when it differs; true when changed. */
async function setLocal(key: string, value: string): Promise<boolean> {
  const now = (await git(["config", "--local", "--get", key])).stdout.trim();
  if (now === value) return false;
  const r = await git(["config", "--local", key, value]);
  if (!r.ok) throw new Error(`git config ${key}: ${r.stderr.trim()}`);
  return true;
}

/** Render the checkout's allowed signers from signers.ts; true when changed. */
async function renderAllowed(path: string): Promise<boolean> {
  const text = allowedSignersText(await loadSigners());
  if ((await readTextOr(path)) === text) return false;
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, text);
  return true;
}

/** Install the pre-push check (leaves another program's hook alone); true when written. */
async function installHook(path: string): Promise<"written" | "same" | "foreign"> {
  const current = await readTextOr(path);
  if (current === PRE_PUSH_HOOK) return "same";
  if (current && !current.includes("Installed by archon")) return "foreign";
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, PRE_PUSH_HOOK);
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o755);
  return "written";
}

/** Sign a test message with `key` and verify it against `allowed` as `name`. */
async function testSignature(key: string, allowed: string, name: string): Promise<boolean> {
  const dir = await Deno.makeTempDir({ prefix: "archon-sign-" });
  try {
    const msg = join(dir, "message");
    await Deno.writeTextFile(msg, `stolos keys ${new Date().toISOString()}\n`);
    const s = await interactive(["ssh-keygen", "-q", "-Y", "sign", "-f", key, "-n", "git", msg]);
    if (!s.ok) return false;
    const v = await run(
      ["ssh-keygen", "-Y", "verify", "-f", allowed, "-I", name, "-n", "git", "-s", msg + ".sig"],
      { stdin: await Deno.readTextFile(msg) },
    );
    return v.ok;
  } finally {
    await dropTemp(dir);
  }
}

/** Sign a test message with `key` and verify it as `name` with `pub` (a one-line allowed list). */
async function signsAs(key: string, name: string, pub: string): Promise<boolean> {
  const dir = await Deno.makeTempDir({ prefix: "archon-check-" });
  try {
    const allowed = join(dir, "allowed");
    await Deno.writeTextFile(allowed, `${name} namespaces="git" ${pub.trim()}\n`);
    return await testSignature(key, allowed, name);
  } finally {
    await dropTemp(dir);
  }
}

/** Commit signers.ts alone, signed with `key` (asks its passphrase); "none" when unchanged. */
async function commitSigners(key: string, message: string): Promise<"done" | "none" | "failed"> {
  const rel = repoRel(signersFile()).replace(/\\/g, "/");
  const status = (await git(["status", "--porcelain", "--", rel])).stdout.trim();
  if (!status) return "none";
  await git(["add", "--", rel]);
  const r = await interactive([
    "git",
    "-C",
    P.repo,
    "-c",
    "gpg.format=ssh",
    "-c",
    `user.signingkey=${key}`,
    "commit",
    "-q",
    "-S",
    "-m",
    message,
    "--",
    rel,
  ]);
  return r.ok ? "done" : "failed";
}

/** How an operation ends (archon prints the summary): 1 when anything failed. */
const end = (): number => ui.problems.some((x) => x.level === "fail") ? 1 : 0;

// ------------------------------------------------------------------ status

/** `stolos keys`: every check, with its fix; exit 1 when signing does not work. */
export async function keysStatus(json: boolean): Promise<number> {
  const f = await collectKeyFacts();
  const checks = keyChecks(f);
  if (json) {
    console.log(JSON.stringify({ paths: f.paths, checks }, null, 2));
    return checks.some((c) => !c.ok && c.level === "fail") ? 1 : 0;
  }
  const p = ui.phase(`Your signing keys${f.fleetId ? ` (${f.fleetId})` : ""}`);
  for (const c of checks) {
    if (c.ok) p.ok(c.what);
    else if (c.level === "fail") p.fail(c.what, c.fix, c.code);
    else p.warn(c.what, c.fix, c.code);
  }
  p.done(f.paths.daily);
  return ui.finish();
}

// ------------------------------------------------------------------ setup

/** Whether this is Ubuntu on WSL (Windows is then the PC whose key is already listed, usually). */
function onWsl(): boolean {
  if (Deno.env.get("WSL_DISTRO_NAME")) return true;
  try {
    return /microsoft/i.test(Deno.readTextFileSync("/proc/version"));
  } catch {
    return false;
  }
}

/**
 * The exact commands that approve a new PC's daily key: run where a listed key
 * signs (on WSL, Windows PowerShell in the fleet folder), then pull here.
 */
export function approvalSteps(
  fleetId: string,
  rel: string,
  name: string,
  pub: string,
  wsl = onWsl(),
): string[] {
  const where = wsl
    ? "in Windows: open PowerShell, cd C:\\fleet (your fleet folder), deno task stolos update, then run:"
    : "on a PC whose key is already listed, in the fleet repository, after deno task stolos update, run:";
  return [
    `approve this PC's key ${where}`,
    `    deno task stolos signers add ${name} --role daily --key "${pub}"`,
    `    deno task stolos apply -m "${fleetId}: signers: add ${name}"`,
    `then back here: git checkout -- ${rel} && deno task stolos update`,
  ];
}

/** `stolos keys setup`: everything, idempotent. */
export async function keysSetup(o: { test?: boolean } = {}): Promise<number> {
  let f = await collectKeyFacts();
  const paths = f.paths;
  let changed = false;

  const t = ui.phase("Tools");
  if (!f.repo || !f.fleetId) {
    t.fail(
      !f.repo
        ? "this folder is not a Git checkout"
        : "no fleet here (or several: set ARCHON_FLEET)",
      !f.repo
        ? "cd into your fleet repository (for example C:\\fleet), then run this again"
        : "deno task stolos fleet init <id>, or set ARCHON_FLEET",
    );
    return end();
  }
  const sshCheck = keyChecks(f).find((c) => c.code === "E057-SSH")!;
  if (!sshCheck.ok) {
    t.fail(sshCheck.what, sshCheck.fix, sshCheck.code);
    return end();
  }
  t.done(sshCheck.what);

  // The daily key.
  const d = ui.phase("Daily key");
  if (!f.daily.exists) {
    d.status(`making ${paths.daily}`);
    if (!(await makeKey(paths.daily, `${await yourName()} fleet signing (${pc()})`))) {
      d.fail("ssh-keygen did not make the key", "run this again");
      return end();
    }
    changed = true;
    d.note(`made ${paths.daily} and ${paths.daily}.pub`);
  } else d.note(`${paths.daily} (already there; kept)`);
  if (!(await readTextOr(paths.daily + ".pub"))) {
    const pub = await publicOf(paths.daily);
    if (!pub) {
      d.fail(`${paths.daily}.pub is missing and could not be made`, "run this again");
      return end();
    }
    await Deno.writeTextFile(paths.daily + ".pub", pub + "\n");
    d.note(`made ${paths.daily}.pub again from the private key`);
  }
  if (!(await hasPassphrase(paths.daily))) {
    d.fail(
      "the key has NO passphrase: anyone with a copy could approve changes",
      `ssh-keygen -p -f ${paths.daily} (choose one), then run this again`,
      "E057-NO-PASSPHRASE",
    );
    return end();
  }
  f = await collectKeyFacts();
  if (f.daily.inAgent) {
    d.fail(
      "the key is loaded in an ssh-agent",
      `ssh-add -d ${paths.daily}, then run this again`,
      "E057-AGENT",
    );
    return end();
  }
  d.done("locked by a passphrase, not in an ssh-agent");

  // Signers: the daily key, then the recovery key.
  const s = ui.phase("Signers");
  const me = await yourName();
  let list = await loadSigners();
  const dailyPub = pubOf(await readTextOr(paths.daily + ".pub"))!;
  const listedDaily = list.find((x) => x.key.trim() === dailyPub);
  let signersChanged = false;
  // A fleet whose committed signers.ts already lists a daily key accepts a new
  // one only from a commit signed by a listed key: that approval happens elsewhere.
  const rel = repoRel(signersFile()).replace(/\\/g, "/");
  const committed = parseSignersSource((await git(["show", `HEAD:${rel}`])).stdout);
  let approval: { name: string; pub: string } | undefined;
  if (listedDaily) s.note(`your daily key is listed as ${listedDaily.name}`);
  else {
    const taken = new Set(list.map((x) => x.name));
    const name = !taken.has(`${me}-daily`) ? `${me}-daily` : `${me}-${pc()}-daily`;
    list = [...list, { name, role: "daily", key: dailyPub, added: today() }];
    await writeSigners(list);
    signersChanged = true;
    s.note(`added your daily key as ${name}`);
    if (committed.some((x) => x.role === "daily")) {
      approval = { name, pub: dailyPub };
      s.warn(
        "this PC's key must be approved by a key already listed (the commands are below)",
        "approve it from a PC whose key is listed, then pull here",
        "E057-NOT-LISTED",
      );
    }
  }
  // Still waiting for approval (an earlier run added it here, not committed elsewhere yet).
  if (
    !approval && listedDaily && committed.some((x) => x.role === "daily") &&
    !committed.some((x) => x.key.trim() === dailyPub)
  ) {
    approval = { name: listedDaily.name, pub: dailyPub };
  }
  let recoveryMade = false;
  let newRecovery: { file: string; name: string; pub: string } | undefined;
  if (list.some((x) => x.role === "recovery")) {
    s.note(`recovery key listed: ${list.filter((x) => x.role === "recovery").map((x) => x.name)}`);
  } else {
    if (!(await exists(paths.recovery))) {
      console.log(
        "\n  Now the RECOVERY key: use a DIFFERENT passphrase, and write it down somewhere safe.",
      );
      if (!(await makeKey(paths.recovery, `${me} fleet recovery`))) {
        s.fail("ssh-keygen did not make the recovery key", "run this again");
        return end();
      }
      recoveryMade = true;
    }
    const rpub = await publicOf(paths.recovery);
    if (!rpub) {
      s.fail(`could not read ${paths.recovery}.pub`, "run this again");
      return end();
    }
    const taken = new Set(list.map((x) => x.name));
    const name = !taken.has(`${me}-recovery`) ? `${me}-recovery` : `${me}-recovery-${today()}`;
    list = [...list, { name, role: "recovery", key: rpub, added: today() }];
    await writeSigners(list);
    signersChanged = true;
    recoveryMade = true;
    newRecovery = { file: paths.recovery, name, pub: rpub };
    s.note(`added the recovery key as ${name}`);
  }
  changed ||= signersChanged;
  s.done(`${repoRel(signersFile())}: ${list.length} signer(s)`);

  // Git's settings, this checkout only.
  const g = ui.phase("Git signing");
  let gitChanged = false;
  for (
    const [k, v] of [
      ["gpg.format", "ssh"],
      ["user.signingkey", paths.daily],
      ["commit.gpgsign", "true"],
      ["tag.gpgsign", "true"],
      ["gpg.ssh.allowedSignersFile", paths.allowedSigners],
    ]
  ) {
    if (await setLocal(k, v)) {
      gitChanged = true;
      g.note(`set ${k} = ${v}`);
    }
  }
  if (await renderAllowed(paths.allowedSigners)) gitChanged = true;
  changed ||= gitChanged;
  g.done(
    gitChanged ? "every commit in this repository is now signed" : "already set (this repository)",
  );

  // The pre-push check.
  const h = ui.phase("Push check");
  const hook = await installHook(paths.hook);
  if (hook === "foreign") {
    h.warn(
      `${paths.hook} belongs to another program: left alone`,
      "add this line to it: deno task stolos keys check-push || exit 1",
      "E057-HOOK",
    );
  } else h.done(hook === "written" ? "installed: every push is checked first" : "installed");

  // A test signature: proves the passphrase and the listing, once something changed.
  const ts = ui.phase("Test signature");
  if (changed || o.test) {
    const name = list.find((x) => x.key.trim() === dailyPub)!.name;
    console.log("\n  A test signature: type your DAILY key's passphrase.\n");
    if (await testSignature(paths.daily, paths.allowedSigners, name)) {
      ts.done(`signed and verified as ${name}`);
    } else {
      ts.fail(
        "the test signature did not verify",
        "check the passphrase, then: deno task stolos keys setup --test",
      );
    }
  } else ts.done("nothing changed (run with --test to sign once anyway)");

  // The recovery key just made: prove its passphrase too, while it is fresh in mind.
  if (newRecovery) {
    const rt = ui.phase("Recovery test");
    console.log(
      `\n  A test signature: type your RECOVERY key's passphrase (${newRecovery.name}).\n`,
    );
    if (await signsAs(newRecovery.file, newRecovery.name, newRecovery.pub)) {
      const state = await readKeyState(paths.state);
      await writeKeyState({ ...state, recoveryCheckedAt: new Date().toISOString() }, paths.state);
      rt.done(`signed and verified as ${newRecovery.name}`);
    } else {
      rt.fail(
        "the recovery key's test signature did not verify",
        `check its passphrase: deno task stolos keys check-recovery --key ${newRecovery.file}`,
      );
    }
  }

  if (approval) {
    for (const line of approvalSteps(f.fleetId, rel, approval.name, approval.pub)) {
      ui.next.push(line);
    }
  } else if (signersChanged) {
    ui.next.push(
      `approve the new signers: deno task stolos apply -m "${f.fleetId}: signers"`,
    );
  }
  if (recoveryMade) {
    ui.next.push(
      `move the folder ${paths.recoveryDir} (the recovery key) to an encrypted USB drive or a password manager, then delete it from this PC; check it twice a year: deno task stolos keys check-recovery --key <its private file>`,
    );
  }
  if (changed) ui.next.push("back up (your daily key is in it): deno task stolos vault backup");
  return end();
}

/**
 * The parts of `keys setup` that need no passphrase and make no key (spec 058:
 * run by `archon update` after every pull): Git's allowed signers from the
 * current signers.ts, and the pre-push check. Returns what it changed.
 */
export async function repairKeys(): Promise<string[]> {
  const paths = keyPaths((await git(["config", "--get", "user.signingkey"])).stdout.trim());
  const out: string[] = [];
  if (await renderAllowed(paths.allowedSigners)) out.push("Git's allowed signers updated");
  if (await setLocal("gpg.ssh.allowedSignersFile", paths.allowedSigners)) {
    out.push("Git reads them (gpg.ssh.allowedSignersFile)");
  }
  const hook = await installHook(paths.hook);
  if (hook === "written") out.push("the pre-push check installed");
  return out;
}

// ---------------------------------------------------------- check-recovery

/** `stolos keys check-recovery --key <file>`: prove the recovery key works; changes nothing else. */
export async function keysCheckRecovery(key: string): Promise<number> {
  const p = ui.phase("Recovery key check");
  if (!(await exists(key))) {
    p.fail(
      `${key} is not there`,
      "plug in or unlock where you keep it, then pass its private file",
    );
    return end();
  }
  const list = await loadSigners();
  const pub = await publicOf(key);
  const signer = list.find((x) => x.role === "recovery" && x.key.trim() === pub);
  if (!signer) {
    p.fail(
      `${key} is not this fleet's recovery key`,
      "pass the recovery key's private file (signers.ts lists its public half)",
      "E057-NO-RECOVERY",
    );
    return end();
  }
  const dir = await Deno.makeTempDir({ prefix: "archon-recovery-" });
  try {
    const allowed = join(dir, "allowed");
    await Deno.writeTextFile(allowed, `${signer.name} namespaces="git" ${signer.key.trim()}\n`);
    console.log(`\n  Type the RECOVERY key's passphrase (${signer.name}).\n`);
    if (!(await testSignature(key, allowed, signer.name))) {
      p.fail("the recovery key did not sign", "check its passphrase, then run this again");
      return end();
    }
  } finally {
    await dropTemp(dir);
  }
  const paths = keyPaths();
  const state = await readKeyState(paths.state);
  await writeKeyState({ ...state, recoveryCheckedAt: new Date().toISOString() }, paths.state);
  p.done(`${signer.name} works (checked ${today()}); next check in six months`);
  const home = paths.home;
  if (key.startsWith(join(home, ".ssh")) || key.startsWith(paths.recoveryDir)) {
    ui.next.push(`${key} is on this PC: move it away again, then delete it here`);
  } else ui.next.push("put the recovery key away again");
  return end();
}

// ------------------------------------------------------------ rotate, lost

/** The daily signer this PC's key replaces: the one listed with its key, else the only one. */
function dailyOf(list: SignerDef[], pub?: string): SignerDef | undefined {
  const daily = list.filter((x) => x.role === "daily");
  return daily.find((x) => x.key.trim() === pub) ?? (daily.length === 1 ? daily[0] : undefined);
}

/** Move a key pair aside as <path>.retired-<date> (kept, never used again). */
async function retire(path: string): Promise<string> {
  const to = `${path}.retired-${today()}`;
  for (const ext of ["", ".pub"]) {
    if (await exists(path + ext)) await Deno.rename(path + ext, to + ext);
  }
  return to;
}

/** Replace a signer's key in signers.ts (same name, today's date). */
async function replaceKey(name: string, key: string): Promise<void> {
  const list = await loadSigners();
  await writeSigners(list.map((x) => x.name === name ? { ...x, key, added: today() } : x));
}

/** `stolos keys rotate`: a new daily key, approved by the current one; resumes a rotation in progress. */
export async function keysRotate(): Promise<number> {
  const f = await collectKeyFacts();
  const p = ui.phase("Rotate the daily key");
  const next = f.paths.daily + ".next";
  const list = await loadSigners();
  const nextPub = pubOf(await readTextOr(next + ".pub"));
  const current = dailyOf(list, f.daily.pub) ??
    (nextPub ? list.find((x) => x.key.trim() === nextPub) : undefined);
  if (!current || !f.daily.exists) {
    p.fail("no listed daily key here to rotate", "deno task stolos keys setup", "E057-NOT-LISTED");
    return end();
  }
  if (!nextPub && (await exists(`${f.paths.daily}.retired-${today()}`))) {
    p.done(`${current.name}'s key was already rotated today: nothing to do`);
    return end();
  }
  if (!(await exists(next))) {
    if (!(await makeKey(next, `${current.name} fleet signing (${pc()}, ${today()})`))) {
      p.fail("ssh-keygen did not make the new key", "run this again");
      return end();
    }
  }
  const newPub = (await publicOf(next))!;
  if (current.key.trim() !== newPub) await replaceKey(current.name, newPub);
  console.log("\n  Approve it with the CURRENT daily key: type its passphrase.\n");
  const c = await commitSigners(
    f.paths.daily,
    `${f.fleetId}: rotate ${current.name}'s signing key`,
  );
  if (c === "failed") {
    p.fail("the commit was not signed", "run this again (it continues from here)");
    return end();
  }
  // Committed (now or before): the new key takes the daily key's place; Git's settings stay.
  const old = await retire(f.paths.daily);
  for (const ext of ["", ".pub"]) await Deno.rename(next + ext, f.paths.daily + ext);
  await renderAllowed(f.paths.allowedSigners);
  p.done(`${current.name} has a new key; the old one is kept as ${old} (never used again)`);
  ui.next.push("push it: deno task stolos apply (servers accept the new key from that commit on)");
  ui.next.push("back up the new key: deno task stolos vault backup");
  return end();
}

/** `stolos keys lost --recovery <file>`: replace a lost or stolen daily key, approved by the recovery key. */
export async function keysLost(recovery: string, stolen = false): Promise<number> {
  const f = await collectKeyFacts();
  const p = ui.phase("Replace a lost daily key");
  const list = await loadSigners();
  if (!(await exists(recovery))) {
    p.fail(`${recovery} is not there`, "plug in or unlock where you keep the recovery key");
    return end();
  }
  const rpub = await publicOf(recovery);
  const r = list.find((x) => x.role === "recovery" && x.key.trim() === rpub);
  if (!r) {
    p.fail(`${recovery} is not this fleet's recovery key`, "pass the recovery key's private file");
    return end();
  }
  const me = await yourName();
  const old = list.find((x) => x.role === "daily" && x.name === `${me}-daily`) ??
    dailyOf(list, f.daily.pub);
  if (!old) {
    p.fail(
      "cannot tell which daily key is lost (several are listed)",
      "deno task stolos signers remove <its name>, then run this again",
    );
    return end();
  }
  // The local key, if it is the lost (or stolen) one, is retired, never used again.
  const replacedToday = await exists(`${f.paths.daily}.retired-${today()}`);
  if (f.daily.exists && f.daily.pub === old.key.trim()) {
    // The listed key is here: it is not lost. Replace it only when it was stolen
    // (copied by someone else), and only once.
    const clean = !(await git(["status", "--porcelain", "--", repoRel(signersFile())])).stdout
      .trim();
    // signers.ts not committed yet: a replacement was interrupted; finish it below.
    if (clean && (!stolen || replacedToday)) {
      p.done(
        stolen
          ? `${old.name}'s key was already replaced today: nothing to do`
          : `${old.name}'s key is here and listed: nothing is lost (if someone copied it, add --stolen)`,
      );
      return end();
    }
    if (stolen && !replacedToday) p.note(`retired the old key: ${await retire(f.paths.daily)}`);
  }
  if (!(await exists(f.paths.daily))) {
    if (!(await makeKey(f.paths.daily, `${old.name} fleet signing (${pc()}, ${today()})`))) {
      p.fail("ssh-keygen did not make the new key", "run this again");
      return end();
    }
  }
  const newPub = (await publicOf(f.paths.daily))!;
  if (old.key.trim() !== newPub) await replaceKey(old.name, newPub);
  console.log(`\n  Approve it with the RECOVERY key (${r.name}): type its passphrase.\n`);
  const c = await commitSigners(recovery, `${f.fleetId}: replace ${old.name}'s lost signing key`);
  if (c === "failed") {
    p.fail("the commit was not signed", "run this again (it continues from here)");
    return end();
  }
  await setLocal("user.signingkey", f.paths.daily);
  await renderAllowed(f.paths.allowedSigners);
  p.done(`${old.name} has a new key, approved by ${r.name}`);
  ui.next.push(
    "push it: deno task stolos apply (servers stop trusting the old key from that commit on)",
  );
  ui.next.push(`put the recovery key away again; back up: deno task stolos vault backup`);
  return end();
}

// -------------------------------------------------------- rotate-recovery

/**
 * `stolos keys rotate-recovery --recovery <old file>` (or `--old-lost`): a new
 * recovery key in place of the old one (same signer name). The change is
 * approved by the OLD recovery key, proving you still hold it; only when it is
 * lost does the daily key approve (a stolen daily key could do the same, so
 * that path says so). The new key is tested before anything changes; running
 * it again continues an interrupted change, or does nothing.
 */
export async function keysRotateRecovery(o: { old?: string; oldLost?: boolean }): Promise<number> {
  const f = await collectKeyFacts();
  const p = ui.phase("Change the recovery key");
  const list = await loadSigners();
  const recovery = list.filter((x) => x.role === "recovery");
  if (!recovery.length) {
    p.fail("no recovery key is listed", "deno task stolos keys setup", "E057-NO-RECOVERY");
    return end();
  }
  if (!o.old && !o.oldLost) {
    p.fail(
      "say how the change is approved",
      "--recovery <the OLD recovery key's private file> (best), or --old-lost when it is lost",
    );
    return end();
  }
  const fresh = join(f.paths.recoveryDir, `fleet-recovery-${today()}`);
  const rel = repoRel(signersFile()).replace(/\\/g, "/");
  const committed = parseSignersSource((await git(["show", `HEAD:${rel}`])).stdout);
  const freshPub = pubOf(await readTextOr(fresh + ".pub"));
  if (freshPub && committed.some((x) => x.role === "recovery" && x.key.trim() === freshPub)) {
    p.done(`the recovery key was already changed today (${fresh}): nothing to do`);
    return end();
  }
  // Which recovery signer is replaced, and which key signs the change.
  let old = recovery.length === 1 ? recovery[0] : undefined;
  let signWith = f.paths.daily;
  if (o.old) {
    if (!(await exists(o.old))) {
      p.fail(`${o.old} is not there`, "plug in or unlock where you keep the recovery key");
      return end();
    }
    const pub = await publicOf(o.old);
    old = recovery.find((x) => x.key.trim() === pub);
    if (!old) {
      // Already replaced by an earlier run? Then the new key is listed and this one is not.
      p.fail(
        `${o.old} is not the fleet's current recovery key`,
        "pass the OLD recovery key's private file",
      );
      return end();
    }
    signWith = o.old;
  } else if (!old) {
    p.fail("several recovery keys are listed", "pass --recovery <the one to replace>");
    return end();
  }
  // 1. The new key, tested before anything changes.
  if (!(await exists(fresh))) {
    console.log(
      "\n  The NEW recovery key: a passphrase different from your daily key's; write it down somewhere safe.",
    );
    if (!(await makeKey(fresh, `${old!.name} fleet recovery (${today()})`))) {
      p.fail("ssh-keygen did not make the new recovery key", "run this again");
      return end();
    }
  }
  const newPub = (await publicOf(fresh))!;
  console.log(`\n  A test signature: type the NEW recovery key's passphrase.\n`);
  if (!(await signsAs(fresh, old!.name, newPub))) {
    p.fail("the new recovery key did not sign", "check its passphrase, then run this again");
    return end();
  }
  // 2. signers.ts, then one commit approved by the old recovery key (or the daily key).
  if (old!.key.trim() !== newPub) await replaceKey(old!.name, newPub);
  if (o.oldLost) {
    p.warn(
      "approved by your daily key: anyone who had a copy of it could have done the same",
      "if the daily key may have been copied too, replace it now: deno task stolos keys rotate",
    );
  }
  console.log(
    `\n  Approve it with the ${o.old ? "OLD RECOVERY" : "DAILY"} key: type its passphrase.\n`,
  );
  const c = await commitSigners(signWith, `${f.fleetId}: change ${old!.name}'s recovery key`);
  if (c === "failed") {
    p.fail("the commit was not signed", "run this again (it continues from here)");
    return end();
  }
  await renderAllowed(f.paths.allowedSigners);
  const state = await readKeyState(f.paths.state);
  await writeKeyState({ ...state, recoveryCheckedAt: new Date().toISOString() }, f.paths.state);
  p.done(`${old!.name} has a new recovery key (${fresh}), tested`);
  ui.next.push("push it: deno task stolos apply (servers trust the new recovery key from then on)");
  ui.next.push(
    `move ${fresh} and ${fresh}.pub to where you keep the recovery key, then delete them here`,
  );
  if (o.old) {
    ui.next.push(
      `destroy the OLD recovery key (${o.old}) once the push is done: it is no longer trusted`,
    );
  }
  return end();
}

// ------------------------------------------------------------- check-push

/**
 * `stolos keys check-push` (Git's pre-push hook): each pushed tip of the
 * fleet's branch must be signed by a key the fleet trusts as of what the
 * remote has now, exactly as servers will check it. Refs to push come on
 * standard input ("<local ref> <local sha> <remote ref> <remote sha>").
 */
export async function keysCheckPush(input?: string): Promise<number> {
  const text = input ?? await new Response(Deno.stdin.readable).text();
  const { loadFleet } = await import("../model/load.ts");
  const branch = (await loadFleet().catch(() => undefined))?.repository?.branch ?? "main";
  const rel = repoRel(signersFile()).replace(/\\/g, "/");
  const zero = /^0+$/;
  let bad = 0;
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    if (!localSha || zero.test(localSha) || remoteRef !== `refs/heads/${branch}`) continue;
    const have = remoteSha && !zero.test(remoteSha) &&
      (await git(["cat-file", "-e", `${remoteSha}^{commit}`])).ok;
    const base = have ? remoteSha : localSha;
    const signers = parseSignersSource((await git(["show", `${base}:${rel}`])).stdout);
    if (!signers.some((s) => s.role === "daily")) continue; // no signers yet: nothing to check
    const dir = await Deno.makeTempDir({ prefix: "archon-push-" });
    try {
      const allowed = join(dir, "allowed_signers");
      await Deno.writeTextFile(allowed, allowedSignersText(signers));
      const t = await checkTip(P.repo, localSha, have ? remoteSha : "", allowed);
      if (!t.ok) {
        bad++;
        console.error(`archon: push refused here: ${t.reason}`);
        console.error(
          t.code === "unsigned"
            ? "  sign your last commit: git commit --amend --no-edit -S   (then push again)"
            : t.code === "untrusted"
            ? "  it was signed by a key signers.ts does not list: deno task stolos keys"
            : "  pull first: git pull --rebase",
        );
        console.error(`  (archon explain E047-${(t.code ?? "untrusted").toUpperCase()})`);
      }
    } finally {
      await dropTemp(dir);
    }
  }
  return bad ? 1 : 0;
}

/** The checks for other commands (boot doctor, where am I): the facts are gathered once. */
export async function keyChecksNow(): Promise<ReturnType<typeof keyChecks>> {
  const f: KeyFacts = await collectKeyFacts();
  return keyChecks(f);
}
