/**
 * Spec 031: dotfile layers compose into one chezmoi source per user.
 *
 * @module
 */
import { width } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assertExists,
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import {
  compose,
  forbidden,
  layersFor,
  strayLayers,
  targetOf,
} from "../src/archon/dotfiles/layers.ts";
import { syncComposed } from "../src/archon/dotfiles/sync.ts";
import { at } from "./fixtures.ts";

/** The text without its escape sequences (colors). */
const noEscapes = (s: string): string =>
  width
    .tokens(s)
    .filter((t) => t.kind === "text")
    .map((t) => t.text)
    .join("");

proves(["031-dotfile-layers FR-002"], "031: source names map to their targets", () => {
  assertEquals(targetOf("dot_bashrc.tmpl"), ".bashrc");
  assertEquals(targetOf("dot_bashrc"), ".bashrc");
  assertEquals(targetOf("private_dot_ssh/config"), ".ssh/config");
  assertEquals(targetOf("dot_config/fish/executable_x.fish.tmpl"), ".config/fish/x.fish");
  assertEquals(targetOf("literal_dot_keep"), "dot_keep");
  assertEquals(targetOf("exact_private_dot_config/readonly_a"), ".config/a");
});

proves(
  ["031-dotfile-layers FR-003"],
  "031: scripts, secrets, externals, and a chezmoiroot are refused",
  () => {
    assert(forbidden("run_once_setup.sh"));
    assert(forbidden(".chezmoiscripts/a.sh"));
    assert(forbidden("encrypted_dot_netrc"));
    assert(forbidden("dot_key.age"));
    assert(forbidden(".chezmoiexternal.toml"));
    assert(forbidden(".chezmoiroot"));
    assertEquals(forbidden("dot_config/fish/config.fish.tmpl"), undefined);
  },
);

/** An in-memory repository: layer dir -> { relative path: content }. */
function repo(tree: Record<string, Record<string, string>>): {
  list: (dir: string) => Promise<string[]>;
  read: (rel: string) => Promise<string>;
} {
  return {
    list: (dir: string) => Promise.resolve(Object.keys(tree[dir] ?? {}).sort()),
    read: (rel: string) => {
      for (const [dir, files] of Object.entries(tree)) {
        const text = rel.startsWith(dir + "/") ? files[rel.slice(dir.length + 1)] : undefined;
        if (text !== undefined) return Promise.resolve(text);
      }
      return Promise.reject(new Error(rel));
    },
  };
}

proves(
  ["031-dotfile-layers FR-001", "031-dotfile-layers FR-002"],
  "031: later layers replace by target; ignore files combine; problems are named",
  async () => {
    const [, base = "", h = "", u = "", hu = ""] = layersFor("alpha", "alice", "lab").map(
      (l) => l.dir,
    );
    const r = repo({
      [base]: {
        "README.md": "docs",
        ".chezmoiignore": ".claude\n",
        "dot_bashrc.tmpl": "base",
        "dot_config/fish/config.fish.tmpl": "fish",
      },
      [h]: { ".chezmoiignore": ".config/tmux\n", dot_gitconfig: "host git" },
      [u]: {
        dot_bashrc: "mine",
        "private_dot_config/fish/conf.d/x.fish": "x",
        dot_tool: "a",
        "dot_tool.tmpl": "b",
      },
      [hu]: { "run_once_x.sh": "echo" },
    });
    const c = await compose("alpha", "alice", r.list, r.read);
    const byTarget = Object.fromEntries(c.files.map((f) => [f.target, f]));
    assertEquals(byTarget[".bashrc"]?.from, `${u}/dot_bashrc`);
    assertEquals(byTarget[".bashrc"]?.source, "dot_bashrc");
    // The directory keeps the fleet layer's name, so there is one ~/.config.
    assertEquals(byTarget[".config/fish/conf.d/x.fish"]?.source, "dot_config/fish/conf.d/x.fish");
    assertEquals(byTarget[".gitconfig"]?.layer.kind, "host");
    assert(!c.files.some((f) => f.target === "README.md"));
    assertEquals(
      c.concatenated.get(".chezmoiignore"),
      `# from ${base}/.chezmoiignore\n.claude\n# from ${h}/.chezmoiignore\n.config/tmux\n`,
    );
    assertEquals(c.problems.length, 2);
    assert(c.problems.some((p) => p.includes("same target ~/.tool")));
    assert(c.problems.some((p) => p.includes("run_once_x.sh") && p.includes("scripts")));
    assertEquals(
      c.present.map((l) => l.kind),
      ["fleet", "host", "user", "host-user"],
    );
  },
);

proves(
  ["031-dotfile-layers FR-004"],
  "031: the composed source is written, kept in step, and checked without writing",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-dotfiles-test-" });
    try {
      const repoDir = `${dir}/repo`;
      const out = `${dir}/out`;
      // Spec 046: the engine's base layer comes with the engine; the fleet's and
      // the user's layers are in the fleet's folder.
      await fs.mkdir(`${repoDir}/fleets/lab/home/dot_config`, { recursive: true });
      await fs.mkdir(`${repoDir}/fleets/lab/users/ann/home`, { recursive: true });
      await fs.writeTextFile(`${repoDir}/fleets/lab/home/dot_config/a`, "a\n");
      await fs.writeTextFile(`${repoDir}/fleets/lab/users/ann/home/dot_bashrc`, "ann\n");

      const check = await syncComposed(repoDir, "alpha", "ann", { check: true, root: out });
      assert(check.changed.includes("dot_bashrc"), "the user's layer");
      assert(check.changed.includes("dot_config/a"), "the fleet's layer");
      assert(check.changed.includes("dot_config/tmux/tmux.conf"), "the engine's base layer");
      assert(!check.changed.includes("dot_bashrc.tmpl"), "replaced by the user's ~/.bashrc");
      assert(!(await fs.stat(`${out}/ann`).catch(() => undefined)));

      const s = await syncComposed(repoDir, "alpha", "ann", { check: false, root: out });
      assertEquals(s.changed.length, check.changed.length);
      assertEquals(await fs.readTextFile(`${out}/ann/dot_bashrc`), "ann\n");
      assertEquals(
        (await syncComposed(repoDir, "alpha", "ann", { check: false, root: out })).changed,
        [],
      );

      // A file no layer provides any more is removed.
      await fs.remove(`${repoDir}/fleets/lab/home/dot_config/a`);
      const again = await syncComposed(repoDir, "alpha", "ann", { check: false, root: out });
      assertEquals(again.changed, ["dot_config/a"]);
      assert(!(await fs.stat(`${out}/ann/dot_config/a`).catch(() => undefined)));
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(["031-dotfile-layers FR-005"], "031: layers must name hosts and users in the model", () => {
  const hostUsers = new Map([["alpha", ["alice", "ops"]]]);
  assertEquals(
    strayLayers(
      {
        hosts: ["alpha", "rome"],
        users: ["alice", "zed"],
        hostUsers: [
          ["alpha", "ops"],
          ["alpha", "bob"],
        ],
      },
      hostUsers,
    ),
    [
      "fleets/lab/hosts/rome/home: no host rome in the model",
      "fleets/lab/users/zed: no user zed on any host",
      "fleets/lab/hosts/alpha/users/bob: alpha has no user bob",
    ],
  );
});

proves(
  ["031-dotfile-layers FR-004", "031-dotfile-layers FR-007", "031-dotfile-layers FR-008"],
  "031: chezmoi reads the composed source; the login banner and man page explain it",
  async () => {
    const { chezmoiConfig, dotfilesMotd, shell } =
      await import("../src/archon/capabilities/shell.ts");
    const { fleet, host } = await import("./fixtures.ts");
    const { usersFor } = await import("../src/archon/model/load.ts");
    const users = usersFor(fleet(), host());
    const [user] = users;
    assertExists(user);
    const cfg: unknown = JSON.parse(chezmoiConfig(user, "alpha"));
    // The same modes whoever runs chezmoi (root's umask 022, or a person's 002).
    assertEquals(at(cfg, "umask"), 0o022);
    assertEquals(at(cfg, "sourceDir"), `/var/lib/archon-dotfiles/${user.name}`);
    assertEquals(at(cfg, "data", "archon", "workstation"), false);
    const motd = dotfilesMotd();
    for (const s of ["archon dotfiles", "chezmoi diff", "man archon-dotfiles", "~/.bashrc.local"]) {
      assertStringIncludes(motd, s);
    }
    const files = shell()({ fleet: fleet(), host: host(), users }).files;
    assertExists(files);
    assert(files.some((f) => f.path === "/etc/update-motd.d/71-archon-dotfiles"));
    const { renderManPages } = await import("../src/archon/render/man.ts");
    const page = renderManPages().get("man7/archon-dotfiles.7");
    assertExists(page);
    assertStringIncludes(page, "fleets/<id>/hosts/<host>/users/<user>/home/");
    assertStringIncludes(page, '.SH "WHAT NOT TO DO"');
  },
);

proves(
  ["031-dotfile-layers FR-007"],
  "031: the login banners run under sh, in color, with emoji",
  async () => {
    const { archonMotd, dotfilesMotd } = await import("../src/archon/render/motd.ts");
    const { fleet, host } = await import("./fixtures.ts");
    const run = async (script: string) => {
      const r = await proc.output(["sh", "-c", script]);
      assertEquals(r.code, 0);
      return new TextDecoder().decode(r.stdout);
    };
    const dot = await run(dotfilesMotd());
    assertStringIncludes(dot, "\x1b[36marchon dotfiles\x1b[0m");
    const plain = noEscapes(dot);
    for (const s of [
      "🏠 Your dotfiles",
      "🔎 archon dotfiles",
      "👀 chezmoi diff",
      "📖 man archon-dotfiles",
    ]) {
      assertStringIncludes(plain, s);
    }
    const web = { ...fleet(), web: { domain: "lab.example.net" } };
    const arc = noEscapes(await run(archonMotd(web, host(), true)));
    assertStringIncludes(arc, "🌐 https://alpha.lab.example.net");
    assertStringIncludes(arc, "https://cockpit.alpha.lab.example.net");
  },
);
