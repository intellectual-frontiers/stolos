/**
 * Spec 114-release-record: Stolos is one work of commons' 0026-works-versioning. Its record `release.ts`, the tool that
 * writes the version into the three files, the tag `stolos-v<version>` and commons' own check run here on a real Git
 * repository in a temporary folder, with the runtime of the test (Bun or Node).
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { runtimeCommand } from "../src/archon/install/bun.ts";
import { integrateLines } from "../src/archon/adopt/integrate.ts";
import { pairEngine } from "../src/archon/adopt/pair-service.ts";
import { LAUNCHER } from "../src/archon/capabilities/cli.ts";
import { guideUrl, PAGES } from "../src/archon/core/guides.ts";
import { bootstrapOneLiner } from "../src/archon/fleet/bootstrap.ts";
import { newestTag } from "../src/archon/fleet/releases.ts";
import { TAG, TAG_PREFIX, tagOf, VERSION, versionLine, WORK_SLUG } from "../src/archon/version.ts";
import { ENGINE_ROOT } from "./sandbox.ts";

const TOOL = path.join(ENGINE_ROOT, "tools", "version.ts");
const VERSIONS = path.join(
  ENGINE_ROOT,
  "node_modules",
  "@intellectual-frontiers",
  "commons",
  "commons",
  "ts",
  "mizan",
  "versions.ts",
);

/** Run a program with a time limit; what it said. */
async function run(argv: string[], cwd: string, env: Record<string, string> = {}) {
  return await proc.run(argv, { cwd, env, signal: AbortSignal.timeout(90_000), killAfterMs: 2000 });
}

const git = (cwd: string, ...a: string[]) =>
  run(["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false", ...a], cwd);

/** The tool of this repository, run on a repository of its own (STOLOS_VERSION_ROOT). */
const version = (root: string, ...a: string[]) =>
  run([...runtimeCommand(), TOOL, ...a], root, { STOLOS_VERSION_ROOT: root });

/** commons' check of works, run on the repository `root`. */
const versions = (root: string, ...a: string[]) =>
  run([...runtimeCommand(), VERSIONS, ...a, "--repo", root], root);

/** A Git repository holding this engine's three version files, committed. */
async function work(dir: string): Promise<void> {
  for (const f of ["src/archon/version.ts", "package.json", "release.ts"]) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeTextFile(path.join(dir, f), await fs.readTextFile(path.join(ENGINE_ROOT, f)));
  }
  for (const c of [
    ["init", "-q", "-b", "main"],
    ["config", "user.name", "test"],
    ["config", "user.email", "test@example.invalid"],
    ["add", "-A"],
    ["commit", "-q", "-m", "base"],
    ["tag", "base"],
  ]) {
    const r = await git(dir, ...c);
    assertEquals(r.code, 0, r.stderr);
  }
}

proves(
  ["114-release-record FR-001", "114-release-record FR-003"],
  "114: release.ts is the one work's record, commons decodes it and the version is 0.150.0 or later",
  async () => {
    const text = await fs.readTextFile(path.join(ENGINE_ROOT, "release.ts"));
    assertEquals(text.split("\n").filter((l) => /^export\s/.test(l)).length, 1);
    for (const w of [
      'slug: "stolos"',
      'kind: "Software"',
      `version: "${VERSION}"`,
      '"out"',
      '"test-results"',
    ])
      assertStringIncludes(text, w);
    const dir = await fs.makeTempDir({ prefix: "stolos-release-" });
    try {
      await work(dir);
      const r = await versions(dir, "check", "--base", "base");
      assertEquals(r.code, 0, r.stderr + r.stdout);
      assertStringIncludes(r.stdout, "1 work judged");
      assertStringIncludes(r.stdout, "nothing found");
      // a record that does not decode is found
      await fs.writeTextFile(
        path.join(dir, "release.ts"),
        text.replace('kind: "Software"', 'kind: "Nonsense"'),
      );
      await git(dir, "commit", "-q", "-am", "bad record");
      const bad = await versions(dir, "check", "--base", "base");
      assertEquals(bad.code, 1, bad.stdout);
      assertStringIncludes(bad.stdout + bad.stderr, "record-invalid");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
    const [maj = 0, min = 0] = VERSION.split(".").map(Number);
    assert(maj > 0 || min >= 150, `the first version is 0.150.0, not ${VERSION}`);
  },
  { timeout: 180_000 },
);

proves(
  ["114-release-record FR-002"],
  "114: bun run version bump, set and sync write the three files (release.ts by its version line only), and check holds that they agree and grew",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "stolos-version-" });
    try {
      await work(dir);
      const before = await fs.readTextFile(path.join(dir, "release.ts"));
      const same = await version(dir, "check", "base");
      assertEquals(same.code, 1, "not newer than the base");
      assertStringIncludes(same.stderr, "is not newer");
      const bumped = await version(dir, "bump");
      assertEquals(bumped.code, 0, bumped.stderr);
      const [maj = 0, min = 0] = VERSION.split(".").map(Number);
      const next = `${maj}.${min + 1}.0`;
      assertEquals(bumped.stdout.trim(), next);
      const after = await fs.readTextFile(path.join(dir, "release.ts"));
      assertEquals(
        after,
        before.replace(`version: "${VERSION}"`, `version: "${next}"`),
        "one line",
      );
      assertStringIncludes(
        await fs.readTextFile(path.join(dir, "package.json")),
        `"version": "${next}"`,
      );
      assertStringIncludes(
        await fs.readTextFile(path.join(dir, "src/archon/version.ts")),
        `"${next}"`,
      );
      const ok = await version(dir, "check", "base");
      assertEquals(ok.code, 0, ok.stderr);
      assertStringIncludes(ok.stdout, tagOf(next));
      // the record alone differs: found, and sync repairs it
      await fs.writeTextFile(path.join(dir, "release.ts"), before);
      const off = await version(dir, "check", "base");
      assertEquals(off.code, 1);
      assertStringIncludes(off.stderr, "release.ts 0.150.0");
      assertEquals((await version(dir, "sync")).code, 0);
      assertEquals((await version(dir, "check", "base")).code, 0);
      // set
      assertEquals((await version(dir, "set", "0.150.0")).stdout.trim(), "0.150.0");
      assertEquals(await fs.readTextFile(path.join(dir, "release.ts")), before);
      assertEquals((await version(dir, "set", "0.150")).code, 2);
      assertEquals((await version(dir, "set", "v0.150.0")).code, 2);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  { timeout: 180_000 },
);

proves(
  ["114-release-record FR-008"],
  "114: commons' versions check fails where the files of the work changed and the version did not grow, and passes once the tool raised it",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "stolos-grow-" });
    try {
      await work(dir);
      await fs.writeTextFile(
        path.join(dir, "package.json"),
        '{"name":"x","version":"0.150.0","changed":true}\n',
      );
      await git(dir, "commit", "-q", "-am", "a change, no new version");
      const stuck = await versions(dir, "check", "--base", "base");
      assertEquals(stuck.code, 1, stuck.stdout);
      assertStringIncludes(stuck.stdout + stuck.stderr, "not-grown");
      assertEquals((await version(dir, "bump")).code, 0);
      await git(dir, "commit", "-q", "-am", "the version grew");
      const grown = await versions(dir, "check", "--base", "base");
      assertEquals(grown.code, 0, grown.stdout + grown.stderr);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
    const ci = await fs.readTextFile(path.join(ENGINE_ROOT, ".github/workflows/ci.yml"));
    assertStringIncludes(ci, "mizan/versions.ts check");
    const pkg = await fs.readTextFile(path.join(ENGINE_ROOT, "package.json"));
    assertStringIncludes(pkg, '"versions:check"');
    assertStringIncludes(pkg, "&& bun run versions:check");
  },
  { timeout: 180_000 },
);

proves(
  ["114-release-record FR-004"],
  "114: a release is the annotated tag stolos-v<version> with the commit and the tree in its message, made by commons' versions tag",
  async () => {
    assertEquals(TAG_PREFIX, "stolos-v");
    assertEquals(TAG, `stolos-v${VERSION}`);
    const dir = await fs.makeTempDir({ prefix: "stolos-tag-" });
    try {
      await work(dir);
      const r = await versions(dir, "tag", "stolos");
      assertEquals(r.code, 0, r.stderr + r.stdout);
      assertEquals((await git(dir, "cat-file", "-t", TAG)).stdout.trim(), "tag", "annotated");
      const msg = (await git(dir, "tag", "-n9", TAG)).stdout;
      const head = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
      const tree = (await git(dir, "rev-parse", "HEAD^{tree}")).stdout.trim();
      assertStringIncludes(msg, `commit: ${head}`);
      assertStringIncludes(msg, `tree: ${tree}`);
      const again = await versions(dir, "tag", "stolos");
      assertEquals(again.code, 1, "a published version is immutable");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
    const ci = await fs.readTextFile(path.join(ENGINE_ROOT, ".github/workflows/ci.yml"));
    assertStringIncludes(ci, 'TAG="$(bun tools/version.ts tag)"');
    assertStringIncludes(ci, "mizan/versions.ts tag ");
  },
  { timeout: 180_000 },
);

proves(
  ["114-release-record FR-005"],
  "114: every writer of the tag says stolos-v<version>: the one-liners, the pairing, the launcher, the docs site",
  async () => {
    assertStringIncludes(bootstrapOneLiner("posix", "example/fleet"), `/${TAG}/bin/bootstrap.sh`);
    assertStringIncludes(
      bootstrapOneLiner("windows", "example/fleet"),
      `/${TAG}/bin/bootstrap.windows.ps1`,
    );
    assertEquals(pairEngine(), TAG);
    const lines = await integrateLines({ as: ["discover"], fleet: "lab" });
    assertStringIncludes(lines.posix, `/${TAG}/bin/integrate.sh`);
    assertStringIncludes(lines.posix, `--engine ${TAG}`);
    assertStringIncludes(LAUNCHER, "\\(stolos-v[0-9][0-9.]*\\)");
    assertEquals(guideUrl("fleet").startsWith(`${PAGES}${TAG}/`), true);
  },
);

proves(
  ["114-release-record FR-006", "114-release-record FR-010"],
  "114: only stolos-v tags are releases: v0.x and other tags are ignored",
  () => {
    const ls = [
      "a\trefs/tags/v0.999.0",
      "b\trefs/tags/stolos-v0.150.0",
      "c\trefs/tags/stolos-v0.151.0",
      "d\trefs/tags/ifc-ts-v9.0.0",
      "e\trefs/tags/stolos-v0.151.0-rc1",
    ].join("\n");
    assertEquals(newestTag(ls), "stolos-v0.151.0");
    assertEquals(newestTag("a\trefs/tags/v0.999.0"), undefined);
  },
);

proves(
  ["114-release-record FR-010", "114-release-record FR-011"],
  "114: the guide and AGENTS.md say one work, release.ts, stolos-v<version>, both checks, bun run version bump and the first release",
  async () => {
    const guide = await fs.readTextFile(path.join(ENGINE_ROOT, "src/releasing.ts"));
    const agents = await fs.readTextFile(path.join(ENGINE_ROOT, "AGENTS.md"));
    for (const w of [
      "release.ts",
      "stolos-v<version>",
      "version bump",
      "versions:check",
      "0.150.0",
    ])
      assertStringIncludes(guide, w);
    for (const w of ["release.ts", "stolos-v<version>", "version bump", "versions:check"])
      assertStringIncludes(agents, w);
    assert(!/#v<version>/.test(guide + agents), "no pin in the old spelling");
  },
);

proves(
  ["114-release-record FR-013"],
  "114: the slug and the tag form are written once: the record, the tool and the workflows agree with src/archon/version.ts",
  async () => {
    assertEquals(WORK_SLUG, "stolos");
    assertEquals(TAG_PREFIX, `${WORK_SLUG}-v`);
    assertStringIncludes(
      await fs.readTextFile(path.join(ENGINE_ROOT, "release.ts")),
      `slug: "${WORK_SLUG}",`,
    );
    const dir = await fs.makeTempDir({ prefix: "stolos-slug-" });
    try {
      await work(dir);
      assertEquals((await version(dir, "slug")).stdout.trim(), WORK_SLUG);
      assertEquals((await version(dir, "tag")).stdout.trim(), TAG);
      const rec = await fs.readTextFile(path.join(dir, "release.ts"));
      await fs.writeTextFile(
        path.join(dir, "release.ts"),
        rec.replace(`slug: "${WORK_SLUG}"`, 'slug: "other"'),
      );
      const bad = await version(dir, "check", "base");
      assertEquals(bad.code, 1);
      assertStringIncludes(bad.stderr, "does not name the work");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
    const ci = await fs.readTextFile(path.join(ENGINE_ROOT, ".github/workflows/ci.yml"));
    assertStringIncludes(ci, 'TAG="$(bun tools/version.ts tag)"');
    assertStringIncludes(ci, 'versions.ts tag "$(bun tools/version.ts slug)"');
    assertStringIncludes(ci, `ls -d ../pages/${TAG_PREFIX}*/`);
    const e2e = await fs.readTextFile(path.join(ENGINE_ROOT, ".github/workflows/fleet-e2e.yml"));
    assertStringIncludes(e2e, `#${TAG_PREFIX}[0-9]+`);
  },
  { timeout: 180_000 },
);

proves(
  ["114-release-record FR-014"],
  "114: archon --version and stolos --version print <version> (engine stolos-v<version>) on this runtime",
  async () => {
    assertEquals(versionLine(), `${VERSION} (engine stolos-v${VERSION})`);
    const dir = await fs.makeTempDir({ prefix: "stolos-vline-" });
    try {
      for (const entry of ["archon", "stolos"]) {
        const file = path.join(dir, `${entry}.ts`);
        const main = path.toFileUrl(path.join(ENGINE_ROOT, "src", entry, "main.ts")).href;
        await fs.writeTextFile(file, `import { run } from "${main}";\n\nawait run();\n`);
        const r = await run([...runtimeCommand(), file, "--version"], dir);
        assertEquals(r.stdout.trim(), versionLine(), `${entry}: ${r.stderr}`);
      }
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  { timeout: 180_000 },
);
