/**
 * Spec 048-observe-by-query: ask a server through its MCP server, over SSH as
 * ops (spec 030, Article 17), the same way an agent does. The server limits
 * what it answers; nothing it says is pushed anywhere.
 *
 * @module
 */

import { currentTraceparent, span } from "../core/telemetry.ts";

/** A server's answer to one MCP tool call. */
export interface RemoteResult {
  /** True when the tool ran and did not report an error. */
  ok: boolean;
  /** The tool's text output, or why the call failed (ssh's error, "no answer"). */
  text: string;
}

/**
 * ssh arguments for a server's MCP endpoint. With `knownHosts` (known_hosts.auto,
 * generated from the hosts' registrations in Git, spec 047), the server's key is
 * checked against Git first, then the user's own known_hosts.
 */
export function sshArgs(target: string, timeoutS = 8, knownHosts?: string): string[] {
  return [
    "-T",
    ...(knownHosts && !/\s/.test(knownHosts)
      ? ["-o", `UserKnownHostsFile=${knownHosts} ~/.ssh/known_hosts`]
      : []),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${timeoutS}`,
    "-o",
    "ServerAliveInterval=15",
    target,
  ];
}

/** Call one tool of a server's MCP server (newline-delimited JSON-RPC over ssh's stdio). */
export async function callRemoteTool(
  target: string,
  tool: string,
  args: Record<string, unknown>,
  o: { timeoutMs?: number; traceparent?: string; command?: string[]; knownHosts?: string } = {},
): Promise<RemoteResult> {
  const argv = o.command ?? ["ssh", ...sshArgs(target, 8, o.knownHosts)];
  const traceparent = o.traceparent ?? currentTraceparent();
  const end = span("archon.remote", { "archon.tool": tool });
  const child = new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const enc = new TextEncoder();
  const w = child.stdin.getWriter();
  const send = (m: unknown) => w.write(enc.encode(JSON.stringify(m) + "\n"));
  const timer = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch { /* gone */ }
  }, o.timeoutMs ?? 20_000);
  try {
    await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "archon-fleet", version: "1" },
      },
    });
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: tool,
        arguments: args,
        ...(traceparent ? { _meta: { traceparent } } : {}),
      },
    });
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: {
          id?: number;
          result?: { content?: Array<{ text?: string }>; isError?: boolean };
          error?: { message: string };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== 2) continue;
        await reader.cancel().catch(() => {});
        if (msg.error) return { ok: false, text: msg.error.message };
        const text = (msg.result?.content ?? []).map((c) => c.text ?? "").join("\n");
        return { ok: !msg.result?.isError, text };
      }
    }
    const err = new TextDecoder().decode(
      (await child.stderr.getReader().read()).value ?? new Uint8Array(),
    );
    return { ok: false, text: err.trim() || "no answer" };
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  } finally {
    end();
    clearTimeout(timer);
    await w.close().catch(() => {});
    try {
      child.kill("SIGTERM");
    } catch { /* gone */ }
    await child.status.catch(() => {});
  }
}
