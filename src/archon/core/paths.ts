/**
 * Well-known locations (spec 046-engine-instance). Two roots:
 *
 * - the engine: this repository, as a checkout or as the package a fleet
 *   repository installs (`node_modules/@intellectual-frontiers/stolos`, spec
 *   096); its root is three folders above this module either way;
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
 * A provider's PC (spec 082) works for many clients, each in its own
 * checkout: `--client <id>` (ARCHON_CLIENT) points ARCHON_REPO and
 * ARCHON_FLEET at that client's checkout and fleet, and this PC's per-user
 * folders (state, secrets, the key store) move under `stolos/clients/<id>/`,
 * so no two clients ever share one. The catalogs (public reference data) and
 * the boot cache stay shared.
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

import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";

const { dirname, join, resolve, sep } = path;

/** The engine's root folder: the checkout, or the installed package's folder. */
export const ENGINE_ROOT: string = path
  .fromFileUrl(new URL("../../../", import.meta.url))
  .replace(/[\\/]$/, "");

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory;
  } catch {
    return false;
  }
}

function readOr(p: string): string | undefined {
  try {
    return fs.readTextFileSync(p);
  } catch {
    return undefined;
  }
}

/** The instance repository's root (see the header). */
export function findInstanceRoot(): string {
  const env = proc.env.get("ARCHON_REPO");
  if (env !== undefined && env !== "") return resolve(env);
  let d = resolve(proc.cwd());
  for (;;) {
    if (isDir(join(d, "fleets"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  if (isDir("/srv/archon/fleets")) return "/srv/archon";
  if (isDir(join(ENGINE_ROOT, "examples", "fleets"))) {
    return join(ENGINE_ROOT, "examples");
  }
  return resolve(proc.cwd());
}

/** The fleets an instance holds (folders of fleets/ with a fleet.ts). */
export function listFleets(repo: string): string[] {
  const out: string[] = [];
  try {
    for (const e of fs.readDirSync(join(repo, "fleets"))) {
      if (e.isDirectory && readOr(join(repo, "fleets", e.name, "fleet.ts")) !== undefined) {
        out.push(e.name);
      }
    }
  } catch {
    /* no fleets yet */
  }
  return out.sort();
}

/** Where `stolos fleet use <id>` keeps this checkout's choice (inside .git: never committed). */
export function fleetChoiceFile(repo: string): string {
  return join(repo, ".git", "stolos", "fleet");
}

/** The active fleet's id, or "" when it cannot be decided (see the header). */
export function findFleetId(repo: string): string {
  const env = proc.env.get("ARCHON_FLEET")?.trim();
  if (env !== undefined && env !== "") return env;
  const etc = readOr("/etc/archon/fleet")?.trim();
  if (etc !== undefined && etc !== "") return etc;
  const chosen = readOr(fleetChoiceFile(repo))?.trim();
  if (chosen !== undefined && chosen !== "") return chosen;
  const all = listFleets(repo);
  return all.length === 1 ? (all[0] ?? "") : "";
}

/** A client's id (spec 082): lowercase letters, digits, and hyphens, as a folder name. */
export const CLIENT_ID: RegExp = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The provider's client this run is for (ARCHON_CLIENT, which `--client`
 * sets), or "" for none. Anything but a client id is refused: it names folders.
 */
export function clientId(): string {
  const c = proc.env.get("ARCHON_CLIENT")?.trim() ?? "";
  if (c !== "" && !CLIENT_ID.test(c)) throw new Error(`ARCHON_CLIENT is not a client id: ${c}`);
  return c;
}

let cachedRepo: string | undefined;
let cachedFleet: string | undefined;
/** Forget the resolved instance and fleet (tests, and `fleet init`). */
export function resetRoots(): void {
  cachedRepo = undefined;
  cachedFleet = undefined;
}
function repoRoot(): string {
  return (cachedRepo ??= findInstanceRoot());
}
function fleetId(): string {
  return (cachedFleet ??= findFleetId(repoRoot()));
}
function fleetDir(): string {
  return join(repoRoot(), "fleets", fleetId() || "_");
}

const home = proc.env.get("HOME") ?? proc.env.get("USERPROFILE") ?? ".";
const isWindows = proc.build.os === "windows";
/** Per-user data on the boot machine (Windows: %LOCALAPPDATA%, else XDG). */
const userData = isWindows
  ? (proc.env.get("LOCALAPPDATA") ?? join(home, "AppData", "Local"))
  : (proc.env.get("XDG_DATA_HOME") ?? join(home, ".local", "share"));
/** Per-user config (secrets) on the boot machine (Windows: %APPDATA%). */
const userConfig = isWindows
  ? (proc.env.get("APPDATA") ?? join(home, "AppData", "Roaming"))
  : (proc.env.get("XDG_CONFIG_HOME") ?? join(home, ".config"));

/**
 * A per-user folder for the active fleet: `<base>/stolos/<kind>/<fleet>`, or,
 * for a provider's client (spec 082), `<base>/stolos/clients/<client>/<kind>/<fleet>`.
 */
function perFleet(base: string, kind: string): string {
  const c = clientId();
  return c !== ""
    ? join(base, "stolos", "clients", c, kind, fleetId() || "_")
    : join(base, "stolos", kind, fleetId() || "_");
}

/**
 * ARCHON_SANDBOX=<folder> (tests): every per-user path must resolve inside it,
 * or archon refuses to start, before it reads or writes anything. Windows
 * reads APPDATA and LOCALAPPDATA, Linux HOME and XDG_*: a sandbox that set only
 * one family once let tests reach the boot machine's real secrets.
 */
const sandbox = proc.env.get("ARCHON_SANDBOX");
if (sandbox !== undefined && sandbox !== "") {
  const root = resolve(sandbox).toLowerCase();
  const roots: ReadonlyArray<readonly [string, string]> = [
    ["home", home],
    ["user data", userData],
    ["user config", userConfig],
  ];
  for (const [what, p] of roots) {
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
  /** The provider's client this run is for (spec 082), or "" for none. */
  get clientId(): string {
    return clientId();
  },
  /**
   * The provider's own folder on this PC (spec 082): the registry of client
   * checkouts (clients.json) and the chosen client. Never in any repository.
   */
  provider: join(userConfig, "stolos"),
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
      : perFleet(userData, "state");
  },
  /**
   * This user's own files derived from Git, per fleet (known_hosts.auto): an
   * operator on a workstation cannot write /var/lib/archon.
   */
  get userState(): string {
    return perFleet(userData, "state");
  },
  /**
   * Downloaded reference catalogs (spec 071: SCF, NIST), for every fleet on
   * this machine; a server keeps them in /var/lib/archon/catalogs.
   */
  get catalogs(): string {
    return readOr("/etc/archon/host") !== undefined
      ? "/var/lib/archon/catalogs"
      : join(userData, "stolos", "catalogs");
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
    return perFleet(userConfig, "secrets");
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
