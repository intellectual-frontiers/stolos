/**
 * Spec 067: `stolos host adopt | observe | check | release` and
 * `stolos fleet query`, on the controller PC.
 *
 * @module
 */
// Spec: 097-controller FR-001, FR-006
// Spec: 098-pair FR-009
// Spec: 107-pairing-and-query FR-007, FR-010, FR-011
// Spec: 108-tags FR-004, FR-008, FR-013
// Spec: 112-machine-reported-tags FR-011
// Spec: 110-network-assets FR-002, FR-006, FR-011

import {
  array,
  compact,
  json,
  record,
  unknownValue,
} from "@intellectual-frontiers/commons/ts/kernel";
import { fs, path, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import type { Discovered } from "./discover.ts";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import {
  type AdoptedDef,
  adoptedDir,
  ensureProbeKey,
  installScript,
  keepReported,
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
import type { CheckIn } from "./checkin.ts";
import { joinedMark } from "./joining.ts";
import {
  answeredLine,
  askAll,
  type AskOptions,
  type AskTarget,
  QUERY_CAP,
  type QueryAnswer,
  type QueryTag,
  QUERY_TIMEOUT_S,
  tagCell,
} from "./query.ts";

const fail = (): number => (ui.problems.some((x) => x.level === "fail") ? 1 : 0);

/** `stolos host adopt <name> --ssh user@address`: pin, install the probe, observe. */
export async function hostAdopt(o: {
  name: string;
  ssh?: string;
  checkIn?: string;
  title?: string;
  owner?: string;
  until?: string;
}): Promise<number> {
  if (o.checkIn) return await adoptFromCheckIn({ ...o, checkIn: o.checkIn });
  if (!o.ssh) {
    ui.phase("Checks").fail(
      "--ssh user@address, or --check-in <code>",
      `the easy way: bun run stolos pair (a short line to run on the machine, and a code)`,
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
      "for example --ssh alice@macbook.local, or user@10.0.0.20:2222",
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
  const [, user = "", address = "", portS] = m;
  const port = portS ? Number(portS) : undefined;
  c.done(`${user}@${address}${port ? `:${port}` : ""}`);

  const k = ui.phase("Host key");
  const existing = (await loadAdopted()).find((a) => a.machine.name === o.name)?.machine;
  const hostKeys = existing?.hostKeys.length
    ? existing.hostKeys
    : await scanHostKeys(address, port);
  const [firstKey] = hostKeys;
  if (firstKey === undefined) {
    k.fail(
      `${address} did not answer on SSH`,
      "check the address, and that SSH (Remote Login on macOS) is on",
    );
    return fail();
  }
  k.done(`${firstKey.split(" ")[0]} pinned in Git${existing ? " (kept from before)" : ""}`);
  stdio.stdout.writeSync(
    `\n  Fingerprint to compare with the machine's own (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub):\n`,
  );
  const fp = await proc.run(["ssh-keygen", "-lf", "-"], {
    input: `${address} ${firstKey}\n`,
    stderr: "inherit",
  });
  stdio.stdout.writeSync(`  ${fp.stdout.trim()}\n\n`);

  const machine: AdoptedDef = {
    name: o.name,
    ...compact({
      title: (o.title ?? existing?.title) || undefined,
      owner: (o.owner ?? existing?.owner) || undefined,
    }),
    ssh: { user, address, ...(port ? { port } : {}) },
    hostKeys,
    ...compact({ until: (o.until ?? existing?.until) || undefined }),
    adopted: existing?.adopted ?? new Date().toISOString(),
    // Spec 108-tags: the tags a person gave it are kept.
    ...(existing?.tags?.length ? { tags: existing.tags } : {}),
    ...(existing?.customTags?.length ? { customTags: existing.customTags } : {}),
  };

  const pk = ui.phase("Probe key");
  const pub = await ensureProbeKey(o.name, P.fleetId);
  pk.done(`in the vault (adopted/${o.name}/probe_key): it may run the probe, nothing else`);

  const i = ui.phase("Install");
  stdio.stdout.writeSync(
    `\n  Installing the probe as ${user} on ${address} (your own SSH: it may ask your password).\n\n`,
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

  await fs.mkdir(adoptedDir(o.name), { recursive: true });
  await fs.writeTextFile(path.join(adoptedDir(o.name), "machine.ts"), machineSource(machine));
  const ob = ui.phase("Observe");
  const r = await observe(machine);
  if (!r.observed) {
    ob.fail(
      `the probe key could not read facts: ${r.why}`,
      `bun run stolos host observe ${o.name}`,
    );
    return fail();
  }
  await fs.writeTextFile(path.join(adoptedDir(o.name), "observed.ts"), observedSource(r.observed));
  await keepReported(o.name, r.reported);
  ob.done(`${r.observed.os.name} ${r.observed.os.version} · ${r.observed.os.arch}`);
  report(o.name, policies(machine, r.observed));
  ui.next.push(`keep it: bun run stolos apply -m "067-adopt: adopt ${o.name}"`);
  ui.next.push("back up: bun run stolos vault backup (the probe key is new)");
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
  // Spec 097: this PC is a fleet machine too; recorded the first time.
  {
    const { ensureController } = await import("./controller.ts");
    const c = await ensureController();
    if ("added" in c && c.added) {
      ui.phase("Controller").done(
        `${c.name}: this PC, recorded as the fleet's controller (observed locally)`,
      );
    }
  }
  const all = await loadAdopted();
  const which = name ? all.filter((a) => a.machine.name === name) : all;
  if (name && !which.length) {
    ui.phase("Observe").fail(
      `no adopted machine ${name}`,
      "bun run stolos host adopt <name> --ssh user@address",
    );
    return fail();
  }
  if (!which.length) {
    ui.phase("Observe").done(
      "no adopted machines yet (bun run stolos host adopt <name> --ssh user@address)",
    );
    return 0;
  }
  const today = new Date().toISOString().slice(0, 10);
  await Promise.all(
    which.map(async ({ machine }) => {
      const p = ui.phase(machine.name);
      if (machine.until && machine.until < today) {
        p.warn(
          `adoption ended ${machine.until}: not observed`,
          `bun run stolos host release ${machine.name}, or extend until`,
        );
        return;
      }
      if (machine.role === "controller") {
        const { isThisController } = await import("./controller.ts");
        if (!(await isThisController(machine))) {
          p.done("another controller PC: it observes itself");
          return;
        }
      }
      if (machine.role !== "controller" && !(await fs.exists(probeKeyPath(machine.name)))) {
        p.fail(
          "its probe key is not in this PC's vault",
          `restore the vault, or adopt again: bun run stolos host adopt ${machine.name} --ssh ${machine.ssh.user}@${machine.ssh.address}`,
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
      await fs.writeTextFile(
        path.join(adoptedDir(machine.name), "observed.ts"),
        observedSource(r.observed),
      );
      await keepReported(machine.name, r.reported);
      p.done(`${r.observed.os.name} ${r.observed.os.version}`);
    }),
  );
  ui.next.push(`keep the observations: bun run stolos apply -m "067-adopt: observe"`);
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
    stdio.stdout.writeSync(`${JSON.stringify(results, null, 2)}\n`);
    return results.some((r) => r.results.some((x) => x.status === "fail")) ? 1 : 0;
  }
  if (!all.length) ui.phase("Check").done("no adopted machines yet");
  for (const r of results) report(r.name, r.results);
  return results.some((r) => r.results.some((x) => x.status === "fail")) ? 1 : 0;
}

/** `stolos host release <name>`: remove the probe and its key's line, then the model and the key. */
export async function hostRelease(name: string): Promise<number> {
  // Spec 110-network-assets FR-002: a network asset (adopted through an integration) is released as a host is: its record goes, on a
  // person's explicit request, and nothing at the controller changes.
  {
    const { releaseNetworkAsset } = await import("../connect/network-commands.ts");
    const done = await releaseNetworkAsset(name);
    if (done !== undefined) return done;
  }
  const a = (await loadAdopted()).find((x) => x.machine.name === name);
  const p = ui.phase("Release");
  if (!a) {
    p.fail(`no adopted machine ${name}`, "bun run stolos host check (lists them)");
    return fail();
  }
  // A controller has no probe or key installed: only its model goes (spec 097).
  let ok = true;
  if (a.machine.role !== "controller") {
    stdio.stdout.writeSync(
      `\n  Removing the probe from ${a.machine.ssh.address} (your own SSH: it may ask your password).\n\n`,
    );
    ui.pause();
    ok = await runAsYou(a.machine, releaseScript(P.fleetId));
    ui.resume();
  }
  if (!ok) {
    p.warn(
      "the machine did not answer: its probe stays until you remove it",
      `ssh ${a.machine.ssh.user}@${a.machine.ssh.address}, then remove ~/.local/bin/stolos-probe and the stolos-probe line of ~/.ssh/authorized_keys`,
    );
  }
  await fs.remove(adoptedDir(name), { recursive: true });
  const { removeSecret } = await import("../core/secrets.ts");
  await removeSecret(probeKeyPath(name));
  await removeSecret(`${probeKeyPath(name)}.pub`);
  p.done(`${name} released: its model and probe key are gone`);
  ui.outcome(`${name} released: its model and probe key are gone`);
  ui.next.push(`keep it: bun run stolos apply -m "067-adopt: release ${name}"`);
  return fail();
}

/** An answer's rows (JSON: an array of objects); throws where the answer is something else. */
function rowsOf(text: string): Array<Record<string, unknown>> {
  const d = json(text, array(record(unknownValue)));
  if (d.kind === "err") throw new Error("unreadable answer");
  return d.value.map((r) => ({ ...r }));
}

/**
 * One osquery SELECT on each adopted machine, through its probe (the caller
 * checks the SQL first, with queryRefusal). Spec 078's osquery controls ask
 * through this too.
 */
export async function queryAdopted(
  sql: string,
  adopted: ReadonlyArray<{ machine: AdoptedDef }>,
): Promise<QueryAnswer[]> {
  const answers: QueryAnswer[] = [];
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(sql)));
  await Promise.all(
    adopted.map(async ({ machine }) => {
      const r = await probe(machine, `osquery ${b64}`);
      try {
        answers.push(
          r.ok
            ? { machine: machine.name, kind: "adopted", state: "answered", rows: rowsOf(r.out) }
            : {
                machine: machine.name,
                kind: "adopted",
                state: "failed",
                error: r.err || "no answer",
              },
        );
      } catch {
        answers.push({
          machine: machine.name,
          kind: "adopted",
          state: "failed",
          error: "unreadable answer",
        });
      }
    }),
  );
  return answers.sort((a, b) => a.machine.localeCompare(b.machine));
}

/**
 * Every machine to ask a question: the managed servers (over their MCP servers) and the adopted machines (through their probes, the
 * controller PC's own among them), each as a target {@link askAll} can ask within a time limit.
 */
export async function queryTargets(sql: string): Promise<AskTarget[]> {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(sql)));
  const targets: AskTarget[] = (await loadAdopted()).map(({ machine }) => ({
    machine: machine.name,
    kind: "adopted" as const,
    ask: async (signal) => {
      const r = await probe(machine, `osquery ${b64}`, { signal });
      if (!r.ok) throw new Error(r.err || "no answer");
      try {
        return rowsOf(r.out);
      } catch {
        throw new Error("unreadable answer");
      }
    },
  }));
  const { loadHosts } = await import("../model/load.ts");
  const { mcpServers } = await import("../render/agent.ts");
  const { callRemoteTool } = await import("../observe/remote.ts");
  const { writeKnownHosts } = await import("../fleet/registration.ts");
  const knownHosts = await writeKnownHosts().catch(() => undefined);
  for (const h of (await loadHosts()).filter((x) => x.kind !== "workstation")) {
    const target = mcpServers([h], P.fleetId)[0]?.target;
    targets.push({
      machine: h.name,
      kind: "managed",
      ask: async (_signal, limitMs) => {
        if (!target) throw new Error("no way to reach it is known yet");
        const r = await callRemoteTool(
          target,
          "archon_query",
          { sql, json: true },
          { timeoutMs: limitMs, ...(knownHosts === undefined ? {} : { knownHosts }) },
        );
        if (!r.ok) throw new Error(r.text.split("\n").pop() || "no answer");
        try {
          return rowsOf(r.text);
        } catch {
          throw new Error("unreadable answer");
        }
      },
    });
  }
  // Spec 110-network-assets FR-011: a network asset has no osquery: it gets a row that says so, and nothing is sent to it.
  try {
    const { loadNetworkAssets } = await import("../connect/network-asset.ts");
    for (const a of await loadNetworkAssets()) {
      targets.push({
        machine: a.name,
        kind: "network",
        skip: "no osquery on this device",
        ask: () => Promise.resolve([]),
      });
    }
  } catch {
    // A fleet whose network assets do not load is told so by every other command: the machines are still asked.
  }
  return targets;
}

/**
 * Ask every machine one SELECT (spec 107-pairing-and-query FR-010): all at once, at most `cap` at a time, each within `timeoutMs`;
 * `onStart` and `onAnswer` let a page draw the table as the answers come. The caller has checked the SQL (`queryRefusal`).
 * Spec 108-tags FR-013: with a `selection`, only the machines whose tags it chooses are asked, and each answer carries its
 * machine's tags.
 */
export async function askFleet(sql: string, o: AskOptions = {}): Promise<QueryAnswer[]> {
  const { selection, reported, ...pool } = o;
  const { chosen, loadFleetTags } = await import("../fleet/tags.ts");
  const ft = await loadFleetTags();
  const keep = selection
    ? new Set(chosen(ft.machines, selection, reported === true).map((m) => m.name))
    : undefined;
  const tags = new Map(
    ft.machines.map((m) => [
      m.name,
      m.resolved.tags.map((t): QueryTag => ({
        id: t.id,
        standing: t.standing,
        origin: t.origin,
        ...(t.from === undefined ? {} : { from: t.from }),
        ...(t.trust === undefined ? {} : { trust: t.trust }),
      })),
    ]),
  );
  const withTags = (a: QueryAnswer): QueryAnswer => {
    const t = tags.get(a.machine);
    return t?.length ? { ...a, tags: t } : a;
  };
  const targets = (await queryTargets(sql)).filter((t) => !keep || keep.has(t.machine));
  const answers = await askAll(targets, {
    ...pool,
    ...(pool.onAnswer ? { onAnswer: (a: QueryAnswer) => pool.onAnswer?.(withTags(a)) } : {}),
  });
  return answers.map(withTags);
}

/**
 * `stolos fleet query "<sql>" [--timeout s] [--tag t ...] [--any-tag t ...] [--select expr]`: one osquery SELECT on every machine
 * (or the machines the tags choose) at once; one merged table.
 */
export async function fleetQuery(
  sql: string,
  json = false,
  timeoutS?: number,
  pick: { tag?: unknown; "any-tag"?: unknown; select?: unknown; reported?: unknown } = {},
): Promise<number> {
  const { queryRefusal, table } = await import("../state/query.ts");
  const why = queryRefusal(sql);
  if (why) {
    ui.phase("Query").fail(
      `refused: ${why}`,
      `for example: bun run stolos fleet query "select name, version from os_version"`,
    );
    return fail();
  }
  const p = ui.phase("Query");
  // Spec 108-tags FR-012, FR-013: the machines by their tags; a typo in a tag is refused before anything is asked.
  const { loadFleetTags, selectionFromArgs, chosen, selectionText } =
    await import("../fleet/tags.ts");
  const ft = await loadFleetTags();
  const sel = selectionFromArgs(pick, ft.set);
  if (sel.error) {
    p.fail(
      sel.error,
      "for example: --tag env:prod, --any-tag role:nas --any-tag role:web, --select 'env:prod and not role:database' (stolos tag list)",
    );
    return fail();
  }
  const reported = pick.reported === true;
  if (sel.selection && !chosen(ft.machines, sel.selection, reported).length) {
    p.fail(
      `no machine has ${selectionText(sel.selection)}: nothing was asked`,
      "stolos tag list shows which machines hold which tags",
    );
    return fail();
  }
  let asked = 0;
  let got = 0;
  const answers = await askFleet(sql, {
    timeoutMs: (timeoutS ?? QUERY_TIMEOUT_S) * 1000,
    ...(sel.selection ? { selection: sel.selection, reported } : {}),
    onStart: (ms) => {
      asked = ms.length;
      p.status(`Asking ${asked} machine(s), ${Math.min(QUERY_CAP, asked)} at a time`);
    },
    onAnswer: () => p.status(`${++got} of ${asked} answered or failed`),
  });
  p.done(
    `${answeredLine(answers)}${sel.selection ? ` (chosen by ${selectionText(sel.selection)})` : ""}`,
  );
  if (json) {
    stdio.stdout.writeSync(`${JSON.stringify(answers, null, 2)}\n`);
    return 0;
  }
  const rows: Array<Record<string, unknown>> = answers.flatMap((a) =>
    (a.rows ?? []).map((r) => ({ machine: a.machine, ...tagCell(a), ...r })),
  );
  if (rows.length) stdio.stdout.writeSync(`${table(rows)}\n`);
  for (const a of answers.filter((x) => x.state !== "answered" && x.state !== "skipped")) {
    stdio.stderr.writeSync(
      `${a.machine}: ${a.state === "timed-out" ? "timed out: " : ""}${a.error}\n`,
    );
  }
  stdio.stdout.writeSync(`\n${answeredLine(answers)} · ${rows.length} row(s)\n`);
  return answers.some((a) => a.state !== "answered" && a.state !== "skipped") ? 1 : 0;
}

/** `stolos discover`: machines seen on this PC's network or in the clouds, not yet in the fleet. */
export async function discover(json = false): Promise<number> {
  const { neighbors, unknownMachines } = await import("./discover.ts");
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
  const seen: Discovered[] = (await neighbors()).map((n) => ({
    source: "lan",
    address: n.address,
    id: n.mac,
  }));
  for (const o of await loadObservations()) {
    for (const a of o.assets) {
      if (!["server", "ec2-instance"].includes(a.kind) || a.fleetMachine) continue;
      const address = String(a.facts?.["ipv4"] ?? a.facts?.["publicIp"] ?? "");
      seen.push({ source: o.provider, address, id: a.id, name: a.name });
    }
  }
  const found = unknownMachines(seen, {
    macs,
    addresses: adopted.map((a) => a.machine.ssh.address),
    names: [...hosts.map((h) => h.name), ...adopted.map((a) => a.machine.name)],
  });
  if (json) {
    stdio.stdout.writeSync(`${JSON.stringify(found, null, 2)}\n`);
    return 0;
  }
  const { table } = await import("../state/query.ts");
  if (found.length) {
    stdio.stdout.writeSync(
      `${table(
        found.map((d) => ({ source: d.source, address: d.address, id: d.id, name: d.name ?? "" })),
      )}\n`,
    );
  }
  const me = adopted.find((a) => a.machine.role === "controller");
  if (me) {
    ui.phase(me.machine.name).done(
      `this PC is in the fleet already · ${joinedMark("auto-adopted")}`,
    );
  }
  ui.phase("Discover").done(
    `${found.length} machine(s) seen that the fleet does not know (from this PC's neighbor table and the cloud observations; nothing was scanned)`,
  );
  if (found.length) {
    ui.next.push(
      "adopt one you are responsible for: bun run stolos host adopt <name> --ssh <user>@<address>",
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
    p.fail(`no adopted machine ${name}`, "bun run stolos host check (lists them)");
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
  const accepted = [
    ...(a.machine.accepted ?? []).filter((x) => x.policy !== policy),
    {
      policy,
      reason: reason.trim(),
      by,
      until,
    },
  ];
  await fs.writeTextFile(
    path.join(adoptedDir(name), "machine.ts"),
    machineSource({ ...a.machine, accepted }),
  );
  p.done(`${name}: ${policy} accepted by ${by} until ${until}`);
  ui.next.push(
    `keep it (the signed commit is the record): bun run stolos apply -m "067-adopt: ${name} accepts ${policy}"`,
  );
  return 0;
}

/** `host adopt <name> --check-in <code>`: the machine already ran integrate --adopt; pin its keys from the code and observe. */
async function adoptFromCheckIn(o: {
  name: string;
  checkIn: string;
  ssh?: string;
  title?: string;
  owner?: string;
  until?: string;
}): Promise<number> {
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
      `bun run stolos fleet use ${ci.fleet}`,
    );
    return fail();
  }
  if (!ci.kinds.includes("adopt")) {
    c.fail(
      "the machine was not prepared for adoption (no --adopt)",
      `bun run stolos host integrate ${o.name} --as adopt`,
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
  if (!(await fs.exists(probeKeyPath(o.name)))) {
    c.fail(
      `this PC has no probe key for ${o.name}`,
      `the line must come from this PC: bun run stolos host integrate ${o.name} --as adopt, then run it again`,
    );
    return fail();
  }
  return await adoptCheckIn(ci, o, c);
}

/**
 * Adopt a machine from its check-in (a `stolos1:` code, or a paired machine's signed check-in):
 * its host keys are pinned from the check-in, then it is observed over SSH with its probe key.
 */
export async function adoptCheckIn(
  ci: CheckIn,
  o: {
    name: string;
    ssh?: string;
    title?: string;
    owner?: string;
    until?: string;
    spec?: string;
    /** How it joined, recorded in machine.ts (spec 107-pairing-and-query FR-007): `paired` by `stolos pair`. */
    joined?: "paired" | "integrated";
    /** Spec 108-tags FR-008: the defined tags a person chose for it at pairing (kept from before when none). */
    tags?: readonly string[];
    /** Spec 108-tags FR-008: the free-form tags a person chose for it at pairing. */
    customTags?: readonly string[];
  },
  c = ui.phase("Check-in"),
): Promise<number> {
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
    ...compact({
      title: (o.title ?? existing?.title) || undefined,
      owner: (o.owner ?? existing?.owner) || undefined,
    }),
    ssh: { user, address, ...(port ? { port } : {}) },
    hostKeys: ci.hostKeys,
    ...compact({ until: (o.until ?? existing?.until) || undefined }),
    adopted: existing?.adopted ?? new Date().toISOString(),
    ...((j) => (j ? { joined: j } : {}))(o.joined ?? existing?.joined),
    // Spec 110-network-assets FR-006: the MACs it checked in with, to match it to a client of the router.
    ...((m) => (m?.length ? { macs: m } : {}))(ci.macs.length ? ci.macs : existing?.macs),
    ...(existing?.accepted ? { accepted: existing.accepted } : {}),
    ...((t) => (t?.length ? { tags: t } : {}))(o.tags?.length ? o.tags : existing?.tags),
    ...((t) => (t?.length ? { customTags: t } : {}))(
      o.customTags?.length ? o.customTags : existing?.customTags,
    ),
  };
  await fs.mkdir(adoptedDir(o.name), { recursive: true });
  await fs.writeTextFile(path.join(adoptedDir(o.name), "machine.ts"), machineSource(machine));
  const ob = ui.phase("Observe");
  const r = await observe(machine);
  const observed = r.observed ?? ci.observed;
  if (observed) {
    await fs.writeTextFile(path.join(adoptedDir(o.name), "observed.ts"), observedSource(observed));
  }
  await keepReported(o.name, r.reported);
  if (r.observed) ob.done(`${r.observed.os.name} ${r.observed.os.version} · ${r.observed.os.arch}`);
  else if (observed) {
    ob.warn(
      `this PC could not reach it over SSH (${r.why}); kept what the check-in code said`,
      `when it is reachable: bun run stolos host observe ${o.name} (or --ssh user@address)`,
    );
  } else ob.fail(`not observed: ${r.why}`, `bun run stolos host observe ${o.name}`);
  const { saveDiscovered } = await import("./integrate.ts");
  await saveDiscovered([], [o.name]);
  if (observed) report(o.name, policies(machine, observed));
  ui.next.push(`keep it: bun run stolos apply -m "${o.spec ?? "069-integrate"}: adopt ${o.name}"`);
  ui.next.push("back up: bun run stolos vault backup (the probe key is new)");
  return fail();
}

/** `stolos host integrate <name> --as discover|adopt|osquery|server|workstation`: the line to run on the machine. */
export async function hostIntegrate(o: {
  name: string;
  as: string;
  github?: string;
  repo?: string;
}): Promise<number> {
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
  const github =
    o.github ??
    (as.includes("server")
      ? (await import("../model/load.ts").then((m) => m.loadFleet())).admin.github.login
      : undefined);
  const repo =
    o.repo ??
    (as.includes("workstation")
      ? await import("../fleet/bootstrap.ts").then((m) => m.repoSlug(P.repo))
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
  stdio.stdout.writeSync(
    `\n  On ${o.name}, in a terminal (Linux, macOS, or Ubuntu in WSL):\n\n    ${lines.posix}\n\n`,
  );
  if (lines.windows) {
    stdio.stdout.writeSync(
      `  Or on Windows, in PowerShell (Run as administrator${
        as.includes("adopt") ? "" : " is not needed for discover"
      }):\n\n    ${lines.windows}\n\n`,
    );
  }
  stdio.stdout.writeSync(
    "  It says what it will do and asks once; at the end it prints a check-in code (stolos1:...).\n\n",
  );
  if (as.includes("adopt")) ui.next.push("easier, with a short code: bun run stolos pair");
  const next = as.includes("adopt")
    ? `then: bun run stolos host adopt ${o.name} --check-in <code>   (or paste it in the Stolos Console)`
    : as.includes("server")
      ? `then: bun run stolos host add ${o.name}, and bun run stolos host bootstrap ${o.name} --ssh <user>@<address>`
      : as.includes("workstation")
        ? "then: bun run stolos apply, on that workstation, to keep it"
        : `then: bun run stolos discover --import <code>   (or paste it in the Stolos Console)`;
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
  ui.next.push(`keep it: bun run stolos apply -m "069-integrate: discovered ${n}"`);
  ui.next.push(`adopt it: bun run stolos host integrate ${n} --as adopt`);
  return 0;
}
