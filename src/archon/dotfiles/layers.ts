/**
 * 031-dotfile-layers: every user's chezmoi source is composed from layers,
 * most general first (spec 046: the engine's base travels with the engine;
 * the rest is in the fleet repository, under the fleet's folder):
 *
 *   @engine/home/                                 the engine's base (every fleet)
 *   fleets/<id>/home/                             the fleet (every user, every host)
 *   fleets/<id>/hosts/<host>/home/                everyone on one host
 *   fleets/<id>/users/<user>/home/                one user on every host
 *   fleets/<id>/hosts/<host>/users/<user>/home/   one user on one host
 *
 * A later layer replaces a file with the same target (~/.bashrc is the same
 * target whether its source is dot_bashrc or dot_bashrc.tmpl). The root
 * .chezmoiignore and .chezmoiremove of every layer are concatenated. `archon
 * apply` writes the composition to /var/lib/archon-dotfiles/<user> (owned by
 * root, readable by the user) and runs chezmoi from there, so chezmoi's
 * templates and data work as usual and every change goes through the repo.
 *
 * @module
 */
// Spec: 031-dotfile-layers

import { path as paths } from "@intellectual-frontiers/commons/ts/runtime";

/** Where `archon apply` writes each user's composed chezmoi source (one directory per user). */
export const COMPOSED_ROOT = "/var/lib/archon-dotfiles";

/** Which layer it is, most general first: engine, fleet, host, user, host-user. */
export type LayerKind = "engine" | "fleet" | "host" | "user" | "host-user";

/** The engine's base layer: read from the engine's own files (assets.auto.ts), not the repository. */
export const ENGINE_LAYER = "@engine/home";

/** One layer of a user's dotfiles. */
export interface Layer {
  /** Which layer it is. */
  kind: LayerKind;
  /** Repository-relative directory (forward slashes). */
  dir: string;
}

/** The five layers for one user on one host in a fleet, most general first. */
export function layersFor(host: string, user: string, fleet: string): Layer[] {
  const f = `fleets/${fleet}`;
  return [
    { kind: "engine", dir: ENGINE_LAYER },
    { kind: "fleet", dir: `${f}/home` },
    { kind: "host", dir: `${f}/hosts/${host}/home` },
    { kind: "user", dir: `${f}/users/${user}/home` },
    { kind: "host-user", dir: `${f}/hosts/${host}/users/${user}/home` },
  ];
}

/** The composed source directory for a user, under `COMPOSED_ROOT`: a host's path, always `/`. */
export function composedDir(user: string): string {
  return paths.posix.join(COMPOSED_ROOT, user);
}

/** Root files of a layer whose contents are concatenated, not replaced. */
const CONCATENATED = [".chezmoiignore", ".chezmoiremove"];

/** Layer files that are documentation, not dotfiles. */
const DOCS = ["README.md"];

// chezmoi source-state attributes (https://www.chezmoi.io/reference/source-state-attributes/).
const PREFIXES = [
  "after_",
  "before_",
  "create_",
  "empty_",
  "encrypted_",
  "exact_",
  "executable_",
  "external_",
  "modify_",
  "once_",
  "onchange_",
  "private_",
  "readonly_",
  "remove_",
  "run_",
  "symlink_",
];

/** The target name of one source path component ("private_dot_ssh" is ".ssh"). */
export function targetName(component: string, isFile: boolean): string {
  let s = component;
  for (let again = true; again;) {
    again = false;
    if (s.startsWith("literal_")) return s.slice("literal_".length);
    for (const p of PREFIXES) {
      if (s.startsWith(p)) {
        s = s.slice(p.length);
        again = true;
      }
    }
  }
  if (s.startsWith("dot_")) s = "." + s.slice(4);
  if (isFile) s = s.replace(/\.(tmpl|literal)$/, "");
  return s;
}

/** The target path (relative to the home directory) of a source path. */
export function targetOf(sourceRel: string): string {
  const parts = sourceRel.split("/");
  return parts.map((c, i) => targetName(c, i === parts.length - 1)).join("/");
}

/**
 * Why a source file may not be in any layer, or undefined. Scripts run code
 * at apply time, encrypted files are secrets (Article 13), externals download
 * without a pinned checksum (Article 12), and a .chezmoiroot would point
 * chezmoi elsewhere.
 */
export function forbidden(sourceRel: string): string | undefined {
  const parts = sourceRel.split("/");
  const top = parts[0] ?? "";
  if (top === ".chezmoiscripts") return "scripts are not allowed in dotfiles (use the model)";
  if (top.startsWith(".chezmoiexternal")) return "externals download unpinned files (Article 12)";
  if (top === ".chezmoiroot") return "a layer cannot move chezmoi's source";
  for (const c of parts) {
    if (c.startsWith("run_")) return "scripts are not allowed in dotfiles (use the model)";
    if (c.startsWith("encrypted_") || /\.(age|asc)$/.test(c)) {
      return "no secrets in dotfiles (Article 13)";
    }
  }
  return undefined;
}

/** One file of the composed source, from the most specific layer that has its target. */
export interface ComposedFile {
  /** Path in the composed source. */
  source: string;
  /** Repository-relative path it comes from. */
  from: string;
  /** The layer it comes from. */
  layer: Layer;
  /** Target path relative to the home directory. */
  target: string;
}

/** A user's composed dotfiles source, with any problems found on the way. */
export interface Composition {
  /** Every layer considered, most general first. */
  layers: Layer[];
  /** Layers that exist (have at least one file). */
  present: Layer[];
  /** The files that won, sorted by source path. */
  files: ComposedFile[];
  /** Concatenated special files (.chezmoiignore, .chezmoiremove) and their text. */
  concatenated: Map<string, string>;
  /** Files left out and why (forbidden kinds, two sources for one target in a layer). */
  problems: string[];
}

/** Read a layer's files: repository-relative paths below its directory. */
export type LayerReader = (dir: string) => Promise<string[]>;
/** Read one file's text, by repository-relative path. */
export type TextReader = (repoRel: string) => Promise<string>;

/** Compose a user's source on a host from the layers (pure apart from the readers). */
export async function compose(
  host: string,
  user: string,
  list: LayerReader,
  read: TextReader,
  fleet = "lab",
): Promise<Composition> {
  const layers = layersFor(host, user, fleet);
  const byTarget = new Map<string, ComposedFile>();
  // A target directory keeps the source name the most general layer gave it,
  // so `dot_ssh` in one layer and `private_dot_ssh` in another do not collide.
  const dirSource = new Map<string, string>([["", ""]]);
  const concatenated = new Map<string, string>();
  const problems: string[] = [];
  const present: Layer[] = [];
  for (const layer of layers) {
    const rels = await list(layer.dir);
    if (rels.length) present.push(layer);
    const seen = new Map<string, string>();
    for (const rel of rels) {
      const from = `${layer.dir}/${rel}`;
      if (DOCS.includes(rel)) continue;
      if (CONCATENATED.includes(rel)) {
        const text = await read(from);
        concatenated.set(
          rel,
          (concatenated.get(rel) ?? "") +
            `# from ${layer.dir}/${rel}\n${text.replace(/\n?$/, "\n")}`,
        );
        continue;
      }
      const why = forbidden(rel);
      if (why) {
        problems.push(`${from}: ${why}`);
        continue;
      }
      const target = rel.startsWith(".chezmoi") ? rel : targetOf(rel);
      const twin = seen.get(target);
      if (twin) {
        problems.push(`${from}: same target ~/${target} as ${layer.dir}/${twin} in the same layer`);
        continue;
      }
      seen.set(target, rel);
      const src = rel.split("/");
      const tgt = target.split("/");
      for (let i = 1; i < src.length; i++) {
        const td = tgt.slice(0, i).join("/");
        if (!dirSource.has(td)) {
          const parent = dirSource.get(tgt.slice(0, i - 1).join("/"));
          const name = src[i - 1] ?? "";
          dirSource.set(td, parent ? `${parent}/${name}` : name);
        }
      }
      const dir = dirSource.get(tgt.slice(0, -1).join("/"));
      const last = src.at(-1) ?? "";
      byTarget.set(target, {
        source: dir ? `${dir}/${last}` : last,
        from,
        layer,
        target,
      });
    }
  }
  const files = [...byTarget.values()].sort((a, b) => a.source.localeCompare(b.source));
  return { layers, present, files, concatenated, problems };
}

/** The composition's files as path -> repository path or literal text (for writing). */
export function composedEntries(
  c: Composition,
): Array<{ path: string; from?: string; text?: string }> {
  return [
    ...c.files.map((f) => ({ path: f.source, from: f.from })),
    ...[...c.concatenated].map(([path, text]) => ({ path, text })),
  ].sort((a, b) => a.path.localeCompare(b.path));
}

/** Layer directories in the repository that name no host or no user on it. */
export function strayLayers(
  dirs: { hosts: string[]; users: string[]; hostUsers: Array<[string, string]> },
  hostUsers: Map<string, string[]>,
  fleet = "lab",
): string[] {
  const f = `fleets/${fleet}`;
  const allUsers = new Set([...hostUsers.values()].flat());
  const out: string[] = [];
  for (const h of dirs.hosts) {
    if (!hostUsers.has(h)) out.push(`${f}/hosts/${h}/home: no host ${h} in the model`);
  }
  for (const u of dirs.users) {
    if (!allUsers.has(u)) out.push(`${f}/users/${u}: no user ${u} on any host`);
  }
  for (const [h, u] of dirs.hostUsers) {
    const users = hostUsers.get(h);
    if (users !== undefined && !users.includes(u)) {
      out.push(`${f}/hosts/${h}/users/${u}: ${h} has no user ${u}`);
    }
  }
  return out;
}
