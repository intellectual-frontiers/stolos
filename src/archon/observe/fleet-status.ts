// `archon fleet status` (specs 021, 022): every server and workstation in the
// model, its last install as it recorded it (state/hosts/<host>/installed.json),
// whether it is durable or ephemeral (spec 044), and how to reach and observe it. Works on the boot machine (which also knows
// the addresses hosts installed from) and on any host.

import { P } from "../core/paths.ts";
import { join } from "../core/path.ts";
import { readTextOr } from "../core/fsx.ts";
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
  for (const h of hosts) {
    const p = ui.phase(h.name);
    const rec = JSON.parse(
      (await readTextOr(join(P.state, "hosts", h.name, "installed.json"))) ?? "{}",
    ) as Installed;
    let latest: RecordedVerify | undefined;
    try {
      latest = JSON.parse(
        (await readTextOr(join(P.state, "hosts", h.name, "verify.json"))) ?? "",
      ) as RecordedVerify;
    } catch { /* not recorded yet */ }
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
        // Article 23: as recorded on GitHub (the host itself says it live: archon data).
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
  ui.next.push("(from this checkout: git pull for what hosts recorded since)");
  return 0;
}
