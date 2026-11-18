/**
 * Spec 107-pairing-and-query: the way of joining (the controller is auto-adopted) in the Stolos Console and on the command line, and
 * asking every machine at once (the pool, its cap and limit, the table that fills in as machines answer, AG Grid vendored and
 * pinned).
 *
 * @module
 */

import { sha256 } from "@intellectual-frontiers/commons/ts/kernel";
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { CODE_LISTS } from "../ontology/stolos/mod.ts";
import {
  ANSWER_STATES,
  MACHINE_KINDS,
  PAIRING_STAGES,
  WAYS_OF_JOINING,
} from "../src/archon/ontology.auto.ts";
import {
  CONTROLLER_BADGE,
  JOINED_LABEL,
  joinedMark,
  wayOfJoining,
} from "../src/archon/adopt/joining.ts";
import { machineSource } from "../src/archon/adopt/adopt.ts";
import { controllerDef } from "../src/archon/adopt/controller.ts";
import {
  answeredLine,
  askAll,
  type AskTarget,
  QUERY_CAP,
  QUERY_TIMEOUT_S,
  tableRows,
} from "../src/archon/adopt/query.ts";
import { AG_GRID } from "../src/archon/console/assets.ts";
import { tableItem, tableMarkup, tableScript } from "../src/archon/console/table.ts";
import { machinesCsv } from "../src/archon/console/stolos-pages.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { FACTS, fakeConsole } from "./console/serve-stolos.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";

const PORT = 8092;
const B = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/** The fake console, signed in. */
async function signedIn() {
  const { handler, launch } = await fakeConsole(PORT);
  const r = await handler(
    new Request(`${B}/launch?t=${launch.issue()}`, { headers: { host: `127.0.0.1:${PORT}` } }),
  );
  assertEquals(r.status, 303);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const get = (p: string): Promise<Response> =>
    handler(new Request(B + p, { headers: { host: `127.0.0.1:${PORT}`, cookie } }));
  const post = (p: string, body: Record<string, string>): Promise<Response> =>
    handler(
      new Request(B + p, {
        method: "POST",
        headers: { host: `127.0.0.1:${PORT}`, cookie, origin: B, "datastar-request": "true" },
        body: new URLSearchParams(body),
      }),
    );
  return { get, post };
}

// ------------------------------------------------------------------------------ FR-007: the way of joining

proves(
  ["107-pairing-and-query FR-007"],
  "107: a machine's way of joining is the ontology's, derived from what it is and what its declaration records",
  () => {
    assertEquals(
      [...WAYS_OF_JOINING],
      ["auto-adopted", "paired", "integrated", "integration", "managed", "cloud"],
      "the ontology's order",
    );
    assertEquals(Object.keys(CODE_LISTS.WayOfJoining.list), [...WAYS_OF_JOINING]);
    assertEquals([...PAIRING_STAGES], ["hello", "installing", "waiting", "adopted", "refused"]);
    assertEquals([...ANSWER_STATES], ["asking", "answered", "failed", "skipped", "timed-out"]);
    for (const k of MACHINE_KINDS) {
      // Every kind is classified (the discovered one has joined nowhere yet).
      const w = wayOfJoining({ kind: k });
      assertEquals(w === undefined, k === "discovered", k);
    }
    assertEquals(wayOfJoining({ kind: "controller" }), "auto-adopted");
    assertEquals(wayOfJoining({ kind: "adopted", role: "controller" }), "auto-adopted");
    assertEquals(wayOfJoining({ kind: "adopted", joined: "paired" }), "paired");
    assertEquals(wayOfJoining({ kind: "adopted", joined: "integrated" }), "integrated");
    assertEquals(wayOfJoining({ kind: "adopted" }), "integrated", "an older declaration");
    assertEquals(wayOfJoining({ kind: "device" }), "integrated");
    assertEquals(wayOfJoining({ kind: "server" }), "managed");
    assertEquals(wayOfJoining({ kind: "workstation" }), "managed");
    assertEquals(wayOfJoining({ kind: "cloud" }), "cloud");
    assertEquals(wayOfJoining({ kind: "discovered" }), undefined);
    for (const w of WAYS_OF_JOINING) assert(JOINED_LABEL[w], w);
    assertStringIncludes(joinedMark("auto-adopted"), "needs no pairing");
    assertStringIncludes(joinedMark("auto-adopted"), "local probe");
    assertEquals(joinedMark(undefined), "not joined yet");
    // machine.ts records how a machine joined, and the declaration reads back.
    assertStringIncludes(
      machineSource({
        name: "alice-laptop",
        ssh: { user: "alice", address: "10.0.0.7" },
        hostKeys: [],
        adopted: "2026-11-17",
        joined: "paired",
      }),
      'joined: "paired"',
    );
  },
);

// ------------------------------------------------------------------------------ FR-008: the Stolos Console

proves(
  ["107-pairing-and-query FR-008"],
  "107: the machines page pins this PC first in a This PC group with the controller's badge, and has the How it joined column and filter",
  async () => {
    const { get } = await signedIn();
    const page = await (await get("/machines")).text();
    assertStringIncludes(page, "<th>How it joined</th>");
    assertStringIncludes(page, `<option value="auto-adopted">Auto-adopted</option>`);
    for (const w of WAYS_OF_JOINING) assertStringIncludes(page, `<option value="${w}">`);
    assertStringIncludes(page, "data-bind:joined");
    assertStringIncludes(page, `>${CONTROLLER_BADGE}</span>`);
    // The group comes first, holds this PC, and the others follow.
    const pc = page.indexOf('id="this-pc"');
    assert(pc > 0, "the This PC group");
    assertStringIncludes(page, ">This PC</th>");
    const names = [...page.matchAll(/<a href="\/machines\/([^"]+)"><b>/g)].map((m) => m[1]);
    assertEquals(names[0], "lab-pc", "pinned first");
    assert(page.indexOf("/machines/lab-pc") < page.indexOf("/machines/alpha"));
    assertStringIncludes(page, ">Other machines</th>");
    // Each row carries the way it joined, which the filter reads.
    for (const [name, way] of [
      ["alpha", "managed"],
      ["alice-mbp", "paired"],
      ["bob-desk", "integrated"],
      ["scratch", "cloud"],
      ["lab-pc", "auto-adopted"],
    ] as const) {
      const row = page.slice(
        page.indexOf(`/machines/${name}"`),
        page.indexOf("</tr>", page.indexOf(`/machines/${name}"`)),
      );
      assertStringIncludes(row, `data-joined="${way}"`, name);
    }
    // The CSV carries it.
    const csv = machinesCsv(FACTS);
    assertStringIncludes(csv.split("\r\n")[0] ?? "", "kind,how_it_joined,os");
    assertStringIncludes(csv, "lab-pc,");
    assertStringIncludes(csv, ",auto-adopted,");
  },
);

proves(
  ["107-pairing-and-query FR-008"],
  "107: the controller's page says it needs no pairing and is observed by the local probe, and its Release and Remove are disabled with the reason; another machine's Release is a link",
  async () => {
    const { get, post } = await signedIn();
    const page = await (await get("/machines/lab-pc")).text();
    assertStringIncludes(page, "needs no pairing");
    assertStringIncludes(page, "observed by the local probe");
    assertStringIncludes(page, `>${CONTROLLER_BADGE}</h3>`);
    // Both actions are there, disabled, each with the reason as its title.
    const buttons = [...page.matchAll(/<button[^>]*disabled[^>]*>\s*(Release|Remove)/g)].map(
      (m) => m[1],
    );
    assertEquals(buttons, ["Release", "Remove"]);
    assertStringIncludes(page, "aria-disabled=");
    assertStringIncludes(page, "It is not released or removed here");
    assert(!page.includes("cmd=host%20release"), "no link to release it");
    const mbp = await (await get("/machines/alice-mbp")).text();
    assertStringIncludes(mbp, "/actions/adopted?cmd=host%20release&name=alice-mbp");
    assert(!/<button[^>]*disabled/.test(mbp), "nothing is disabled on another machine");
    // The console refuses to run `host release` of the controller, whoever asks.
    const run = await (
      await post("/actions/run", { command: "host release", name: "lab-pc" })
    ).text();
    assertStringIncludes(run, "It is not released or removed here");
    const ok = await (
      await post("/actions/run", { command: "host release", name: "alice-mbp" })
    ).text();
    assert(!ok.includes("not released or removed"), "another machine's is run as usual");
  },
);

// ------------------------------------------------------------------------------ FR-010, FR-011: the pool

/** A target that answers after `ms`, or fails, or never answers; it records when it started and ended. */
function target(
  machine: string,
  how: { ms?: number; fail?: string; hang?: boolean; rows?: number },
  trace: { inFlight: number; peak: number; started: string[]; aborted: string[] },
): AskTarget {
  return {
    machine,
    kind: "adopted",
    ask: async (signal) => {
      trace.started.push(machine);
      trace.inFlight++;
      trace.peak = Math.max(trace.peak, trace.inFlight);
      try {
        await new Promise<void>((ok) => {
          const t = setTimeout(ok, how.hang ? 60_000 : (how.ms ?? 5));
          signal.addEventListener(
            "abort",
            () => {
              trace.aborted.push(machine);
              clearTimeout(t);
              ok();
            },
            { once: true },
          );
        });
        if (how.fail) throw new Error(how.fail);
        return Array.from({ length: how.rows ?? 1 }, (_x, i) => ({ n: i }));
      } finally {
        trace.inFlight--;
      }
    },
  };
}

proves(
  ["107-pairing-and-query FR-010", "107-pairing-and-query FR-011"],
  "107: every machine is asked at once, at most 8 at a time, each with its own limit; each answers once, in the order it arrives, with its reason when it fails or times out",
  async () => {
    assertEquals([QUERY_CAP, QUERY_TIMEOUT_S], [8, 15]);
    const trace = { inFlight: 0, peak: 0, started: [] as string[], aborted: [] as string[] };
    // Twelve machines: the cap holds at 8, and the rest start as places free up (not group after group).
    const many = Array.from({ length: 12 }, (_x, i) =>
      target(`m${String(i).padStart(2, "0")}`, { ms: 40 }, trace),
    );
    const seen: string[] = [];
    let started: string[] = [];
    const answers = await askAll(many, {
      onStart: (ms) => (started = ms.map((m) => m.machine)),
      onAnswer: (a) => seen.push(a.machine),
    });
    assertEquals(trace.peak, 8, "at most 8 at the same time, and 8 of them at once");
    assertEquals(started.length, 12);
    assertEquals(answers.length, 12);
    assertEquals(seen.length, 12);
    assertEquals(
      answers.map((a) => a.machine),
      [...started].sort(),
      "the result is by name",
    );
    // A slow machine does not hold up a quick one, and a failing and a hanging one still have an answer with a reason.
    const t2 = { inFlight: 0, peak: 0, started: [] as string[], aborted: [] as string[] };
    const order: string[] = [];
    const t0 = Date.now();
    const out = await askAll(
      [
        target("slow", { ms: 300 }, t2),
        target("quick", { ms: 10, rows: 2 }, t2),
        target("broken", { ms: 10, fail: "osquery is not installed here" }, t2),
        target("hung", { hang: true }, t2),
      ],
      { timeoutMs: 600, onAnswer: (a) => order.push(`${a.machine}:${a.state}`) },
    );
    assert(Date.now() - t0 < 5_000, "the hung machine did not hold the others for long");
    assertEquals(order, ["quick:answered", "broken:failed", "slow:answered", "hung:timed-out"]);
    assertEquals(
      out.map((a) => [a.machine, a.state]),
      [
        ["broken", "failed"],
        ["hung", "timed-out"],
        ["quick", "answered"],
        ["slow", "answered"],
      ],
    );
    assertEquals(out.find((a) => a.machine === "broken")?.error, "osquery is not installed here");
    assertStringIncludes(out.find((a) => a.machine === "hung")?.error ?? "", "no answer in 1 s");
    assertEquals(t2.aborted, ["hung"], "the machine's work is stopped when its limit passes");
    assertEquals(answeredLine(out), "2 of 4 answered");
    assertEquals(answeredLine(out.slice(0, 2), 4), "0 of 4 answered");
    // One merged table: a row per result row, and a row for each machine without rows, with its reason.
    const rows = tableRows(out);
    assertEquals(
      rows.map((r) => [r["machine"], r["answer"], r["reason"] ?? ""].map(String).join("|")),
      [
        "broken|failed|osquery is not installed here",
        "hung|timed-out|no answer in 1 s",
        "quick|answered|",
        "quick|answered|",
        "slow|answered|",
      ],
    );
    // No machine at all is no answer, not an error.
    assertEquals(await askAll([]), []);
  },
);

proves(
  ["107-pairing-and-query FR-010"],
  "107: fleet query has --timeout, and refuses a nonsense one",
  async () => {
    const q = COMMANDS.find((c) => c.name === "fleet query");
    assert(q, "fleet query");
    assert(q.args.some((a) => a.name === "timeout"));
    assertStringIncludes(q.description, "at once");
    assertStringIncludes(q.description, "N of M answered");
    for (const bad of ["0", "-3", "abc", "601"]) {
      let said = "";
      try {
        await q.run({ sql: "select 1", timeout: bad }, {} as never);
      } catch (e) {
        said = (e as Error).message;
      }
      assertStringIncludes(said, "--timeout", bad);
    }
  },
);

proves(
  ["107-pairing-and-query FR-011", "107-pairing-and-query FR-012"],
  "107: the console's table fills in as machines answer: a row for each machine at once, each replaced by its answer, failures with their reasons, and N of M answered",
  async () => {
    const { post } = await signedIn();
    const res = await post("/query/run", { sql: "select name, version from os_version" });
    assertEquals(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    const changes = [...text.matchAll(/payload="([^"]*)"/g)].map(
      (m) =>
        JSON.parse((m[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as {
          op: string;
          rows?: Array<Record<string, unknown>>;
          remove?: string[];
        },
    );
    assertEquals(changes[0]?.op, "reset");
    // All five machines appear at once, asking; then each answer replaces its row, in the order they came.
    const asking = changes[1]?.rows ?? [];
    assertEquals(asking.map((r) => [r["machine"], r["answer"]].map(String).join(":")).sort(), [
      "alice-mbp:asking",
      "alpha:asking",
      "bob-desk:asking",
      "front-pc:asking",
      "lab-pc:asking",
    ]);
    const arrived = changes
      .slice(2)
      .map((c) => [c.rows?.[0]?.["machine"], c.rows?.[0]?.["answer"]]);
    assertEquals(arrived, [
      ["bob-desk", "failed"],
      ["lab-pc", "answered"],
      ["alpha", "answered"],
      ["alice-mbp", "answered"],
      ["front-pc", "timed-out"],
    ]);
    const bob = changes[2];
    assertEquals(bob?.remove, ["ask:bob-desk"]);
    assertEquals(bob?.rows?.[0]?.["reason"], "osquery is not installed here");
    assertStringIncludes(String(changes.at(-1)?.rows?.[0]?.["reason"]), "no answer in");
    // The line says how many answered, as it goes and at the end.
    assertStringIncludes(text, `id="summary"`);
    assertStringIncludes(text, "0 of 5 answered");
    assertStringIncludes(text, "3 of 5 answered");
    assertStringIncludes(text, "2 failed or did not answer in time");
    assertStringIncludes(text, "Answered, with machines that did not answer");
    // A refused question says why and asks nobody.
    const refused = await (await post("/query/run", { sql: "select * from shadow" })).text();
    assertStringIncludes(refused, "never served");
    assertStringIncludes(refused, "Refused or failed");
    assert(!refused.includes('payload="'), "nothing was asked");
  },
);

// ------------------------------------------------------------------------------ FR-012, FR-013: AG Grid and its wrapper

proves(
  ["107-pairing-and-query FR-012"],
  "107: AG Grid Community is vendored, pinned by its SHA-256 with its licence, served by the console itself, and never loaded from another site",
  async () => {
    const file = await fs.readFile(path.join(ROOT, AG_GRID.path));
    assertEquals(String(await sha256(file)), AG_GRID.sha256, "the pinned build");
    const licence = await fs.readTextFile(path.join(ROOT, AG_GRID.license.path));
    assertStringIncludes(licence, "The MIT License");
    assertEquals(
      String(await sha256(new TextEncoder().encode(licence))),
      AG_GRID.license.sha256,
      "the pinned licence",
    );
    const readme = await fs.readTextFile(path.join(ROOT, "vendor/ag-grid/README"));
    assertStringIncludes(readme, "sha512-");
    assertStringIncludes(readme, AG_GRID.version);
    // The console serves both from this machine (the same bytes), with the type a browser runs.
    const { get } = await signedIn();
    const js = await get(AG_GRID.url);
    assertEquals(js.status, 200);
    assertStringIncludes(js.headers.get("content-type") ?? "", "javascript");
    assertEquals(String(await sha256(new Uint8Array(await js.arrayBuffer()))), AG_GRID.sha256);
    const lic = await get(AG_GRID.license.url);
    assertEquals(lic.status, 200);
    assertStringIncludes(await lic.text(), "AG GRID");
    // The page loads it from itself, and from nowhere else: no script or stylesheet of another site.
    const page = await (await get("/query")).text();
    assertStringIncludes(page, `<script src="${AG_GRID.url}"></script>`);
    for (const m of page.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)) {
      assert(!/^(?:https?:)?\/\//.test(m[1] ?? ""), `a resource from another site: ${m[1]}`);
    }
    // And nothing in the engine's own source names a CDN for it.
    for (const f of ["table.ts", "assets.ts", "stolos-pages.ts"]) {
      const src = await fs.readTextFile(path.join(ROOT, "src/archon/console", f));
      assert(!/cdn\.|unpkg|jsdelivr|cdnjs/i.test(src), `${f} names a CDN`);
    }
    assert(ENGINE_ROOT.length > 0);
  },
);

proves(
  ["107-pairing-and-query FR-013"],
  "107: the wrapper knows nothing of machines: it makes the grid, escapes what it is fed, and offers paging, sorting, filtering, resizing, pinning and CSV",
  () => {
    const marker = tableItem({
      op: "add",
      rows: [{ __id: 'x"><script>alert(1)</script>', a: "<b>" }],
      remove: [],
    }).s;
    assert(!marker.includes("<script>"), "a value cannot become markup");
    assertStringIncludes(marker, "payload=");
    const m = tableMarkup({ id: "t1", label: "Things", csvName: "things", pageSize: 10 }).s;
    assertStringIncludes(m, `id="t1"`);
    assertStringIncludes(m, `aria-label="Things"`);
    assertStringIncludes(m, "tbl-csv");
    assertStringIncludes(m, "tbl-quick");
    for (const needle of [
      "pagination: true",
      "paginationPageSizeSelector",
      "sortable: true",
      "filter: true",
      "resizable: true",
      "pinned: i === 0",
      "exportDataAsCsv",
      "quickFilterText",
      "applyTransaction",
      "MutationObserver",
    ]) {
      assertStringIncludes(m, needle);
    }
    assertEquals(tableScript().s, `<script src="${AG_GRID.url}"></script>`);
    // Nothing of machines in it.
    assert(!/fleet|osquery/i.test(m.replace(/fleet-query/g, "")), "it is a table, not a fleet's");
  },
);

// ------------------------------------------------------------------------------ FR-009, FR-010: the command line

/** The example lab as a fleet repository in a sandbox, with this PC recorded as its controller and an `ssh` that does not answer. */
async function lab(sshBody: string) {
  const sb = await sandbox("stolos-query107-");
  const repo = path.join(sb.home, "fleet");
  await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
  await proc.output([
    "cp",
    "-r",
    path.join(ENGINE_ROOT, "examples/fleets/lab"),
    `${repo}/fleets/lab`,
  ]);
  await linkEngine(repo);
  const bin = path.join(sb.home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeTextFile(path.join(bin, "ssh"), `#!/bin/sh\n${sshBody}\n`, { mode: 0o755 });
  const me = await controllerDef();
  const dir = path.join(repo, "fleets", "lab", "adopted", me.name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeTextFile(path.join(dir, "machine.ts"), machineSource(me));
  const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab", PATH: `${bin}:${proc.env.get("PATH")}` };
  return {
    sb,
    me: me.name,
    stolos: (...args: string[]) => sb.run("src/stolos/main.ts", args, "", env),
  };
}

proves(
  ["107-pairing-and-query FR-009", "107-pairing-and-query FR-007", "097-controller FR-007"],
  "107: fleet status and discover mark the controller as auto-adopted, and the servers as managed",
  async () => {
    const l = await lab(`echo "ssh: connect to host: No route to host" >&2; exit 255`);
    try {
      const st = await l.stolos("fleet", "status");
      assertStringIncludes(st.out, l.me);
      assertStringIncludes(
        st.out,
        "auto-adopted (the controller: needs no pairing, observed by the local probe)",
      );
      assertStringIncludes(st.out, "this PC");
      assertStringIncludes(st.out, "server · managed");
      const d = await l.stolos("discover");
      assertStringIncludes(d.out, "this PC is in the fleet already");
      assertStringIncludes(d.out, "auto-adopted");
      // discover --json keeps its shape: an array.
      const j = await l.stolos("discover", "--json");
      assert(j.out.trim().startsWith("[") || j.out.includes("\n["), j.out);
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "the stand-in ssh is a shell script" },
);

proves(
  ["107-pairing-and-query FR-010", "107-pairing-and-query FR-011"],
  "107: fleet query asks the servers and this PC at once, names the machine that failed or timed out with its reason, and ends with N of M answered",
  async () => {
    // A server that hangs: its limit passes, and the others are not held up for it.
    const l = await lab(`sleep 30`);
    try {
      const t0 = Date.now();
      const r = await l.stolos(
        "fleet",
        "query",
        "select name, version from os_version",
        "--timeout",
        "2",
      );
      assert(Date.now() - t0 < 25_000, "the hung servers did not hold the command");
      // alpha and beta hang (timed out); this PC answers or says why not (osquery may not be installed here).
      assertStringIncludes(r.out, "alpha: timed out: no answer in 2 s");
      assertStringIncludes(r.out, "beta: timed out: no answer in 2 s");
      assertStringIncludes(r.out, "answered");
      assert(/\d of 3 answered/.test(r.out), r.out);
      assertEquals(r.code, 1, "a machine did not answer");
      const j = await l.stolos(
        "--json",
        "fleet",
        "query",
        "select name, version from os_version",
        "--timeout",
        "2",
      );
      const arr: unknown = JSON.parse(j.out.slice(j.out.indexOf("[")));
      assert(Array.isArray(arr) && arr.length === 3, j.out);
      const states = (arr as Array<{ machine: string; state: string; ms: number }>).map((a) => [
        a.machine,
        a.state,
      ]);
      assertEquals(
        states.filter(([, s]) => s === "timed-out").map(([m]) => m),
        ["alpha", "beta"],
      );
      assert((arr as Array<{ ms: number }>).every((a) => typeof a.ms === "number"));
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "the stand-in ssh is a shell script" },
);

// ------------------------------------------------------------------------------ FR-015: what is true now

proves(
  ["107-pairing-and-query FR-015"],
  "107: the guides, the command help and the specs say what is true now: many machines, no expiry, per address, the way of joining",
  async () => {
    const read = (f: string): Promise<string> => fs.readTextFile(path.join(ROOT, f));
    const adopt = await read("src/archon/adopt/mod.ts");
    for (const t of [
      "How a machine joined",
      "Session is open: Ctrl+C closes it",
      "no expiry",
      "less safe than a short one",
      "Wrong codes are counted for each client address",
      "auto-adopted",
      "N of M answered",
    ]) {
      assertStringIncludes(adopt, t);
    }
    assert(
      !/expires in 10 minutes|One machine per code/.test(adopt),
      "the old pairing is gone from the guide",
    );
    const consoleGuide = await read("src/archon/console/mod.ts");
    assertStringIncludes(consoleGuide, "AG Grid Community");
    assertStringIncludes(consoleGuide, "This PC");
    const pair = COMMANDS.find((c) => c.name === "pair");
    assert(pair, "pair");
    assertStringIncludes(pair.description, "Ctrl+C");
    assertStringIncludes(pair.description, "no expiry");
    assertStringIncludes(pair.description, "for each client address");
    assert(!/expires in 10 minutes|One machine per code/.test(pair.description));
    for (const f of ["specs/098-pair/spec.md", "specs/103-three-ports/spec.md"]) {
      const spec = await read(f);
      assertStringIncludes(spec, "107-pairing-and-query");
      assert(
        !/10 minutes|ten minutes|good for one machine/.test(spec),
        `${f} still says the old session`,
      );
    }
    // The Remote Access page says the controller needs no pairing.
    const access = await read("src/archon/access/pages.ts");
    assertStringIncludes(access, "needs no pairing");
  },
);
