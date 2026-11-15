/**
 * The command line, for both commands (spec 059): `archon` on each machine
 * (servers, workstations) and `stolos` on your PC (src/stolos/main.ts), over
 * one registry where every command says where it runs. See archon(1).
 *
 * @module
 */

import { P, resetRoots } from "./core/paths.ts";
import { COMMANDS, findCommand, offeredOn } from "./commands/registry.ts";
import { effectiveTier, GLOBAL_ARGS, parseArgs, type RunContext } from "./core/registry-types.ts";
import { isRoot } from "./core/exec.ts";
import { defaultLogPath, ui } from "./core/ui.ts";
import { shareCheckout } from "./core/share.ts";
import { writeStatus } from "./core/status.ts";
import { hostLock } from "./core/lock.ts";
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
  if (Deno.env.get("HOME")) return;
  const { currentUser, homeDir } = await import("./core/exec.ts");
  const home = await homeDir(currentUser());
  Deno.env.set("HOME", home && home !== "/" ? home : isRoot() ? "/root" : "/");
}

/** This host's name in the model: /etc/archon/host, else the short hostname. */
export async function localHostName(): Promise<string> {
  try {
    return (await Deno.readTextFile("/etc/archon/host")).trim();
  } catch {
    return Deno.hostname().split(".")[0];
  }
}

/** Which command this is: `stolos` on your PC, `archon` on a machine. */
export type Surface = "pc" | "machine";

/** The command's name for a surface. */
export const commandName = (s: Surface): string => s === "pc" ? "stolos" : "archon";

function usage(surface: Surface): string {
  const cmds = COMMANDS.filter((c) => offeredOn(c, surface));
  const width = Math.max(...cmds.map((c) => c.name.length), 10);
  const me = commandName(surface);
  return [
    surface === "pc"
      ? "usage: deno task stolos <command> [options]   (in your fleet repository, on your PC)"
      : "usage: archon <command> [options]   (on this machine)",
    "",
    ...cmds.map((c) =>
      `  ${c.name.padEnd(width)}  ${c.summary}${
        c.aliases ? ` (also: ${c.aliases.join(", ")})` : ""
      }`
    ),
    ...(surface === "pc"
      ? [
        "  " + "boot <sub>".padEnd(width) +
        "  The boot server: serve, arm, status, doctor, reinstall, retire, ...",
      ]
      : []),
    "",
    surface === "pc"
      ? "Global options: --fleet <id>, --client <id> (a provider's client), --host <name>, --json, -v/--verbose."
      : "Global options: --fleet <id>, --host <name>, --json, -v/--verbose.",
    surface === "pc"
      ? "Where you are, and the one thing to do next: deno task stolos (no arguments). A problem's code: stolos explain <code>."
      : "This machine's state: archon (no arguments). Every command has a man page: man archon-<command>. A problem's code: archon explain <code>.",
    `The other command: ${
      surface === "pc"
        ? "archon, on each server and workstation"
        : "stolos, on your PC in the fleet repository"
    } (${me} is this one).`,
  ].join("\n");
}

/** Pull global options out of argv. */
function globals(argv: string[]) {
  const rest: string[] = [];
  const g: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-v") {
      g.verbose = true;
      continue;
    }
    const [k, inline] = a.startsWith("--") ? a.slice(2).split("=", 2) : [""];
    const spec = GLOBAL_ARGS.find((x) => x.name === k);
    if (spec) g[k] = spec.type === "boolean" ? true : inline ?? argv[++i];
    else rest.push(a);
  }
  return { rest, g };
}

/** The CLI: parses global options, finds the command offered here, and runs it. Returns the exit code. */
export async function main(argv: string[], surface: Surface = "machine"): Promise<number> {
  await ensureHome();
  // Spec 059: the run log's folder is named after the command (stolos on your PC).
  const { setLogProgram } = await import("./core/ui.ts");
  setLogProgram(commandName(surface) as "stolos" | "archon");
  // Spec 053: no arguments is "where am I, and what next" (on a machine: its state).
  const home = surface === "pc" ? "where" : "state";
  if (!argv.length) argv = [home];
  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    console.log(usage(surface));
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "version") {
    console.log(`${commandName(surface)} ${VERSION}`);
    return 0;
  }
  const { rest, g } = globals(argv);
  if (!rest.length) rest.push(home); // only global options: still the default
  // Spec 082: --client (or the client chosen with clients use) scopes this run to that client.
  if (surface === "pc" || typeof g.client === "string") {
    const { resolveClientScope } = await import("./clients/commands.ts");
    const sc = await resolveClientScope(
      typeof g.client === "string" ? g.client : undefined,
      rest[0],
    );
    if (sc.error) {
      console.error(`${ui.red("error:")} ${sc.error}`);
      return 2;
    }
    if (sc.client && typeof g.fleet === "string" && g.fleet !== sc.client.fleet) {
      console.error(
        `${ui.red("error:")} client ${sc.client.id} is fleet ${sc.client.fleet}: drop --fleet`,
      );
      return 2;
    }
    if (sc.client && !g.json && typeof g.client !== "string") {
      console.error(ui.dim(`client ${sc.client.id} (${sc.client.title}), chosen with clients use`));
    }
  }
  // Spec 046: --fleet chooses the fleet for this run (and what it starts through sudo).
  if (typeof g.fleet === "string") {
    Deno.env.set("ARCHON_FLEET", g.fleet);
    resetRoots();
  }
  const found = findCommand(rest, surface);
  if (!found) {
    // Spec 059: the other command's? Say which, and how.
    const other: Surface = surface === "pc" ? "machine" : "pc";
    const there = findCommand(rest, other);
    if (there) {
      console.error(
        other === "pc"
          ? `${
            ui.red("error:")
          } '${there.cmd.name}' is a fleet command: on your PC, in the fleet repository: deno task stolos ${
            rest.join(" ")
          }`
          : `${ui.red("error:")} '${there.cmd.name}' runs on a machine: there, archon ${
            rest.join(" ")
          } (for example: ssh -t <host> archon ${there.cmd.name})`,
      );
      return 2;
    }
    console.error(`${ui.red("error:")} unknown command: ${rest.join(" ")}`);
    console.error(usage(surface));
    return 2;
  }
  const { cmd } = found;
  if (found.rest.includes("--help")) {
    console.log(
      `${commandName(surface)} ${cmd.name}: ${cmd.summary}\n${cmd.description}`,
    );
    return 0;
  }
  try {
    const args = parseArgs(cmd, found.rest);
    const tier = effectiveTier(cmd, args);
    if (cmd.precheck && !isRoot()) {
      const done = await cmd.precheck(args, {
        hostName: (g.host as string) ?? await localHostName(),
        json: !!g.json,
        verbose: !!g.verbose,
      });
      if (done !== undefined) return done;
    }
    // Host-mutating commands elevate through sudo (operators have passwordless
    // sudo for archon only; admins are prompted). Article 17. Never on the
    // Windows boot machine, where nothing host-mutating runs.
    if (
      (tier === "mutate" || tier === "destructive" || cmd.asOwner) && !isRoot() && !args.root &&
      Deno.build.os !== "windows"
    ) {
      const self = Deno.env.get("ARCHON_SELF") ?? "/usr/local/bin/archon";
      const p = new Deno.Command("sudo", {
        args: [
          "--preserve-env=ARCHON_AGENT,ARCHON_VERBOSE,ARCHON_PLAIN,NO_COLOR,LANG,LC_ALL,TERM,TRACEPARENT,ARCHON_FLEET,ARCHON_REPO,ARCHON_CLIENT,ARCHON_GITHUB_API",
          self,
          ...argv,
        ],
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
      return (await p.status).code;
    }
    // Spec 021: this run is a trace, its phases spans (no-op without OTEL_DENO).
    await initTelemetry();
    startRun(cmd.name, {
      "archon.tier": tier,
      "archon.fleet": P.fleetId,
      "archon.host": (g.host as string) ?? await localHostName(),
      "archon.engine.version": VERSION,
    }, commandName(surface));
    if (args["confirm-destroy"] !== undefined) count("archon.confirm_destroy.used");
    ui.listeners.push(phaseListener);
    const ctx: RunContext = {
      hostName: (g.host as string) ?? await localHostName(),
      json: !!g.json,
      verbose: !!g.verbose,
    };
    if (ctx.verbose) ui.verbose = true;
    if (ctx.json) ui.quiet = true;
    // One host-changing run at a time; the lock is released when this process exits.
    if ((tier === "mutate" || tier === "destructive") && isRoot() && !cmd.unlocked) {
      const held = await hostLock({
        wait: cmd.name !== "reconcile",
        onWait: async (holder) => {
          const { describeHolder } = await import("./core/lock.ts");
          console.error(
            ui.dim(
              holder
                ? `waiting for ${
                  describeHolder(holder)
                } to finish... (Ctrl+C is safe; see it with: journalctl _PID=${holder.pid} -f)`
                : "waiting for another archon run on this host to finish (the reconcile timer or a second terminal)...",
            ),
          );
        },
      });
      if (!held) {
        console.error("another archon run is in progress; skipping this reconcile");
        return 0;
      }
    }
    // The prompt's Archon segment (spec 011) follows every run that records something.
    const record = (failures: number, warnings: number, deferred: number) =>
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
      ui.active(cmd.name).fail((e as Error).message);
      if (Deno.env.get("ARCHON_DEBUG")) console.error(e);
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
    console.error(`${ui.red("error:")} ${(e as Error).message}`);
    if (Deno.env.get("ARCHON_DEBUG")) console.error(e);
    return 1;
  }
}

/**
 * Run as a program and exit: from this file, or from a fleet repository's own
 * entry file, which imports this one through `@stolos/` (spec 046-engine-instance).
 */
export async function run(
  argv: string[] = Deno.args,
  surface: Surface = "machine",
): Promise<never> {
  const code = await main(argv, surface);
  ui.printPanel(); // spec 029: a secret changed and is not backed up yet
  Deno.exit(code);
}

if (import.meta.main) await run();
