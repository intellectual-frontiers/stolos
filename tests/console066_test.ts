// Spec 066: the Stolos Console's guards (one-time launch links, loopback Host only, same-origin POSTs),
// what it offers, and the auditor's downloads.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import {
  Launch,
  LAUNCH_MS,
  stolosCommands,
  stolosCookie,
} from "../src/archon/console/stolos-server.ts";
import {
  evidence,
  machinesCsv,
  STOLOS_GROUPS,
  stolosGroupOf,
} from "../src/archon/console/stolos-pages.ts";
import { FACTS, fakeConsole } from "./console/serve-stolos.ts";

const PORT = 8091;
const B = `http://127.0.0.1:${PORT}`;

async function signedIn() {
  const { handler, launch } = await fakeConsole(PORT);
  const r = await handler(
    new Request(`${B}/launch?t=${launch.issue()}`, { headers: { host: `127.0.0.1:${PORT}` } }),
  );
  assertEquals(r.status, 303);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const get = (path: string, h: Record<string, string> = {}) =>
    handler(new Request(B + path, { headers: { host: `127.0.0.1:${PORT}`, cookie, ...h } }));
  const post = (path: string, body: Record<string, string>, h: Record<string, string> = {}) =>
    handler(
      new Request(B + path, {
        method: "POST",
        headers: { host: `127.0.0.1:${PORT}`, cookie, origin: B, "datastar-request": "true", ...h },
        body: new URLSearchParams(body),
      }),
    );
  return { handler, launch, cookie, get, post };
}

Deno.test("066: a launch link works once, and only for two minutes", () => {
  let t = 0;
  const l = new Launch(() => t);
  const a = l.issue();
  assertEquals(a.length, 64);
  assert(l.redeem(a));
  assert(!l.redeem(a), "used twice");
  const b = l.issue();
  t = LAUNCH_MS + 1;
  assert(!l.redeem(b), "too old");
  assert(!l.redeem(null));
  assert(!l.redeem("guess"));
});

Deno.test("066: the cookie is HttpOnly and SameSite=Strict", () => {
  const c = stolosCookie({ id: "x" } as never);
  assertStringIncludes(c, "HttpOnly");
  assertStringIncludes(c, "SameSite=Strict");
});

Deno.test("066: only the loopback Host, only with a session", async () => {
  const { handler } = await fakeConsole(PORT);
  for (
    const host of [
      "evil.example",
      `evil.example:${PORT}`,
      `127.0.0.1:${PORT + 1}`,
      "192.168.1.5:8091",
    ]
  ) {
    assertEquals((await handler(new Request(`${B}/`, { headers: { host } }))).status, 421, host);
  }
  assertEquals(
    (await handler(new Request(`${B}/`, { headers: { host: `localhost:${PORT}` } }))).status,
    401,
  );
  const bad = await handler(
    new Request(`${B}/launch?t=guess`, { headers: { host: `127.0.0.1:${PORT}` } }),
  );
  assertEquals(bad.status, 401);
  assertStringIncludes(await bad.text(), "deno task stolos console");
});

Deno.test("066: POSTs come from the console's own page", async () => {
  const { post } = await signedIn();
  assertEquals(
    (await post("/actions/run", { command: "where" }, { origin: "http://evil.example" })).status,
    403,
  );
  assertEquals(
    (await post("/actions/run", { command: "where" }, { "datastar-request": "" })).status,
    403,
  );
  const ok = await post("/actions/run", { command: "where" });
  assertEquals(ok.status, 200);
  const text = await ok.text();
  assertStringIncludes(text, "deno task stolos where");
  assertStringIncludes(text, "Done");
});

Deno.test("066: a command not offered, or a value that reads as an option, is refused", async () => {
  const { post } = await signedIn();
  for (
    const [form, why] of [
      [{ command: "keys rotate" }, "not offered"],
      [{ command: "vault restore", zip: "x.zip" }, "not offered"],
      [{ command: "host check", name: "--json" }, "may not start"],
    ] as const
  ) {
    const t = await (await post("/actions/run", form)).text();
    assertStringIncludes(t, why);
  }
});

Deno.test("066: a fleet query answers as a table; a refused one says why", async () => {
  const { post } = await signedIn();
  const t = await (await post("/query/run", { sql: "select name, version from os_version" }))
    .text();
  assertStringIncludes(t, "<table>");
  assertStringIncludes(t, "alice-mbp");
  assertStringIncludes(t, "osquery is not installed here");
  const r = await (await post("/query/run", { sql: "select * from shadow" })).text();
  assertStringIncludes(r, "never served");
});

Deno.test("066: what the console offers: person-only commands yes, keys that change and restores no", () => {
  const names = stolosCommands().map((c) => c.name);
  for (
    const n of [
      "apply",
      "fleet status",
      "host adopt",
      "cloud connect",
      "vault backup",
      "keys",
      "fleet query",
    ]
  ) {
    assert(names.includes(n), `${n} is offered`);
  }
  for (
    const n of ["keys setup", "keys rotate", "keys lost", "vault restore", "console", "boot serve"]
  ) {
    assert(!names.includes(n), `${n} is not offered`);
  }
  // Every offered command is in a group whose page lists it.
  for (const n of names) assert(STOLOS_GROUPS.some((g) => g.names.includes(n)), `${n} has a group`);
  assertEquals(stolosGroupOf("cloud check").id, "clouds");
});

Deno.test("066: every page answers, and the downloads are for auditors", async () => {
  const { get } = await signedIn();
  for (
    const p of [
      "/",
      "/machines",
      "/machines/bob-desk",
      "/boot",
      "/compliance",
      "/compliance?fw=cmmc",
      "/export/compliance.json",
      "/clouds",
      "/query",
      "/changes",
      "/trust",
      "/how",
      "/guide",
      "/activity",
      "/actions/vault",
    ]
  ) {
    assertEquals((await get(p)).status, 200, p);
  }
  assertEquals((await get("/machines/nobody")).status, 404);
  const csv = await (await get("/export/machines.csv")).text();
  assertStringIncludes(csv.split("\r\n")[0], "name,kind,os");
  assertEquals(csv.trim().split("\r\n").length, FACTS.machines.length + 1);
  const ev = JSON.parse(await (await get("/export/evidence.json")).text());
  assertEquals(ev.adopted.length, 2);
  assert(ev.adopted[0].results.every((r: { scf: string[] }) => r.scf.length > 0));
});

Deno.test("066: CSV cells with commas, quotes, and new lines are quoted", () => {
  const f = structuredClone(FACTS);
  f.machines = [{ name: 'a,"b"', kind: "adopted", failing: ["x\ny"] }];
  const csv = machinesCsv(f);
  assertStringIncludes(csv, '"a,""b"""');
  assertStringIncludes(csv, '"x\ny"');
  assertEquals((evidence(f) as { managed: unknown[] }).managed.length, 0);
});

Deno.test("066: boot.log as install timelines: Ready, under way, stopped, and armed again", async () => {
  const { parseBootLog } = await import("../src/archon/console/boot-timeline.ts");
  const { BOOT_LOG } = await import("./console/serve-stolos.ts");
  const p = parseBootLog(BOOT_LOG);
  assertEquals(p.map((x) => [x.host, x.step, x.failed]), [["alpha", 11, false], [
    "beta",
    5,
    false,
  ]]);
  const stopped = parseBootLog(
    BOOT_LOG + "2026-11-15T11:03:00Z 10.0.30.60 beta: ✗ installer: partitioning the disk failed\n",
  );
  assertEquals(stopped[1].failed, true);
  assertEquals(stopped[1].step, 7);
  const again = parseBootLog(
    BOOT_LOG + "2026-11-15T12:00:00Z 10.0.30.59 alpha: armed, starting its install\n",
  );
  assertEquals(again.find((x) => x.host === "alpha")!.step, 3);
});
