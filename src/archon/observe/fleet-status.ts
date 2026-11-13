// `archon fleet status` (specs 021, 022): every server and workstation in the
// model, its last install and verify as it says them now (spec 048: asked over
// MCP, cached in this machine's archon.sql when it cannot be reached),
// whether it is durable or ephemeral (spec 044), and how to reach and observe it. Works on the boot machine (which also knows
// the addresses hosts installed from) and on any host.

import { getRecord, putRecord } from "../state/store.ts";
import { callRemoteTool } from "./remote.ts";
import { mcpServers } from "../render/agent.ts";
import type { HostState } from "../state/state-command.ts";
import { P } from "../core/paths.ts";

import { ui } from "../core/ui.ts";
import { liveToken, loadTokens } from "../core/secrets.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import { nextSteps } from "./next.ts";
import { describeData, hostData } from "../model/durable.ts";
import type { RecordedVerify } from "../state/verify.ts";

interface Installed {
  installed?: string;
  ok?: boolean;
  checks?: { passed: number; total: number };
  problems?: Array<{ message: string }>;
}

export async function fleetStatus(): Promise<number> {
  const fleet = await loadFleet();
  const hosts = await loadHosts();
  const tokens = await loadTokens().catch(() => []);
  if (!hosts.length) {
    ui.next.push("no hosts yet: deno task archon host add <name> (or workstation add, in WSL)");
    return 0;
  }
  // Spec 048: ask every server live (its MCP server, over SSH as ops), all at
  // once; keep each answer in this machine's state as the last one seen.
  const live = new Map<string, { ok: boolean; why?: string }>();
  // Spec 047: each server's key is checked against Git (registration.ts).
  const { writeKnownHosts } = await import("../fleet/registration.ts");
  const knownHosts = await writeKnownHosts().catch(() => undefined);
  await Promise.all(
    hosts.filter((h) => h.kind !== "workstation").map(async (h) => {
      const target = mcpServers([h])[0]?.target;
      if (!target) return;
      const r = await callRemoteTool(target, "archon_state", { json: true }, {
        timeoutMs: 15_000,
        knownHosts,
      });
      if (!r.ok) return live.set(h.name, { ok: false, why: r.text.split("\n").pop() });
      try {
        const st = JSON.parse(r.text) as HostState;
        if (st.install) {
          await putRecord(h.name, "install", "install", st.install.body, P.state, st.install.at);
        }
        if (st.verify) {
          await putRecord(h.name, "verify", "latest", st.verify, P.state, st.verify.since);
        }
        live.set(h.name, { ok: true });
      } catch {
        live.set(h.name, { ok: false, why: "unreadable answer" });
      }
    }),
  );
  for (const h of hosts) {
    const p = ui.phase(h.name);
    const inst = await getRecord<Installed>(h.name, "install", "install", P.state);
    const rec: Installed = inst ? { ...inst.body, installed: inst.at } : {};
    let latest = (await getRecord<RecordedVerify>(h.name, "verify", "latest", P.state))?.body;
    const seen = live.get(h.name);
    if (seen && !seen.ok) {
      p.warn(`unreachable now (${seen.why}); showing what it said last`);
    }
    // The latest verify, when it is newer than the install, is what the host is now.
    if (latest && rec.installed && latest.since < rec.installed) latest = undefined;
    const t = tokens.find((x) => x.host === h.name);
    const kind = h.kind === "workstation" ? "workstation" : "server";
    if (latest) {
      for (const f of latest.failed) p.warn(`failing at its last verify: ${f}`);
      for (const w of latest.warned) p.note(`warning at its last verify: ${w}`);
    } else if (rec.ok === false) {
      for (const pr of rec.problems ?? []) p.warn(`at its last install: ${pr.message}`);
    }
    p.done(
      [
        kind,
        rec.installed
          ? `installed ${rec.installed.slice(0, 16).replace("T", " ")}${
            latest
              ? ` · ${latest.passed}/${latest.total} checks${
                latest.warned.length ? `, ${latest.warned.length} warning(s)` : ""
              } (verified ${latest.since.slice(0, 16).replace("T", " ")})`
              : rec.checks
              ? ` · ${rec.checks.passed}/${rec.checks.total} checks at install`
              : ""
          }${!latest && rec.ok === false ? " · with problems" : ""}`
          : "not installed yet",
        // Article 23: from the model here (the host itself says it live: archon data).
        h.kind === "workstation" ? "" : describeData(hostData(h)),
        liveToken(tokens, h.name) ? "armed for an install" : "",
      ].filter(Boolean).join(" · "),
    );
    ui.next.push(
      `${h.name}:`,
      ...nextSteps({
        host: h,
        fleet,
        address: t?.addresses?.at(-1),
      }).map((l) => `  ${l}`),
    );
  }
  ui.next.push("(live from each server over SSH; archon fleet query asks them anything)");
  return 0;
}
