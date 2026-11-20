/**
 * Spec 011: the prompt shows the host, and every layer titles the terminal
 * "<shell> in <user>@<host>" (oh-my-posh, fish, bash, tmux).
 *
 * @module
 */
import { fs, proc } from "@intellectual-frontiers/system";
import { assert, assertEquals, assertExists, proves, test } from "@intellectual-frontiers/test";

/** The parts of Oh My Posh's theme these tests read. */
type Segment = {
  type: string;
  template: string;
  background_templates: string[];
};
const omp = JSON.parse(await fs.readTextFile("src/archon/shell/archon.omp.json")) as {
  console_title_template: string;
  blocks: Array<{ segments: Segment[] }>;
};

/** bash, fish and the launcher are a host's (Linux) and a workstation's (WSL): Windows runs none. */
const WINDOWS: string | false =
  proc.build.os === "windows" &&
  "a host's shells and launcher (POSIX sh, bash) do not run on Windows";

proves(
  ["011-shell FR-005", "044-durable FR-009"],
  "prompt: the host name beside the distro icon, marked on a durable host (spec 044)",
  () => {
    const os = omp.blocks[0]?.segments[0];
    assertExists(os);
    assertEquals(os.type, "os");
    assertEquals(
      os.template,
      ' {{ if .WSL }}WSL at {{ end }}{{.Icon}} {{ .HostName }}{{ if eq .Env.ARCHON_DATA "durable" }} \uf132 durable{{ end }} ',
    );
    assertEquals(os.background_templates, [
      '{{ if eq .Env.ARCHON_DATA "durable" }}#e9b96e{{ end }}',
    ]);
  },
);

proves(["011-shell FR-006"], "prompt: the terminal title is <shell> in <user>@<host>", () => {
  assertEquals(omp.console_title_template, "{{ .Shell }} in {{ .UserName }}@{{ .HostName }}");
});

proves(["011-shell FR-007"], "prompt: 🔐 backup is amber (spec 029)", () => {
  const status = omp.blocks[1]?.segments[0];
  assert(status?.background_templates.some((t) => t.includes("🔐") && t.includes("#c4a000")));
});

proves(
  ["011-shell FR-006"],
  "titles: fish, bash, and tmux say the same as oh-my-posh",
  async () => {
    const { renderEmit } = await import("../src/archon/shell/emit.ts");
    const fish = renderEmit("fish");
    assert(
      /function fish_title\n\s+echo "fish in \$USER@"\(prompt_hostname\)\n\s+end/.test(fish),
      "fish_title",
    );
    // Defined before oh-my-posh initializes, so oh-my-posh's own title (same text) wins when it sets one.
    assert(fish.indexOf("function fish_title") < fish.indexOf("oh-my-posh init fish"));
    const bash = renderEmit("bash");
    assert(
      bash.includes(`printf '\\033]0;bash in %s@%s\\007' "$USER" "\${HOSTNAME%%.*}"`),
      "bash title",
    );
    const tmux = await fs.readTextFile("home/dot_config/tmux/tmux.conf");
    assert(tmux.includes("set -g set-titles on"));
    assert(
      tmux.includes(`set -g set-titles-string "#{pane_current_command} in #(whoami)@#h"`),
      "short host (#h)",
    );
  },
);

// ---------------------------------------------------------------- spec 036

const SP = await fs.makeTempDir({ prefix: "archon-shell-test-" });
/** A PATH with stand-ins for Ubuntu's names (batcat, fdfind) and eza. */
async function fakeTools(names: string[]): Promise<string> {
  const dir = `${SP}/bin-${names.join("-") || "none"}`;
  await fs.mkdir(dir, { recursive: true });
  for (const n of names) {
    await fs.writeTextFile(`${dir}/${n}`, "#!/bin/sh\nexit 0\n");
    await fs.chmod(`${dir}/${n}`, 0o755);
  }
  return dir;
}
async function bash(
  script: string,
  path: string,
  interactive: boolean,
  env: Record<string, string> = {},
) {
  const r = await proc.output(
    [
      "bash",
      ...(interactive ? ["--norc", "--noprofile", "-i", "-c", script] : ["--norc", "-c", script]),
    ],
    {
      env: { PATH: `${path}:/usr/bin:/bin`, HOME: SP, TERM: "xterm-256color", ...env },
      stdin: "null",
    },
  );
  return new TextDecoder().decode(r.stdout);
}

proves(
  ["036-cli-comforts FR-002"],
  "036: shell emit's bash code parses, and aliases only interactive shells",
  async () => {
    const { renderEmit } = await import("../src/archon/shell/emit.ts");
    const file = `${SP}/init.bash`;
    await fs.writeTextFile(file, renderEmit("bash"));
    const syntax = await proc.output(["bash", "-n", file]);
    assertEquals(syntax.code, 0, new TextDecoder().decode(syntax.stderr));
    const path = await fakeTools(["eza", "batcat", "fdfind"]);
    const on = await bash(`. ${file}; alias`, path, true);
    // A terminal with a Nerd Font (not a console): eza draws icons.
    assert(on.includes("alias ls='eza --icons=auto --group-directories-first'"), on);
    assert(on.includes("alias tree='eza --icons=auto --tree'"), on);
    // A console terminal (no Nerd Font): no icons.
    const onConsole = await bash(`. ${file}; alias`, path, true, { TERM: "linux" });
    assert(onConsole.includes("alias ls='eza --group-directories-first'"), onConsole);
    const plain = await bash(`. ${file}; alias`, path, true, { ARCHON_PROMPT: "plain" });
    assert(plain.includes("alias ll='eza -l --git --group-directories-first'"), plain);
    assert(on.includes("alias cat='batcat --paging=never'"), on);
    assert(on.includes("alias bat='batcat'"), on);
    assert(on.includes("alias fd='fdfind'"), on);
    // Not interactive (a script, scp): nothing.
    assertEquals((await bash(`. ${file}; alias`, path, false)).trim(), "");
    // No eza: the classic ls with colors.
    const none = await bash(`. ${file}; alias`, await fakeTools([]), true);
    assert(none.includes("alias ls='ls --color=auto'"), none);
    assert(!none.includes("cat="), none);
  },
  { skip: WINDOWS },
);

proves(
  ["036-cli-comforts FR-003"],
  "036: the prompt is plain on a console terminal and when asked",
  async () => {
    const { renderEmit } = await import("../src/archon/shell/emit.ts");
    const file = `${SP}/init.bash`;
    await fs.writeTextFile(file, renderEmit("bash"));
    const path = await fakeTools(["oh-my-posh"]);
    // oh-my-posh is a stand-in here: the plain prompt is what's left when it is not chosen.
    const ps1 = (env: Record<string, string>) =>
      bash(`. ${file}; printf %s "$PS1"`, path, true, env);
    assert((await ps1({ TERM: "linux" })).includes("__archon_status_plain"));
    assert((await ps1({ ARCHON_PROMPT: "plain" })).includes("__archon_status_plain"));
  },
  { skip: WINDOWS },
);

proves(
  ["036-cli-comforts FR-004"],
  "036: the launcher prints the rendered file without starting the engine",
  async () => {
    const { LAUNCHER } = await import("../src/archon/capabilities/cli.ts");
    const { SHELL_DIR, renderEmit } = await import("../src/archon/shell/emit.ts");
    const dir = `${SP}/share`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeTextFile(`${dir}/init.fish`, renderEmit("fish"));
    const launcher = `${SP}/archon`;
    // The same script, pointed at a test folder, with Bun and Node made unreachable.
    await fs.writeTextFile(
      launcher,
      LAUNCHER.replaceAll(SHELL_DIR, dir)
        .replaceAll("/usr/local/bin/bun", "/nonexistent/bun")
        .replace("exec node ", "exec /nonexistent/node "),
    );
    const r = await proc.output(["sh", launcher, "shell", "emit", "fish"]);
    assertEquals(r.code, 0);
    assertEquals(new TextDecoder().decode(r.stdout), renderEmit("fish"));
  },
  { skip: WINDOWS },
);

proves(
  ["096-bun-runtime FR-007", "012-cli-mcp FR-001"],
  "096: the launcher runs archon.ts with Bun, and with Node where Bun is not installed",
  async () => {
    const { LAUNCHER } = await import("../src/archon/capabilities/cli.ts");
    const dir = `${SP}/runtimes`;
    await fs.mkdir(`${dir}/bin`, { recursive: true });
    // Stand-ins that say which runtime ran, and with what.
    for (const name of ["bun", "node"]) {
      await fs.writeTextFile(`${dir}/bin/${name}`, `#!/bin/sh\necho "${name} $*"\n`);
      await fs.chmod(`${dir}/bin/${name}`, 0o755);
    }
    const launcher = (bun: string): string =>
      LAUNCHER.replaceAll("/usr/local/bin/bun", bun).replace("exec node ", `exec ${dir}/bin/node `);
    await fs.writeTextFile(`${dir}/with-bun`, launcher(`${dir}/bin/bun`));
    await fs.writeTextFile(`${dir}/without-bun`, launcher(`${dir}/nonexistent/bun`));
    const run = async (script: string): Promise<string> =>
      new TextDecoder()
        .decode((await proc.output(["sh", `${dir}/${script}`, "verify", "--json"])).stdout)
        .trim();
    // It is /usr/local/bin/archon on every host (spec 012).
    const { resolvePlan } = await import("../src/archon/model/resolve.ts");
    const { fleet, host } = await import("./fixtures.ts");
    const bin = resolvePlan(host(), fleet()).files.find((f) => f.path === "/usr/local/bin/archon");
    assertEquals([bin?.content, bin?.mode], [LAUNCHER, "0755"]);
    if (WINDOWS === false) {
      assertEquals(await run("with-bun"), `bun /srv/archon/archon.ts verify --json`);
      // Node with commons' hook, by its file (Node resolves --import from the working folder).
      assertEquals(
        await run("without-bun"),
        `node --import /srv/archon/node_modules/@intellectual-frontiers/commons/commons/ts/node/register.mjs /srv/archon/archon.ts verify --json`,
      );
    }
    // Only Bun or Node (the old runtime spelled in parts, so this file does not name it).
    assert(!new RegExp(["d", "eno"].join(""), "i").test(LAUNCHER), "the launcher runs Bun or Node");
  },
);

proves(
  ["036-cli-comforts FR-005"],
  "036: the fleet's dotfiles carry the one line for everyone",
  async () => {
    const bashrc = await fs.readTextFile("home/dot_bashrc.tmpl");
    const fish = await fs.readTextFile("home/dot_config/fish/config.fish.tmpl");
    assert(bashrc.includes('eval "$(archon shell emit bash)"'));
    assert(fish.includes("archon shell emit fish | source"));
    // Not behind a persona feature: the line's only condition is that archon exists.
    const before = bashrc.slice(0, bashrc.indexOf("archon shell emit"));
    assertEquals(
      (before.match(/\{\{- if/g) ?? []).length,
      (before.match(/\{\{- end/g) ?? []).length,
    );
  },
);

proves(
  ["036-cli-comforts FR-001", "036-cli-comforts FR-007"],
  "036: the comforts come from Ubuntu; VS Code only on a desktop workstation",
  async () => {
    const { TOOLS } = await import("../src/archon/tools/catalog.ts");
    for (const id of [
      "eza",
      "bat",
      "zoxide",
      "fzf",
      "ripgrep",
      "fd",
      "delta",
      "duf",
      "dust",
      "tealdeer",
    ]) {
      const t = TOOLS.find((x) => x.id === id);
      assert(t && t.source === "apt" && !t.ppa && !t.repo, id);
    }
    const { resolvePlan } = await import("../src/archon/model/resolve.ts");
    const { workstation } = await import("../src/archon/capabilities/mod.ts");
    const { fleet, host } = await import("./fixtures.ts");
    const ws = (desktop: boolean) =>
      host({
        name: "pc",
        kind: "workstation",
        user: "alice",
        desktop,
        mac: undefined,
        disk: undefined,
        capabilities: workstation(),
        spec: "020-workstation",
      });
    const has = (p: ReturnType<typeof resolvePlan>) => p.packages.some((x) => x.name === "code");
    assert(has(resolvePlan(ws(true), fleet())));
    assert(!has(resolvePlan(ws(false), fleet())));
    assert(!has(resolvePlan(host(), fleet())));
  },
);

test("036: fish 4 has no cd.fish file: zoxide gets fish's built-in cd instead", async () => {
  const { renderEmit } = await import("../src/archon/shell/emit.ts");
  const fish = renderEmit("fish");
  const copy = fish.indexOf("function __zoxide_cd_internal");
  const init = fish.indexOf("zoxide init fish");
  assert(copy > 0 && copy < init);
  assert(fish.includes("__fish_data_dir/functions/cd\\.fish"));
});
