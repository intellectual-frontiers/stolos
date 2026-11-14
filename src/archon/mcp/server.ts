/**
 * `archon mcp`: a Model Context Protocol server over stdio (JSON-RPC 2.0,
 * newline-delimited), implemented natively without an SDK (Article II).
 * Every registry command within the tier limit is a tool; docs, specs,
 * runbooks, and reports are resources. Workstations reach it on a server as
 * ops over SSH, forced to `archon mcp --max-tier <tier>` (spec 030): the limit
 * is enforced here, on the server, whatever the client is configured to do.
 *
 * @module
 */

import { count, parseTraceparent } from "../core/telemetry.ts";
import { COMMANDS } from "../commands/registry.ts";
import type { Command, Parsed, Tier } from "../core/registry-types.ts";
import { effectiveTier, GLOBAL_ARGS } from "../core/registry-types.ts";
import { join } from "../core/path.ts";
import { listFiles, readTextOr } from "../core/fsx.ts";
import { P } from "../core/paths.ts";
import { engineFile, engineSpecs } from "../core/assets.ts";
import type { McpTier } from "../model/types.ts";

const PROTOCOL = "2025-06-18";

/** The MCP tool name of a command: `archon_` and its words joined by underscores (`archon_backup_run`). */
export function mcpToolName(c: Command): string {
  return `archon_${c.name.replace(/ /g, "_")}`;
}

const RANK: Record<Tier, number> = { read: 0, repo: 1, mutate: 2, destructive: 3 };

/** A --max-tier value; anything else (or nothing) is mutate, never destructive. */
export function parseTier(s: string | undefined): McpTier {
  if (s === undefined) return "mutate";
  if (s === "read" || s === "repo" || s === "mutate") return s;
  throw new Error(`--max-tier: '${s}' is not read, repo, or mutate`);
}

/** Listed: within the limit, or reducible to read with its read-only flag. */
export function listed(c: Command, limit: McpTier): boolean {
  if (c.noMcp) return false;
  return RANK[c.tier] <= RANK[limit] || !!c.readOnlyWith;
}

/** Allowed for these arguments (apply with check: read; apply without: mutate). */
export function allowed(c: Command, args: Record<string, unknown>, limit: McpTier): boolean {
  return !c.noMcp && RANK[effectiveTier(c, args as Parsed)] <= RANK[limit];
}

/** An MCP tool definition, as `tools/list` returns it. */
export interface McpTool {
  /** The tool's name (see mcpToolName). */
  name: string;
  /** A human title: `archon <command>`. */
  title: string;
  /** The summary, the description's first paragraph, the tier and the man page. */
  description: string;
  /** JSON Schema for the arguments: the command's own and `host`, without person-only ones. */
  inputSchema: {
    /** Always "object". */
    type: "object";
    /** One JSON Schema per argument (type, description, default). */
    properties: Record<string, unknown>;
    /** Names of the required arguments. */
    required: string[];
  };
  /** MCP hints for clients. */
  annotations: {
    /** True for read-tier commands. */
    readOnlyHint: boolean;
    /** True for destructive-tier commands (never served). */
    destructiveHint: boolean;
    /** True for read-tier commands and apply. */
    idempotentHint: boolean;
  };
}

/** The MCP tool definition for a registry command. Arguments only a person types (Article 23) are left out. */
export function toolFor(c: Command): McpTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const a of [...c.args, ...GLOBAL_ARGS.filter((g) => g.name === "host")]) {
    if (a.human) continue; // Article 23: only a person types it
    properties[a.name] = {
      type: a.type,
      description: a.description,
      ...(a.default !== undefined ? { default: a.default } : {}),
    };
    if (a.required) required.push(a.name);
  }
  return {
    name: mcpToolName(c),
    title: `archon ${c.name}`,
    description: `${c.summary}. ${c.description.split(/\n\s*\n/)[0]} (tier: ${c.tier}; man archon-${
      c.name.replace(/ /g, "-")
    })`,
    inputSchema: { type: "object", properties, required },
    annotations: {
      readOnlyHint: c.tier === "read",
      destructiveHint: c.tier === "destructive",
      idempotentHint: c.name === "apply" || c.tier === "read",
    },
  };
}

/** Build an argv for the CLI from MCP tool arguments. */
export function argvFor(c: Command, args: Record<string, unknown>): string[] {
  const argv = c.name.split(" ");
  for (const a of c.args) {
    const v = args[a.name];
    if (v === undefined || v === null || v === false) continue;
    if (a.positional) argv.push(String(v));
    else if (a.type === "boolean") argv.push(`--${a.name}`);
    else argv.push(`--${a.name}`, String(v));
  }
  if (typeof args.host === "string") argv.push("--host", args.host);
  if (args.json === true) argv.push("--json");
  return argv;
}

interface Resource {
  uri: string;
  name: string;
  mimeType: string;
  /** A file on this machine, or the text itself (the engine's own files). */
  path?: string;
  text?: string;
}

async function resources(): Promise<Resource[]> {
  const out: Resource[] = [
    {
      uri: "archon://constitution",
      name: "Archon constitution",
      mimeType: "text/markdown",
      text: engineFile(".specify/memory/constitution.md"),
    },
    {
      uri: "archon://operating-rules",
      name: "Operating rules (AGENTS.md of the fleet's repository)",
      mimeType: "text/markdown",
      path: join(P.repo, "AGENTS.md"),
    },
  ];
  for (const d of engineSpecs()) {
    out.push({
      uri: `archon://specs/${d}/spec.md`,
      name: `Spec ${d}`,
      mimeType: "text/markdown",
      text: engineFile(`specs/${d}/spec.md`),
    });
  }
  for (const sec of ["man1", "man7"]) {
    for (const f of await listFiles(join(P.man, sec))) {
      out.push({
        uri: `archon://man/${f}`,
        name: `man ${f}`,
        mimeType: "text/troff",
        path: join(P.man, sec, f),
      });
    }
  }
  for (const f of await listFiles(join(P.varLib, "reports"), ".md")) {
    out.push({
      uri: `archon://reports/${f}`,
      name: `Report ${f}`,
      mimeType: "text/markdown",
      path: join(P.varLib, "reports", f),
    });
  }
  return out;
}

/** One line in the journal per call (tag archon-mcp), with the SSH client. */
async function journalCall(name: string, args: Record<string, unknown>, verdict: string) {
  const via = Deno.env.get("SSH_CLIENT")?.split(" ")[0] ?? "local";
  try {
    await new Deno.Command("logger", {
      args: [
        "-t",
        "archon-mcp",
        `${verdict} ${name} ${JSON.stringify(args)} from ${via}`.slice(0, 2000),
      ],
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // No logger (not a Linux host): nothing to record.
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  limit: McpTier,
  traceparent?: string,
) {
  const c = COMMANDS.find((x) => !x.noMcp && mcpToolName(x) === name);
  if (!c) return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  const human = c.args.find((a) => a.human && args[a.name] !== undefined);
  if (human) {
    await journalCall(name, args, "refused");
    count("archon.mcp.calls", 1, { "archon.tool": name, "archon.result": "refused" });
    return {
      content: [{
        type: "text",
        text:
          `refused: --${human.name} is typed by a person, never passed by an agent (Article 23). Ask the owner to run archon ${c.name} themselves.`,
      }],
      isError: true,
    };
  }
  if (!allowed(c, args, limit)) {
    await journalCall(name, args, "refused");
    count("archon.mcp.calls", 1, { "archon.tool": name, "archon.result": "refused" });
    const hint = c.readOnlyWith && RANK[c.tier] > RANK[limit]
      ? ` Only with ${c.readOnlyWith}: true.`
      : "";
    return {
      content: [{
        type: "text",
        text:
          `refused: archon ${c.name} is tier ${c.tier}; this server allows up to ${limit} over MCP (fleet.mcp.maxTier, spec 030).${hint} Run it yourself over SSH as the admin if it is needed.`,
      }],
      isError: true,
    };
  }
  await journalCall(name, args, "call");
  count("archon.mcp.calls", 1, { "archon.tool": name, "archon.result": "served" });
  const self = Deno.env.get("ARCHON_SELF") ?? "/usr/local/bin/archon";
  const p = new Deno.Command(self, {
    args: argvFor(c, args),
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
    env: {
      ARCHON_AGENT: Deno.env.get("ARCHON_AGENT") ?? "mcp",
      NO_COLOR: "1",
      // Spec 049: the caller's trace continues in the command it asked for.
      ...(parseTraceparent(traceparent) ? { TRACEPARENT: traceparent! } : {}),
    },
  });
  const r = await p.output();
  const dec = new TextDecoder();
  const text = [dec.decode(r.stdout).trim(), dec.decode(r.stderr).trim()].filter(Boolean).join(
    "\n\n",
  );
  return { content: [{ type: "text", text: text || `(exit ${r.code})` }], isError: r.code !== 0 };
}

/** One JSON-RPC 2.0 message from the client: a request (with `id`) or a notification. */
export type Msg = {
  /** Always "2.0". */
  jsonrpc: "2.0";
  /** The request ID to answer with; absent on notifications. */
  id?: number | string;
  /** The method, such as "tools/call". */
  method?: string;
  /** The method's parameters. */
  params?: Record<string, unknown>;
};

/**
 * Answer one JSON-RPC message, serving tools up to `limit`: the JSON-RPC
 * response, or undefined for notifications (nothing to send).
 */
export async function handle(msg: Msg, limit: McpTier = "mutate"): Promise<unknown | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code, message },
  });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: (msg.params?.protocolVersion as string) ?? PROTOCOL,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: "archon", version: "2.0.0" },
        instructions:
          `Archon operates this Ubuntu server from the model in /srv/archon. Follow the constitution (resource archon://constitution) and the operating rules (archon://operating-rules). Tools up to tier ${limit} are served; destructive ones never. Read-only tools are safe; host-mutating tools need the human's approval. Model changes are made in the workstation's checkout and pushed to main; servers converge from it.`,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: COMMANDS.filter((c) => listed(c, limit)).map(toolFor) });
    case "tools/call":
      return reply(
        await callTool(
          String(msg.params?.name),
          (msg.params?.arguments as Record<string, unknown>) ?? {},
          limit,
          (msg.params?._meta as { traceparent?: string } | undefined)?.traceparent,
        ),
      );
    case "resources/list":
      return reply({ resources: (await resources()).map(({ path: _p, text: _t, ...r }) => r) });
    case "resources/read": {
      const r = (await resources()).find((x) => x.uri === msg.params?.uri);
      if (!r) return error(-32002, `resource not found: ${msg.params?.uri}`);
      return reply({
        contents: [{
          uri: r.uri,
          mimeType: r.mimeType,
          text: r.text ?? (r.path ? (await readTextOr(r.path)) ?? "" : ""),
        }],
      });
    }
    default:
      return msg.id === undefined ? undefined : error(-32601, `method not found: ${msg.method}`);
  }
}

/**
 * `archon mcp`: read newline-delimited JSON-RPC from stdin and write each
 * response to stdout until stdin closes. `maxTier` is the --max-tier value
 * (default mutate); an invalid one throws.
 */
export async function serveMcp(maxTier?: string): Promise<void> {
  const limit = parseTier(maxTier);
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  const write = async (obj: unknown) => {
    await Deno.stdout.write(enc.encode(JSON.stringify(obj) + "\n"));
  };
  for await (const chunk of Deno.stdin.readable) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Msg;
      try {
        msg = JSON.parse(line);
      } catch {
        await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      const out = await handle(msg, limit).catch((e) => ({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: String(e) },
      }));
      if (out !== undefined) await write(out);
    }
  }
}
