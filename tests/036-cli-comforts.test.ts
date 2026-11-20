/**
 * Spec 036 (command-line comforts): `archon shell status` on a home of its own, and what the guide
 * says about the comforts, the prompt's font, and VS Code on servers and workstations.
 *
 * @module
 */

import { fs, path } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { workstation } from "../src/archon/capabilities/mod.ts";
import { guideFor } from "../src/archon/guide/guide.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import type { HostDef } from "../src/archon/model/types.ts";
import { fleet, host } from "./fixtures.ts";
import { sandbox } from "./sandbox.ts";

proves(
  ["036-cli-comforts FR-006"],
  "036: archon shell status shows which startup files carry the line",
  async () => {
    const sb = await sandbox("archon-036-");
    try {
      // bash has the line, fish's file lacks it, zsh has no file.
      await fs.writeTextFile(
        path.join(sb.home, ".bashrc"),
        '# mine\neval "$(archon shell emit bash)"\n',
      );
      await fs.mkdir(path.join(sb.home, ".config", "fish"), { recursive: true });
      await fs.writeTextFile(path.join(sb.home, ".config", "fish", "config.fish"), "# mine\n");
      const script = path.join(sb.home, "status.ts");
      const src = new URL("../src/archon/shell/emit.ts", import.meta.url).href;
      await fs.writeTextFile(
        script,
        `import { shellStatus } from ${JSON.stringify(src)};\nawait shellStatus();\n`,
      );
      const r = await sb.run(script, []);
      assertEquals(r.code, 0, r.out);
      const lines = r.out.split("\n").map((l) => l.trimEnd());
      assert(lines.includes("  ✓ bash  ~/.bashrc"), r.out);
      assert(
        lines.some((l) => l.startsWith("  · fish  ~/.config/fish/config.fish  add: ")),
        r.out,
      );
      assert(lines.includes("  · zsh   ~/.zshrc  (no such file)"), r.out);
      assert(!r.out.includes("None of your startup files"));
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

const ws = (desktop: boolean): HostDef =>
  host({
    name: "pc",
    kind: "workstation",
    user: "alice",
    mac: undefined,
    disk: undefined,
    desktop,
    capabilities: workstation(),
    spec: "020-workstation",
  });

proves(
  ["036-cli-comforts FR-008"],
  "036: the guide explains the comforts, the prompt's Nerd Font, and VS Code, for servers and workstations",
  () => {
    const f = fleet({ web: { domain: "lab.example.net" } });
    const item = (h: HostDef, id: string) => {
      const i = guideFor(resolvePlan(h, f)).find((x) => x.id === id);
      assert(i !== undefined, `${id} on ${h.name}`);
      return { text: i.what, cmds: (i.use ?? []).map((u) => u.cmd) };
    };
    // The comforts, and how to tell whether they are on.
    const c = item(host(), "comforts");
    assertStringIncludes(c.text, "eza");
    assert(c.cmds.includes("archon shell status") && c.cmds.includes("command ls"));
    // The prompt: a server says how to choose the plain one; WSL installs the font on Windows.
    const sp = item(host(), "prompt");
    assertStringIncludes(sp.text, "Nerd Font");
    assert(sp.cmds.includes("set -Ux ARCHON_PROMPT plain"));
    const wp = item(ws(false), "prompt");
    assertStringIncludes(wp.text, "Windows Terminal");
    assert(wp.cmds.includes("oh-my-posh font install meslo"));
    assert(wp.cmds.includes("winget install JanDeDobbeleer.OhMyPosh"));
    const dp = item(ws(true), "prompt");
    assert(dp.cmds.includes("oh-my-posh font install meslo"));
    assert(!dp.cmds.some((x) => x.startsWith("winget")));
    // VS Code: installed (a desktop), the WSL extension, or Remote - SSH (a server).
    assertStringIncludes(item(ws(true), "vscode").text, "VS Code is installed here");
    assertStringIncludes(item(ws(false), "vscode").text, "WSL extension");
    assertStringIncludes(item(host(), "vscode").text, "Remote - SSH");
    assertStringIncludes(item(host(), "vscode").text, "alice@alpha.lab.example.net");
  },
);
