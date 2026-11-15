// Spec 082: one controller, many client fleets, isolated. Two fixture clients (north and south),
// each its own repository, fleet, vault folder, and signers: switching scopes every path; the
// summary is numbers only; a bundle for north holds nothing of south; a console session for one
// client never reaches the other's pages without switching (a new session).
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { unzipSync } from "npm:fflate@0.8.2";
import { join } from "../src/archon/core/path.ts";
import { P, resetRoots } from "../src/archon/core/paths.ts";
import { Sessions } from "../src/archon/console/auth.ts";
import { Launch } from "../src/archon/console/stolos-server.ts";
import { type ClientConsole, providerHandler } from "../src/archon/clients/console.ts";
import {
  type Client,
  loadClients,
  overlaps,
  planAdd,
  saveClients,
} from "../src/archon/clients/registry.ts";
import { activeClient, enterClient, SCOPE_VARS, withClient } from "../src/archon/clients/scope.ts";
import { type ClientSummary, summarize } from "../src/archon/clients/summary.ts";
import { reportFolder } from "../src/archon/clients/report.ts";
import { fleetFreshView } from "../src/archon/compliance/freshness.ts";
import { signersSource } from "../src/archon/identity/signers.ts";
import { FACTS, fakeConsole } from "./console/serve-stolos.ts";
import { sandbox } from "./sandbox.ts";

const dec = new TextDecoder();

async function sh(args: string[], cwd?: string, env: Record<string, string> = {}) {
  const r = await new Deno.Command(args[0], {
    args: args.slice(1),
    ...(cwd ? { cwd } : {}),
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!r.success) throw new Error(`${args.join(" ")}: ${dec.decode(r.stderr)}`);
  return dec.decode(r.stdout);
}

/** One client's own repository: the example lab as fleet `fleet`, its own signer, one signed commit. */
async function clientRepo(dir: string, o: { fleet: string; title: string; signer: string }) {
  const key = join(dir, `${o.signer}-key`);
  await sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", o.signer, "-f", key]);
  const pub = (await Deno.readTextFile(key + ".pub")).trim().split(/\s+/).slice(0, 2).join(" ");
  const repo = join(dir, `${o.fleet}-repo`);
  const fd = join(repo, "fleets", o.fleet);
  await Deno.mkdir(join(repo, "fleets"), { recursive: true });
  await sh(["cp", "-r", "examples/fleets/lab", fd]);
  const f = join(fd, "fleet.ts");
  await Deno.writeTextFile(
    f,
    (await Deno.readTextFile(f)).replace(/id: "lab"/, `id: "${o.fleet}"`).replace(
      /title: "Example lab fleet"/,
      `title: "${o.title}"`,
    ),
  );
  await Deno.writeTextFile(
    join(fd, "signers.ts"),
    signersSource([{ name: o.signer, role: "daily", key: pub, added: "2026-11-01" }]),
  );
  await sh(["git", "init", "-q", "-b", "main"], repo);
  for (
    const [k, v] of [
      ["user.name", o.signer],
      ["user.email", `${o.signer}@example.org`],
      ["gpg.format", "ssh"],
      ["user.signingkey", key],
      ["commit.gpgsign", "true"],
    ]
  ) await sh(["git", "config", k, v], repo);
  await sh(["git", "add", "-A"], repo);
  await sh(["git", "commit", "-q", "-m", `${o.fleet}: first commit (${o.signer})`], repo, {
    GIT_AUTHOR_DATE: "2026-11-02T10:00:00Z",
    GIT_COMMITTER_DATE: "2026-11-02T10:00:00Z",
  });
  return { repo, key, pub };
}

/** Run `fn` with the scope variables cleared, then put them back. */
async function bare<T>(fn: () => Promise<T>): Promise<T> {
  const keep = Object.fromEntries(SCOPE_VARS.map((k) => [k, Deno.env.get(k)]));
  enterClient(undefined);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    resetRoots();
  }
}

const north: Client = {
  id: "north",
  title: "North Example Co",
  path: "/srv/example/north-repo",
  fleet: "harbor",
  added: "2026-11-01",
};
const south: Client = {
  id: "south",
  title: "South Example Co",
  path: "/srv/example/south-repo",
  fleet: "summit",
  added: "2026-11-01",
};

Deno.test("082: a client's scope moves every per-user folder; two clients never share one", async () => {
  await bare(async () => {
    const plain = { state: P.state, secrets: P.secrets };
    const seen: Record<string, { repo: string; fleet: string; state: string; secrets: string }> =
      {};
    for (const c of [north, south]) {
      await withClient(c, () => {
        seen[c.id] = { repo: P.repo, fleet: P.fleetId, state: P.state, secrets: P.secrets };
        return Promise.resolve();
      });
    }
    assertEquals(seen.north.repo, north.path);
    assertEquals(seen.north.fleet, "harbor");
    assertEquals(seen.south.fleet, "summit");
    for (const id of ["north", "south"]) {
      assertStringIncludes(seen[id].state, join("stolos", "clients", id, "state"));
      assertStringIncludes(seen[id].secrets, join("stolos", "clients", id, "secrets"));
    }
    for (const k of ["state", "secrets"] as const) {
      assert(!overlaps(seen.north[k], seen.south[k]), `${k} shared`);
      assert(!overlaps(seen.north[k], plain[k]), `${k} shared with no client's`);
    }
    // Leaving the scope puts the paths back.
    assertEquals(P.secrets, plain.secrets);
    assertEquals(activeClient(), undefined);
    // A client id that is not one is refused (it names folders).
    Deno.env.set("ARCHON_CLIENT", "../x");
    let threw = false;
    try {
      P.secrets;
    } catch {
      threw = true;
    }
    Deno.env.delete("ARCHON_CLIENT");
    assert(threw, "a bad ARCHON_CLIENT was accepted");
  });
});

Deno.test("082: work for two clients at once never sees the other's paths", async () => {
  await bare(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const read = (c: Client) =>
      withClient(c, async () => {
        const out: string[] = [];
        for (let i = 0; i < 5; i++) {
          out.push(P.repo, P.secrets);
          await tick();
          // Work for the same client may overlap (a page and the facts it reads).
          await withClient(c, async () => (await tick(), out.push(P.repo)));
        }
        return out;
      });
    const [a, b] = await Promise.all([read(north), read(south), read(north)]);
    assert(a.every((p) => p.includes("north")), a.join("\n"));
    assert(b.every((p) => p.includes("south")), b.join("\n"));
  });
});

Deno.test("082: the registry: one checkout per client, ids, and the provider's own file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repo = join(dir, "north-repo");
    for (const f of ["harbor", "dock"]) {
      await Deno.mkdir(join(repo, "fleets", f), { recursive: true });
      await Deno.writeTextFile(join(repo, "fleets", f, "fleet.ts"), "export default {};\n");
    }
    let r = planAdd([], { path: repo });
    assert("error" in r && r.error.includes("more than one fleet"), JSON.stringify(r));
    r = planAdd([], { path: repo, fleet: "nope" });
    assert("error" in r && r.error.includes("no fleet nope"));
    r = planAdd([], { path: repo, fleet: "harbor", id: "North!" });
    assert("error" in r && r.error.includes("not a client id"));
    r = planAdd([], { path: repo, fleet: "harbor", id: "north", today: "2026-11-15" });
    assert("client" in r);
    const c = r.client;
    assertEquals(c, {
      id: "north",
      title: "north",
      path: repo,
      fleet: "harbor",
      added: "2026-11-15",
    });
    // The same checkout (or one inside it) cannot be a second client.
    for (const path of [repo, join(repo, "fleets", "..")]) {
      const again = planAdd([c], { path, fleet: "dock", id: "other" });
      assert("error" in again && again.error.includes("client north's checkout"), path);
    }
    assert("error" in planAdd([c], { path: repo, fleet: "dock", id: "north" }));
    const file = join(dir, "provider", "clients.json");
    await saveClients([c], file);
    assertEquals(await loadClients(file), [c]);
    assertEquals(await loadClients(join(dir, "none.json")), []);
    await Deno.writeTextFile(file, JSON.stringify({ format: "other", clients: [] }));
    let threw = false;
    await loadClients(file).catch(() => (threw = true));
    assert(threw);
    // Reports never go inside a client's checkout.
    assert("error" in reportFolder(join(repo, "reports"), [c]));
    assert("dir" in reportFolder(join(dir, "reports"), [c]));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Every key in a summary, and the only ones it may have. */
const SUMMARY_KEYS = new Set([
  "client",
  "title",
  "readable",
  "problem",
  "controls",
  "machines",
  "drift",
  "lastObservation",
  "poamOpen",
  "evidenceBundle",
  "asOf",
  "pass",
  "fail",
  "partial",
  "noEvidence",
  "stale",
  "since",
  "changed",
  "worse",
]);

function onlyAggregates(s: unknown): string[] {
  const bad: string[] = [];
  const walk = (x: unknown, at: string) => {
    if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) {
        if (!SUMMARY_KEYS.has(k)) bad.push(`${at}.${k}`);
        walk(v, `${at}.${k}`);
      }
    } else if (
      typeof x === "string" && !["title", "client", "problem"].includes(at.split(".").pop()!)
    ) {
      if (!/^\d{4}-\d\d-\d\d(T[\d:.]+Z)?$/.test(x)) bad.push(`${at}=${x}`);
    }
  };
  walk(s, "");
  return bad;
}

Deno.test("082: a client's summary is numbers and dates only", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  const view = fleetFreshView(FACTS, undefined, { now });
  const s = summarize(north, view, {
    machines: FACTS.machines.length,
    drift: { since: "2026-11-14T12:00:00.000Z", changed: 2, worse: 1 },
    openRisks: 1,
    openVulnerabilities: 2,
    evidenceBundle: "2026-11-10",
    now: new Date(now),
  });
  assertEquals(onlyAggregates(s), []);
  const text = JSON.stringify(s);
  for (const m of FACTS.machines) assert(!text.includes(m.name), `${m.name} is in the summary`);
  assert(!text.includes(FACTS.fleet.title));
  assert(s.controls.fail > 0 && s.poamOpen >= s.controls.fail, text);
  assertEquals(
    s.controls.pass + s.controls.fail + s.controls.partial + s.controls.noEvidence,
    view.controls.length,
  );
});

Deno.test({
  name: "082: two client repositories: add, scope, summary, reports, and bundles never mix",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sb = await sandbox("archon-clients-");
    try {
      const n = await clientRepo(sb.home, {
        fleet: "harbor",
        title: "Harbor Example fleet",
        signer: "nina-daily",
      });
      const s = await clientRepo(sb.home, {
        fleet: "summit",
        title: "Summit Example fleet",
        signer: "sam-daily",
      });
      const stolos = (args: string[]) => sb.run("src/stolos/main.ts", args);
      let r = await stolos(["clients", "add", n.repo, "--id", "north"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "added client north (Harbor Example fleet)");
      r = await stolos(["clients", "add", join(n.repo, "fleets"), "--id", "other"]);
      assert(r.code !== 0, r.out);
      r = await stolos(["clients", "add", s.repo, "--id", "south", "--title", "South Example Co"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["clients", "list", "--json"]);
      const reg = JSON.parse(r.out.slice(r.out.indexOf("{")));
      assertEquals(reg.clients.map((c: Client) => c.id), ["north", "south"]);
      // The registry is the provider's own file, in no client's repository.
      const file = join(sb.home, "config", "stolos", "clients.json");
      assertStringIncludes(await Deno.readTextFile(file), "stolos-clients/1");
      for (const repo of [n.repo, s.repo]) {
        assertEquals((await sh(["git", "status", "--porcelain"], repo)).trim(), "", repo);
      }
      r = await stolos(["--client", "nobody", "validate"]);
      assertEquals(r.code, 2, r.out);
      assertStringIncludes(r.out, "no client nobody");
      r = await stolos(["--client", "north", "clients", "list"]);
      assertEquals(r.code, 2, r.out);

      // A bundle for north: north's paths, north's signer; nothing of south.
      r = await stolos([
        "--client",
        "north",
        "evidence",
        "export",
        "--from",
        "2026-11-01",
        "--to",
        "2026-11-30",
        "--key",
        n.key,
      ]);
      assertEquals(r.code, 0, r.out);
      const bundle = join(
        sb.home,
        "data",
        "stolos",
        "clients",
        "north",
        "state",
        "harbor",
        "evidence",
        "harbor-evidence-2026-11-01-to-2026-11-30.zip",
      );
      const files = unzipSync(await Deno.readFile(bundle));
      const all = Object.entries(files).map(([k, v]) => `${k}\n${dec.decode(v)}`).join("\n");
      assertStringIncludes(all, "nina-daily");
      assertStringIncludes(all, n.pub.split(" ")[1]);
      for (
        const x of ["summit", "Summit Example", "South Example", "sam-daily", s.pub.split(" ")[1]]
      ) {
        assert(!all.includes(x), `north's bundle holds ${x}`);
      }
      // Signers never mix: north's key is not one of south's signers.
      r = await stolos([
        "--client",
        "south",
        "evidence",
        "export",
        "--from",
        "2026-11-01",
        "--to",
        "2026-11-30",
        "--key",
        n.key,
      ]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "is not one of the fleet's signers");
      const southBundles = join(sb.home, "data", "stolos", "clients", "south", "state");
      assert(
        !(await Deno.stat(join(southBundles, "summit", "evidence")).then(() => true, () => false)),
        "a refused bundle left a folder",
      );

      // The summary: both clients, numbers only.
      r = await stolos(["clients", "summary", "--json"]);
      assertEquals(r.code, 0, r.out);
      const sum = JSON.parse(r.out.slice(r.out.indexOf("{\n")));
      assertEquals(sum.clients.map((c: ClientSummary) => c.client), ["north", "south"]);
      for (const c of sum.clients as ClientSummary[]) {
        assert(c.readable, JSON.stringify(c));
        assertEquals(onlyAggregates(c), [], JSON.stringify(c));
      }
      assertEquals(sum.clients[0].evidenceBundle?.length, 10);
      assertEquals(sum.clients[1].evidenceBundle, undefined);

      // Reports: one folder per client, each with that client's data only; never in a checkout.
      r = await stolos(["clients", "report", "--out", join(n.repo, "reports")]);
      assertEquals(r.code, 1, r.out);
      const out = join(sb.home, "reports");
      r = await stolos(["clients", "report", "--out", out]);
      assertEquals(r.code, 0, r.out);
      const folder = async (id: string) => {
        let text = "";
        for await (const e of Deno.readDir(join(out, id))) {
          text += await Deno.readTextFile(join(out, id, e.name));
        }
        return text;
      };
      const nt = await folder("north"), st = await folder("south");
      assertStringIncludes(nt, "Harbor Example fleet");
      assertStringIncludes(st, "South Example Co");
      for (const x of ["South Example", "summit", '"south"']) assert(!nt.includes(x), x);
      for (const x of ["Harbor Example", "harbor", '"north"']) assert(!st.includes(x), x);
      const top = JSON.parse(await Deno.readTextFile(join(out, "summary.json")));
      for (const c of top.clients) assertEquals(onlyAggregates(c), []);

      // clients use: the chosen client is every command's, until cleared; --client still wins.
      r = await stolos(["clients", "use", "south"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["clients", "list"]);
      assertStringIncludes(r.out, "* south");
      r = await stolos(["fleet", "use", "summit"]);
      assertStringIncludes(r.out, "client south");
      assertStringIncludes(r.out, s.repo);
      r = await stolos(["--client", "north", "fleet", "use", "harbor"]);
      assertStringIncludes(r.out, n.repo);
      r = await stolos(["clients", "use", "--clear"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["clients", "remove", "south"]);
      assertEquals(r.code, 0, r.out);
      assert(await Deno.stat(s.repo).then(() => true), "remove deleted the checkout");
    } finally {
      await Deno.remove(sb.home, { recursive: true });
    }
  },
});

/** A fake client console: the fake fleet under another title, with its own sessions. */
async function fakeClient(c: Client, fleetTitle: string): Promise<ClientConsole> {
  const sessions = new Sessions();
  const facts = structuredClone(FACTS);
  facts.fleet = { ...facts.fleet, id: c.fleet, title: fleetTitle };
  const { handler } = await fakeConsole(8097, {
    sessions,
    facts: () => Promise.resolve(structuredClone(facts)),
    scope: { label: c.title, href: "/clients" },
  });
  return { sessions, handler: (req) => handler(req) };
}

Deno.test("082: the provider's console: a session sees one client; switching re-scopes", async () => {
  const consoles: Record<string, ClientConsole> = {
    north: await fakeClient(north, "Harbor fleet"),
    south: await fakeClient(south, "Summit fleet"),
  };
  const sums: ClientSummary[] = [north, south].map((c) => ({
    client: c.id,
    title: c.title,
    readable: true,
    controls: { pass: 3, fail: 1, partial: 0, noEvidence: 2, stale: 0 },
    machines: 4,
    poamOpen: 1,
    asOf: "2026-11-15T12:00:00.000Z",
  }));
  const launch = new Launch();
  const h = providerHandler({
    port: 8097,
    person: { user: "alice", name: "Alice Example" },
    launch,
    sessions: new Sessions(),
    clients: () => Promise.resolve([north, south]),
    summaries: () => Promise.resolve(sums),
    consoleFor: (c) => Promise.resolve(consoles[c.id]),
    cacheDir: await Deno.makeTempDir(),
  });
  const base = "http://127.0.0.1:8097";
  const get = (path: string, cookie = "", extra: HeadersInit = {}) =>
    h(new Request(base + path, { headers: { host: "127.0.0.1:8097", cookie, ...extra } }));
  const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];
  const signIn = async () => cookieOf(await get(`/launch?t=${launch.issue()}`));
  const sw = (cookie: string, id: string) =>
    h(
      new Request(base + "/clients/switch", {
        method: "POST",
        headers: {
          host: "127.0.0.1:8097",
          cookie,
          origin: base,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `id=${id}`,
      }),
    );
  const text = async (r: Response) => await r.text();

  assertEquals((await get("/clients")).status, 401);
  assertEquals((await get("/clients", "", { host: "evil.example:8097" })).status, 421);
  const c0 = await signIn();
  // The summary: both clients, their numbers, a switch each.
  let r = await get("/clients", c0);
  assertEquals(r.status, 200);
  const page = await text(r);
  for (const t of ["North Example Co", "South Example Co", 'action="/clients/switch"']) {
    assertStringIncludes(page, t);
  }
  for (const t of ["Harbor fleet", "Summit fleet", "alice-mbp"]) assert(!page.includes(t), t);
  // No client chosen: no client's pages, no client's API.
  r = await get("/", c0);
  assertEquals([r.status, r.headers.get("location")], [303, "/clients"]);
  assertEquals((await get("/v1/device", c0)).status, 409);
  const api = await (await get("/v1/clients", c0)).json();
  assertEquals(api.clients.length, 2);
  for (const c of api.clients) assertEquals(onlyAggregates(c), []);

  // Switch to north: a new session; the old cookie is gone.
  r = await sw(c0, "north");
  assertEquals(r.status, 303);
  const cn = cookieOf(r);
  assert(cn && cn !== c0);
  assertEquals((await get("/clients", c0)).status, 401);
  const north1 = await text(await get("/machines", cn));
  assertStringIncludes(north1, "Harbor fleet");
  assertStringIncludes(north1, "North Example Co");
  for (const t of ["Summit fleet", "South Example Co"]) assert(!north1.includes(t), t);
  assertEquals((await get("/v1/device", cn)).status, 200);

  // Another session switches to south: north's session still sees north only.
  const c1 = await signIn();
  const cs = cookieOf(await sw(c1, "south"));
  const south1 = await text(await get("/", cs));
  assertStringIncludes(south1, "Summit fleet");
  assert(!south1.includes("Harbor fleet"));
  const north2 = await text(await get("/", cn));
  assertStringIncludes(north2, "Harbor fleet");
  assert(!north2.includes("Summit fleet"));

  // Each client's console has its own sessions: north's never opens south's.
  const nId = consoles.north.sessions.create(
    { user: "alice", name: "Alice Example", groups: ["archon-ops"] },
    "test",
  ).id;
  r = await consoles.south.handler(
    new Request(base + "/", {
      headers: { host: "127.0.0.1:8097", cookie: `stolos_session=${nId}` },
    }),
  );
  assertEquals(r.status, 401);

  // Re-scoping north's session to south: a new cookie; the north one stops working.
  const cs2 = cookieOf(await sw(cn, "south"));
  assertEquals((await get("/", cn)).status, 401);
  assertStringIncludes(await text(await get("/", cs2)), "Summit fleet");
  // A switch from another site is refused; an unknown client is 404.
  r = await h(
    new Request(base + "/clients/switch", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8097",
        cookie: cs2,
        origin: "http://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "id=north",
    }),
  );
  assertEquals(r.status, 403);
  assertEquals((await sw(cs2, "nobody")).status, 404);
  // Signing out ends the session.
  r = await h(
    new Request(base + "/signout", {
      method: "POST",
      headers: { host: "127.0.0.1:8097", cookie: cs2, origin: base },
    }),
  );
  assertEquals(r.status, 303);
  assertEquals((await get("/", cs2)).status, 401);
});
