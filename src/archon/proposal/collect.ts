/**
 * Spec 095-proposals: the collectors. Each reads one of Ubuntu's own records
 * (journald's sudo entries, apt's history.log and dpkg.log, etckeeper's git
 * log, osquery, `systemctl list-unit-files`, snapd, podman, `dpkg -S` on
 * /usr/local and /opt, `debsums -c` or `dpkg --verify`) and writes
 * observations (what, who, when, source) into the host's own `archon.sql`,
 * with the latest state and, once, the birth snapshot. Nothing here changes
 * the host. A modified package binary is a security alert, mailed at once and
 * never proposed.
 *
 * ```mermaid
 * flowchart LR
 *   j["journald: sudo"] & a["apt history.log, dpkg.log"] & e["etckeeper: git log /etc"] & o["osquery snapshots"] & u["systemctl list-unit-files"] & s["snap, podman"] & d["dpkg -S, dpkg --verify"] --> c["collect"]
 *   c --> obs["archon.sql: observation"]
 *   c --> st["archon.sql: snapshot (state, osquery)"]
 *   c --> b["archon.sql: birth (once)"]
 *   d -->|"a package file modified"| al["SECURITY ALERT mail<br/>(never a proposal)"]
 * ```
 *
 * @module
 */

import { fs } from "@intellectual-frontiers/ifc-ts/runtime";
import { run } from "../core/exec.ts";
import { onHost, P } from "../core/paths.ts";
import { getRecord, listRecords, putRecord, putRecords } from "../state/store.ts";
import type { HostDef, HostPlan } from "../model/types.ts";
import {
  etckeeperObservations,
  isUbuntuCommit,
  osqueryDiff,
  type OsquerySnapshot,
  parseAptHistory,
  parseDpkgLog,
  parseDpkgSearch,
  parseEtckeeperLog,
  parseModified,
  parseSnapChanges,
  parseSudoJournal,
  parseUnitFiles,
  sudoObservations,
} from "./parse.ts";
import type { Birth, EtcChange, HostState, PlanView } from "./drift.ts";
import type { Alert, Observation } from "./types.ts";

/** What the plan says, for drift: package and unit names, file paths, ports, accounts, Archon's own paths. */
export function planView(plan: HostPlan): PlanView {
  const apt = plan.packages.filter((p) => (p.source ?? "apt") === "apt").map((p) => p.name);
  const toolPkgs = plan.tools.filter((t) => t.source === "apt").map((t) => t.package ?? t.id);
  const snaps = [
    ...plan.packages.filter((p) => p.source === "snap").map((p) => p.name),
    ...plan.tools.filter((t) => t.source === "snap").map((t) => t.package ?? t.id),
  ];
  return {
    packages: [...new Set([...apt, ...toolPkgs])].sort(),
    snaps: [...new Set(snaps)].sort(),
    units: Object.fromEntries(
      plan.units.map((u) => [u.unitName, { state: u.state, spec: u.spec }]),
    ),
    files: Object.fromEntries(plan.files.map((f) => [f.path, { spec: f.spec }])),
    ports: [...new Set(plan.ports.map((p) => `${p.protocol}/${p.port}`))].sort(),
    users: [
      ...new Set([
        ...plan.users.map((u) => u.name),
        ...(plan.fleet.services ?? []).map((s) => s.name),
      ]),
    ].sort(),
    ownPaths: [
      P.toolsRoot,
      `${P.bin}/archon`,
      `${P.bin}/stolos`,
      ...plan.tools.flatMap((t) => t.bins.map((b) => `${P.bin}/${b}`)),
      ...plan.files
        .map((f) => f.path)
        .filter((p) => p.startsWith("/usr/local/") || p.startsWith("/opt/")),
    ].sort(),
  };
}

/** Raw output of every source, read from the host (tests pass fixtures). */
export interface RawSources {
  /** When it was read (ISO). */
  at: string;
  /** `journalctl -o json SYSLOG_IDENTIFIER=sudo`. */
  sudoJournal: string;
  /** `/var/log/apt/history.log` (and its previous rotation). */
  aptHistory: string;
  /** `/var/log/dpkg.log` (and its previous rotation). */
  dpkgLog: string;
  /** etckeeper's log since birth (see {@link parseEtckeeperLog}). */
  etcLog: string;
  /** `git -C /etc status --porcelain`: changes not committed yet. */
  etcStatus: string;
  /** /etc paths no package owns, among the changed ones (`dpkg -S`). */
  etcUnowned: string[];
  /** `apt-mark showmanual`. */
  manual: string;
  /** `snap list`. */
  snapList: string;
  /** `snap changes`. */
  snapChanges: string;
  /** `systemctl list-unit-files --no-legend --plain`. */
  unitFiles: string;
  /** `ss -Hlntu`. */
  listening: string;
  /** `getent passwd`. */
  passwd: string;
  /** `podman ps -a --format {{.Names}}`. */
  containers: string;
  /** Files under /usr/local and /opt that no package owns (`dpkg -S` errors). */
  unowned: string[];
  /** `debsums -c`, or `dpkg --verify`. */
  modified: string;
  /** Files the plan writes whose content differs now. */
  managedFiles: string[];
  /** osquery's snapshot, when osquery answered. */
  osquery?: OsquerySnapshot;
  /** Collectors that failed, with why. */
  failed: Record<string, string>;
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Listening sockets (`ss -Hlntu`) as "tcp/443", without loopback and DHCP clients. */
export function parseListening(text: string): string[] {
  const out = new Set<string>();
  for (const l of lines(text)) {
    const f = l.split(/\s+/);
    const proto = f[0],
      addr = f[4] ?? "";
    const port = addr.slice(addr.lastIndexOf(":") + 1);
    const local = /^(127\.|\[::1\]|\[?::ffff:127\.)/.test(addr) || addr.includes("%lo:");
    const client = proto === "udp" && (port === "68" || port === "546");
    if (!local && !client && /^\d+$/.test(port)) out.add(`${proto}/${port}`);
  }
  return [...out].sort();
}

/** Accounts with a login (UID 1000 to 59999) from `getent passwd`. */
export function parseLoginUsers(text: string): string[] {
  return lines(text)
    .map((l) => l.split(":"))
    .filter((f) => Number(f[2]) >= 1000 && Number(f[2]) < 60000)
    .map((f) => f[0] ?? "")
    .sort();
}

/**
 * The host's state from its raw sources, against the plan and the birth
 * snapshot: /etc files a person changed since birth (a package's own unchanged
 * file is not drift; a modified one is), units, packages, ports, accounts.
 */
export function stateFrom(raw: RawSources, plan: PlanView): HostState {
  const commits = parseEtckeeperLog(raw.etcLog);
  const touched = new Map<string, EtcChange["change"]>();
  for (const c of [...commits].reverse()) {
    if (isUbuntuCommit(c)) continue;
    for (const f of c.files) {
      if (f.path.startsWith("/etc/.etckeeper") || f.path === "/etc/.gitignore") continue;
      touched.set(f.path, f.status === "A" ? "added" : f.status === "D" ? "deleted" : "edited");
    }
  }
  for (const l of raw.etcStatus.split("\n")) {
    const [, xy, name] = /^(..) (.+)$/.exec(l) ?? [];
    if (xy === undefined || name === undefined) continue;
    const path = `/etc/${name.trim()}`;
    touched.set(path, xy.includes("D") ? "deleted" : xy === "??" ? "added" : "edited");
  }
  const unowned = new Set(raw.etcUnowned);
  const modifiedConf = new Set(
    lines(raw.modified).flatMap((l) => {
      const [, flags, path] = /^(\S{9}) c (\/etc\/.+)$/.exec(l) ?? [];
      return flags?.[2] === "5" && path !== undefined ? [path] : [];
    }),
  );
  const etc: EtcChange[] = [];
  for (const [path, change] of [...touched].sort(([a], [b]) => a.localeCompare(b))) {
    if (change === "deleted" || unowned.has(path) || modifiedConf.has(path)) {
      etc.push({ path, change });
    }
  }
  const containerUnits = new Set(Object.keys(plan.units).map((u) => u.replace(/\.service$/, "")));
  return {
    at: raw.at,
    manualPackages: lines(raw.manual).sort(),
    snaps: lines(raw.snapList)
      .slice(1)
      .map((l) => l.split(/\s+/)[0] ?? "")
      .sort(),
    units: parseUnitFiles(raw.unitFiles),
    listening: parseListening(raw.listening),
    users: parseLoginUsers(raw.passwd),
    etc,
    managedFiles: [...raw.managedFiles].sort(),
    unowned: [...raw.unowned].sort(),
    containers: lines(raw.containers)
      .filter((c) => !containerUnits.has(c))
      .sort(),
    ...(Object.keys(raw.failed).length ? { failed: raw.failed } : {}),
  };
}

/** Every observation in the raw sources (osquery's against the previous snapshot). */
export async function observationsFrom(
  raw: RawSources,
  prevOsquery?: OsquerySnapshot,
): Promise<Observation[]> {
  const apt = await parseAptHistory(raw.aptHistory);
  return [
    ...(await sudoObservations(parseSudoJournal(raw.sudoJournal))),
    ...apt,
    ...(await parseDpkgLog(raw.dpkgLog, apt)),
    ...(await etckeeperObservations(parseEtckeeperLog(raw.etcLog))),
    ...(raw.osquery && prevOsquery ? await osqueryDiff(prevOsquery, raw.osquery) : []),
    ...(await parseSnapChanges(raw.snapChanges, raw.at)),
  ];
}

const out = async (argv: string[]) => (await run(argv)).stdout;

/** Paths under /usr/local and /opt (four levels, Archon's tools left out) that no package owns. */
async function unownedFiles(plan: PlanView): Promise<string[]> {
  const found = await run([
    "find",
    onHost("/usr/local"),
    onHost("/opt"),
    "-xdev",
    "-maxdepth",
    "4",
    "(",
    "-type",
    "f",
    "-o",
    "-type",
    "l",
    ")",
    "-not",
    "-path",
    `${P.toolsRoot}/*`,
  ]);
  const own = plan.ownPaths;
  const paths = lines(found.stdout)
    .filter((p) => !own.some((o) => p === o || p.startsWith(`${o}/`)))
    .slice(0, 500);
  const result: string[] = [];
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    result.push(...parseDpkgSearch((await run(["dpkg", "-S", ...chunk])).stderr));
  }
  // A link into Archon's tools is Archon's.
  const kept: string[] = [];
  for (const p of result) {
    const target = await fs.realPath(p).catch(() => p);
    if (!target.startsWith(`${P.toolsRoot}/`)) kept.push(p);
  }
  return kept;
}

/** Read every source from this host (root: journald, /etc's history, and root-only files). */
export async function readSources(
  plan: HostPlan,
  view: PlanView,
  birth: Birth,
  since: string,
): Promise<RawSources> {
  const failed: Record<string, string> = {};
  const at = new Date().toISOString();
  const guard = async <T>(name: string, f: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      failed[name] = (e as Error).message;
      return fallback;
    }
  };
  const sudoJournal = await guard(
    "sudo",
    () =>
      out([
        "journalctl",
        "-o",
        "json",
        "--no-pager",
        "SYSLOG_IDENTIFIER=sudo",
        `--since=@${Math.floor(Date.parse(since) / 1000)}`,
      ]),
    "",
  );
  const rotated = async (base: string) =>
    `${(await fs.readTextOr(`${base}.1`)) ?? ""}\n\n${(await fs.readTextOr(base)) ?? ""}`;
  const aptHistory = await guard("apt", () => rotated("/var/log/apt/history.log"), "");
  const dpkgLog = await guard("dpkg", () => rotated("/var/log/dpkg.log"), "");
  const etcGit = await fs.exists("/etc/.git");
  const etcLog = etcGit
    ? await guard(
        "etckeeper",
        () =>
          out([
            "git",
            "-C",
            "/etc",
            "log",
            "--no-renames",
            "--format=%x1e%H%x1f%an%x1f%aI%x1f%s",
            "--name-status",
            ...(birth.etcCommit ? [`${birth.etcCommit}..HEAD`] : []),
          ]),
        "",
      )
    : "";
  const etcStatus = etcGit
    ? await guard("etckeeper", () => out(["git", "-C", "/etc", "status", "--porcelain"]), "")
    : "";
  const candidates = [
    ...new Set([
      ...parseEtckeeperLog(etcLog)
        .filter((c) => !isUbuntuCommit(c))
        .flatMap((c) => c.files.map((f) => f.path)),
      ...lines(etcStatus).map((l) => `/etc/${l.slice(3).trim()}`),
    ]),
  ].slice(0, 500);
  const existing: string[] = [];
  for (const c of candidates) if (await fs.exists(c)) existing.push(c);
  const etcUnowned: string[] = [];
  for (let i = 0; i < existing.length; i += 100) {
    etcUnowned.push(
      ...parseDpkgSearch((await run(["dpkg", "-S", ...existing.slice(i, i + 100)])).stderr),
    );
  }
  let osquery: OsquerySnapshot | undefined;
  try {
    const { query } = await import("../state/query.ts");
    const { OSQUERY_SQL, osquerySnapshot } = await import("./parse.ts");
    osquery = osquerySnapshot(
      {
        packages: await query(OSQUERY_SQL.packages),
        users: await query(OSQUERY_SQL.users),
        sudoers: await query(OSQUERY_SQL.sudoers),
        ports: await query(OSQUERY_SQL.ports),
        modules: await query(OSQUERY_SQL.modules),
      },
      at,
    );
  } catch (e) {
    failed["osquery"] = (e as Error).message;
  }
  const managedFiles: string[] = [];
  for (const f of plan.files) {
    if (f.content === undefined || f.symlink) continue;
    const now = await fs.readTextOr(f.path).catch(() => undefined);
    if (now !== undefined && now !== f.content) managedFiles.push(f.path);
  }
  const debsums = (await run(["sh", "-c", "command -v debsums"])).ok;
  return {
    at,
    sudoJournal,
    aptHistory,
    dpkgLog,
    etcLog,
    etcStatus,
    etcUnowned,
    manual: await guard("packages", () => out(["apt-mark", "showmanual"]), ""),
    snapList: await guard("snap", () => out(["snap", "list"]), ""),
    snapChanges: await guard("snap", () => out(["snap", "changes"]), ""),
    unitFiles: await guard(
      "units",
      () => out(["systemctl", "list-unit-files", "--no-legend", "--plain", "--no-pager"]),
      "",
    ),
    listening: await guard("ports", () => out(["ss", "-Hlntu"]), ""),
    passwd: await guard("users", () => out(["getent", "passwd"]), ""),
    containers: await guard(
      "containers",
      async () =>
        (
          await run([
            "sh",
            "-c",
            "command -v podman >/dev/null && podman ps -a --format '{{.Names}}'",
          ])
        ).stdout,
      "",
    ),
    unowned: await guard("unowned", () => unownedFiles(view), []),
    modified: await guard(
      "modified",
      async () => (await run(debsums ? ["debsums", "-c"] : ["dpkg", "--verify"])).stdout,
      "",
    ),
    managedFiles,
    ...(osquery ? { osquery } : {}),
    failed,
  };
}

/**
 * The birth snapshot from this host now. At install it is what Ubuntu (and the
 * first apply) put there. Taken later (`late`), packages a person installed
 * with apt and units a person enabled under sudo, as the logs show, are left
 * out of it, so they still count as drift.
 */
export async function birthFrom(
  raw: Pick<RawSources, "at" | "manual" | "snapList" | "unitFiles" | "passwd" | "listening">,
  etcCommit: string,
  late?: Observation[],
): Promise<Birth> {
  const byPerson = new Set(
    (late ?? [])
      .filter((o) => o.who && (o.kind === "package" || o.kind === "snap"))
      .map((o) => o.name),
  );
  const units = Object.fromEntries(
    Object.entries(parseUnitFiles(raw.unitFiles)).map(([u, s]) => [u, s.state]),
  );
  if (late) {
    const { commandTargets } = await import("./parse.ts");
    for (const o of late.filter((x) => x.source === "sudo")) {
      for (const t of commandTargets(o.name)) if (t.kind === "unit") delete units[t.name];
    }
  }
  return {
    at: raw.at,
    ...(late ? { late: true } : {}),
    manualPackages: lines(raw.manual)
      .filter((p) => !byPerson.has(p))
      .sort(),
    snaps: lines(raw.snapList)
      .slice(1)
      .map((l) => l.split(/\s+/)[0] ?? "")
      .filter((s) => !byPerson.has(s))
      .sort(),
    units,
    users: parseLoginUsers(raw.passwd),
    listening: parseListening(raw.listening),
    etcCommit,
  };
}

/** /etc's first etckeeper commit, or "" without etckeeper. */
async function firstEtcCommit(): Promise<string> {
  if (!(await fs.exists("/etc/.git"))) return "";
  return lines(await out(["git", "-C", "/etc", "rev-list", "--max-parents=0", "HEAD"]))[0] ?? "";
}

/**
 * Take the birth snapshot at install (first boot), once: what Ubuntu put on
 * the host. Never replaced.
 */
export async function recordBirth(hostName: string, dir: string = P.state): Promise<Birth> {
  const have = await getRecord<Birth>(hostName, "birth", "birth", dir);
  if (have) return have.body;
  const at = new Date().toISOString();
  const birth = await birthFrom(
    {
      at,
      manual: await out(["apt-mark", "showmanual"]),
      snapList: await out(["snap", "list"]),
      unitFiles: await out([
        "systemctl",
        "list-unit-files",
        "--no-legend",
        "--plain",
        "--no-pager",
      ]),
      passwd: await out(["getent", "passwd"]),
      listening: await out(["ss", "-Hlntu"]),
    },
    await firstEtcCommit(),
  );
  await putRecord(hostName, "birth", "birth", birth, dir, at);
  return birth;
}

/** What one collection did. */
export interface Collected {
  /** Observations written (new or seen again). */
  observations: number;
  /** Security alerts seen for the first time. */
  newAlerts: Alert[];
  /** Collectors that failed, with why. */
  failed: Record<string, string>;
  /** The birth snapshot was taken late, now. */
  birthTakenLate: boolean;
}

/**
 * Store one collection: the observations, the state, the osquery snapshot,
 * and the alerts (new ones are returned, to be mailed). Pure storage over raw
 * sources, so tests run it on fixtures.
 */
export async function storeCollection(
  hostName: string,
  raw: RawSources,
  view: PlanView,
  dir: string = P.state,
): Promise<Omit<Collected, "birthTakenLate">> {
  const prev = (await getRecord<OsquerySnapshot>(hostName, "snapshot", "osquery", dir))?.body;
  const observations = await observationsFrom(raw, prev);
  await putRecords(
    hostName,
    "observation",
    observations.map((o) => ({ name: o.id, body: o, at: o.at })),
    dir,
  );
  await putRecord(hostName, "snapshot", "state", stateFrom(raw, view), dir, raw.at);
  if (raw.osquery) await putRecord(hostName, "snapshot", "osquery", raw.osquery, dir, raw.at);
  await putRecord(hostName, "snapshot", "cursor", { journal: raw.at }, dir, raw.at);
  const known = new Set((await listRecords<Alert>(hostName, "alert", dir)).map((r) => r.name));
  const alerts = parseModified(raw.modified, raw.at);
  const fresh = alerts.filter((a) => !known.has(a.path));
  await putRecords(
    hostName,
    "alert",
    fresh.map((a) => ({ name: a.path, body: a, at: a.at })),
    dir,
  );
  return { observations: observations.length, newAlerts: fresh, failed: raw.failed };
}

/**
 * Collect on this host (as root): read every source, store what it saw, take
 * the birth snapshot if it is missing (late, on a host installed before spec
 * 095), and mail a SECURITY ALERT for a newly modified package file.
 */
export async function collect(host: HostDef, dir: string = P.state): Promise<Collected> {
  const { planFor } = await import("../build.ts");
  const plan = await planFor(host);
  const view = planView(plan);
  let birthRec = (await getRecord<Birth>(host.name, "birth", "birth", dir))?.body;
  const cursor =
    (await getRecord<{ journal: string }>(host.name, "snapshot", "cursor", dir))?.body.journal ??
    new Date(Date.now() - 30 * 86_400_000).toISOString();
  let late = false;
  if (!birthRec) {
    // Read the logs first, so what a person did is not mistaken for Ubuntu's.
    const pre = await readSources(
      plan,
      view,
      {
        at: "",
        manualPackages: [],
        snaps: [],
        units: {},
        users: [],
        listening: [],
        etcCommit: await firstEtcCommit(),
      },
      new Date(Date.now() - 365 * 86_400_000).toISOString(),
    );
    const obs = await observationsFrom(pre);
    birthRec = await birthFrom(pre, await firstEtcCommit(), obs);
    await putRecord(host.name, "birth", "birth", birthRec, dir, pre.at);
    late = true;
  }
  const raw = await readSources(plan, view, birthRec, cursor);
  const r = await storeCollection(host.name, raw, view, dir);
  if (r.newAlerts.length) {
    const { notify } = await import("../notify/events.ts");
    await notify(
      {
        event: `✗ SECURITY ALERT: ${r.newAlerts.length} package file(s) modified`,
        level: "fail",
        what: `Files installed by a package no longer match it (never a proposal, spec 095):\n${r.newAlerts
          .map((a) => `- ${a.path}${a.package ? ` (${a.package})` : ""}: ${a.evidence}`)
          .join("\n")}`,
        todo: `Investigate now on ${host.name}: who had root (journalctl SYSLOG_IDENTIFIER=sudo), dpkg --verify, then reinstall the package from Ubuntu's archive (sudo apt install --reinstall <package>), or re-create the host.`,
        key: `alert:${r.newAlerts
          .map((a) => a.path)
          .sort()
          .join(",")}`,
      },
      host.name,
    ); // never throws
  }
  return { ...r, birthTakenLate: late };
}
