/**
 * The export delivery commands, on your PC (spec 092):
 *
 *   bun run stolos export list                    the jobs, how each delivers, and its last run
 *   bun run stolos export run <job>               make and deliver one job's documents now
 *   bun run stolos export schedule <job>          create this PC's own scheduled job for it
 *   bun run stolos export schedule <job> --remove remove it
 *   bun run stolos export credential <name>       store a separate send-only credential
 *
 * ## A send-only credential (least privilege)
 *
 * Stolos only ever submits mail (SMTP: EHLO, AUTH, MAIL, RCPT, DATA, over TLS
 * that it requires); it never opens a mailbox (no IMAP, no POP, no mail API).
 * Give it a credential that can do nothing more:
 *
 * - **The fleet's own (default):** the Cloudflare API token from `stolos boot
 *   mail-setup`, with the one permission "Email Sending: Edit" on the account
 *   (Cloudflare Email Service sends only; there is no mailbox to read). Limit
 *   it to the sending zone and, if you like, to this PC's address.
 * - **A tenant's own** (`email.credential` in the job): `stolos export
 *   credential <name>` stores it on this PC only (`mail-<name>.json` in the
 *   secrets folder, backed up by the vault). Use a submission-only account:
 *   another Cloudflare token as above, or a provider's SMTP account with
 *   reading (IMAP, POP, the mail API) turned off, ideally an app password
 *   limited to SMTP. `--user` gives its SMTP user name.
 *
 * ## Recipients' certificates
 *
 * Each recipient sends you their S/MIME certificate (public: X.509, RSA, PEM;
 * the `.cer` or `.pem` their mail program exports, never the `.p12` or
 * `.pfx` that holds the private key). Put it in the fleet repository, for
 * example `fleets/<id>/certs/auditor.pem`, and name it in the job. Each
 * recipient gets their own copy, encrypted to their certificate only; one
 * without a usable certificate (missing, expired, for another address)
 * gets nothing, and the run says why.
 *
 * @module
 */

import {
  array,
  boolean,
  type Decoder,
  jobs as kernelJobs,
  json,
  mapDecoder,
  object,
  string,
} from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, jobs, path, proc, stdio } from "@intellectual-frontiers/ifc-ts/runtime";
import { ui } from "../core/ui.ts";
import type { ExportJobDef, FleetDef } from "../model/types.ts";
import type { Credential } from "../notify/transport.ts";
import { deliveryPlan, type RunReport } from "./deliver.ts";
import { describeSchedule, exportJobSpec, findJob } from "./jobs.ts";

const print = (line: string): void => {
  stdio.stdout.writeSync(`${line}\n`);
};

async function fleetAndJob(
  id: string,
): Promise<{ fleet: FleetDef; job: ExportJobDef } | undefined> {
  const { loadFleet } = await import("../model/load.ts");
  const fleet = await loadFleet();
  const job = findJob(fleet, id);
  if (!job) {
    const ids = (fleet.estate?.exports ?? []).map((j) => j.id);
    ui.phase("Export").fail(
      `no export job named ${id}`,
      ids.length
        ? `one of: ${ids.join(", ")}`
        : "add one to estate.exports in fleets/<fleet>/fleet.ts",
    );
    return undefined;
  }
  return { fleet, job };
}

/** Read a send-only credential: the fleet's (no name) or a job's own, from this PC's secrets. */
export async function readCredential(name?: string): Promise<Credential | undefined> {
  const { readSecret, SECRETS } = await import("../core/secrets.ts");
  const text = await readSecret(name ? SECRETS.exportMail(name) : SECRETS.mail);
  const c = json(text ?? "", credentialDecoder);
  return c.kind === "ok" ? c.value : undefined;
}

const credentialDecoder: Decoder<Credential> = mapDecoder(
  object({ token: string }, { user: string, created: string }),
  (c): Credential => ({ ...c, created: c.created ?? "" }),
);

/** This PC's short name (the sender's subaddress). */
const pcName = (): string => (proc.hostname().split(".")[0] ?? "pc").toLowerCase();

/** `stolos export run <job>`: make and deliver the documents now; exit 1 on any problem. */
export async function exportRun(id: string): Promise<number> {
  const found = await fleetAndJob(id);
  if (!found) return 1;
  const { fleet, job } = found;
  const { P } = await import("../core/paths.ts");
  const { runJob } = await import("./deliver.ts");
  const { sendSmtp } = await import("../notify/transport.ts");
  const p = ui.phase(`Export ${job.id}`);
  const r: RunReport = await runJob(job, {
    fleet,
    fleetDir: P.fleetDir,
    stateDir: P.state,
    pc: pcName(),
    now: new Date(),
    fetch,
    smtp: sendSmtp,
    credential: readCredential,
  });
  for (const d of r.documents) p.ok(`${d.kind}: ${d.fileName} (${d.bytes} bytes)`);
  if (r.otlp?.ok) p.ok(`sent to the collector, ${r.otlp.endpoint}`);
  for (const f of r.files ?? []) p.ok(f);
  for (const e of r.email.filter((x) => x.ok)) {
    p.ok(`emailed to ${e.to}, encrypted to their certificate`);
  }
  for (const m of r.problems) p.warn(m);
  p.done(r.ok ? "delivered" : `${r.problems.length} problem(s)`);
  ui.next.push(`what happened: ${path.join(P.state, "exports", job.id, "last-run.json")}`);
  return r.ok ? 0 : 1;
}

/** `stolos export list`: each job, its kinds and tenants, how it delivers, its schedule, its last run. */
export async function exportList(): Promise<number> {
  const { loadFleet } = await import("../model/load.ts");
  const { P } = await import("../core/paths.ts");
  const fleet = await loadFleet();
  const p = ui.phase("Export jobs");
  const jobs = fleet.estate?.exports ?? [];
  for (const j of jobs) {
    const plan = deliveryPlan(fleet, j);
    const to = [
      plan.otlp ? `collector ${plan.otlp}` : "",
      plan.file ? "file" : "",
      plan.email ? `email to ${(j.email?.to ?? []).map((r) => r.address).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" + ");
    const last = await fs.readTextOr(path.join(P.state, "exports", j.id, "last-run.json"));
    const l = json(last ?? "", lastRunDecoder);
    const lastRun =
      l.kind === "ok"
        ? `last run ${l.value.at}: ${l.value.ok ? "ok" : l.value.problems.join("; ")}`
        : "never run here";
    p.ok(
      `${j.id}: ${j.kinds.join(", ")} for ${(j.tenants ?? ["every tenant"]).join(", ")}; ${to}; ${
        j.schedule ? describeSchedule(j) : "not scheduled"
      }; ${lastRun}`,
    );
  }
  p.done(
    jobs.length ? `${jobs.length} job(s)` : "none: add estate.exports to fleets/<fleet>/fleet.ts",
  );
  return 0;
}

const lastRunDecoder = object({ at: string, ok: boolean, problems: array(string) });

/**
 * `stolos export schedule <job> [--remove] [--dry-run]`: create (or remove)
 * this PC's own scheduled job (kernel `jobs.planJob`, runtime
 * `jobs.installJob` and `jobs.removeJob`). With --dry-run, print the files
 * and commands and change nothing.
 */
export async function exportSchedule(
  id: string,
  o: { remove?: boolean; dryRun?: boolean } = {},
): Promise<number> {
  const found = await fleetAndJob(id);
  if (!found) return 1;
  const { fleet, job } = found;
  const p = ui.phase(`Schedule ${job.id}`);
  const os = proc.build.os;
  if (os !== "linux" && os !== "darwin" && os !== "windows") {
    p.fail(`this OS (${os}) has no scheduler Stolos knows`, "Windows, macOS, or Linux");
    return 1;
  }
  if (!o.remove && !job.schedule) {
    p.fail(
      `${job.id} has no schedule`,
      'add schedule: { every: "daily", at: "06:10" } to the job in fleets/<fleet>/fleet.ts',
    );
    return 1;
  }
  const { P } = await import("../core/paths.ts");
  const spec = exportJobSpec(fleet.id, job, {
    command: proc.selfCommand(),
    workdir: P.repo,
    log: path.join(P.state, "exports", job.id, "scheduled.log"),
  });
  if (spec.kind === "err") {
    p.fail(kernelJobs.formatScheduleError(spec.error));
    return 1;
  }
  const uid = proc.uid();
  const plan = kernelJobs.planJob(spec.value, {
    os,
    home: proc.homeDir(),
    ...(uid === undefined ? {} : { uid }),
  });
  if (plan.kind === "err") {
    p.fail(kernelJobs.formatScheduleError(plan.error));
    return 1;
  }
  if (o.dryRun) {
    for (const f of o.remove ? [] : plan.value.files) print(`--- ${f.path}\n${f.content}`);
    for (const s of o.remove ? plan.value.remove : plan.value.install) {
      print(`$ ${s.argv.join(" ")}`);
    }
    if (o.remove) {
      for (const f of plan.value.files) print(`remove ${f.path}`);
    }
    p.done("dry run: nothing changed");
    return 0;
  }
  const r = o.remove ? await jobs.removeJob(spec.value) : await jobs.installJob(spec.value);
  if (r.kind === "err") {
    p.fail(jobs.formatJobError(r.error));
    return 1;
  }
  if (o.remove) {
    p.done(`removed ${plan.value.label}`);
    return 0;
  }
  for (const f of plan.value.files) p.ok(f.path);
  p.done(`${plan.value.label}: ${plan.value.description}, runs ${spec.value.argv.join(" ")}`);
  if (os === "linux") {
    ui.next.push("to run while you are logged out too: loginctl enable-linger");
  }
  ui.next.push(`try it now: bun run stolos export run ${job.id}`);
  return 0;
}

/**
 * `stolos export credential <name> [--user <smtp user>]`: read a send-only
 * credential (hidden, or one line on stdin), check it logs in to the relay
 * of a job that names it (nothing is sent), and store it in this PC's
 * secrets folder. Never printed, never logged.
 */
export async function exportCredential(name: string, user?: string): Promise<number> {
  const p = ui.phase("Credential");
  if (!/^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/.test(name)) {
    p.fail(`'${name}' is not a name`, "lowercase letters, digits, and -");
    return 1;
  }
  const { loadFleet } = await import("../model/load.ts");
  const { readHidden } = await import("../identity/fleet-init.ts");
  const { SECRETS, writeSecret } = await import("../core/secrets.ts");
  const { DEFAULT_RELAY, probeSmtp } = await import("../notify/transport.ts");
  const fleet = await loadFleet();
  const job = (fleet.estate?.exports ?? []).find((j) => j.email?.credential === name);
  const relay = job?.email?.relay ?? fleet.mail?.relay ?? DEFAULT_RELAY;
  const token = (
    await readHidden(`Send-only credential (password or API token) for ${relay}: `)
  ).trim();
  if (!token) {
    p.fail("nothing entered");
    return 1;
  }
  const c: Credential = {
    token,
    created: new Date().toISOString(),
    ...(user ? { user } : {}),
  };
  try {
    await probeSmtp(c, { relay, ipv4: fleet.network?.ipv6 === false });
    p.ok(`logged in to ${relay} over TLS (nothing sent)`);
  } catch (e) {
    const { redact } = await import("../notify/redact.ts");
    p.fail(
      redact(e instanceof Error ? e.message : String(e), [token]),
      "check the credential, then again",
    );
    return 1;
  }
  await writeSecret(SECRETS.exportMail(name), JSON.stringify(c) + "\n");
  p.done(`stored as ${SECRETS.exportMail(name)} (this user only)`);
  if (!job) ui.next.push(`name it in a job: email: { credential: "${name}", ... }`);
  return 0;
}
