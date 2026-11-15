/**
 * The boot machine's side of outbound mail (specs 025, 027):
 *
 *   bun run stolos boot mail-setup           store the Cloudflare API token (once)
 *   bun run stolos boot mail-push <host>     give a running host the token over SSH
 *   bun run stolos boot notify --subject ... email the mailbox from this PC (also: notify test | status)
 *
 * The token lives only in this PC's secrets folder and, on each server, in
 * Postfix's /etc/postfix/sasl_passwd (root only). It never enters the
 * repository (Article 13).
 *
 * @module
 */

import { proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { readHidden } from "../archon/identity/fleet-init.ts";
import { ui } from "../archon/core/ui.ts";
import { readSecret, SECRETS, writeSecret } from "../archon/core/secrets.ts";
import { loadFleet, loadServers } from "../archon/model/load.ts";
import {
  type Credential,
  DEFAULT_RELAY,
  probeSmtp,
  senderAddress,
} from "../archon/notify/transport.ts";
import { notifyFlush, notifySend, notifyStatus, notifyTest } from "../archon/notify/commands.ts";

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  return args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
}

function opts(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    const next = args[i + 1];
    if (a === `--${name}` && next !== undefined) out.push(next);
    else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3));
  });
  return out;
}

/**
 * `bun run stolos boot mail-setup`: explain the one-time Cloudflare setup, read the
 * API token without echo, test it with an SMTP login (nothing is sent), store
 * it in this PC's secrets, then run the doctor's email checks. Returns the exit
 * code (1 on a missing mail setting, a bad token, or a failed check).
 */
export async function mailSetup(): Promise<number> {
  const fleet = await loadFleet();
  if (!fleet.mail) {
    ui.say(
      'No mail settings: add mail: { to: "<mailbox>", domain: "<sending domain>" } to fleets/<fleet>/fleet.ts first.',
    );
    return 1;
  }
  const { to, domain } = fleet.mail;
  const relay = fleet.mail.relay ?? DEFAULT_RELAY;
  const had = await readSecret(SECRETS.mail);
  // One onboarded domain for the fleet; each machine is a subaddress (root+alpha.lab@...).
  const first = (await loadServers())[0]?.name ?? "alpha";
  ui.say(
    [
      `Mail from every server (and archon's own messages to ${to}) leaves through`,
      `Cloudflare Email Service, from ${senderAddress(fleet.mail, first, "root")} (and so on).`,
      `Once, in the Cloudflare dashboard (the account that holds ${domain}, on the Workers Paid plan):`,
      ``,
      ` 1. Compute > Email Service > Email Sending > Onboard Domain: ${domain}, then Done.`,
      `    Cloudflare adds its records (MX, SPF, DKIM on cf-bounce.${domain}; DMARC on _dmarc.${domain}).`,
      `    New servers need nothing more: the machine is in the address, not the domain.`,
      ` 2. An API token "archon mail" with the permission Account > Email Sending > Edit for this`,
      `    account: Manage Account > Account API Tokens (cfat_..., recommended) or`,
      `    My Profile > API Tokens (cfut_...). Copy it (it is shown once).`,
      ``,
      had ? `(A token is already stored; pasting a new one replaces it.)` : "",
    ]
      .filter((l, i, a) => l || a[i - 1])
      .join("\n"),
  );
  const token = (await readHidden("Cloudflare API token: ")).trim();
  if (!/^\S{20,}$/.test(token)) {
    ui.say("That does not look like an API token. Nothing was stored.");
    return 1;
  }
  const c: Credential = { token, created: new Date().toISOString() };
  ui.say(`Logging in to ${relay} (nothing is sent)...`);
  try {
    await probeSmtp(c, { relay, ipv4: fleet.network?.ipv6 === false });
  } catch (e) {
    ui.say(`${(e as Error).message}. Nothing was stored.`);
    return 1;
  }
  await writeSecret(SECRETS.mail, JSON.stringify(c, null, 2) + "\n");
  ui.say(
    [
      ``,
      `Cloudflare accepted the token. Stored in ${SECRETS.mail} (this PC only, never in git).`,
      `Servers get it at their next install, or now: bun run stolos boot mail-push <host>.`,
      `Anyone with it can send mail from ${domain}. To revoke it: delete "archon mail" where you`,
      `created it (Account API Tokens or My Profile > API Tokens); then run this again and mail-push each server.`,
      ``,
    ].join("\n"),
  );
  // The doctor's email checks, and their findings mailed to the shared mailbox.
  const { emailChecks } = await import("../archon/doctor/email.ts");
  const { bootSite } = await import("../archon/notify/notify.ts");
  const p = ui.phase("Email");
  await emailChecks(bootSite(fleet), p, "bun run stolos boot mail-setup", { send: "mail-setup" });
  return p.level === "fail" ? 1 : 0;
}

/**
 * `bun run stolos boot mail-push <host>`: give a running host the stored mail token
 * over SSH (on stdin to `archon mail credential`). Returns ssh's exit code, 2
 * for an unknown host, or 1 when no token is stored.
 */
export async function mailPush(name: string | undefined): Promise<number> {
  const fleet = await loadFleet();
  const hosts = await loadServers();
  if (!name || !hosts.some((h) => h.name === name)) {
    ui.say(
      `usage: bun run stolos boot mail-push <host>  (known: ${
        hosts.map((h) => h.name).join(", ") || "none"
      })`,
    );
    return 2;
  }
  const cred = await readSecret(SECRETS.mail);
  if (!cred) {
    ui.say("No token on this PC yet: bun run stolos boot mail-setup");
    return 1;
  }
  const target = `${fleet.admin.user}@${name}`;
  // Installing the token runs the doctor's email checks and mails the result.
  const { code } = await proc
    .run(["ssh", "-o", "ConnectTimeout=10", target, "archon mail credential"], {
      input: cred,
      stdout: "inherit",
      stderr: "inherit",
    })
    .catch(() => ({ code: 127 }));
  if (code !== 0) {
    ui.say(`ssh ${target} failed (exit ${code}). Is ${name} up, and can this PC ssh to it?`);
  }
  return code;
}

/** bun run stolos boot notify ... : the same options as archon notify send, or test / status. */
export async function bootNotify(args: string[]): Promise<number> {
  if (args[0] === "test") return await notifyTest();
  if (args[0] === "status") return await notifyStatus({ check: args.includes("--check") });
  if (args[0] === "flush") return await notifyFlush();
  const subject = opt(args, "subject");
  if (!subject) {
    ui.say(
      "usage: bun run stolos boot notify --subject <s> [--body <text> | --body-file <f>] [--attach <file>...] [--level info|warn|fail] [--key <k>]\n" +
        "       bun run stolos boot notify test | status | flush",
    );
    return 2;
  }
  const body = opt(args, "body");
  const bodyFile = opt(args, "body-file");
  const key = opt(args, "key");
  return await notifySend(
    {
      subject,
      ...(body === undefined ? {} : { body }),
      ...(bodyFile === undefined ? {} : { bodyFile }),
      attach: opts(args, "attach"),
      level: (opt(args, "level") ?? "info") as "info" | "warn" | "fail",
      ...(key === undefined ? {} : { key }),
    },
    { wait: true },
  );
}
