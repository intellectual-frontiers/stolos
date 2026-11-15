/**
 * Spec 025: archon notify. Messages are built, redacted, queued, deduplicated,
 * collapsed, and sent through a fake transport; the watcher's journal parsing.
 *
 * @module
 */

import { fs } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  test,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { buildMime } from "../src/archon/notify/mime.ts";
import { redact } from "../src/archon/notify/redact.ts";
import {
  collapse,
  compose,
  enqueue,
  flush,
  type Queued,
  queued,
  sendDeps,
  type Site,
} from "../src/archon/notify/notify.ts";
import { applyTransition } from "../src/archon/notify/events.ts";
import { classify, eventFor, failedSummary, inNetworks } from "../src/archon/notify/watch.ts";
import { parseArgs } from "../src/archon/core/registry-types.ts";
import { COMMANDS as commands } from "../src/archon/commands/registry.ts";

const SECRET = {
  token: "cfat_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
  created: "2026-11-11T00:00:00Z",
};
/** Another token shape (a legacy token without the cfat_ prefix): only exact redaction catches it. */
const PLAIN_TOKEN = "Zx9yW8vU7tS6rQ5pO4nM3lK2jI1hG0fEdCbA";

async function site(): Promise<Site> {
  const dir = await fs.makeTempDir({ prefix: "archon-notify-test-" });
  const credential = `${dir}/cred.json`;
  await fs.writeTextFile(credential, JSON.stringify(SECRET));
  return {
    role: "boot",
    name: "alpha",
    credential,
    spool: `${dir}/spool`,
    status: `${dir}/status.json`,
    to: "box@example.com",
    from: "server-alpha@example.org",
    relay: "smtp.mx.cloudflare.net:465",
    ipv4: true,
    timezone: "America/New_York",
  };
}

function fakeRelay() {
  const sent: string[] = [];
  let fail: string | undefined;
  const real = { ...sendDeps };
  sendDeps.smtp = (_c, _o, mime) => {
    if (fail) return Promise.reject(new Error(fail));
    sent.push(mime);
    return Promise.resolve("id");
  };
  return {
    sent,
    failWith: (e?: string) => (fail = e),
    restore: () => Object.assign(sendDeps, real),
  };
}

proves(["025-notify FR-008"], "mime: subject, from, both parts, and a base64 attachment", () => {
  const m = buildMime(
    {
      from: "server-alpha@example.org",
      to: "box@example.com",
      subject: "[Archon] alpha: ✓ Ready",
      text: "hello",
      html: "<p>hello</p>",
      attachments: [
        {
          name: "installed.json",
          type: "application/json",
          data: new TextEncoder().encode('{"ok":true}'),
        },
      ],
    },
    "00000000-0000-0000-0000-000000000000",
  );
  assert(m.includes("From: server-alpha@example.org"));
  assert(/Subject: =\?UTF-8\?B\?/.test(m), "a non-ASCII subject is encoded");
  assert(m.includes("text/plain") && m.includes("text/html"));
  assert(m.includes('filename="installed.json"') && m.includes(btoa('{"ok":true}')));
});

proves(["025-notify FR-009"], "redact: no secret survives", () => {
  const cfToken = "cfut_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210";
  const text = [
    `token: ${SECRET.token}`,
    `[smtp.mx.cloudflare.net]:465 api_token:${PLAIN_TOKEN}`,
    `curl --user api_token:x ${cfToken}`,
    "Authorization: Bearer ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxx",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz",
    "admin:$6$rounds=4096$saltsalt$hashhashhashhash:19000",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "my-exact-secret-value",
  ].join("\n");
  const out = redact(text, ["my-exact-secret-value"]);
  for (const s of [
    SECRET.token,
    PLAIN_TOKEN,
    cfToken,
    "ya29.a0AfH6",
    "ghp_abc",
    "sk-ant-oat01",
    "$6$rounds",
    "AAAA",
    "my-exact-secret-value",
  ]) {
    assert(!out.includes(s), `leaked: ${s}`);
  }
});

proves(
  ["025-notify FR-009"],
  "compose: the credential's own secrets are redacted from messages and attachments",
  async () => {
    const s = await site();
    const log = `${s.spool}.log`;
    await fs.writeTextFile(log, `password ${PLAIN_TOKEN}\nok\n`);
    const q = await compose(
      s,
      {
        event: "test",
        what: `leaked ${PLAIN_TOKEN}`,
        attach: [log],
      },
      [PLAIN_TOKEN],
    );
    assertEquals(q.subject, "[Archon] alpha: test");
    assert(!q.text.includes(PLAIN_TOKEN));
    assert(!atob(must(q.attachments[0]).b64).includes(PLAIN_TOKEN));
  },
);

proves(
  ["025-notify FR-010"],
  "enqueue: the same key within an hour is sent once; not configured never throws",
  async () => {
    const s = await site();
    assertEquals(await enqueue(s, { event: "a", what: "x", key: "k1" }), "queued");
    assertEquals(await enqueue(s, { event: "a", what: "x", key: "k1" }), "duplicate");
    assertEquals(await enqueue(s, { event: "b", what: "x", key: "k2" }), "queued");
    assertEquals((await queued(s)).length, 2);
    assertEquals(
      await enqueue({ ...s, credential: `${s.spool}/missing` }, { event: "c", what: "x" }),
      "not configured",
    );
  },
);

proves(["025-notify FR-010"], "collapse: five or more old messages become one summary", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const q = (i: number, created: string): Queued => ({
    id: String(i),
    created,
    subject: `[Archon] alpha: event ${i}`,
    text: "",
    html: "",
    level: i === 2 ? "fail" : "info",
    attachments: [],
    attempts: 3,
    nextAt: created,
  });
  const old = [0, 1, 2, 3, 4].map((i) => q(i, "2026-11-11T08:00:00Z"));
  const r = collapse([...old, q(9, "2026-11-11T11:59:00Z")], now);
  assertEquals(r.drop.length, 5);
  assertEquals(
    r.summary?.subject,
    "[Archon] alpha: 5 messages were queued while mail could not be sent",
  );
  assertEquals(r.summary?.level, "fail");
  assertEquals(collapse(old.slice(0, 4), now).drop.length, 0);
});

proves(
  ["025-notify FR-010"],
  "flush: a failure keeps the message with backoff; the next flush sends it",
  async () => {
    const s = await site();
    const g = fakeRelay();
    try {
      await enqueue(s, { event: "x", what: "y" });
      g.failWith("421 Service temporarily unavailable");
      const a = await flush(s);
      assertEquals([a.sent, a.failed], [0, 1]);
      assertEquals((await queued(s))[0]?.q.attempts, 1);
      g.failWith(undefined);
      assertEquals((await flush(s)).sent, 0, "waits for its backoff");
      assertEquals((await flush(s, { force: true })).sent, 1);
      assertEquals((await queued(s)).length, 0);
    } finally {
      g.restore();
    }
  },
);

proves(
  ["025-notify FR-007"],
  "apply: a forced failure sends exactly one 'failing' and one 'recovered'",
  () => {
    const t0 = Date.parse("2026-11-11T10:00:00Z");
    const at = (min: number) => new Date(t0 + min * 60_000);
    let state: ReturnType<typeof applyTransition>["next"] | undefined;
    const sends: string[] = [];
    // ok, then four failing reconciles 15 minutes apart, then ok twice.
    for (const [min, ok] of [
      [0, true],
      [15, false],
      [30, false],
      [45, false],
      [60, false],
      [75, true],
      [90, true],
    ] as const) {
      const r = applyTransition(state, ok, at(min));
      state = r.next;
      if (r.send) sends.push(r.send);
    }
    assertEquals(sends, ["failing", "recovered"]);
    // Failing for more than a day: one reminder.
    const f = applyTransition(undefined, false, at(0)).next;
    assertEquals(applyTransition(f, false, at(60 * 25)).send, "still failing");
  },
);

proves(["025-notify FR-006"], "notify send: --attach is repeatable", () => {
  const cmd = must(commands.find((c) => c.name === "notify send"));
  const a = parseArgs(cmd, ["--subject", "s", "--attach", "a.html", "--attach", "b.txt"]);
  assertEquals(String(a["attach"]).split("\n"), ["a.html", "b.txt"]);
});

// ------------------------------------------------------------- the watcher

const J = (SYSLOG_IDENTIFIER: string, MESSAGE: string, extra: Record<string, string> = {}) => ({
  SYSLOG_IDENTIFIER,
  MESSAGE,
  ...extra,
});
const LOCAL = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];

proves(["025-notify FR-012"], "watch: sshd logins, failures, and invalid users", () => {
  assertEquals(
    classify(
      J(
        "sshd-session",
        "Accepted publickey for alice from 10.0.1.157 port 50122 ssh2: ED25519 SHA256:abcDEF123",
      ),
    ),
    {
      kind: "login",
      method: "publickey",
      user: "alice",
      from: "10.0.1.157",
      key: "ED25519 SHA256:abcDEF123",
    },
  );
  assertEquals(
    classify(J("sshd", "Accepted password for alice from 10.1.2.3 port 1 ssh2"))?.kind,
    "login",
  );
  assertEquals(
    classify(
      J("sshd-session", "Failed password for invalid user admin from 203.0.113.9 port 4242 ssh2"),
    ),
    { kind: "login-failed", invalidUser: true, user: "admin", from: "203.0.113.9" },
  );
  assertEquals(
    classify(J("sshd", "Invalid user oracle from 203.0.113.9 port 55"))?.kind,
    "login-failed",
  );
  assertEquals(classify(J("sshd", "Received disconnect from 1.2.3.4 port 1:11: bye")), undefined);
});

proves(["025-notify FR-012"], "watch: sudo refusals, su, console, accounts, kernel, units", () => {
  assertEquals(
    classify(
      J(
        "sudo",
        "    alice : 3 incorrect password attempts ; TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/bin/bash",
      ),
    )?.kind,
    "sudo-refused",
  );
  assertEquals(
    classify(
      J(
        "sudo",
        "    alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/local/bin/archon apply",
      ),
    ),
    undefined,
  );
  assertEquals(
    classify(
      J("su", "pam_unix(su:session): session opened for user root(uid=0) by alice(uid=1000)"),
    ),
    { kind: "su", user: "root", by: "alice" },
  );
  assertEquals(
    classify(
      J(
        "login",
        "pam_unix(login:session): session opened for user alice(uid=1000) by LOGIN(uid=0)",
      ),
    )?.kind,
    "console",
  );
  assertEquals(
    classify(
      J(
        "useradd",
        "new user: name=eve, UID=1002, GID=1002, home=/home/eve, shell=/bin/bash, from=/dev/pts/0",
      ),
    )?.kind,
    "account",
  );
  assertEquals(
    classify({
      _TRANSPORT: "kernel",
      MESSAGE: "Out of memory: Killed process 1234 (bun) total-vm:1kB",
    })?.kind,
    "kernel",
  );
  assertEquals(
    classify({ _TRANSPORT: "kernel", MESSAGE: "EXT4-fs error (device sda2): ext4_find_entry:1455" })
      ?.kind,
    "kernel",
  );
  assertEquals(
    classify(
      J("systemd", "pmlogger.service: Failed with result 'exit-code'.", {
        UNIT: "pmlogger.service",
      }),
    )?.kind,
    "unit-failed",
  );
  assertEquals(
    classify(
      J("systemd", "archon-reconcile.service: Failed with result 'exit-code'.", {
        UNIT: "archon-reconcile.service",
      }),
    ),
    undefined,
  );
});

proves(["025-notify FR-012"], "watch: login messages say who, from where, and how loud", () => {
  const ctx = {
    host: "alpha",
    local: LOCAL,
    seen: { alice: ["10.0.1.157"] },
    keyNames: { "SHA256:abc": "alice@bootpc" },
  };
  const known = must(
    eventFor(
      {
        kind: "login",
        user: "alice",
        from: "10.0.1.157",
        method: "publickey",
        key: "ED25519 SHA256:abc",
      },
      ctx,
    ),
  );
  assertEquals(known.level, "info");
  assert(known.what.includes("alice@bootpc") && known.what.includes("a local network"));
  const fresh = must(
    eventFor({ kind: "login", user: "alice", from: "10.0.1.200", method: "password" }, ctx),
  );
  assertEquals(fresh.level, "warn");
  const outside = must(
    eventFor(
      {
        kind: "login",
        user: "alice",
        from: "198.51.100.7",
        method: "publickey",
      },
      ctx,
    ),
  );
  assertEquals(outside.level, "warn");
  assert(outside.event.includes("outside the local networks"));
  assertEquals(
    must(eventFor({ kind: "login", user: "root", from: "10.0.1.157", method: "publickey" }, ctx))
      .level,
    "fail",
  );
});

proves(["025-notify FR-012"], "watch: failed logins become one summary by address", () => {
  const ev = must(
    failedSummary(
      "alpha",
      {
        "203.0.113.9": {
          count: 40,
          users: ["root", "admin"],
          first: "2026-11-11T10:00:00Z",
          last: "2026-11-11T10:40:00Z",
        },
        "10.0.1.157": {
          count: 1,
          users: ["alice"],
          first: "2026-11-11T10:05:00Z",
          last: "2026-11-11T10:05:00Z",
        },
      },
      LOCAL,
    ),
  );
  assertEquals(ev.event, "⚠ 41 failed SSH logins from 2 addresses");
  assert(ev.what.indexOf("203.0.113.9") < ev.what.indexOf("10.0.1.157"));
  assert(ev.what.includes("outside the local networks"));
  assertEquals(failedSummary("alpha", {}, LOCAL), undefined);
});

test("watch: local networks", () => {
  assert(inNetworks("10.0.30.57", LOCAL));
  assert(inNetworks("::ffff:10.1.1.1", LOCAL));
  assert(inNetworks("fd12::1", LOCAL));
  assert(!inNetworks("198.51.100.7", LOCAL));
  assert(!inNetworks("172.32.0.1", LOCAL));
});

// ------------------------------------------------- the relay (spec 027)

import {
  parseSaslPasswd,
  saslPasswd,
  smtpConfig,
  smtpError,
} from "../src/archon/notify/transport.ts";
import { mainCf, recipientMap, senderMap } from "../src/archon/capabilities/mail.ts";
import { missingRecords } from "../src/archon/doctor/email.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { fleet, host } from "./fixtures.ts";
import { must } from "./console/tree.ts";

proves(
  ["025-notify FR-002"],
  "relay: curl's config carries the token (stdin), Cloudflare's endpoint, IPv4",
  () => {
    const c = smtpConfig(SECRET, {
      ipv4: true,
      from: "server-alpha@lab.example",
      to: "box@example.com",
      file: "/tmp/m.eml",
    });
    assert(c.includes('url = "smtps://smtp.mx.cloudflare.net:465"'));
    assert(c.includes(`user = "api_token:${SECRET.token}"`));
    assert(c.includes("ssl-reqd") && c.includes("\nipv4\n"));
    assert(c.includes('mail-rcpt = "box@example.com"') && c.includes('upload-file = "/tmp/m.eml"'));
    // Without a message: log in and NOOP, nothing sent.
    const probe = smtpConfig(SECRET, { ipv4: false });
    assert(probe.includes('request = "NOOP"') && !probe.includes("mail-from"));
    assert(smtpError(67, "curl: (67) Login denied").includes("refused the API token"));
    assert(smtpError(55, "curl: (55) MAIL failed: 550").includes("onboarded for Email Sending"));
  },
);

proves(["027-mail FR-005"], "relay: Postfix's sasl_passwd round trip, root-only content", () => {
  const text = saslPasswd(SECRET);
  assert(text.includes(`[smtp.mx.cloudflare.net]:465 api_token:${SECRET.token}`));
  assertEquals(parseSaslPasswd(text)?.token, SECRET.token);
  assertEquals(parseSaslPasswd("# nothing\n"), undefined);
});

proves(
  ["027-mail FR-002", "027-mail FR-003", "027-mail FR-004"],
  "mail: Postfix is a send-only null client relaying to Cloudflare",
  () => {
    const f = fleet({
      mail: { to: "box@example.com", domain: "example.net", tag: "lab" },
      network: { ipv6: false },
    });
    const h = host();
    const cf = mainCf(f, h);
    for (const line of [
      "relayhost = [smtp.mx.cloudflare.net]:465",
      "smtp_tls_wrappermode = yes",
      "smtp_tls_security_level = secure",
      "smtp_sasl_auth_enable = yes",
      "smtp_sasl_password_maps = texthash:/etc/postfix/sasl_passwd",
      "inet_interfaces = loopback-only",
      "inet_protocols = ipv4",
      "mydestination =",
      "local_transport = error:local delivery is disabled",
      `myorigin = ${h.name}.lab.example.net`,
      `myhostname = ${h.name}.lab.example.net`,
    ])
      assert(cf.split("\n").includes(line), line);
    // Senders: the user kept, any old subaddress dropped, the host as the subaddress (checked
    // with Postfix's postmap -q too; JavaScript and Postfix's regexp agree on this pattern).
    const sm = must(senderMap(f, h).split("\n")[1]);
    const [spat, srepl] = [sm.slice(1, sm.lastIndexOf("/")), sm.slice(sm.lastIndexOf("/") + 2)];
    const rewrite = (a: string): string => a.replace(new RegExp(spat), srepl.replace("${1}", "$1"));
    assertEquals(rewrite("root@alpha"), `root+${h.name}.lab@example.net`);
    assertEquals(rewrite("www-data"), `www-data+${h.name}.lab@example.net`);
    assertEquals(rewrite("app+old@example.com"), `app+${h.name}.lab@example.net`);
    assertEquals(rewrite(rewrite("root@alpha")), rewrite("root@alpha"));
    const r = must(recipientMap(f, h).split("\n")[1]);
    const [pattern, target] = [r.slice(1, r.lastIndexOf("/")), r.split(" ").pop()];
    const rx = new RegExp(pattern);
    assertEquals(target, "box@example.com");
    for (const a of [
      "root@localhost",
      `ops@${h.name}`,
      `root@${h.name}.localdomain`,
      `root@${h.name}.lab.example.net`,
    ]) {
      assert(rx.test(a), a);
    }
    assert(!rx.test("someone@example.com"));
    // A real address at the sending domain is relayed as written, not swallowed.
    assert(!rx.test("someone@example.net"));
    assert(!rx.test("root+alpha.lab@example.net"));
    // The plan: postfix preseeded with No configuration, SASL modules, the unit, the files.
    const plan = resolvePlan(h, f);
    const pf = must(plan.packages.find((p) => p.name === "postfix"));
    assertEquals(pf.debconf, ["postfix postfix/main_mailer_type select No configuration"]);
    assert(plan.packages.some((p) => p.name === "libsasl2-modules"));
    assert(plan.files.some((x) => x.path === "/etc/postfix/main.cf"));
    assert(plan.units.some((u) => u.unitName === "postfix.service" && u.state === "enabled"));
    // Without mail in the model: no Postfix at all.
    assert(!resolvePlan(h, fleet()).packages.some((p) => p.name === "postfix"));
  },
);

proves(
  ["025-notify FR-003"],
  "mail: the domain's records, as Cloudflare's onboarding creates them",
  () => {
    const ok = {
      spf: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
      dkim: ["v=DKIM1; h=sha256; k=rsa; p=MIIB..."],
      dmarc: ["v=DMARC1; p=reject;"],
      mx: ["route1.mx.cloudflare.net", "route2.mx.cloudflare.net"],
    };
    assertEquals(missingRecords("lab.example.net", ok), []);
    assertEquals(
      missingRecords("lab.example.net", { spf: [], dkim: [], dmarc: [], mx: [] }).length,
      4,
    );
  },
);

proves(["025-notify FR-012"], "watch: Postfix bounces become a warning; deferrals do not", () => {
  assertEquals(
    classify({
      SYSLOG_IDENTIFIER: "postfix/smtp",
      MESSAGE:
        "4F2A31C0A: to=<box@example.com>, relay=smtp.mx.cloudflare.net[104.30.0.1]:465, delay=1, delays=0/0/0.5/0.5, dsn=5.7.1, status=bounced (host smtp.mx.cloudflare.net[104.30.0.1] said: 550 5.7.1 Sender denied (in reply to MAIL FROM command))",
    }),
    {
      kind: "mail-bounced",
      to: "box@example.com",
      detail:
        "host smtp.mx.cloudflare.net[104.30.0.1] said: 550 5.7.1 Sender denied (in reply to MAIL FROM command)",
    },
  );
  assertEquals(
    classify({
      SYSLOG_IDENTIFIER: "postfix/smtp",
      MESSAGE:
        "4F2A31C0A: to=<box@example.com>, relay=none, delay=30, status=deferred (connect timed out)",
    }),
    undefined,
  );
});

proves(
  ["025-notify FR-001", "027-mail FR-004"],
  "mail: archon's senders, display name, and Reply-To",
  async () => {
    const { senderAddress } = await import("../src/archon/notify/transport.ts");
    const m = { domain: "example.net", tag: "lab" };
    assertEquals(senderAddress(m, "alpha", "root"), "root+alpha.lab@example.net");
    assertEquals(senderAddress(m, "bootpc", "alice"), "alice+bootpc.lab@example.net");
    assertEquals(
      senderAddress({ domain: "example.net" }, "alpha", "root"),
      "root+alpha@example.net",
    );
    const mime = buildMime({
      from: "root+alpha.lab@example.net",
      fromName: "alpha (Archon)",
      to: "box@example.com",
      subject: "s",
      text: "t",
      html: "h",
      headers: { "Reply-To": "box@example.com" },
    });
    assert(mime.includes('From: "alpha (Archon)" <root+alpha.lab@example.net>'));
    assert(mime.includes("Reply-To: box@example.com"));
  },
);

test("doctor --send: the email findings are mailed to the shared mailbox", async () => {
  const { emailChecks } = await import("../src/archon/doctor/email.ts");
  const { ui } = await import("../src/archon/core/ui.ts");
  const s = await site();
  const g = fakeRelay();
  ui.quiet = true;
  try {
    await emailChecks(s, ui.phase("Email"), "fix", { send: "mail-setup" });
    assertEquals(g.sent.length, 1);
    const sent = must(g.sent[0]);
    const text = decodeParts(sent);
    assert(text.includes("alpha checked its mail (mail-setup) and found:"), text);
    assert(/(ok|WARN|FAIL) {2,}/.test(text), "each finding is listed");
    assert(!text.includes(SECRET.token), "the token is never in the message");
    assert(/Subject: .*mail test/.test(sent) || sent.includes("Subject: =?UTF-8?B?"));
  } finally {
    g.restore();
    ui.quiet = false;
  }
});

/** The base64 text parts of a MIME message, decoded. */
function decodeParts(mime: string): string {
  return [...mime.matchAll(/base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)]
    .map((m) =>
      new TextDecoder().decode(
        Uint8Array.from(atob((m[1] ?? "").replace(/\r\n/g, "")), (c) => c.charCodeAt(0)),
      ),
    )
    .join("\n");
}

test("025: an SMTP failure says which step, what was tried, the server's answer, and the fix", async () => {
  const { smtpError } = await import("../src/archon/notify/transport.ts");
  const ctx = { from: "ops+alpha.lab@example.net", to: "<the shared mailbox>" };
  let m = smtpError(55, "curl: (55) RCPT failed: 500", ctx);
  assertStringIncludes(m, 'refused the recipient "<the shared mailbox>" (the server answered 500)');
  assertStringIncludes(m, "not an email address");
  assertStringIncludes(m, "fleet.mail.to");
  m = smtpError(55, "curl: (55) RCPT failed: 550", { ...ctx, to: "fleet@example.net" });
  assertStringIncludes(m, "refused the recipient fleet@example.net");
  assertStringIncludes(m, "typo");
  m = smtpError(55, "curl: (55) MAIL failed: 550", ctx);
  assertStringIncludes(m, "refused the sender ops+alpha.lab@example.net");
  assertStringIncludes(m, "example.net onboarded");
  m = smtpError(67, "curl: (67) Login denied", ctx);
  assertStringIncludes(m, "refused the API token");
  m = smtpError(7, "curl: (7) Failed to connect", ctx);
  assertStringIncludes(m, "outbound port 465");
});

test("025: build refuses a mailbox that is not an address (a placeholder left in)", async () => {
  const { fleet } = await import("./fixtures.ts");
  const { validateFleet } = await import("../src/archon/model/validate.ts");
  const f = fleet();
  const bad = { ...f, mail: { domain: "example.net", ...f.mail, to: "<the shared mailbox>" } };
  const p = validateFleet(bad, []).find((x) => x.where === "fleet.mail.to");
  assert(p, "a problem for fleet.mail.to");
  assertStringIncludes(p.message, "still a placeholder?");
  assert(!validateFleet(f, []).some((x) => x.where === "fleet.mail.to"), "a real address passes");
});
