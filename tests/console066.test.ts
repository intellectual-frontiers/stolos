/**
 * Spec 066: the Stolos Console's guards (one-time launch links, loopback Host only, same-origin POSTs),
 * what it offers, and the auditor's downloads.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  test,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
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
import { list, must, parse } from "./console/tree.ts";

const PORT = 8091;
const B = `http://127.0.0.1:${PORT}`;

async function signedIn(): Promise<{
  handler: Awaited<ReturnType<typeof fakeConsole>>["handler"];
  launch: Awaited<ReturnType<typeof fakeConsole>>["launch"];
  cookie: string;
  get: (path: string, h?: Record<string, string>) => Promise<Response>;
  post: (
    path: string,
    body: Record<string, string>,
    h?: Record<string, string>,
  ) => Promise<Response>;
}> {
  const { handler, launch } = await fakeConsole(PORT);
  const r = await handler(
    new Request(`${B}/launch?t=${launch.issue()}`, { headers: { host: `127.0.0.1:${PORT}` } }),
  );
  assertEquals(r.status, 303);
  const cookie = must(r.headers.get("set-cookie")).split(";")[0] ?? "";
  const get = (path: string, h: Record<string, string> = {}): Promise<Response> =>
    handler(new Request(B + path, { headers: { host: `127.0.0.1:${PORT}`, cookie, ...h } }));
  const post = (
    path: string,
    body: Record<string, string>,
    h: Record<string, string> = {},
  ): Promise<Response> =>
    handler(
      new Request(B + path, {
        method: "POST",
        headers: { host: `127.0.0.1:${PORT}`, cookie, origin: B, "datastar-request": "true", ...h },
        body: new URLSearchParams(body),
      }),
    );
  return { handler, launch, cookie, get, post };
}

proves(
  ["066-stolos-console FR-001"],
  "066: a launch link works once, and only for two minutes",
  () => {
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
  },
);

proves(["066-stolos-console FR-001"], "066: the cookie is HttpOnly and SameSite=Strict", () => {
  const c = stolosCookie({ id: "x" } as never);
  assertStringIncludes(c, "HttpOnly");
  assertStringIncludes(c, "SameSite=Strict");
});

proves(
  ["066-stolos-console FR-002"],
  "066: only the loopback Host, only with a session",
  async () => {
    const { handler } = await fakeConsole(PORT);
    for (const host of [
      "evil.example",
      `evil.example:${PORT}`,
      `127.0.0.1:${PORT + 1}`,
      "192.168.1.5:8091",
    ]) {
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
    assertStringIncludes(await bad.text(), "bun run stolos console");
  },
);

proves(["066-stolos-console FR-002"], "066: POSTs come from the console's own page", async () => {
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
  assertStringIncludes(text, "bun run stolos where");
  assertStringIncludes(text, "Done");
});

proves(
  ["066-stolos-console FR-005"],
  "066: a command not offered, or a value that reads as an option, is refused",
  async () => {
    const { post } = await signedIn();
    for (const [form, why] of [
      [{ command: "keys rotate" }, "not offered"],
      [{ command: "vault restore", zip: "x.zip" }, "not offered"],
      [{ command: "host check", name: "--json" }, "may not start"],
    ] as const) {
      const t = await (await post("/actions/run", form)).text();
      assertStringIncludes(t, why);
    }
  },
);

proves(
  ["066-stolos-console FR-003", "107-pairing-and-query FR-011"],
  "066: a fleet query streams its answers into the table, each machine's row with its reason; a refused one says why",
  async () => {
    const { post } = await signedIn();
    const t = await (
      await post("/query/run", { sql: "select name, version from os_version" })
    ).text();
    assertStringIncludes(t, "selector #answers-feed");
    assertStringIncludes(t, "alice-mbp");
    assertStringIncludes(t, "osquery is not installed here");
    const r = await (await post("/query/run", { sql: "select * from shadow" })).text();
    assertStringIncludes(r, "never served");
  },
);

proves(
  ["066-stolos-console FR-004"],
  "066: what the console offers: person-only commands yes, keys that change and restores no",
  () => {
    const names = stolosCommands().map((c) => c.name);
    for (const n of [
      "apply",
      "fleet status",
      "host adopt",
      "connect",
      "vault backup",
      "keys",
      "fleet query",
    ]) {
      assert(names.includes(n), `${n} is offered`);
    }
    for (const n of [
      "keys setup",
      "keys rotate",
      "keys lost",
      "vault restore",
      "console",
      "boot serve",
    ]) {
      assert(!names.includes(n), `${n} is not offered`);
    }
    // Every offered command is in a group whose page lists it.
    for (const n of names)
      assert(
        STOLOS_GROUPS.some((g) => g.names.includes(n)),
        `${n} has a group`,
      );
    assertEquals(stolosGroupOf("estate check").id, "clouds");
  },
);

proves(
  ["066-stolos-console FR-003"],
  "066: every page answers, and the downloads are for auditors",
  async () => {
    const { get } = await signedIn();
    for (const p of [
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
      // Spec 094: the REST API (tests/api094_test.ts has the rest).
      "/v1/",
      "/v1/openapi.json",
      "/v1/device",
      "/v1/finding?format=ocsf",
      "/v1/oscal/assessment-results",
      "/v1/evidence/",
    ]) {
      assertEquals((await get(p)).status, 200, p);
    }
    assertEquals((await get("/machines/nobody")).status, 404);
    const csv = await (await get("/export/machines.csv")).text();
    assertStringIncludes(csv.split("\r\n")[0] ?? "", "name,title,kind,how_it_joined,os");
    assertEquals(csv.trim().split("\r\n").length, FACTS.machines.length + 1);
    const ev = parse(await (await get("/export/evidence.json")).text());
    assertEquals(list(ev, "adopted").length, 3, "two adopted machines and the controller");
    assert(list(ev, "adopted", 0, "results").every((r) => list(r, "scf").length > 0));
  },
);

test("066: CSV cells with commas, quotes, and new lines are quoted", () => {
  const f = structuredClone(FACTS);
  f.machines = [{ name: 'a,"b"', kind: "adopted", failing: ["x\ny"] }];
  const csv = machinesCsv(f);
  assertStringIncludes(csv, '"a,""b"""');
  assertStringIncludes(csv, '"x\ny"');
  assertEquals((evidence(f) as { managed: unknown[] }).managed.length, 0);
});

test("066: boot.log as install timelines: Ready, under way, stopped, and armed again", async () => {
  const { parseBootLog } = await import("../src/archon/console/boot-timeline.ts");
  const { BOOT_LOG } = await import("./console/serve-stolos.ts");
  const p = parseBootLog(BOOT_LOG);
  assertEquals(
    p.map((x) => [x.host, x.step, x.failed]),
    [
      ["alpha", 11, false],
      ["beta", 5, false],
    ],
  );
  const stopped = parseBootLog(
    BOOT_LOG + "2026-11-15T11:03:00Z 10.0.30.60 beta: ✗ installer: partitioning the disk failed\n",
  );
  assertEquals(stopped[1]?.failed, true);
  assertEquals(stopped[1]?.step, 7);
  const again = parseBootLog(
    BOOT_LOG + "2026-11-15T12:00:00Z 10.0.30.59 alpha: armed, starting its install\n",
  );
  assertEquals(must(again.find((x) => x.host === "alpha")).step, 3);
});

test("066 acceptance: choices, long values, quoting, bad addresses, signers in the terminal", async () => {
  const { argvFor, shellWords } = await import("../src/archon/console/forms.ts");
  const connect = must(stolosCommands().find((c) => c.name === "connect"));
  assert(
    "error" in argvFor(connect, { provider: "cloudfare" }),
    "a misspelled provider is refused",
  );
  assert(!("error" in argvFor(connect, { provider: "cloudflare" })));
  const check = must(stolosCommands().find((c) => c.name === "host check"));
  assert("error" in argvFor(check, { name: "x".repeat(2001) }), "a very long value is refused");
  assertEquals(
    shellWords(["host", "adopt", "a b", "it's", "<img>"]),
    `host adopt 'a b' 'it'\\''s' '<img>'`,
  );
  const names = stolosCommands().map((c) => c.name);
  assert(
    !names.includes("signers add") && !names.includes("signers remove"),
    "trust changes stay in the terminal",
  );
  const { get } = await signedIn();
  assertEquals((await get("/machines/%E0%A4%A")).status, 404);
  assertStringIncludes(await (await get("/compliance?fw=bogus")).text(), "There is no framework");
});

test("066 acceptance: 'failed' in a passing line does not stop an install", async () => {
  const { parseBootLog } = await import("../src/archon/console/boot-timeline.ts");
  const p = parseBootLog(
    [
      "2026-11-15T10:00:03Z 10.0.30.59 alpha: armed, starting its install",
      "2026-11-15T10:01:00Z 10.0.30.59 alpha: installer: retrying a failed mirror",
      "2026-11-15T10:09:00Z 10.0.30.59 alpha: First boot: installing Bun, cloning the repository",
      "2026-11-15T10:10:30Z 10.0.30.59 alpha: Verify: 142 passed, 0 failed",
    ].join("\n"),
  );
  assertEquals([p[0]?.step, p[0]?.failed], [10, false]);
});

proves(
  ["066-stolos-console FR-006"],
  "066: why a server did not take a change, in plain words",
  async () => {
    const { syncAdvice } = await import("../src/archon/console/stolos-pages.ts");
    assertEquals(
      syncAdvice("a1b2 is not signed by a fleet signer (archon explain E047-UNSIGNED)").href,
      "/changes",
    );
    assertStringIncludes(
      syncAdvice("fetch failed as ops: Could not resolve host").what,
      "could not fetch",
    );
    assertStringIncludes(
      syncAdvice("working tree has uncommitted changes").what,
      "changed on the server",
    );
    const { get } = await signedIn();
    const alpha = await (await get("/machines/alpha")).text();
    assertStringIncludes(alpha, "Its last pull");
    assertStringIncludes(alpha, "not signed by a fleet signer");
    assertStringIncludes(await (await get("/")).text(), "did not take the newest change");
  },
);

proves(["066-stolos-console FR-007"], "066: Activity between dates, and as CSV", async () => {
  const { activityBetween, activityCsv } = await import("../src/archon/console/pages.ts");
  const es = [
    {
      at: "2026-11-01T10:00:00Z",
      user: "alice",
      from: "this PC",
      kind: "run" as const,
      detail: "where",
      code: 0,
    },
    {
      at: "2026-11-10T10:00:00Z",
      user: "alice",
      from: "this PC",
      kind: "run" as const,
      detail: 'a "b", c',
      code: 1,
    },
  ];
  assertEquals(activityBetween(es, "2026-11-05", undefined).length, 1);
  assertEquals(activityBetween(es, "bad", "2026-11-02").length, 1);
  const csv = activityCsv(es);
  assertStringIncludes(csv, '"a ""b"", c"');
  assertEquals(csv.split("\r\n")[0], "at_utc,user,from,kind,detail,exit_code");
  const { get } = await signedIn();
  const r = await get("/export/activity.csv");
  assertEquals(r.headers.get("content-type"), "text/csv; charset=utf-8");
});

/** WCAG 2's relative luminance of a #RRGGBB color. */
function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = ch.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 2's contrast ratio of two colors. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
/** The color tokens of a block of the stylesheet (`--name: #RRGGBB`). */
function tokens(css: string): Record<string, string> {
  return Object.fromEntries(
    [...css.matchAll(/--([a-z-]+):\s*(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}
/** Whether every <table> of a page is inside an element of class `cls`. */
function tablesInside(page: string, cls: string): string[] {
  const VOID = new Set([
    "br",
    "img",
    "input",
    "meta",
    "link",
    "hr",
    "source",
    "path",
    "rect",
    "circle",
  ]);
  const stack: Array<{ tag: string; scroll: boolean }> = [];
  const bad: string[] = [];
  for (const m of page.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g)) {
    const [, close, name = "", attrs = "", self] = m;
    const tag = name.toLowerCase();
    if (close) {
      const i = stack.map((x) => x.tag).lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    if (tag === "table" && !stack.some((x) => x.scroll))
      bad.push(page.slice(m.index - 120, m.index));
    if (VOID.has(tag) || self) continue;
    const c = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
    stack.push({ tag, scroll: c.split(/\s+/).includes(cls) });
  }
  return bad;
}

proves(
  ["066-stolos-console FR-008"],
  "066: 4.5:1 contrast in light and dark; tables scroll with a shadow; diagrams scroll on a phone; a skip link",
  async () => {
    const { CONSOLE_CSS } = await import("../src/archon/console/assets.ts");
    const dark = CONSOLE_CSS.slice(CONSOLE_CSS.indexOf("@media (prefers-color-scheme: dark)"));
    const light = tokens(CONSOLE_CSS.slice(0, CONSOLE_CSS.indexOf("@media (prefers-color-scheme")));
    // Text on each surface, buttons, links, and each pill's text on its own background.
    const pairs: Array<[string, string]> = [
      ["ink", "bg"],
      ["ink", "panel"],
      ["ink", "rail"],
      ["ink", "code"],
      ["muted", "bg"],
      ["muted", "panel"],
      ["muted", "rail"],
      ["muted", "code"],
      ["accent", "panel"],
      ["accent", "bg"],
      ["on-accent", "accent"],
      ["accent", "accent-soft"],
      ["ok", "ok-soft"],
      ["warn", "warn-soft"],
      ["bad", "bad-soft"],
    ];
    for (const [scheme, t] of [
      ["light", light],
      ["dark", { ...light, ...tokens(dark) }],
    ] as const) {
      for (const [fg, bg] of pairs) {
        const a = t[fg];
        const b = t[bg];
        assert(a !== undefined && b !== undefined, `${scheme}: --${fg} and --${bg}`);
        const r = contrast(a, b);
        assert(r >= 4.5, `${scheme}: --${fg} on --${bg} is ${r.toFixed(2)}:1`);
      }
    }
    // A table wider than its card scrolls sideways, with a shadow at the edge where more is.
    const scroll = CONSOLE_CSS.slice(CONSOLE_CSS.indexOf(".scroll {"));
    assertStringIncludes(scroll.slice(0, 900), "overflow-x: auto");
    assertStringIncludes(scroll.slice(0, 900), "radial-gradient(farthest-side at 0 50%");
    assertStringIncludes(
      scroll.slice(0, 900),
      "background-attachment: local, local, scroll, scroll",
    );
    // A diagram on a phone keeps a readable size and scrolls.
    assertStringIncludes(CONSOLE_CSS, ".diagram { overflow-x: auto; }");
    assertStringIncludes(
      CONSOLE_CSS,
      "@media (max-width: 640px) { .diagram svg { min-width: 620px; } }",
    );
    assertStringIncludes(CONSOLE_CSS, ".skip:focus {");
    const { get } = await signedIn();
    for (const p of [
      "/",
      "/machines",
      "/machines/alice-mbp",
      "/machines/front-printer",
      "/add",
      "/add?what=cloud",
      "/clouds",
      "/boot",
      "/query",
      "/changes",
      "/trust",
      "/compliance",
      "/compliance?fw=hipaa",
      "/activity",
      "/how",
      "/guide",
      "/actions/fleet",
      "/actions/adopted",
    ]) {
      const page = await (await get(p)).text();
      assertStringIncludes(page, '<a class="skip" href="#main">Skip to the page</a>', p);
      assertStringIncludes(page, 'id="main"', p);
      assertEquals(tablesInside(page, "scroll"), [], `${p}: a table outside .scroll`);
      for (const d of page.matchAll(/<pre class="mermaid"/g)) {
        assert(
          page.lastIndexOf('class="card diagram"', d.index) >= 0,
          `${p}: a diagram outside .diagram`,
        );
      }
    }
  },
);

proves(
  ["069-integrate FR-006"],
  "069: each cloud has a recipe for a read-only credential; cloud servers no machine owns are under Machines, with Adopt",
  async () => {
    const { CONNECTORS } = await import("../src/archon/connect/commands.ts");
    const clouds = CONNECTORS.filter((c) => c.serviceModels.includes("IaaS"));
    assert(clouds.length >= 4, clouds.map((c) => c.id).join(", "));
    for (const c of clouds) {
      const r = c.recipe;
      assert(r.open !== undefined || r.shell !== undefined, `${c.id}: a page to open or a command`);
      if (r.open) assert(/^https:\/\//.test(r.open.href), `${c.id}: ${r.open.href}`);
      if (r.shell) assert(/^https:\/\//.test(r.shell.href) && r.shell.command.length > 0, c.id);
    }
    const shell = (id: string) => CONNECTORS.find((c) => c.id === id)?.recipe.shell?.where ?? "";
    assertStringIncludes(shell("aws"), "AWS CloudShell");
    assertStringIncludes(shell("microsoft"), "Azure Cloud Shell");
    const { get } = await signedIn();
    const add = await (await get("/add?what=cloud")).text();
    assertStringIncludes(add, "AWS CloudShell");
    assertStringIncludes(add, "it makes a read-only identity and prints its keys");
    assertStringIncludes(add, ">\n          Copy\n        </button>");
    assertStringIncludes(add, "/actions/clouds?cmd=connect&provider=hetzner");
    const machines = await (await get("/machines")).text();
    assertStringIncludes(machines, '<a href="/machines/scratch"><b>scratch</b></a>');
    assertStringIncludes(machines, "Hetzner Cloud, fsn1-dc14");
    const scratch = await (await get("/machines/scratch")).text();
    assertStringIncludes(scratch, 'href="/add?name=scratch">Adopt it</a>');
  },
);

proves(
  ["069-integrate FR-007"],
  "069: Add a machine asks what it is in plain words, shows the line with Copy, takes the check-in code; Machines lists what was discovered",
  async () => {
    const { ADD_CHOICES } = await import("../src/archon/console/stolos-pages.ts");
    assertEquals(
      ADD_CHOICES.map((c) => c.id),
      ["adopt", "discover", "device", "cloud", "server", "workstation"],
    );
    const { get } = await signedIn();
    const add = await (await get("/add")).text();
    for (const c of ADD_CHOICES) {
      assertStringIncludes(add, `value="${c.id}"`);
      assertStringIncludes(add, c.title);
    }
    for (const words of [
      "laptop",
      "Just record",
      "printer",
      "cloud",
      "server we will manage",
      "workstation",
    ]) {
      assertStringIncludes(add, words);
    }
    const step = await (await get("/add?what=adopt&name=alice-laptop")).text();
    assertStringIncludes(step, "Run this on alice-laptop");
    assertStringIncludes(step, "navigator.clipboard.writeText");
    assertStringIncludes(step, "Paste the check-in code");
    assertStringIncludes(step, 'name="check-in"');
    assertStringIncludes(step, 'name="command" value="host adopt"');
    const machines = await (await get("/machines")).text();
    for (const m of ["front-desk", "front-printer"]) assertStringIncludes(machines, m);
  },
);
