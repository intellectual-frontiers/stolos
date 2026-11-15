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
