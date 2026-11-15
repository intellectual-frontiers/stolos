/**
 * Spec 065: how the Archon Console runs a command for the person signed in.
 *
 * The console's web server runs as the `archon-console` account, in a
 * sandbox that cannot change the system. For each command it runs
 * `sudo -n archon console exec --as <person> --argv '<command as JSON>'` (that account is
 * in archon-ops, which may run archon as root). `console exec`, as root:
 *
 * 1. accepts only the console's account (SUDO_USER is archon-console);
 * 2. checks again that the person may run it (their groups, the command's
 *    tier as its arguments make it): the web server is never trusted alone;
 * 3. asks systemd to run `archon <command...>` as a transient service, outside
 *    the console's sandbox, with SUDO_USER set to the person, so every record
 *    the command writes names them (as `sudo archon ...` from their own
 *    shell would), and ARCHON_VIA=web;
 * 4. after a command that changes the server, mails the fleet's mailbox.
 *
 * ```mermaid
 * flowchart LR
 *   web["archon web serve<br/>(archon-console, sandboxed)"] -- "sudo -n" --> exec["archon console exec<br/>(root: checks again)"]
 *   exec -- "systemd-run --pipe --wait" --> cmd["archon &lt;command&gt;<br/>SUDO_USER=&lt;person&gt;"]
 *   cmd -- "output, line by line" --> web
 * ```
 *
 * @module
 */

import { run } from "../core/exec.ts";
import { effectiveTier, parseArgs } from "../core/registry-types.ts";
import { type AccountLookup, mayRun, roleOf, systemAccounts, USERNAME } from "./auth.ts";
import { NOT_IN_CONSOLE } from "./forms.ts";

/** The console's own account: the only one `console exec` serves. */
export const CONSOLE_USER = "archon-console";

/** Where archon is installed on a machine. */
export const ARCHON_BIN = "/usr/local/bin/archon";

/** Runs a command for a person, line by line: systemd on a server, a fake in tests. */
export interface Runner {
  /** Run `argv` (an archon command) as `user`; each output line to `line`; the exit code. */
  run(user: string, argv: string[], line: (s: string) => void): Promise<number>;
}

/** Read a stream's lines as they come. */
async function lines(stream: ReadableStream<Uint8Array>, each: (s: string) => void): Promise<void> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      each(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  if (buf) each(buf);
}

/** The server's runner: `sudo -n archon console exec --as <user> --argv <JSON>`, output as it comes. */
export const systemRunner: Runner = {
  async run(user, argv, line) {
    const p = new Deno.Command("sudo", {
      args: ["-n", ARCHON_BIN, "console", "exec", "--as", user, "--argv", JSON.stringify(argv)],
      // A person's request, not an agent's: nothing of this process's environment passes on.
      clearEnv: true,
      env: {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        NO_COLOR: "1",
        ARCHON_PLAIN: "1",
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    await Promise.all([lines(p.stdout, line), lines(p.stderr, line)]);
    return (await p.status).code;
  },
};

/** Why `console exec` refuses this request, or undefined when it may run. */
export async function execRefusal(
  o: { sudoUser?: string; as: string; argv: string[] },
  accounts: AccountLookup = systemAccounts,
): Promise<string | undefined> {
  if (o.sudoUser !== CONSOLE_USER) return `only the Archon Console (${CONSOLE_USER}) runs this`;
  if (!USERNAME.test(o.as)) return `not a username: ${o.as}`;
  const account = await accounts(o.as);
  if (!account) return `${o.as} may not use the console (no such person here)`;
  const { findCommand } = await import("../commands/registry.ts");
  const found = findCommand(o.argv, "machine");
  if (!found || found.cmd.noMcp || NOT_IN_CONSOLE.has(found.cmd.name)) {
    return `not a command the console runs: ${o.argv.slice(0, 3).join(" ")}`;
  }
  let tier;
  try {
    tier = effectiveTier(found.cmd, parseArgs(found.cmd, found.rest));
  } catch (e) {
    return (e as Error).message;
  }
  if (!mayRun(roleOf(account.groups), tier)) {
    return `${o.as} may not run ${found.cmd.name} (it ${
      tier === "destructive" ? "destroys data" : "changes the server"
    }; operators are in sudo or archon-ops)`;
  }
  return undefined;
}

/**
 * `archon console exec --as <person> --argv <JSON>` (root, through sudo, for
 * the console only): check, run as a transient systemd service with the
 * person's name, stream its output, mail the mailbox after a change.
 */
export async function consoleExec(as: string, argv: string[]): Promise<number> {
  const refusal = await execRefusal({ sudoUser: Deno.env.get("SUDO_USER"), as, argv });
  if (refusal) {
    console.error(`archon console exec: ${refusal}`);
    return 2;
  }
  const { findCommand } = await import("../commands/registry.ts");
  const found = findCommand(argv, "machine")!;
  const tier = effectiveTier(found.cmd, parseArgs(found.cmd, found.rest));
  const p = new Deno.Command("systemd-run", {
    args: [
      "--pipe",
      "--wait",
      "--quiet",
      "--collect",
      "--service-type=exec",
      `--description=archon ${found.cmd.name} (web: ${as})`,
      `--setenv=SUDO_USER=${as}`,
      "--setenv=ARCHON_VIA=web",
      "--setenv=NO_COLOR=1",
      "--setenv=ARCHON_PLAIN=1",
      "--setenv=LANG=C.UTF-8",
      "--setenv=HOME=/root",
      ARCHON_BIN,
      ...argv,
    ],
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const code = (await p.status).code;
  if (tier !== "read") {
    const { notify } = await import("../notify/events.ts");
    await notify({
      event: `${code === 0 ? "" : "✗ "}${as} ran archon ${found.cmd.name} from the web console`,
      level: code === 0 ? "info" : "warn",
      what: `archon ${argv.join(" ")}\nby ${as}, from the Archon Console; it ${
        code === 0 ? "finished" : `failed (exit ${code})`
      }.`,
      key: `console:${as}:${found.cmd.name}:${new Date().toISOString().slice(0, 16)}`,
    });
  }
  await run(["logger", "-t", "archon-console", `${as} ran archon ${argv.join(" ")}: exit ${code}`]);
  return code;
}
