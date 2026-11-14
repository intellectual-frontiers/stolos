// Spec 046: a new fleet repository's files (stolos fleet init <id>).
import { assert, assertEquals } from "./assert.ts";
import { join } from "../src/archon/core/path.ts";
import { scaffoldFiles, scaffoldRepository } from "../src/archon/fleet/scaffold.ts";
import { ENGINE_ENTRY_TEXT, readPin } from "../src/archon/fleet/upgrade.ts";
import { FLEET_ID, initRepository } from "../src/archon/identity/fleet-init.ts";

Deno.test("the scaffolded deno.json is a pin fleet upgrade can read, and runs frozen", () => {
  const f = scaffoldFiles("v1.2.3");
  const pin = readPin(f["deno.json"]);
  assertEquals(pin?.tag, "v1.2.3");
  const j = JSON.parse(f["deno.json"]);
  assertEquals(Object.keys(j.tasks), ["stolos"], "one command on your PC (spec 059)");
  assert(j.tasks.stolos.includes("--frozen") && j.tasks.stolos.includes("stolos.ts"));
  assert(
    f["stolos.ts"].includes("@stolos/stolos/main.ts") && f["archon.ts"].includes("archon/main.ts"),
  );
  assertEquals(f["engine.ts"], ENGINE_ENTRY_TEXT);
  // VS Code: Deno checks and formats on save; Deno is the suggested extension.
  const vs = JSON.parse(f[".vscode/settings.json"]);
  assert(vs["deno.enable"] && vs["editor.formatOnSave"]);
  assertEquals(vs["[markdown]"]["editor.defaultFormatter"], "denoland.vscode-deno");
  assert(JSON.parse(f[".vscode/extensions.json"]).recommendations.includes("denoland.vscode-deno"));
});

Deno.test("scaffolding writes only missing files", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    const written = await scaffoldRepository(dir, "v1.0.0");
    assert(!written.includes("deno.json"));
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), "{}\n");
    assert(written.includes("archon.ts") && written.includes(".gitignore"));
    assertEquals(await scaffoldRepository(dir, "v1.0.0"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fleet ids are folder names and DNS labels", () => {
  for (const ok of ["fcr", "lab", "a", "home-2"]) assert(FLEET_ID.test(ok), ok);
  for (const bad of ["", "FCR", "-x", "x-", "a/b", "a.b", "1lab"]) assert(!FLEET_ID.test(bad), bad);
});

Deno.test("a new fleet goes into the nearest repository holding fleets/, else the working directory", async () => {
  const saved = Deno.env.get("ARCHON_REPO");
  Deno.env.delete("ARCHON_REPO");
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.mkdir(join(dir, "a", "b"), { recursive: true });
    assertEquals(initRepository(join(dir, "a", "b")), join(dir, "a", "b"));
    await Deno.mkdir(join(dir, "fleets"));
    assertEquals(initRepository(join(dir, "a", "b")), dir);
  } finally {
    if (saved) Deno.env.set("ARCHON_REPO", saved);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fleet files are TypeScript, not JSON: bare keys, quotes only where needed", async () => {
  const { tsLiteral } = await import("../src/archon/core/ts-literal.ts");
  const { fleetSource } = await import("../src/archon/identity/fleet-init.ts");
  assertEquals(
    tsLiteral({ id: "fcr", optIn: { "otel-ui": { enabled: true } }, keys: [], skip: undefined }),
    '{\n  id: "fcr",\n  optIn: {\n    "otel-ui": {\n      enabled: true,\n    },\n  },\n  keys: [],\n}',
  );
  const src = fleetSource({ id: "fcr", title: "T" } as never);
  assert(src.includes('  id: "fcr",') && !src.includes('"id":'), src);
});
