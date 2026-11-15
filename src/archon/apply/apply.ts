/**
 * `archon apply`: converge a host to its plan (Article XI). Idempotent: a run
 * right after a successful run reports zero changes. Never removes anything
 * (Article IX).
 *
 * @module
 */

import { getRecord, putRecord } from "../state/store.ts";
import { dirname, join } from "../core/path.ts";
import { P } from "../core/paths.ts";
import { ensureDir, exists, readTextOr } from "../core/fsx.ts";
import { currentUser, isRoot, run, splitArgs, which } from "../core/exec.ts";
import { type Phase, ui } from "../core/ui.ts";
import { aptInstall, aptUpdate } from "./apt.ts";
import { addPpa, aptVersions, ppaHasRelease, ppaPresent } from "./ppa.ts";
import { recordChanges } from "../core/telemetry.ts";
import { networkOf } from "../model/resolve.ts";
import { planFor } from "../build.ts";
import { groupsFor } from "../personas/mod.ts";
import type { Action, FileDef, HostDef, HostPlan, UnitDef, UserDef } from "../model/types.ts";
import { homeOf } from "../model/load.ts";
import type { Hold } from "../proposal/drift.ts";

/** What `archon apply` does. */
export interface ApplyOptions {
  /** Only report what would change; change nothing. */
  check: boolean;
  /** Alternate root for files (testing). Skips packages, accounts, units, actions. */
  root?: string;
  /** Run only these phases (default: all). A second pass after tools sync needs only dotfiles. */
  only?: Array<
    "packages" | "accounts" | "files" | "units" | "databases" | "containers" | "dotfiles"
  >;
}

/** What an apply did. */
export interface ApplyResult {
  /** The host's name. */
  host: string;
  /** Whether it was a check (nothing changed). */
  check: boolean;
  /** Every change made (or, in a check, that would be made), one line each. */
  changes: string[];
  /** Steps left for a later run (for example a file whose owner does not exist yet). */
  skipped: string[];
  /** Whether any step failed. */
  failed: boolean;
}

/** What a converge step reports to (spec 040): this run's phase. */
function sinkOf(r: Runner) {
  return {
    check: !!r.opts.check,
    change: (m: string) => r.change(m),
    warn: (m: string, fix?: string) => r.p.warn(m, fix),
    fail: (m: string, fix?: string) => r.fail(m, fix),
    unreadable: (path: string) => r.unreadable.push(path),
  };
}

class Runner {
  changes: string[] = [];
  skipped: string[] = [];
  failed = false;
  /** Dotfiles skipped because chezmoi is not installed yet. */
  dotfilesWaiting = false;
  actions: Action[] = [];
  /** The phase being reported (Article XXII: counted, not listed). */
  p!: Phase;
  /** Files a read-only check could not read as the calling user. */
  unreadable: string[] = [];
  /** The host being applied (for operator switches, spec 037). */
  host = "";
  /** Its opt-in switches as the model has them (Git's decisions over local records, spec 047). */
  optIn: Record<string, { enabled: boolean }> = {};
  constructor(readonly opts: ApplyOptions) {}
  get sandbox() {
    return !!this.opts.root;
  }
  path(p: string) {
    return this.opts.root ? join(this.opts.root, p) : p;
  }
  change(msg: string) {
    this.changes.push(msg);
    this.p.change(msg);
  }
  skip(msg: string) {
    this.skipped.push(msg);
    this.p.skip(msg);
  }
  fail(msg: string, fix?: string) {
    this.failed = true;
    this.p.fail(msg, fix);
  }

  /**
   * One item of a read-only check run without sudo: what the calling user may
   * not read is noted (never compared, never a failure); a real apply runs as
   * root and is unaffected.
   */
  async guard<T>(label: string, f: () => Promise<T>): Promise<T | undefined> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof Deno.errors.PermissionDenied && this.opts.check && !isRoot()) {
        this.unreadable.push(label);
        return undefined;
      }
      throw e;
    }
  }

  /** Count this phase's changes for its one-line result. */
  mark() {
    return this.changes.length;
  }
}

/**
 * `archon apply`: converge the host to its plan. Must run as root unless
 * `check` or `root` is set. A real run also records provenance (spec 014),
 * restarts Archon's daemons when the code changed, commits /etc with
 * etckeeper (spec 033), settles the install record after a success (spec
 * 009), and, for a full apply, reports a change of state (spec 025).
 */
export async function apply(host: HostDef, opts: ApplyOptions): Promise<ApplyResult> {
  if (!opts.check && !opts.root && !isRoot()) {
    throw new Error("archon apply must run as root (it elevates through sudo automatically)");
  }
  const started = new Date();
  const result = await applyPlan(host, opts, started);
  recordChanges(result.changes.length, opts.check);
  if (!opts.check && !opts.root) {
    // Spec 014: every apply that changed something is a provenance activity.
    const { recordActivity } = await import("../prov/prov.ts");
    await recordActivity(host.name, {
      started,
      ended: new Date(),
      changes: result.changes,
      failed: result.failed,
      log: ui.logPath ?? undefined,
    });
    // Archon's own long-running services (the welcome page, notify watch) run
    // the checkout's code: restart them when that code changed since they started.
    await restartArchonDaemons(await planFor(host)).catch(() => {});
    // Spec 033: what this apply changed in /etc is one etckeeper commit, attributed.
    if (result.changes.length) await etckeeperCommit(result.changes).catch(() => {});
    // Spec 009 FR-008: a first boot that met a transient failure is settled by
    // the next apply that succeeds.
    const ok = !result.failed && !ui.problems.some((p) => p.level === "fail");
    if (ok) await settleInstallRecord(host.name);
    // Spec 025: a message when a full apply changes state (failing, recovered).
    if (!opts.only) {
      const { applyOutcome } = await import("../notify/events.ts");
      const { loadFleet } = await import("../model/load.ts");
      await applyOutcome(
        host.name,
        ok,
        ui.problems.filter((p) => p.level === "fail").map((p) => `${p.phase}: ${p.message}`),
        ui.logPath,
        (await loadFleet()).timezone,
      ).catch(() => {});
    }
  }
  return result;
}

/** Archon's long-running services: managed units that run archon and are not oneshot. */
export function archonDaemons(units: UnitDef[]): string[] {
  return units.filter((u) =>
    u.managed && u.content && /ExecStart=\/usr\/local\/bin\/archon /.test(u.content) &&
    !/Type=oneshot/.test(u.content) && u.state === "enabled"
  ).map((u) => u.unitName).sort();
}

/**
 * Restart Archon's own daemons when the checkout's code changed since they
 * started (the checkout's HEAD, remembered in /var/lib/archon/status/daemons-head).
 * A pull alone does not restart a running process, so without this the
 * welcome page kept serving the code it started with.
 */
export async function restartArchonDaemons(plan: HostPlan): Promise<string[]> {
  const head = (await run(["git", "-C", P.repo, "rev-parse", "HEAD"])).stdout.trim();
  if (!head) return [];
  const mark = "/var/lib/archon/status/daemons-head";
  if ((await readTextOr(mark))?.trim() === head) return [];
  const daemons = archonDaemons(plan.units);
  if (daemons.length) await run(["systemctl", "try-restart", ...daemons]);
  await Deno.writeTextFile(mark, head + "\n").catch(() => {});
  return daemons;
}

/**
 * Spec 033: commit /etc's changes as archon's, so etckeeper's history tells an
 * archon apply from apt, unattended-upgrades, and a person.
 */
export async function etckeeperCommit(changes: string[]): Promise<boolean> {
  if (!(await exists("/usr/bin/etckeeper"))) return false;
  if ((await run(["etckeeper", "unclean"])).code !== 0) return false; // nothing to commit
  const specs = [
    ...new Set(changes.flatMap((c) => c.match(/\(([0-9]{3}-[a-z0-9-]+)\)/)?.[1] ?? [])),
  ];
  const msg = `archon apply: ${changes.length} change(s)${
    specs.length ? ` (${specs.join(", ")})` : ""
  }\n\n${changes.slice(0, 50).join("\n")}`;
  return (await run(["etckeeper", "commit", msg])).ok;
}

/** The install record at "ok": false becomes ok once an apply succeeds; its problems are kept as resolved. */
export async function settleInstallRecord(hostName: string, root = P.state): Promise<boolean> {
  const r = await getRecord<Record<string, unknown>>(hostName, "install", "install", root);
  if (!r) return false;
  const rec = r.body;
  if (rec.ok !== false) return false;
  rec.ok = true;
  rec.resolved = { at: new Date().toISOString(), by: "apply", problems: rec.problems ?? [] };
  rec.problems = [];
  await putRecord(hostName, "install", "install", rec, root, r.at);
  return true;
}

async function applyPlan(host: HostDef, opts: ApplyOptions, _started: Date): Promise<ApplyResult> {
  const plan = await planFor(host);
  const r = new Runner(opts);
  r.host = host.name;
  r.optIn = host.optIn ?? {};
  const verb = opts.check ? "would" : "";
  // "12 installed" after a run; "12 to install" with --check.
  const n = (k: number, done: string, todo: string) => `${k} ${verb ? todo : done}`;
  const want = (x: NonNullable<ApplyOptions["only"]>[number]) =>
    !opts.only || opts.only.includes(x);

  if (!r.sandbox && want("packages")) {
    r.p = ui.phase("Packages");
    const installed = await packages(plan, r);
    r.p.done(installed ? n(installed, "changed", "to change") : "all present");
  }
  if (!r.sandbox && want("accounts")) {
    r.p = ui.phase("Accounts");
    const before = r.mark();
    await groupsFirst(plan, r);
    await users(plan, r);
    r.p.done(
      r.mark() - before
        ? n(r.mark() - before, "changed", "to change")
        : `${plan.users.map((u) => u.name).join(", ")} up to date`,
    );
  }

  // Spec 095 (the owner's decision 1): a managed file or unit a person changed under sudo is
  // held, up to 7 days or until its proposal is decided; then the model wins.
  let held: Map<string, Hold> | undefined;
  const holds = async (): Promise<Map<string, Hold>> => {
    if (held) return held;
    held = new Map();
    if (r.sandbox || plan.host.kind === "workstation") return held;
    try {
      const h = await import("../proposal/hold.ts");
      held = opts.check || !isRoot() ? await h.activeHolds(host.name) : await h.refreshHolds(plan);
    } catch (e) {
      if (e instanceof Deno.errors.PermissionDenied && !isRoot()) r.unreadable.push("holds");
      else {
        r.p.warn(
          `holds not read: ${(e as Error).message}`,
          "archon drift shows what was changed by hand",
        );
      }
    }
    return held;
  };
  const heldNote = async (key: string): Promise<string | undefined> => {
    const h = (await holds()).get(key);
    if (!h) return undefined;
    const { heldLine } = await import("../proposal/hold.ts");
    return heldLine(h);
  };

  if (want("files")) {
    r.p = ui.phase("Files");
    const fBefore = r.mark();
    for (const [i, f] of plan.files.entries()) {
      r.p.step(i + 1, plan.files.length, f.path);
      const note = await heldNote(`file:${f.path}`);
      if (note) {
        r.skip(`${f.path}: ${note}`);
        continue;
      }
      await r.guard(f.path, () => file(f, r));
    }
    if (!r.sandbox) await actions(r);
    // Directories Archon writes into (prov, status, snapshots) can be created
    // by a run before their group exists; re-assert tmpfiles ownership and
    // modes every run (idempotent, quiet).
    if (!r.sandbox && !opts.check) {
      for (const f of plan.files.filter((x) => x.path.startsWith("/etc/tmpfiles.d/"))) {
        if (await exists(f.path)) await run(["systemd-tmpfiles", "--create", f.path]);
      }
    }
    // Opt-in containers turned on (spec 040): their generated secrets exist before they start.
    if (!r.sandbox && plan.host.optIn?.s3?.enabled) {
      const { prepareS3 } = await import("../s3/s3.ts");
      await r.guard("/var/lib/archon/s3", () => prepareS3(sinkOf(r)));
    }
    // Spec 050: the telemetry web UI's credentials (and the Collector's copy).
    if (!r.sandbox && plan.host.optIn?.["otel-ui"]?.enabled) {
      const { prepareOtelUi } = await import("../otelui/otelui.ts");
      await r.guard("/var/lib/archon/otel-ui", () => prepareOtelUi(sinkOf(r)));
    }
    const written = r.mark() - fBefore;
    r.p.done(written ? n(written, "written", "to write") : `${plan.files.length} up to date`);
  }

  if (!r.sandbox && want("units")) {
    r.p = ui.phase("Units");
    const uBefore = r.mark();
    for (const [i, u] of plan.units.entries()) {
      r.p.step(i + 1, plan.units.length, u.unitName);
      const note = await heldNote(`unit:${u.unitName}`);
      if (note) {
        r.skip(`${u.unitName}: ${note}`);
        continue;
      }
      await r.guard(u.unitName, () => unit(u, r));
    }
    const uChanged = r.mark() - uBefore;
    r.p.done(uChanged ? n(uChanged, "changed", "to change") : `${plan.units.length} up to date`);
  }
  if (!r.sandbox && want("databases")) {
    // Specs 038, 039: each PostgreSQL instance the model and the host's record keep,
    // while PostgreSQL (an opt-in service, spec 040) is on.
    const { instancesOf, pgOn } = await import("../pg/config.ts");
    const instances = instancesOf(plan.host, plan.users, plan.fleet);
    if (pgOn(plan.host) && instances.length) {
      r.p = ui.phase("Databases");
      const { convergeInstance, writeSystemServices } = await import("../pg/converge.ts");
      const before = r.mark();
      const sink = {
        check: !!opts.check,
        change: (m: string) => r.change(`${m} (038-pg)`),
        warn: (m: string, fix?: string) => r.p.warn(m, fix),
        fail: (m: string, fix?: string) => r.fail(m, fix),
        unreadable: (path: string) => r.unreadable.push(path),
      };
      for (const i of instances) {
        await r.guard(
          `PostgreSQL ${i.name}`,
          () => convergeInstance(plan.fleet, plan.host, i, sink, "archon apply"),
        );
      }
      await r.guard(
        "/etc/postgresql-common/pg_service.conf",
        () => writeSystemServices(plan.host.name, sink),
      );
      r.p.done(
        r.mark() - before
          ? n(r.mark() - before, "changed", "to change")
          : `${instances.map((i) => i.name).join(", ")} up to date`,
      );
    }
  }
  if (!r.sandbox && want("containers") && plan.host.optIn?.s3?.enabled) {
    // Spec 041: S3's users are the server's Linux accounts and the fleet's service accounts.
    r.p = ui.phase("Containers");
    const before = r.mark();
    const { convergeS3 } = await import("../s3/s3.ts");
    await r.guard("S3 users", () => convergeS3(plan, sinkOf(r)));
    r.p.done(r.mark() - before ? n(r.mark() - before, "changed", "to change") : "S3 up to date");
  }
  if (!r.sandbox && want("dotfiles")) {
    r.p = ui.phase("Dotfiles");
    const applied: string[] = [];
    for (const u of plan.users) {
      if (await r.guard(`dotfiles of ${u.name}`, () => dotfiles(plan.host.name, u, r))) {
        applied.push(u.name);
      }
    }
    r.p.done(
      applied.length
        ? `${verb ? "pending: " : ""}${applied.join(", ")}`
        : r.dotfilesWaiting
        ? "waiting for chezmoi (installed by the tools step)"
        : "up to date",
    );
  }
  if (r.unreadable.length) {
    ui.next.push(
      `Not compared (readable only by root or their owner): ${
        r.unreadable.join(", ")
      }. sudo archon apply --check compares everything.`,
    );
  }
  const result: ApplyResult = {
    host: plan.host.name,
    check: opts.check,
    changes: r.changes,
    skipped: r.skipped,
    failed: r.failed,
  };
  return result;
}

// ------------------------------------------------------------------ packages

async function installed(pkg: string): Promise<boolean> {
  const q = await run(["dpkg-query", "-W", "-f=${db:Status-Abbrev}", pkg]);
  return q.ok && q.stdout.startsWith("ii");
}

async function snapInstalled(name: string): Promise<boolean> {
  return (await run(["snap", "list", name])).ok;
}

/**
 * Maintainers' PPAs (spec 010): add each one that has builds for this release.
 * Returns the PPAs in use, so their packages can be brought to the PPA's version.
 */
async function ppas(plan: HostPlan, r: Runner): Promise<Set<string>> {
  const codename = plan.fleet.ubuntu.codename;
  const inUse = new Set<string>();
  let added = false;
  const ipv4Only = !networkOf(plan.fleet, plan.host).ipv6;
  let launchpadDown = false;
  for (const ppa of new Set(plan.packages.flatMap((p) => p.ppa ? [p.ppa] : []))) {
    if (await ppaPresent(ppa, codename)) {
      inUse.add(ppa);
      continue;
    }
    r.p.status(`checking ppa:${ppa} for ${codename}`);
    // Once Launchpad proved unreachable, the next PPA is asked once, without waiting again.
    const { answer: has, reason } = await ppaHasRelease(ppa, codename, {
      ipv4Only,
      retries: !launchpadDown,
    });
    if (has === "unreachable") launchpadDown = true;
    if (has !== "yes") {
      r.p.warn(
        has === "no"
          ? `ppa:${ppa} has no builds for Ubuntu ${plan.fleet.ubuntu.release} (${codename}) yet: keeping Ubuntu's package`
          : `could not reach ppa.launchpadcontent.net to check ppa:${ppa} (${reason}): keeping Ubuntu's package for now`,
        has === "no"
          ? "nothing to do: the next apply adds it once the PPA publishes for this release"
          : "check the network (curl -sI https://ppa.launchpadcontent.net); the next apply tries again",
      );
      continue;
    }
    r.change(`add ppa:${ppa} (010-tools)`);
    inUse.add(ppa);
    if (r.opts.check) continue;
    // add-apt-repository is Ubuntu Server's (software-properties-common); make sure.
    if (!(await which("add-apt-repository"))) {
      await aptUpdate(r.p);
      const sp = await aptInstall(r.p, ["software-properties-common"]);
      if (!sp.ok) {
        if (!sp.network) r.failed = true;
        continue; // no add-apt-repository yet: the next reconcile adds the PPA
      }
    }
    const res = await addPpa(ppa);
    if (!res.ok) {
      r.fail(`add-apt-repository ppa:${ppa}: ${res.output}`);
      inUse.delete(ppa);
    } else added = true;
  }
  if (added) await aptUpdate(r.p);
  return inUse;
}

/**
 * Vendors' apt repositories (spec 010): the pinned key and a deb822 source,
 * written before packages so their packages install in the same run.
 */
async function vendorRepos(plan: HostPlan, r: Runner): Promise<void> {
  let changed = false;
  for (const repo of plan.aptRepos) {
    const keyPath = `/etc/apt/keyrings/archon-${repo.id}.asc`;
    const files: Array<[string, string]> = [
      [keyPath, repo.key.trim() + "\n"],
      [
        `/etc/apt/sources.list.d/archon-${repo.id}.sources`,
        `# Archon (${repo.spec}): ${repo.uri}, signing key pinned in the repository.\n` +
        `Types: deb\nURIs: ${repo.uri}\nSuites: ${repo.suites}\nComponents: ${repo.components}\n` +
        `Architectures: ${plan.host.arch}\nSigned-By: ${keyPath}\n`,
      ],
    ];
    for (const [path, content] of files) {
      if ((await readTextOr(path)) === content) continue;
      r.change(`write ${path} (${repo.spec})`);
      changed = true;
      if (r.opts.check) continue;
      await ensureDir(dirname(path));
      await Deno.writeTextFile(path, content);
      await Deno.chmod(path, 0o644);
    }
  }
  if (changed && !r.opts.check) await aptUpdate(r.p);
}

/** apt and snap are both native on Ubuntu (Article 2). */
async function packages(plan: HostPlan, r: Runner): Promise<number> {
  await vendorRepos(plan, r);
  const inUse = await ppas(plan, r);
  const missing: string[] = [];
  const upgrade: string[] = [];
  const snaps: string[] = [];
  for (const [i, p] of plan.packages.entries()) {
    r.p.step(i + 1, plan.packages.length, `checking ${p.name}`);
    if (p.source === "snap") {
      if (!(await snapInstalled(p.name))) snaps.push(p.name);
    } else if (!(await installed(p.name))) missing.push(p.name);
    else if ((p.ppa && inUse.has(p.ppa)) || p.repo) {
      // Installed from Ubuntu before the PPA was added: move to the PPA's build now
      // (unattended-upgrades keeps it current from here).
      const v = await aptVersions(p.name);
      if (v.candidate && v.installed && v.candidate !== v.installed) {
        upgrade.push(p.name);
        r.change(
          `upgrade ${p.name} ${v.installed} -> ${v.candidate} (${p.ppa ? `ppa:${p.ppa}` : p.repo})`,
        );
      }
    }
  }
  for (const m of missing) r.change(`install ${m}`);
  for (const m of snaps) r.change(`snap install ${m}`);
  const count = missing.length + upgrade.length + snaps.length;
  if (r.opts.check || !count) return count;
  if (missing.length || upgrade.length) {
    const u = missing.length ? await aptUpdate(r.p) : { ok: true, network: false };
    if (!u.ok) {
      // Spec 009: the archive could not be reached (warned). Skip only these
      // installs; the rest of apply goes on, and the next reconcile retries.
      if (!u.network) r.failed = true;
      for (const m of [...missing, ...upgrade]) {
        r.skip(`install ${m}: waits for the Ubuntu archive`);
      }
    } else {
      // Preseed the questions of packages about to be installed (debconf).
      const pre = plan.packages.filter((p) => missing.includes(p.name)).flatMap((p) =>
        p.debconf ?? []
      );
      if (pre.length) {
        const d = await run(["debconf-set-selections"], { stdin: pre.join("\n") + "\n" });
        if (!d.ok) r.fail(`debconf-set-selections: ${d.stderr.trim()}`);
      }
      const res = await aptInstall(r.p, [...missing, ...upgrade]);
      if (!res.ok && !res.network) r.failed = true;
    }
  }
  for (const m of snaps) {
    r.p.status(`snap install ${m}`);
    const res = await run(["snap", "install", m]);
    // Spec 009: the Snap Store is sometimes unreachable from this network
    // (api.snapcraft.io times out); a warning, retried by the next reconcile.
    if (!res.ok) {
      r.p.warn(
        `snap install ${m}: ${
          (res.stderr || res.stdout).trim().split("\n").pop()
        }; the Snap Store did not answer, the next reconcile tries again`,
        "snap debug connectivity",
      );
    }
  }
  return count;
}

// ------------------------------------------------------------------ accounts

async function groupsFirst(plan: HostPlan, r: Runner) {
  // Persona groups must exist before accounts reference them.
  const sysusers = plan.files.find((f) => f.path === "/etc/sysusers.d/archon.conf");
  if (sysusers) await file(sysusers, r);
  if (!r.opts.check) await run(["systemd-sysusers"]);
}

async function users(plan: HostPlan, r: Runner) {
  for (const u of plan.users) await r.guard(`account ${u.name}`, () => user(u, r));
}

async function user(u: UserDef, r: Runner) {
  const want = groupsFor(u.personas);
  if (u.admin) want.push("sudo");
  const pw = await run(["getent", "passwd", u.name]);
  if (!pw.ok) {
    r.change(`create user ${u.name} (${u.personas.join(", ")})`);
    if (!r.opts.check) {
      const existingGroups = await filterGroups(want);
      const res = await run([
        "useradd",
        "--create-home",
        "--shell",
        "/bin/bash",
        "--user-group",
        ...(existingGroups.length ? ["--groups", existingGroups.join(",")] : []),
        ...(u.fullName ? ["--comment", u.fullName] : []),
        u.name,
      ]);
      if (!res.ok) return r.fail(`useradd ${u.name}: ${res.stderr.trim()}`);
    }
  } else {
    const shell = pw.stdout.trim().split(":")[6];
    if (shell !== "/bin/bash") {
      r.change(`set login shell of ${u.name} to /bin/bash (Article XIX)`);
      if (!r.opts.check) await run(["usermod", "--shell", "/bin/bash", u.name]);
    }
    const have = (await run(["id", "-nG", u.name])).stdout.trim().split(/\s+/);
    const add = (await filterGroups(want)).filter((g) => !have.includes(g));
    if (add.length) {
      r.change(`add ${u.name} to ${add.join(", ")}`);
      if (!r.opts.check) await run(["usermod", "--append", "--groups", add.join(","), u.name]);
    }
  }
  if (u.sshKeys?.length) {
    const home = homeOf(u);
    await file(
      {
        path: `${home}/.ssh/authorized_keys`,
        content: `# Managed by archon (spec 005-ssh). Edit the host model, not this file.\n${
          u.sshKeys.join("\n")
        }\n`,
        mode: "0600",
        owner: u.name,
        group: u.name,
        spec: "005-ssh",
      },
      r,
      { dirMode: 0o700 },
    );
  }
}

async function filterGroups(groups: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const g of new Set(groups)) if ((await run(["getent", "group", g])).ok) out.push(g);
  return out;
}

// --------------------------------------------------------------------- files

async function file(f: FileDef, r: Runner, extra: { dirMode?: number } = {}) {
  const target = r.path(f.path);
  if (f.symlink) {
    let cur: string | undefined;
    try {
      cur = await Deno.readLink(target);
    } catch { /* missing or not a link */ }
    if (cur === f.symlink) return;
    r.change(`link ${f.path} -> ${f.symlink}`);
    if (r.opts.check) return;
    await ensureDir(dirname(target));
    const tmp = `${target}.archon-tmp`;
    try {
      await Deno.remove(tmp);
    } catch { /* none */ }
    await Deno.symlink(f.symlink, tmp);
    await Deno.rename(tmp, target);
    r.actions.push(...(f.onChange ?? []));
    return;
  }
  const content = f.content ?? "";
  let current: string | undefined;
  try {
    current = await readTextOr(target);
  } catch (e) {
    // A read-only check runs as the person who asked (no sudo): files only root or
    // their owner may read (ops' authorized_keys, secrets) cannot be compared.
    if (e instanceof Deno.errors.PermissionDenied && r.opts.check && !isRoot()) {
      r.unreadable.push(f.path);
      return;
    }
    throw e;
  }
  const mode = parseInt(f.mode, 8);
  const contentDiffers = current !== content;
  let metaDiffers = false;
  if (!contentDiffers) {
    const st = await Deno.stat(target);
    metaDiffers = ((st.mode ?? 0) & 0o7777) !== mode;
    if (!r.sandbox && isRoot()) {
      const uid = await idOf("passwd", f.owner);
      const gid = await idOf("group", f.group ?? (f.owner === "root" ? "root" : f.owner));
      if ((uid !== undefined && st.uid !== uid) || (gid !== undefined && st.gid !== gid)) {
        metaDiffers = true;
      }
    }
  }
  if (!contentDiffers && !metaDiffers) return;
  r.change(
    `${
      current === undefined ? "create" : contentDiffers ? "update" : "fix mode/owner of"
    } ${f.path} (${f.spec})`,
  );
  if (r.opts.check) return;

  // Owners that do not exist yet (a fresh account) defer to the next run.
  if (!r.sandbox && f.owner !== "root" && (await idOf("passwd", f.owner)) === undefined) {
    return r.skip(`${f.path}: owner ${f.owner} does not exist yet`);
  }
  const dir = dirname(target);
  if (!(await exists(dir))) {
    // Create missing parents one at a time so every directory created on a
    // user's behalf (for example ~/.config) belongs to that user.
    const missing: string[] = [];
    for (let d = dir; !(await exists(d)); d = dirname(d)) missing.unshift(d);
    for (const d of missing) {
      await Deno.mkdir(d);
      if (!r.sandbox && f.owner !== "root") await chown(d, f.owner, f.group ?? f.owner);
    }
    if (extra.dirMode !== undefined) await Deno.chmod(dir, extra.dirMode);
  }
  const tmp = `${target}.archon-tmp`;
  await Deno.writeTextFile(tmp, content);
  await Deno.chmod(tmp, mode);
  if (f.validate && !r.sandbox) {
    const argv = f.validate.map((a) => (a === "{}" ? tmp : a));
    const v = await run(argv);
    if (!v.ok) {
      await Deno.remove(tmp);
      return r.fail(
        `${f.path}: validation failed (${argv.join(" ")}): ${(v.stderr || v.stdout).trim()}`,
      );
    }
  }
  if (!r.sandbox) await chown(tmp, f.owner, f.group ?? (f.owner === "root" ? "root" : f.owner));
  await Deno.rename(tmp, target);
  if (f.postValidate && !r.sandbox) {
    const v = await run(f.postValidate);
    if (!v.ok) {
      if (current !== undefined) await Deno.writeTextFile(target, current);
      else await Deno.remove(target);
      return r.fail(
        `${f.path}: post-validation failed (${
          f.postValidate.join(" ")
        }), restored previous content: ${(v.stderr || v.stdout).trim()}`,
      );
    }
  }
  r.actions.push(...(f.onChange ?? []));
}

async function idOf(db: "passwd" | "group", name: string): Promise<number | undefined> {
  const res = await run(["getent", db, name]);
  if (!res.ok) return undefined;
  return Number(res.stdout.split(":")[2]);
}

async function chown(path: string, owner: string, group: string) {
  const uid = await idOf("passwd", owner);
  const gid = await idOf("group", group);
  if (uid !== undefined) await Deno.chown(path, uid, gid ?? null);
}

// ------------------------------------------------------------------- actions

async function actions(r: Runner) {
  if (r.opts.check || !r.actions.length) return;
  // Spec 012: run each queued action once, then clear the queue (it used to
  // be re-run by every later unit step).
  const queued = r.actions;
  r.actions = [];
  const seen = new Set<string>();
  const unique = queued.filter((a) => {
    const k = JSON.stringify(a);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // daemon-reload first, then commands, then restarts.
  const order = { "daemon-reload": 0, run: 1, "reload-or-restart": 2, restart: 2 } as const;
  unique.sort((a, b) => order[a.kind] - order[b.kind]);
  for (const a of unique) {
    let res;
    // A unit this same apply has not written yet (a first install): the Units
    // step starts it with its new configuration, so there is nothing to restart.
    if (a.kind === "restart" || a.kind === "reload-or-restart") {
      const load = await run(["systemctl", "show", "-p", "LoadState", "--value", a.unit]);
      if (load.stdout.trim() === "not-found") {
        r.skip(`${a.kind} ${a.unit} (not installed yet: the Units step starts it)`);
        continue;
      }
    }
    if (a.kind === "daemon-reload") res = await run(["systemctl", "daemon-reload"]);
    else if (a.kind === "restart") res = await run(["systemctl", "restart", a.unit]);
    else if (a.kind === "reload-or-restart") {
      res = await run(["systemctl", "reload-or-restart", a.unit]);
    } else {
      if (a.ifExists && !(await exists(a.ifExists))) {
        r.skip(`${a.argv.join(" ")} (${a.ifExists} not installed yet)`);
        continue;
      }
      res = await run(a.argv, { asUser: a.asUser });
    }
    const label = a.kind === "run"
      ? a.argv.join(" ")
      : `${a.kind}${"unit" in a ? ` ${a.unit}` : ""}`;
    r.p.status(label);
    if (res.ok) r.p.ok(label);
    else r.fail(`${label}: ${(res.stderr || res.stdout).trim()}`);
  }
}

// --------------------------------------------------------------------- units

async function unitExists(name: string): Promise<boolean> {
  const res = await run(["systemctl", "list-unit-files", "--no-legend", name]);
  return res.ok && res.stdout.trim().length > 0;
}

/** An operator's switch (spec 037): the opt-in record says {"enabled": true} (spec 048). */
export async function switchOn(host: string, name: string, root = P.state): Promise<boolean> {
  const rec = await getRecord<{ enabled?: boolean }>(host, "optin", name, root);
  return rec?.body?.enabled === true;
}

async function unit(u0: UnitDef, r: Runner) {
  // An operator's switch decides between the unit's own state and "enabled" (spec 037).
  const u: UnitDef = u0.switch &&
      (u0.switch in r.optIn ? r.optIn[u0.switch].enabled : await switchOn(r.host, u0.switch))
    ? { ...u0, state: "enabled", start: true }
    : u0;
  if (u.managed && u.content !== undefined) {
    await file({
      path: `/etc/systemd/system/${u.unitName}`,
      content: u.content,
      mode: "0644",
      owner: "root",
      spec: u.spec,
      onChange: [{ kind: "daemon-reload" }],
    }, r);
    await actions(r);
  }
  if (u.state === "ignore") return;
  if (u.state === "masked") {
    // Stopped and masked, its package kept (spec 001: avahi-daemon). Absent is fine too.
    if (!(await unitExists(u.unitName))) return;
    const st = (await run(["systemctl", "is-enabled", u.unitName])).stdout.trim();
    const activeNow = (await run(["systemctl", "is-active", "--quiet", u.unitName])).ok;
    if (st === "masked" && !activeNow) return;
    r.change(`mask --now ${u.unitName} (${u.spec})`);
    if (r.opts.check) return;
    const res = await run(["systemctl", "mask", "--now", u.unitName]);
    if (!res.ok) r.fail(`systemctl mask --now ${u.unitName}: ${res.stderr.trim()}`);
    return;
  }
  if (!(await unitExists(u.unitName))) {
    if (u.state === "disabled") return; // nothing to disable
    if (r.opts.check && u.managed) return r.change(`enable --now ${u.unitName} (${u.spec})`);
    return r.skip(`${u.unitName}: unit not installed`);
  }
  const enabled = (await run(["systemctl", "is-enabled", u.unitName])).stdout.trim();
  const want = u.state === "enabled";
  if (u.generated && want) {
    // A generated unit (Quadlet): on is unmasked and running; boot follows its [Install].
    const active = (await run(["systemctl", "is-active", "--quiet", u.unitName])).ok;
    if (enabled !== "masked" && active) return;
    r.change(`start ${u.unitName} (${u.spec})`);
    if (r.opts.check) return;
    if (enabled === "masked") {
      const um = await run(["systemctl", "unmask", u.unitName]);
      if (!um.ok) return r.fail(`systemctl unmask ${u.unitName}: ${um.stderr.trim()}`);
      await run(["systemctl", "daemon-reload"]);
    }
    const st = await run(["systemctl", "start", u.unitName]);
    if (!st.ok) {
      r.fail(
        `systemctl start ${u.unitName}: ${st.stderr.trim()}`,
        `journalctl -u ${u.unitName} -n 30`,
      );
    }
    return;
  }
  const isEnabled = enabled === "enabled" || enabled === "static" || enabled === "alias";
  if (
    want !== isEnabled ||
    (want && u.start !== false &&
      !(await run(["systemctl", "is-active", "--quiet", u.unitName])).ok)
  ) {
    const now = u.start === false ? "" : " --now";
    r.change(`${want ? "enable" : "disable"}${now} ${u.unitName} (${u.spec})`);
    if (r.opts.check) return;
    // A switch turned on (spec 037): the unit was masked while it was off.
    if (want && enabled === "masked") {
      const um = await run(["systemctl", "unmask", u.unitName]);
      if (!um.ok) r.fail(`systemctl unmask ${u.unitName}: ${um.stderr.trim()}`);
    }
    const argv = want
      ? ["systemctl", "enable", ...(u.start === false ? [] : ["--now"]), u.unitName]
      : ["systemctl", "disable", ...(u.start === false ? [] : ["--now"]), u.unitName];
    const res = await run(argv);
    if (!res.ok) r.fail(`${argv.join(" ")}: ${res.stderr.trim()}`);
  }
}

export { splitArgs };

// ------------------------------------------------------------------ dotfiles

/**
 * Specs 011 and 031: converge each user's dotfiles. First the user's chezmoi
 * source is composed from the repository's layers into
 * /var/lib/archon-dotfiles/<user>; then `chezmoi verify` (non-zero when the
 * home directory differs) decides whether to apply, which keeps this step
 * idempotent.
 */
async function dotfiles(host: string, u: UserDef, r: Runner): Promise<boolean> {
  const chezmoi = "/usr/local/bin/chezmoi";
  const cfg = `${homeOf(u)}/.config/chezmoi/chezmoi.json`;
  r.p.status(u.name);
  // A check without sudo can only look at the caller's own dotfiles (the others'
  // composed sources and homes are theirs): the rest is noted, not compared.
  if (r.opts.check && !isRoot() && u.name !== currentUser()) {
    r.unreadable.push(`dotfiles of ${u.name}`);
    return false;
  }
  const { syncComposed } = await import("../dotfiles/sync.ts");
  const s = await syncComposed(P.repo, host, u.name, { check: r.opts.check });
  if (s.composition.problems.length) {
    for (const p of s.composition.problems) r.fail(`dotfiles for ${u.name}: ${p}`);
    return false;
  }
  if (s.changed.length) {
    r.change(
      `compose dotfiles for ${u.name}: ${s.changed.length} file(s) from ${
        s.composition.present.map((l) => l.dir).join(", ")
      } (031-dotfile-layers)`,
    );
  }
  if (!(await exists(chezmoi))) {
    r.skip(`dotfiles for ${u.name}: chezmoi not installed yet (archon tools sync)`);
    r.dotfilesWaiting = true;
    return false;
  }
  if (!(await exists(cfg))) {
    r.skip(`dotfiles for ${u.name}: no chezmoi data yet`);
    return false;
  }
  if (r.opts.check && s.changed.length) return true;
  if ((await run([chezmoi, "verify", "--no-tty"], { asUser: u.name })).ok) return false;
  r.change(`chezmoi apply for ${u.name} (011-shell)`);
  if (r.opts.check) return true;
  const res = await run([chezmoi, "apply", "--force", "--no-tty"], { asUser: u.name });
  if (!res.ok) r.fail(`chezmoi apply for ${u.name}: ${(res.stderr || res.stdout).trim()}`);
  return res.ok;
}
