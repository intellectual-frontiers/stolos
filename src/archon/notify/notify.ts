/**
 * archon notify (spec 025): major events, by email, to the fleet's shared
 * mailbox. Reporting never fails or slows the action it reports: a message is
 * queued on disk and sent by `archon notify flush` (a service started at once
 * and a timer every 5 minutes) through Cloudflare's SMTP relay (spec 027),
 * with backoff when it cannot be reached,
 * duplicates dropped by key within an hour, and one summary after a long
 * outage. Nothing secret is ever sent (redact.ts).
 *
 * @module
 */

import { join } from "../core/path.ts";
import { ensureDir, exists, readTextOr } from "../core/fsx.ts";
import { isRoot, run } from "../core/exec.ts";
import { P } from "../core/paths.ts";
import { SECRETS } from "../core/secrets.ts";
import type { FleetDef } from "../model/types.ts";
import { buildMime, escapeHtml } from "./mime.ts";
import { redact } from "./redact.ts";
import {
  type Credential,
  DEFAULT_RELAY,
  parseSaslPasswd,
  SASL_PASSWD,
  secretsOf,
  senderAddress,
  sendSmtp,
} from "./transport.ts";

export type Level = "info" | "warn" | "fail";

/** Where this machine keeps its credential, queue, and status. */
export interface Site {
  role: "server" | "workstation" | "boot";
  name: string;
  credential: string;
  spool: string;
  status: string;
  to?: string;
  from?: string;
  /** host:port of the SMTP relay (Cloudflare Email Service). */
  relay: string;
  ipv4: boolean;
  timezone: string;
}

export const HOST_NOTIFY = {
  /** Postfix's credential file; archon's own sends use the same token. */
  credential: SASL_PASSWD,
  spool: "/var/spool/archon/notify",
  status: "/var/lib/archon/status/notify.json",
  flushUnit: "archon-notify-flush.service",
};

export function hostSite(
  fleet: FleetDef,
  name: string,
  kind: "server" | "workstation",
  ipv6: boolean,
): Site {
  return {
    role: kind,
    name,
    credential: HOST_NOTIFY.credential,
    spool: HOST_NOTIFY.spool,
    status: HOST_NOTIFY.status,
    to: fleet.mail?.to,
    // archon's own messages come from root+<host>.<tag>@<domain> (spec 027).
    from: fleet.mail ? senderAddress(fleet.mail, name, "root") : undefined,
    relay: fleet.mail?.relay ?? DEFAULT_RELAY,
    ipv4: !ipv6,
    timezone: fleet.timezone,
  };
}

/** The boot machine's user, as a mail local part (Windows USERNAME, else USER). */
export function bootUser(): string {
  const u = (Deno.env.get("USERNAME") ?? Deno.env.get("USER") ?? "archon").toLowerCase();
  return u.replace(/[^a-z0-9._-]/g, "") || "archon";
}

export function bootSite(fleet: FleetDef): Site {
  const name = Deno.hostname().split(".")[0].toLowerCase();
  const dir = join(P.bootCache, "..", "notify");
  return {
    role: "boot",
    name,
    credential: SECRETS.mail,
    spool: dir,
    status: join(dir, "status.json"),
    to: fleet.mail?.to,
    // The boot machine: <the person running it>+<pc>.<tag>@<domain> (alice+bootpc.lab@...).
    from: fleet.mail ? senderAddress(fleet.mail, name, bootUser()) : undefined,
    relay: fleet.mail?.relay ?? DEFAULT_RELAY,
    ipv4: fleet.network?.ipv6 === false,
    timezone: fleet.timezone,
  };
}

export async function loadCredential(site: Site): Promise<Credential | undefined> {
  const text = (await readTextOr(site.credential)) ?? "";
  // Hosts: Postfix's sasl_passwd line; the boot machine: JSON in its secrets folder.
  if (site.role !== "boot") return parseSaslPasswd(text);
  try {
    const c = JSON.parse(text);
    return typeof c?.token === "string" ? c as Credential : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- compose

export interface Event {
  /** What happened, short: "✗ apply failing since 14:04". */
  event: string;
  level?: Level;
  /** The details: a few lines. */
  what: string;
  /** What a person or assistant should do, if anything. */
  todo?: string;
  log?: string;
  attach?: string[];
  /** Messages with the same key within an hour are sent once. */
  key?: string;
  /**
   * archon notify send: this exact subject (for example "Lab Network Runbook
   * Change Log ..."), and `what` as the whole body.
   */
  subject?: string;
}

export interface Queued {
  id: string;
  created: string;
  subject: string;
  text: string;
  html: string;
  level: Level;
  key?: string;
  attachments: Array<{ name: string; type: string; b64: string }>;
  attempts: number;
  nextAt: string;
  lastError?: string;
}

const MAX_ATTACH = 1_000_000;

async function commit(): Promise<string> {
  return (await run(["git", "-C", P.repo, "rev-parse", "--short", "HEAD"])).stdout.trim() ||
    "unknown";
}

/** Files to attach: text redacted and trimmed to its end, gzipped when large; about 1 MB in all. */
export async function attachments(
  paths: string[],
  exact: string[],
): Promise<Queued["attachments"]> {
  const out: Queued["attachments"] = [];
  let total = 0;
  for (const p of paths) {
    const raw = await Deno.readFile(p).catch(() => undefined);
    if (!raw) continue;
    const name = p.split(/[\\/]/).pop()!;
    let text = redact(new TextDecoder().decode(raw), exact);
    if (text.length > 256_000) text = "[trimmed to the last 256 KB]\n" + text.slice(-256_000);
    let data = new TextEncoder().encode(text);
    let file = name;
    let type = /\.html?$/.test(name)
      ? "text/html"
      : /\.json$/.test(name)
      ? "application/json"
      : "text/plain";
    if (data.length > 64_000) {
      data = new Uint8Array(
        await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("gzip")))
          .arrayBuffer(),
      );
      file = `${name}.gz`;
      type = "application/gzip";
    }
    if (total + data.length > MAX_ATTACH) continue;
    total += data.length;
    const { base64 } = await import("./mime.ts");
    out.push({ name: file, type, b64: base64(data) });
  }
  return out;
}

export async function compose(site: Site, ev: Event, exact: string[] = []): Promise<Queued> {
  const now = new Date();
  const local = now.toLocaleString("en-US", {
    timeZone: site.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const subject = redact(ev.subject ?? `[Archon] ${site.name}: ${ev.event}`, exact);
  if (ev.subject) {
    // A message written by a person or assistant: their body, as given.
    const body = redact(ev.what, exact);
    return {
      id: `${now.getTime()}-${crypto.randomUUID().slice(0, 8)}`,
      created: now.toISOString(),
      subject,
      text: `${body}\n\n-- sent with archon notify from ${site.name} (${
        now.toISOString().slice(0, 16).replace("T", " ")
      } UTC)`,
      html:
        `<div style="font-family:system-ui,sans-serif;font-size:14px"><pre style="white-space:pre-wrap;font-family:inherit">${
          escapeHtml(body)
        }</pre><p style="color:#888;font-size:12px">sent with archon notify from ${
          escapeHtml(site.name)
        }</p></div>`,
      level: ev.level ?? "info",
      key: ev.key,
      attachments: await attachments(ev.attach ?? [], exact),
      attempts: 0,
      nextAt: now.toISOString(),
    };
  }
  const fields: Array<[string, string]> = [
    ["Host", `${site.name} (${site.role === "boot" ? "boot machine" : site.role})`],
    ["Time", `${now.toISOString().slice(0, 16).replace("T", " ")} UTC (${local} ${site.timezone})`],
    ["Archon", await commit()],
  ];
  const what = redact(ev.what, exact);
  const todo = redact(ev.todo ?? "Nothing.", exact);
  const text = [
    ...fields.map(([k, v]) => `${k}: ${v}`),
    "",
    "What happened:",
    what,
    "",
    "What to do:",
    todo,
    ...(ev.log ? ["", `Log: ${ev.log}`] : []),
    "",
    "-- archon notify (spec 025)",
  ].join("\n");
  const color = ev.level === "fail" ? "#b00020" : ev.level === "warn" ? "#9a6700" : "#1a7f37";
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px">
<h3 style="color:${color};margin:0 0 8px">${escapeHtml(ev.event)}</h3>
<table style="border-collapse:collapse">${
    fields.map(([k, v]) =>
      `<tr><td style="padding:2px 12px 2px 0;color:#555">${k}</td><td>${escapeHtml(v)}</td></tr>`
    ).join("")
  }</table>
<h4 style="margin:12px 0 4px">What happened</h4><pre style="white-space:pre-wrap">${
    escapeHtml(what)
  }</pre>
<h4 style="margin:12px 0 4px">What to do</h4><p>${escapeHtml(todo)}</p>
${ev.log ? `<p style="color:#555">Log: <code>${escapeHtml(ev.log)}</code></p>` : ""}
<p style="color:#888;font-size:12px">archon notify (spec 025)</p></div>`;
  return {
    id: `${now.getTime()}-${crypto.randomUUID().slice(0, 8)}`,
    created: now.toISOString(),
    subject,
    text,
    html,
    level: ev.level ?? "info",
    key: ev.key,
    attachments: await attachments(ev.attach ?? [], exact),
    attempts: 0,
    nextAt: now.toISOString(),
  };
}

// ------------------------------------------------------------------ queue

const DEDUPE_MS = 3600_000;
/** Backoff between attempts: 1 min, 5 min, 15 min, 1 h, then every 3 h. */
export const BACKOFF_MIN = [1, 5, 15, 60, 180];

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse((await readTextOr(path)) ?? "") as T;
  } catch {
    return fallback;
  }
}

/** Queue a message. Returns why it was not queued, if it was not. Never throws. */
export async function enqueue(
  site: Site,
  ev: Event,
): Promise<"queued" | "duplicate" | "not configured" | "failed"> {
  try {
    if (!site.to || !(await exists(site.credential))) return "not configured";
    await ensureDir(site.spool);
    if (Deno.build.os !== "windows" && isRoot()) {
      await Deno.chmod(site.spool, 0o700).catch(() => {});
    }
    const keysPath = join(site.spool, "keys.json");
    const keys = await readJson<Record<string, string>>(keysPath, {});
    const now = Date.now();
    for (const [k, at] of Object.entries(keys)) {
      if (now - Date.parse(at) > DEDUPE_MS) delete keys[k];
    }
    if (ev.key && keys[ev.key]) return "duplicate";
    if (ev.key) keys[ev.key] = new Date(now).toISOString();
    await Deno.writeTextFile(keysPath, JSON.stringify(keys));
    const cred = await loadCredential(site);
    const q = await compose(site, ev, secretsOf(cred));
    await Deno.writeTextFile(join(site.spool, `${q.id}.json`), JSON.stringify(q), { mode: 0o600 });
    return "queued";
  } catch {
    return "failed";
  }
}

export async function queued(site: Site): Promise<Array<{ path: string; q: Queued }>> {
  const out: Array<{ path: string; q: Queued }> = [];
  if (!(await exists(site.spool))) return out;
  for await (const e of Deno.readDir(site.spool)) {
    if (!e.isFile || !/^\d+-[0-9a-f]{8}\.json$/.test(e.name)) continue;
    const path = join(site.spool, e.name);
    const q = await readJson<Queued | undefined>(path, undefined);
    if (q) out.push({ path, q });
  }
  return out.sort((a, b) => a.q.created.localeCompare(b.q.created));
}

export interface Status {
  configured: boolean;
  to?: string;
  method?: string;
  lastSend?: { at: string; ok: boolean; subject: string; error?: string };
  queue: number;
  oldest?: string;
}

export async function readStatus(site: Site): Promise<Status> {
  return await readJson<Status>(site.status, { configured: false, queue: 0 });
}

async function writeStatus(site: Site, s: Status) {
  await ensureDir(join(site.status, ".."));
  await Deno.writeTextFile(site.status, JSON.stringify(s, null, 2) + "\n").catch(() => {});
}

/**
 * After a long outage many messages wait: they become one summary ("N
 * messages were queued"), so the mailbox gets one message, not a burst.
 */
export function collapse(
  items: Queued[],
  now = Date.now(),
): { summary?: Omit<Queued, "id">; drop: Queued[] } {
  const old = items.filter((q) => now - Date.parse(q.created) > 3600_000);
  if (old.length < 5) return { drop: [] };
  const lines = old.map((q) => `- ${q.created.slice(0, 16).replace("T", " ")} UTC  ${q.subject}`);
  const host = old[0].subject.match(/^\[Archon\] ([^:]+):/)?.[1] ?? "archon";
  const worst: Level = old.some((q) => q.level === "fail")
    ? "fail"
    : old.some((q) => q.level === "warn")
    ? "warn"
    : "info";
  return {
    summary: {
      created: new Date(now).toISOString(),
      subject: `[Archon] ${host}: ${old.length} messages were queued while mail could not be sent`,
      text: `These messages could not be sent and are summarized here:\n\n${
        lines.join("\n")
      }\n\nDetails are in each host's logs.\n\n-- archon notify (spec 025)`,
      html: `<p>These messages could not be sent and are summarized here:</p><pre>${
        escapeHtml(lines.join("\n"))
      }</pre>`,
      level: worst,
      attachments: [],
      attempts: 0,
      nextAt: new Date(now).toISOString(),
    },
    drop: old,
  };
}

/** The transports, replaceable in tests. */
export const sendDeps = { smtp: sendSmtp };

/** Send what is due. Returns how many were sent. */
export async function flush(
  site: Site,
  o: { force?: boolean } = {},
): Promise<{ sent: number; failed: number; error?: string }> {
  const cred = await loadCredential(site);
  const status = await readStatus(site);
  status.configured = !!cred && !!site.to;
  status.to = site.to;
  status.method = cred ? "cloudflare" : undefined;
  if (!cred || !site.to || !site.from) {
    status.queue = (await queued(site)).length;
    await writeStatus(site, status);
    return { sent: 0, failed: 0, error: "not configured" };
  }
  let items = await queued(site);
  const { summary, drop } = collapse(items.map((x) => x.q));
  if (summary) {
    for (const d of drop) {
      await Deno.remove(items.find((x) => x.q.id === d.id)!.path).catch(() => {});
    }
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await Deno.writeTextFile(join(site.spool, `${id}.json`), JSON.stringify({ id, ...summary }), {
      mode: 0o600,
    });
    items = await queued(site);
  }
  let sent = 0;
  let failed = 0;
  let error: string | undefined;
  for (const { path, q } of items) {
    if (!o.force && Date.parse(q.nextAt) > Date.now()) continue;
    const mime = buildMime({
      from: site.from,
      // The machine by name in the inbox; replies go to the shared mailbox, not the sender.
      fromName: `${site.name} (Archon)`,
      to: site.to,
      subject: q.subject,
      text: q.text,
      html: q.html,
      headers: {
        "Reply-To": site.to,
        "X-Archon-Level": q.level,
        ...(q.key ? { "X-Archon-Key": q.key } : {}),
      },
      attachments: q.attachments.map((a) => ({
        name: a.name,
        type: a.type,
        data: Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0)),
      })),
    });
    try {
      await sendDeps.smtp(cred, {
        relay: site.relay,
        ipv4: site.ipv4,
        from: site.from,
        to: site.to,
      }, mime);
      await Deno.remove(path).catch(() => {});
      sent++;
      status.lastSend = { at: new Date().toISOString(), ok: true, subject: q.subject };
    } catch (e) {
      failed++;
      error = redact((e as Error).message, secretsOf(cred));
      q.attempts++;
      q.lastError = error;
      q.nextAt = new Date(
        Date.now() + BACKOFF_MIN[Math.min(q.attempts - 1, BACKOFF_MIN.length - 1)] * 60_000,
      ).toISOString();
      await Deno.writeTextFile(path, JSON.stringify(q), { mode: 0o600 }).catch(() => {});
      status.lastSend = { at: new Date().toISOString(), ok: false, subject: q.subject, error };
      break; // the relay is not answering: the rest waits for the next flush
    }
  }
  const left = await queued(site);
  status.queue = left.length;
  status.oldest = left[0]?.q.created;
  await writeStatus(site, status);
  return { sent, failed, error };
}

/** Start sending now without waiting for it (hosts: the flush service). */
export async function kick(site: Site): Promise<void> {
  if (site.role === "boot") {
    await flush(site).catch(() => {});
    return;
  }
  await run(["systemctl", "start", "--no-block", HOST_NOTIFY.flushUnit]).catch(() => {});
}
