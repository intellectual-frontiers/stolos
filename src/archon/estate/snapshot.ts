/**
 * Spec 090: what the estate graph is built from, read from the fleet
 * repository as it is now or at any commit, without running any of it: the
 * connectors' observations (`estate/<id>.ts`), the links people made
 * (`estate/links.ts`), the adopted machines, the SNMP devices, and the
 * managed hosts. Every file Stolos writes is a TypeScript literal, which
 * IFC TypeScript's `exportedLiteral` reads; the managed hosts are known by their folders.
 * Each source's history (`git log`) gives first-seen and last-seen times.
 *
 * @module
 */
// Spec: 090-estate-graph

import { exportedLiteral } from "@intellectual-frontiers/formats";
import { errors, fs } from "@intellectual-frontiers/system";
import { run, type RunResult } from "../core/exec.ts";
import type { Observation } from "../connect/connector.ts";
import type { Device } from "../connect/entities.ts";

/** One connector's observation, as read. */
export interface SourceSnapshot {
  /** The connector's id (the file's name). */
  connector: string;
  /** The observation. */
  observation: Observation;
  /** The commit that last changed it (undefined: not committed yet). */
  commit?: string;
}

/** Everything the graph is built from. */
export interface Snapshot {
  /** The fleet's id. */
  fleet: string;
  /** The commit it was read at (undefined: the working tree). */
  rev?: string;
  /** Each connector's observation. */
  sources: SourceSnapshot[];
  /** The fleet's own machines: managed hosts, adopted machines, SNMP devices. */
  machines: Device[];
  /** links.ts: "<connector>:<login>" to a work email; "device:<source>:<id>" to a machine's key. */
  links: Record<string, string>;
}

/** Reads a fleet repository's files, now or at a commit. */
export interface RepoReader {
  /** A file's text, or undefined when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** The names in a folder (empty when it does not exist). */
  list(dir: string): Promise<string[]>;
  /** The last commit that changed a path (undefined: none). */
  lastCommit(path: string): Promise<string | undefined>;
}

/** A reader for the working tree, or for one commit (`rev`), of the repository at `repo`. */
export function gitReader(repo: string, rev?: string): RepoReader {
  const git = (args: string[]): Promise<RunResult> => run(["git", "-C", repo, ...args]);
  return {
    async read(path): Promise<string | undefined> {
      if (!rev) {
        try {
          return await fs.readTextFile(`${repo}/${path}`);
        } catch (e) {
          if (e instanceof errors.NotFound) return undefined;
          throw e;
        }
      }
      const r = await git(["show", `${rev}:${path}`]);
      return r.ok ? r.stdout : undefined;
    },
    async list(dir): Promise<string[]> {
      if (!rev) {
        const out: string[] = [];
        try {
          for await (const e of fs.readDir(`${repo}/${dir}`)) out.push(e.name);
        } catch (e) {
          if (!(e instanceof errors.NotFound)) throw e;
        }
        return out.sort();
      }
      const r = await git(["ls-tree", "--name-only", `${rev}:${dir}`]);
      return r.ok ? r.stdout.split("\n").filter(Boolean).sort() : [];
    },
    async lastCommit(path): Promise<string | undefined> {
      const r = await git(["log", "-1", "--format=%H", ...(rev ? [rev] : []), "--", path]);
      return r.stdout.trim() || undefined;
    },
  };
}

/**
 * The literal a file Stolos wrote exports as `name`, as the type that file declares it (Stolos wrote
 * it from that type); undefined where there is no file. A file that is not such a literal throws.
 */
function lit<T>(text: string | undefined, name: string): T | undefined {
  if (text === undefined) return undefined;
  const r = exportedLiteral(text, name);
  if (r.kind === "err") throw new Error(`${name}: expected ${r.error.expected} at ${r.error.at}`);
  return r.value as T;
}

/** The snapshot of a fleet, through a reader. */
export async function readSnapshot(r: RepoReader, fleet: string, rev?: string): Promise<Snapshot> {
  const base = `fleets/${fleet}`;
  const sources: SourceSnapshot[] = [];
  for (const f of await r.list(`${base}/estate`)) {
    if (!f.endsWith(".ts") || f === "links.ts") continue;
    const path = `${base}/estate/${f}`;
    const observation = lit<Observation>(await r.read(path), "observed");
    if (!observation) continue;
    const commit = await r.lastCommit(path);
    sources.push({ connector: f.replace(/\.ts$/, ""), observation, ...(commit ? { commit } : {}) });
  }
  const links = lit<Record<string, string>>(await r.read(`${base}/estate/links.ts`), "links") ?? {};
  const machines: Device[] = [];
  for (const h of await r.list(`${base}/hosts`)) {
    machines.push({ source: "stolos", id: h, name: h, managed: true, os: "Ubuntu" });
  }
  for (const n of await r.list(`${base}/adopted`)) {
    const m = lit<{ name: string; owner?: string }>(
      await r.read(`${base}/adopted/${n}/machine.ts`),
      "machine",
    );
    if (!m) continue;
    const o = lit<{
      at: string;
      os: { name?: string; version?: string; serial?: string; hostname?: string };
      security: { diskEncryption?: string };
    }>(await r.read(`${base}/adopted/${n}/observed.ts`), "observed");
    const enc = o?.security.diskEncryption;
    machines.push({
      source: "adopted",
      id: m.name,
      name: o?.os.hostname || m.name,
      managed: false,
      ...(m.owner ? { owner: m.owner } : {}),
      ...(o ? { os: `${o.os.name ?? ""} ${o.os.version ?? ""}`.trim(), seen: o.at } : {}),
      ...(o?.os.serial ? { serial: o.os.serial } : {}),
      ...(enc === "on" || enc === "off" ? { encrypted: enc === "on" } : {}),
    });
  }
  for (const n of await r.list(`${base}/devices`)) {
    const d = lit<{ name: string; owner?: string; kind: string }>(
      await r.read(`${base}/devices/${n}/device.ts`),
      "device",
    );
    if (!d) continue;
    const o = lit<{ at: string; model?: string; serial?: string; sysName?: string }>(
      await r.read(`${base}/devices/${n}/observed.ts`),
      "observed",
    );
    machines.push({
      source: "snmp",
      id: d.name,
      name: o?.sysName || d.name,
      managed: false,
      ...(d.owner ? { owner: d.owner } : {}),
      ...(o?.model ? { os: o.model } : {}),
      ...(o?.serial ? { serial: o.serial } : {}),
      ...(o ? { seen: o.at } : {}),
    });
  }
  return { fleet, ...(rev ? { rev } : {}), sources, machines, links };
}

/** When each uid was first and last seen, across the history of the fleet's estate files. */
export type SeenTimes = Map<string, { first: string; last: string }>;

/**
 * First-seen and last-seen times from Git: each committed version of each
 * observation file (oldest first, at most `max` per file), mapped to uids by
 * `uids`. The working tree's own observation counts as the newest version.
 */
export async function seenTimes(
  repo: string,
  paths: string[],
  uids: (connector: string, o: Observation) => string[],
  max = 400,
): Promise<SeenTimes> {
  const seen: SeenTimes = new Map();
  const mark = (uid: string, at: string) => {
    const s = seen.get(uid);
    if (!s) seen.set(uid, { first: at, last: at });
    else {
      if (at < s.first) s.first = at;
      if (at > s.last) s.last = at;
    }
  };
  for (const path of paths) {
    const connector = (path.split("/").pop() ?? path).replace(/\.ts$/, "");
    const log = await run(["git", "-C", repo, "log", `-${max}`, "--format=%H", "--", path]);
    for (const sha of log.stdout.split("\n").filter(Boolean)) {
      const r = await run(["git", "-C", repo, "show", `${sha}:${path}`]);
      if (!r.ok) continue;
      try {
        const o = lit<Observation>(r.stdout, "observed");
        if (o) for (const u of uids(connector, o)) mark(u, o.at);
      } catch {
        // A version that is not a literal Stolos wrote (edited by hand): it adds no times.
      }
    }
  }
  return seen;
}
