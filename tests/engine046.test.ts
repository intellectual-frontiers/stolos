/**
 * Spec 046: the engine and the instance. Where the two roots and the fleet resolve, the layout of a
 * fleet, the engine's own files as a module, the entry files a fleet repository runs, the engine
 * installed whole as bun.lock holds it, and per-fleet secrets.
 *
 * @module
 */
import { fs, path, proc, serve } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { engineFile, engineFiles, engineSpecs } from "../src/archon/core/assets.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";
import { fleet, host } from "./fixtures.ts";

/** A fleet repository in a sandbox (the example lab as fleet `lab`), and a script that reports paths. */
async function instance() {
  const sb = await sandbox("archon-engine046-");
  const repo = path.join(sb.home, "fleet");
  await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
  await proc.output([
    "cp",
    "-r",
    path.join(ENGINE_ROOT, "examples/fleets/lab"),
    `${repo}/fleets/lab`,
  ]);
  await linkEngine(repo);
  // Imported as a fleet repository imports the engine: by its package name.
  const where = path.join(repo, "where.ts");
  await fs.writeTextFile(
    where,
    `import { ENGINE_ROOT, findFleetId, findInstanceRoot, P } from "@intellectual-frontiers/stolos/archon/core/paths";
const [cwd] = process.argv.slice(2);
if (cwd) process.chdir(cwd);
const root = findInstanceRoot();
console.log(JSON.stringify({ engine: ENGINE_ROOT, root, fleet: findFleetId(root), secrets: P.secrets, out: P.out, hosts: P.hosts }));
`,
  );
  const report = async (env: Record<string, string>, cwd = "") => {
    const r = await sb.run(where, cwd ? [cwd] : [], "", env);
    assertEquals(r.code, 0, r.out);
    const j: unknown = JSON.parse(r.out.trim().split("\n").pop() ?? "{}");
    return j as {
      engine: string;
      root: string;
      fleet: string;
      secrets: string;
      out: string;
      hosts: string;
    };
  };
  return { sb, repo, report };
}

/** What a host's /etc and /srv hold here: this machine's own files decide some answers. */
const onAHost = async (): Promise<boolean> =>
  (await fs.exists("/etc/archon/fleet")) || (await fs.exists("/srv/archon/fleets"));

proves(
  ["046-engine-instance FR-001"],
  "046: two roots: the engine where its modules load from; the instance and the fleet in order",
  async () => {
    const { sb, repo, report } = await instance();
    try {
      // The engine's root: this checkout, also when loaded through the fleet's installed package.
      let w = await report({ ARCHON_REPO: repo });
      assertEquals(w.engine, ENGINE_ROOT);
      assertEquals(w.root, repo, "ARCHON_REPO");
      assertEquals((await report({ ARCHON_REPO: repo, ARCHON_FLEET: "other" })).fleet, "other");
      // Without ARCHON_REPO: the nearest folder above the working directory holding fleets/.
      w = await report({}, path.join(repo, "fleets", "lab", "hosts", "alpha"));
      assertEquals(w.root, repo);
      if (!(await onAHost())) {
        assertEquals(w.fleet, "lab", "the instance's only fleet");
        // Nothing above with fleets/, no /srv/archon: the engine checkout's examples/.
        w = await report({}, sb.home);
        assertEquals(w.root, path.join(ENGINE_ROOT, "examples"));
        // Two fleets and no choice: none.
        await proc.output(["cp", "-r", `${repo}/fleets/lab`, `${repo}/fleets/two`]);
        assertEquals((await report({ ARCHON_REPO: repo })).fleet, "");
      }
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

proves(
  ["046-engine-instance FR-002", "046-engine-instance FR-006"],
  "046: a fleet's layout, its id checked against its folder; out/<id>/; secrets per fleet",
  async () => {
    const { sb, repo, report } = await instance();
    try {
      const w = await report({ ARCHON_REPO: repo, ARCHON_FLEET: "lab" });
      assertEquals(w.hosts, path.join(repo, "fleets", "lab", "hosts"));
      assertEquals(w.out, path.join(repo, "out", "lab"), "rendered output: out/<id>/");
      const { GITIGNORE_TEXT } = await import("../src/archon/fleet/scaffold.ts");
      assert(GITIGNORE_TEXT.split("\n").includes("out/"), "never committed");
      // Secrets per fleet, in this user's config folder (spec 059 named the folder stolos).
      assertEquals(w.secrets, path.join(sb.home, "config", "stolos", "secrets", "lab"));
      const other = await report({ ARCHON_REPO: repo, ARCHON_FLEET: "other" });
      assertEquals(other.secrets, path.join(sb.home, "config", "stolos", "secrets", "other"));

      // The layout loads: fleet.ts, site.ts, one folder per host.
      const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab" };
      let r = await sb.run("src/stolos/main.ts", ["validate"], "", env);
      assertEquals(r.code, 0, r.out);
      // fleet.ts's id must equal its folder's name.
      const ft = path.join(repo, "fleets", "lab", "fleet.ts");
      await fs.writeTextFile(ft, (await fs.readTextFile(ft)).replace('id: "lab"', 'id: "lab2"'));
      r = await sb.run("src/stolos/main.ts", ["validate"], "", env);
      assert(r.code !== 0, r.out);
      assertStringIncludes(r.out, 'fleets/lab/fleet.ts says id "lab2": rename one to match');
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

proves(
  ["046-engine-instance FR-003"],
  "046: the engine's text files travel as src/archon/assets.auto.ts",
  async () => {
    assertStringIncludes(engineFile(".specify/memory/constitution.md"), "Article 23");
    const specs = (await fs.listDirs(path.join(ENGINE_ROOT, "specs"))).filter((d) =>
      fs.existsSync(path.join(ENGINE_ROOT, "specs", d, "spec.md")),
    );
    assertEquals(engineSpecs().sort(), specs.sort(), "every specs/*/spec.md");
    assertStringIncludes(engineFile("docs/s3.md"), "# S3 object storage");
    assert(engineFiles("home").includes("dot_bashrc.tmpl"), "the base dotfile layer");
    assertEquals(
      engineFile("src/archon/shell/archon.omp.json"),
      await fs.readTextFile(path.join(ENGINE_ROOT, "src/archon/shell/archon.omp.json")),
      "the prompt theme",
    );
  },
);

proves(
  ["046-engine-instance FR-005"],
  "046: a fleet runs the engine through archon.ts and stolos.ts; the first boot installs it frozen",
  async () => {
    const { ARCHON_ENTRY_TEXT, STOLOS_ENTRY_TEXT } =
      await import("../src/archon/fleet/scaffold.ts");
    const code = (t: string) =>
      t
        .split("\n")
        .filter((l) => l.trim() !== "" && !l.startsWith("//"))
        .join("\n");
    assertEquals(
      code(ARCHON_ENTRY_TEXT),
      'import { run } from "@intellectual-frontiers/stolos/archon/main";\nawait run();',
    );
    assertEquals(
      code(STOLOS_ENTRY_TEXT),
      'import { run } from "@intellectual-frontiers/stolos/stolos/main";\nawait run();',
    );
    const { firstBootScript, userData } = await import("../src/archon/render/autoinstall.ts");
    const s = firstBootScript(fleet(), host());
    const install = s.indexOf("(cd /srv/archon && /usr/local/bin/bun install --frozen-lockfile)");
    assert(install >= 0, s);
    const exec = s.indexOf("exec /usr/local/bin/bun /srv/archon/archon.ts first-boot --host alpha");
    assert(exec > install, "installed, then run");
    const { LAUNCHER } = await import("../src/archon/capabilities/cli.ts");
    assertStringIncludes(LAUNCHER, 'exec /usr/local/bin/bun /srv/archon/archon.ts "$@"');
    // Node runs it with commons' hook, by its file: --import resolves from the working folder.
    assertStringIncludes(
      LAUNCHER,
      'exec node --import /srv/archon/node_modules/@intellectual-frontiers/commons/commons/ts/node/register.mjs /srv/archon/archon.ts "$@"',
    );
    const ud = userData(
      { fleet: fleet(), host: host(), base: "http://10.0.1.157:8080/i/", traceparent: "" },
      { passwordHash: "x" },
    );
    assert(
      /"path": "\/etc\/archon\/fleet",\s+"content": "lab\\n"/.test(ud),
      "the install writes /etc/archon/fleet",
    );
    // `stolos boot <sub>` is the boot server, in the same process.
    const sb = await sandbox("archon-entry-");
    try {
      const r = await sb.run("src/stolos/main.ts", ["boot", "help"], "", {
        ARCHON_REPO: path.join(ENGINE_ROOT, "examples"),
      });
      assertStringIncludes(r.out, "boot retire <host>");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

proves(
  ["046-engine-instance FR-005a"],
  "046: the engine is installed as bun.lock holds it, or not at all (E046-LOCK-INTEGRITY)",
  async () => {
    const { packageJsonText, installEngine } = await import("../src/archon/fleet/scaffold.ts");
    const { ENGINE_PACKAGE } = await import("../src/archon/fleet/upgrade.ts");
    const pkg: unknown = JSON.parse(packageJsonText("stolos-v1.2.3"));
    const deps = (pkg as { dependencies: Record<string, string> }).dependencies;
    assertEquals(Object.keys(deps), [ENGINE_PACKAGE]);
    assertEquals(deps[ENGINE_PACKAGE], "github:intellectual-frontiers/stolos#stolos-v1.2.3");

    // Bun fetches a github: dependency as its commit's archive and checks it against the integrity
    // bun.lock holds; the same check, on an archive served on 127.0.0.1 that then changes.
    const dir = await fs.makeTempDir({ prefix: "archon-lock-" });
    const tarball = async (body: string): Promise<Uint8Array> => {
      await fs.mkdir(path.join(dir, "pkg", "package"), { recursive: true });
      await fs.writeTextFile(
        path.join(dir, "pkg", "package", "package.json"),
        '{"name":"demo-engine","version":"1.0.0","type":"module"}\n',
      );
      await fs.writeTextFile(path.join(dir, "pkg", "package", "index.js"), body);
      await proc.output([
        "tar",
        "-czf",
        path.join(dir, "demo.tgz"),
        "-C",
        path.join(dir, "pkg"),
        "package",
      ]);
      return await fs.readFile(path.join(dir, "demo.tgz"));
    };
    let served = await tarball("export const a = 1;\n");
    const stop = new AbortController();
    const server = await serve(
      { port: 0, hostname: "127.0.0.1", signal: stop.signal },
      () => new Response(served.slice(), { headers: { "content-type": "application/gzip" } }),
    );
    const saved = ["BUN_INSTALL_CACHE_DIR", "NO_PROXY", "no_proxy"].map(
      (k) => [k, proc.env.get(k)] as const,
    );
    try {
      proc.env.set("NO_PROXY", "127.0.0.1");
      proc.env.set("no_proxy", "127.0.0.1");
      const repo = path.join(dir, "repo");
      await fs.mkdir(repo);
      await fs.writeTextFile(
        path.join(repo, "package.json"),
        JSON.stringify({
          name: "fleet",
          private: true,
          dependencies: { "demo-engine": `http://127.0.0.1:${server.addr.port}/demo.tgz` },
        }),
      );
      const { installDependencies } = await import("../src/archon/install/bun.ts");
      proc.env.set("BUN_INSTALL_CACHE_DIR", path.join(dir, "cache1"));
      const first = await installDependencies(repo, { frozen: false });
      assert(first.ok, first.stderr);
      assertStringIncludes(await fs.readTextFile(path.join(repo, "bun.lock")), "sha512-");
      // As the lock holds it: installed.
      await fs.remove(path.join(repo, "node_modules"), { recursive: true });
      assertEquals(await installEngine(repo), { ok: true });

      served = await tarball("export const a = 2;\n");
      await fs.remove(path.join(repo, "node_modules"), { recursive: true });
      proc.env.set("BUN_INSTALL_CACHE_DIR", path.join(dir, "cache2"));
      const r = await installEngine(repo);
      assertEquals(r.ok, false);
      assert(/integrity|checksum|mismatch/i.test(r.why ?? ""), r.why);
      assert(!(await fs.exists(path.join(repo, "node_modules", "demo-engine", "index.js"))));
      const { EXPLAIN } = await import("../src/archon/core/explain.ts");
      assert(EXPLAIN["E046-LOCK-INTEGRITY"] !== undefined, "the code is explained");
    } finally {
      for (const [k, v] of saved) v === undefined ? proc.env.delete(k) : proc.env.set(k, v);
      stop.abort();
      await server.finished;
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["046-engine-instance FR-009"],
  "046: the agent layer is MCP only: no agent is installed on a workstation",
  async () => {
    const { resolvePlan } = await import("../src/archon/model/resolve.ts");
    const ws = host({
      name: "pc",
      kind: "workstation",
      user: "alice",
      mac: undefined,
      disk: undefined,
    });
    const plan = resolvePlan(ws, fleet());
    const names = [...plan.packages.map((p) => p.name), ...plan.tools.map((t) => t.id)].join(" ");
    for (const agent of ["claude", "codex", "gemini", "copilot", "cursor", "aider"]) {
      assert(!new RegExp(`\\b${agent}`, "i").test(names), `${agent} installed on a workstation`);
    }
  },
);
