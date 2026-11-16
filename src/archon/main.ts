/**
 * The command line, for both commands (spec 059): `archon` on each machine
 * (servers, workstations) and `stolos` on your PC (src/stolos/main.ts), over
 * one registry where every command says where it runs. See archon(1).
 *
 * @module
 */

import { fs, lock, proc, stdio } from "@intellectual-frontiers/ifc-ts/runtime";
import { asRoot, onHost, P, resetRoots } from "./core/paths.ts";
import { COMMANDS, findCommand, offeredOn } from "./commands/registry.ts";
import { effectiveTier, GLOBAL_ARGS, parseArgs, type RunContext } from "./core/registry-types.ts";
import { defaultLogPath, ui } from "./core/ui.ts";
import { shareCheckout } from "./core/share.ts";
import { writeStatus } from "./core/status.ts";
import { hostLock } from "./core/lock.ts";
import { currentUser, homeOf } from "./core/exec.ts";
import {
  count,
  endRun,
  flushEvents,
  initTelemetry,
  phaseListener,
  startRun,
} from "./core/telemetry.ts";
import { VERSION } from "./version.ts";

/**
 * cloud-init (the first boot) and some service managers start archon without
 * $HOME. Tools assume it (chezmoi refuses to run, so its smoke test failed and
 * it was rolled back on alpha' first boot): take it from the account database.
 */
export async function ensureHome(): Promise<void> {
  // Windows keeps the home in USERPROFILE and sets no HOME: one set here ("/") would send Git for
  // Windows to //.config/git/config, which it cannot read.
  if (proc.build.os === "windows" || proc.env.get("HOME")) return;
  const home = await homeOf(currentUser());
  proc.env.set("HOME", home && home !== "/" ? home : asRoot() ? "/root" : "/");
}

/** This host's name in the model: /etc/archon/host, else the short hostname. */
export async function localHostName(): Promise<string> {
  try {
    return (await fs.readTextFile(onHost("/etc/archon/host"))).trim();
  } catch {
    return proc.hostname().split(".")[0] ?? "";
  }
}

/** Which command this is: `stolos` on your PC, `archon` on a machine. */
export type Surface = "pc" | "machine";

/** The command's name for a surface. */
export const commandName = (s: Surface): string => (s === "pc" ? "stolos" : "archon");

function usage(surface: Surface): string {
  const cmds = COMMANDS.filter((c) => offeredOn(c, surface));
  const width = Math.max(...cmds.map((c) => c.name.length), 10);
  const me = commandName(surface);
  return [
    surface === "pc"
      ? "usage: bun run stolos <command> [options]   (in your fleet repository, on your PC)"
      : "usage: archon <command> [options]   (on this machine)",
    "",
    ...cmds.map(
      (c) =>
        `  ${c.name.padEnd(width)}  ${c.summary}${
          c.aliases ? ` (also: ${c.aliases.join(", ")})` : ""
        }`,
    ),
    ...(surface === "pc"
      ? [
          "  " +
            "boot <sub>".padEnd(width) +
            "  The boot server: serve, arm, status, doctor, reinstall, retire, ...",
        ]
      : []),
    "",
    surface === "pc"
      ? "Global options: --fleet <id>, --client <id> (a provider's client), --host <name>, --json, -v/--verbose."
      : "Global options: --fleet <id>, --host <name>, --json, -v/--verbose.",
    surface === "pc"
      ? "Where you are, and the one thing to do next: bun run stolos (no arguments). A problem's code: stolos explain <code>."
      : "This machine's state: archon (no arguments). Every command has a man page: man archon-<command>. A problem's code: archon explain <code>.",
    `The other command: ${
      surface === "pc"
        ? "archon, on each server and workstation"
        : "stolos, on your PC in the fleet repository"
    } (${me} is this one).`,
  ].join("\n");
}

/** The global options of a run (`GLOBAL_ARGS`). */
type Globals = {
  fleet?: string;
  client?: string;
  host?: string;
  json?: boolean;
  verbose?: boolean;
};

/** Pull global options out of argv. */
function globals(argv: readonly string[]): { rest: string[]; g: Globals } {
  const rest: string[] = [];
  const g: Globals = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "-v") {
      g.verbose = true;
      continue;
    }
    const [k = "", inline] = a.startsWith("--") ? a.slice(2).split("=", 2) : [""];
    const spec = GLOBAL_ARGS.find((x) => x.name === k);
    if (spec === undefined) {
      rest.push(a);
      continue;
    }
    const value = spec.type === "boolean" ? undefined : (inline ?? argv[++i]);
    switch (k) {
      case "json":
      case "verbose":
        g[k] = true;
        break;
      case "fleet":
      case "client":
      case "host":
        if (value !== undefined) g[k] = value;
        break;
    }
  }
  return { rest, g };
}

/** A line of the program's own output (help, the version), on standard output. */
function print(text: string): void {
  stdio.stdout.writeSync(`${text}\n`);
}

/** A line for the person at the terminal, before any phase is drawn (usage errors). */
function complain(text: string): void {
  stdio.stderr.writeSync(`${text}\n`);
}

/** With `ARCHON_DEBUG`, the error's whole stack. */
function debug(e: unknown): void {
  if (proc.env.get("ARCHON_DEBUG"))
    complain(e instanceof Error ? (e.stack ?? e.message) : String(e));
}

/** The CLI: parses global options, finds the command offered here, and runs it. Returns the exit code. */
export async function main(
  argvIn: readonly string[],
  surface: Surface = "machine",
): Promise<number> {
  let argv = [...argvIn];
  await ensureHome();
  // Spec 059: the run log's folder is named after the command (stolos on your PC).
  const { setLogProgram } = await import("./core/ui.ts");
  setLogProgram(surface === "pc" ? "stolos" : "archon");
  // Spec 053: no arguments is "where am I, and what next" (on a machine: its state).
  const home = surface === "pc" ? "where" : "state";
  if (!argv.length) argv = [home];
  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    print(usage(surface));
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "version") {
    print(`${commandName(surface)} ${VERSION}`);
    return 0;
  }
  const { rest, g } = globals(argv);
  if (!rest.length) rest.push(home); // only global options: still the default
  // Spec 082: --client (or the client chosen with clients use) scopes this run to that client.
  if (surface === "pc" || g.client !== undefined) {
    const { resolveClientScope } = await import("./clients/commands.ts");
    const sc = await resolveClientScope(g.client, rest[0] ?? home);
    if (sc.error) {
      complain(`${ui.red("error:")} ${sc.error}`);
      return 2;
    }
    if (sc.client && g.fleet !== undefined && g.fleet !== sc.client.fleet) {
      complain(
        `${ui.red("error:")} client ${sc.client.id} is fleet ${sc.client.fleet}: drop --fleet`,
      );
      return 2;
    }
    if (sc.client && !g.json && g.client === undefined) {
      complain(ui.dim(`client ${sc.client.id} (${sc.client.title}), chosen with clients use`));
    }
  }
  // Spec 046: --fleet chooses the fleet for this run (and what it starts through sudo).
  if (g.fleet !== undefined) {
    proc.env.set("ARCHON_FLEET", g.fleet);
    resetRoots();
  }
  const found = findCommand(rest, surface);
  if (!found) {
    // Spec 059: the other command's? Say which, and how.
    const other: Surface = surface === "pc" ? "machine" : "pc";
    const there = findCommand(rest, other);
    if (there) {
      complain(
        other === "pc"
          ? `${ui.red(
              "error:",
            )} '${there.cmd.name}' is a fleet command: on your PC, in the fleet repository: bun run stolos ${rest.join(
              " ",
            )}`
          : `${ui.red("error:")} '${there.cmd.name}' runs on a machine: there, archon ${rest.join(
              " ",
            )} (for example: ssh -t <host> archon ${there.cmd.name})`,
      );
      return 2;
    }
    complain(`${ui.red("error:")} unknown command: ${rest.join(" ")}`);
    complain(usage(surface));
    return 2;
  }
  const { cmd } = found;
  if (found.rest.includes("--help")) {
    print(`${commandName(surface)} ${cmd.name}: ${cmd.summary}\n${cmd.description}`);
    return 0;
  }
  try {
    const args = parseArgs(cmd, found.rest);
    const tier = effectiveTier(cmd, args);
    if (cmd.precheck && !asRoot()) {
      const done = await cmd.precheck(args, {
        hostName: g.host ?? (await localHostName()),
        json: g.json === true,
        verbose: g.verbose === true,
      });
      if (done !== undefined) return done;
    }
    // Host-mutating commands elevate through sudo (operators have passwordless
    // sudo for archon only; admins are prompted). Article 17. Never on the
    // Windows boot machine, where nothing host-mutating runs.
    if (
      (tier === "mutate" || tier === "destructive" || cmd.asOwner) &&
      !asRoot() &&
      !args["root"] &&
      proc.build.os !== "windows"
    ) {
      const self = proc.env.get("ARCHON_SELF") ?? "/usr/local/bin/archon";
      const p = await proc.output(
        [
          "sudo",
          "--preserve-env=ARCHON_AGENT,ARCHON_VERBOSE,ARCHON_PLAIN,NO_COLOR,LANG,LC_ALL,TERM,TRACEPARENT,ARCHON_FLEET,ARCHON_REPO,ARCHON_CLIENT,ARCHON_GITHUB_API",
          self,
          ...argv,
        ],
        { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      );
      return p.code;
    }
    // Spec 021: this run is a trace, its phases spans (silent without a collector).
    initTelemetry(commandName(surface), VERSION);
    startRun(cmd.name, {
      "archon.tier": tier,
      "archon.fleet": P.fleetId,
      "archon.host": g.host ?? (await localHostName()),
      "archon.engine.version": VERSION,
    });
    if (args["confirm-destroy"] !== undefined) count("archon.confirm_destroy.used");
    ui.listeners.push(phaseListener);
    const ctx: RunContext = {
      hostName: g.host ?? (await localHostName()),
      json: g.json === true,
      verbose: g.verbose === true,
    };
    if (ctx.verbose) ui.verbose = true;
    if (ctx.json) ui.quiet = true;
    // One host-changing run at a time; the lock is released when this process exits.
    if ((tier === "mutate" || tier === "destructive") && asRoot() && !cmd.unlocked) {
      const held = await hostLock({
        wait: cmd.name !== "reconcile",
        onWait: (holder) => {
          complain(
            ui.dim(
              holder
                ? `waiting for ${lock.describeHolder(
                    holder,
                  )} to finish... (Ctrl+C is safe; see it with: journalctl _PID=${holder.pid} -f)`
                : "waiting for another archon run on this host to finish (the reconcile timer or a second terminal)...",
            ),
          );
        },
      });
      if (!held) {
        complain("another archon run is in progress; skipping this reconcile");
        return 0;
      }
    }
    // The prompt's Archon segment (spec 011) follows every run that records something.
    const record = (failures: number, warnings: number, deferred: number): Promise<void> =>
      (tier === "read" && cmd.name !== "push") || cmd.unlocked
        ? Promise.resolve()
        : writeStatus({ command: cmd.name, failures, warnings, deferred });
    if (!cmd.operation) {
      let code = 1;
      try {
        code = await cmd.run(args, ctx);
        return code;
      } finally {
        await shareCheckout();
        await record(code ? 1 : 0, 0, 0);
        endRun(code, code ? 1 : 0, 0);
        await flushEvents(ui.problems);
      }
    }
    // Operations (Article 19): header, phases, one run log, closing summary.
    ui.useLog(defaultLogPath());
    ui.header(
      `${surface === "pc" ? "Stolos" : "Archon"} ${cmd.name}`,
      `${ctx.hostName}${tier === "read" ? " · read-only" : ""}`,
    );
    let code = 1;
    try {
      code = await cmd.run(args, ctx);
    } catch (e) {
      ui.active(cmd.name).fail(e instanceof Error ? e.message : String(e));
      debug(e);
    }
    await shareCheckout();
    await record(
      ui.problems.filter((p) => p.level === "fail").length,
      ui.problems.filter((p) => p.level === "warn").length,
      ui.deferred.length,
    );
    endRun(
      code,
      ui.problems.filter((p) => p.level === "fail").length,
      ui.problems.filter((p) => p.level === "warn").length,
    );
    await flushEvents(ui.problems);
    const summary = ui.finish({ title: `${cmd.name} finished` });
    return Math.max(code, summary);
  } catch (e) {
    complain(`${ui.red("error:")} ${e instanceof Error ? e.message : String(e)}`);
    debug(e);
    return 1;
  }
}

/**
 * Run as a program and exit: from this file, or from a fleet repository's own
 * entry file, which imports this one by the package's name (spec 096).
 */
export async function run(
  argv: readonly string[] = proc.args,
  surface: Surface = "machine",
): Promise<never> {
  const code = await main(argv, surface);
  ui.printPanel(); // spec 029: a secret changed and is not backed up yet
  return proc.exit(code);
}

if (import.meta.main) await run();
