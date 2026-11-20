/**
 * Specs 012-014: the registry's generated files, MCP argv mapping, push rules, export.
 *
 * @module
 */
import { fs, lock, proc } from "@intellectual-frontiers/system";
import {
  assertExists,
  assert,
  assertEquals,
  assertStringIncludes,
  test,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import {
  allowed,
  argvFor,
  handle,
  listed,
  mcpToolName,
  parseTier,
} from "../src/archon/mcp/server.ts";
import { mcpServers, renderMcpJson } from "../src/archon/render/agent.ts";
import { renderManPages } from "../src/archon/render/man.ts";
import { lit, subject } from "../src/archon/model/export.ts";
import { at, list } from "./fixtures.ts";
import { runtimeCommand } from "../src/archon/install/bun.ts";

test("every machine command has a man page; fleet commands (stolos) have none", () => {
  const pages = renderManPages();
  for (const c of COMMANDS) {
    const has = pages.has(`man1/archon-${c.name.replace(/ /g, "-")}.1`);
    if (c.place === "pc") {
      assert(!has || COMMANDS.some((x) => x.name === c.name && x.place !== "pc"), c.name);
    } else assert(has, c.name);
  }
});

proves(
  ["059-stolos-and-archon FR-001"],
  "059: every command says where it runs; stolos and archon do not overlap but for explain, docs, apply, update and tag",
  async () => {
    const { offeredOn } = await import("../src/archon/commands/registry.ts");
    for (const c of COMMANDS) assert(c.place, `${c.name} has no place`);
    const names = (p: "pc" | "machine") =>
      new Set(COMMANDS.filter((c) => offeredOn(c, p)).map((c) => c.name));
    const pc = names("pc");
    const machine = names("machine");
    const both = [...pc].filter((n) => machine.has(n)).sort();
    assertEquals(
      both,
      ["apply", "docs", "explain", "tag add", "tag list", "tag remove", "update"],
      "apply, update and tag add, remove and list are two commands each: one for each place (spec 112)",
    );
    for (const n of ["keys setup", "fleet init", "host add", "vault backup", "decide", "where"]) {
      assert(pc.has(n) && !machine.has(n), n);
    }
    for (const n of ["verify", "pg on", "reboot", "mcp", "signers trust", "state"]) {
      assert(machine.has(n) && !pc.has(n), n);
    }
  },
);

proves(
  ["059-stolos-and-archon FR-004"],
  "059: each command points at the other for the other's commands",
  async () => {
    const run = async (main: string, args: string[]): Promise<{ code: number; out: string }> => {
      const r = await proc.output([...runtimeCommand(), main, ...args], {
        stdout: "piped",
        stderr: "piped",
        stdin: "null",
      });
      return {
        code: r.code,
        out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr),
      };
    };
    let r = await run("src/archon/main.ts", ["keys", "setup"]);
    assertEquals(r.code, 2, r.out);
    assertStringIncludes(r.out, "bun run stolos keys setup");
    r = await run("src/stolos/main.ts", ["verify"]);
    assertEquals(r.code, 2, r.out);
    assertStringIncludes(r.out, "archon verify");
    r = await run("src/stolos/main.ts", ["help"]);
    assertStringIncludes(r.out, "bun run stolos <command>");
    assertStringIncludes(r.out, "boot <sub>");
    assert(!r.out.includes("  verify "), "no machine commands in stolos help");
    assertStringIncludes(r.out, "(also: push)");
  },
);

proves(
  ["030-agent-layer FR-006", "046-engine-instance FR-009"],
  "030: workstations reach each server over SSH as ops, one MCP server each",
  async () => {
    const { host } = await import("./fixtures.ts");
    const servers = mcpServers(
      [
        host({ name: "alpha", dnsName: "alpha.localdomain" }),
        host({ name: "pc", kind: "workstation" }),
      ],
      "lab",
    );
    assertEquals(servers, [{ name: "archon-lab-alpha", target: "ops@alpha.localdomain" }]);
    const mcp: unknown = JSON.parse(renderMcpJson(servers));
    const alpha = (...k: string[]): unknown => at(mcp, "mcpServers", "archon-lab-alpha", ...k);
    assertEquals(alpha("command"), "ssh");
    assertEquals(list(alpha("args")).at(-1), "ops@alpha.localdomain");
    assert(list(alpha("args")).includes("BatchMode=yes"));
  },
);

proves(
  ["030-agent-layer FR-007"],
  "030: .mcp.json names no particular agent, and the server's limit holds whatever the client asks",
  async () => {
    const text = renderMcpJson([{ name: "archon-lab-alpha", target: "ops@alpha.localdomain" }]);
    const mcp: unknown = JSON.parse(text);
    // The plain MCP shape every client reads: servers, each a command and its arguments.
    assertEquals(Object.keys(mcp ?? {}), ["mcpServers"]);
    const entry = at(mcp, "mcpServers", "archon-lab-alpha");
    assertEquals(Object.keys(entry ?? {}).sort(), ["args", "command"]);
    assert(!/claude|cursor|copilot|codex|gemini|windsurf/i.test(text), text);
    // A client that calls a tool the tier does not list is refused by the server itself.
    const above = COMMANDS.find((c) => c.tier === "mutate" && !c.noMcp && !c.readOnlyWith);
    assert(above !== undefined);
    const tools = JSON.stringify(
      await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "read"),
    );
    const name = mcpToolName(above);
    assert(!tools.includes(`"${name}"`), `${name} is not listed at the read tier`);
    const refused = JSON.stringify(
      await handle(
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } },
        "read",
      ),
    );
    assert(/not allowed|refused|unknown|not served|isError/i.test(refused), refused);
  },
);

proves(
  ["046-engine-instance FR-012"],
  "046: one .mcp.json for every fleet: a build replaces only its own fleet's servers",
  () => {
    const e = { command: "ssh", args: ["ops@x"] };
    const existing = JSON.stringify({
      mcpServers: {
        "archon-alpha": e, // the old, fleet-less name: dropped
        "archon-lab-old": e, // this fleet's: replaced by what the build renders
        "archon-lab-2-beta": e, // fleet lab-2, whose id starts with lab
        "archon-home-gamma": e, // fleet home
        "archon-gone-delta": e, // a fleet no longer in the repository: dropped
      },
    });
    const out = at(
      JSON.parse(
        renderMcpJson([{ name: "archon-lab-alpha", target: "ops@alpha" }], {
          existing,
          fleet: "lab",
          fleets: ["home", "lab", "lab-2"],
        }),
      ) as unknown,
      "mcpServers",
    );
    assertEquals(Object.keys(out ?? {}), [
      "archon-home-gamma",
      "archon-lab-2-beta",
      "archon-lab-alpha",
    ]);
    // Built from fleet lab-2, lab's servers are kept.
    const back = at(
      JSON.parse(
        renderMcpJson([], { existing, fleet: "lab-2", fleets: ["home", "lab", "lab-2"] }),
      ) as unknown,
      "mcpServers",
    );
    assertEquals(Object.keys(back ?? {}), ["archon-home-gamma", "archon-lab-old"]);
  },
);

proves(
  ["030-agent-layer FR-003"],
  "030: ops' keys only start archon mcp at the fleet's tier",
  async () => {
    const { usersFor, mcpAuthorizedKeys } = await import("../src/archon/model/load.ts");
    const { fleet, host, KEY } = await import("./fixtures.ts");
    const ops = usersFor(fleet(), host()).find((u) => u.name === "ops");
    assertExists(ops);
    assertEquals(ops.fullName, "Archon Operator");
    assertEquals(ops.sshKeys, [
      `restrict,command="env ARCHON_AGENT=mcp /usr/local/bin/archon mcp --max-tier mutate" ${KEY}`,
    ]);
    const f = { ...fleet(), mcp: { maxTier: "read" as const, keys: [KEY] } };
    assert(mcpAuthorizedKeys(f)[0]?.includes("--max-tier read"));
    const { validateFleet } = await import("../src/archon/model/validate.ts");
    const bad = validateFleet({ ...fleet(), mcp: { maxTier: "destructive" as never } }, [host()]);
    assert(bad.some((p) => p.message.includes("not a tier an agent may have")));
  },
);

proves(
  ["030-agent-layer FR-004"],
  "030: archon mcp serves only its tier, and never destructive",
  async () => {
    const cmd = (n: string): (typeof COMMANDS)[number] => {
      const c = COMMANDS.find((x) => x.name === n && x.place !== "pc");
      assertExists(c, `no machine command ${n}`);
      return c;
    };
    assertEquals(parseTier(undefined), "mutate");
    let threw = false;
    try {
      parseTier("destructive");
    } catch {
      threw = true;
    }
    assert(threw);
    assert(listed(cmd("verify"), "read"));
    assert(!listed(cmd("backup run"), "read"));
    assert(listed(cmd("apply"), "read")); // with --check only
    assert(allowed(cmd("apply"), { check: true }, "read"));
    assert(!allowed(cmd("apply"), {}, "read"));
    assert(allowed(cmd("apply"), {}, "mutate"));
    for (const c of COMMANDS.filter((c) => c.tier === "destructive")) {
      assert(!listed(c, "mutate") || !!c.readOnlyWith, c.name);
      assert(!allowed(c, {}, "mutate"), c.name);
    }
    const list = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "read")) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = list.result.tools.map((t) => t.name);
    assert(names.includes("archon_verify") && !names.includes("archon_backup_run"));
    const refused = (await handle(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "archon_backup_run", arguments: {} },
      },
      "read",
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert(refused.result.isError);
    assertStringIncludes(refused.result.content[0]?.text ?? "", "refused");
  },
);

test("MCP arguments map to the CLI", () => {
  const apply = COMMANDS.find((c) => c.name === "apply");
  assertExists(apply);
  assertEquals(argvFor(apply, { check: true }), ["apply", "--check"]);
  const query = COMMANDS.find((c) => c.name === "query");
  assertExists(query);
  assertEquals(argvFor(query, { sql: "select 1", json: true }), ["query", "select 1", "--json"]);
  const add = COMMANDS.find((c) => c.name === "host add");
  assertExists(add);
  assertEquals(argvFor(add, { name: "alpha", "mac-address": "aa:bb:cc:dd:ee:ff" }), [
    "host",
    "add",
    "alpha",
    "--mac-address",
    "aa:bb:cc:dd:ee:ff",
  ]);
});

test("Turtle literals and subjects are well formed", () => {
  assertEquals(lit('a "b"\nc'), '"a \\"b\\"\\nc"');
  assertStringIncludes(
    subject("<x>", [
      ["a", "prov:Activity"],
      ["prov:used", ["<y>", "<z>"]],
    ]),
    "prov:used <y>, <z> .",
  );
});

test("guests launch as modeled; backups default to Ubuntu's /var/backups", async () => {
  const { launchArgs } = await import("../src/archon/guests/guests.ts");
  assertEquals(
    launchArgs({
      name: "db",
      kind: "vm",
      image: "ubuntu:26.04",
      data: "durable",
      cpus: 2,
      memory: "4GiB",
    }),
    [
      "lxc",
      "launch",
      "ubuntu:26.04",
      "db",
      "--vm",
      "-c",
      "limits.cpu=2",
      "-c",
      "limits.memory=4GiB",
    ],
  );
  const { backupPolicy } = await import("../src/archon/capabilities/backup.ts");
  const { host } = await import("./fixtures.ts");
  assertEquals(backupPolicy(host()).target, "/var/backups/archon");
  assertEquals(backupPolicy(host({ backup: { keep: 3 } })).keep, 3);
});

test("guest and backup rules are validated", async () => {
  const { validateFleet } = await import("../src/archon/model/validate.ts");
  const { fleet, host } = await import("./fixtures.ts");
  const ps = validateFleet(fleet(), [
    host({
      guests: [{ name: "Bad_Name", kind: "container", image: "nope", data: "ephemeral" }],
      backup: { target: "relative", keep: 0 },
    }),
  ]).map((p) => p.message);
  assertEquals(ps.length, 4);
});

test("archon runs with $HOME set even when started without it (cloud-init)", async () => {
  const { ensureHome } = await import("../src/archon/main.ts");
  const saved = proc.env.get("HOME");
  proc.env.delete("HOME");
  try {
    await ensureHome();
    // Windows has no HOME of its own (USERPROFILE), and none is made up there.
    assertEquals(!!proc.env.get("HOME"), proc.build.os !== "windows");
  } finally {
    // Put back exactly what was there: every test file shares this process on Bun.
    if (saved === undefined) proc.env.delete("HOME");
    else proc.env.set("HOME", saved);
  }
});

test("apt lock contention is recognized (Ubuntu's daily apt run right after first boot)", async () => {
  const { LOCKED, classifyAptLine } = await import("../src/archon/apply/apt.ts");
  for (const line of [
    "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 2690 (apt-get)",
    "E: Unable to lock directory /var/lib/apt/lists/",
  ]) {
    assert(LOCKED.test(line));
    assert(LOCKED.test(classifyAptLine(line)?.message ?? ""));
  }
  assert(!LOCKED.test("E: Unable to locate package nope"));
});

test("the host lock says who holds it", async () => {
  const { hostLock, holderCommand } = await import("../src/archon/core/lock.ts");
  const dir = await fs.makeTempDir({ prefix: "archon-lock-test-" });
  const saved = proc.env.get("ARCHON_LOCK_HELD");
  proc.env.delete("ARCHON_LOCK_HELD");
  try {
    const held = await hostLock({ wait: false }, `${dir}/archon.lock`);
    assert(held);
    const h = await lock.readHolder(`${dir}/archon.lock`);
    assertEquals(h?.pid, proc.pid);
    held.release();
    assertEquals(
      lock.describeHolder(
        {
          pid: 42,
          command: holderCommand(["reconcile"], "reconciler"),
          since: "2026-11-12T13:50:00Z",
          token: "",
        },
        Date.parse("2026-11-12T13:53:12Z"),
      ),
      "archon reconcile, the reconcile timer (pid 42, for 3m 12s)",
    );
  } finally {
    if (saved !== undefined) proc.env.set("ARCHON_LOCK_HELD", saved);
    await fs.remove(dir, { recursive: true });
  }
});

proves(
  ["048-observe-by-query FR-008"],
  "048: any change in the checkout blocks a pull (hosts record nothing there)",
  async () => {
    const { blockingChanges } = await import("../src/archon/reconcile/reconcile.ts");
    assertEquals(blockingChanges(" M fleets/lab/fleet.ts\n"), " M fleets/lab/fleet.ts");
    assertEquals(blockingChanges(""), "");
  },
);

test("three-word commands run, and complete in fish", async () => {
  const { findCommand } = await import("../src/archon/commands/registry.ts");
  assertEquals(findCommand(["fs", "smb", "status"])?.cmd.name, "fs smb status");
  assertEquals(findCommand(["fs", "smb", "on", "--host", "alpha"])?.rest, ["--host", "alpha"]);
  assertEquals(findCommand(["web", "status"])?.cmd.name, "web status");
  assertEquals(findCommand(["verify"])?.cmd.name, "verify");
  assertEquals(findCommand(["fs"]), undefined);
  const { renderFishCompletions } = await import("../src/archon/render/fish.ts");
  const fish = renderFishCompletions(COMMANDS);
  assert(fish.includes("-a smb -d 'fs smb commands'"), "the middle word");
  assert(
    fish.includes(
      '__fish_seen_subcommand_from smb; and not __fish_seen_subcommand_from on off status" -a status',
    ),
  );
});
