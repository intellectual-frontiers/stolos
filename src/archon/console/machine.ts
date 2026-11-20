/**
 * Spec 065: the Archon Console's real dependencies on a server: PAM, the
 * system's accounts, the runner, the checkout of the fleet repository (the
 * commit applied now, who signed it, the engine it pins), the activity record,
 * and the served guides.
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/system";
import { engineFileOr } from "../core/assets.ts";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { P } from "../core/paths.ts";
import { markdownToHtml } from "../web/markdown.ts";
import type { ActivityEntry, RepoFacts } from "./pages.ts";

/** Where the console keeps its activity record (its StateDirectory). */
export const ACTIVITY_FILE = "/var/lib/archon-console/activity.jsonl";

/** The checkout this server applies: the commit, its signer (as servers check it), the engine, the signers. */
export async function repoFacts(repo = P.repo): Promise<RepoFacts> {
  const git = (args: string[]): ReturnType<typeof run> =>
    run(["git", "-c", `safe.directory=${repo}`, "-C", repo, ...args]);
  const log = await git(["log", "-1", "--format=%h%x09%s%x09%an%x09%cI"]);
  const [sha, subject = "", author = "", at = ""] = log.stdout.trim().split("\t");
  const v = await git([
    "-c",
    "gpg.format=ssh",
    "-c",
    "gpg.ssh.allowedSignersFile=/etc/archon/allowed_signers",
    "verify-commit",
    "--raw",
    "HEAD",
  ]);
  const signer = (v.stderr + v.stdout).match(/Good "git" signature for (\S+) with/)?.[1];
  const { PIN_FILE, readPin } = await import("../fleet/upgrade.ts");
  const pin = readPin((await fs.readTextOr(path.join(repo, PIN_FILE))) ?? "");
  let signers: RepoFacts["signers"] = [];
  try {
    const { loadSigners } = await import("../identity/signers.ts");
    signers = (await loadSigners()).map((s) => ({ name: s.name, role: s.role }));
  } catch {
    /* no signers.ts: none shown */
  }
  return {
    ...(log.ok && sha ? { commit: { sha, subject, author, at } } : {}),
    ...(signer ? { signer } : {}),
    ...(pin ? { engine: pin.tag } : {}),
    signers,
  };
}

/** The activity record: one JSON line per sign-in or run, appended. */
export function activityLog(file = ACTIVITY_FILE): {
  add(e: ActivityEntry): Promise<void>;
  recent(n: number): Promise<ActivityEntry[]>;
} {
  return {
    async add(e) {
      try {
        await fs.writeTextFile(file, JSON.stringify(e) + "\n", { append: true, create: true });
      } catch {
        /* the record is best effort; the journal has the run too */
      }
      ui.say(`${e.kind}: ${e.user} from ${e.from}${e.detail ? `: ${e.detail}` : ""}`);
    },
    async recent(n) {
      const lines = ((await fs.readTextOr(file)) ?? "").trim().split("\n").filter(Boolean);
      return lines
        .slice(-n)
        .reverse()
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as ActivityEntry];
          } catch {
            return [];
          }
        });
    },
  };
}

/** A served guide's body as HTML (docs/<name>.md), or undefined when it is not served. */
export async function guideBody(
  name: string,
  guides: Array<{ name: string }>,
  repoSlug: string,
): Promise<string | undefined> {
  if (!guides.some((g) => g.name === name)) return undefined;
  const md = engineFileOr(`docs/${name}.md`);
  if (!md) return undefined;
  return await Promise.resolve(
    markdownToHtml(md, {
      served: guides.map((g) => g.name),
      repoBlob: `https://github.com/${repoSlug}/blob/main/`,
    }),
  );
}

/** One optional service, as the console shows it. */
export interface OptInRow {
  /** Its switch (pg, s3, smb, otel-ui). */
  name: string;
  /** Its name for people. */
  title: string;
  /** On or off. */
  on: boolean;
  /** durable, ephemeral, "unchosen", or undefined when it holds no user data. */
  data?: string | undefined;
  /** When it was last switched (ISO time). */
  since?: string;
  /** Who switched it. */
  by?: string;
  /** The commands that turn it on and off, and show it. */
  commands: { on: string; off: string; status: string };
}

/** One unit of the host's plan, with its live state. */
export interface UnitRow {
  /** The unit's name. */
  unit: string;
  /** The spec that wants it. */
  spec: string;
  /** systemd's ActiveState: active, failed, inactive, ... */
  active: string;
  /** systemd's SubState: running, exited, dead, ... */
  sub: string;
  /** Its unit file's state: enabled, disabled, masked, static, ... */
  enabled: string;
}

/** What the Services page shows: the optional services and every unit of the plan. */
export interface ServicesFacts {
  /** The optional services. */
  optIns: OptInRow[];
  /** The units, with their live state. */
  units: UnitRow[];
}

/** systemctl show's blocks (Id, ActiveState, SubState, UnitFileState), by unit. */
export function parseUnitStates(
  out: string,
): Map<string, { active: string; sub: string; enabled: string }> {
  const m = new Map<string, { active: string; sub: string; enabled: string }>();
  for (const block of out.split(/\n\s*\n/)) {
    const f = Object.fromEntries(
      block
        .split("\n")
        .map((l) => l.split("=", 2))
        .filter((x) => x.length === 2),
    ) as Record<string, string>;
    const id = f["Id"];
    if (id) {
      m.set(id, {
        active: f["ActiveState"] ?? "",
        sub: f["SubState"] ?? "",
        enabled: f["UnitFileState"] ?? "",
      });
    }
  }
  return m;
}

/** This host's optional services and units, as they are now. */
export async function servicesFacts(hostName: string): Promise<ServicesFacts> {
  const { loadFleet, loadHosts } = await import("../model/load.ts");
  const { resolvePlan } = await import("../model/resolve.ts");
  const { OPT_INS, holdsUserData } = await import("../optin/optin.ts");
  const host = (await loadHosts()).find((h) => h.name === hostName);
  if (!host) throw new Error(`no host ${hostName} in the model`);
  const plan = resolvePlan(host, await loadFleet());
  const optIns = OPT_INS.map((o) => {
    const r = host.optIn?.[o.name];
    return {
      name: o.name,
      title: o.title,
      on: r?.enabled === true,
      ...(holdsUserData(o.name) ? { data: r?.data ?? (r?.enabled ? "unchosen" : undefined) } : {}),
      ...(r?.at ? { since: r.at } : {}),
      ...(r?.by ? { by: r.by } : {}),
      commands: o.commands,
    };
  });
  const names = [...new Set(plan.units.map((u) => u.unitName))].sort();
  const show = names.length
    ? await run(["systemctl", "show", "-p", "Id,ActiveState,SubState,UnitFileState", ...names])
    : { stdout: "" };
  const states = parseUnitStates(show.stdout);
  const units = plan.units
    .filter((u, i, all) => all.findIndex((x) => x.unitName === u.unitName) === i)
    .map((u) => ({
      unit: u.unitName,
      spec: u.spec,
      active: states.get(u.unitName)?.active ?? "unknown",
      sub: states.get(u.unitName)?.sub ?? "",
      enabled: states.get(u.unitName)?.enabled ?? "",
    }))
    .sort((a, b) => a.unit.localeCompare(b.unit));
  return { optIns, units };
}

/**
 * The journal, live, for the Logs page: the last lines, then each new one,
 * until `signal` aborts. Only a unit of the host's plan (or everything).
 */
export async function journalTail(
  unit: string | undefined,
  each: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const p = proc.spawn(
    [
      "journalctl",
      "--no-pager",
      "-o",
      "short-iso",
      "-n",
      "150",
      "-f",
      ...(unit ? ["-u", unit] : []),
    ],
    { stdin: "null", stdout: "piped", stderr: "null", signal },
  );
  const dec = new TextDecoder();
  let buf = "";
  try {
    if (!p.stdout) return;
    for await (const chunk of p.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        each(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
  } catch {
    /* aborted: the page went away */
  }
}
