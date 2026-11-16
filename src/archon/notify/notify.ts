/**
 * archon notify (spec 025): major events, by email, to the fleet's shared
 * mailbox. Reporting never fails or slows the action it reports: a message is
 * queued on disk and sent by `archon notify flush` (a service started at once
 * and a timer every 5 minutes) through Cloudflare's SMTP relay (spec 027),
 * with backoff when it cannot be reached,
 * duplicates dropped by key within an hour, and one summary after a long
 * outage. Nothing secret is ever sent (IFC TypeScript's one redaction, `otel.redactText`).
 *
 * ```mermaid
 * flowchart LR
 *   ev["an event<br/>(apply, verify, backup, watch, notify send)"] --> enq["enqueue<br/>dedupe by key, compose, redact"]
 *   enq --> spool["spool<br/>one JSON file per message"]
 *   enq --> kick["kick<br/>start the flush service"]
 *   kick --> flush["flush<br/>collapse after an outage"]
 *   spool --> flush
 *   flush -->|"SMTP, implicit TLS"| relay["Cloudflare relay"]
 *   relay --> box["the fleet's mailbox"]
 *   flush -->|"relay fails"| back["backoff: 1, 5, 15, 60, then 180 min"]
 *   back --> spool
 * ```
 *
 * @module
 */

import { fromBase64, otel, toBase64 } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { run } from "../core/exec.ts";
import { asRoot, onHost, P } from "../core/paths.ts";
import { SECRETS } from "../core/secrets.ts";
import type { FleetDef } from "../model/types.ts";
import { buildMime, escapeHtml } from "./mime.ts";
import {
  type Credential,
  DEFAULT_RELAY,
  parseSaslPasswd,
  SASL_PASSWD,
  secretsOf,
  senderAddress,
  sendSmtp,
} from "./transport.ts";

/** How serious a message is: sets the heading color and the `X-Archon-Level` header. */
export type Level = "info" | "warn" | "fail";

/** Where this machine keeps its credential, queue, and status. */
export interface Site {
  /** What this machine is: a server, a workstation, or the boot machine. */
  role: "server" | "workstation" | "boot";
  /** Its short name, as it appears in subjects and in the From display name. */
  name: string;
  /** Path of the credential file (Postfix's sasl_passwd on hosts, JSON on the boot machine). */
  credential: string;
  /** Folder of queued messages, one JSON file each. */
  spool: string;
  /** Path of the status file (`archon notify status` reads it). */
  status: string;
  /** The fleet's mailbox (`fleet.mail.to`); unset when the fleet has no mail. */
  to?: string | undefined;
  /** The sender address (spec 027); unset when the fleet has no mail. */
  from?: string | undefined;
  /** host:port of the SMTP relay (Cloudflare Email Service). */
  relay: string;
  /** Reach the relay over IPv4 only (the network has no IPv6). */
  ipv4: boolean;
  /** The fleet's IANA time zone, for local times in messages. */
  timezone: string;
}

/** Where a host (server or workstation) keeps its notify files, and its flush unit. */
export const HOST_NOTIFY = {
  /** Postfix's credential file; archon's own sends use the same token. */
  credential: SASL_PASSWD,
  /** The queue, one JSON file per message (mode 0700, root only). */
  spool: "/var/spool/archon/notify",
  /** The status file. */
  status: "/var/lib/archon/status/notify.json",
  /** The systemd service that sends what is queued (`archon notify flush`). */
  flushUnit: "archon-notify-flush.service",
};

/**
 * A host as a notify site: the fixed host paths, the fleet's mailbox, and
 * `root+<host>.<tag>@<domain>` as sender (spec 027). `ipv6` is whether the
 * host's network has IPv6 (without it, the relay is reached over IPv4).
 */
export function hostSite(
  fleet: FleetDef,
  name: string,
  kind: "server" | "workstation",
  ipv6: boolean,
): Site {
  return {
    role: kind,
    name,
    credential: onHost(HOST_NOTIFY.credential),
    spool: onHost(HOST_NOTIFY.spool),
    status: onHost(HOST_NOTIFY.status),
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
  const u = (proc.env.get("USERNAME") ?? proc.env.get("USER") ?? "archon").toLowerCase();
  return u.replace(/[^a-z0-9._-]/g, "") || "archon";
}

/**
 * The boot machine as a notify site: its queue next to the boot cache, the
 * credential in its secrets folder, and `<user>+<pc>.<tag>@<domain>` as sender.
 */
export function bootSite(fleet: FleetDef): Site {
  const name = (proc.hostname().split(".")[0] ?? "").toLowerCase();
  const dir = path.join(P.bootCache, "..", "notify");
  return {
    role: "boot",
    name,
    credential: SECRETS.mail,
    spool: dir,
    status: path.join(dir, "status.json"),
    to: fleet.mail?.to,
    // The boot machine: <the person running it>+<pc>.<tag>@<domain> (alice+bootpc.lab@...).
    from: fleet.mail ? senderAddress(fleet.mail, name, bootUser()) : undefined,
    relay: fleet.mail?.relay ?? DEFAULT_RELAY,
    ipv4: fleet.network?.ipv6 === false,
    timezone: fleet.timezone,
  };
}

/**
 * The relay credential: parsed from sasl_passwd on hosts, JSON on the boot
 * machine; undefined when missing or unreadable.
 */
export async function loadCredential(site: Site): Promise<Credential | undefined> {
  const text = await fs.readTextOr(site.credential, "");
  // Hosts: Postfix's sasl_passwd line; the boot machine: JSON in its secrets folder.
  if (site.role !== "boot") return parseSaslPasswd(text);
  try {
    const c: unknown = JSON.parse(text);
    return typeof c === "object" && c !== null && "token" in c && typeof c.token === "string"
      ? (c as Credential)
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- compose

/** Something to report: what `notify` and `enqueue` take. */
export interface Event {
  /** What happened, short: "✗ apply failing since 14:04". */
  event: string;
  /** How serious it is; `"info"` by default. */
  level?: Level | undefined;
  /** The details: a few lines. */
  what: string;
  /** What a person or assistant should do, if anything. */
  todo?: string | undefined;
  /** Path of the full log, named in the message (not attached by itself). */
  log?: string | undefined;
  /** Files to attach (redacted, trimmed, about 1 MB in all). */
  attach?: string[] | undefined;
  /** Messages with the same key within an hour are sent once. */
  key?: string | undefined;
  /**
   * archon notify send: this exact subject (for example "Lab Network Runbook
   * Change Log ..."), and `what` as the whole body.
   */
  subject?: string | undefined;
}

/** A composed message waiting in the spool (one JSON file, named by its id). */
export interface Queued {
  /** `<epoch ms>-<8 hex>`: sorts by time and names the file. */
  id: string;
  /** When it was composed (ISO 8601). */
  created: string;
  /** The subject, redacted. */
  subject: string;
  /** The plain-text body, redacted. */
  text: string;
  /** The HTML body, redacted. */
  html: string;
  /** How serious it is. */
  level: Level;
  /** The deduplication key, if any (sent as `X-Archon-Key`). */
  key?: string | undefined;
  /** Attached files, contents in base64. */
  attachments: Array<{ name: string; type: string; b64: string }>;
  /** How many sends have failed so far. */
  attempts: number;
  /** When to try next (ISO 8601); see BACKOFF_MIN. */
  nextAt: string;
  /** The last send error, redacted. */
  lastError?: string | undefined;
}

const MAX_ATTACH = 1_000_000;

async function commit(): Promise<string> {
  return (
    (await run(["git", "-C", P.repo, "rev-parse", "--short", "HEAD"])).stdout.trim() || "unknown"
  );
}

/** Files to attach: text redacted and trimmed to its end, gzipped when large; about 1 MB in all. */
export async function attachments(
  files: string[],
  exact: string[],
): Promise<Queued["attachments"]> {
  const out: Queued["attachments"] = [];
  let total = 0;
  for (const p of files) {
    const raw = await fs.readFile(p).catch(() => undefined);
    if (!raw) continue;
    const name = p.split(/[\\/]/).pop() ?? p;
    let text = otel.redactText(new TextDecoder().decode(raw), exact);
    if (text.length > 256_000) text = "[trimmed to the last 256 KB]\n" + text.slice(-256_000);
    let data: Uint8Array = new TextEncoder().encode(text);
    let file = name;
    let type = /\.html?$/.test(name)
      ? "text/html"
      : /\.json$/.test(name)
        ? "application/json"
        : "text/plain";
    if (data.length > 64_000) {
      data = new Uint8Array(
        await new Response(
          new Blob([data as Uint8Array<ArrayBuffer>])
            .stream()
            .pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer(),
      );
      file = `${name}.gz`;
      type = "application/gzip";
    }
    if (total + data.length > MAX_ATTACH) continue;
    total += data.length;
    out.push({ name: file, type, b64: toBase64(data) });
  }
  return out;
}

/**
 * Build the message for an event: subject, plain text and HTML, all redacted
 * (known secret shapes and the `exact` strings). With `ev.subject` the body is
 * `ev.what` as given; otherwise a report with host, time, Archon commit, what
 * happened and what to do.
 */
export async function compose(site: Site, ev: Event, exact: string[] = []): Promise<Queued> {
  const now = new Date();
  const local = now.toLocaleString("en-US", {
    timeZone: site.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const subject = otel.redactText(ev.subject ?? `[Archon] ${site.name}: ${ev.event}`, exact);
  if (ev.subject) {
    // A message written by a person or assistant: their body, as given.
    const body = otel.redactText(ev.what, exact);
    return {
      id: `${now.getTime()}-${crypto.randomUUID().slice(0, 8)}`,
      created: now.toISOString(),
      subject,
      text: `${body}\n\n-- sent with archon notify from ${site.name} (${now
        .toISOString()
        .slice(0, 16)
        .replace("T", " ")} UTC)`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:14px"><pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(
        body,
      )}</pre><p style="color:#888;font-size:12px">sent with archon notify from ${escapeHtml(
        site.name,
      )}</p></div>`,
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
  const what = otel.redactText(ev.what, exact);
  const todo = otel.redactText(ev.todo ?? "Nothing.", exact);
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
<table style="border-collapse:collapse">${fields
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#555">${k}</td><td>${escapeHtml(v)}</td></tr>`,
    )
    .join("")}</table>
<h4 style="margin:12px 0 4px">What happened</h4><pre style="white-space:pre-wrap">${escapeHtml(
    what,
  )}</pre>
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

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readTextOr(file, "")) as T;
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
    if (!site.to || !(await fs.exists(site.credential))) return "not configured";
    await fs.ensureDir(site.spool);
    if (proc.build.os !== "windows" && asRoot()) {
      await fs.chmod(site.spool, 0o700).catch(() => undefined);
    }
    const keysPath = path.join(site.spool, "keys.json");
    const keys = await readJson<Record<string, string>>(keysPath, {});
    const now = Date.now();
    for (const [k, at] of Object.entries(keys)) {
      if (now - Date.parse(at) > DEDUPE_MS) delete keys[k];
    }
    if (ev.key && keys[ev.key]) return "duplicate";
    if (ev.key) keys[ev.key] = new Date(now).toISOString();
    await fs.writeTextFile(keysPath, JSON.stringify(keys));
    const cred = await loadCredential(site);
    const q = await compose(site, ev, secretsOf(cred));
    await fs.writeTextFile(path.join(site.spool, `${q.id}.json`), JSON.stringify(q), {
      mode: 0o600,
    });
    return "queued";
  } catch {
    return "failed";
  }
}

/** The messages in the spool, oldest first, with their file paths. */
export async function queued(site: Site): Promise<Array<{ path: string; q: Queued }>> {
  const out: Array<{ path: string; q: Queued }> = [];
  if (!(await fs.exists(site.spool))) return out;
  for await (const e of fs.readDir(site.spool)) {
    if (!e.isFile || !/^\d+-[0-9a-f]{8}\.json$/.test(e.name)) continue;
    const file = path.join(site.spool, e.name);
    const q = await readJson<Queued | undefined>(file, undefined);
    if (q) out.push({ path: file, q });
  }
  return out.sort((a, b) => a.q.created.localeCompare(b.q.created));
}

/** What `archon notify status` shows: written after every flush. */
export interface Status {
  /** A credential and a mailbox are both set. */
  configured: boolean;
  /** The mailbox messages go to. */
  to?: string | undefined;
  /** How mail is sent (`"cloudflare"`), unset without a credential. */
  method?: string | undefined;
  /** The last send attempt: when, whether it worked, its subject, and the error if not. */
  lastSend?: { at: string; ok: boolean; subject: string; error?: string };
  /** How many messages are waiting. */
  queue: number;
  /** When the oldest waiting message was composed (ISO 8601). */
  oldest?: string | undefined;
}

/** The site's status file, or "not configured, empty queue" when there is none. */
export async function readStatus(site: Site): Promise<Status> {
  return await readJson<Status>(site.status, { configured: false, queue: 0 });
}

async function writeStatus(site: Site, s: Status): Promise<void> {
  await fs.ensureDir(path.join(site.status, ".."));
  await fs.writeTextFile(site.status, JSON.stringify(s, null, 2) + "\n").catch(() => undefined);
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
  const first = old[0];
  if (old.length < 5 || first === undefined) return { drop: [] };
  const lines = old.map((q) => `- ${q.created.slice(0, 16).replace("T", " ")} UTC  ${q.subject}`);
  const host = first.subject.match(/^\[Archon\] ([^:]+):/)?.[1] ?? "archon";
  const worst: Level = old.some((q) => q.level === "fail")
    ? "fail"
    : old.some((q) => q.level === "warn")
      ? "warn"
      : "info";
  return {
    summary: {
      created: new Date(now).toISOString(),
      subject: `[Archon] ${host}: ${old.length} messages were queued while mail could not be sent`,
      text: `These messages could not be sent and are summarized here:\n\n${lines.join(
        "\n",
      )}\n\nDetails are in each host's logs.\n\n-- archon notify (spec 025)`,
      html: `<p>These messages could not be sent and are summarized here:</p><pre>${escapeHtml(
        lines.join("\n"),
      )}</pre>`,
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
): Promise<{ sent: number; failed: number; error?: string | undefined }> {
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
      const file = items.find((x) => x.q.id === d.id)?.path;
      if (file !== undefined) await fs.remove(file).catch(() => undefined);
    }
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await fs.writeTextFile(
      path.join(site.spool, `${id}.json`),
      JSON.stringify({ id, ...summary }),
      {
        mode: 0o600,
      },
    );
    items = await queued(site);
  }
  let sent = 0;
  let failed = 0;
  let error: string | undefined;
  const from = site.from;
  const to = site.to;
  for (const { path: file, q } of items) {
    if (!o.force && Date.parse(q.nextAt) > Date.now()) continue;
    const mime = buildMime({
      from,
      // The machine by name in the inbox; replies go to the shared mailbox, not the sender.
      fromName: `${site.name} (Archon)`,
      to,
      subject: q.subject,
      text: q.text,
      html: q.html,
      headers: {
        "Reply-To": to,
        "X-Archon-Level": q.level,
        ...(q.key ? { "X-Archon-Key": q.key } : {}),
      },
      attachments: q.attachments.map((a) => ({
        name: a.name,
        type: a.type,
        data: ((r) => (r.kind === "ok" ? r.value : new Uint8Array()))(fromBase64(a.b64)),
      })),
    });
    try {
      await sendDeps.smtp(
        cred,
        {
          relay: site.relay,
          ipv4: site.ipv4,
          from,
          to,
        },
        mime,
      );
      await fs.remove(file).catch(() => undefined);
      sent++;
      status.lastSend = { at: new Date().toISOString(), ok: true, subject: q.subject };
    } catch (e) {
      failed++;
      error = otel.redactText((e as Error).message, secretsOf(cred));
      q.attempts++;
      q.lastError = error;
      const wait = BACKOFF_MIN[Math.min(q.attempts - 1, BACKOFF_MIN.length - 1)] ?? 180;
      q.nextAt = new Date(Date.now() + wait * 60_000).toISOString();
      await fs.writeTextFile(file, JSON.stringify(q), { mode: 0o600 }).catch(() => undefined);
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
    await flush(site).catch(() => undefined);
    return;
  }
  await run(["systemctl", "start", "--no-block", HOST_NOTIFY.flushUnit]).catch(() => undefined);
}
