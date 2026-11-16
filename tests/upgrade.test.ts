/**
 * Spec 046 (Articles 9, 12, 24) and spec 096 FR-006: stolos fleet upgrade moves a fleet
 * repository to a released engine package (its tarball's URL in package.json), records its
 * integrity in bun.lock, validates every fleet, and makes one signed commit; anything else is
 * refused, and the files are put back.
 *
 * @module
 */
import { fs, path, proc, serve } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import {
  compare,
  engineRepository,
  fleetUpgrade,
  parseTag,
  readPin,
  rewriteWorkflowRefs,
  tarballUrl,
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
const RELEASES = "https://github.com/intellectual-frontiers/stolos/releases/download/";

proves(
  ["046-engine-instance FR-005b", "096-bun-runtime FR-006"],
  "046: tags, order, and the pin in package.json",
  () => {
    assertEquals(parseTag("v1.2.3"), [1, 2, 3]);
    assertEquals(parseTag("1.2.3"), undefined);
    assertEquals(parseTag("v1.2"), undefined);
    assertEquals(compare([0, 7, 0], [0, 10, 0]), -1, "numbers, not text");
    const json = packageJsonText("v0.7.0");
    const pin = readPin(json);
    assertEquals(pin, { base: RELEASES, tag: "v0.7.0" });
    assert(pin);
    assertEquals(tarballUrl("v0.7.0"), `${RELEASES}v0.7.0/intellectual-frontiers-stolos-0.7.0.tgz`);
    const moved = writePin(json, pin, "v0.8.0");
    assertEquals(
      moved,
      json.replace(
        "v0.7.0/intellectual-frontiers-stolos-0.7.0",
        "v0.8.0/intellectual-frontiers-stolos-0.8.0",
      ),
      "only the pin changes",
    );
    // Not a release's tarball: a branch, a file, mismatched versions, not JSON.
    const dep = (url: string): string =>
      JSON.stringify({ dependencies: { "@intellectual-frontiers/stolos": url } });
    assertEquals(readPin(dep("github:intellectual-frontiers/stolos#main")), undefined);
    assertEquals(
      readPin(dep(`${RELEASES}v0.7.0/intellectual-frontiers-stolos-0.8.0.tgz`)),
      undefined,
    );
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
 * The engine packed as a release is (`intellectual-frontiers-stolos-<file version>.tgz`): this
 * checkout's sources with its package.json, the version it says being `says`.
 */
async function packEngine(www: string, fileVersion: string, says: string): Promise<void> {
  const stage = await fs.makeTempDir({ prefix: "stolos-pack-" });
  try {
    const pkg = path.join(stage, "package");
    await fs.mkdir(pkg, { recursive: true });
    const own: unknown = JSON.parse(await fs.readTextFile(path.join(ENGINE, "package.json")));
    assert(typeof own === "object" && own !== null);
    await fs.writeTextFile(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "@intellectual-frontiers/stolos",
        version: says,
        type: "module",
        exports: { "./package.json": "./package.json", "./*": "./src/*.ts" },
        dependencies: Reflect.get(own, "dependencies") as unknown,
      }),
    );
    await sh(ENGINE, "cp", "-r", "src", path.join(pkg, "src"));
    const dir = path.join(www, "stolos", "releases", "download", `v${fileVersion}`);
    await fs.mkdir(dir, { recursive: true });
    await sh(
      stage,
      "tar",
      "czf",
      path.join(dir, `intellectual-frontiers-stolos-${fileVersion}.tgz`),
      "package",
    );
  } finally {
    await fs.remove(stage, { recursive: true });
  }
}

const bun = proc.which("bun");

proves(
  ["046-engine-instance FR-005b", "096-bun-runtime FR-006"],
  "096: fleet upgrade installs and locks the release, validates, and signs; refuses what is not a release",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-upgrade-" });
    const www = path.join(dir, "www");
    // A local "GitHub": this engine's release, and "v0.0.2" whose package says it is another version.
    await packEngine(www, VERSION, VERSION);
    await packEngine(www, "0.0.2", VERSION);
    const server = await serve({ port: 0 }, async (req) => {
      const file = path.join(www, decodeURIComponent(new URL(req.url).pathname));
      const body = await fs.readFile(file).catch(() => undefined);
      return body === undefined
        ? new Response("not found\n", { status: 404 })
        : new Response(new Uint8Array(body), { headers: { "content-type": "application/gzip" } });
    });
    const base = `http://127.0.0.1:${server.addr.port}/stolos/releases/download/`;
    const repo = path.join(dir, "fleet");
    try {
      // A fleet repository, pinned to an old release, with the example lab fleet.
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await sh(ENGINE, "cp", "-r", "examples/fleets/lab", path.join(repo, "fleets", "lab"));
      await fs.writeTextFile(path.join(repo, "package.json"), packageJsonText("v0.0.1", base));
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

      // Not that release: the package at "v0.0.2" says it is another version.
      assertEquals(await upgrade({ tag: "v0.0.2", repo }), 1);
      // Not a tag at all, and not on the server.
      assertEquals(await upgrade({ tag: "main", repo }), 1);
      assertEquals(await upgrade({ tag: "v9.9.9", repo }), 1);
      assertEquals(await fs.readTextFile(path.join(repo, "package.json")), pinned, "put back");
      assert(!(await fs.exists(path.join(repo, "bun.lock"))), "no lock left behind");

      // A change waiting in the tree: the upgrade must be a commit of its own.
      await fs.writeTextFile(path.join(repo, "archon.ts"), "// changed\n", { append: true });
      assertEquals(await upgrade({ tag: `v${VERSION}`, repo }), 1);
      await sh(repo, "git", "checkout", "--", "archon.ts");

      // The real thing.
      assertEquals(await upgrade({ tag: `v${VERSION}`, repo }), 0);
      assertStringIncludes(
        await fs.readTextFile(path.join(repo, "package.json")),
        tarballUrl(`v${VERSION}`, base),
      );
      const lock = await fs.readTextFile(path.join(repo, "bun.lock"));
      assertStringIncludes(lock, tarballUrl(`v${VERSION}`, base), "the lock names the tarball");
      assertStringIncludes(lock, "sha512-", "and holds its integrity");
      const log = await sh(repo, "git", "log", "-1", "--format=%s%n%B");
      assertStringIncludes(log, `stolos v${VERSION}: adopt the engine v${VERSION}`);
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

      // Back to an older version: only with --downgrade (and only to a release).
      assertEquals(await upgrade({ tag: "v0.0.2", repo }), 1);
      assertEquals(await upgrade({ tag: `v${VERSION}`, repo }), 0, "already there");
    } finally {
      await server.shutdown();
      await fs.remove(dir, { recursive: true });
    }
  },
  {
    skip: bun === undefined && "bun is not installed (fleet upgrade runs bun install)",
  },
);

proves(
  ["046-engine-instance FR-005b"],
  "046: an upgrade moves the engine's reusable workflows to the same tag as the pin",
  () => {
    const pin = { base: "https://github.com/acme/stolos/releases/download/", tag: "v0.1.0" };
    assertEquals(engineRepository(pin), "acme/stolos");
    const yml = [
      "    uses: acme/stolos/.github/workflows/fleet-e2e.yml@v0.1.0",
      "    uses: other/stolos/.github/workflows/fleet-e2e.yml@v0.1.0",
      "    uses: actions/checkout@v5",
    ].join("\n");
    assertEquals(rewriteWorkflowRefs(yml, "acme/stolos", "v0.2.0").split("\n"), [
      "    uses: acme/stolos/.github/workflows/fleet-e2e.yml@v0.2.0",
      "    uses: other/stolos/.github/workflows/fleet-e2e.yml@v0.1.0",
      "    uses: actions/checkout@v5",
    ]);
  },
);
