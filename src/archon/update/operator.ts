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
 *    only reports. Then `bun install --frozen-lockfile`: the engine bun.lock
 *    holds is the one installed here.
 * 4. **Keys**: the parts of `keys setup` that need no passphrase (Git's
 *    allowed signers, the pre-push check).
 * 5. **Doctor**: `boot doctor` on a boot machine (keys included), else
 *    `stolos keys`.
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
 *   keys --> doctor["boot doctor<br/>(or stolos keys)"]
 * ```
 *
 * @module
 */

import { fs, path, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import { P, repoRel } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { SECRETS } from "../core/secrets.ts";
import { json, object, integer } from "@intellectual-frontiers/commons/ts/kernel";
import {
  compare,
  engineRepository,
  parseTag,
  PIN_FILE,
  readPin,
  type Semver,
} from "../fleet/upgrade.ts";
import { BUN_VERSION } from "../core/bun-pin.ts";
import { engineCommand } from "../install/bun.ts";

/** The newest release tag in a list of `git ls-remote --tags` lines, or undefined. */
export function newestTag(lsRemote: string): string | undefined {
  let best: Semver | undefined;
  for (const m of lsRemote.matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)$/gm)) {
    const v = parseTag(m[1] ?? "");
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

/** What a step run as its own command found (from its STOLOS_SUMMARY). */
interface StepSummary {
  code: number;
  fails: number;
  warns: number;
  pending: number;
}

/** What a step writes to STOLOS_SUMMARY (core/ui.ts `finish`). */
const SUMMARY = object({}, { fails: integer, warns: integer, pending: integer });

/** Run `stolos <args>` in the checkout (a fresh process), with the terminal (it may ask for a passphrase). */
async function stolos(args: string[]): Promise<StepSummary> {
  const summary = await fs.makeTempFile({ prefix: "stolos-summary-" });
  ui.pause();
  try {
    const r = await proc.output([...engineCommand(), "stolos.ts", ...args], {
      cwd: P.repo,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...(P.fleetId ? { ARCHON_FLEET: P.fleetId } : {}), STOLOS_SUMMARY: summary },
    });
    // No summary: the step wrote none, and its exit code says enough.
    const d = json((await fs.readTextOr(summary)) || "{}", SUMMARY);
    const c = d.kind === "ok" ? d.value : {};
    return { code: r.code, fails: c.fails ?? 0, warns: c.warns ?? 0, pending: c.pending ?? 0 };
  } finally {
    ui.resume();
    try {
      await fs.remove(summary);
    } catch (e) {
      stdio.stderr.writeSync(`stolos: could not remove ${summary}: ${(e as Error).message}\n`);
    }
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
  const git = (args: string[]): ReturnType<typeof run> => run(["git", "-C", P.repo, ...args]);
  const before = (await git(["rev-parse", "HEAD"])).stdout.trim();

  // 0. The runtime itself: the pinned Bun (spec 096), or Node 26 where Bun is not installed.
  const d = ui.phase("Runtime");
  const runtime = proc.runtimeName();
  const version = proc.runtimeVersion();
  if (runtime !== "bun")
    d.done(`${runtime} ${version} (Bun is the runtime of record: ${BUN_VERSION})`);
  else if (atLeast(version, BUN_VERSION)) d.done(`Bun ${version}`);
  else {
    d.warn(
      `Bun ${version} is older than ${BUN_VERSION}, the version Stolos is pinned to`,
      `bun upgrade (or the bootstrap again: bin/bootstrap.sh)`,
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
      ahead
        ? `up to date; ${ahead} commit(s) of yours not pushed yet (bun run stolos apply)`
        : "up to date",
    );
  } else if (ahead) {
    p.warn(
      `your ${ahead} commit(s) and ${behind} new one(s) on GitHub went different ways`,
      `git pull --rebase (puts yours on top), then bun run stolos apply`,
    );
    p.done();
  } else if (dirty) {
    p.warn(
      `${behind} new commit(s) on GitHub, but you have changes not committed`,
      "send them first (bun run stolos apply), or set them aside (git stash), then run this again",
    );
    p.done();
  } else {
    pulled = (await git(["log", "--format=%h %s", `HEAD..${remote}`])).stdout
      .split("\n")
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
    const rel = repoRel(path.join(P.fleetDir, "signers.ts")).replace(/\\/g, "/");
    const signers = parseSignersSource((await git(["show", `${before}:${rel}`])).stdout);
    if (!signers.some((s) => s.role === "daily")) {
      a.done("nothing to check yet (the fleet has no signers on GitHub yet)");
    } else {
      const dir = await fs.makeTempDir({ prefix: "archon-update-" });
      try {
        const allowed = path.join(dir, "allowed_signers");
        await fs.writeTextFile(allowed, allowedSignersText(signers));
        const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
        const t = await checkTip(P.repo, head, before, allowed);
        if (t.ok) a.done(`signed by ${t.signer}`);
        else {
          a.warn(
            `what you pulled was made elsewhere, not signed by a fleet signer (${head.slice(
              0,
              10,
            )}): servers wait for your approval`,
            "bun run stolos apply (it lists those commits and approves them with one signed commit)",
            `E047-${(t.code ?? "untrusted").toUpperCase()}`,
          );
          a.done();
        }
      } finally {
        try {
          await fs.remove(dir, { recursive: true });
        } catch (e) {
          stdio.stderr.writeSync(`archon: could not remove ${dir}: ${(e as Error).message}\n`);
        }
      }
    }
  }

  // 3. The engine: the newest Stolos release, and the pin.
  const e = ui.phase("Engine");
  const pin = readPin((await fs.readTextOr(path.join(P.repo, PIN_FILE))) ?? "");
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
    } else if (compare(parseTag(newest) ?? [0, 0, 0], parseTag(pin.tag) ?? [0, 0, 0]) <= 0) {
      e.done(`${pin.tag}, the newest release`);
    } else if (o.noUpgrade || dirty || ahead) {
      e.warn(
        `${newest} is out (pinned: ${pin.tag})`,
        dirty || ahead
          ? `push or commit your own changes first, then: bun run stolos update`
          : `bun run stolos fleet upgrade ${newest}, then bun run stolos apply`,
      );
      e.done();
    } else {
      // The upgrade is a signed commit: only where one can be made (a fresh clone cannot
      // until vault restore or keys setup ran in it).
      const { signingBlockers } = await import("../identity/keys-commands.ts");
      const blocking = await signingBlockers();
      if (blocking.length) {
        e.warn(
          `${newest} is out (pinned: ${pin.tag}), but this checkout cannot sign a commit yet: ${blocking
            .map((k) => k.code)
            .join(", ")}`,
          "a restored PC: bun run stolos vault restore <your backup ZIP>; otherwise: bun run stolos keys setup. Then: bun run stolos update",
        );
        e.done();
      } else {
        upgradeTo = newest;
        e.done(`${newest} is out (pinned: ${pin.tag}): upgrading`);
      }
    }
  }
  let upgraded = false;
  if (upgradeTo) {
    // A fresh process with the engine pinned now: it validates, locks, and makes one signed commit.
    stdio.stdout.writeSync(
      `\n  Upgrading the engine to ${upgradeTo}: Git asks for your passphrase to sign it.\n\n`,
    );
    const { code } = await stolos(["fleet", "upgrade", upgradeTo]);
    const u = ui.phase("Upgrade");
    if (code === 0) {
      upgraded = true;
      u.done(`pinned to ${upgradeTo} (one signed commit)`);
      ui.next.push(
        `push it: bun run stolos apply (servers move to ${upgradeTo} within 15 minutes)`,
      );
    } else {
      u.fail(
        `fleet upgrade to ${upgradeTo} did not finish`,
        `see its messages above; then: bun run stolos update`,
      );
    }
  }

  // The engine bun.lock holds, installed here: what stolos runs, and what VS Code checks fleet.ts against.
  if (pin) {
    const ed = ui.phase("Install");
    ed.status("bun install --frozen-lockfile (the engine bun.lock holds)");
    const { installEngine } = await import("../fleet/scaffold.ts");
    const c = await installEngine(P.repo);
    if (c.ok) ed.done(`the engine ${pin.tag}, as bun.lock holds it`);
    else {
      ed.warn(
        `the engine could not be installed: ${c.why}`,
        /integrity|checksum|mismatch/i.test(c.why ?? "")
          ? "stop: do not regenerate bun.lock (bun run stolos explain E046-LOCK-INTEGRITY)"
          : "check the network, then run this again",
        /integrity|checksum|mismatch/i.test(c.why ?? "") ? "E046-LOCK-INTEGRITY" : undefined,
      );
      ed.done();
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
    const boot = await fs.exists(SECRETS.adminPasswordHash);
    stdio.stdout.writeSync("\n");
    const r = boot ? await stolos(["boot", "doctor"]) : await stolos(["keys"]);
    const dr = ui.phase("Doctor");
    const what = boot ? "boot doctor" : "stolos keys";
    const again = boot ? "bun run stolos boot doctor" : "bun run stolos keys";
    const notYet = r.pending ? `; ${r.pending} thing(s) not set up yet` : "";
    if (r.code !== 0 || r.fails) {
      dr.fail(
        `${what}: ${r.fails || "some"} problem(s), each with its fix (above)${notYet}`,
        again,
      );
    } else if (r.warns) {
      dr.warn(`${what}: ${r.warns} warning(s), each with its fix (above)${notYet}`, again);
    } else dr.done(`${what}: all well${notYet}`);
    if (!dr.level || dr.level !== "ok") dr.done();
  }
  if (!upgraded && !pulled.length) ui.next.push("next: bun run stolos (where you are)");
  return ui.problems.some((x) => x.level === "fail") ? 1 : 0;
}
