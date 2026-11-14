/**
 * archon doctor's email checks (spec 026, for specs 025 and 027), shared by
 * servers and the boot machine: the sending domain's records in DNS, the
 * relay's credential, a login to the relay that sends nothing, and on servers
 * Postfix itself. The records are the ones Cloudflare's Email Sending
 * onboarding creates (developers.cloudflare.com/email-service/configuration/domains/).
 * With `send` (archon doctor --send, and by itself after mail-setup, an
 * install, or a new token), it also mails what it found to the shared mailbox
 * through each path: archon's own sender, and on servers Postfix.
 *
 * @module
 */

import type { Phase } from "../core/ui.ts";
import { exists } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { enqueue, flush, loadCredential, queued, readStatus, type Site } from "../notify/notify.ts";
import { probeSmtp, relayParts } from "../notify/transport.ts";
import { isReservedDomain } from "../model/providers.ts";

async function txt(name: string): Promise<string[]> {
  try {
    return (await Deno.resolveDns(name, "TXT")).map((r) => r.join(""));
  } catch {
    return [];
  }
}

async function mx(name: string): Promise<string[]> {
  try {
    return (await Deno.resolveDns(name, "MX")).map((r) => r.exchange.replace(/\.$/, ""));
  } catch {
    return [];
  }
}

/** Which of Cloudflare Email Sending's records a domain lacks, from its TXT and MX answers. */
export function missingRecords(
  domain: string,
  r: { spf: string[]; dkim: string[]; dmarc: string[]; mx: string[] },
): string[] {
  const bounce = `cf-bounce.${domain}`;
  const missing: string[] = [];
  if (!r.spf.some((t) => /^v=spf1 .*include:_spf\.mx\.cloudflare\.net/.test(t))) {
    missing.push(`SPF (TXT ${bounce})`);
  }
  if (!r.dkim.some((t) => /^v=DKIM1/.test(t))) {
    missing.push(`DKIM (TXT cf-bounce._domainkey.${domain})`);
  }
  if (!r.dmarc.some((t) => /^v=DMARC1/.test(t))) missing.push(`DMARC (TXT _dmarc.${domain})`);
  if (!r.mx.some((m) => /\.mx\.cloudflare\.net$/.test(m))) missing.push(`bounce MX (${bounce})`);
  return missing;
}

export async function domainRecords(domain: string): Promise<string[]> {
  const [spf, dkim, dmarc, mxs] = await Promise.all([
    txt(`cf-bounce.${domain}`),
    txt(`cf-bounce._domainkey.${domain}`),
    txt(`_dmarc.${domain}`),
    mx(`cf-bounce.${domain}`),
  ]);
  return missingRecords(domain, { spf, dkim, dmarc, mx: mxs });
}

export async function emailChecks(
  site: Site | undefined,
  phase: Phase,
  fixCredential: string,
  o: { send?: string } = {},
): Promise<void> {
  if (!site?.to || !site.from) {
    phase.done("not used: no mail in fleets/<fleet>/fleet.ts");
    return;
  }
  // Everything found, for the test message.
  const found: string[] = [];
  const p = {
    ok: (m: string) => (found.push(`ok    ${m}`), phase.ok(m)),
    warn: (m: string, fix?: string) => (found.push(`WARN  ${m}`), phase.warn(m, fix)),
    fail: (m: string, fix?: string) => (found.push(`FAIL  ${m}`), phase.fail(m, fix)),
    pending: (m: string, next: string, code: string) => (
      found.push(`TODO  ${m}`), phase.pending(m, next, code)
    ),
    done: (m: string) => phase.done(m),
  };
  const domain = site.from.split("@")[1];

  // The sending domain, as Cloudflare's onboarding sets it up. A reserved test
  // domain (a synthetic fleet's) can never be onboarded: not asked about.
  const missing = isReservedDomain(domain) ? [] : await domainRecords(domain);
  if (isReservedDomain(domain)) {
    p.ok(`${domain} is reserved for tests (RFC 2606): its DNS is not checked`);
  } else if (missing.length) {
    p.fail(
      `${domain} is missing ${missing.join(", ")}: Cloudflare will refuse or mail will be rejected`,
      `Cloudflare: Compute > Email Service > Email Sending > Onboard Domain > ${domain}`,
    );
  } else {
    p.ok(`${domain}: SPF, DKIM, DMARC, and bounce MX in place (Cloudflare Email Sending)`);
  }

  // The relay: log in and leave, sending nothing.
  const cred = await loadCredential(site);
  const { host, port } = relayParts(site.relay);
  if (!cred) {
    // Spec 052: not set up yet, with its next step (not a problem).
    p.pending(`no relay token yet: this machine sends no mail`, fixCredential, "P027-MAIL-TOKEN");
  } else {
    try {
      await probeSmtp(cred, { relay: site.relay, ipv4: site.ipv4 });
      p.ok(`${host}:${port}: TLS and the API token work (logged in, nothing sent)`);
    } catch (e) {
      const msg = (e as Error).message;
      p.fail(
        `${host}:${port}: ${msg}`,
        /token/.test(msg)
          ? fixCredential
          : `outbound TCP ${port} (the router's firewall); archon doctor's Internet phase`,
      );
    }
  }

  // Postfix, on servers: what apps, cron, and unattended-upgrades send through.
  if (site.role !== "boot" && Deno.build.os === "linux") {
    if (!(await exists("/usr/sbin/postfix"))) {
      p.warn(
        "Postfix is not installed: programs on this host cannot send mail",
        "sudo archon apply",
      );
    } else {
      const active = (await run(["systemctl", "is-active", "postfix.service"])).stdout.trim();
      if (active !== "active") {
        p.fail(`Postfix is ${active}`, "systemctl status postfix; journalctl -u postfix@- -n 50");
      }
      const relayhost = (await run(["postconf", "-h", "relayhost"])).stdout.trim();
      if (relayhost !== `[${host}]:${port}`) {
        p.fail(`Postfix relays to "${relayhost}", not [${host}]:${port}`, "sudo archon apply");
      }
      const q = (await run(["postqueue", "-j"])).stdout.split("\n").filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as { recipients?: Array<{ delay_reason?: string }> };
          } catch {
            return {};
          }
        });
      if (q.length) {
        const reason = q.flatMap((m) => m.recipients ?? []).find((r) => r.delay_reason)
          ?.delay_reason;
        p.warn(
          `Postfix holds ${q.length} message(s)${reason ? `: ${reason}` : ""}`,
          "mailq; sudo postqueue -f retries now; journalctl -t postfix/smtp -n 20",
        );
      } else p.ok(`Postfix: ${active}, relaying to [${host}]:${port}, queue empty`);
    }
  }

  if (o.send && cred) await sendTests(site, o.send, found, p);

  // archon notify's own queue.
  const st = await readStatus(site);
  const n = (await queued(site)).length;
  if (st.lastSend && !st.lastSend.ok) {
    p.warn(
      `archon notify's last send failed (${st.lastSend.at}): ${st.lastSend.error}`,
      "archon notify status; it is retried with backoff",
    );
  }
  if (n) {
    p.warn(
      `${n} archon message(s) waiting${st.oldest ? ` since ${st.oldest}` : ""}`,
      "sudo archon notify flush",
    );
  }
  p.done(
    `${site.to} from ${site.from} via ${host}${
      st.lastSend?.ok ? ` · last sent ${st.lastSend.at.slice(0, 16).replace("T", " ")} UTC` : ""
    }`,
  );
}

/**
 * Mail the doctor's findings to the shared mailbox through each path, so a
 * person sees the result where it matters: archon's own sender (waits for the
 * relay's answer) and, on servers, Postfix (what every program uses).
 */
async function sendTests(
  site: Site,
  reason: string,
  found: string[],
  p: { ok: (m: string) => void; fail: (m: string, fix?: string) => void },
): Promise<void> {
  const report = [
    `${site.name} checked its mail (${reason}) and found:`,
    "",
    ...found,
    "",
    `Sender ${site.from}, relay ${site.relay}, mailbox ${site.to}.`,
  ].join("\n");
  const failed = found.some((l) => l.startsWith("FAIL"));
  const r = await enqueue(site, {
    event: `mail test (${reason})${failed ? ": problems found" : ""}`,
    level: failed ? "warn" : "info",
    what: report,
    todo: failed ? `archon doctor on ${site.name} shows each fix.` : undefined,
  });
  const f = r === "queued" ? await flush(site, { force: true }) : undefined;
  if (f?.sent) p.ok(`test message sent to ${site.to} (archon, ${reason})`);
  else {
    p.fail(
      `the test message was not sent: ${f?.error ?? r}`,
      "archon notify status; it is retried with backoff",
    );
  }
  if (site.role === "boot" || !(await exists("/usr/sbin/sendmail"))) return;
  const msg = [
    "To: root",
    `Subject: [Archon] ${site.name}: mail test via Postfix (${reason})`,
    "",
    "The same check, sent the way every program on this server sends mail (Postfix).",
    "",
    report,
    "",
  ].join("\n");
  const s = await run(["/usr/sbin/sendmail", "-t", "-oi"], { stdin: msg });
  if (s.ok) {
    p.ok(
      `test message handed to Postfix for ${site.to} (journalctl -t postfix/smtp shows the relay's answer)`,
    );
  } else p.fail(`sendmail: ${s.stderr.trim()}`, "systemctl status postfix");
}
