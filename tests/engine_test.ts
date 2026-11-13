// Spec 046-engine-instance: the engine holds no fleet's facts, travels as
// modules (`@stolos/` from GitHub), names no particular agent, and keeps its
// version in TypeScript.

import { assert, assertEquals } from "./assert.ts";
import { VERSION } from "../src/archon/version.ts";

const ROOT = new URL("..", import.meta.url).pathname;

async function tracked(): Promise<string[]> {
  const r = await new Deno.Command("git", {
    args: ["-C", ROOT, "ls-files", "-co", "--exclude-standard"],
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(r.stdout).split("\n").filter(Boolean);
}

// Words that would only be in the engine if a real fleet's facts leaked into
// it. Kept as base64 so this file does not match itself.
const LEAKS = ["ZmNyLm5ldHdvcms=", "ZXJnYS5meWk=", "c25zaGFo", "ZmFsbGluZ2NyZWVr", "NDc0OTc="]
  .map((b) => atob(b));

Deno.test("046: no fleet's facts in the engine", async () => {
  const hits: string[] = [];
  for (const f of await tracked()) {
    if (!/\.(ts|md|json|sh|tmpl|toml|yaml|yml|txt)$/.test(f)) continue;
    const text = (await Deno.readTextFile(ROOT + f)).toLowerCase();
    for (const w of LEAKS) if (text.includes(w)) hits.push(`${f}: ${w}`);
  }
  assertEquals(hits, []);
});

Deno.test("046: the engine imports only full specifiers (it is loaded by URL)", async () => {
  const bad: string[] = [];
  for (const f of await tracked()) {
    if (!f.startsWith("src/") || !f.endsWith(".ts")) continue;
    const lines = (await Deno.readTextFile(ROOT + f)).split("\n");
    let inTemplate = false; // lines inside a template literal are generated text, not imports
    lines.forEach((l, i) => {
      const quoted = inTemplate;
      inTemplate = ((l.match(/(?<!\\)`/g) ?? []).length % 2 === 1) !== inTemplate;
      if (quoted) return;
      const m = l.match(/^(?:import|export)\s.*\sfrom\s+"([^"]+)"/) ??
        l.match(/\bimport\(\s*"([^"]+)"\s*\)/);
      if (m && !/^(\.|npm:|jsr:|node:|https:)/.test(m[1])) bad.push(`${f}:${i + 1} ${m[1]}`);
      if (m && /(^|\/)(fleets|examples)\//.test(m[1])) bad.push(`${f}:${i + 1} ${m[1]}`);
    });
  }
  assertEquals(bad, []);
});

Deno.test("046: fleets hold TypeScript, not JSON", async () => {
  const bad = (await tracked()).filter((f) => /(^|\/)fleets\//.test(f) && /\.json5?$/.test(f));
  assertEquals(bad, []);
});

Deno.test("046: no agent-specific files; AGENTS.md is the entry point", async () => {
  const files = await tracked();
  assert(files.includes("AGENTS.md"));
  assertEquals(files.filter((f) => /^(CLAUDE\.md|\.claude\/|\.cursor\/|\.codex\/)/.test(f)), []);
});

Deno.test("046: the version is semver, in TypeScript, and the generated assets are fresh", async () => {
  assert(/^\d+\.\d+\.\d+$/.test(VERSION), VERSION);
  const json = JSON.parse(await Deno.readTextFile(ROOT + "deno.json"));
  assertEquals(json.version, undefined, "the version lives in src/archon/version.ts only");
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", ROOT + "tools/gen-assets.ts", "--check"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
});

Deno.test("046: generated files are named .auto.", async () => {
  const files = await tracked();
  for (const f of files) {
    if (!f.endsWith(".ts")) continue;
    const head = (await Deno.readTextFile(ROOT + f)).slice(0, 200);
    if (/^\/\/ GENERATED/.test(head)) {
      assert(f.includes(".auto."), `${f} is generated: name it .auto.`);
    }
  }
});
