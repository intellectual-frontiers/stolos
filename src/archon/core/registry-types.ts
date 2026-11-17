/**
 * Types for the command registry (Article VI). One definition per capability
 * generates the CLI, MCP tools, man pages, fish completions, and the agent's
 * permission rules.
 *
 * @module
 */
// Spec: 101-ladder FR-006
// Spec: 105-calm-output FR-001, FR-002
// Spec: 108-tags FR-006
import { proc } from "@intellectual-frontiers/commons/ts/runtime";
import type { CommandTier, OutputClass } from "../ontology.auto.ts";

/**
 * What a command may do, from least to most: read, change the repository, change a machine, or
 * destroy something (the agent's permission rules follow it): the ontology's command tiers
 * (`stolos:CommandTier`, spec 101-ladder FR-006).
 */
export type Tier = CommandTier;

/** One argument of a command: an option (--name) or a positional value. */
export interface ArgSpec {
  /** Its name (the option is --name). */
  name: string;
  /** A value, or a flag. */
  type: "string" | "boolean";
  /** What it does, in one line (help, man page, MCP). */
  description: string;
  /** Given without --name, in order. */
  positional?: boolean;
  /** A one-letter form (-m for --message). */
  short?: string;
  /** The command refuses to run without it. */
  required?: boolean;
  /** Its value when it is not given. */
  default?: string | boolean;
  /** May be given more than once (the last positional too: `tag add <machine> <tag...>`); the values are joined with newlines. */
  repeatable?: boolean;
  /**
   * Only a person types it (--confirm-destroy, Article 23; --show for a secret): never offered over
   * MCP, and refused when an agent runs the command (ARCHON_AGENT is set).
   */
  human?: boolean;
  /** The only values it takes (a console shows a choice). */
  choices?: string[];
}

/** A command's arguments, parsed: name to value. */
export type Parsed = Record<string, string | boolean | undefined>;

/** What every command is given besides its arguments. */
export interface RunContext {
  /** The host this invocation operates on. */
  hostName: string;
  /** --json: machine-readable output, nothing drawn. */
  json: boolean;
  /** -v: every item, as it happens. */
  verbose?: boolean;
  /** -q: only one verdict line and the exit code (spec 105-calm-output FR-002). */
  quiet?: boolean;
}

/** One archon command: its name, help, tier, arguments, and what it runs. The man pages, the MCP tools, and `archon help` all come from these. */
export interface Command {
  /** Space-separated words, for example "tools sync". */
  name: string;
  /** One line, for archon help. */
  summary: string;
  /** Paragraphs separated by blank lines. */
  description: string;
  /** What it may do: read, write the repository, change the host, or destroy (spec 030: MCP serves up to the fleet's tier). */
  tier: Tier;
  /**
   * What it is for (spec 105-calm-output FR-001): a `report` is read as a whole and is verbose by
   * default; an `action` does something and is calm by default. Every command declares one.
   */
  output: OutputClass;
  /** Tier when this flag is set (for example apply --check is read-only). */
  readOnlyWith?: string;
  /**
   * The reverse: read-only, except with this flag, which changes the host
   * (fs s3 key --rotate). It then elevates, and counts as mutate over MCP.
   */
  mutateWith?: string;
  /**
   * Always runs elevated, even when read-only, because it works through the
   * checkout's owner (ops and the host's deploy key): push. Operators and the
   * admin are in archon-ops, so sudo does not prompt (spec 006).
   */
  asOwner?: boolean;
  /** Its arguments. */
  args: ArgSpec[];
  /** Examples, for its man page. */
  examples?: Array<{ cmd: string; text: string }>;
  /** Related man pages. */
  seeAlso?: string[];
  /** Hide from MCP (for example `mcp` itself). */
  noMcp?: boolean;
  /**
   * An operation (Article XXII): runs in phases with a header, a run log, and
   * a closing summary instead of printing a result.
   */
  operation?: boolean;
  /**
   * Touches only its own files (archon notify's spool): no host lock, so it
   * never waits for or blocks an apply, and it leaves the prompt's last-run
   * segment alone.
   */
  unlocked?: boolean;
  /**
   * A look before elevating (spec 038): when it returns a code, the command is
   * already satisfied and finishes unprivileged, so an idempotent mutate
   * command (archon pg ensure) works unattended for a normal user once its
   * work is done.
   */
  precheck?: (args: Parsed, ctx: RunContext) => Promise<number | undefined>;
  /**
   * Where it runs: "pc" (`stolos`, in the fleet repository on your PC), "machine"
   * (`archon`, on each server or workstation), or "both".
   */
  place?: Place;
  /** Other names for it (spec 060: stolos push is stolos apply). */
  aliases?: string[];
  /** Runs it; returns the exit code. */
  run: (args: Parsed, ctx: RunContext) => Promise<number>;
}

/** Where a command runs: your PC (stolos), each machine (archon), or both. */
export type Place = "pc" | "machine" | "both";

/** The tier this run needs (a command's tier can depend on its arguments, for example --check). */
export function effectiveTier(cmd: Command, args: Parsed): Tier {
  if (cmd.mutateWith && args[cmd.mutateWith]) return "mutate";
  return cmd.readOnlyWith && args[cmd.readOnlyWith] ? "read" : cmd.tier;
}

/** Parse argv for this command, or throw a message naming the problem (a person-only option from an agent is refused). */
export function parseArgs(cmd: Command, argv: string[]): Parsed {
  const out: Parsed = {};
  const positionals = cmd.args.filter((a) => a.positional);
  let pi = 0;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i] ?? "";
    // A one-letter form: -m "text" is --message "text".
    const short = /^-([a-zA-Z])$/.exec(a)?.[1];
    if (short !== undefined) {
      const s = cmd.args.find((x) => x.short === short);
      if (!s) throw new Error(`unknown option -${short} for '${cmd.name}'`);
      a = `--${s.name}`;
    }
    if (a.startsWith("--")) {
      const [k = "", inline] = a.slice(2).split("=", 2);
      const spec = cmd.args.find((x) => x.name === k && !x.positional);
      if (!spec) throw new Error(`unknown option --${k} for 'archon ${cmd.name}'`);
      if (spec.type === "boolean") out[k] = inline === undefined ? true : inline !== "false";
      else {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error(`--${k} needs a value: ${spec.description}`);
        out[k] = spec.repeatable && typeof out[k] === "string" ? `${out[k]}\n${v}` : v;
      }
    } else {
      const spec = positionals[pi++];
      if (!spec) {
        // Spec 108-tags: the last positional may repeat (`tag add <machine> <tag...>`); its values are joined with newlines.
        const rest = positionals[positionals.length - 1];
        if (!rest?.repeatable)
          throw new Error(`unexpected argument '${a}' for 'archon ${cmd.name}'`);
        out[rest.name] = `${out[rest.name] as string}\n${a}`;
      } else out[spec.name] = a;
    }
  }
  const agent = proc.env.get("ARCHON_AGENT");
  for (const s of cmd.args) {
    if (s.human && out[s.name] !== undefined && agent) {
      throw new Error(
        `--${s.name} is typed by a person, not an agent (${agent}): run archon ${cmd.name} yourself`,
      );
    }
  }
  for (const s of cmd.args) {
    if (out[s.name] === undefined && s.default !== undefined) out[s.name] = s.default;
    if (s.required && out[s.name] === undefined) {
      throw new Error(`missing required ${s.positional ? "argument" : "option --"}${s.name}`);
    }
  }
  return out;
}

/** Arguments shared by every command. */
export const GLOBAL_ARGS: ArgSpec[] = [
  {
    name: "fleet",
    type: "string",
    description:
      "The fleet of this repository to work on (fleets/<id>/), when it holds more than one (also ARCHON_FLEET).",
  },
  {
    name: "client",
    type: "string",
    description:
      "On a provider's PC (spec 082): run this command for one client, in its own checkout, state, and secrets (stolos clients list).",
  },
  {
    name: "host",
    type: "string",
    description: "Operate on this host model instead of the local host.",
  },
  { name: "json", type: "boolean", description: "Print machine-readable JSON where supported." },
  {
    name: "verbose",
    type: "boolean",
    description:
      "Show every step as it happens, the green ones too, for any command (also -v or ARCHON_VERBOSE=1); the run log always has everything.",
  },
  {
    name: "quiet",
    type: "boolean",
    description:
      "Print one verdict line and exit with the code, nothing else (also -q); the run log still has everything.",
  },
  {
    name: "fresh",
    type: "boolean",
    description:
      "Do not use what an earlier run remembered (the firewall check is kept for five minutes): ask the system again (spec 106-one-passphrase-speed).",
  },
];
