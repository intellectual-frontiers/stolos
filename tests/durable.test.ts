/**
 * Spec 044 (Article 23): ephemeral and durable data.
 *
 * @module
 */
import type { Check } from "../src/archon/state/verify.ts";
import { fs, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assertExists,
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
  test,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { fleet, host } from "./fixtures.ts";
import type { DataClass, HostDef, OptInRecord } from "../src/archon/model/types.ts";
import {
  chooseData,
  dataSources,
  describeData,
  durableGuests,
  durablePaths,
  hostData,
} from "../src/archon/model/durable.ts";
import { checkChoice } from "../src/archon/optin/optin.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { validateFleet } from "../src/archon/model/validate.ts";
import { backupPolicy } from "../src/archon/capabilities/backup.ts";
import { destroyRefusal, parseData } from "../src/archon-boot/reinstall.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { parseArgs } from "../src/archon/core/registry-types.ts";
import { handle, toolFor } from "../src/archon/mcp/server.ts";
import { renderWelcome } from "../src/archon/web/welcome.ts";
import { ENGINE_ROOT, sandbox } from "./sandbox.ts";
import { path } from "@intellectual-frontiers/ifc-ts/runtime";

const rec = (enabled: boolean, data?: DataClass): OptInRecord => ({
  enabled,
  by: "alice",
  at: "2026-11-13T12:00:00Z",
  ...(data ? { data } : {}),
});
const withOptIn = (optIn: Record<string, OptInRecord>, over: Partial<HostDef> = {}) =>
  host({ optIn, ...over });

proves(["044-durable FR-003"], "044: a server with nothing on is ephemeral", () => {
  const d = hostData(host());
  assertEquals([d.class, d.reasons, d.sources], ["ephemeral", [], []]);
  assertEquals(describeData(d), "ephemeral");
});

proves(["044-durable FR-003"], "044: the class follows every source's choice; durable wins", () => {
  assertEquals(hostData(withOptIn({ pg: rec(true, "ephemeral") })).class, "ephemeral");
  const d = hostData(withOptIn({ pg: rec(true, "ephemeral"), s3: rec(true, "durable") }));
  assertEquals([d.class, d.reasons], ["durable", ["S3"]]);
  assertEquals(describeData(d), "durable (S3)");
  const all = hostData(withOptIn({ pg: rec(true, "durable"), smb: rec(true, "durable") }));
  assertEquals(all.reasons, ["PostgreSQL", "SMB shares"]);
});

proves(
  ["044-durable FR-003"],
  "044: a missing choice counts as durable, and says how to record one",
  () => {
    const d = hostData(withOptIn({ pg: rec(true) }));
    assertEquals(d.class, "durable");
    assertStringIncludes(d.reasons[0] ?? "", "no choice recorded");
    assertEquals(
      d.unchosen.map((u) => u.name),
      ["pg"],
    );
    assertStringIncludes(d.unchosen[0]?.fix ?? "", "archon data set pg --durable");
  },
);

proves(
  ["044-durable FR-002", "044-durable FR-003"],
  "044: turned off keeps its data, so it keeps its class; never on means no source",
  () => {
    assertEquals(hostData(withOptIn({ s3: rec(false, "durable") })).class, "durable");
    assertEquals(dataSources(withOptIn({ smb: rec(false) })), []);
    assertEquals(hostData(withOptIn({ smb: rec(false) })).class, "ephemeral");
  },
);

proves(
  ["044-durable FR-001", "044-durable FR-002"],
  "044: guests carry their own choice; the model requires it",
  () => {
    const h = host({
      guests: [
        { name: "db", kind: "container", image: "ubuntu:26.04", data: "durable" },
        { name: "scratch", kind: "container", image: "ubuntu:26.04", data: "ephemeral" },
      ],
    });
    assertEquals([hostData(h).class, hostData(h).reasons], ["durable", ["guest db"]]);
    assertEquals(durableGuests(h), ["db"]);
    const bad = validateFleet(fleet(), [
      host({
        guests: [{ name: "g", kind: "container", image: "ubuntu:26.04" } as never],
      }),
    ]);
    assert(
      bad.some((p) => p.message.includes('guest g: data must be "durable" or "ephemeral"')),
      "a guest without a choice fails the build",
    );
  },
);

proves(
  ["044-durable FR-002"],
  "044: the choice is forced: neither or both is a usage error",
  () => {
    let msg = "";
    try {
      chooseData({}, "PostgreSQL's data");
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "--durable");
    assertStringIncludes(msg, "--ephemeral");
    assertStringIncludes(msg, "no default");
    assertThrows(() => chooseData({ durable: true, ephemeral: true }, "x"));
    assertEquals(chooseData({ durable: true }, "x"), "durable");
    assertEquals(chooseData({ ephemeral: true }, "x"), "ephemeral");
  },
);

proves(
  ["044-durable FR-002"],
  "044: every command that turns on end users' data refuses without a choice",
  async () => {
    for (const name of ["pg on", "fs s3 on", "fs smb on", "data set"]) {
      const c = COMMANDS.find((x) => x.name === name);
      assertExists(c);
      assert(
        c.args.some((a) => a.name === "durable") && c.args.some((a) => a.name === "ephemeral"),
      );
      const args = parseArgs(c, name === "data set" ? ["pg"] : []);
      let msg = "";
      try {
        await c.run(args, { hostName: "nowhere", json: false });
      } catch (e) {
        msg = (e as Error).message;
      }
      assertStringIncludes(msg, "choose --durable or --ephemeral", name);
    }
  },
);

proves(
  ["044-durable FR-004"],
  "044: durable to ephemeral needs --confirm-destroy naming the host",
  () => {
    const h = withOptIn({ pg: rec(true, "durable"), s3: rec(true) });
    assertThrows(
      () => checkChoice(h, "pg", "ephemeral", undefined),
      Error,
      "--confirm-destroy alpha",
    );
    assertThrows(() => checkChoice(h, "pg", "ephemeral", "rome"), Error, "does not name alpha");
    checkChoice(h, "pg", "ephemeral", "alpha");
    // No choice recorded counts as durable.
    assertThrows(() => checkChoice(h, "s3", "ephemeral", undefined), Error, "--confirm-destroy");
    // Toward durable, or a first choice, needs nothing.
    checkChoice(h, "pg", "durable", undefined);
    checkChoice(host(), "smb", "ephemeral", undefined);
    checkChoice(withOptIn({ smb: rec(true, "ephemeral") }), "smb", "ephemeral", undefined);
  },
);

proves(
  ["044-durable FR-005"],
  "044: --confirm-destroy is typed by a person: refused from an agent and absent over MCP",
  async () => {
    const c = COMMANDS.find((x) => x.name === "data set");
    assertExists(c);
    const prev = proc.env.get("ARCHON_AGENT");
    proc.env.set("ARCHON_AGENT", "mcp");
    try {
      assertThrows(
        () => parseArgs(c, ["pg", "--ephemeral", "--confirm-destroy", "alpha"]),
        Error,
        "typed by a person",
      );
      parseArgs(c, ["pg", "--durable"]); // the rest still works for an agent
    } finally {
      if (prev === undefined) proc.env.delete("ARCHON_AGENT");
      else proc.env.set("ARCHON_AGENT", prev);
    }
    for (const cmd of COMMANDS) {
      const props = toolFor(cmd).inputSchema.properties;
      assert(!("confirm-destroy" in props), `${cmd.name} offers --confirm-destroy over MCP`);
    }
    const r = (await handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "archon_data_set",
          arguments: { name: "pg", ephemeral: true, "confirm-destroy": "alpha" },
        },
      },
      "mutate",
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert(r.result.isError);
    assertStringIncludes(r.result.content[0]?.text ?? "", "typed by a person");
  },
);

proves(
  ["044-durable FR-006"],
  "044: reinstall refuses a durable or unknown host without --confirm-destroy",
  () => {
    const durable = { class: "durable", reasons: ["PostgreSQL"] };
    const ephemeral = { class: "ephemeral", reasons: [] };
    const none = undefined as string | undefined;
    assertEquals(destroyRefusal("alpha", ephemeral, none, ""), undefined);
    assertStringIncludes(destroyRefusal("alpha", durable, none, "") ?? "", "durable (PostgreSQL)");
    assertStringIncludes(
      destroyRefusal("alpha", durable, none, "") ?? "",
      "--confirm-destroy alpha",
    );
    assertStringIncludes(destroyRefusal("alpha", undefined, none, "") ?? "", "unknown data class");
    assertStringIncludes(destroyRefusal("alpha", durable, "rome", "") ?? "", "does not name alpha");
    assertEquals(destroyRefusal("alpha", durable, "alpha", ""), undefined);
    assertEquals(destroyRefusal("alpha", undefined, "alpha", ""), undefined);
    assertStringIncludes(
      destroyRefusal("alpha", durable, "alpha", "mcp") ?? "",
      "typed by a person",
    );
    // What the host says over SSH.
    assertEquals(parseData('{"class":"durable","reasons":["S3"]}'), {
      class: "durable",
      reasons: ["S3"],
    });
    assertEquals(parseData("not json"), undefined);
    assertEquals(parseData('{"class":"maybe"}'), undefined);
    assertEquals(parseData(undefined), undefined);
  },
);

proves(
  ["044-durable FR-007"],
  "044: durable buckets and shares join the nightly archive; ephemeral ones do not",
  () => {
    assertEquals(
      durablePaths(withOptIn({ s3: rec(true, "durable"), smb: rec(true, "ephemeral") })),
      ["/srv/s3"],
    );
    const p = backupPolicy(withOptIn({ s3: rec(true, "durable"), smb: rec(true, "durable") }));
    assert(p.paths.includes("/srv/s3") && p.paths.includes("/srv/smb"));
    const e = backupPolicy(withOptIn({ s3: rec(true, "ephemeral"), smb: rec(true, "ephemeral") }));
    assert(!e.paths.includes("/srv/s3") && !e.paths.includes("/srv/smb"));
    // PostgreSQL's dumps are already in the backup target: no extra path.
    assertEquals(durablePaths(withOptIn({ pg: rec(true, "durable") })), []);
  },
);

proves(
  ["044-durable FR-008", "044-durable FR-009"],
  "044: where it shows: /etc/archon/data, the banner, and a warning until an off-host copy exists",
  () => {
    const plain = resolvePlan(host(), fleet());
    assertEquals(plain.files.find((f) => f.path === "/etc/archon/data")?.content, "ephemeral\n");
    assert(!plain.checks.some((c) => c.spec === "044-durable"));
    const banner = plain.files.find((f) => f.path === "/etc/update-motd.d/72-archon-data")?.content;
    assertExists(banner);
    assertStringIncludes(banner, "ephemeral");
    assertStringIncludes(banner, "your home directory is not kept across a reinstall");

    const plan = resolvePlan(withOptIn({ pg: rec(true, "durable") }), fleet());
    assertEquals(plan.files.find((f) => f.path === "/etc/archon/data")?.content, "durable\n");
    const motd = plan.files.find((f) => f.path === "/etc/update-motd.d/72-archon-data")?.content;
    assertExists(motd);
    assertStringIncludes(motd, "durable");
    assertStringIncludes(motd, "PostgreSQL");
    assertStringIncludes(motd, "--confirm-destroy");
    const off = plan.checks.find((c) => c.spec === "044-durable");
    assertExists(off);
    assertEquals(off.level, "warn", "a warning, not a failure, until the destination exists");
    assertStringIncludes(off.command, "none yet");
    assertStringIncludes(off.fix ?? "", "off-host destination");
  },
);

proves(
  ["044-durable FR-009"],
  "044: the prompt reads the class and marks a durable host",
  async () => {
    const { renderEmit } = await import("../src/archon/shell/emit.ts");
    for (const sh of ["bash", "zsh", "fish"] as const) {
      const s = renderEmit(sh);
      assertStringIncludes(s, "/etc/archon/data");
      assertStringIncludes(s, "[durable]");
    }
    const theme = await fs.readTextFile(
      new URL("../src/archon/shell/archon.omp.json", import.meta.url),
    );
    assertStringIncludes(theme, 'eq .Env.ARCHON_DATA \\"durable\\"');
  },
);

proves(
  ["044-durable FR-011"],
  "044: no history: the record holds only the choice, kept when turned off",
  async () => {
    const { writeOptIn } = await import("../src/archon/optin/optin.ts");
    const { readOptIns } = await import("../src/archon/model/load.ts");
    const root = await fs.makeTempDir({ prefix: "archon-durable-" });
    try {
      await writeOptIn("alpha", "s3", true, "alice", root, "durable");
      await writeOptIn("alpha", "s3", false, "alice", root);
      const got = (await readOptIns("alpha", root))["s3"];
      assertEquals([got?.enabled, got?.data], [false, "durable"]);
      const { getRecord } = await import("../src/archon/state/store.ts");
      const raw = (await getRecord<Record<string, unknown>>("alpha", "optin", "s3", root))?.body;
      assertEquals(Object.keys(raw ?? {}).sort(), ["at", "by", "data", "enabled"]);
    } finally {
      await fs.remove(root, { recursive: true });
    }
  },
);

proves(
  ["044-durable FR-003"],
  "044: an off record without a choice still counts when PostgreSQL instances are recorded",
  () => {
    const h = host({
      optIn: { pg: rec(false) },
      pgState: {
        enabled: false,
        instances: {
          prime: { version: 18, port: 5433, created: "2026-11-12T18:51:02Z", by: "archon apply" },
        },
      },
    });
    const d = hostData(h);
    assertEquals([d.class, d.unchosen.map((u) => u.name)], ["durable", ["pg"]]);
    // ...and calling it ephemeral needs the confirmation.
    assertThrows(() => checkChoice(h, "pg", "ephemeral", undefined), Error, "--confirm-destroy");
  },
);

proves(["044-durable FR-003"], "044: data found on disk without a choice counts as durable", () => {
  const h = withOptIn({ s3: rec(false), smb: rec(false) });
  assertEquals(hostData(h).class, "ephemeral");
  const d = hostData(h, ["s3"]);
  assertEquals([d.class, d.reasons], ["durable", ["S3 (no choice recorded)"]]);
  assertEquals(hostData(host(), ["smb"]).class, "durable", "even with no record at all");
  // A recorded choice wins over what is on disk.
  assertEquals(hostData(withOptIn({ s3: rec(false, "ephemeral") }), ["s3"]).class, "ephemeral");
  assertThrows(
    () => checkChoice(h, "s3", "ephemeral", undefined, ["s3"]),
    Error,
    "no recorded choice",
  );
});

proves(
  ["044-durable FR-003"],
  "044: the host looks in each data directory (and counts what it cannot read)",
  async () => {
    const { dataOnDisk } = await import("../src/archon/optin/data.ts");
    const root = await fs.makeTempDir({ prefix: "archon-disk-" });
    const dirs = { pg: `${root}/pg`, s3: `${root}/s3`, smb: `${root}/smb` };
    try {
      assertEquals(await dataOnDisk(dirs), [], "nothing there: a fresh server");
      await fs.mkdir(`${dirs.pg}/18`, { recursive: true });
      await fs.mkdir(dirs.s3);
      await fs.mkdir(dirs.smb);
      assertEquals(await dataOnDisk(dirs), [], "empty directories hold nothing");
      await fs.mkdir(`${dirs.pg}/18/prime`);
      await fs.mkdir(`${dirs.s3}/.rustfs.sys`);
      await fs.writeTextFile(`${dirs.smb}/notes.txt`, "x");
      assertEquals(await dataOnDisk(dirs), ["pg", "s3", "smb"]);
    } finally {
      await fs.remove(root, { recursive: true });
    }
  },
);

proves(
  ["040-opt-in FR-003"],
  "044: creating an instance keeps pg.json's switch and choice (pg on before any instance)",
  async () => {
    const { writeOptIn } = await import("../src/archon/optin/optin.ts");
    const { writeRecord, readState } = await import("../src/archon/pg/converge.ts");
    const root = await fs.makeTempDir({ prefix: "archon-pgstate-" });
    try {
      await writeOptIn("alpha", "pg", true, "alice", root, "durable");
      await writeRecord(
        "alpha",
        "prime",
        { version: 18, port: 5433, created: "2026-11-13T01:24:30Z", by: "archon apply" },
        root,
      );
      const st = await readState("alpha", root);
      assertEquals([st.enabled, st.by, st.data], [true, "alice", "durable"]);
      assertEquals(Object.keys(st.instances), ["prime"]);
    } finally {
      await fs.remove(root, { recursive: true });
    }
  },
);

test("fleet status's source: the latest verify, rewritten only when the result changes", async () => {
  const { recordVerify } = await import("../src/archon/state/verify.ts");
  const root = await fs.makeTempDir({ prefix: "archon-verify-" });
  const checks: Check[] = [
    { resource: "a", command: "true", ok: true, output: "" },
    { resource: "off-host", command: "false", ok: false, output: "", level: "warn" },
  ];
  try {
    assert(await recordVerify("alpha", checks, root, new Date("2026-11-13T01:00:00Z")));
    assert(!(await recordVerify("alpha", checks, root, new Date("2026-11-13T02:00:00Z"))));
    const { getRecord } = await import("../src/archon/state/store.ts");
    const rec = (await getRecord("alpha", "verify", "latest", root))?.body;
    assertEquals(rec, {
      passed: 1,
      total: 2,
      failed: [],
      warned: ["off-host"],
      since: "2026-11-13T01:00:00.000Z",
    });
    assert(await recordVerify("alpha", checks.slice(0, 1), root), "a different result is written");
  } finally {
    await fs.remove(root, { recursive: true });
  }
});

proves(
  ["044-durable FR-006"],
  "044: boot reinstall has no --force; it says to use --confirm-destroy",
  async () => {
    const r = await proc.output(
      [proc.execPath(), "src/archon-boot/main.ts", "reinstall", "alpha", "--force"],
      { stdout: "piped", stderr: "piped", stdin: "null" },
    );
    assertEquals(r.code, 2);
    assertStringIncludes(new TextDecoder().decode(r.stderr), "--confirm-destroy <host>");
  },
);

proves(
  ["044-durable FR-010"],
  "044: homes are archived locally; the banner, the welcome page, and archon data say they are not kept",
  async () => {
    assert(backupPolicy(host()).paths.includes("/home"), "archived locally, as before");
    const banner = resolvePlan(host(), fleet()).files.find(
      (f) => f.path === "/etc/update-motd.d/72-archon-data",
    )?.content;
    assertStringIncludes(banner ?? "", "your home directory is not kept across a reinstall");
    for (const data of [
      { class: "ephemeral" as const, reasons: [] },
      { class: "durable" as const, reasons: ["PostgreSQL"] },
    ]) {
      const html = renderWelcome({
        host: "alpha",
        title: "Test fleet",
        os: "Ubuntu 26.04.1 LTS",
        repo: { slug: "example/fleet", url: "https://github.com/example/fleet" },
        data,
        services: [],
        unrouted: [],
        guide: [],
        guides: [],
        admin: "alice",
        generated: "2026-11-12 14:00 UTC",
      });
      assertStringIncludes(html, "your home directory is not kept across a reinstall");
    }
    // archon data, on the example lab, as text and as JSON.
    const sb = await sandbox("archon-data-test-");
    try {
      const script = path.join(sb.home, "data.ts");
      const mod = (rel: string) =>
        JSON.stringify(new URL(`../src/archon/${rel}`, import.meta.url).href);
      await fs.writeTextFile(
        script,
        `import { dataShow } from ${mod("optin/data.ts")};
import { ui } from ${mod("core/ui.ts")};
const json = process.argv.includes("--json");
await dataShow("alpha", json);
if (!json) ui.finish();
`,
      );
      const env = { ARCHON_REPO: path.join(ENGINE_ROOT, "examples"), ARCHON_FLEET: "lab" };
      const text = await sb.run(script, [], "", env);
      assertStringIncludes(text.out, "Home directories are not kept across a reinstall");
      const json = await sb.run(script, ["--json"], "", env);
      const parsed: unknown = JSON.parse(json.out.slice(json.out.indexOf("{")));
      assertEquals((parsed as { home?: unknown }).home, "ephemeral");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);
