/**
 * Spec 059: `stolos` on your PC (the boot server in the same process), and the shortcut.
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
import { ENGINE_ROOT, sandbox } from "./sandbox.ts";

proves(
  ["059-stolos-and-archon FR-002"],
  "059: stolos with no arguments is where you are; stolos boot <sub> is the boot server, in-process",
  async () => {
    const sb = await sandbox("archon-stolos059-");
    try {
      const env = { ARCHON_REPO: path.join(ENGINE_ROOT, "examples"), ARCHON_FLEET: "lab" };
      const stolos = (...args: string[]) => sb.run("src/stolos/main.ts", args, "", env);
      const bare = await stolos("--json");
      const where = await stolos("--json", "where");
      assertEquals(bare.code, 0, bare.out);
      const facts = (s: string): unknown => JSON.parse(s.slice(s.indexOf("{")));
      assertEquals(facts(bare.out), facts(where.out), "stolos is stolos where");
      const text = await stolos();
      assertStringIncludes(text.out, "fleet lab");
      assertStringIncludes(text.out, "next: ");
      // The boot server's commands, from the same entry point and process (src/stolos/main.ts
      // imports src/archon-boot/main.ts; it spawns nothing).
      const boot = await stolos("boot", "help");
      assertStringIncludes(boot.out, "bun run stolos boot retire <host>");
      const main = await fs.readTextFile(path.join(ENGINE_ROOT, "src/stolos/main.ts"));
      assertStringIncludes(main, 'await import("../archon-boot/main.ts")');
      assert(!/proc\.(run|spawn|output)\(/.test(main), "no second process");
      const bootMain = await fs.readTextFile(path.join(ENGINE_ROOT, "src/archon-boot/main.ts"));
      assertStringIncludes(bootMain, "initBootTelemetry()", "its telemetry starts in-process");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

proves(
  ["059-stolos-and-archon FR-006"],
  "059: the stolos shortcut: PowerShell's function, and the macOS and Linux equivalent",
  async () => {
    const readme = await fs.readTextFile(path.join(ENGINE_ROOT, "README.md"));
    assertStringIncludes(readme, "Add-Content $PROFILE 'function stolos { bun run stolos @args }'");
    assertStringIncludes(readme, `echo 'stolos() { bun run stolos "$@"; }' >> ~/.zshrc`);
    assertStringIncludes(readme, `echo 'stolos() { bun run stolos "$@"; }' >> ~/.bashrc`);
    assertStringIncludes(readme, "function stolos; bun run stolos $argv; end; funcsave stolos");
    // The bootstraps add the same (optional: --no-shortcut); tests/bootstrap062.test.ts runs the
    // POSIX one, and CI's Windows job runs tests/bootstrap/windows-check.ps1 for PowerShell's.
    const ps1 = await fs.readTextFile(path.join(ENGINE_ROOT, "bin/bootstrap.windows.ps1"));
    assertStringIncludes(ps1, '$line = "function stolos { $StolosCmd @args } # stolos shortcut');
    assertStringIncludes(ps1, "--no-shortcut");
  },
);
