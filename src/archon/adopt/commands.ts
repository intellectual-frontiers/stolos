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
  o: { name: string; ssh: string; title?: string; owner?: string; until?: string },
): Promise<number> {
  const c = ui.phase("Checks");
  const m = o.ssh.match(/^([a-z_][a-z0-9_.-]*)@([A-Za-z0-9.:-]+?)(?::(\d+))?$/);
  if (!MACHINE_NAME.test(o.name)) {
    c.fail(
      `${o.name} is not a name (lowercase letters, digits, -)`,
      "for example: macbook, omarchy-desk",
    );
    return fail();
  }
  if (!m) {
    c.fail(
      `--ssh ${o.ssh} is not user@address`,
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
    } else if (r.status === "warn" || r.status === "unknown") p.note(`${r.title}: ${r.detail}`);
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
