// apt with real progress (spec 018): APT::Status-Fd=2 makes apt report
// "pmstatus:<pkg>:<percent>:<text>" and "dlstatus:..." lines on stderr, which
// drive the progress bar; everything else goes to the run log. apt's warnings
// are translated into problems with a fix instead of being pasted raw.

import { stream as realStream } from "../core/exec.ts";
import type { Phase } from "../core/ui.ts";

/** apt's runner and the pause between retries, replaceable in tests (spec 009). */
export const aptDeps = {
  stream: realStream,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};
const stream = (...a: Parameters<typeof realStream>) => aptDeps.stream(...a);

/**
 * A network-shaped apt failure (spec 009): DNS, unreachable, timed out. On an
 * IPv4-only network with a flaky upstream resolver these come and go; they are
 * retried, then reported as a warning that the next reconcile clears.
 */
export const NETWORK =
  /Temporary failure resolving|Could not resolve|Cannot initiate the connection|Could not connect|Connection timed out|Connection failed|Network is unreachable|Unable to connect|Connection reset/i;
/** "...no longer has a Release file" is network-shaped only after connection errors. */
const RELEASE_GONE = /no longer has a Release file|does not have a Release file/i;
/** Backoff before each retry of a network-shaped failure (about 10 s, 30 s, 60 s). */
export const NETWORK_BACKOFF_MS = [10_000, 30_000, 60_000];
export const ARCHIVE_UNREACHABLE =
  "could not reach the Ubuntu archive; the next reconcile tries again";

const ENV = () => ({
  DEBIAN_FRONTEND: "noninteractive",
  PATH: Deno.env.get("PATH") ?? "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  // Package scripts that manage config with ucf (unattended-upgrades owns
  // 20auto-upgrades this way) must keep the file Archon wrote, not stop to
  // ask: dpkg's --force-confold does not reach ucf.
  UCF_FORCE_CONFFOLD: "1",
});

export interface AptIssue {
  level: "warn" | "fail";
  message: string;
  fix?: string;
  /** DNS, unreachable, or timed out: retried, then a warning (spec 009). */
  network?: boolean;
}

/** Turn apt's W:/E: lines into one actionable issue per cause. */
export function classifyAptLine(line: string): AptIssue | undefined {
  // "Err:1 <url>" is apt's progress for item 1; its reason is on the next line.
  if (/^Err:\d+\s/.test(line)) return undefined;
  const m = line.match(/^(W|E|Err):\s*(.*)$/);
  if (!m) return undefined;
  const text = m[2];
  const level = m[1] === "W" ? "warn" : "fail";
  if (/Not live until|is not valid yet/i.test(text)) {
    const repo = text.match(/https?:\/\/\S+?\s+(\S+)\s+InRelease/)?.[1] ??
      text.match(/\/dists\/([^/\s]+)\/InRelease/)?.[1] ?? "a Debian repository";
    return {
      level: "warn",
      message: `${repo} not refreshed: the system clock is behind`,
      fix: "sudo timedatectl set-ntp true, then sudo archon update",
    };
  }
  // dpkg's own lines name the package; aptInstall reports those instead.
  if (/Sub-process \/usr\/bin\/dpkg returned an error code/.test(text)) return undefined;
  if (/Some index files failed to download|previous index files will be used/i.test(text)) {
    return undefined;
  }
  if (NETWORK.test(text)) {
    return {
      level: "warn",
      message: ARCHIVE_UNREACHABLE,
      fix:
        "check networking: resolvectl query archive.ubuntu.com; getent ahostsv4 archive.ubuntu.com",
      network: true,
    };
  }
  if (/Failed to fetch/i.test(text)) {
    return {
      level,
      message: `apt failed to fetch ${text.match(/https?:\/\/\S+/)?.[0] ?? "an index"}`,
    };
  }
  return { level, message: `apt: ${text}` };
}

export interface DpkgFailure {
  pkg: string;
  reason: string;
  /** The script's last output before dpkg gave up: usually the real cause. */
  cause?: string;
}

const PROGRESS =
  /^(Reading|Building|Selecting|Preparing|Unpacking|Setting up|Processing|\(Reading|Errors were encountered|E: Sub-process|dpkg: dependency problems)/;

/**
 * Collect "dpkg: error processing package X (--configure):" and the reason on
 * the following line, so a failure names the package instead of apt's
 * "Sub-process /usr/bin/dpkg returned an error code (1)".
 */
export function dpkgFailureParser(): {
  feed(line: string): void;
  error(pkg: string, reason: string): void;
  failures: DpkgFailure[];
} {
  const failures: DpkgFailure[] = [];
  let pending: DpkgFailure | undefined;
  let lastOutput = "";
  return {
    failures,
    error(pkg: string, reason: string) {
      const name = pkg.replace(/:\w+$/, "").replace(/^.*\/([^/_]+)_[^/]*\.deb$/, "$1");
      const f = failures.find((x) => x.pkg === name);
      if (f) f.reason ||= reason.trim();
      else failures.push({ pkg: name, reason: reason.trim() });
    },
    feed(line: string) {
      const m = line.match(/^dpkg: error processing (?:package|archive) (\S+?)(?::\w+)? \(/);
      if (m) {
        pending = { pkg: m[1], reason: "", ...(lastOutput ? { cause: lastOutput } : {}) };
        lastOutput = "";
        const f = failures.find((x) => x.pkg === m[1]);
        if (f) {
          f.cause ??= pending.cause;
          pending = f;
        } else failures.push(pending);
        return;
      }
      if (pending && line.trim()) {
        pending.reason ||= line.trim();
        pending = undefined;
        return;
      }
      if (line.trim() && !PROGRESS.test(line.trim()) && !/^ \S+$/.test(line)) {
        lastOutput = line.trim();
      }
    },
  };
}

/** Another apt or dpkg (Ubuntu's daily apt run, unattended-upgrades) holds a lock. */
export const LOCKED =
  /Could not get lock|Unable to lock|is another process using it|Unable to acquire the dpkg frontend lock/i;
/** apt waits up to 5 minutes for dpkg's lock by itself... */
const LOCK_WAIT = ["-o", "DPkg::Lock::Timeout=300"];
/** ...and Archon retries the rest (the package-lists lock) for as long. */
const LOCK_RETRIES = 30;
const LOCK_PAUSE_MS = 10_000;

export interface AptResult {
  ok: boolean;
  /** It failed for network reasons only (warned, not failed). */
  network: boolean;
}

/**
 * `apt-get update`: waits for another apt holding a lock, and retries
 * network-shaped failures with backoff (spec 009). A failure that stays
 * network-shaped is a warning; anything else is a failure.
 */
export async function aptUpdate(p: Phase): Promise<AptResult> {
  let lockTries = 0;
  let netTries = 0;
  for (;;) {
    const issues: AptIssue[] = [];
    let locked = false;
    let netError = false;
    let releaseGone = false;
    p.status(
      lockTries
        ? "waiting for another apt to finish"
        : netTries
        ? `refreshing package lists (retry ${netTries})`
        : "refreshing package lists",
    );
    const code = await stream(["apt-get", "update", "-q", ...LOCK_WAIT], {
      env: ENV(),
      onLine: (line) => {
        p.note(line);
        if (LOCKED.test(line)) {
          locked = true;
          return;
        }
        if (NETWORK.test(line)) netError = true;
        if (RELEASE_GONE.test(line)) releaseGone = true;
        const issue = classifyAptLine(line);
        if (issue) issues.push(issue);
        const hit = line.match(/^(Get|Hit|Ign):\d+\s+(\S+)\s+(\S+)/);
        if (hit) p.status(`${hit[1].toLowerCase()} ${hit[3]}`);
      },
    });
    // A Release file "gone" right after connection errors is the network, not the archive.
    const networkOnly = netError &&
      issues.every((i) =>
        i.network || (releaseGone && RELEASE_GONE.test(i.message)) || i.level === "warn"
      );
    if (code !== 0 && locked && lockTries < LOCK_RETRIES) {
      lockTries++;
      await aptDeps.sleep(LOCK_PAUSE_MS);
      continue;
    }
    if (code !== 0 && networkOnly && netTries < NETWORK_BACKOFF_MS.length) {
      await aptDeps.sleep(NETWORK_BACKOFF_MS[netTries++]);
      continue;
    }
    if (code === 0) {
      // Warnings that still let apt finish (one mirror slow, a stale index).
      for (const issue of dedupe(issues)) if (!issue.network) p.warn(issue.message, issue.fix);
      return { ok: true, network: false };
    }
    if (networkOnly) {
      p.warn(ARCHIVE_UNREACHABLE, issues.find((i) => i.network)?.fix);
      return { ok: false, network: true };
    }
    const real = dedupe(issues).filter((i) =>
      !netError || (!i.network && !RELEASE_GONE.test(i.message))
    );
    for (const issue of real) {
      issue.level === "fail" ? p.fail(issue.message, issue.fix) : p.warn(issue.message, issue.fix);
    }
    if (!real.some((i) => i.level === "fail")) {
      p.fail(
        locked
          ? "another apt process held the package lists for 5 minutes"
          : "apt-get update failed (see the log)",
        locked ? "wait for it (ps aux | grep apt), then sudo archon update" : undefined,
      );
    }
    return { ok: false, network: false };
  }
}

function dedupe(issues: AptIssue[]): AptIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => !seen.has(i.message) && seen.add(i.message));
}

interface Attempt {
  code: number;
  failures: DpkgFailure[];
  issues: AptIssue[];
  last: string;
}

/** One `apt-get install` run; problems are collected, not reported. */
async function installOnce(p: Phase, pkgs: string[]): Promise<Attempt> {
  const issues: AptIssue[] = [];
  const dpkg = dpkgFailureParser();
  let last = "";
  const code = await stream(
    [
      "apt-get",
      "install",
      "-y",
      "-q",
      "--no-install-recommends",
      ...LOCK_WAIT,
      "-o",
      "APT::Status-Fd=2",
      "-o",
      "Dpkg::Use-Pty=0",
      "-o",
      "Dpkg::Options::=--force-confdef",
      "-o",
      "Dpkg::Options::=--force-confold",
      ...pkgs,
    ],
    {
      env: ENV(),
      onLine: (line) => {
        const err = line.match(/^pmerror:([^:]*):[\d.]+:(.*)$/);
        if (err) {
          p.note(line);
          dpkg.error(err[1], err[2]);
          return;
        }
        const st = line.match(/^(pm|dl)status:([^:]*):([\d.]+):(.*)$/);
        if (st) {
          const pct = Math.round(Number(st[3]));
          p.step(
            pct,
            100,
            st[1] === "dl"
              ? `downloading ${st[2] || "packages"}`
              : st[4].replace(/^Installing |^Configuring /, "").slice(0, 60),
          );
          return;
        }
        p.note(line);
        if (!PROGRESS.test(line.trim())) last = line.trim();
        dpkg.feed(line);
        const issue = classifyAptLine(line);
        if (issue && !issues.some((x) => x.message === issue.message)) issues.push(issue);
      },
    },
  );
  return { code, failures: dpkg.failures, issues, last };
}

/** `dpkg --configure -a`: finish whatever an interrupted or failed run left. */
async function configurePending(p: Phase): Promise<number> {
  p.status("finishing interrupted package setup (dpkg --configure -a)");
  return await stream(["dpkg", "--configure", "-a"], {
    env: ENV(),
    onLine: (line) => p.note(line),
  });
}

/**
 * Install packages. When a maintainer script fails (often a transient
 * problem during a large first install, such as an initramfs rebuild
 * triggered mid-run), finish pending setup with `dpkg --configure -a` and try
 * once more; only a second failure is reported as one.
 */
export async function aptInstall(p: Phase, pkgs: string[]): Promise<AptResult> {
  if (!pkgs.length) return { ok: true, network: false };
  let a = await installOnce(p, pkgs);
  // Another apt or dpkg is busy (Ubuntu's daily run right after boot): wait, then try again.
  for (
    let n = 1;
    a.code !== 0 && n < LOCK_RETRIES && a.issues.some((i) => LOCKED.test(i.message));
    n++
  ) {
    p.status("waiting for another apt to finish");
    await aptDeps.sleep(LOCK_PAUSE_MS);
    a = await installOnce(p, pkgs);
  }
  // Downloads that failed for network reasons (spec 009): retry with backoff,
  // then warn and leave the packages for the next reconcile.
  const netOnly = (x: Attempt) =>
    x.code !== 0 && !x.failures.length && x.issues.some((i) => i.network) &&
    x.issues.every((i) =>
      i.network || i.level === "warn" || /Failed to fetch|fetch some archives/i.test(i.message)
    );
  for (let n = 0; netOnly(a) && n < NETWORK_BACKOFF_MS.length; n++) {
    p.status(`downloading again (retry ${n + 1})`);
    await aptDeps.sleep(NETWORK_BACKOFF_MS[n]);
    a = await installOnce(p, pkgs);
  }
  if (netOnly(a)) {
    p.warn(
      `${ARCHIVE_UNREACHABLE} (not installed yet: ${pkgs.join(" ")})`,
      a.issues.find((i) => i.network)?.fix,
    );
    return { ok: false, network: true };
  }
  let retried: string[] = [];
  const interrupted = a.issues.some((i) => /dpkg --configure -a/.test(i.message));
  if (a.code !== 0 && (a.failures.length || interrupted)) {
    retried = a.failures.map((f) => f.pkg);
    p.note(`retrying after dpkg failures: ${retried.join(" ") || "(unnamed)"}`);
    await configurePending(p);
    a = await installOnce(p, pkgs);
  }
  for (const issue of a.issues) {
    issue.level === "fail" ? p.fail(issue.message, issue.fix) : p.warn(issue.message, issue.fix);
  }
  for (const f of a.failures) {
    p.fail(
      `${f.pkg} did not install: ${f.cause ?? (f.reason || "its maintainer script failed")}`,
      "sudo dpkg --configure -a shows the script's full output and retries it",
    );
  }
  if (a.code !== 0 && !a.issues.length && !a.failures.length) {
    p.fail(
      `apt-get install failed for ${pkgs.join(" ")}${a.last ? `: ${a.last}` : ""}`,
      "sudo dpkg --configure -a to retry; the run log has apt's full output",
    );
  }
  if (a.code === 0 && retried.length) {
    p.note(`${retried.join(", ")} installed on the second try (after dpkg --configure -a)`);
  }
  return { ok: a.code === 0, network: false };
}
