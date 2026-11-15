// Spec 065: the Archon Console's foundations: escaped HTML, sessions, roles, and the sign-in throttle.
import { assert, assertEquals } from "./assert.ts";
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

Deno.test("065: html escapes every value, but not Html or raw()", () => {
  const evil = `<script>alert("x")</script>&'`;
  assertEquals(
    html`<p title="${evil}">${evil}</p>`.s,
    `<p title="${esc(evil)}">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;</p>`,
  );
  assertEquals(
    html`<ul>${["a", "<b>"].map((x) => html`<li>${x}</li>`)}</ul>`.s,
    "<ul><li>a</li><li>&lt;b&gt;</li></ul>",
  );
  assertEquals(html`${raw("<hr>")}${undefined}${false}${null}`.s, "<hr>");
});

Deno.test("065: operators change the server; everyone else looks", () => {
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

Deno.test("065: a session ends after 8 idle hours; the cookie is HttpOnly, Secure, SameSite=Strict", () => {
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

Deno.test("065: five failed sign-ins in a minute pause that address", () => {
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

Deno.test("065: Datastar is served from the engine, exactly the pinned file", async () => {
  const { DATASTAR, datastarSource } = await import("../src/archon/console/assets.ts");
  const bytes = new TextEncoder().encode(datastarSource());
  const d = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(hex, DATASTAR.sha256);
  assert(datastarSource().startsWith("// Datastar v1.0.4"));
});

Deno.test("065: a form becomes one command's argument list: no shell, no smuggled options", async () => {
  const { argvFor, consoleCommands } = await import("../src/archon/console/forms.ts");
  const offered = consoleCommands("machine").map((c) => c.name);
  assert(offered.includes("verify") && offered.includes("pg on") && offered.includes("reboot"));
  for (const hidden of ["pg connect", "mcp", "web serve", "console exec", "host-keys export"]) {
    assert(!offered.includes(hidden), hidden);
  }
  const cmd = (n: string) => consoleCommands("machine").find((c) => c.name === n)!;
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

Deno.test("065: console exec serves only the console, and checks the person again", async () => {
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
    /only the Archon Console/.test((await execRefusal({ ...ok, sudoUser: "mallory" }, accounts))!),
  );
  assert(/no such person/.test((await execRefusal({ ...ok, as: "carol" }, accounts))!));
  assertEquals(await execRefusal({ ...ok, as: "bob" }, accounts), undefined, "anyone may look");
  assert(
    /may not run reboot/.test(
      (await execRefusal({ ...ok, as: "bob", argv: ["reboot"] }, accounts))!,
    ),
  );
  assertEquals(
    await execRefusal({ ...ok, argv: ["reboot"] }, accounts),
    undefined,
    "an operator may",
  );
  assert(
    /not a command the console runs/.test(
      (await execRefusal({ ...ok, argv: ["host-keys", "export"] }, accounts))!,
    ),
  );
  assert(
    /not a command the console runs/.test((await execRefusal({ ...ok, argv: ["mcp"] }, accounts))!),
  );
});
