/**
 * Spec 046-engine-instance: the engine holds no fleet's facts, travels as
 * modules (`@stolos/` from GitHub), names no particular agent, and keeps its
 * version in TypeScript.
 *
 * @module
 */
import { fs, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { assert, assertEquals, proves } from "@intellectual-frontiers/ifc-ts/runtime/test";
import { VERSION } from "../src/archon/version.ts";

const ROOT = new URL("..", import.meta.url).pathname;

async function tracked(): Promise<string[]> {
  const r = await proc.run(["git", "-C", ROOT, "ls-files", "-co", "--exclude-standard"]);
  // Tracked or new, and still there (a deletion not yet committed is not part of the engine).
  return r.stdout.split("\n").filter((f) => f !== "" && fs.existsSync(ROOT + f));
}

// Words that would only be in the engine if a real fleet's facts leaked into
// it. Kept as base64 so this file does not match itself.
const LEAKS = ["ZmNyLm5ldHdvcms=", "ZXJnYS5meWk=", "c25zaGFo", "ZmFsbGluZ2NyZWVr", "NDc0OTc="].map(
  (b) => atob(b),
);

proves(["046-engine-instance FR-008"], "046: no fleet's facts in the engine", async () => {
  const hits: string[] = [];
  for (const f of await tracked()) {
    if (!/\.(ts|md|json|sh|tmpl|toml|yaml|yml|txt)$/.test(f)) continue;
    const text = (await fs.readTextFile(ROOT + f)).toLowerCase();
    for (const w of LEAKS) if (text.includes(w)) hits.push(`${f}: ${w}`);
  }
  assertEquals(hits, []);
});

proves(
  ["046-engine-instance FR-008", "096-bun-runtime FR-001"],
  "096: the engine imports its own modules relatively, node: builtins, and its declared packages only",
  async () => {
    const bad: string[] = [];
    for (const f of await tracked()) {
      if (!f.startsWith("src/") || !f.endsWith(".ts")) continue;
      const lines = (await fs.readTextFile(ROOT + f)).split("\n");
      let inTemplate = false; // lines inside a template literal are generated text, not imports
      lines.forEach((l, i) => {
        const quoted = inTemplate;
        inTemplate = ((l.match(/(?<!\\)`/g) ?? []).length % 2 === 1) !== inTemplate;
        if (quoted) return;
        const m =
          l.match(/^(?:import|export)\s.*\sfrom\s+"([^"]+)"/) ??
          l.match(/\bimport\(\s*"([^"]+)"\s*\)/);
        const spec = m?.[1];
        if (spec === undefined) return;
        // Relative (with .ts), node: builtins, the packages package.json declares, and the PAM
        // binding's bun:ffi (spec 096); never npm:, jsr: or a URL.
        if (!/^(\.|node:|@intellectual-frontiers\/ifc-ts(\/|$)|ajv(\/|$)|bun:ffi$)/.test(spec)) {
          bad.push(`${f}:${i + 1} ${spec}`);
        }
        if (/(^|\/)(fleets|examples)\//.test(spec)) bad.push(`${f}:${i + 1} ${spec}`);
      });
    }
    assertEquals(bad, []);
  },
);

proves(["046-engine-instance FR-008"], "046: fleets hold TypeScript, not JSON", async () => {
  const bad = (await tracked()).filter((f) => /(^|\/)fleets\//.test(f) && /\.json5?$/.test(f));
  assertEquals(bad, []);
});

proves(
  ["046-engine-instance FR-008", "046-engine-instance FR-010"],
  "046: no agent-specific files; AGENTS.md is the entry point",
  async () => {
    const files = await tracked();
    assert(files.includes("AGENTS.md"));
    assertEquals(
      files.filter((f) => /^(CLAUDE\.md|\.claude\/|\.cursor\/|\.codex\/)/.test(f)),
      [],
    );
  },
);

proves(
  ["046-engine-instance FR-007"],
  "046: the version is semver, in TypeScript (package.json follows it), and the generated assets are fresh",
  async () => {
    assert(/^\d+\.\d+\.\d+$/.test(VERSION), VERSION);
    const json: unknown = JSON.parse(await fs.readTextFile(ROOT + "package.json"));
    assertEquals(
      typeof json === "object" && json !== null ? Reflect.get(json, "version") : undefined,
      VERSION,
      "package.json's version is src/archon/version.ts's (bun run version keeps them equal)",
    );
    const r = await proc.run([proc.execPath(), ROOT + "tools/gen-assets.ts", "--check"]);
    assertEquals(r.code, 0, r.stderr);
  },
);

proves(["046-engine-instance FR-008"], "046: generated files are named .auto.", async () => {
  const files = await tracked();
  for (const f of files) {
    if (!f.endsWith(".ts")) continue;
    const head = (await fs.readTextFile(ROOT + f)).slice(0, 200);
    if (/^\/\/ GENERATED/.test(head)) {
      assert(f.includes(".auto."), `${f} is generated: name it .auto.`);
    }
  }
});
