/**
 * Spec 058: `archon update` on your PC (the boot machine, or any checkout of
 * the fleet repository that is not an installed host). One command instead of
 * `git pull`, and everything that should follow it, every step idempotent:
 *
 * 1. **Pull**: fetch, then fast-forward a clean checkout (never a merge, never
 *    a rewrite); local commits or changes are named, with what to do.
 * 2. **Approval**: what arrived is signed by a key the fleet trusted before it
 *    (the check servers make), so a push that servers will refuse is seen here.
 * 3. **Engine**: is the pinned Stolos release the newest? If not, `fleet
 *    upgrade` moves the pin (one signed commit; you push it). `--no-upgrade`
 *    only reports.
 * 4. **Keys**: the parts of `keys setup` that need no passphrase (Git's
 *    allowed signers, the pre-push check).
 * 5. **Doctor**: `boot doctor` on a boot machine (keys included), else
 *    `archon keys`.
 *
 * On an installed host, `archon update` is spec 015's (pull, apply, verify).
 *
 * ```mermaid
 * flowchart LR
 *   pull["pull<br/>(fast-forward only)"] --> approval["signed by a<br/>trusted key?"]
 *   approval --> engine{"newer Stolos<br/>release?"}
 *   engine -->|yes| upgrade["fleet upgrade<br/>(a signed commit)"]
 *   engine -->|no| keys
 *   upgrade --> keys["keys: allowed signers,<br/>pre-push check"]
 *   keys --> doctor["boot doctor<br/>(or archon keys)"]
 * ```
 *
 * @module
 */

import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { P, repoRel } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { SECRETS } from "../core/secrets.ts";
import { compare, engineRepository, parseTag, readPin, type Semver } from "../fleet/upgrade.ts";

/** The minimum Deno the engine is tested with. */
export const MIN_DENO = "2.9.6";

/** The newest release tag in a list of `git ls-remote --tags` lines, or undefined. */
export function newestTag(lsRemote: string): string | undefined {
  let best: Semver | undefined;
  for (const m of lsRemote.matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)$/gm)) {
    const v = parseTag(m[1]);
    if (v && (!best || compare(v, best) > 0)) best = v;
  }
  return best ? `v${best.join(".")}` : undefined;
}

/** Whether `have` ("2.9.6") is at least `want`. */
export function atLeast(have: string, want: string): boolean {
  const a = have.split(".").map(Number);
  const b = want.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** Run `deno task <args>` in the checkout, with the terminal (it may ask for a passphrase). */
async function task(args: string[]): Promise<number> {
  ui.pause();
  try {
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["task", ...args],
      cwd: P.repo,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: P.fleetId ? { ARCHON_FLEET: P.fleetId } : {},
    }).output();
    return r.code;
  } finally {
    ui.resume();
  }
}

/** What `archon update` on a PC is told. */
export interface OperatorUpdateOptions {
  /** Report a newer engine without moving the pin. */
  noUpgrade?: boolean;
  /** Skip the doctor at the end. */
  noDoctor?: boolean;
}

/** `archon update` on your PC: pull, check, upgrade the engine, repair keys, doctor. */
export async function operatorUpdate(o: OperatorUpdateOptions = {}): Promise<number> {
  const git = (args: string[]) => run(["git", "-C", P.repo, ...args]);
  const before = (await git(["rev-parse", "HEAD"])).stdout.trim();

  // 0. Deno itself.
  const d = ui.phase("Deno");
  if (atLeast(Deno.version.deno, MIN_DENO)) d.done(`${Deno.version.deno}`);
  else {
    d.warn(
      `Deno ${Deno.version.deno} is older than ${MIN_DENO}, the version Stolos is tested with`,
      "deno upgrade",
    );
    d.done();
  }

  // 1. Pull: fast-forward only.
  const p = ui.phase("Pull");
  if (!(await git(["rev-parse", "--git-dir"])).ok) {
    p.fail(`${P.repo} is not a Git checkout`, "cd into your fleet repository first");
    return 1;
  }
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "main";
  p.status(`git fetch origin ${branch}`);
  const fetch = await git(["fetch", "--quiet", "origin", branch]);
  if (!fetch.ok) {
    p.fail(
      `git fetch failed: ${fetch.stderr.trim().split("\n").pop()}`,
      "check the network and your GitHub sign-in (gh auth status), then run this again",
    );
    return 1;
  }
  const remote = `origin/${branch}`;
  const behind = Number((await git(["rev-list", "--count", `HEAD..${remote}`])).stdout.trim()) || 0;
  const ahead = Number((await git(["rev-list", "--count", `${remote}..HEAD`])).stdout.trim()) || 0;
  const dirty = (await git(["status", "--porcelain", "--untracked-files=no"])).stdout.trim();
  let pulled: string[] = [];
  if (!behind) {
    p.done(
      ahead ? `up to date; ${ahead} commit(s) of yours not pushed yet (git push)` : "up to date",
    );
  } else if (ahead) {
    p.warn(
      `your ${ahead} commit(s) and ${behind} new one(s) on GitHub went different ways`,
      `git pull --rebase (puts yours on top), then git push`,
    );
    p.done();
  } else if (dirty) {
    p.warn(
      `${behind} new commit(s) on GitHub, but you have changes not committed`,
      "commit them (git add -A; git commit -m ...) or set them aside (git stash), then run this again",
    );
    p.done();
  } else {
    pulled = (await git(["log", "--format=%h %s", `HEAD..${remote}`])).stdout.split("\n")
      .filter(Boolean);
    const ff = await git(["merge", "--ff-only", "--quiet", remote]);
    if (!ff.ok) {
      p.fail(`fast-forward failed: ${ff.stderr.trim()}`, "git status shows why");
      return 1;
    }
    for (const c of pulled.slice(0, 10)) p.note(c);
    p.done(`${pulled.length} new commit(s)`);
  }

  // 2. Approval: the new tip, against the signers the fleet had before.
  if (pulled.length && P.fleetId) {
    const a = ui.phase("Approval");
    const { allowedSignersText, checkTip } = await import("../identity/signers.ts");
    const { parseSignersSource } = await import("../identity/keys.ts");
    const rel = repoRel(join(P.fleetDir, "signers.ts")).replace(/\\/g, "/");
    const signers = parseSignersSource((await git(["show", `${before}:${rel}`])).stdout);
    if (!signers.some((s) => s.role === "daily")) a.done("the fleet had no signers yet");
    else {
      const dir = await Deno.makeTempDir({ prefix: "archon-update-" });
      try {
        const allowed = join(dir, "allowed_signers");
        await Deno.writeTextFile(allowed, allowedSignersText(signers));
        const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
        const t = await checkTip(P.repo, head, before, allowed);
        if (t.ok) a.done(`signed by ${t.signer}`);
        else {
          a.warn(
            `servers will refuse what you pulled: ${t.reason}`,
            `whoever pushed it signs it; or approve it yourself: git commit -S --allow-empty -m approve, then git push (archon explain E047-${
              (t.code ?? "untrusted").toUpperCase()
            })`,
            `E047-${(t.code ?? "untrusted").toUpperCase()}`,
          );
          a.done();
        }
      } finally {
        try {
          await Deno.remove(dir, { recursive: true });
        } catch (e) {
          console.error(`archon: could not remove ${dir}: ${(e as Error).message}`);
        }
      }
    }
  }

  // 3. The engine: the newest Stolos release, and the pin.
  const e = ui.phase("Engine");
  const pin = readPin((await readTextOr(join(P.repo, "deno.json"))) ?? "");
  const engineRepo = pin ? engineRepository(pin) : undefined;
  let upgradeTo: string | undefined;
  if (!pin || !engineRepo) e.done("not pinned to a release (an engine checkout): nothing to check");
  else {
    e.status(`newest release of ${engineRepo}`);
    const ls = await run([
      "git",
      "ls-remote",
      "--tags",
      "--refs",
      `https://github.com/${engineRepo}.git`,
    ]);
    const newest = ls.ok ? newestTag(ls.stdout) : undefined;
    if (!newest) {
      e.warn(`cannot read ${engineRepo}'s releases`, "check the network, then run this again");
      e.done(`pinned ${pin.tag}`);
    } else if (compare(parseTag(newest)!, parseTag(pin.tag)!) <= 0) {
      e.done(`${pin.tag}, the newest release`);
    } else if (o.noUpgrade || dirty || ahead) {
      e.warn(
        `${newest} is out (pinned: ${pin.tag})`,
        dirty || ahead
          ? `push or commit your own changes first, then: deno task archon update`
          : `deno task archon fleet upgrade ${newest}, then git push`,
      );
      e.done();
    } else {
      upgradeTo = newest;
      e.done(`${newest} is out (pinned: ${pin.tag}): upgrading`);
    }
  }
  let upgraded = false;
  if (upgradeTo) {
    // A fresh process with the engine pinned now: it validates, locks, and makes one signed commit.
    console.log(
      `\n  Upgrading the engine to ${upgradeTo}: Git asks for your passphrase to sign it.\n`,
    );
    const code = await task(["archon", "fleet", "upgrade", upgradeTo]);
    const u = ui.phase("Upgrade");
    if (code === 0) {
      upgraded = true;
      u.done(`pinned to ${upgradeTo} (one signed commit)`);
      ui.next.push(`push it: git push (servers move to ${upgradeTo} within 15 minutes)`);
    } else {
      u.fail(
        `fleet upgrade to ${upgradeTo} did not finish`,
        `see its messages above; then: deno task archon update`,
      );
    }
  }

  // 4. Keys: what needs no passphrase.
  if (P.fleetId) {
    const k = ui.phase("Keys");
    const { repairKeys } = await import("../identity/keys-commands.ts");
    const fixed = await repairKeys();
    k.done(
      fixed.length ? fixed.join("; ") : "Git's allowed signers and the pre-push check are current",
    );
  }

  // 5. The doctor (in a fresh process: the engine may have just moved).
  if (!o.noDoctor) {
    const boot = await exists(SECRETS.adminPasswordHash);
    console.log("");
    const code = boot ? await task(["boot", "doctor"]) : await task(["archon", "keys"]);
    const dr = ui.phase("Doctor");
    if (code === 0) dr.done(boot ? "boot doctor: all well" : "archon keys: all well");
    else {
      dr.warn(
        `${boot ? "boot doctor" : "archon keys"} found something (above), each with its fix`,
        boot ? "deno task boot doctor" : "deno task archon keys",
      );
      dr.done();
    }
  }
  if (!upgraded && !pulled.length) ui.next.push("next: deno task archon (where you are)");
  return ui.problems.some((x) => x.level === "fail") ? 1 : 0;
}
