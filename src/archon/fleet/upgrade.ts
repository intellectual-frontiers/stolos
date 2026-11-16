/**
 * `stolos fleet upgrade <tag>` (spec 046-engine-instance, Articles 9, 12, 24; spec 096 FR-006):
 * move a fleet repository to another version of the engine, safely. A version of the engine is its
 * tag `v<version>`: there is no GitHub release, and a fleet depends on the engine by Git.
 *
 * Why each step exists (the fleet-repository guide, ./mod.ts, says it at length):
 *   1. The tag must be a version tag, and only forward unless --downgrade: going back to an older
 *      engine is a decision, not an accident.
 *   2. `package.json`'s dependency on the engine is moved to that tag
 *      (`"@intellectual-frontiers/stolos": "github:intellectual-frontiers/stolos#v<version>"`),
 *      and `bun install` pins the commit the tag names, and its integrity, in `bun.lock`. The
 *      installed package must say it is that version: a typo, or a tag that is not that version, is
 *      refused and everything is put back. Hosts run `bun install --frozen-lockfile`: an engine
 *      that differs from the lock is refused, and a tag moved later changes nothing, since the lock
 *      holds the commit. That is what makes your signature cover the engine's bytes.
 *   3. Every fleet in the repository is validated with the new engine before anything is
 *      committed.
 *   4. The files are committed together and signed (git commit -S): hosts apply only a signed
 *      tip of main. Pushing it is the approval.
 *
 * ```mermaid
 * sequenceDiagram
 *   actor P as Person
 *   participant U as stolos fleet upgrade
 *   participant G as GitHub (the engine's tag)
 *   participant R as fleet repository
 *   P->>U: fleet upgrade vX.Y.Z
 *   U->>R: package.json: github:...#vX.Y.Z, the reusable workflows' tag
 *   U->>G: bun install: the tag's commit
 *   U->>R: bun.lock (the commit, its integrity); the installed engine says vX.Y.Z
 *   U->>R: validate every fleet with the new engine
 *   U->>R: one signed commit
 *   P->>R: stolos apply (the approval)
 * ```
 *
 * @module
 */
// Spec: 046-engine-instance
// Spec: 096-bun-runtime

import { object, record, string } from "@intellectual-frontiers/commons/ts/kernel";
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { listFleets, P } from "../core/paths.ts";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { engineCommand, installDependencies } from "../install/bun.ts";

/** The engine's package name, as a fleet repository depends on it. */
export const ENGINE_PACKAGE = "@intellectual-frontiers/stolos";

/** Where the engine is fetched from: its repository on GitHub, as a `github:` dependency names it. */
export const ENGINE_SOURCE = "github:intellectual-frontiers/stolos";

/** The file of a fleet repository that pins the engine. */
export const PIN_FILE = "package.json";

/** The file that holds the commit and the integrity of the pinned engine. */
export const LOCK_FILE = "bun.lock";

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
/**
 * A Git dependency at a version tag: `github:<owner>/<name>#v0.7.0`, or any `git+` URL (a mirror,
 * or a local copy of the engine in a test) at such a tag.
 */
const PIN = /^((?:github:[^#\s]+)|(?:git\+[^#\s]+))#(v\d+\.\d+\.\d+)$/;

/** A version: major, minor, patch. */
export type Semver = [number, number, number];

/** A tag ("v1.2.3") as a version, or undefined. */
export function parseTag(tag: string): Semver | undefined {
  const m = tag.match(TAG);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** -1, 0, or 1. */
export function compare(a: Semver, b: Semver): number {
  for (const i of [0, 1, 2] as const) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Where the engine is pinned: the Git source and the tag. */
export interface Pin {
  /** The dependency before `#`: `github:intellectual-frontiers/stolos`, or a `git+` URL. */
  source: string;
  /** The tag, "vX.Y.Z". */
  tag: string;
}

/** The dependency on the engine at a tag: `github:intellectual-frontiers/stolos#v<version>`. */
export function engineDependency(tag: string, source: string = ENGINE_SOURCE): string {
  return `${source}#v${tag.replace(/^v/, "")}`;
}

/** The parts of a package.json the pin is read from. */
const PACKAGE_JSON = object({}, { dependencies: record(string) });

/** The engine's pin in a package.json's text, or undefined when it is not a Git dependency at a version tag. */
export function readPin(packageJson: string): Pin | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return undefined;
  }
  const d = PACKAGE_JSON(parsed);
  const dep = d.kind === "ok" ? d.value.dependencies?.[ENGINE_PACKAGE] : undefined;
  const m = dep?.match(PIN);
  if (!m) return undefined;
  const [, source = "", tag = ""] = m;
  return { source, tag };
}

/** package.json's text with the pin moved to `tag` (only that string changes). */
export function writePin(packageJson: string, pin: Pin, tag: string): string {
  const from = JSON.stringify(engineDependency(pin.tag, pin.source));
  const to = JSON.stringify(engineDependency(tag, pin.source));
  if (!packageJson.includes(from)) {
    throw new Error(`package.json's ${ENGINE_PACKAGE} pin is not where expected`);
  }
  return packageJson.replace(from, to);
}

/** The engine repository ("owner/name") a pin's `github:` source names (else undefined). */
export function engineRepository(pin: Pin): string | undefined {
  return pin.source.match(/^github:([^/]+\/[^/]+)$/)?.[1];
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
    for (const e of fs.readDirSync(path.join(repo, ".github", "workflows"))) {
      if (!e.isFile || !/\.ya?ml$/.test(e.name)) continue;
      const rel = `.github/workflows/${e.name}`;
      const before = await fs.readTextFile(path.join(repo, rel));
      const after = rewriteWorkflowRefs(before, engineRepo, tag);
      if (after !== before) {
        await fs.writeTextFile(path.join(repo, rel), after);
        changed.push(rel);
      }
    }
  } catch {
    /* no workflows */
  }
  return changed;
}

/** The version of the engine installed in a checkout (its package's own package.json), or undefined. */
export async function installedVersion(repo: string): Promise<string | undefined> {
  const text = await fs.readTextOr(
    path.join(repo, "node_modules", ...ENGINE_PACKAGE.split("/"), "package.json"),
  );
  if (text === undefined) return undefined;
  try {
    const d = object({ version: string })(JSON.parse(text));
    return d.kind === "ok" ? d.value.version : undefined;
  } catch {
    return undefined;
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

/** stolos fleet upgrade: move the pin, install and lock the engine, validate every fleet, and make one signed commit. */
export async function fleetUpgrade(o: UpgradeOptions): Promise<number> {
  const repo = o.repo ?? P.repo;
  const pinPath = path.join(repo, PIN_FILE);
  const lockPath = path.join(repo, LOCK_FILE);
  const git = (args: string[]): ReturnType<typeof run> => run(["git", "-C", repo, ...args]);

  // 1. The pin and the tag.
  const p = ui.phase("Engine version");
  const text = await fs.readTextOr(pinPath);
  const pin = text ? readPin(text) : undefined;
  const have = pin ? parseTag(pin.tag) : undefined;
  if (!text || !pin || !have) {
    p.fail(
      `${pinPath} does not depend on ${ENGINE_PACKAGE} by Git at a version tag ("${engineDependency("vX.Y.Z")}")`,
      "see bun run stolos docs fleet-repository, section 'The pin'",
    );
    return ui.finish();
  }
  const want = parseTag(o.tag);
  if (!want) {
    p.fail(`'${o.tag}' is not a version tag`, "use the form v1.2.3 (the engine's version tags)");
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
  const version = want.join(".");
  // Spec 088: every connector a fleet added must support the new engine.
  {
    const { engineSuits, registryEntries } = await import("../connect/registry.ts");
    for (const id of listFleets(repo)) {
      const f = path.join(repo, "fleets", id, "connectors.ts");
      for (const e of registryEntries(await fs.readTextOr(f))) {
        if (engineSuits(version, e.engine) === false) {
          p.fail(
            `fleet ${id}'s connector ${e.id} (${e.ref}) supports engine ${e.engine}, not ${version}`,
            `move it to a tag that does (bun run stolos connector add ${e.source}@<tag>), or remove it, first`,
          );
          return ui.finish();
        }
      }
    }
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
  p.done(`${pin.tag} → ${o.tag} (${order < 0 ? "a downgrade" : "newer"})`);

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

  // 2. The pin, the install, and the lock.
  const l = ui.phase("Lock");
  const lockBefore = await fs.readTextOr(lockPath);
  await fs.writeTextFile(pinPath, writePin(text, pin, o.tag));
  const workflows = await moveWorkflowRefs(repo, pin, o.tag);
  // Put everything back: a half-done upgrade is worse than none.
  const restore = async (): Promise<void> => {
    await fs.writeTextFile(pinPath, text);
    if (lockBefore === undefined) await fs.remove(lockPath).catch(() => {});
    else await fs.writeTextFile(lockPath, lockBefore);
    if (workflows.length) await git(["checkout", "--", ...workflows]);
    await installDependencies(repo);
  };
  l.status(`installing the engine ${o.tag} and recording its integrity in ${LOCK_FILE}`);
  const install = await installDependencies(repo, { frozen: false });
  if (!install.ok) {
    await restore();
    l.fail(
      `the engine at ${o.tag} could not be installed: ${install.stderr.trim().split("\n").pop() ?? `exit ${install.code}`}`,
      "check the tag (a version tag CI made) and the network, then run it again; nothing was changed",
    );
    return ui.finish();
  }
  const installed = await installedVersion(repo);
  if (installed !== version) {
    await restore();
    l.fail(
      `${o.tag}'s package says it is ${installed ?? "no version"}: not that version`,
      "pick a tag CI made (the engine's version tags), and check its spelling; nothing was changed",
    );
    return ui.finish();
  }
  l.done(`${LOCK_FILE} pins the engine's commit at ${o.tag}`);

  // 3. Every fleet, validated with the new engine (in its own process).
  const v = ui.phase("Validate");
  const fleets = listFleets(repo);
  for (const id of fleets) {
    v.status(`fleet ${id}`);
    const r = await run([...engineCommand(), "stolos.ts", "validate"], {
      cwd: repo,
      env: { ...proc.env.toObject(), ARCHON_REPO: repo, ARCHON_FLEET: id },
    });
    if (!r.ok) {
      v.fail(
        `fleet ${id} does not validate with ${o.tag}`,
        `read it with: ARCHON_FLEET=${id} bun run stolos validate; fix the model (or stay on ${pin.tag}: git checkout -- ${PIN_FILE} ${LOCK_FILE} && bun install --frozen-lockfile)`,
      );
      return ui.finish();
    }
  }
  v.done(fleets.length ? `${fleets.join(", ")} valid with ${o.tag}` : "no fleets yet");

  // Spec 062: the bootstrap scripts and .gitattributes, as this engine writes them;
  // spec 074: the compliance-impact workflow too.
  const { bootstrapFiles, repoSlug } = await import("./bootstrap.ts");
  const { GITATTRIBUTES_TEXT } = await import("./scaffold.ts");
  const { IMPACT_WORKFLOW_PATH, IMPACT_WORKFLOW_TEXT } = await import("../compliance/workflow.ts");
  const refreshed: string[] = [];
  for (const [rel, want] of Object.entries({
    ...bootstrapFiles(await repoSlug(repo)),
    ".gitattributes": GITATTRIBUTES_TEXT,
    [IMPACT_WORKFLOW_PATH]: IMPACT_WORKFLOW_TEXT,
  })) {
    const f = path.join(repo, rel);
    if ((await fs.readTextOr(f)) === want) continue;
    await fs.mkdir(path.join(f, ".."), { recursive: true });
    await fs.writeTextFile(f, want);
    if (rel.endsWith(".sh") && proc.build.os !== "windows") await fs.chmod(f, 0o755);
    refreshed.push(rel);
  }
  if (refreshed.length) v.note(`refreshed ${refreshed.join(", ")}`);

  // 4. One signed commit.
  const c = ui.phase("Commit");
  const files = [PIN_FILE, LOCK_FILE, ...workflows, ...refreshed];
  if (o.noCommit) {
    c.done("files changed, not committed (--no-commit)");
    ui.next.push(
      `review: git diff; then: git add ${files.join(" ")} && git commit -S -m "stolos ${o.tag}: adopt the engine ${o.tag}"`,
    );
    return ui.finish();
  }
  await git(["add", ...files]);
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
      `From ${pin.tag}. ${LOCK_FILE} pins the engine's commit at ${o.tag} and its integrity; validated: ${
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
    "push it: bun run stolos apply (pushing is the approval; hosts move to it within 15 minutes)",
    "then watch them: stolos fleet status",
  );
  return ui.finish();
}
