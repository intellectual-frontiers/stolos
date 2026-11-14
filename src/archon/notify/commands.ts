/**
 * The archon notify commands (spec 025), on hosts, workstations, and the boot
 * machine (deno task stolos boot notify runs the same code), and archon mail
 * credential and mail test (spec 027).
 *
 * @module
 */

import { ensureDir, exists } from "../core/fsx.ts";
import { isRoot, run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import {
  enqueue,
  flush,
  HOST_NOTIFY,
  type Level,
  loadCredential,
  queued,
  readStatus,
  type Site,
} from "./notify.ts";
import { localSite } from "./events.ts";
import { type Credential, saslPasswd } from "./transport.ts";
import { loadFleet } from "../model/load.ts";
import { DEFAULT_RELAY } from "./transport.ts";

/**
 * Install the relay credential on this host (spec 027): Postfix's
 * /etc/postfix/sasl_passwd, root only, then Postfix reloads (it reads the file
 * once, texthash). archon's own sends read the same file.
 */
export async function installCredential(json: string): Promise<void> {
  const c = JSON.parse(json) as Credential;
  if (typeof c.token !== "string" || !c.token) throw new Error("not an archon mail credential");
  const relay = (await loadFleet().catch(() => undefined))?.mail?.relay ?? DEFAULT_RELAY;
  await ensureDir("/etc/postfix");
  await Deno.writeTextFile(HOST_NOTIFY.credential, saslPasswd(c, relay), { mode: 0o600 });
  await Deno.chmod(HOST_NOTIFY.credential, 0o600);
  await run(["chown", "root:root", HOST_NOTIFY.credential]);
  if (await exists("/usr/sbin/postfix")) {
    await run(["systemctl", "try-reload-or-restart", "postfix.service"]);
  }
}

async function site(): Promise<Site> {
  const s = await localSite();
  if (!s) throw new Error("no fleet: archon notify needs fleets/<fleet>/fleet.ts");
  return s;
}

/** The options of `archon notify send`. */
export interface SendArgs {
  /**
   * The subject. One that starts with `[` or `Lab ` is sent as given, with the
   * body as the whole message; a short one becomes `[Archon] <host>: <subject>`.
   */
  subject: string;
  /** The body text (with a short subject, the subject itself when empty). */
  body?: string;
  /** Read the body from this file instead (it wins over `body`). */
  bodyFile?: string;
  /** Files to attach. */
  attach?: string[];
  /** How serious it is; `"info"` by default. */
  level?: Level;
  /** Deduplication key: the same key within an hour is sent once. */
  key?: string;
}

/**
 * archon notify send: queue a message from this machine. With `wait`, send it
 * now and report whether it went; otherwise start the sender and return.
 * Exit code 0 when queued (or sent, with `wait`) or a duplicate, else 1.
 */
export async function notifySend(a: SendArgs, o: { wait: boolean }): Promise<number> {
  const s = await site();
  const p = ui.phase("Notify");
  const body = a.bodyFile ? await Deno.readTextFile(a.bodyFile) : a.body ?? "";
  // A full subject is sent as given; a short one becomes "[Archon] <host>: <subject>".
  const full = /^\[|^Lab /.test(a.subject);
  const r = await enqueue(s, {
    event: a.subject,
    subject: full ? a.subject : undefined,
    what: full ? body : body || a.subject,
    level: a.level,
    attach: a.attach,
    key: a.key,
  });
  if (r === "not configured") {
    p.fail(
      `notifications are not configured on ${s.name}`,
      s.role === "boot"
        ? "deno task stolos boot mail-setup"
        : `on the boot machine: deno task stolos boot mail-push ${s.name}`,
    );
    return 1;
  }
  if (r === "duplicate") {
    p.done(`not sent: the same --key was sent within the hour`);
    return 0;
  }
  if (r === "failed") {
    p.fail("could not queue the message", "archon notify status");
    return 1;
  }
  if (!o.wait) {
    if (s.role === "boot") await flush(s);
    else await run(["systemctl", "start", "--no-block", HOST_NOTIFY.flushUnit]);
    p.done(`queued for ${s.to}; sending now`);
    return 0;
  }
  const f = await flush(s, { force: true });
  if (f.sent) p.done(`sent to ${s.to}`);
  else {p.fail(
      `not sent yet: ${f.error ?? "queued"}`,
      "archon notify status; it is retried with backoff",
    );}
  return f.sent ? 0 : 1;
}

/** archon notify test: send a test message now and wait for the relay (exit code 0 when sent). */
export async function notifyTest(): Promise<number> {
  const s = await site();
  return await notifySend({
    subject: `[Archon] ${s.name}: notification test`,
    body: `This is a test from ${s.name} (${s.role === "boot" ? "the boot machine" : s.role}).\n` +
      `If it arrived, archon notify works here. Nothing needs to be done.`,
  }, { wait: true });
}

/**
 * archon notify status: mailbox, sender, relay, credential, last send and
 * queue. With `check` (archon verify), one line instead, and exit code 1 when
 * mail is not configured, the last send failed, or a message has waited more
 * than 6 hours.
 */
export async function notifyStatus(o: { check: boolean }): Promise<number> {
  const s = await site();
  const st = await readStatus(s);
  const cred = await loadCredential(s).catch(() => undefined);
  const configured = s.role === "boot" || isRoot() ? !!cred : st.configured;
  const q = isRoot() || s.role === "boot" ? (await queued(s)).length : st.queue;
  const lines = [
    `mailbox    ${s.to ?? "(none: mail in fleets/<fleet>/fleet.ts)"}`,
    `from       ${s.from ?? "-"}`,
    `relay      ${s.relay}`,
    `configured ${configured ? "yes (Cloudflare API token)" : "no"}`,
    `last send  ${
      st.lastSend
        ? `${st.lastSend.at} ${
          st.lastSend.ok ? "ok" : `FAILED: ${st.lastSend.error}`
        } · ${st.lastSend.subject}`
        : "none yet"
    }`,
    `queue      ${q}${st.oldest && q ? ` (oldest ${st.oldest})` : ""}`,
  ];
  if (o.check) {
    // archon verify (spec 025): configured, the last send ok, the queue moving.
    const stuck = q > 0 && st.oldest && Date.now() - Date.parse(st.oldest) > 6 * 3600_000;
    const problem = !s.to
      ? undefined // the fleet does not use notifications
      : !configured
      ? "mail is not configured (on the boot machine: deno task stolos boot mail-push <host>)"
      : st.lastSend && !st.lastSend.ok
      ? `the last send failed: ${st.lastSend.error}`
      : stuck
      ? `${q} message(s) waiting for more than 6 hours`
      : undefined;
    console.log(problem ?? "notifications ok");
    return problem ? 1 : 0;
  }
  for (const l of lines) console.log(l);
  return 0;
}

/**
 * archon notify flush (the flush service): send what is due. Prints counts
 * only when something was tried. Always exit code 0.
 */
export async function notifyFlush(): Promise<number> {
  const s = await site();
  const f = await flush(s);
  if (f.sent || f.failed) {
    console.log(`sent ${f.sent}${f.failed ? `, failed ${f.failed}: ${f.error}` : ""}`);
  }
  return 0;
}

/**
 * archon mail credential: the credential JSON on stdin (deno task stolos boot
 * mail-push). Then the doctor's email checks, mailed to the shared mailbox
 * through archon and Postfix, so the new token is proven where it matters.
 */
export async function mailCredential(): Promise<number> {
  const json = await new Response(Deno.stdin.readable).text();
  await installCredential(json);
  console.log(`installed ${HOST_NOTIFY.credential} (root only); Postfix reloaded`);
  const s = await site();
  const { emailChecks } = await import("../doctor/email.ts");
  const p = ui.phase("Email");
  await emailChecks(s, p, `on the boot machine: deno task stolos boot mail-push ${s.name}`, {
    send: "new token",
  });
  return p.level === "fail" ? 1 : 0;
}

/**
 * archon mail test: one message through Postfix (/usr/sbin/sendmail), the path
 * every app and cron job uses; addressed to root, which this host's Postfix
 * sends on to the fleet's mailbox.
 */
export async function mailTest(hostName: string): Promise<number> {
  const p = ui.phase("Mail");
  if (!(await exists("/usr/sbin/sendmail"))) {
    p.fail("no /usr/sbin/sendmail: Postfix is not installed yet", "sudo archon apply");
    return 1;
  }
  const msg = [
    "To: root",
    `Subject: [Archon] ${hostName}: mail test (Postfix)`,
    "",
    `A test from ${hostName}'s Postfix, the way apps and cron jobs send mail.`,
    "If it arrived, mail from this server works. Nothing needs to be done.",
    "",
  ].join("\n");
  const r = await run(["/usr/sbin/sendmail", "-t", "-oi"], { stdin: msg });
  if (!r.ok) {
    p.fail(
      `sendmail: ${r.stderr.trim()}`,
      "systemctl status postfix; journalctl -u postfix@- -n 50",
    );
    return 1;
  }
  p.done(
    "handed to Postfix for root (sent on to the fleet's mailbox); journalctl -t postfix/smtp -f shows the relay's answer",
  );
  return 0;
}
