// Spec 065: the Archon Console's web server, driven with fakes: sign-in, sessions, the cross-site
// rules, who may run what, destroying data, and the live output of a run.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import {
  type ConsoleDeps,
  consoleHandler,
  lineClass,
  patch,
} from "../src/archon/console/server.ts";
import { Sessions, Throttle } from "../src/archon/console/auth.ts";
import type { ActivityEntry } from "../src/archon/console/pages.ts";
import type { WelcomeData } from "../src/archon/web/welcome.ts";

const PEOPLE: Record<string, { pw: string; groups: string[]; name: string }> = {
  alice: { pw: "right", groups: ["alice", "sudo"], name: "Alice Example" },
  bob: { pw: "bobpw", groups: ["bob"], name: "Bob Example" },
};

function deps(): ConsoleDeps & {
  log: ActivityEntry[];
  ran: Array<{ user: string; argv: string[] }>;
} {
  const log: ActivityEntry[] = [];
  const ran: Array<{ user: string; argv: string[] }> = [];
  const data: WelcomeData = {
    host: "alpha",
    fqdn: "alpha.lab.example.net",
    title: "lab",
    os: "Ubuntu 26.04.1 LTS",
    repo: { slug: "example/fleet", url: "https://github.com/example/fleet" },
    verify: { at: new Date().toISOString(), passed: 142, total: 142, failed: [] },
    services: [],
    unrouted: [],
    guide: [],
    guides: [],
    admin: "alice",
    generated: "now",
  };
  return {
    log,
    ran,
    host: "alpha",
    auth: { check: (u, p) => Promise.resolve(PEOPLE[u]?.pw === p) },
    accounts: (u) =>
      Promise.resolve(
        PEOPLE[u] ? { user: u, name: PEOPLE[u].name, groups: PEOPLE[u].groups } : undefined,
      ),
    runner: {
      run(user, argv, line) {
        ran.push({ user, argv });
        line("[ok] Verify           142 passed");
        line("<b>not markup</b>");
        return Promise.resolve(0);
      },
    },
    sessions: new Sessions(),
    throttle: new Throttle(),
    data: () => Promise.resolve(data),
    repo: () =>
      Promise.resolve({
        commit: {
          sha: "a7c1e94",
          subject: "lab: approve",
          author: "alice",
          at: new Date().toISOString(),
        },
        signer: "alice-daily",
        engine: "v0.66.0",
        signers: [{ name: "alice-daily", role: "daily" }, {
          name: "alice-recovery",
          role: "recovery",
        }],
      }),
    activity: {
      add: (e) => (log.push(e), Promise.resolve()),
      recent: (n) => Promise.resolve(log.slice(-n).reverse()),
    },
    guideDoc: () => Promise.resolve(undefined),
    cacheDir: "/nonexistent",
    services: () =>
      Promise.resolve({
        optIns: [
          {
            name: "pg",
            title: "PostgreSQL",
            on: false,
            commands: { on: "archon pg on", off: "archon pg off", status: "archon pg status" },
          },
          {
            name: "otel-ui",
            title: "Telemetry web UI (OpenObserve)",
            on: true,
            data: "ephemeral",
            since: "2026-11-14T12:20:00Z",
            by: "alice",
            commands: {
              on: "archon otel ui on",
              off: "archon otel ui off",
              status: "archon otel ui status",
            },
          },
        ],
        units: [
          {
            unit: "traefik.service",
            spec: "032-web",
            active: "active",
            sub: "running",
            enabled: "enabled",
          },
          {
            unit: "smbd.service",
            spec: "037-smb",
            active: "inactive",
            sub: "dead",
            enabled: "masked",
          },
        ],
      }),
    journal: (unit, each) => {
      each(`2026-11-15T01:00:00 alpha ${unit ?? "kernel"}[1]: <script>hi</script>`);
      return Promise.resolve();
    },
  };
}

const BASE = "https://alpha.lab.example.net";
const req = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const h = new Headers(init.headers);
  h.set("host", "alpha.lab.example.net");
  h.set("x-forwarded-for", "10.0.0.5");
  if (init.cookie) h.set("cookie", init.cookie);
  return new Request(BASE + path, { ...init, headers: h });
};
const form = (o: Record<string, string>) => new URLSearchParams(o);
async function signIn(h: ReturnType<typeof consoleHandler>, user: string, pw: string) {
  const r = await h(
    req("/signin", {
      method: "POST",
      body: form({ user, password: pw }),
      headers: { origin: BASE },
    }),
  );
  const c = r.headers.get("set-cookie") ?? "";
  return { r, cookie: c.split(";")[0] };
}

Deno.test("065 console: nothing without signing in; a wrong password is refused and recorded", async () => {
  const d = deps();
  const h = consoleHandler(d);
  let r = await h(req("/"));
  assertEquals(r.status, 303);
  assertEquals(r.headers.get("location"), "/signin");
  r = await h(req("/signin"));
  assertStringIncludes(await r.text(), "Sign in to alpha");
  const bad = await signIn(h, "alice", "wrong");
  assertEquals(bad.r.status, 401);
  assertEquals(bad.cookie, "");
  assertEquals(d.log.at(-1)?.kind, "sign-in failed");
  assertEquals((await signIn(h, "root", "x")).r.status, 401, "no such account here");
});

Deno.test("065 console: sign in, see the overview with its live diagram, sign out", async () => {
  const d = deps();
  const h = consoleHandler(d);
  const { r, cookie } = await signIn(h, "alice", "right");
  assertEquals(r.status, 303);
  assert(
    /HttpOnly/.test(r.headers.get("set-cookie")!) &&
      /SameSite=Strict/.test(r.headers.get("set-cookie")!),
  );
  const page = await (await h(req("/", { cookie }))).text();
  assertStringIncludes(page, "All checks pass");
  assertStringIncludes(page, "Alice Example");
  assertStringIncludes(page, 'class="mermaid"');
  assertStringIncludes(page, "a7c1e94");
  assertStringIncludes(page, "alice-daily");
  assertEquals((await h(req("/actions", { cookie }))).headers.get("location"), "/actions/server");
  for (
    const p of [
      "/how",
      "/actions/server",
      "/actions/postgres?cmd=pg%20on",
      "/actions/storage",
      "/actions/web",
      "/actions/mail",
      "/actions/shell",
      "/activity",
      "/guide",
    ]
  ) {
    assertEquals((await h(req(p, { cookie }))).status, 200, p);
  }
  const out = await h(req("/signout", { method: "POST", cookie, headers: { origin: BASE } }));
  assertEquals(out.headers.get("location"), "/signin");
  assertEquals((await h(req("/", { cookie }))).status, 303, "signed out");
});

Deno.test("065 console: five wrong tries pause the address", async () => {
  const h = consoleHandler(deps());
  for (let i = 0; i < 5; i++) await signIn(h, "alice", "wrong");
  assertEquals((await signIn(h, "alice", "right")).r.status, 429);
});

Deno.test("065 console: another site cannot sign in or run anything", async () => {
  const d = deps();
  const h = consoleHandler(d);
  const evil = await h(
    req("/signin", {
      method: "POST",
      body: form({ user: "alice", password: "right" }),
      headers: { origin: "https://evil.example" },
    }),
  );
  assertEquals(evil.status, 403);
  const { cookie } = await signIn(h, "alice", "right");
  // A form from another site carries no Datastar header (and a cross-site Origin).
  let r = await h(
    req("/actions/run", {
      method: "POST",
      cookie,
      body: form({ command: "reboot" }),
      headers: { origin: "https://evil.example", "datastar-request": "true" },
    }),
  );
  assertEquals(r.status, 403);
  r = await h(
    req("/actions/run", {
      method: "POST",
      cookie,
      body: form({ command: "reboot" }),
      headers: { origin: BASE },
    }),
  );
  assertEquals(r.status, 403, "no Datastar header");
  assertEquals(d.ran.length, 0);
});

const run = async (
  h: ReturnType<typeof consoleHandler>,
  cookie: string,
  f: Record<string, string>,
) =>
  await (await h(
    req("/actions/run", {
      method: "POST",
      cookie,
      body: form(f),
      headers: { origin: BASE, "datastar-request": "true" },
    }),
  )).text();

Deno.test("065 console: a run streams its output, escaped, and is recorded with the person", async () => {
  const d = deps();
  const h = consoleHandler(d);
  const { cookie } = await signIn(h, "alice", "right");
  const out = await run(h, cookie, { command: "verify" });
  assertStringIncludes(out, "event: datastar-patch-elements");
  assertStringIncludes(out, "data: mode append");
  assertStringIncludes(out, "142 passed");
  assertStringIncludes(out, "&lt;b&gt;not markup&lt;/b&gt;");
  assertStringIncludes(out, "Done");
  assertEquals(d.ran, [{ user: "alice", argv: ["verify"] }]);
  assertEquals(d.log.at(-1)?.kind, "run");
  assertEquals(d.log.at(-1)?.detail, "archon verify");
});

Deno.test("065 console: people who are not operators look but cannot change; destroying needs the password", async () => {
  const d = deps();
  const h = consoleHandler(d);
  const bob = (await signIn(h, "bob", "bobpw")).cookie;
  assertStringIncludes(await run(h, bob, { command: "verify" }), "Done");
  assertStringIncludes(await run(h, bob, { command: "reboot" }), "Only operators");
  assertEquals(d.ran.map((x) => x.argv.join(" ")), ["verify"]);
  const alice = (await signIn(h, "alice", "right")).cookie;
  assertStringIncludes(
    await run(h, alice, { command: "pg remove", name: "prime", "confirm-destroy": "prime" }),
    "needs your password again",
  );
  assertStringIncludes(
    await run(h, alice, {
      command: "pg remove",
      name: "prime",
      "confirm-destroy": "prime",
      password: "right",
    }),
    "Done",
  );
  assertEquals(d.ran.at(-1)?.argv, ["pg", "remove", "prime", "--confirm-destroy", "prime"]);
  assertEquals(d.log.filter((e) => e.kind === "refused").length, 2);
});

Deno.test("065 console: Basic credentials work for a script's GET", async () => {
  const h = consoleHandler(deps());
  const r = await h(
    req("/activity", { headers: { authorization: "Basic " + btoa("alice:right") } }),
  );
  assertEquals(r.status, 200);
  assertEquals(
    (await h(req("/activity", { headers: { authorization: "Basic " + btoa("alice:no") } }))).status,
    303,
  );
});

Deno.test("065 console: event format and line colors", () => {
  assertEquals(
    patch("<p>a\nb</p>", { selector: "#x", mode: "append" }),
    "event: datastar-patch-elements\ndata: mode append\ndata: selector #x\ndata: elements <p>a\ndata: elements b</p>\n\n",
  );
  assertEquals(lineClass("[ok] Units  46 up to date"), "ok");
  assertEquals(lineClass("[FAIL] verify  2 failed"), "bad");
  assertEquals(
    lineClass("[!!] Web   certificate renews in 9 days"),
    "w",
    "a warning, not a failure",
  );
});

Deno.test("065 console: every command is on exactly one action page, each page has some", async () => {
  const { ACTION_GROUPS, groupOf } = await import("../src/archon/console/pages.ts");
  const { consoleCommands } = await import("../src/archon/console/forms.ts");
  const cmds = consoleCommands("machine");
  for (const g of ACTION_GROUPS) {
    assert(cmds.some((c) => groupOf(c.name).id === g.id), `${g.id} has commands`);
    assert(
      cmds.some((c) => c.name === g.first),
      `${g.id} starts with an offered command (${g.first})`,
    );
  }
});

Deno.test("065 console: terminal color codes never reach the page", async () => {
  const { stripAnsi } = await import("../src/archon/console/exec.ts");
  assertEquals(
    stripAnsi("\x1b[0m\x1b[1m\x1b[31merror\x1b[0m: Failed caching\r"),
    "error: Failed caching",
  );
});

Deno.test("065 console: Services, Apps, Data, and Logs; the live journal only for the plan's units", async () => {
  const d = deps();
  const h = consoleHandler(d);
  const { cookie } = await signIn(h, "alice", "right");
  const svc = await (await h(req("/services", { cookie }))).text();
  assertStringIncludes(svc, "PostgreSQL");
  assertStringIncludes(svc, "Turn on");
  assertStringIncludes(svc, "/actions/postgres?cmd=pg%20on");
  assertStringIncludes(svc, "off (masked)");
  assertStringIncludes(svc, 'class="brandlogo"');
  for (const p of ["/apps", "/data", "/logs", "/logs?unit=traefik.service"]) {
    assertEquals((await h(req(p, { cookie }))).status, 200, p);
  }
  let stream = await (await h(req("/logs/stream?unit=traefik.service", { cookie }))).text();
  assertStringIncludes(stream, "traefik.service[1]: &lt;script&gt;");
  stream = await (await h(req("/logs/stream?unit=../../etc/shadow", { cookie }))).text();
  assertStringIncludes(stream, "kernel[1]", "an unknown unit means everything, never an argument");
  const bob = (await signIn(h, "bob", "bobpw")).cookie;
  assert(
    !(await (await h(req("/services", { cookie: bob }))).text()).includes(">Turn on<"),
    "only operators switch",
  );
});
