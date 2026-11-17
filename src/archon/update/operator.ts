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
 *    upgrade` moves the pin (one signed commit), and `stolos apply` sends it (spec 099). `--no-upgrade`
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
// Spec: 058-operator-update
// Spec: 099-engine-update FR-001, FR-004, FR-006
// Spec: 105-calm-output FR-005, FR-007, FR-012 to FR-016

import { fs, path, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import { P, repoRel } from "../core/paths.ts";
import { type Problem, type RunSummary, ui } from "../core/ui.ts";
import { SECRETS } from "../core/secrets.ts";
import {
  compare,
  engineRepository,
  parseTag,
  PIN_FILE,
  readPin,
  waitingUpgrade,
} from "../fleet/upgrade.ts";
import { whatsNew } from "../fleet/whatsnew.ts";
import { newestTag } from "../fleet/releases.ts";
import { BUN_VERSION } from "../core/bun-pin.ts";
import { engineCommand } from "../install/bun.ts";

/** The newest release tag in a list of `git ls-remote --tags` lines, or undefined. */
export { newestTag } from "../fleet/releases.ts";

/** Whether `have` ("2.9.6") is at least `want`. */
export function atLeast(have: string, want: string): boolean {
  const a = have.split(".").map(Number);
  const b = want.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** What a step run as its own command found (from its STOLOS_SUMMARY, spec 105-calm-output FR-005). */
interface StepSummary {
  code: number;
  fails: number;
  warns: number;
  pending: number;
  /** Every problem of the step, to be merged into the parent's phase. */
  problems: Problem[];
  /** The outcome lines the step wants shown. */
  outcomes: string[];
}

/** The problems and outcomes in a step's STOLOS_SUMMARY text (empty where it wrote none or wrote something else). */
export function readSummary(text: string): Pick<RunSummary, "problems" | "outcomes"> {
  const none = { problems: [], outcomes: [] };
  try {
    const d: unknown = JSON.parse(text || "{}");
    if (typeof d !== "object" || d === null) return none;
    const levels = ["fail", "warn", "pending", "action"];
    const problems = (
      Array.isArray((d as { problems?: unknown }).problems)
        ? ((d as { problems: unknown[] }).problems as Array<Partial<Problem>>)
        : []
    ).filter(
      (p): p is Problem =>
        typeof p === "object" &&
        p !== null &&
        typeof p.message === "string" &&
        typeof p.phase === "string" &&
        typeof p.level === "string" &&
        levels.includes(p.level),
    );
    const o = (d as { outcomes?: unknown }).outcomes;
    return { problems, outcomes: Array.isArray(o) ? o.filter((x) => typeof x === "string") : [] };
  } catch {
    return none;
  }
}

/**
 * Run `stolos <args>` in the checkout as a phase of this run (spec 105-calm-output FR-005): a fresh
 * process with the terminal (it may ask for a passphrase) that prints no header, no summary and no
 * `next:`, appends to this run's log, and hands its problems back to be merged.
 */
async function stolos(args: string[]): Promise<StepSummary> {
  const summary = await fs.makeTempFile({ prefix: "stolos-summary-" });
  ui.pause();
  try {
    const r = await proc.output([...engineCommand(), "stolos.ts", ...args], {
      cwd: P.repo,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...(P.fleetId ? { ARCHON_FLEET: P.fleetId } : {}),
        STOLOS_SUMMARY: summary,
        STOLOS_NESTED:
          ui.mode === "quiet" || ui.mode === "json"
            ? "quiet"
            : ui.mode === "verbose"
              ? "verbose"
              : "calm",
        ARCHON_UI_START: String(ui.started),
        ...(ui.logPath ? { ARCHON_LOG: ui.logPath } : {}),
        ...(ui.verbose ? { ARCHON_VERBOSE: "1" } : {}),
      },
    });
    const c = readSummary((await fs.readTextOr(summary)) ?? "");
    const count = (l: Problem["level"]): number => c.problems.filter((p) => p.level === l).length;
    return {
      code: r.code,
      fails: count("fail"),
      warns: count("warn"),
      pending: count("pending"),
      ...c,
    };
  } finally {
    ui.resume();
    try {
      await fs.remove(summary);
    } catch (e) {
      stdio.stderr.writeSync(`stolos: could not remove ${summary}: ${(e as Error).message}\n`);
    }
  }
}

/**
 * A step's result in the parent's phase, once (spec 105-calm-output FR-007): its problems and
 * outcomes merged, never re-reported; where it failed without saying why, one plain failure.
 * Returns whether the step succeeded.
 */
function took(
  phase: ReturnType<typeof ui.phase>,
  r: StepSummary,
  whenNoReason: string,
  fix: string,
): boolean {
  phase.merge(r.problems, r.outcomes);
  if (r.code !== 0 && !r.fails) phase.fail(whenNoReason, fix, "E105-FAILED");
  return r.code === 0 && !r.fails;
}

/** Where the engine's releases are listed: the pin's GitHub repository, or the mirror a `git+` pin names. */
function engineRemote(pin: { source: string; tag: string }): string | undefined {
  const repo = engineRepository(pin);
  if (repo) return `https://github.com/${repo}.git`;
  return pin.source.startsWith("git+") ? pin.source.slice(4) : undefined;
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
      `bun upgrade`,
      "E105-RUNTIME-OLD",
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
    ui.log(`   git fetch: ${fetch.stderr.trim()}`);
    p.fail(
      "GitHub could not be reached, so nothing was changed. Check the network and your GitHub sign-in.",
      "gh auth status",
      "E105-GITHUB",
    );
    return 1;
  }
  const remote = `origin/${branch}`;
  const behind = Number((await git(["rev-list", "--count", `HEAD..${remote}`])).stdout.trim()) || 0;
  let ahead = Number((await git(["rev-list", "--count", `${remote}..HEAD`])).stdout.trim()) || 0;
  let dirty = (await git(["status", "--porcelain", "--untracked-files=no"])).stdout.trim();
  let pulled: string[] = [];
  if (!behind) {
    p.done("up to date");
  } else if (ahead && !dirty) {
    // Spec 099: yours on top of GitHub's (never a merge); a conflict is undone and named.
    pulled = (await git(["log", "--format=%h %s", `HEAD..${remote}`])).stdout
      .split("\n")
      .filter(Boolean);
    const rb = await git(["rebase", "--quiet", remote]);
    if (!rb.ok) {
      await git(["rebase", "--abort"]);
      pulled = [];
      p.warn(
        `Your ${ahead} commit(s) and ${behind} new one(s) on GitHub change the same lines, so nothing was moved.`,
        "git pull --rebase",
        "E105-CONFLICT",
      );
      p.done();
    } else {
      for (const c of pulled.slice(0, 10)) p.note(c);
      p.done(
        `${pulled.length} new commit(s); your ${ahead} commit(s) on top (they need signing again)`,
      );
    }
  } else if (ahead) {
    p.warn(
      `Your ${ahead} commit(s) and ${behind} new one(s) on GitHub went different ways, and you have changes not committed, so nothing was moved.`,
      "bun run stolos apply",
      "E105-CONFLICT",
    );
    p.done();
  } else if (dirty) {
    p.warn(
      `${behind} new commit(s) on GitHub, but you have changes not committed, so nothing was moved. Send them first, or set them aside (git stash).`,
      "bun run stolos apply",
      "E105-UNSENT",
    );
    p.done();
  } else {
    pulled = (await git(["log", "--format=%h %s", `HEAD..${remote}`])).stdout
      .split("\n")
      .filter(Boolean);
    const ff = await git(["merge", "--ff-only", "--quiet", remote]);
    if (!ff.ok) {
      ui.log(`   git merge: ${ff.stderr.trim()}`);
      p.fail(
        "GitHub's new commits could not be fast-forwarded, so nothing was changed.",
        "git status",
        "E105-CONFLICT",
      );
      return 1;
    }
    for (const c of pulled.slice(0, 10)) p.note(c);
    p.done(`${pulled.length} new commit(s)`);
  }
  if (pulled.length) ui.verdictTitle = "Updated";

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
            `What you pulled was made elsewhere, not signed by a fleet signer (${head.slice(
              0,
              10,
            )}): servers wait for your approval.`,
            "bun run stolos apply",
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

  // Spec 099: what is here and not on GitHub goes out first (stolos apply: checked, signed,
  // pushed), so the engine can be upgraded on top of it. Records Stolos wrote (an install's
  // registration, an adoption) are sent without asking; your own edits only when you say so. An
  // engine upgrade that waits for its signature is finished here (spec 105-calm-output FR-014).
  let finishedUpgrade: string | undefined;
  if (!o.noUpgrade) {
    const { porcelainPath, splitChanges, yoursNamed } = await import("../fleet/records.ts");
    const changed = (await git(["status", "--porcelain", "--untracked-files=all"])).stdout
      .split("\n")
      .filter(Boolean)
      .map(porcelainPath);
    const waiting = await waitingUpgrade(P.repo, changed);
    const { records, yours } = splitChanges(waiting ? [] : changed);
    ahead = Number((await git(["rev-list", "--count", `${remote}..HEAD`])).stdout.trim()) || 0;
    let send = changed.length > 0 || ahead > 0;
    const s = ui.phase("Send");
    if (yours.length) {
      s.note(
        `your changes: ${yours.slice(0, 5).map(yoursNamed).join(", ")}${yours.length > 5 ? ", ..." : ""}`,
      );
      ui.live(
        `Your ${yours.length} change${yours.length > 1 ? "s" : ""}: ${yours.slice(0, 5).map(yoursNamed).join(", ")}${yours.length > 5 ? ", ..." : ""}`,
      );
      send = await ui.confirm(
        `  Send your ${yours.length} change(s) now, with the update (one signed commit)?`,
      );
    }
    if (!send) {
      if (yours.length) {
        s.action(
          "Your changes stay here, not sent; the engine upgrade waits for them.",
          "bun run stolos apply",
          "E105-UNSENT",
        );
      }
      s.done(changed.length || ahead ? "nothing sent" : "nothing to send");
    } else {
      const what = [
        ...(waiting ? [`engine upgrade to ${waiting.to}`] : []),
        ...records.map((r) => r.what),
        ...(yours.length ? [`${yours.length} change(s) of yours`] : []),
        ...(ahead ? [`${ahead} commit(s)`] : []),
      ].join("; ");
      const args = ["apply"];
      if (records.length && !yours.length) {
        args.push("-m", `${P.fleetId}: ${records.map((r) => r.what).join("; ")}`);
      }
      const r = await stolos(args);
      if (
        !took(
          s,
          r,
          "Nothing was sent: the send did not finish. Your files are safe.",
          "bun run stolos apply",
        )
      ) {
        s.done();
        return 1;
      }
      s.done(`sent: ${what}`);
      if (waiting) finishedUpgrade = waiting.to;
      ahead = 0;
      dirty = (await git(["status", "--porcelain", "--untracked-files=no"])).stdout.trim();
    }
  }
  if (finishedUpgrade) {
    ui.verdictTitle = `Updated to ${finishedUpgrade}`;
    return await onNewEngine(o, finishedUpgrade);
  }

  // 3. The engine: the newest Stolos release, and the pin.
  const e = ui.phase("Engine");
  const pin = readPin((await fs.readTextOr(path.join(P.repo, PIN_FILE))) ?? "");
  const remoteUrl = pin ? engineRemote(pin) : undefined;
  let upgradeTo: string | undefined;
  if (!pin || !remoteUrl) e.done("not pinned to a release (an engine checkout): nothing to check");
  else {
    e.status("newest release of the engine");
    const ls = await run(["git", "ls-remote", "--tags", "--refs", remoteUrl]);
    const newest = ls.ok ? newestTag(ls.stdout) : undefined;
    if (!newest) {
      ui.log(`   git ls-remote ${remoteUrl}: ${ls.stderr.trim()}`);
      e.warn(
        "The engine's newest release could not be read, so the engine was not checked.",
        "bun run stolos update",
        "E105-GITHUB",
      );
      e.done(`pinned ${pin.tag}`);
    } else if (compare(parseTag(newest) ?? [0, 0, 0], parseTag(pin.tag) ?? [0, 0, 0]) <= 0) {
      e.done(`${pin.tag}, the newest release`);
    } else if (o.noUpgrade || dirty || ahead) {
      e.action(
        `${newest} is out (pinned: ${pin.tag}): next, once your changes are sent.`,
        dirty || ahead ? "bun run stolos apply" : "bun run stolos update",
        "E105-UNSENT",
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
          "bun run stolos keys setup",
          blocking[0]?.code ?? "E057-NO-KEY",
        );
        e.done();
      } else {
        upgradeTo = newest;
        e.done(`${newest} is out (pinned: ${pin.tag}): upgrading`);
      }
    }
  }
  if (upgradeTo && pin) {
    // A fresh process with the engine pinned now: it validates, locks, and makes one signed commit.
    const up = ui.phase("Upgrade");
    if (
      !took(
        up,
        await stolos(["fleet", "upgrade", upgradeTo]),
        `The engine upgrade to ${upgradeTo} did not finish. Nothing was sent.`,
        "bun run stolos update",
      )
    ) {
      up.done();
      return 1;
    }
    up.done(`pinned to ${upgradeTo} (one signed commit)`);
    // Spec 099: publish it too (stolos apply: verified, pushed); pushing is approval.
    const pub = ui.phase("Publish");
    if (
      !took(
        pub,
        await stolos(["apply"]),
        "The upgrade is signed here but not sent.",
        "bun run stolos apply",
      )
    ) {
      pub.done();
      return 1;
    }
    pub.done(`on GitHub: every server moves to ${upgradeTo} within 15 minutes`);
    ui.verdictTitle = `Updated to ${upgradeTo}`;
    await announce(pin.tag, upgradeTo);
    return await onNewEngine(o, upgradeTo);
  }
  return await rest(o, pin);
}

/** What the new engine brought (spec 105-calm-output FR-016): up to five bullets, and each operator action as a thing to do. */
async function announce(from: string, to: string): Promise<void> {
  const w = await whatsNew(from, to);
  if (w.bullets.length) {
    ui.outcome(`What's new in ${to}:`);
    for (const b of w.bullets) ui.outcome(`  - ${b}`);
  }
  if (w.actions.length) {
    const n = ui.phase("What's new");
    for (const a of w.actions) n.action(a, "", "E105-OPERATOR");
    n.done();
  }
}

/**
 * The rest of the update, on the engine that was just adopted (spec 105-calm-output FR-015): a
 * fresh process, so what is reported is what runs, and its problems are this run's.
 */
async function onNewEngine(o: OperatorUpdateOptions, tag: string): Promise<number> {
  const n = ui.phase(`The engine ${tag}`);
  const r = await stolos(["update", "--no-upgrade", ...(o.noDoctor ? ["--no-doctor"] : [])]);
  took(n, r, `The rest of the update on ${tag} did not finish.`, "bun run stolos update");
  n.done();
  return ui.problems.some((x) => x.level === "fail") ? 1 : 0;
}

/** Install the engine, repair keys, run the doctor: the end of every update. */
async function rest(
  o: OperatorUpdateOptions,
  pin: { source: string; tag: string } | undefined,
): Promise<number> {
  // The engine bun.lock holds, installed here: what stolos runs, and what VS Code checks fleet.ts against.
  if (pin) {
    const ed = ui.phase("Install");
    ed.status("bun install --frozen-lockfile (the engine bun.lock holds)");
    const { installEngine } = await import("../fleet/scaffold.ts");
    const c = await installEngine(P.repo);
    if (c.ok) ed.done(`the engine ${pin.tag}, as bun.lock holds it`);
    else {
      ui.log(`   bun install: ${c.why}`);
      const integrity = /integrity|checksum|mismatch/i.test(c.why ?? "");
      ed.warn(
        integrity
          ? "The engine does not match bun.lock. Stop: do not regenerate bun.lock."
          : "The engine could not be installed on this PC.",
        integrity ? "bun run stolos explain E046-LOCK-INTEGRITY" : "bun run stolos update",
        integrity ? "E046-LOCK-INTEGRITY" : "E105-INSTALL",
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

  // 5. The doctor (in a fresh process, as a phase of this run: its problems are merged, once).
  if (!o.noDoctor) {
    const boot = await fs.exists(SECRETS.adminPasswordHash);
    const r = boot ? await stolos(["boot", "doctor"]) : await stolos(["keys"]);
    const dr = ui.phase("Doctor");
    took(
      dr,
      r,
      `${boot ? "boot doctor" : "stolos keys"} did not finish.`,
      boot ? "bun run stolos boot doctor" : "bun run stolos keys",
    );
    dr.done();
  }
  return ui.problems.some((x) => x.level === "fail") ? 1 : 0;
}
