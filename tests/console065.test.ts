/**
 * Spec 065: the Archon Console's foundations: escaped HTML, sessions, roles, and the sign-in throttle.
 * Spec 096 FR-010: the password check through PAM on `bun:ffi`, in a worker, and refused on Node.
 *
 * @module
 */

import { errors, fs, path, proc } from "@intellectual-frontiers/system";
import { assert, assertEquals, assertRejects, proves, test } from "@intellectual-frontiers/test";
import {
  answerFor,
  cstr,
  PAM_UNSUPPORTED,
  pamAuthenticator,
  pamReply,
  pamRequest,
  pamSupported,
  pamWorkerUrl,
  pointerBytes,
} from "../src/archon/console/pam.ts";
import { passwordMatches } from "../src/archon/console/server.ts";
import { esc, html, raw } from "../src/archon/console/html.ts";
import {
  cookieOf,
  IDLE_MS,
  mayRun,
  roleOf,
  sessionCookie,
  Sessions,
  Throttle,
  USERNAME,
} from "../src/archon/console/auth.ts";
import { must } from "./console/tree.ts";

test("065: html escapes every value, but not Html or raw()", () => {
  const evil = `<script>alert("x")</script>&'`;
  assertEquals(
    html`<p title="${evil}">${evil}</p>`.s,
    `<p title="${esc(evil)}">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;</p>`,
  );
  const items = ["a", "<b>"].map((x) => html`<li>${x}</li>`);
  // Under another name, so that the formatter (which formats html`...` as HTML) keeps the text as it is.
  const tag = html;
  assertEquals(tag`<ul>${items}</ul>`.s, "<ul><li>a</li><li>&lt;b&gt;</li></ul>");
  assertEquals(html`${raw("<hr>")}${undefined}${false}${null}`.s, "<hr>");
});

test("065: operators change the server; everyone else looks", () => {
  assertEquals(roleOf(["alice", "sudo"]), "operator");
  assertEquals(roleOf(["alice", "archon-ops"]), "operator");
  assertEquals(roleOf(["bob", "users"]), "viewer");
  assert(
    mayRun("viewer", "read") && !mayRun("viewer", "mutate") && !mayRun("viewer", "destructive"),
  );
  assert(mayRun("operator", "mutate") && mayRun("operator", "destructive"));
  assert(!mayRun("operator", "repo"), "repository commands belong on the PC");
  assert(USERNAME.test("alice") && !USERNAME.test("-rf") && !USERNAME.test("a b"));
});

test("065: a session ends after 8 idle hours; the cookie is HttpOnly, Secure, SameSite=Strict", () => {
  let t = 0;
  const s = new Sessions(() => t);
  const a = s.create({ user: "alice", name: "Alice Example", groups: ["sudo"] }, "10.0.0.5");
  assertEquals(s.get(a.id)?.role, "operator");
  t += IDLE_MS - 1;
  assert(s.get(a.id), "still used");
  t += IDLE_MS + 1;
  assertEquals(s.get(a.id), undefined, "idle too long");
  const b = s.create({ user: "bob", name: "bob", groups: [] }, "x");
  s.end(b.id);
  assertEquals(s.get(b.id), undefined);
  const c = sessionCookie(a);
  assert(/HttpOnly/.test(c) && /Secure/.test(c) && /SameSite=Strict/.test(c), c);
  assertEquals(cookieOf(`x=1; archon_session=${a.id}; y=2`, "archon_session"), a.id);
  assert(/Max-Age=0/.test(sessionCookie(undefined)));
});

test("065: five failed sign-ins in a minute pause that address", () => {
  let t = 0;
  const th = new Throttle(() => t);
  for (let i = 0; i < 5; i++) {
    assert(th.allowed("1.2.3.4"));
    th.failed("1.2.3.4");
  }
  assert(!th.allowed("1.2.3.4"), "paused");
  assert(th.allowed("5.6.7.8"), "only that address");
  t += 60_001;
  assert(th.allowed("1.2.3.4"), "a minute later");
});

test("065: Datastar is served from the engine, exactly the pinned file", async () => {
  const { DATASTAR, datastarSource } = await import("../src/archon/console/assets.ts");
  const bytes = new TextEncoder().encode(datastarSource());
  const d = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(hex, DATASTAR.sha256);
  assert(datastarSource().startsWith("// Datastar v1.0.4"));
});

test("065: a form becomes one command's argument list: no shell, no smuggled options", async () => {
  const { argvFor, consoleCommands } = await import("../src/archon/console/forms.ts");
  const offered = consoleCommands("machine").map((c) => c.name);
  assert(offered.includes("verify") && offered.includes("pg on") && offered.includes("reboot"));
  for (const hidden of ["pg connect", "mcp", "web serve", "console exec", "host-keys export"]) {
    assert(!offered.includes(hidden), hidden);
  }
  const cmd = (n: string) => must(consoleCommands("machine").find((c) => c.name === n));
  assertEquals(argvFor(cmd("pg on"), { durable: "on" }), {
    argv: ["pg", "on", "--durable"],
    args: { durable: true },
    tier: "mutate",
  });
  const r = argvFor(cmd("pg status"), { name: "prime; rm -rf /" });
  assert(
    "argv" in r && r.argv.length === 3 && r.argv[2] === "prime; rm -rf /",
    "one argument, never a shell",
  );
  assert("error" in argvFor(cmd("pg status"), { name: "--all" }), "a value may not be an option");
  assert("error" in argvFor(cmd("pg status"), { name: "a\nb" }), "one line");
  const upd = argvFor(cmd("update"), { check: "on" });
  assert("tier" in upd && upd.tier === "read", "--check makes it read-only");
});

test("065: console exec serves only the console, and checks the person again", async () => {
  const { execRefusal } = await import("../src/archon/console/exec.ts");
  const accounts = (u: string) =>
    Promise.resolve(
      u === "alice"
        ? { user: "alice", name: "Alice", groups: ["alice", "sudo"] }
        : u === "bob"
          ? { user: "bob", name: "Bob", groups: ["bob"] }
          : undefined,
    );
  const ok = { sudoUser: "archon-console", as: "alice", argv: ["verify"] };
  assertEquals(await execRefusal(ok, accounts), undefined);
  assert(
    /only the Archon Console/.test(
      must(await execRefusal({ ...ok, sudoUser: "mallory" }, accounts)),
    ),
  );
  assert(/no such person/.test(must(await execRefusal({ ...ok, as: "carol" }, accounts))));
  assertEquals(await execRefusal({ ...ok, as: "bob" }, accounts), undefined, "anyone may look");
  assert(
    /may not run reboot/.test(
      must(await execRefusal({ ...ok, as: "bob", argv: ["reboot"] }, accounts)),
    ),
  );
  assertEquals(
    await execRefusal({ ...ok, argv: ["reboot"] }, accounts),
    undefined,
    "an operator may",
  );
  assert(
    /not a command the console runs/.test(
      must(await execRefusal({ ...ok, argv: ["host-keys", "export"] }, accounts)),
    ),
  );
  assert(
    /not a command the console runs/.test(
      must(await execRefusal({ ...ok, argv: ["mcp"] }, accounts)),
    ),
  );
});

// ------------------------------------------------------------------- PAM (spec 096 FR-010)

proves(
  ["096-bun-runtime FR-010"],
  "096: PAM's arguments and the worker's messages are marshalled as libpam and the console expect",
  () => {
    assertEquals([...cstr("alice")], [97, 108, 105, 99, 101, 0], "a C string ends in NUL");
    assertEquals(answerFor(1, "alice", "pw"), "pw", "a hidden prompt gets the password");
    assertEquals(answerFor(2, "alice", "pw"), "alice", "a visible prompt gets the username");
    assertEquals(answerFor(3, "alice", "pw"), undefined, "an error message gets nothing");
    assertEquals(answerFor(4, "alice", "pw"), undefined, "an information message gets nothing");
    assertEquals(pointerBytes(0x1234).length, 1);
    assertEquals(pointerBytes(0x1234)[0], 0x1234n);
    const req = { id: 1, service: "archon-console", user: "alice", password: "pw" };
    assertEquals(pamRequest(req), req);
    assertEquals(pamRequest({ ...req, confdir: "/tmp/pam" }), { ...req, confdir: "/tmp/pam" });
    assertEquals(pamRequest({ ...req, password: 7 }), undefined);
    assertEquals(pamRequest({ ...req, confdir: 1 }), undefined);
    assertEquals(pamRequest("nonsense"), undefined);
    assertEquals(pamReply({ id: 1, ok: true }), { id: 1, ok: true });
    assertEquals(pamReply({ id: 1, ok: "yes" }), undefined);
    assertEquals(pamSupported("bun"), true);
    assertEquals(pamSupported("node"), false);
    // The worker is found from the repository's .ts and from the release package's .js.
    assertEquals(
      pamWorkerUrl("file:///r/src/archon/console/pam.ts").href,
      "file:///r/src/archon/console/pam-worker.ts",
    );
    assertEquals(
      pamWorkerUrl("file:///p/dist/archon/console/pam.js").href,
      "file:///p/dist/archon/console/pam-worker.js",
    );
  },
);

proves(
  ["096-bun-runtime FR-010"],
  "096: on Node the password sign-in is refused as not supported, never as a wrong password",
  async () => {
    const auth = pamAuthenticator("archon-console");
    try {
      await assertRejects(() => auth.check("alice", "pw"), errors.NotSupported, PAM_UNSUPPORTED);
      assertEquals(await passwordMatches(auth, "alice", "pw"), "unsupported");
    } finally {
      await auth.close();
    }
  },
  { skip: pamSupported() && "this runtime is Bun, which checks passwords with PAM" },
);

const PAM_EXEC = [
  "/usr/lib/x86_64-linux-gnu/security",
  "/lib/x86_64-linux-gnu/security",
  "/usr/lib/aarch64-linux-gnu/security",
  "/lib/security",
  "/usr/lib/security",
]
  .map((d) => path.join(d, "pam_exec.so"))
  .find((f) => fs.existsSync(f));

proves(
  ["096-bun-runtime FR-010"],
  "096: on Bun, PAM signs in with the right password only, in a worker, through bun:ffi",
  async () => {
    await fs.withTempDir(async (dir) => {
      // A PAM service of the test's own (PAM's configuration folder for it, not /etc/pam.d):
      // pam_exec hands the password the conversation answered to a script that compares it.
      const script = path.join(dir, "check.sh");
      await fs.writeTextFile(script, '#!/bin/sh\nread -r pw\n[ "$pw" = "s3cret" ]\n', {
        mode: 0o755,
      });
      await fs.mkdir(path.join(dir, "pam.d"));
      await fs.writeTextFile(
        path.join(dir, "pam.d", "archon-test"),
        `auth required pam_exec.so quiet expose_authtok ${script}\naccount required pam_permit.so\n`,
      );
      const auth = pamAuthenticator("archon-test", { confdir: path.join(dir, "pam.d") });
      try {
        const [right, wrong, other] = await Promise.all([
          auth.check("alice", "s3cret"),
          auth.check("alice", "wrong"),
          auth.check("bob", "s3cret"),
        ]);
        assertEquals([right, wrong, other], [true, false, true]);
        assertEquals(await passwordMatches(auth, "alice", "nope"), false);
        // A service PAM does not know: refused, not a crash.
        const none = pamAuthenticator("archon-test-missing", { confdir: path.join(dir, "pam.d") });
        try {
          assertEquals(await none.check("alice", "s3cret"), false);
        } finally {
          await none.close();
        }
      } finally {
        await auth.close();
      }
    });
  },
  {
    skip:
      (!pamSupported() && "PAM is called through bun:ffi: Bun only") ||
      (proc.build.os !== "linux" && "PAM is Linux's") ||
      (PAM_EXEC === undefined && "no pam_exec.so here"),
  },
);
