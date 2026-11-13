// Types for the command registry (Article VI). One definition per capability
// generates the CLI, MCP tools, man pages, fish completions, and the agent's
// permission rules.

export type Tier = "read" | "repo" | "mutate" | "destructive";

export interface ArgSpec {
  name: string;
  type: "string" | "boolean";
  description: string;
  positional?: boolean;
  required?: boolean;
  default?: string | boolean;
  /** May be given more than once; the values are joined with newlines. */
  repeatable?: boolean;
  /**
   * Only a person types it (--confirm-destroy, Article 23; --show for a secret): never offered over
   * MCP, and refused when an agent runs the command (ARCHON_AGENT is set).
   */
  human?: boolean;
}

export type Parsed = Record<string, string | boolean | undefined>;

export interface RunContext {
  /** The host this invocation operates on. */
  hostName: string;
  json: boolean;
  verbose?: boolean;
}

export interface Command {
  /** Space-separated words, for example "tools sync". */
  name: string;
  summary: string;
  /** Paragraphs separated by blank lines. */
  description: string;
  tier: Tier;
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
  args: ArgSpec[];
  examples?: Array<{ cmd: string; text: string }>;
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
  run: (args: Parsed, ctx: RunContext) => Promise<number>;
}

export function effectiveTier(cmd: Command, args: Parsed): Tier {
  if (cmd.mutateWith && args[cmd.mutateWith]) return "mutate";
  return cmd.readOnlyWith && args[cmd.readOnlyWith] ? "read" : cmd.tier;
}

export function parseArgs(cmd: Command, argv: string[]): Parsed {
  const out: Parsed = {};
  const positionals = cmd.args.filter((a) => a.positional);
  let pi = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
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
      if (!spec) throw new Error(`unexpected argument '${a}' for 'archon ${cmd.name}'`);
      out[spec.name] = a;
    }
  }
  const agent = Deno.env.get("ARCHON_AGENT");
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
    name: "host",
    type: "string",
    description: "Operate on this host model instead of the local host.",
  },
  { name: "json", type: "boolean", description: "Print machine-readable JSON where supported." },
  {
    name: "verbose",
    type: "boolean",
    description:
      "Show every item as it happens (also -v or ARCHON_VERBOSE=1); the run log always has everything.",
  },
];
