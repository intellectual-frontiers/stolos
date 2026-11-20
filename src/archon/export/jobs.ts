/**
 * Spec 092's export jobs as the fleet declares them (`estate.exports` in
 * `fleets/<id>/fleet.ts`, see ExportJobDef): checking them, matching their
 * tenants, and reading what each needs at run time (the recipients'
 * certificates, the sender, the credential's name), and the operating
 * system's job for each (kernel `jobs`). Pure, apart from reading a
 * certificate file.
 *
 * Each job is one tenant's (or a few tenants') arrangement: its own kinds,
 * its own recipients and sender, its own schedule. Nothing secret is in a
 * job; the credential is named, and lives in this PC's secrets folder.
 *
 * @module
 */
// Spec: 092-exporters

import type { ExportJobDef, ExportKind, ExportScheduleDef, FleetDef } from "../model/types.ts";
import { EMAIL } from "../notify/transport.ts";
import { absurd, ok, type Result } from "@intellectual-frontiers/core";
import { cms, jobs } from "@intellectual-frontiers/commons/ts/kernel";
import { fs } from "@intellectual-frontiers/commons/ts/runtime";
import { describeCertificateProblem, parseCertificate } from "./smime.ts";

/** Every kind of export document, in the order a job lists them. */
export const EXPORT_KINDS: readonly ExportKind[] = [
  "oscal",
  "ocsf",
  "otlp",
  "cyclonedx",
  "in-toto",
];

/** A problem with a job, in the validator's shape (model/validate.ts). */
export interface JobProblem {
  /** Where: `fleet.estate.exports[<id>]...`. */
  where: string;
  /** What is wrong. */
  message: string;
  /** How to fix it. */
  fix: string;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/;
const TENANT = /^[a-z0-9_-]+:([^\s*]*\*?)$|^\*$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Check every export job: ids, kinds, tenants, recipients, sender, schedule. Empty when valid. */
export function validateExportJobs(fleet: FleetDef): JobProblem[] {
  const out: JobProblem[] = [];
  const seen = new Set<string>();
  for (const [i, j] of (fleet.estate?.exports ?? []).entries()) {
    const w = `fleet.estate.exports[${j.id || i}]`;
    const add = (where: string, message: string, fix: string) =>
      out.push({ where: `${w}${where}`, message, fix });
    if (!LABEL.test(j.id ?? "")) {
      add(".id", `'${j.id}' is not a job id`, "lowercase letters, digits and -, up to 42");
    }
    if (seen.has(j.id)) add(".id", `two jobs are named ${j.id}`, "give each job its own id");
    seen.add(j.id);
    if (!j.kinds?.length) add(".kinds", "no kinds", `one or more of ${EXPORT_KINDS.join(", ")}`);
    for (const k of j.kinds ?? []) {
      if (!EXPORT_KINDS.includes(k)) {
        add(".kinds", `unknown kind ${k}`, `one of ${EXPORT_KINDS.join(", ")}`);
      }
    }
    for (const t of j.tenants ?? []) {
      if (!TENANT.test(t)) {
        add(".tenants", `'${t}' is not a tenant uid`, "<connector>:<account>, or aws:* for all");
      }
    }
    if (j.email) {
      if (!j.email.to?.length) add(".email.to", "no recipients", "list at least one recipient");
      for (const r of j.email.to ?? []) {
        if (!EMAIL.test(r.address)) {
          add(".email.to", `'${r.address}' is not an email address`, "for example a@example.com");
        }
        if (!r.certificate?.trim()) {
          add(
            ".email.to",
            `${r.address} has no certificate: exports are only emailed encrypted`,
            "ask the recipient for their S/MIME certificate (public, PEM) and name it here",
          );
        }
        if (/PRIVATE KEY/.test(r.certificate ?? "")) {
          add(
            ".email.to",
            `${r.address}'s certificate holds a private key`,
            "use the certificate only; the private key stays with the recipient",
          );
        }
      }
      const f = j.email.from;
      if (f && !EMAIL.test(f) && !/^[a-z0-9._+-]+$/i.test(f)) {
        add(".email.from", `'${f}' is not an address or a local part`, "for example exports");
      }
      if (f && !EMAIL.test(f) && !fleet.mail) {
        add(".email.from", "a local part needs fleet.mail.domain", "give a whole address");
      }
      if (!fleet.mail && !(f && EMAIL.test(f))) {
        add(
          ".email",
          "the fleet has no mail settings, so there is no sender",
          "set fleet.mail, or email.from (a whole address) with its own credential",
        );
      }
      if (j.email.relay && !/^[a-z0-9.-]+:\d{1,5}$/i.test(j.email.relay)) {
        add(
          ".email.relay",
          `'${j.email.relay}' is not host:port`,
          "for example smtp.example.net:465",
        );
      }
      if (j.email.credential && !LABEL.test(j.email.credential)) {
        add(".email.credential", `'${j.email.credential}' is not a name`, "for example acme");
      }
      if (j.email.subject && /[\r\n]/.test(j.email.subject)) {
        add(".email.subject", "the subject has a line break", "one line");
      }
    }
    const s = j.schedule;
    if (s) {
      if (!["hourly", "daily", "weekly", "monthly"].includes(s.every)) {
        add(".schedule.every", `'${s.every}' is not a period`, "hourly, daily, weekly, or monthly");
      }
      if (s.at !== undefined && !HHMM.test(s.at)) {
        add(".schedule.at", `'${s.at}' is not HH:MM`, "for example 06:10");
      }
      if (s.weekday !== undefined && !WEEKDAYS.includes(s.weekday)) {
        add(".schedule.weekday", `'${s.weekday}' is not a weekday`, WEEKDAYS.join(", "));
      }
      if (
        s.dayOfMonth !== undefined &&
        !(Number.isInteger(s.dayOfMonth) && s.dayOfMonth >= 1 && s.dayOfMonth <= 28)
      ) {
        add(".schedule.dayOfMonth", `${s.dayOfMonth} is not 1 to 28`, "every month has it");
      }
    }
  }
  return out;
}

/** Whether a tenant uid matches one pattern (exact, `aws:*` as a prefix, or `*`). */
export function tenantMatches(pattern: string, uid: string): boolean {
  if (pattern === "*") return true;
  return pattern.endsWith("*") ? uid.startsWith(pattern.slice(0, -1)) : uid === pattern;
}

/** A job's tenant filter: true for every tenant when it lists none. */
export function tenantFilter(job: Pick<ExportJobDef, "tenants">): (uid: string) => boolean {
  const ps = job.tenants ?? [];
  return (uid) => !ps.length || ps.some((p) => tenantMatches(p, uid));
}

/** The job with this id, or undefined. */
export function findJob(fleet: FleetDef, id: string): ExportJobDef | undefined {
  return fleet.estate?.exports?.find((j) => j.id === id);
}

/**
 * The sender of a job's mail: its whole address; a local part on the
 * fleet's domain; else `exports+<pc>[.<tag>]@<domain>` (spec 027's form).
 */
export function jobSender(fleet: FleetDef, job: ExportJobDef, pc: string): string {
  const f = job.email?.from;
  if (f && EMAIL.test(f)) return f;
  if (!fleet.mail) throw new Error("the fleet has no mail settings (fleet.mail), so no sender");
  const detail = fleet.mail.tag ? `${pc}.${fleet.mail.tag}` : pc;
  return f ? `${f}@${fleet.mail.domain}` : `exports+${detail}@${fleet.mail.domain}`;
}

/** A recipient ready to encrypt to: their address and their parsed certificate. */
export interface ReadyRecipient {
  /** Their address. */
  address: string;
  /** Their certificate, parsed. */
  cert: cms.Certificate;
}

/**
 * Read and check each recipient's certificate (`certificate` is PEM text, or a
 * path relative to `fleetDir`). Returns those ready, and a problem for each
 * that is not (missing, not RSA, expired, for another address).
 */
export async function readRecipients(
  job: ExportJobDef,
  fleetDir: string,
  now: Date = new Date(),
  read: (path: string) => Promise<string> = (p) => fs.readTextFile(p),
): Promise<{ ready: ReadyRecipient[]; problems: Array<{ address: string; error: string }> }> {
  const ready: ReadyRecipient[] = [];
  const problems: Array<{ address: string; error: string }> = [];
  for (const r of job.email?.to ?? []) {
    try {
      const pem = r.certificate.includes("-----BEGIN")
        ? r.certificate
        : await read(
            /^([a-z]:)?[\\/]/i.test(r.certificate) ? r.certificate : `${fleetDir}/${r.certificate}`,
          );
      const cert = parseCertificate(pem);
      const why = cms.certificateProblem(cert, r.address, now);
      if (why) {
        problems.push({
          address: r.address,
          error: `${r.address}: the certificate cannot be used: ${describeCertificateProblem(why)}`,
        });
      } else ready.push({ address: r.address, cert });
    } catch (e) {
      problems.push({
        address: r.address,
        error: `${r.address}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return { ready, problems };
}

/** A job's schedule with its defaults filled in (every day at 02:17, Mondays, the 1st). */
export function scheduleOf(job: Pick<ExportJobDef, "schedule">): Required<ExportScheduleDef> {
  const s = job.schedule ?? { every: "daily" };
  return {
    every: s.every,
    at: s.at ?? "02:17",
    weekday: s.weekday ?? "mon",
    dayOfMonth: s.dayOfMonth ?? 1,
  };
}

/** A job's schedule as IFC TypeScript's (kernel `jobs.schedule`), or why it is not one. */
export function jobWhen(
  job: Pick<ExportJobDef, "schedule">,
): Result<jobs.Schedule, jobs.ScheduleError> {
  const s = scheduleOf(job);
  const [hh = "", mm = ""] = s.at.split(":");
  const hour = Number(hh);
  const minute = Number(mm);
  switch (s.every) {
    case "hourly":
      return jobs.schedule({ kind: "hourly", minute });
    case "daily":
      return jobs.schedule({ kind: "daily", hour, minute });
    case "weekly":
      return jobs.schedule({ kind: "weekly", day: s.weekday, hour, minute });
    case "monthly":
      return jobs.schedule({ kind: "monthly", day: s.dayOfMonth, hour, minute });
    default:
      return absurd(s.every);
  }
}

/** When a job runs, in plain words (`every day at 02:17`). */
export function describeSchedule(job: Pick<ExportJobDef, "schedule">): string {
  const w = jobWhen(job);
  return w.kind === "ok" ? jobs.describeSchedule(w.value) : jobs.formatScheduleError(w.error);
}

/** Who Stolos's scheduled jobs belong to: their launchd and systemd domain, their Task Scheduler folder. */
export const JOB_OWNER: jobs.JobOwner = {
  domain: "io.github.intellectual-frontiers.stolos",
  folder: "Stolos",
};

/**
 * The operating system's job for an export job (kernel `jobs.JobSpec`): it runs `command` (this
 * program, `--fleet <fleet> export run <job>`; no secret, ever) in the repository, on the job's
 * schedule, its output appended to `log`.
 */
export function exportJobSpec(
  fleet: string,
  job: ExportJobDef,
  o: { command: readonly string[]; workdir: string; log?: string },
): Result<jobs.JobSpec, jobs.ScheduleError> {
  const name = jobs.jobName(`export-${fleet}-${job.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
  if (name.kind === "err") return name;
  const when = jobWhen(job);
  if (when.kind === "err") return when;
  return ok({
    name: name.value,
    owner: JOB_OWNER,
    argv: [...o.command, "--fleet", fleet, "export", "run", job.id],
    workdir: o.workdir,
    when: when.value,
    ...(o.log === undefined ? {} : { log: o.log }),
  });
}
