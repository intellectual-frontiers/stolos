// Spec 046: a new fleet repository's files (archon fleet init <id>).
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
  assert(j.tasks.archon.includes("--frozen"));
  assert(j.tasks.boot.includes("--frozen"));
  assert(j.tasks.boot.includes("OTEL_DENO=true"));
  assertEquals(f["engine.ts"], ENGINE_ENTRY_TEXT);
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
