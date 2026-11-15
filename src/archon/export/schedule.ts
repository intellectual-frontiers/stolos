/**
 * Export jobs on a schedule, without Stolos open (spec 092): `stolos export
 * schedule <job>` creates the operating system's own scheduled job on this
 * PC, which runs `deno task stolos --fleet <fleet> export run <job>` in the
 * fleet checkout.
 *
 * | OS      | what is created                                                                 | how it is loaded                                  |
 * | ------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
 * | Windows | a Task Scheduler task `Stolos\export-<fleet>-<job>` running a small `.cmd` file | `schtasks /Create /F ...` (as you, no password)   |
 * | macOS   | a LaunchAgent, `~/Library/LaunchAgents/net.stolos.export.<fleet>.<job>.plist`   | `launchctl bootstrap gui/<uid> <plist>`           |
 * | Linux   | a systemd user service and timer in `~/.config/systemd/user/`                   | `systemctl --user enable --now <unit>.timer`      |
 *
 * Every definition is built by a pure function here (tested for each OS on
 * any OS); only the command runs schtasks, launchctl, or systemctl. A job
 * definition never holds a secret: it names the job, and `export run` reads
 * the send-only credential from this PC's secrets folder when it runs. On
 * Windows the task is created for the signed-in user without a stored
 * password (it runs while you are signed in); on Linux a user timer runs
 * while you are logged in, unless `loginctl enable-linger` keeps your user
 * manager running.
 *
 * ```mermaid
 * flowchart LR
 *   sched["stolos export schedule job"] --> def["the OS's job definition<br/>(pure: scheduledJob)"]
 *   def --> os{"this OS"}
 *   os -->|Windows| st["schtasks /Create"]
 *   os -->|macOS| ld["launchctl bootstrap"]
 *   os -->|Linux| sd["systemctl --user enable --now"]
 *   st & ld & sd -->|"at the time"| run["deno task stolos export run job"]
 * ```
 *
 * @module
 */

import type { ExportJobDef, ExportScheduleDef } from "../model/types.ts";

/** The operating systems a job can be scheduled on. */
export type SchedulerOs = "windows" | "darwin" | "linux";

/** What a definition is built from. */
export interface ScheduleInput {
  /** The OS to build for. */
  os: SchedulerOs;
  /** The fleet's id (`--fleet`). */
  fleet: string;
  /** The job (its `schedule` is used; daily at 02:17 when it has none). */
  job: ExportJobDef;
  /** The absolute path of the deno executable. */
  deno: string;
  /** The fleet checkout (its deno.json has the `stolos` task). */
  repo: string;
  /** The user's home directory. */
  home: string;
  /** A folder for the job's output log and helper files (in this PC's state directory). */
  stateDir: string;
  /** The user's numeric id (macOS launchctl's gui/<uid> domain). */
  uid?: number;
}

/** One OS command to run; `mayFail` for a step whose failure is expected (nothing to unload). */
export interface Step {
  /** The program and its arguments (never through a shell). */
  argv: string[];
  /** Its failure does not stop the rest. */
  mayFail?: boolean;
}

/** The OS's job for one export job: files to write, commands to load or unload it. */
export interface ScheduledJob {
  /** The task, label, or unit name. */
  name: string;
  /** What runs: deno and its arguments. */
  command: string[];
  /** Files to write (absolute paths) before `create`. */
  files: Array<{ path: string; content: string }>;
  /** Load and enable it. */
  create: Step[];
  /** Disable and unload it (then `files` are removed). */
  remove: Step[];
  /** After the files are removed (systemd forgets the units). */
  afterRemove?: Step[];
  /** When it runs, in words. */
  when: string;
}

/** A path on the target OS (backslashes on Windows). */
function pathJoin(os: SchedulerOs, ...parts: string[]): string {
  const sep = os === "windows" ? "\\" : "/";
  return parts.map((p, i) => (i ? p.replace(/^[\\/]+/, "") : p).replace(/[\\/]+$/, ""))
    .join(sep);
}

/** The schedule with its defaults filled in. */
export function scheduleOf(job: ExportJobDef): Required<ExportScheduleDef> {
  const s = job.schedule ?? { every: "daily" };
  return {
    every: s.every,
    at: s.at ?? "02:17",
    weekday: s.weekday ?? "mon",
    dayOfMonth: s.dayOfMonth ?? 1,
  };
}

/** When a schedule runs, in plain words. */
export function describeSchedule(job: ExportJobDef): string {
  const s = scheduleOf(job);
  const [, mm] = s.at.split(":");
  switch (s.every) {
    case "hourly":
      return `every hour at minute ${mm}`;
    case "daily":
      return `every day at ${s.at}`;
    case "weekly":
      return `every ${s.weekday} at ${s.at}`;
    default:
      return `on day ${s.dayOfMonth} of every month at ${s.at}`;
  }
}

/** A safe name part: lowercase letters, digits, and dashes. */
const part = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-");

/** The command a scheduled job runs: deno, its task, and the job (no secret, ever). */
export function jobCommand(i: ScheduleInput): string[] {
  return [i.deno, "task", "stolos", "--fleet", i.fleet, "export", "run", i.job.id];
}

/** XML text, escaped. */
const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One argument for a Windows command line, quoted when it needs it. */
const winArg = (s: string) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** One argument for systemd's ExecStart, quoted when it needs it (systemd.syntax). */
const unitArg = (s: string) =>
  /[\s"'\\;$%]/.test(s)
    ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`
    : s;

const DAYS = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 } as const;

/** Windows: a .cmd file (working directory, log) and a Task Scheduler task that runs it. */
export function windowsJob(i: ScheduleInput): ScheduledJob {
  const s = scheduleOf(i.job);
  const name = `Stolos\\export-${part(i.fleet)}-${part(i.job.id)}`;
  const dir = pathJoin("windows", i.stateDir, "exports", i.job.id);
  const cmdFile = pathJoin("windows", dir, "run.cmd");
  const log = pathJoin("windows", dir, "run.log");
  const command = jobCommand(i);
  const content = [
    "@echo off",
    `rem Written by stolos export schedule ${i.job.id} (spec 092). No secrets: the credential stays in the secrets folder.`,
    `cd /d ${winArg(i.repo)}`,
    `${command.map(winArg).join(" ")} >> ${winArg(log)} 2>&1`,
    "",
  ].join("\r\n");
  const [hh, mm] = s.at.split(":");
  const sc = { hourly: "HOURLY", daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY" }[s.every];
  const create = [
    "schtasks",
    "/Create",
    "/F",
    "/TN",
    name,
    "/TR",
    `"${cmdFile}"`,
    "/SC",
    sc,
    "/ST",
    s.every === "hourly" ? `00:${mm}` : `${hh}:${mm}`,
    ...(s.every === "weekly" ? ["/D", s.weekday.toUpperCase()] : []),
    ...(s.every === "monthly" ? ["/D", String(s.dayOfMonth)] : []),
  ];
  return {
    name,
    command,
    files: [{ path: cmdFile, content }],
    create: [{ argv: create }],
    remove: [{ argv: ["schtasks", "/Delete", "/F", "/TN", name], mayFail: true }],
    when: describeSchedule(i.job),
  };
}

/** macOS: a LaunchAgent property list, loaded into the user's GUI domain. */
export function macJob(i: ScheduleInput): ScheduledJob {
  const s = scheduleOf(i.job);
  const label = `net.stolos.export.${part(i.fleet)}.${part(i.job.id)}`;
  const plist = pathJoin("darwin", i.home, "Library", "LaunchAgents", `${label}.plist`);
  const log = pathJoin("darwin", i.stateDir, "exports", i.job.id, "run.log");
  const command = jobCommand(i);
  const [hh, mm] = s.at.split(":").map(Number);
  const cal: Array<[string, number]> = [["Minute", mm]];
  if (s.every !== "hourly") cal.push(["Hour", hh]);
  if (s.every === "weekly") cal.push(["Weekday", DAYS[s.weekday]]);
  if (s.every === "monthly") cal.push(["Day", s.dayOfMonth]);
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <!-- Written by stolos export schedule ${xml(i.job.id)} (spec 092). No secrets. -->`,
    "  <key>Label</key>",
    `  <string>${xml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...command.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(i.repo)}</string>`,
    "  <key>StartCalendarInterval</key>",
    "  <dict>",
    ...cal.flatMap(([k, v]) => [`    <key>${k}</key>`, `    <integer>${v}</integer>`]),
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(log)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(log)}</string>`,
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  const domain = `gui/${i.uid ?? 501}`;
  return {
    name: label,
    command,
    files: [{ path: plist, content }],
    create: [
      { argv: ["launchctl", "bootout", `${domain}/${label}`], mayFail: true },
      { argv: ["launchctl", "bootstrap", domain, plist] },
    ],
    remove: [{ argv: ["launchctl", "bootout", `${domain}/${label}`], mayFail: true }],
    when: describeSchedule(i.job),
  };
}

/** systemd's OnCalendar= for a schedule. */
export function onCalendar(job: ExportJobDef): string {
  const s = scheduleOf(job);
  const [hh, mm] = s.at.split(":");
  const wd = s.weekday[0].toUpperCase() + s.weekday.slice(1);
  switch (s.every) {
    case "hourly":
      return `*-*-* *:${mm}:00`;
    case "daily":
      return `*-*-* ${hh}:${mm}:00`;
    case "weekly":
      return `${wd} *-*-* ${hh}:${mm}:00`;
    default:
      return `*-*-${String(s.dayOfMonth).padStart(2, "0")} ${hh}:${mm}:00`;
  }
}

/** Linux: a systemd user service (one shot) and its timer. */
export function linuxJob(i: ScheduleInput): ScheduledJob {
  const unit = `stolos-export-${part(i.fleet)}-${part(i.job.id)}`;
  const dir = pathJoin("linux", i.home, ".config", "systemd", "user");
  const command = jobCommand(i);
  const service = [
    `# Written by stolos export schedule ${i.job.id} (spec 092). No secrets: the credential`,
    "# stays in this PC's secrets folder and is read when the job runs.",
    "[Unit]",
    `Description=Stolos export ${i.job.id} (fleet ${i.fleet})`,
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${i.repo}`,
    `ExecStart=${command.map(unitArg).join(" ")}`,
    "",
  ].join("\n");
  const timer = [
    `# Written by stolos export schedule ${i.job.id} (spec 092).`,
    "[Unit]",
    `Description=Stolos export ${i.job.id} (fleet ${i.fleet}), ${describeSchedule(i.job)}`,
    "",
    "[Timer]",
    `OnCalendar=${onCalendar(i.job)}`,
    "Persistent=true",
    "RandomizedDelaySec=60",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return {
    name: `${unit}.timer`,
    command,
    files: [
      { path: pathJoin("linux", dir, `${unit}.service`), content: service },
      { path: pathJoin("linux", dir, `${unit}.timer`), content: timer },
    ],
    create: [
      { argv: ["systemctl", "--user", "daemon-reload"] },
      { argv: ["systemctl", "--user", "enable", "--now", `${unit}.timer`] },
    ],
    remove: [
      { argv: ["systemctl", "--user", "disable", "--now", `${unit}.timer`], mayFail: true },
    ],
    afterRemove: [{ argv: ["systemctl", "--user", "daemon-reload"], mayFail: true }],
    when: describeSchedule(i.job),
  };
}

/** The OS's job for an export job, on the given OS. */
export function scheduledJob(i: ScheduleInput): ScheduledJob {
  return i.os === "windows" ? windowsJob(i) : i.os === "darwin" ? macJob(i) : linuxJob(i);
}

/** What `install` and `uninstall` need from outside (tests record instead of running). */
export interface SchedulerDeps {
  /** Write a file (folders made as needed). */
  write: (path: string, content: string) => Promise<void>;
  /** Remove a file (absent is fine). */
  remove: (path: string) => Promise<void>;
  /** Run one command; returns whether it succeeded and what it said. */
  exec: (argv: string[]) => Promise<{ ok: boolean; output: string }>;
}

/** Write the files and load the job; throws with the OS's message when a required step fails. */
export async function installJob(j: ScheduledJob, d: SchedulerDeps): Promise<void> {
  for (const f of j.files) await d.write(f.path, f.content);
  for (const s of j.create) {
    const r = await d.exec(s.argv);
    if (!r.ok && !s.mayFail) throw new Error(`${s.argv.join(" ")} failed: ${r.output.trim()}`);
  }
}

/** Unload the job and remove its files. */
export async function uninstallJob(j: ScheduledJob, d: SchedulerDeps): Promise<void> {
  for (const s of j.remove) {
    const r = await d.exec(s.argv);
    if (!r.ok && !s.mayFail) throw new Error(`${s.argv.join(" ")} failed: ${r.output.trim()}`);
  }
  for (const f of j.files) await d.remove(f.path);
  for (const s of j.afterRemove ?? []) await d.exec(s.argv);
}
