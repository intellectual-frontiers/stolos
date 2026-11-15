/**
 * Spec 046: a new fleet repository's files (stolos fleet init <id>).
 *
 * @module
 */
import { tsLiteral } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { assert, assertEquals, proves, test } from "@intellectual-frontiers/ifc-ts/runtime/test";
import { scaffoldFiles, scaffoldRepository } from "../src/archon/fleet/scaffold.ts";
import { ENGINE_PACKAGE, readPin } from "../src/archon/fleet/upgrade.ts";
import { FLEET_ID, initRepository } from "../src/archon/identity/fleet-init.ts";

/** A package.json's fields this test reads. */
type PackageJson = {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};

proves(
  ["059-stolos-and-archon FR-005", "096-bun-runtime FR-006"],
  "096: the scaffolded package.json pins the engine's release tarball; stolos and archon are its commands",
  () => {
    const f = scaffoldFiles("v1.2.3");
    const text = f["package.json"] ?? "";
    assertEquals(readPin(text), {
      base: "https://github.com/intellectual-frontiers/stolos/releases/download/",
      tag: "v1.2.3",
    });
    const j = JSON.parse(text) as PackageJson;
    assertEquals(
      j.dependencies[ENGINE_PACKAGE],
      "https://github.com/intellectual-frontiers/stolos/releases/download/v1.2.3/intellectual-frontiers-stolos-1.2.3.tgz",
    );
    assertEquals(j.scripts, { stolos: "bun stolos.ts", archon: "bun archon.ts" });
    assert(
      (f["stolos.ts"] ?? "").includes(`"${ENGINE_PACKAGE}/stolos/main"`) &&
        (f["archon.ts"] ?? "").includes(`"${ENGINE_PACKAGE}/archon/main"`),
    );
    assert((f[".gitignore"] ?? "").includes("node_modules/"));
    // These files and no others (bun.lock is bun install's to write, with the tarball's integrity).
    assertEquals(Object.keys(f).sort(), [
      ".gitattributes",
      ".github/workflows/compliance-impact.yml",
      ".gitignore",
      ".vscode/extensions.json",
      ".vscode/settings.json",
      "archon.ts",
      "bin/bootstrap.sh",
      "bin/bootstrap.windows.ps1",
      "package.json",
      "stolos.ts",
    ]);
  },
);

proves(
  ["046-engine-instance FR-011", "096-bun-runtime FR-006"],
  "046: scaffolding writes only missing files",
  async () => {
    const dir = await fs.makeTempDir();
    try {
      await fs.writeTextFile(path.join(dir, "package.json"), "{}\n");
      const written = await scaffoldRepository(dir, "v1.0.0");
      assert(!written.includes("package.json"));
      assertEquals(await fs.readTextFile(path.join(dir, "package.json")), "{}\n");
      assert(
        written.includes("archon.ts") &&
          written.includes("stolos.ts") &&
          written.includes(".gitignore"),
      );
      assertEquals(await scaffoldRepository(dir, "v1.0.0"), []);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

test("fleet ids are folder names and DNS labels", () => {
  for (const ok of ["fcr", "lab", "a", "home-2"]) assert(FLEET_ID.test(ok), ok);
  for (const bad of ["", "FCR", "-x", "x-", "a/b", "a.b", "1lab"]) assert(!FLEET_ID.test(bad), bad);
});

test("a new fleet goes into the nearest repository holding fleets/, else the working directory", async () => {
  const saved = proc.env.get("ARCHON_REPO");
  proc.env.delete("ARCHON_REPO");
  const dir = await fs.realPath(await fs.makeTempDir());
  try {
    await fs.mkdir(path.join(dir, "a", "b"), { recursive: true });
    assertEquals(initRepository(path.join(dir, "a", "b")), path.join(dir, "a", "b"));
    await fs.mkdir(path.join(dir, "fleets"));
    assertEquals(initRepository(path.join(dir, "a", "b")), dir);
  } finally {
    if (saved) proc.env.set("ARCHON_REPO", saved);
    await fs.remove(dir, { recursive: true });
  }
});

test("fleet files are TypeScript, not JSON: bare keys, quotes only where needed", async () => {
  const { fleetSource } = await import("../src/archon/identity/fleet-init.ts");
  assertEquals(
    tsLiteral({ id: "fcr", optIn: { "otel-ui": { enabled: true } }, keys: [], skip: undefined }),
    '{\n  id: "fcr",\n  optIn: {\n    "otel-ui": {\n      enabled: true,\n    },\n  },\n  keys: [],\n}',
  );
  const src = fleetSource({ id: "fcr", title: "T" } as Parameters<typeof fleetSource>[0]);
  assert(src.includes('  id: "fcr",') && !src.includes('"id":'), src);
});
