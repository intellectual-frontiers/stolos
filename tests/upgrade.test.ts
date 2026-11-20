/**
 * Spec 046 (Articles 9, 12, 24) and spec 096 FR-006: stolos fleet upgrade moves a fleet
 * repository to another version of the engine (its tag, after `#` in the Git dependency of
 * package.json), pins that tag's commit in bun.lock, validates every fleet, and makes one signed
 * commit; anything else is refused, and the files are put back.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import {
  compare,
  engineDependency,
  engineRepository,
  fleetUpgrade,
  parseTag,
  readPin,
  rewriteWorkflowRefs,
  writePin,
} from "../src/archon/fleet/upgrade.ts";
import { packageJsonText } from "../src/archon/fleet/scaffold.ts";
import { VERSION } from "../src/archon/version.ts";
import { ui } from "../src/archon/core/ui.ts";

/** One run, as from the command line (the ui's problems are per run). */
const upgrade = (o: Parameters<typeof fleetUpgrade>[0]): Promise<number> => {
  ui.problems.length = 0;
  return fleetUpgrade(o);
};

const ENGINE = path.fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const SOURCE = "github:intellectual-frontiers/stolos";

proves(
  [
    "046-engine-instance FR-005b",
    "096-bun-runtime FR-006",
    "114-release-record FR-005",
    "114-release-record FR-010",
  ],
  "046: tags, order, and the pin in package.json (only the stolos-v spelling)",
  () => {
    assertEquals(parseTag("stolos-v1.2.3"), [1, 2, 3]);
    assertEquals(parseTag("1.2.3"), undefined);
    assertEquals(parseTag("v1.2.3"), undefined, "the old spelling is no tag");
    assertEquals(parseTag("stolos-v1.2"), undefined);
    assertEquals(compare([0, 7, 0], [0, 10, 0]), -1, "numbers, not text");
    const json = packageJsonText("stolos-v0.7.0");
    const pin = readPin(json);
    assertEquals(pin, { source: SOURCE, tag: "stolos-v0.7.0" });
    assert(pin);
    assertEquals(engineDependency("stolos-v0.7.0"), `${SOURCE}#stolos-v0.7.0`);
    const moved = writePin(json, pin, "stolos-v0.8.0");
    assertEquals(
      moved,
      json.replace(`${SOURCE}#stolos-v0.7.0`, `${SOURCE}#stolos-v0.8.0`),
      "only the pin changes",
    );
    // A mirror or a local copy, by a git+ URL at a tag, is a pin too.
    const dep = (spec: string): string =>
      JSON.stringify({ dependencies: { "@intellectual-frontiers/stolos": spec } });
    assertEquals(readPin(dep("git+file:///srv/stolos#stolos-v0.7.0")), {
      source: "git+file:///srv/stolos",
      tag: "stolos-v0.7.0",
    });
    // Not a Git dependency at a version tag: a branch, a commit, a tarball's URL, not JSON.
    assertEquals(readPin(dep(`${SOURCE}#main`)), undefined);
    assertEquals(readPin(dep(`${SOURCE}#0123456789abcdef0123456789abcdef01234567`)), undefined);
    assertEquals(
      readPin(
        dep(
          "https://github.com/intellectual-frontiers/stolos/releases/download/v0.7.0/intellectual-frontiers-stolos-0.7.0.tgz",
        ),
      ),
      undefined,
    );
    assertEquals(readPin(dep(`${SOURCE}#v0.7.0`)), undefined, "the old spelling is no pin");
    assertEquals(readPin(dep("git+file:///srv/stolos#v0.7.0")), undefined);
    assertEquals(readPin("{}"), undefined);
    assertEquals(readPin("not json"), undefined);
  },
);

/** Runs a program, or throws with what it said. */
const sh = async (cwd: string, ...a: string[]): Promise<string> => {
  const r = await proc.run(a, { cwd });
  if (!r.success) throw new Error(`${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/**
 * The engine as a fleet fetches it, in a local Git repository: this checkout's sources with its
 * package.json saying `says`, one commit, tagged with each of `tags`. Its commit.
 */
async function engineRepo(dir: string, says: string, tags: readonly string[]): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const own: unknown = JSON.parse(await fs.readTextFile(path.join(ENGINE, "package.json")));
  assert(typeof own === "object" && own !== null);
  await fs.writeTextFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "@intellectual-frontiers/stolos",
      version: says,
      type: "module",
      exports: { "./package.json": "./package.json", "./*": "./src/*.ts" },
      dependencies: Reflect.get(own, "dependencies") as unknown,
    }),
  );
  await sh(ENGINE, "cp", "-r", "src", path.join(dir, "src"));
  await sh(dir, "git", "init", "-q", "-b", "main");
  await sh(dir, "git", "add", "-A");
  await sh(
    dir,
    "git",
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-q",
    "--no-gpg-sign",
    "-m",
    "engine",
  );
  for (const t of tags) await sh(dir, "git", "tag", t);
  return await sh(dir, "git", "rev-parse", "HEAD");
}

const bun = proc.which("bun");

proves(
  ["046-engine-instance FR-005b", "096-bun-runtime FR-006", "114-release-record FR-007"],
  "096: fleet upgrade moves the Git dependency's tag, locks its commit, validates, and signs; refuses what is not that version",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-upgrade-" });
    // A local copy of the engine's repository: this version's tag, and "stolos-v0.0.2", a tag whose
    // package says it is another version.
    const engine = path.join(dir, "stolos");
    const commit = await engineRepo(engine, VERSION, [`stolos-v${VERSION}`, "stolos-v0.0.2"]);
    const source = `git+${path.toFileUrl(engine).href}`;
    const repo = path.join(dir, "fleet");
    try {
      // A fleet repository, pinned to an old version, with the example lab fleet.
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await sh(ENGINE, "cp", "-r", "examples/fleets/lab", path.join(repo, "fleets", "lab"));
      await fs.writeTextFile(
        path.join(repo, "package.json"),
        packageJsonText("stolos-v0.0.1", source),
      );
      await fs.writeTextFile(
        path.join(repo, "archon.ts"),
        'import { run } from "@intellectual-frontiers/stolos/archon/main";\n\nawait run();\n',
      );
      await fs.writeTextFile(
        path.join(repo, "stolos.ts"),
        'import { run } from "@intellectual-frontiers/stolos/stolos/main";\n\nawait run();\n',
      );
      await fs.writeTextFile(path.join(repo, ".gitignore"), "node_modules/\n");
      const key = path.join(dir, "key");
      await sh(dir, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", key);
      await sh(repo, "git", "init", "-q", "-b", "main");
      for (const [k, v] of [
        ["user.name", "test"],
        ["user.email", "test@example.invalid"],
        ["gpg.format", "ssh"],
        ["gpg.ssh.program", "ssh-keygen"],
        ["user.signingkey", key],
      ] as const) {
        await sh(repo, "git", "config", k, v);
      }
      await sh(repo, "git", "add", "-A");
      await sh(repo, "git", "commit", "-q", "--no-gpg-sign", "-m", "start");
      const pinned = await fs.readTextFile(path.join(repo, "package.json"));

      // Not that version: the package at "stolos-v0.0.2" says it is another version.
      assertEquals(await upgrade({ tag: "stolos-v0.0.2", repo }), 1);
      // Not a tag at all, and not a tag of the engine's repository.
      assertEquals(await upgrade({ tag: "main", repo }), 1);
      assertEquals(await upgrade({ tag: "stolos-v9.9.9", repo }), 1);
      assertEquals(await upgrade({ tag: `v${VERSION}`, repo }), 1, "the old spelling is refused");
      assertEquals(await fs.readTextFile(path.join(repo, "package.json")), pinned, "put back");
      assert(!(await fs.exists(path.join(repo, "bun.lock"))), "no lock left behind");

      // A change waiting in the tree: the upgrade must be a commit of its own.
      await fs.writeTextFile(path.join(repo, "archon.ts"), "// changed\n", { append: true });
      assertEquals(await upgrade({ tag: `stolos-v${VERSION}`, repo }), 1);
      await sh(repo, "git", "checkout", "--", "archon.ts");

      // The real thing.
      assertEquals(await upgrade({ tag: `stolos-v${VERSION}`, repo }), 0);
      assertStringIncludes(
        await fs.readTextFile(path.join(repo, "package.json")),
        engineDependency(`stolos-v${VERSION}`, source),
      );
      const lock = await fs.readTextFile(path.join(repo, "bun.lock"));
      assertStringIncludes(
        lock,
        engineDependency(`stolos-v${VERSION}`, source),
        "the lock names the tag",
      );
      assertStringIncludes(lock, commit, "and pins the commit it names");
      const log = await sh(repo, "git", "log", "-1", "--format=%s%n%B");
      assertStringIncludes(log, `stolos: adopt the engine stolos-v${VERSION}`);
      assertStringIncludes(
        await sh(repo, "git", "cat-file", "commit", "HEAD"),
        "BEGIN SSH SIGNATURE",
      );
      assertEquals(await sh(repo, "git", "status", "--porcelain"), "", "nothing left over");
      assertEquals(
        (await sh(repo, "git", "show", "--name-only", "--format=", "HEAD")).split("\n").sort(),
        // Spec 062: the bootstrap scripts and .gitattributes come with the engine;
        // spec 074: the compliance-impact workflow too.
        [
          ".gitattributes",
          ".github/workflows/compliance-impact.yml",
          "bin/bootstrap.sh",
          "bin/bootstrap.windows.ps1",
          "bun.lock",
          "package.json",
        ],
      );
      assertStringIncludes(
        await sh(repo, "git", "ls-files", "-s", "bin/bootstrap.sh"),
        "100755",
        "bootstrap.sh is executable on every system",
      );

      // Back to an older version: only with --downgrade (and only to that version).
      assertEquals(await upgrade({ tag: "stolos-v0.0.2", repo }), 1);
      assertEquals(await upgrade({ tag: `stolos-v${VERSION}`, repo }), 0, "already there");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  {
    skip: bun === undefined && "bun is not installed (fleet upgrade runs bun install)",
  },
);

proves(
  ["046-engine-instance FR-005b", "114-release-record FR-005"],
  "046: an upgrade moves the engine's reusable workflows to the same tag as the pin",
  () => {
    const pin = { source: "github:acme/stolos", tag: "stolos-v0.1.0" };
    assertEquals(engineRepository(pin), "acme/stolos");
    assertEquals(
      engineRepository({ source: "git+file:///srv/stolos", tag: "stolos-v0.1.0" }),
      undefined,
    );
    const yml = [
      "    uses: acme/stolos/.github/workflows/fleet-e2e.yml@stolos-v0.1.0",
      "    uses: other/stolos/.github/workflows/fleet-e2e.yml@stolos-v0.1.0",
      "    uses: actions/checkout@v5",
    ].join("\n");
    assertEquals(rewriteWorkflowRefs(yml, "acme/stolos", "stolos-v0.2.0").split("\n"), [
      "    uses: acme/stolos/.github/workflows/fleet-e2e.yml@stolos-v0.2.0",
      "    uses: other/stolos/.github/workflows/fleet-e2e.yml@stolos-v0.1.0",
      "    uses: actions/checkout@v5",
    ]);
    const old = "    uses: acme/stolos/.github/workflows/fleet-e2e.yml@v0.1.0";
    assertEquals(
      rewriteWorkflowRefs(old, "acme/stolos", "stolos-v0.2.0"),
      old,
      "not the old spelling",
    );
  },
);
