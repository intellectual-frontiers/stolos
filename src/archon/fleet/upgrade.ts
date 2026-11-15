/**
 * `stolos fleet upgrade <tag>` (spec 046-engine-instance, Articles 9, 12, 24):
 * move a fleet repository to another released version of the engine, safely.
 *
 * Why each step exists (the fleet-repository guide, ./mod.ts, says it at length):
 *   1. The tag must be a release: the engine's own src/archon/version.ts at
 *      that tag must say the same version. A typo or a branch name is refused.
 *   2. Only forward, unless --downgrade: going back to an older engine is a
 *      decision, not an accident.
 *   3. deno.json's @stolos/ pin is rewritten to the tag; deno.lock is built
 *      again through engine.ts, so it holds a hash of every engine file. Hosts
 *      run with --frozen: any engine file that differs from the lock is
 *      refused. That is what makes your signature cover the engine's bytes.
 *   4. Every fleet in the repository is validated with the new engine before
 *      anything is committed.
 *   5. The three files are committed together and signed (git commit -S):
 *      hosts apply only a signed tip of main. Pushing it is the approval.
 *
 * ```mermaid
 * sequenceDiagram
 *   actor P as Person
 *   participant U as stolos fleet upgrade
 *   participant G as GitHub (stolos tag)
 *   participant R as fleet repository
 *   P->>U: fleet upgrade vX.Y.Z
 *   U->>G: is vX.Y.Z a release? (its version.ts)
 *   U->>R: deno.json pin, the reusable workflows' tag
 *   U->>G: deno cache: every engine file
 *   U->>R: deno.lock (a hash of each)
 *   U->>R: validate every fleet with the new engine
 *   U->>R: one signed commit
 *   P->>R: git push (the approval)
 * ```
 *
 * @module
 */

import { listFleets, P } from "../core/paths.ts";
import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";

/** The file that names every engine module, so deno.lock pins all of them. */
export const ENGINE_ENTRY = "engine.ts";
/** Its content. */
export const ENGINE_ENTRY_TEXT =
  `// Every engine module, so that deno.lock pins all of them (archon runs with
// --frozen, and the engine loads some modules on demand). Nothing runs this
// file. Kept by stolos fleet upgrade (spec 046).
import "@stolos/archon/modules.auto.ts";
`;

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
/** "https://raw.githubusercontent.com/<org>/stolos/v0.7.0/src/" */
const PIN = /^(.*\/)(v\d+\.\d+\.\d+)(\/src\/)$/;

/** A version: major, minor, patch. */
export type Semver = [number, number, number];

/** A tag ("v1.2.3") as a version, or undefined. */
export function parseTag(tag: string): Semver | undefined {
  const m = tag.match(TAG);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** -1, 0, or 1. */
export function compare(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Where the engine is pinned: its base URL and tag. */
export interface Pin {
  /** The URL before the tag ("https://raw.githubusercontent.com/<org>/stolos/"). */
  base: string;
  /** The tag, "vX.Y.Z". */
  tag: string;
}

/** The @stolos/ pin in a deno.json's text, or undefined when it is not a tagged URL. */
export function readPin(denoJson: string): Pin | undefined {
  let url: unknown;
  try {
    url = JSON.parse(denoJson)?.imports?.["@stolos/"];
  } catch {
    return undefined;
  }
  const m = typeof url === "string" ? url.match(PIN) : null;
  return m ? { base: m[1], tag: m[2] } : undefined;
}

/** deno.json's text with the pin moved to `tag` (only that string changes). */
export function writePin(denoJson: string, pin: Pin, tag: string): string {
  const from = JSON.stringify(`${pin.base}${pin.tag}/src/`);
  const to = JSON.stringify(`${pin.base}${tag}/src/`);
  if (!denoJson.includes(from)) throw new Error("deno.json's @stolos/ pin is not where expected");
  return denoJson.replace(from, to);
}

/**
 * The engine repository ("owner/name") a pin's base points at:
 * https://raw.githubusercontent.com/<owner>/<name>/ (else undefined).
 */
export function engineRepository(pin: Pin): string | undefined {
  return pin.base.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/$/)?.[1];
}

/**
 * A fleet repository's workflows call the engine's reusable workflows
 * (fleet-e2e.yml) at a tag: the same tag as the pin, so the lab tests the
 * engine the fleet runs. Returns the text with every such reference moved to
 * `tag`.
 */
export function rewriteWorkflowRefs(text: string, engineRepo: string, tag: string): string {
  const esc = engineRepo.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return text.replace(
    new RegExp(`(${esc}/\\.github/workflows/[\\w.-]+\\.ya?ml@)v\\d+\\.\\d+\\.\\d+`, "g"),
    `$1${tag}`,
  );
}

/** Move the engine's reusable workflows to `tag` in .github/workflows; the files changed. */
async function moveWorkflowRefs(repo: string, pin: Pin, tag: string): Promise<string[]> {
  const engineRepo = engineRepository(pin);
  if (!engineRepo) return [];
  const changed: string[] = [];
  try {
    for (const e of Deno.readDirSync(join(repo, ".github", "workflows"))) {
      if (!e.isFile || !/\.ya?ml$/.test(e.name)) continue;
      const rel = `.github/workflows/${e.name}`;
      const before = await Deno.readTextFile(join(repo, rel));
      const after = rewriteWorkflowRefs(before, engineRepo, tag);
      if (after !== before) {
        await Deno.writeTextFile(join(repo, rel), after);
        changed.push(rel);
      }
    }
  } catch { /* no workflows */ }
  return changed;
}

/** The version the engine says it is at `tag` (its src/archon/version.ts), or why not. */
export async function releasedVersion(
  pin: Pin,
  tag: string,
): Promise<{ version?: string; why?: string }> {
  const url = `${pin.base}${tag}/src/archon/version.ts`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) {
      await r.body?.cancel();
      return { why: `${tag} is not a released engine version (${url}: HTTP ${r.status})` };
    }
    const v = (await r.text()).match(/export const VERSION = "(\d+\.\d+\.\d+)";/)?.[1];
    return v ? { version: v } : { why: `${url} has no VERSION` };
  } catch (e) {
    return { why: `cannot reach ${url}: ${(e as Error).message}` };
  }
}

/** What stolos fleet upgrade is given. */
export interface UpgradeOptions {
  /** The tag to move to. */
  tag: string;
  /** Allow an older (or the same) version. */
  downgrade?: boolean;
  /** Change the files only; the operator commits. */
  noCommit?: boolean;
  /** For tests: the repository (default: the instance). */
  repo?: string;
}

/** stolos fleet upgrade: move the pin, lock the engine, validate every fleet, and make one signed commit. */
export async function fleetUpgrade(o: UpgradeOptions): Promise<number> {
  const repo = o.repo ?? P.repo;
  const denoJsonPath = join(repo, "deno.json");
  const git = (args: string[]) => run(["git", "-C", repo, ...args]);

  // 1. The pin and the tag.
  const p = ui.phase("Engine version");
  const text = await readTextOr(denoJsonPath);
  const pin = text ? readPin(text) : undefined;
  if (!text || !pin) {
    p.fail(
      `${denoJsonPath} has no @stolos/ pin to a tagged URL (…/stolos/vX.Y.Z/src/)`,
      "see deno task stolos docs fleet-repository, section 'The pin'",
    );
    return ui.finish();
  }
  const want = parseTag(o.tag);
  const have = parseTag(pin.tag)!;
  if (!want) {
    p.fail(`'${o.tag}' is not a version tag`, "use the form v1.2.3 (see the engine's releases)");
    return ui.finish();
  }
  const order = compare(want, have);
  if (order === 0 && !o.downgrade) {
    p.done(`already at ${pin.tag}: nothing to do`);
    return ui.finish();
  }
  if (order < 0 && !o.downgrade) {
    p.fail(
      `${o.tag} is older than the pinned ${pin.tag}`,
      "going back is a decision: add --downgrade if you mean it",
    );
    return ui.finish();
  }
  p.status(`checking that ${o.tag} is a released version`);
  const rel = await releasedVersion(pin, o.tag);
  if (!rel.version || `v${rel.version}` !== o.tag) {
    p.fail(
      rel.why ?? `${o.tag}'s own version.ts says ${rel.version}: not a release`,
      "pick a tag CI made (the engine's tags), and check its spelling",
    );
    return ui.finish();
  }
  // Nothing else may be changed: the commit must hold exactly this upgrade.
  const dirty = (await git(["status", "--porcelain", "--untracked-files=no"])).stdout.trim();
  if (dirty && !o.noCommit) {
    p.fail(
      "the repository has uncommitted changes",
      "commit or stash them first: the upgrade is a commit of its own",
    );
    return ui.finish();
  }
  p.done(`${pin.tag} → ${o.tag} (released; ${order < 0 ? "a downgrade" : "newer"})`);

  // A signed commit must be possible here, checked before any file changes: a fresh
  // clone has no signing settings or identity until vault restore or keys setup ran in it.
  if (!o.noCommit) {
    const { signingBlockers } = await import("../identity/keys-commands.ts");
    const blocking = await signingBlockers(repo);
    if (blocking.length) {
      const s = ui.phase("Signing");
      for (const k of blocking) s.fail(`${k.what} (nothing was changed)`, k.fix, k.code);
      return ui.finish();
    }
  }

  // 2. The pin, engine.ts, and the lock.
  const l = ui.phase("Lock");
  await Deno.writeTextFile(denoJsonPath, writePin(text, pin, o.tag));
  const workflows = await moveWorkflowRefs(repo, pin, o.tag);
  const entry = join(repo, ENGINE_ENTRY);
  if ((await readTextOr(entry)) !== ENGINE_ENTRY_TEXT) {
    await Deno.writeTextFile(entry, ENGINE_ENTRY_TEXT);
  }
  const lock = join(repo, "deno.lock");
  if (await exists(lock)) await Deno.remove(lock);
  const entries: string[] = [];
  for (const f of ["archon.ts", "stolos.ts", ENGINE_ENTRY]) {
    if (await exists(join(repo, f))) entries.push(f);
  }
  l.status("downloading the engine and hashing every file");
  const cache = await run([
    Deno.execPath(),
    "cache",
    "--allow-import",
    "--lock=deno.lock",
    ...entries,
  ], { cwd: repo });
  if (!cache.ok) {
    // Put everything back: a half-done upgrade is worse than none.
    await Deno.writeTextFile(denoJsonPath, text);
    await git(["checkout", "--", "deno.lock", ENGINE_ENTRY, ...workflows]).catch(() => {});
    l.fail(
      `the engine at ${o.tag} could not be cached: ${cache.stderr.trim().split("\n").pop()}`,
      "check the network, then run it again; nothing was changed",
    );
    return ui.finish();
  }
  const files = ((await readTextOr(lock)) ?? "").split(`${pin.base}${o.tag}/`).length - 1;
  l.done(`deno.lock pins ${files} engine file(s) at ${o.tag}`);

  // 3. Every fleet, validated with the new engine (in its own process, frozen).
  const v = ui.phase("Validate");
  const fleets = listFleets(repo);
  for (const id of fleets) {
    v.status(`fleet ${id}`);
    const r = await run([
      Deno.execPath(),
      "run",
      "-A",
      "--frozen",
      "stolos.ts",
      "validate",
    ], { cwd: repo, env: { ...Deno.env.toObject(), ARCHON_REPO: repo, ARCHON_FLEET: id } });
    if (!r.ok) {
      v.fail(
        `fleet ${id} does not validate with ${o.tag}`,
        `read it with: ARCHON_FLEET=${id} deno task stolos validate; fix the model (or stay on ${pin.tag}: git checkout -- deno.json deno.lock ${ENGINE_ENTRY})`,
      );
      return ui.finish();
    }
  }
  v.done(fleets.length ? `${fleets.join(", ")} valid with ${o.tag}` : "no fleets yet");

  // Spec 062: the bootstrap scripts and .gitattributes, as this engine writes them;
  // spec 074: the compliance-impact workflow too.
  const { bootstrapFiles, repoSlug } = await import("./bootstrap.ts");
  const { GITATTRIBUTES_TEXT } = await import("./scaffold.ts");
  const { IMPACT_WORKFLOW_PATH, IMPACT_WORKFLOW_TEXT } = await import(
    "../compliance/workflow.ts"
  );
  const refreshed: string[] = [];
  for (
    const [rel, want] of Object.entries({
      ...bootstrapFiles(await repoSlug(repo)),
      ".gitattributes": GITATTRIBUTES_TEXT,
      [IMPACT_WORKFLOW_PATH]: IMPACT_WORKFLOW_TEXT,
    })
  ) {
    const p = join(repo, rel);
    if ((await readTextOr(p)) === want) continue;
    await Deno.mkdir(join(p, ".."), { recursive: true });
    await Deno.writeTextFile(p, want);
    if (rel.endsWith(".sh") && Deno.build.os !== "windows") await Deno.chmod(p, 0o755);
    refreshed.push(rel);
  }
  if (refreshed.length) v.note(`refreshed ${refreshed.join(", ")}`);

  // 4. One signed commit.
  const c = ui.phase("Commit");
  if (o.noCommit) {
    c.done("files changed, not committed (--no-commit)");
    ui.next.push(
      `review: git diff; then: git add deno.json deno.lock ${ENGINE_ENTRY} ${
        [...workflows, ...refreshed].join(" ")
      } && git commit -S -m "stolos ${o.tag}: adopt the engine ${o.tag}"`,
    );
    return ui.finish();
  }
  await git(["add", "deno.json", "deno.lock", ENGINE_ENTRY, ...workflows, ...refreshed]);
  // Runnable on Linux and macOS whatever system made the commit.
  if (refreshed.includes("bin/bootstrap.sh")) {
    await git(["update-index", "--chmod=+x", "bin/bootstrap.sh"]);
  }
  c.status("signing (your key's passphrase)");
  ui.pause();
  const commit = await run(
    [
      "git",
      "-C",
      repo,
      "commit",
      "-S",
      "-q",
      "-m",
      `stolos ${o.tag}: adopt the engine ${o.tag}`,
      "-m",
      `From ${pin.tag}. deno.lock pins every engine file at ${o.tag}; validated: ${
        fleets.join(", ") || "no fleets"
      }.`,
    ],
    { inherit: true },
  );
  ui.resume();
  if (!commit.ok) {
    c.fail(
      "the commit was not made (signing failed or was cancelled)",
      `check your signing setup (stolos signers), then: git commit -S -m "stolos ${o.tag}: adopt the engine ${o.tag}"`,
    );
    return ui.finish();
  }
  c.done(`signed commit "stolos ${o.tag}: adopt the engine ${o.tag}"`);
  ui.next.push(
    "push it: deno task stolos apply (pushing is the approval; hosts move to it within 15 minutes)",
    "then watch them: stolos fleet status",
  );
  return ui.finish();
}
