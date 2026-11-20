/**
 * Specs 025 and 027 on the boot machine: `stolos boot mail-setup` and `mail-push`, run in a
 * sandbox on a copy of the example lab, with curl and ssh replaced by scripts that record what
 * they were given (so nothing leaves this machine). Spec 026 FR-012: the doctor's email findings
 * are mailed after mail-setup stores a token, and the token is never in the message.
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/system";
import { assert, assertEquals, assertStringIncludes, proves } from "@intellectual-frontiers/test";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { userData } from "../src/archon/render/autoinstall.ts";
import { classify } from "../src/archon/notify/watch.ts";
import { at, fleet, host, list } from "./fixtures.ts";
import { ENGINE_ROOT, linkEngine, type Sandbox, sandbox } from "./sandbox.ts";

const posix = proc.build.os !== "windows";
const TOKEN = "cfat_exampleexampleexampleexample0123456789";

/** curl: its config (stdin) and any message it was asked to upload, kept in $FAKE_LOG; exit $FAKE_CURL. */
const CURL = `#!/bin/sh
c=$(cat "$FAKE_LOG/count" 2>/dev/null || echo 0); c=$((c + 1)); echo "$c" > "$FAKE_LOG/count"
n=$(printf %04d "$c")
cat > "$FAKE_LOG/curl.$n.cfg"
f=$(sed -n 's/^upload-file = "\\(.*\\)"$/\\1/p' "$FAKE_LOG/curl.$n.cfg")
[ -n "$f" ] && cp "$f" "$FAKE_LOG/curl.$n.eml"
[ "\${FAKE_CURL:-0}" = 0 ] || echo "curl: (67) Login denied" >&2
exit \${FAKE_CURL:-0}
`;
/** ssh: its arguments and stdin, kept in $FAKE_LOG. */
const SSH = `#!/bin/sh
echo "$@" > "$FAKE_LOG/ssh.args"
cat > "$FAKE_LOG/ssh.stdin"
`;

type Lab = {
  sb: Sandbox;
  log: string;
  run: (
    args: string[],
    stdin?: string,
    extra?: Record<string, string>,
  ) => ReturnType<Sandbox["run"]>;
  read: (suffix: string) => Promise<string[]>;
};

/** A sandbox with the example lab as its fleet and fake curl and ssh first on PATH. */
async function lab(): Promise<Lab> {
  const sb = await sandbox("archon-025-");
  const repo = path.join(sb.home, "fleet");
  const bin = path.join(sb.home, "bin");
  const log = path.join(sb.home, "log");
  for (const d of [path.join(repo, "fleets"), bin, log]) await fs.mkdir(d, { recursive: true });
  await proc.output([
    "cp",
    "-r",
    path.join(ENGINE_ROOT, "examples/fleets/lab"),
    path.join(repo, "fleets/lab"),
  ]);
  await linkEngine(repo);
  for (const [name, text] of [
    ["curl", CURL],
    ["ssh", SSH],
  ] as const) {
    await fs.writeTextFile(path.join(bin, name), text);
    await fs.chmod(path.join(bin, name), 0o755);
  }
  const env = {
    ARCHON_REPO: repo,
    ARCHON_FLEET: "lab",
    FAKE_LOG: log,
    PATH: `${bin}:${proc.env.get("PATH") ?? ""}`,
  };
  const read = async (suffix: string): Promise<string[]> => {
    const out: string[] = [];
    for (const f of (await fs.listFiles(log)).sort()) {
      if (f.endsWith(suffix)) out.push(await fs.readTextFile(path.join(log, f)));
    }
    return out;
  };
  return {
    sb,
    log,
    read,
    run: (args, stdin = "", extra = {}) =>
      sb.run(path.join(ENGINE_ROOT, "src/stolos/main.ts"), args, stdin, { ...env, ...extra }),
  };
}

/** A MIME message's text/plain part, decoded from base64. */
function plainPart(mail: string): string {
  const start = mail.indexOf("Content-Type: text/plain");
  assert(start >= 0, "a text part");
  const body = mail.slice(mail.indexOf("\r\n\r\n", start) + 4);
  const b64 = body.slice(0, body.indexOf("\r\n\r\n")).replace(/\s/g, "");
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

const mailJson = (sb: Sandbox): string =>
  path.join(sb.home, "config", "stolos", "secrets", "lab", "mail.json");

proves(
  ["025-notify FR-004", "026-doctor FR-012"],
  "025: mail-setup shows the dashboard steps, stores the token only once the relay accepts it, then mails the findings",
  async () => {
    const l = await lab();
    try {
      // Not a token: nothing stored, nothing tried.
      let r = await l.run(["boot", "mail-setup"], "short\n");
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "Nothing was stored");
      assertEquals(await l.read(".cfg"), []);

      // The relay refuses the login: nothing stored.
      r = await l.run(["boot", "mail-setup"], `${TOKEN}\n`, { FAKE_CURL: "67" });
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "Nothing was stored");
      assertEquals(await fs.exists(mailJson(l.sb)), false);

      // Accepted: the two dashboard steps, then the token stored, how to revoke it, the checks.
      await fs.remove(l.log, { recursive: true });
      await fs.mkdir(l.log);
      r = await l.run(["boot", "mail-setup"], `${TOKEN}\n`);
      assertEquals(r.code, 0, r.out);
      for (const s of [
        "Compute > Email Service > Email Sending > Onboard Domain: example.net",
        "cf-bounce.example.net",
        "_dmarc.example.net",
        "New servers need nothing more",
        "Account > Email Sending > Edit",
        "cfat_",
        "cfut_",
        "To revoke it",
      ]) {
        assertStringIncludes(r.out, s);
      }
      assert(!r.out.includes(TOKEN), "the token is not echoed");
      const stored: unknown = JSON.parse(await fs.readTextFile(mailJson(l.sb)));
      assertEquals(at(stored, "token"), TOKEN);

      // The login sent nothing (NOOP), the token on curl's stdin, never in its arguments.
      const cfgs = await l.read(".cfg");
      const [probe] = cfgs;
      assert(probe !== undefined);
      assertStringIncludes(probe, 'url = "smtps://smtp.mx.cloudflare.net:465"');
      assertStringIncludes(probe, `user = "api_token:${TOKEN}"`);
      assertStringIncludes(probe, 'request = "NOOP"');
      assert(!probe.includes("upload-file"));

      // Spec 026 FR-012: then the findings, mailed to the shared mailbox, without the token.
      const mails = await l.read(".eml");
      assertEquals(mails.length, 1, cfgs.join("\n---\n"));
      const [mail = ""] = mails;
      assert(cfgs.some((c) => c.includes('mail-rcpt = "fleet@example.net"')));
      assertStringIncludes(mail, "Subject: [Archon] ");
      assertStringIncludes(mail, "mail test (mail-setup)");
      const text = plainPart(mail);
      assertStringIncludes(text, "checked its mail (mail-setup) and found:");
      assertStringIncludes(text, "ok    smtp.mx.cloudflare.net:465: TLS and the API token work");
      assert(!mail.includes(TOKEN) && !text.includes(TOKEN), "the token is not in the message");
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: posix ? false : "stand-ins for curl and ssh written as POSIX shell scripts" },
);

proves(
  ["025-notify FR-005"],
  "025: a server gets the token with its install (0600) or by mail-push over SSH on stdin",
  async () => {
    // With the install: a root-only file first boot turns into Postfix's sasl_passwd.
    const cred = JSON.stringify({ token: TOKEN, created: "2026-11-11T00:00:00Z" });
    const u = userData(
      { fleet: fleet(), host: host(), base: "http://10.0.0.5:8080/install/alpha/tok/" },
      { passwordHash: "$6$abc$def", mailCredential: cred },
    );
    const files: unknown = JSON.parse(u.slice("#cloud-config\n".length));
    const written = list(at(files, "autoinstall", "user-data", "write_files"));
    const f = written.find((x) => at(x, "path") === "/etc/archon/mail_credential.json");
    assertEquals([at(f, "permissions"), at(f, "content")], ["0600", `${cred}\n`]);

    // Or now, over SSH: `archon mail credential` with the stored credential on stdin.
    const l = await lab();
    try {
      let r = await l.run(["boot", "mail-push", "alpha"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "boot mail-setup");
      await fs.mkdir(path.dirname(mailJson(l.sb)), { recursive: true });
      await fs.writeTextFile(mailJson(l.sb), `${cred}\n`);
      r = await l.run(["boot", "mail-push", "nosuchhost"]);
      assertEquals(r.code, 2, r.out);
      r = await l.run(["boot", "mail-push", "alpha"]);
      assertEquals(r.code, 0, r.out);
      const args = (await fs.readTextFile(path.join(l.log, "ssh.args"))).trim();
      assert(args.endsWith("alice@alpha archon mail credential"), args);
      assert(!args.includes(TOKEN), "the token is not in ssh's arguments");
      assertEquals((await fs.readTextFile(path.join(l.log, "ssh.stdin"))).trim(), cred);
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: posix ? false : "stand-ins for curl and ssh written as POSIX shell scripts" },
);

proves(
  ["025-notify FR-011"],
  "025: verify warns (never fails) when mail is not configured, the last send failed, or a message waits over 6 hours",
  async () => {
    // The check verify runs on a server: a warning, "not set up yet" without the token.
    const plan = resolvePlan(
      host(),
      fleet({ mail: { to: "fleet@example.net", domain: "example.net", tag: "lab" } }),
    );
    const c = plan.checks.find((x) => x.name === "notify:ok");
    assertEquals(c?.level, "warn");
    assertEquals(
      c?.command,
      "sh -c 'test -s /etc/postfix/sasl_passwd || exit 3; archon notify status --check'",
    );

    // What `notify status --check` answers (here the boot machine's, the same function).
    const l = await lab();
    try {
      const dir = path.join(l.sb.home, "data", "stolos", "notify");
      const status = (s: object) =>
        fs.writeTextFile(path.join(dir, "status.json"), JSON.stringify(s));
      const check = () => l.run(["boot", "notify", "status", "--check"]);
      let r = await check();
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "mail is not configured");

      await fs.mkdir(path.dirname(mailJson(l.sb)), { recursive: true });
      await fs.writeTextFile(mailJson(l.sb), JSON.stringify({ token: TOKEN, created: "" }));
      await fs.mkdir(dir, { recursive: true });
      r = await check();
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "notifications ok");

      const at = new Date().toISOString();
      await status({
        configured: true,
        queue: 0,
        lastSend: { at, ok: false, subject: "s", error: "relay refused" },
      });
      r = await check();
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "the last send failed: relay refused");

      // A message waiting since 7 hours ago; 5 hours is not yet stuck.
      const old = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
      const q = {
        id: "1-0000abcd",
        created: old(7),
        subject: "s",
        text: "",
        html: "",
        level: "info",
      };
      await fs.writeTextFile(path.join(dir, "1-0000abcd.json"), JSON.stringify(q));
      await status({ configured: true, queue: 1, oldest: old(5) });
      r = await check();
      assertEquals(r.code, 0, r.out);
      await status({ configured: true, queue: 1, oldest: old(7) });
      r = await check();
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "1 message(s) waiting for more than 6 hours");
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: posix ? false : "stand-ins for curl and ssh written as POSIX shell scripts" },
);

proves(
  ["025-notify FR-013"],
  "025: the watcher adds nothing to sshd, PAM, or auditd, and does not report sudo's successes",
  () => {
    const plan = resolvePlan(
      host(),
      fleet({ mail: { to: "fleet@example.net", domain: "example.net", tag: "lab" } }),
    );
    const notify = plan.files.filter((f) => f.spec === "025-notify").map((f) => f.path);
    for (const p of notify) {
      assert(!/^\/etc\/(pam\.d|ssh|audit|sudoers)|^\/usr\/share\/pam-configs/.test(p), p);
    }
    assert(!plan.packages.some((p) => /audit/.test(p.name)), "no auditd");
    // sshd logs as Ubuntu has it (no LogLevel of Archon's).
    const sshd = plan.files.find((f) => f.path === "/etc/ssh/sshd_config.d/50-archon.conf");
    assert(sshd?.content !== undefined && !/LogLevel/i.test(sshd.content));
    // It reads the journal: archon notify watch, following journald.
    const unit = plan.units.find((u) => u.unitName === "archon-notify-watch.service");
    assert(unit?.content?.includes("ExecStart=/usr/local/bin/archon notify watch"));
    // A sudo success is no event; a refusal is.
    const J = (SYSLOG_IDENTIFIER: string, MESSAGE: string) => ({ SYSLOG_IDENTIFIER, MESSAGE });
    assertEquals(
      classify(
        J("sudo", "    ops : PWD=/srv/archon ; USER=root ; COMMAND=/usr/local/bin/archon apply"),
      ),
      undefined,
    );
    assertEquals(
      classify(
        J("sudo", "pam_unix(sudo:session): session opened for user root(uid=0) by ops(uid=999)"),
      ),
      undefined,
    );
    assertEquals(
      classify(
        J(
          "sudo",
          "    alice : 3 incorrect password attempts ; TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/bin/bash",
        ),
      )?.kind,
      "sudo-refused",
    );
  },
);
