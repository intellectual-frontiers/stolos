// Specs 012-014: the registry's generated files, MCP argv mapping, push rules, export.

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { allowed, argvFor, handle, listed, parseTier } from "../src/archon/mcp/server.ts";
import { mcpServers, renderMcpJson } from "../src/archon/render/agent.ts";
import { renderManPages } from "../src/archon/render/man.ts";
import { lit, subject } from "../src/archon/model/export.ts";

Deno.test("every command has a man page", () => {
  const pages = renderManPages();
  for (const c of COMMANDS) assert(pages.has(`man1/archon-${c.name.replace(/ /g, "-")}.1`), c.name);
});

Deno.test("030: workstations reach each server over SSH as ops, one MCP server each", async () => {
  const { host } = await import("./fixtures.ts");
  const servers = mcpServers([
    host({ name: "alpha", dnsName: "alpha.localdomain" }),
    host({ name: "pc", kind: "workstation" }),
  ]);
  assertEquals(servers, [{ name: "archon-alpha", target: "ops@alpha.localdomain" }]);
  const mcp = JSON.parse(renderMcpJson(servers)).mcpServers;
  assertEquals(mcp["archon-alpha"].command, "ssh");
  assertEquals(mcp["archon-alpha"].args.at(-1), "ops@alpha.localdomain");
  assert(mcp["archon-alpha"].args.includes("BatchMode=yes"));
});

Deno.test("030: ops' keys only start archon mcp at the fleet's tier", async () => {
  const { usersFor, mcpAuthorizedKeys } = await import("../src/archon/model/load.ts");
  const { fleet, host, KEY } = await import("./fixtures.ts");
  const ops = usersFor(fleet(), host()).find((u) => u.name === "ops")!;
  assertEquals(ops.fullName, "Archon Operator");
  assertEquals(ops.sshKeys, [
    `restrict,command="env ARCHON_AGENT=mcp /usr/local/bin/archon mcp --max-tier mutate" ${KEY}`,
  ]);
  const f = { ...fleet(), mcp: { maxTier: "read" as const, keys: [KEY] } };
  assert(mcpAuthorizedKeys(f)[0].includes("--max-tier read"));
  const { validateFleet } = await import("../src/archon/model/validate.ts");
  const bad = validateFleet({ ...fleet(), mcp: { maxTier: "destructive" as never } }, [host()]);
  assert(bad.some((p) => p.message.includes("not a tier an agent may have")));
});

Deno.test("030: archon mcp serves only its tier, and never destructive", async () => {
  const cmd = (n: string) => COMMANDS.find((c) => c.name === n)!;
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
  const list = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "read") as {
    result: { tools: Array<{ name: string }> };
  };
  const names = list.result.tools.map((t) => t.name);
  assert(names.includes("archon_verify") && !names.includes("archon_backup_run"));
  const refused = await handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "archon_backup_run", arguments: {} },
  }, "read") as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert(refused.result.isError);
  assertStringIncludes(refused.result.content[0].text, "refused");
});

Deno.test("MCP arguments map to the CLI", () => {
  const apply = COMMANDS.find((c) => c.name === "apply")!;
  assertEquals(argvFor(apply, { check: true }), ["apply", "--check"]);
  const query = COMMANDS.find((c) => c.name === "query")!;
  assertEquals(argvFor(query, { sql: "select 1", json: true }), ["query", "select 1", "--json"]);
  const add = COMMANDS.find((c) => c.name === "host add")!;
  assertEquals(argvFor(add, { name: "alpha", mac: "aa:bb:cc:dd:ee:ff" }), [
    "host",
    "add",
    "alpha",
    "--mac",
    "aa:bb:cc:dd:ee:ff",
  ]);
});

Deno.test("Turtle literals and subjects are well formed", () => {
  assertEquals(lit('a "b"\nc'), '"a \\"b\\"\\nc"');
  assertStringIncludes(
    subject("<x>", [["a", "prov:Activity"], ["prov:used", ["<y>", "<z>"]]]),
    "prov:used <y>, <z> .",
  );
});

Deno.test("guests launch as modeled; backups default to Ubuntu's /var/backups", async () => {
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

Deno.test("guest and backup rules are validated", async () => {
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

Deno.test("archon runs with $HOME set even when started without it (cloud-init)", async () => {
  const { ensureHome } = await import("../src/archon/main.ts");
  const saved = Deno.env.get("HOME");
  Deno.env.delete("HOME");
  try {
    await ensureHome();
    assert(!!Deno.env.get("HOME"));
  } finally {
    if (saved) Deno.env.set("HOME", saved);
  }
});

Deno.test("apt lock contention is recognized (Ubuntu's daily apt run right after first boot)", async () => {
  const { LOCKED, classifyAptLine } = await import("../src/archon/apply/apt.ts");
  for (
    const line of [
      "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 2690 (apt-get)",
      "E: Unable to lock directory /var/lib/apt/lists/",
    ]
  ) {
    assert(LOCKED.test(line));
    assert(LOCKED.test(classifyAptLine(line)!.message));
  }
  assert(!LOCKED.test("E: Unable to locate package nope"));
});

Deno.test("the host lock says who holds it", async () => {
  const { hostLock, readHolder, describeHolder } = await import("../src/archon/core/lock.ts");
  const dir = await Deno.makeTempDir({ prefix: "archon-lock-test-" });
  const saved = Deno.env.get("ARCHON_LOCK_HELD");
  Deno.env.delete("ARCHON_LOCK_HELD");
  try {
    const held = await hostLock({ wait: false }, `${dir}/archon.lock`);
    assert(held);
    const h = await readHolder(`${dir}/archon.lock`);
    assertEquals(h?.pid, Deno.pid);
    held!.release();
    assertEquals(
      describeHolder(
        { pid: 42, command: "reconcile", agent: "reconciler", since: "2026-11-12T13:50:00Z" },
        Date.parse("2026-11-12T13:53:12Z"),
      ),
      "archon reconcile (pid 42, the reconcile timer, running for 3m 12s)",
    );
  } finally {
    if (saved !== undefined) Deno.env.set("ARCHON_LOCK_HELD", saved);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("048: any change in the checkout blocks a pull (hosts record nothing there)", async () => {
  const { blockingChanges } = await import("../src/archon/reconcile/reconcile.ts");
  assertEquals(blockingChanges(" M fleets/lab/fleet.ts\n"), " M fleets/lab/fleet.ts");
  assertEquals(blockingChanges(""), "");
});

Deno.test("three-word commands run, and complete in fish", async () => {
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
