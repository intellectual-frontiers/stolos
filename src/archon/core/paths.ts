/**
 * Well-known locations (spec 046-engine-instance). Two roots:
 *
 * - the engine: this repository, loaded from a checkout (file:) or from
 *   GitHub (https:) through the instance's `@stolos/` import;
 * - the instance: the repository that holds the fleets (`fleets/<id>/`), the
 *   one hosts check out at /srv/archon. One fleet of it is active per run.
 *
 * The instance is ARCHON_REPO, else the nearest folder above the working
 * directory that holds `fleets/`, else /srv/archon, else (in an engine
 * checkout) its `examples/`. The fleet is ARCHON_FLEET (or --fleet), else
 * /etc/archon/fleet (written at install), else this checkout's choice
 * (`stolos fleet use <id>`, in .git/stolos/fleet, never committed), else the
 * instance's only fleet.
 *
 * ```mermaid
 * flowchart TD
 *   repo{"ARCHON_REPO?"} -->|set| inst["that folder"]
 *   repo -->|unset| up{"a folder above with fleets/?"}
 *   up -->|yes| inst
 *   up -->|no| srv{"/srv/archon/fleets?"}
 *   srv -->|yes| inst
 *   srv -->|no| ex["the engine's examples/"]
 *   inst --> fleet{"--fleet / ARCHON_FLEET?"}
 *   fleet -->|unset| etc{"/etc/archon/fleet?"}
 *   etc -->|unset| use{"stolos fleet use<br/>(.git/stolos/fleet)?"}
 *   use -->|unset| only["the only fleet"]
 * ```
 *
 * @module
 */

import { dirname, fromFileUrl, join, resolve, sep } from "./path.ts";

/** The engine's root as a URL (file: in a checkout, https: when imported from GitHub). */
export const ENGINE_URL = new URL("../../../", import.meta.url);
/** The engine's root folder, when it is a local checkout. */
export const ENGINE_ROOT: string | undefined = ENGINE_URL.protocol === "file:"
  ? fromFileUrl(ENGINE_URL).replace(/[\\/]$/, "")
  : undefined;

function isDir(p: string): boolean {
  try {
    return Deno.statSync(p).isDirectory;
  } catch {
    return false;
  }
}

function readOr(p: string): string | undefined {
  try {
    return Deno.readTextFileSync(p);
  } catch {
    return undefined;
  }
}

/** The instance repository's root (see the header). */
export function findInstanceRoot(): string {
  const env = Deno.env.get("ARCHON_REPO");
  if (env) return resolve(env);
  let d = resolve(Deno.cwd());
  for (;;) {
    if (isDir(join(d, "fleets"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  if (isDir("/srv/archon/fleets")) return "/srv/archon";
  if (ENGINE_ROOT && isDir(join(ENGINE_ROOT, "examples", "fleets"))) {
    return join(ENGINE_ROOT, "examples");
  }
  return resolve(Deno.cwd());
}

/** The fleets an instance holds (folders of fleets/ with a fleet.ts). */
export function listFleets(repo: string): string[] {
  const out: string[] = [];
  try {
    for (const e of Deno.readDirSync(join(repo, "fleets"))) {
      if (e.isDirectory && readOr(join(repo, "fleets", e.name, "fleet.ts")) !== undefined) {
        out.push(e.name);
      }
    }
  } catch { /* no fleets yet */ }
  return out.sort();
}

/** Where `stolos fleet use <id>` keeps this checkout's choice (inside .git: never committed). */
export function fleetChoiceFile(repo: string): string {
  return join(repo, ".git", "stolos", "fleet");
}

/** The active fleet's id, or "" when it cannot be decided (see the header). */
export function findFleetId(repo: string): string {
  const env = Deno.env.get("ARCHON_FLEET");
  if (env) return env.trim();
  const etc = readOr("/etc/archon/fleet")?.trim();
  if (etc) return etc;
  const chosen = readOr(fleetChoiceFile(repo))?.trim();
  if (chosen) return chosen;
  const all = listFleets(repo);
  return all.length === 1 ? all[0] : "";
}

let cachedRepo: string | undefined;
let cachedFleet: string | undefined;
/** Forget the resolved instance and fleet (tests, and `fleet init`). */
export function resetRoots(): void {
  cachedRepo = undefined;
  cachedFleet = undefined;
}
function repoRoot(): string {
  return cachedRepo ??= findInstanceRoot();
}
function fleetId(): string {
  return cachedFleet ??= findFleetId(repoRoot());
}
function fleetDir(): string {
  return join(repoRoot(), "fleets", fleetId() || "_");
}

const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
const isWindows = Deno.build.os === "windows";
/** Per-user data on the boot machine (Windows: %LOCALAPPDATA%, else XDG). */
const userData = isWindows
  ? Deno.env.get("LOCALAPPDATA") ?? join(home, "AppData", "Local")
  : Deno.env.get("XDG_DATA_HOME") ?? join(home, ".local", "share");
/** Per-user config (secrets) on the boot machine (Windows: %APPDATA%). */
const userConfig = isWindows
  ? Deno.env.get("APPDATA") ?? join(home, "AppData", "Roaming")
  : Deno.env.get("XDG_CONFIG_HOME") ?? join(home, ".config");

/**
 * ARCHON_SANDBOX=<folder> (tests): every per-user path must resolve inside it,
 * or archon refuses to start, before it reads or writes anything. Windows
 * reads APPDATA and LOCALAPPDATA, Linux HOME and XDG_*: a sandbox that set only
 * one family once let tests reach the boot machine's real secrets.
 */
const sandbox = Deno.env.get("ARCHON_SANDBOX");
if (sandbox) {
  const root = resolve(sandbox).toLowerCase();
  for (const [what, p] of [["home", home], ["user data", userData], ["user config", userConfig]]) {
    const r = resolve(p).toLowerCase();
    if (r !== root && !r.startsWith(root + sep)) {
      throw new Error(
        `ARCHON_SANDBOX: ${what} (${p}) is outside the sandbox ${sandbox}; refusing to start`,
      );
    }
  }
}

/** Where Archon's files live: the repository, the fleet, and this machine's caches and secrets. */
export const P = {
  /** The instance repository (the checkout hosts converge to). */
  get repo(): string {
    return repoRoot();
  },
  /** The active fleet's id ("" when undecided). */
  get fleetId(): string {
    return fleetId();
  },
  /** fleets/<id>/ */
  get fleetDir(): string {
    return fleetDir();
  },
  /** fleets/<id>/fleet.ts, the fleet's model. */
  get fleet(): string {
    return join(fleetDir(), "fleet.ts");
  },
  /** fleets/<id>/hosts/<host>/host.ts, one folder per host. */
  get hosts(): string {
    return join(fleetDir(), "hosts");
  },
  /**
   * This machine's own state (spec 048): archon.sql and archon.auto.sqlite.db.
   * An installed host keeps it in /var/lib/archon; the boot machine and a
   * workstation per fleet in their user data. Never in the repository.
   */
  get state(): string {
    return readOr("/etc/archon/host") !== undefined
      ? "/var/lib/archon"
      : join(userData, "stolos", "state", fleetId() || "_");
  },
  /**
   * This user's own files derived from Git, per fleet (known_hosts.auto): an
   * operator on a workstation cannot write /var/lib/archon.
   */
  get userState(): string {
    return join(userData, "stolos", "state", fleetId() || "_");
  },
  /** Rendered by stolos build; never committed. */
  get out(): string {
    return join(repoRoot(), "out", fleetId() || "_");
  },
  get man(): string {
    return join(repoRoot(), "out", fleetId() || "_", "man");
  },
  get mcpJson(): string {
    return join(repoRoot(), ".mcp.json");
  },
  /** Boot machine: Ubuntu netboot cache (Article 12: verified before use). */
  bootCache: join(userData, "stolos", "boot"),
  /** Boot machine: secrets, never in the repository (Article 13). */
  get secrets(): string {
    return join(userConfig, "stolos", "secrets", fleetId() || "_");
  },
  /** Host: runtime state written by timers, outside Git. */
  varLib: "/var/lib/archon",
  /**
   * Generated secrets that belong to one account (an S3 secret, a service's
   * PostgreSQL password): 0711, so each account reaches its own file (0400,
   * its owner) without listing anyone else's. Not under /var/lib/archon,
   * which only archon-ops may enter.
   */
  keys: "/var/lib/archon-keys",
  /** Host: where the repository is checked out. */
  installedRepo: "/srv/archon",
  toolsRoot: "/opt/tools",
  bin: "/usr/local/bin",
};

/** A path inside the instance repository, relative to it, with forward slashes (for git). */
export function repoRel(abs: string): string {
  const r = abs.startsWith(P.repo) ? abs.slice(P.repo.length).replace(/^[\\/]/, "") : abs;
  return r.replaceAll("\\", "/");
}
