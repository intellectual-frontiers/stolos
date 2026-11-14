/**
 * Spec 053: "where am I". `archon` with no arguments shows, for the fleet of
 * this repository, every step from a new repository to running hosts, each
 * done or not as the real state says (Git, this machine's secret store, the
 * boot server's tokens, what hosts reported), and the one command to run next.
 * Nothing is stored about progress: it is computed every time.
 *
 * ```mermaid
 * stateDiagram-v2
 *   direction LR
 *   [*] --> todo
 *   todo --> next: the first step not done
 *   next --> done: its command run
 *   [*] --> pending: waits for a token
 *   pending --> done: the token delivered
 *   done --> [*]
 * ```
 *
 * @module
 */

export interface WhereFacts {
  /** The fleets of this repository. */
  fleets: string[];
  /** The active fleet, when one is chosen and exists. */
  fleetId?: string;
  /** deno.json's engine tag, when pinned; and whether deno.lock exists. */
  pinned?: string;
  /** deno.lock exists. */
  locked: boolean;
  /** How many signers of each role signers.ts lists. */
  signers: { daily: number; recovery: number };
  /** This machine's signing problems (spec 057's checks, failures first): what is wrong, with its fix. */
  signingProblems: Array<{ what: string; fix?: string }>;
  /** The admin password's hash is in this machine's secret store. */
  adminHash: boolean;
  /** The fleet sends mail: is the relay token on this machine? */
  mail?: { token: boolean };
  /** The fleet has HTTPS names: is the Cloudflare token on this machine? */
  web?: { token: boolean };
  /** Each host: a workstation or a server, installed, armed, armed by claim. */
  hosts: Array<{
    name: string;
    workstation: boolean;
    installed: boolean;
    armed: boolean;
    claim: boolean;
  }>;
  /** Uncommitted changes in the fleet repository, and commits not pushed. */
  dirty: boolean;
  /** Commits not pushed. */
  unpushed: number;
}

/** A step's state: done, the one to do next, to do after it, or waiting for something to be set up. */
export type StepState = "done" | "next" | "todo" | "pending";

/** One step of the checklist. */
export interface Step {
  /** Its state. */
  state: StepState;
  /** What it is, in a few words. */
  text: string;
  /** The command that does it (for next, todo, and pending). */
  command?: string;
}

/** The steps, in order; the first one not done (and not merely pending) is "next". */
export function whereSteps(f: WhereFacts): Step[] {
  const raw: Array<{ done: boolean; pending?: boolean; text: string; command?: string }> = [];
  const id = f.fleetId ?? "<id>";
  if (!f.fleetId) {
    raw.push({
      done: false,
      text: f.fleets.length > 1
        ? `choose a fleet of this repository (${f.fleets.join(", ")})`
        : "create the fleet",
      command: f.fleets.length > 1
        ? `deno task archon fleet use ${f.fleets[0]}`
        : "deno task archon fleet init <id>",
    });
    return label(raw);
  }
  raw.push({
    done: !!f.pinned && f.locked,
    text: f.pinned
      ? `engine ${f.pinned}${f.locked ? ", locked" : ", not locked (deno.lock is missing)"}`
      : "the engine is not pinned in deno.json",
    command:
      `deno task archon fleet upgrade v<version> (the newest tag of intellectual-frontiers/stolos)`,
  });
  raw.push({
    done: f.signers.daily > 0,
    text: f.signers.daily
      ? `${f.signers.daily} daily signer(s)`
      : "no daily signer: no change can be approved",
    command: "deno task archon keys setup",
  });
  raw.push({
    done: f.signers.recovery > 0,
    text: f.signers.recovery
      ? `${f.signers.recovery} recovery signer(s)`
      : "no recovery signer (the key you keep apart, for when the daily one is lost)",
    command: "deno task archon keys setup",
  });
  raw.push({
    done: !f.signingProblems.length,
    text: f.signingProblems.length
      ? `this machine's signing: ${f.signingProblems[0].what}`
      : "this machine signs your commits",
    command: f.signingProblems[0]?.fix ?? "deno task archon keys",
  });
  raw.push({
    done: f.adminHash,
    text: f.adminHash
      ? "admin password (hash on this machine)"
      : "no admin password hash on this machine",
    command: `deno task archon fleet init ${id}`,
  });
  if (f.mail) {
    raw.push({
      done: f.mail.token,
      pending: !f.mail.token,
      text: f.mail.token ? "mail token" : "mail is not set up yet (no relay token)",
      command: "deno task boot mail-setup",
    });
  }
  if (f.web) {
    raw.push({
      done: f.web.token,
      pending: !f.web.token,
      text: f.web.token
        ? "Cloudflare token (DNS, certificates)"
        : "HTTPS names are not set up yet (no Cloudflare token)",
      command: "deno task boot web-setup",
    });
  }
  const servers = f.hosts.filter((h) => !h.workstation);
  if (!servers.length) {
    raw.push({
      done: false,
      text: "no server yet",
      command: "deno task archon host add <name> --claim   (or --mac-address <mac>)",
    });
  }
  for (const h of servers) {
    raw.push({
      done: h.installed,
      text: h.installed
        ? `${h.name} installed`
        : h.armed
        ? `${h.name} armed${h.claim ? " (claim)" : ""}: power it on and let it network-boot`
        : `${h.name} not installed`,
      command: h.armed
        ? "deno task boot serve   (leave it running while it installs)"
        : `deno task boot arm ${h.name} --claim   (or --mac-address <mac>)`,
    });
  }
  raw.push({
    done: !f.dirty && !f.unpushed,
    text: f.dirty
      ? "changes not committed"
      : f.unpushed
      ? `${f.unpushed} commit(s) not pushed (pushing is the approval)`
      : "everything committed and pushed",
    command: f.dirty ? 'git add -A && git commit -S -m "<spec>: <what>" && git push' : "git push",
  });
  return label(raw);
}

function label(
  raw: Array<{ done: boolean; pending?: boolean; text: string; command?: string }>,
): Step[] {
  let nextGiven = false;
  return raw.map((r) => {
    if (r.done) return { state: "done" as const, text: r.text };
    if (r.pending) return { state: "pending" as const, text: r.text, command: r.command };
    const state: StepState = nextGiven ? "todo" : "next";
    nextGiven = true;
    return { state, text: r.text, command: r.command };
  });
}

/** The one command to run next (or what to do when everything is done). */
export function nextCommand(steps: Step[]): string {
  return steps.find((s) => s.state === "next")?.command ??
    steps.find((s) => s.state === "pending")?.command ??
    "deno task archon fleet status   (everything is set up)";
}

/** The facts, from the real state (see the header). */
export async function collectWhere(): Promise<WhereFacts> {
  const { P, listFleets } = await import("../core/paths.ts");
  const { exists, readTextOr } = await import("../core/fsx.ts");
  const { join } = await import("../core/path.ts");
  const { run } = await import("../core/exec.ts");
  const fleets = listFleets(P.repo);
  const fleetId = P.fleetId && (await exists(P.fleet)) ? P.fleetId : undefined;
  const { readPin } = await import("../fleet/upgrade.ts");
  const denoJson = await readTextOr(join(P.repo, "deno.json"));
  const base: WhereFacts = {
    fleets,
    ...(fleetId ? { fleetId } : {}),
    ...(denoJson && readPin(denoJson) ? { pinned: readPin(denoJson)!.tag } : {}),
    locked: await exists(join(P.repo, "deno.lock")),
    signers: { daily: 0, recovery: 0 },
    signingProblems: [],
    adminHash: false,
    hosts: [],
    dirty: false,
    unpushed: 0,
  };
  if (!fleetId) return base;
  const { loadSigners } = await import("../identity/signers.ts");
  const { keyChecksNow } = await import("../identity/keys-commands.ts");
  const signers = await loadSigners().catch(() => []);
  const { SECRETS, loadTokens, liveToken } = await import("../core/secrets.ts");
  const { loadFleet, loadHosts } = await import("../model/load.ts");
  const fleet = await loadFleet();
  const tokens = await loadTokens().catch(() => []);
  const { getRecord } = await import("../state/store.ts");
  const hosts = await Promise.all((await loadHosts().catch(() => [])).map(async (h) => {
    const t = liveToken(tokens, h.name);
    const installed = h.registration?.macSource === "installed" ||
      !!(await getRecord(h.name, "install", "install", P.state).catch(() => undefined));
    return {
      name: h.name,
      workstation: h.kind === "workstation",
      installed,
      armed: !!t,
      claim: !!t?.claimUntil,
    };
  }));
  const git = (args: string[]) => run(["git", "-C", P.repo, ...args]);
  const status = await git(["status", "--porcelain"]);
  const ahead = await git(["rev-list", "--count", "@{u}..HEAD"]);
  return {
    ...base,
    signers: {
      daily: signers.filter((s) => s.role === "daily").length,
      recovery: signers.filter((s) => s.role === "recovery").length,
    },
    // Spec 057: what stops signing (fail); warnings stay in archon keys and boot doctor.
    signingProblems: (await keyChecksNow().catch(() => []))
      .filter((c) => !c.ok && c.level === "fail")
      .map((c) => ({ what: c.what, fix: c.fix })),
    adminHash: await exists(SECRETS.adminPasswordHash),
    ...(fleet.mail ? { mail: { token: await exists(SECRETS.mail) } } : {}),
    ...(fleet.web ? { web: { token: await exists(SECRETS.web) } } : {}),
    hosts,
    dirty: status.ok && status.stdout.trim() !== "",
    unpushed: ahead.ok ? Number(ahead.stdout.trim()) || 0 : 0,
  };
}

/** `archon` (no arguments) and `archon where`. */
export async function whereCommand(json: boolean): Promise<number> {
  const { ui } = await import("../core/ui.ts");
  // On a host: what it is and how it is (archon state).
  try {
    Deno.statSync("/etc/archon/host");
    const { stateCommand } = await import("../state/state-command.ts");
    const host = Deno.readTextFileSync("/etc/archon/host").trim();
    const code = await stateCommand(host, json);
    if (!json) console.log("\nEvery command: archon help");
    return code;
  } catch { /* the boot machine or a workstation's checkout */ }
  const f = await collectWhere();
  const steps = whereSteps(f);
  if (json) {
    console.log(JSON.stringify({ facts: f, steps, next: nextCommand(steps) }, null, 2));
    return 0;
  }
  const mark = (s: StepState) =>
    ui.emoji
      ? { done: "✅", next: "👉", todo: "▫️ ", pending: "⏳" }[s]
      : { done: "[ok]", next: "[->]", todo: "[  ]", pending: "[..]" }[s];
  console.log(`fleet ${f.fleetId ?? "(none chosen)"}${f.pinned ? ` · engine ${f.pinned}` : ""}\n`);
  for (const s of steps) {
    console.log(`${mark(s.state)} ${s.text}`);
    if (s.state === "next" || s.state === "pending") console.log(`     ${ui.dim(s.command ?? "")}`);
  }
  console.log(`\nnext: ${nextCommand(steps)}\nEvery command: archon help`);
  return 0;
}
