/**
 * Spec 067: `stolos host adopt | observe | check | release` and
 * `stolos fleet query`, on the controller PC.
 *
 * @module
 */

import { join } from "../core/path.ts";
import { exists } from "../core/fsx.ts";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import {
  type AdoptedDef,
  adoptedDir,
  ensureProbeKey,
  installScript,
  loadAdopted,
  MACHINE_NAME,
  machineSource,
  observe,
  observedSource,
  probe,
  probeKeyPath,
  releaseScript,
  runAsYou,
  scanHostKeys,
} from "./adopt.ts";
import { policies, type PolicyResult } from "./policy.ts";

const fail = (): number => ui.problems.some((x) => x.level === "fail") ? 1 : 0;

/** `stolos host adopt <name> --ssh user@address`: pin, install the probe, observe. */
export async function hostAdopt(
  o: {
    name: string;
    ssh?: string;
    checkIn?: string;
    title?: string;
    owner?: string;
    until?: string;
  },
): Promise<number> {
  if (o.checkIn) return await adoptFromCheckIn({ ...o, checkIn: o.checkIn });
  if (!o.ssh) {
    ui.phase("Checks").fail(
      "--ssh user@address, or --check-in <code>",
      `the easy way: deno task stolos host integrate ${o.name} --as adopt (prints the line to run on the machine)`,
    );
    return fail();
  }
  const ssh = o.ssh;
  const c = ui.phase("Checks");
  const m = ssh.match(/^([a-z_][a-z0-9_.-]*)@([A-Za-z0-9.:-]+?)(?::(\d+))?$/);
  if (!MACHINE_NAME.test(o.name)) {
    c.fail(
      `${o.name} is not a name (lowercase letters, digits, -)`,
      "for example: macbook, omarchy-desk",
    );
    return fail();
  }
  if (!m) {
    c.fail(
      `--ssh ${ssh} is not user@address`,
      "for example --ssh shahid@macbook.local, or user@10.0.0.20:2222",
    );
    return fail();
  }
  if (o.until && !/^\d{4}-\d{2}-\d{2}$/.test(o.until)) {
    c.fail(`--until ${o.until} is not a date`, "YYYY-MM-DD");
    return fail();
  }
  const { loadHosts } = await import("../model/load.ts");
  if ((await loadHosts()).some((h) => h.name === o.name)) {
    c.fail(`${o.name} is already a managed host in this fleet`, "choose another name");
    return fail();
  }
  const [, user, address, portS] = m;
  const port = portS ? Number(portS) : undefined;
  c.done(`${user}@${address}${port ? `:${port}` : ""}`);

  const k = ui.phase("Host key");
  const existing = (await loadAdopted()).find((a) => a.machine.name === o.name)?.machine;
  const hostKeys = existing?.hostKeys.length
    ? existing.hostKeys
    : await scanHostKeys(address, port);
  if (!hostKeys.length) {
    k.fail(
      `${address} did not answer on SSH`,
      "check the address, and that SSH (Remote Login on macOS) is on",
    );
    return fail();
  }
  k.done(`${hostKeys[0].split(" ")[0]} pinned in Git${existing ? " (kept from before)" : ""}`);
  console.log(
    `\n  Fingerprint to compare with the machine's own (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub):`,
  );
  const fp = await new Deno.Command("ssh-keygen", {
    args: ["-lf", "-"],
    stdin: "piped",
    stdout: "piped",
  }).spawn();
  const w = fp.stdin.getWriter();
  await w.write(new TextEncoder().encode(`${address} ${hostKeys[0]}\n`));
  await w.close();
  console.log(`  ${new TextDecoder().decode((await fp.output()).stdout).trim()}\n`);

  const machine: AdoptedDef = {
    name: o.name,
    ...(o.title ?? existing?.title ? { title: o.title ?? existing?.title } : {}),
    ...(o.owner ?? existing?.owner ? { owner: o.owner ?? existing?.owner } : {}),
    ssh: { user, address, ...(port ? { port } : {}) },
    hostKeys,
    ...(o.until ?? existing?.until ? { until: o.until ?? existing?.until } : {}),
    adopted: existing?.adopted ?? new Date().toISOString(),
  };

  const pk = ui.phase("Probe key");
  const pub = await ensureProbeKey(o.name, P.fleetId);
  pk.done(`in the vault (adopted/${o.name}/probe_key): it may run the probe, nothing else`);

  const i = ui.phase("Install");
  console.log(
    `\n  Installing the probe as ${user} on ${address} (your own SSH: it may ask your password).\n`,
  );
  ui.pause();
  const installed = await runAsYou(machine, installScript(pub, P.fleetId));
  ui.resume();
  if (!installed) {
    i.fail(
      "the probe was not installed",
      `check you can run: ssh ${user}@${address}${
        port ? ` -p ${port}` : ""
      } (on Windows targets, use WSL or Git Bash's sh)`,
    );
    return fail();
  }
  i.done(`~/.local/bin/stolos-probe, and the probe key's line in ~/.ssh/authorized_keys`);

  await Deno.mkdir(adoptedDir(o.name), { recursive: true });
  await Deno.writeTextFile(join(adoptedDir(o.name), "machine.ts"), machineSource(machine));
  const ob = ui.phase("Observe");
  const r = await observe(machine);
  if (!r.observed) {
    ob.fail(
      `the probe key could not read facts: ${r.why}`,
      `deno task stolos host observe ${o.name}`,
    );
    return fail();
  }
  await Deno.writeTextFile(join(adoptedDir(o.name), "observed.ts"), observedSource(r.observed));
  ob.done(`${r.observed.os.name} ${r.observed.os.version} · ${r.observed.os.arch}`);
  report(o.name, policies(machine, r.observed));
  ui.next.push(`keep it: deno task stolos apply -m "067-adopt: adopt ${o.name}"`);
  ui.next.push("back up: deno task stolos vault backup (the probe key is new)");
  return fail();
}

/** Print policy results as a phase. */
/** Print one subject's policy results. */
export function report(name: string, rs: PolicyResult[]): void {
  const p = ui.phase(`Policies ${name}`);
  for (const r of rs) {
    if (r.status === "fail") {
      p.warn(
        `${r.title}: ${r.detail} [${r.scf.join(", ")}]`,
        r.fix ?? "",
        `P067-${r.id.toUpperCase()}`,
      );
    } else if (r.status !== "pass") {
      p.note(`${r.title}: ${r.status === "accepted" ? "accepted: " : ""}${r.detail}`);
    }
  }
  const pass = rs.filter((r) => r.status === "pass").length;
  p.done(`${pass} of ${rs.length} pass`);
}

/** `stolos host observe [name]`: observe one adopted machine, or all. */
export async function hostObserve(name?: string): Promise<number> {
  const all = await loadAdopted();
  const which = name ? all.filter((a) => a.machine.name === name) : all;
  if (name && !which.length) {
    ui.phase("Observe").fail(
      `no adopted machine ${name}`,
      "deno task stolos host adopt <name> --ssh user@address",
    );
    return fail();
  }
  if (!which.length) {
    ui.phase("Observe").done(
      "no adopted machines yet (deno task stolos host adopt <name> --ssh user@address)",
    );
    return 0;
  }
  const today = new Date().toISOString().slice(0, 10);
  await Promise.all(which.map(async ({ machine }) => {
    const p = ui.phase(machine.name);
    if (machine.until && machine.until < today) {
      p.warn(
        `adoption ended ${machine.until}: not observed`,
        `deno task stolos host release ${machine.name}, or extend until`,
      );
      return;
    }
    if (!(await exists(probeKeyPath(machine.name)))) {
      p.fail(
        "its probe key is not in this PC's vault",
        `restore the vault, or adopt again: deno task stolos host adopt ${machine.name} --ssh ${machine.ssh.user}@${machine.ssh.address}`,
      );
      return;
    }
    const r = await observe(machine);
    if (!r.observed) {
      return p.fail(
        `not observed: ${r.why}`,
        `ssh ${machine.ssh.user}@${machine.ssh.address} works? is the machine on?`,
      );
    }
    await Deno.writeTextFile(
      join(adoptedDir(machine.name), "observed.ts"),
      observedSource(r.observed),
    );
    p.done(`${r.observed.os.name} ${r.observed.os.version}`);
  }));
  ui.next.push(`keep the observations: deno task stolos apply -m "067-adopt: observe"`);
  return fail();
}

/** `stolos host check [name]`: the policies, per adopted machine. */
export async function hostCheck(name?: string, json = false): Promise<number> {
  const all = (await loadAdopted()).filter((a) => !name || a.machine.name === name);
  const results = all.map(({ machine, observed }) => ({
    name: machine.name,
    results: policies(machine, observed),
  }));
  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return results.some((r) => r.results.some((x) => x.status === "fail")) ? 1 : 0;
  }
  if (!all.length) ui.phase("Check").done("no adopted machines yet");
  for (const r of results) report(r.name, r.results);
  return results.some((r) => r.results.some((x) => x.status === "fail")) ? 1 : 0;
}

/** `stolos host release <name>`: remove the probe and its key's line, then the model and the key. */
export async function hostRelease(name: string): Promise<number> {
  const a = (await loadAdopted()).find((x) => x.machine.name === name);
  const p = ui.phase("Release");
  if (!a) {
    p.fail(`no adopted machine ${name}`, "deno task stolos host check (lists them)");
    return fail();
  }
  console.log(
    `\n  Removing the probe from ${a.machine.ssh.address} (your own SSH: it may ask your password).\n`,
  );
  ui.pause();
  const ok = await runAsYou(a.machine, releaseScript(P.fleetId));
  ui.resume();
  if (!ok) {
    p.warn(
      "the machine did not answer: its probe stays until you remove it",
      `ssh ${a.machine.ssh.user}@${a.machine.ssh.address}, then remove ~/.local/bin/stolos-probe and the stolos-probe line of ~/.ssh/authorized_keys`,
    );
  }
  await Deno.remove(adoptedDir(name), { recursive: true });
  const { removeSecret } = await import("../core/secrets.ts");
  await removeSecret(probeKeyPath(name));
  await removeSecret(`${probeKeyPath(name)}.pub`);
  p.done(`${name} released: its model and probe key are gone`);
  ui.next.push(`keep it: deno task stolos apply -m "067-adopt: release ${name}"`);
  return fail();
}

/** One machine's answer to a fleet query. */
export interface QueryAnswer {
  /** The machine. */
  machine: string;
  /** managed or adopted. */
  kind: "managed" | "adopted";
  /** Its rows, or why there are none. */
  rows?: Array<Record<string, unknown>>;
  /** Why it did not answer. */
  error?: string;
}

/** `stolos fleet query "<sql>"`: one osquery SELECT on every machine; one table. */
export async function fleetQuery(sql: string, json = false): Promise<number> {
  const { queryRefusal, table } = await import("../state/query.ts");
  const why = queryRefusal(sql);
  if (why) {
    ui.phase("Query").fail(
      `refused: ${why}`,
      `for example: deno task stolos fleet query "select name, version from os_version"`,
    );
    return fail();
  }
  const answers: QueryAnswer[] = [];
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(sql)));
  const adopted = await loadAdopted();
  await Promise.all(adopted.map(async ({ machine }) => {
    const r = await probe(machine, `osquery ${b64}`);
    try {
      answers.push(
        r.ok
          ? { machine: machine.name, kind: "adopted", rows: JSON.parse(r.out) }
          : { machine: machine.name, kind: "adopted", error: r.err || "no answer" },
      );
    } catch {
      answers.push({ machine: machine.name, kind: "adopted", error: "unreadable answer" });
    }
  }));
  const { loadHosts } = await import("../model/load.ts");
  const { mcpServers } = await import("../render/agent.ts");
  const { callRemoteTool } = await import("../observe/remote.ts");
  const { writeKnownHosts } = await import("../fleet/registration.ts");
  const knownHosts = await writeKnownHosts().catch(() => undefined);
  const hosts = (await loadHosts()).filter((h) => h.kind !== "workstation");
  await Promise.all(hosts.map(async (h) => {
    const target = mcpServers([h], P.fleetId)[0]?.target;
    if (!target) return;
    const r = await callRemoteTool(target, "archon_query", { sql, json: true }, {
      timeoutMs: 20_000,
      knownHosts,
    });
    try {
      answers.push(
        r.ok
          ? { machine: h.name, kind: "managed", rows: JSON.parse(r.text) }
          : { machine: h.name, kind: "managed", error: r.text.split("\n").pop() },
      );
    } catch {
      answers.push({ machine: h.name, kind: "managed", error: "unreadable answer" });
    }
  }));
  answers.sort((a, b) => a.machine.localeCompare(b.machine));
  if (json) {
    console.log(JSON.stringify(answers, null, 2));
    return 0;
  }
  const rows: Array<Record<string, unknown>> = answers.flatMap((a) =>
    (a.rows ?? []).map((r) => ({ machine: a.machine, ...r }))
  );
  if (rows.length) console.log(table(rows));
  for (const a of answers.filter((x) => x.error)) console.error(`${a.machine}: ${a.error}`);
  console.log(
    `\n${rows.length} row(s) from ${
      answers.filter((a) => a.rows).length
    } of ${answers.length} machine(s)`,
  );
  return answers.some((a) => a.error) ? 1 : 0;
}

/** `stolos discover`: machines seen on this PC's network or in the clouds, not yet in the fleet. */
export async function discover(json = false): Promise<number> {
  const { neighbors, unknownMachines } = await import("./discover.ts");
  type D = import("./discover.ts").Discovered;
  const { loadHosts } = await import("../model/load.ts");
  const { loadRegistration } = await import("../fleet/registration.ts");
  const { loadObservations } = await import("../connect/commands.ts");
  const hosts = await loadHosts();
  const adopted = await loadAdopted();
  const macs: string[] = [];
  for (const h of hosts) {
    if (h.mac) macs.push(h.mac);
    const r = await loadRegistration(h.name);
    if (r?.mac) macs.push(r.mac);
  }
  const seen: D[] = (await neighbors()).map((n) => ({
    source: "lan",
    address: n.address,
    id: n.mac,
  }));
  for (const o of await loadObservations()) {
    for (const a of o.assets) {
      if (!["server", "ec2-instance"].includes(a.kind) || a.fleetMachine) continue;
      const address = String(a.facts?.ipv4 ?? a.facts?.publicIp ?? "");
      seen.push({ source: o.provider, address, id: a.id, name: a.name });
    }
  }
  const found = unknownMachines(seen, {
    macs,
    addresses: adopted.map((a) => a.machine.ssh.address),
    names: [...hosts.map((h) => h.name), ...adopted.map((a) => a.machine.name)],
  });
  if (json) {
    console.log(JSON.stringify(found, null, 2));
    return 0;
  }
  const { table } = await import("../state/query.ts");
  if (found.length) {
    console.log(
      table(
        found.map((d) => ({ source: d.source, address: d.address, id: d.id, name: d.name ?? "" })),
      ),
    );
  }
  ui.phase("Discover").done(
    `${found.length} machine(s) seen that the fleet does not know (from this PC's neighbor table and the cloud observations; nothing was scanned)`,
  );
  if (found.length) {
    ui.next.push(
      "adopt one you are responsible for: deno task stolos host adopt <name> --ssh <user>@<address>",
    );
  }
  return 0;
}

/** `stolos host accept <name> <policy> --reason ... --until YYYY-MM-DD`: record an accepted risk in machine.ts. */
export async function hostAccept(
  name: string,
  policy: string,
  reason: string,
  until: string,
): Promise<number> {
  const p = ui.phase("Accept");
  const a = (await loadAdopted()).find((x) => x.machine.name === name);
  if (!a) {
    p.fail(`no adopted machine ${name}`, "deno task stolos host check (lists them)");
    return fail();
  }
  const ids = policies(a.machine, a.observed).map((r) => r.id);
  if (!ids.includes(policy)) {
    p.fail(`${name} has no policy ${policy}`, `one of: ${ids.join(", ")}`);
    return fail();
  }
  const today = new Date().toISOString().slice(0, 10);
  const limit = new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until <= today || until > limit) {
    p.fail(
      `--until ${until}: a date after today and within a year`,
      "accepted risks are reviewed at least yearly",
    );
    return fail();
  }
  if (reason.trim().length < 10) {
    p.fail(
      "--reason: say why, in words an auditor reads",
      'for example --reason "holds only open-source code; no customer data"',
    );
    return fail();
  }
  const { run } = await import("../core/exec.ts");
  const by = (await run(["git", "-C", P.repo, "config", "user.name"])).stdout.trim() || "unknown";
  const accepted = [...(a.machine.accepted ?? []).filter((x) => x.policy !== policy), {
    policy,
    reason: reason.trim(),
    by,
    until,
  }];
  await Deno.writeTextFile(
    join(adoptedDir(name), "machine.ts"),
    machineSource({ ...a.machine, accepted }),
  );
  p.done(`${name}: ${policy} accepted by ${by} until ${until}`);
  ui.next.push(
    `keep it (the signed commit is the record): deno task stolos apply -m "067-adopt: ${name} accepts ${policy}"`,
  );
  return 0;
}

/** `host adopt <name> --check-in <code>`: the machine already ran integrate --adopt; pin its keys from the code and observe. */
async function adoptFromCheckIn(
  o: {
    name: string;
    checkIn: string;
    ssh?: string;
    title?: string;
    owner?: string;
    until?: string;
  },
): Promise<number> {
  const c = ui.phase("Check-in");
  const { parseCheckIn } = await import("./checkin.ts");
  let ci;
  try {
    ci = parseCheckIn(o.checkIn);
  } catch (e) {
    c.fail(
      (e as Error).message,
      "run the line from host integrate on the machine again, and copy its last line",
    );
    return fail();
  }
  if (!MACHINE_NAME.test(o.name)) {
    c.fail(`${o.name} is not a name (lowercase letters, digits, -)`, "for example: alice-laptop");
    return fail();
  }
  if (ci.fleet && ci.fleet !== P.fleetId) {
    c.fail(
      `this code was made for the fleet ${ci.fleet}, not ${P.fleetId}`,
      `deno task stolos fleet use ${ci.fleet}`,
    );
    return fail();
  }
  if (!ci.kinds.includes("adopt")) {
    c.fail(
      "the machine was not prepared for adoption (no --adopt)",
      `deno task stolos host integrate ${o.name} --as adopt`,
    );
    return fail();
  }
  if (!ci.hostKeys.length) {
    c.fail(
      "the code has no SSH host keys (is SSH on?)",
      "run the line on the machine again: it turns SSH on",
    );
    return fail();
  }
  if (!(await exists(probeKeyPath(o.name)))) {
    c.fail(
      `this PC has no probe key for ${o.name}`,
      `the line must come from this PC: deno task stolos host integrate ${o.name} --as adopt, then run it again`,
    );
    return fail();
  }
  const via = o.ssh?.match(/^([a-z_][a-z0-9_.-]*)@([A-Za-z0-9.:-]+?)(?::(\d+))?$/i);
  const user = via?.[1] ?? ci.user;
  const address = via?.[2] ?? ci.addresses[0] ?? ci.hostname;
  const port = via?.[3] ? Number(via[3]) : ci.port !== 22 ? ci.port : undefined;
  c.done(
    `${ci.hostname}: ${user}@${address}, ${ci.hostKeys.length} host key(s) from the code (no first-connection trust)`,
  );
  const existing = (await loadAdopted()).find((a) => a.machine.name === o.name)?.machine;
  const machine: AdoptedDef = {
    name: o.name,
    ...(o.title ?? existing?.title ? { title: o.title ?? existing?.title } : {}),
    ...(o.owner ?? existing?.owner ? { owner: o.owner ?? existing?.owner } : {}),
    ssh: { user, address, ...(port ? { port } : {}) },
    hostKeys: ci.hostKeys,
    ...(o.until ?? existing?.until ? { until: o.until ?? existing?.until } : {}),
    adopted: existing?.adopted ?? new Date().toISOString(),
    ...(existing?.accepted ? { accepted: existing.accepted } : {}),
  };
  await Deno.mkdir(adoptedDir(o.name), { recursive: true });
  await Deno.writeTextFile(join(adoptedDir(o.name), "machine.ts"), machineSource(machine));
  const ob = ui.phase("Observe");
  const r = await observe(machine);
  const observed = r.observed ?? ci.observed;
  if (observed) {
    await Deno.writeTextFile(join(adoptedDir(o.name), "observed.ts"), observedSource(observed));
  }
  if (r.observed) ob.done(`${r.observed.os.name} ${r.observed.os.version} · ${r.observed.os.arch}`);
  else if (observed) {
    ob.warn(
      `this PC could not reach it over SSH (${r.why}); kept what the check-in code said`,
      `when it is reachable: deno task stolos host observe ${o.name} (or --ssh user@address)`,
    );
  } else ob.fail(`not observed: ${r.why}`, `deno task stolos host observe ${o.name}`);
  const { saveDiscovered } = await import("./integrate.ts");
  await saveDiscovered([], [o.name]);
  if (observed) report(o.name, policies(machine, observed));
  ui.next.push(`keep it: deno task stolos apply -m "069-integrate: adopt ${o.name}"`);
  return fail();
}

/** `stolos host integrate <name> --as discover|adopt|osquery|server|workstation`: the line to run on the machine. */
export async function hostIntegrate(
  o: { name: string; as: string; github?: string; repo?: string },
): Promise<number> {
  const p = ui.phase("Integrate");
  const { INTEGRATIONS, integrateLines } = await import("./integrate.ts");
  const as = o.as.split(/[,\s]+/).filter(Boolean);
  const bad = as.filter((k) => !(INTEGRATIONS as readonly string[]).includes(k));
  if (!as.length || bad.length) {
    p.fail(
      `--as ${o.as}: one or more of ${INTEGRATIONS.join(", ")}`,
      `for example: --as adopt,osquery`,
    );
    return fail();
  }
  if (!MACHINE_NAME.test(o.name)) {
    p.fail(`${o.name} is not a name (lowercase letters, digits, -)`, "for example: alice-laptop");
    return fail();
  }
  if (as.includes("osquery") && !as.includes("adopt")) as.push("adopt");
  const github = o.github ??
    (as.includes("server")
      ? (await import("../model/load.ts").then((m) => m.loadFleet())).admin.github.login
      : undefined);
  const repo = o.repo ??
    (as.includes("workstation")
      ? (await import("../fleet/bootstrap.ts").then((m) => m.repoSlug(P.repo)))
      : undefined);
  const key = as.includes("adopt") ? await ensureProbeKey(o.name, P.fleetId) : undefined;
  const lines = await integrateLines({
    as: as as never,
    fleet: P.fleetId,
    ...(key ? { key } : {}),
    ...(github ? { github } : {}),
    ...(repo ? { repo } : {}),
  });
  p.done(`${o.name}: ${as.join(", ")}${key ? " (its probe key is in the vault)" : ""}`);
  console.log(
    `\n  On ${o.name}, in a terminal (Linux, macOS, or Ubuntu in WSL):\n\n    ${lines.posix}\n`,
  );
  if (lines.windows) {
    console.log(
      `  Or on Windows, in PowerShell (Run as administrator${
        as.includes("adopt") ? "" : " is not needed for discover"
      }):\n\n    ${lines.windows}\n`,
    );
  }
  console.log(
    "  It says what it will do and asks once; at the end it prints a check-in code (stolos1:...).\n",
  );
  const next = as.includes("adopt")
    ? `then: deno task stolos host adopt ${o.name} --check-in <code>   (or paste it in the Stolos Console)`
    : as.includes("server")
    ? `then: deno task stolos host add ${o.name}, and deno task stolos host bootstrap ${o.name} --ssh <user>@<address>`
    : as.includes("workstation")
    ? "then: deno task stolos apply, on that workstation, to keep it"
    : `then: deno task stolos discover --import <code>   (or paste it in the Stolos Console)`;
  ui.next.push(next);
  return 0;
}

/** `stolos discover --import <code>`: record a machine that checked in, to adopt or manage later. */
export async function discoverImport(code: string, name?: string, owner?: string): Promise<number> {
  const p = ui.phase("Discover");
  const { nameFor, parseCheckIn } = await import("./checkin.ts");
  let ci;
  try {
    ci = parseCheckIn(code);
  } catch (e) {
    p.fail((e as Error).message, "copy the whole last line the integrate script printed");
    return fail();
  }
  const n = name ?? nameFor(ci.hostname);
  if (!MACHINE_NAME.test(n)) {
    p.fail(`${n} is not a name`, "give one: --name alice-laptop");
    return fail();
  }
  const { fromCheckIn, saveDiscovered } = await import("./integrate.ts");
  const d = fromCheckIn(ci, n);
  await saveDiscovered([{ ...d, ...(owner ? { owner } : {}) }]);
  p.done(
    `${n}: ${d.os ?? ci.hostname}${
      d.addresses.length ? ` at ${d.addresses.join(", ")}` : ""
    } (recorded in discovered.ts)`,
  );
  ui.next.push(`keep it: deno task stolos apply -m "069-integrate: discovered ${n}"`);
  ui.next.push(`adopt it: deno task stolos host integrate ${n} --as adopt`);
  return 0;
}
