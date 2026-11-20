/**
 * Spec 031 (dotfile layers): `archon dotfiles` on a copy of the example lab with a layer of its
 * own, the files that stay the user's, and the verify check per user.
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
import { targetOf } from "../src/archon/dotfiles/layers.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { fleet, host } from "./fixtures.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";

const posix = proc.build.os !== "windows";

proves(
  ["031-dotfile-layers FR-006"],
  "031: archon dotfiles lists the layers, and for a file the layer and repository file that provide it",
  async () => {
    const sb = await sandbox("archon-031-");
    try {
      const repo = path.join(sb.home, "fleet");
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await proc.output([
        "cp",
        "-r",
        path.join(ENGINE_ROOT, "examples/fleets/lab"),
        path.join(repo, "fleets/lab"),
      ]);
      await linkEngine(repo);
      // alice's own layer, everywhere: her tmux configuration.
      const layer = path.join(repo, "fleets/lab/users/alice/home");
      await fs.mkdir(layer, { recursive: true });
      await fs.writeTextFile(path.join(layer, "dot_tmux.conf"), "set -g mouse on\n");
      const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab" };
      const archon = (args: string[]) =>
        sb.run(path.join(ENGINE_ROOT, "src/archon/main.ts"), [...args, "--host", "alpha"], "", env);

      let r = await archon(["dotfiles", "--user", "alice"]);
      assertEquals(r.code, 0, r.out);
      for (const l of [
        "@engine/home",
        "fleets/lab/home",
        "fleets/lab/hosts/alpha/home",
        "fleets/lab/users/alice/home",
      ]) {
        assertStringIncludes(r.out, l);
      }
      assert(/~\/\.bashrc\s+engine\s+@engine\/home\/dot_bashrc\.tmpl/.test(r.out), r.out);
      assert(
        /~\/\.tmux\.conf\s+user\s+fleets\/lab\/users\/alice\/home\/dot_tmux\.conf/.test(r.out),
        r.out,
      );

      // One file: its layer and its repository file.
      r = await archon(["dotfiles", "~/.tmux.conf", "--user", "alice"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "from   fleets/lab/users/alice/home/dot_tmux.conf");
      assertStringIncludes(r.out, "layer  user");
      // A file no layer has is the user's own.
      r = await archon(["dotfiles", "~/.bashrc.local", "--user", "alice"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "~/.bashrc.local is not managed: it is yours");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  { skip: posix ? false : "the example lab is copied with cp" },
);

proves(
  ["031-dotfile-layers FR-009"],
  "031: bash reads ~/.bashrc.local and fish ~/.config/fish/local.fish when present; no layer provides them",
  async () => {
    const home = path.join(ENGINE_ROOT, "home");
    const bashrc = await fs.readTextFile(path.join(home, "dot_bashrc.tmpl"));
    assert(bashrc.split("\n").includes('[ -r "$HOME/.bashrc.local" ] && . "$HOME/.bashrc.local"'));
    const fish = await fs.readTextFile(path.join(home, "dot_config/fish/config.fish.tmpl"));
    assert(
      fish
        .split("\n")
        .includes("test -r ~/.config/fish/local.fish; and source ~/.config/fish/local.fish"),
    );
    const targets = (await fs.walkFiles(home)).map((f) => targetOf(f));
    assert(targets.includes(".bashrc"), targets.join(" "));
    assert(!targets.includes(".bashrc.local") && !targets.includes(".config/fish/local.fish"));
  },
);

proves(
  ["031-dotfile-layers FR-010"],
  "031: verify warns, per user, when a home directory differs from its composed dotfiles",
  () => {
    const plan = resolvePlan(host(), fleet());
    const checks = plan.checks.filter((c) => c.spec === "031-dotfile-layers");
    assertEquals(
      checks.map((c) => c.name).sort(),
      plan.users.map((u) => `dotfiles of ${u.name} match the repository`).sort(),
    );
    for (const c of checks) {
      assertEquals(c.level, "warn");
      assertStringIncludes(c.command, "chezmoi; [ -x $c ] || exit 0;");
      assertStringIncludes(c.command, "verify --no-tty");
    }
    const alice = checks.find((c) => c.name.startsWith("dotfiles of alice "));
    assertStringIncludes(alice?.command ?? "", "runuser -u alice -- $c verify --no-tty");
  },
);
