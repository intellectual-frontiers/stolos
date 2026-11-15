/**
 * Spec 062: the bootstrap scripts that make a PC a Stolos controller (the
 * pinned Bun, Git, gh, the GitHub sign-in, the fleet cloned into `$HOME/fleet`, the
 * `stolos` shortcut). The engine publishes them with every release,
 * `bin/bootstrap.sh` and `bin/bootstrap.windows.ps1` (carried in {@link ASSETS}),
 * which a new PC runs with --repo; a fleet
 * repository gets its own copy as `bin/bootstrap.sh` and
 * `bin/bootstrap.windows.ps1` with its repository filled in, from `fleet init`
 * and `fleet upgrade`.
 *
 * ```mermaid
 * flowchart LR
 *   tpl["engine: bin/bootstrap.*<br/>(--repo required)"] --> init["fleet init / fleet upgrade"]
 *   init --> copy["fleet: bin/bootstrap.*<br/>(its owner/name filled in)"]
 * ```
 *
 * @module
 */

import { ASSETS } from "../assets.auto.ts";
import { run } from "../core/exec.ts";
import { VERSION } from "../version.ts";

/** The template's path in the engine, by the fleet's file name. */
const TEMPLATES: Record<string, string> = {
  "bin/bootstrap.sh": "bin/bootstrap.sh",
  "bin/bootstrap.windows.ps1": "bin/bootstrap.windows.ps1",
};

/** The bootstrap scripts' paths in a fleet repository. */
export const BOOTSTRAP_PATHS: string[] = Object.keys(TEMPLATES);

/** The template's text for a fleet path (as the engine carries it). */
export function bootstrapTemplate(fleetPath: string): string {
  const asset = TEMPLATES[fleetPath];
  const t = asset === undefined ? undefined : ASSETS[asset];
  if (t === undefined) throw new Error(`no bootstrap template for ${fleetPath}`);
  return t;
}

/**
 * The Bun version a bootstrap script installs (its `BUN_VERSION="..."` / `$BunVersion = "..."`
 * line): the engine's pin, `install/bun.ts` (spec 096 FR-007).
 */
export function bootstrapBunVersion(text: string): string | undefined {
  return text.match(/^(?:BUN_VERSION=|\$BunVersion = )"([^"]+)"/m)?.[1];
}

/**
 * A fleet's bootstrap scripts, by path, with `repo` (owner/name) as their
 * default. Without one (no GitHub remote yet), they ask for --repo, as the
 * engine's own copy does.
 */
export function bootstrapFiles(repo = ""): Record<string, string> {
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`not owner/name: ${repo}`);
  const out: Record<string, string> = {};
  for (const path of BOOTSTRAP_PATHS) {
    out[path] = bootstrapTemplate(path)
      .replace(/^DEFAULT_REPO=""/m, `DEFAULT_REPO="${repo}"`)
      .replace(/^\$DefaultRepo = ""/m, `$DefaultRepo = "${repo}"`);
  }
  return out;
}

/** owner/name of a GitHub remote URL (https or SSH), or undefined. */
export function githubSlug(url: string): string | undefined {
  const m = url.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The repository's own owner/name, from its origin remote ("" when it has none on GitHub). */
export async function repoSlug(repo: string): Promise<string> {
  const r = await run(["git", "-C", repo, "remote", "get-url", "origin"]);
  return (r.ok && githubSlug(r.stdout)) || "";
}

/** Where the engine's bootstrap is published, by release tag. */
const RAW = "https://raw.githubusercontent.com/intellectual-frontiers/stolos/";

/**
 * The one line that bootstraps a PC from the engine's bootstrap at `tag` (it is
 * public: no sign-in needed to fetch it), for the fleet `repo` (owner/name).
 */
export function bootstrapOneLiner(os: "windows" | "posix", repo = "", tag = `v${VERSION}`): string {
  const r = repo || "<owner>/<fleet-repo>";
  return os === "windows"
    ? `& ([scriptblock]::Create((irm ${RAW}${tag}/bin/bootstrap.windows.ps1))) --repo ${r}`
    : `bash <(curl -fsSL ${RAW}${tag}/bin/bootstrap.sh) --repo ${r}`;
}
