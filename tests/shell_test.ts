// Spec 011: the prompt shows the host, and every layer titles the terminal
// "<shell> in <user>@<host>" (oh-my-posh, fish, bash, tmux).
import { assert, assertEquals } from "./assert.ts";

const omp = JSON.parse(await Deno.readTextFile("src/archon/shell/archon.omp.json"));

Deno.test("prompt: the host name beside the distro icon, marked on a durable host (spec 044)", () => {
  const os = omp.blocks[0].segments[0];
  assertEquals(os.type, "os");
  assertEquals(
    os.template,
    ' {{ if .WSL }}WSL at {{ end }}{{.Icon}} {{ .HostName }}{{ if eq .Env.ARCHON_DATA "durable" }} \uf132 durable{{ end }} ',
  );
  assertEquals(os.background_templates, ['{{ if eq .Env.ARCHON_DATA "durable" }}#e9b96e{{ end }}']);
});

Deno.test("prompt: the terminal title is <shell> in <user>@<host>", () => {
  assertEquals(omp.console_title_template, "{{ .Shell }} in {{ .UserName }}@{{ .HostName }}");
});

Deno.test("prompt: 🔐 backup is amber (spec 029)", () => {
  const status = omp.blocks[1].segments[0];
  assert(
    status.background_templates.some((t: string) => t.includes("🔐") && t.includes("#c4a000")),
  );
});

Deno.test("titles: fish, bash, and tmux say the same as oh-my-posh", async () => {
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
  const tmux = await Deno.readTextFile("home/dot_config/tmux/tmux.conf");
  assert(tmux.includes("set -g set-titles on"));
  assert(
    tmux.includes(`set -g set-titles-string "#{pane_current_command} in #(whoami)@#h"`),
    "short host (#h)",
  );
});

// ---------------------------------------------------------------- spec 036

const SP = await Deno.makeTempDir({ prefix: "archon-shell-test-" });
/** A PATH with stand-ins for Ubuntu's names (batcat, fdfind) and eza. */
async function fakeTools(names: string[]): Promise<string> {
  const dir = `${SP}/bin-${names.join("-") || "none"}`;
  await Deno.mkdir(dir, { recursive: true });
  for (const n of names) {
    await Deno.writeTextFile(`${dir}/${n}`, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(`${dir}/${n}`, 0o755);
  }
  return dir;
}
async function bash(
  script: string,
  path: string,
  interactive: boolean,
  env: Record<string, string> = {},
) {
  const r = await new Deno.Command("bash", {
    args: interactive ? ["--norc", "--noprofile", "-i", "-c", script] : ["--norc", "-c", script],
    env: { PATH: `${path}:/usr/bin:/bin`, HOME: SP, TERM: "xterm-256color", ...env },
    stdin: "null",
  }).output();
  return new TextDecoder().decode(r.stdout);
}

Deno.test("036: shell emit's bash code parses, and aliases only interactive shells", async () => {
  const { renderEmit } = await import("../src/archon/shell/emit.ts");
  const file = `${SP}/init.bash`;
  await Deno.writeTextFile(file, renderEmit("bash"));
  const syntax = await new Deno.Command("bash", { args: ["-n", file] }).output();
  assertEquals(syntax.code, 0, new TextDecoder().decode(syntax.stderr));
  const path = await fakeTools(["eza", "batcat", "fdfind"]);
  const on = await bash(`. ${file}; alias`, path, true);
  // A terminal with a Nerd Font (not a console): eza draws icons.
  assert(on.includes("alias ls='eza --icons=auto --group-directories-first'"), on);
  assert(on.includes("alias tree='eza --icons=auto --tree'"), on);
  // A console terminal (no Nerd Font): no icons.
  const console = await bash(`. ${file}; alias`, path, true, { TERM: "linux" });
  assert(console.includes("alias ls='eza --group-directories-first'"), console);
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
});

Deno.test("036: the prompt is plain on a console terminal and when asked", async () => {
  const { renderEmit } = await import("../src/archon/shell/emit.ts");
  const file = `${SP}/init.bash`;
  await Deno.writeTextFile(file, renderEmit("bash"));
  const path = await fakeTools(["oh-my-posh"]);
  // oh-my-posh is a stand-in here: the plain prompt is what's left when it is not chosen.
  const ps1 = (env: Record<string, string>) => bash(`. ${file}; printf %s "$PS1"`, path, true, env);
  assert((await ps1({ TERM: "linux" })).includes("__archon_status_plain"));
  assert((await ps1({ ARCHON_PROMPT: "plain" })).includes("__archon_status_plain"));
});

Deno.test("036: the launcher prints the rendered file without starting Deno", async () => {
  const { LAUNCHER } = await import("../src/archon/capabilities/cli.ts");
  const { SHELL_DIR, renderEmit } = await import("../src/archon/shell/emit.ts");
  const dir = `${SP}/share`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/init.fish`, renderEmit("fish"));
  const launcher = `${SP}/archon`;
  // The same script, pointed at a test folder, with Deno made unreachable.
  await Deno.writeTextFile(
    launcher,
    LAUNCHER.replaceAll(SHELL_DIR, dir).replace(
      "exec /usr/local/bin/deno",
      "exec /nonexistent/deno",
    ),
  );
  const r = await new Deno.Command("sh", { args: [launcher, "shell", "emit", "fish"] }).output();
  assertEquals(r.code, 0);
  assertEquals(new TextDecoder().decode(r.stdout), renderEmit("fish"));
});

Deno.test("036: the fleet's dotfiles carry the one line for everyone", async () => {
  const bashrc = await Deno.readTextFile("home/dot_bashrc.tmpl");
  const fish = await Deno.readTextFile("home/dot_config/fish/config.fish.tmpl");
  assert(bashrc.includes('eval "$(archon shell emit bash)"'));
  assert(fish.includes("archon shell emit fish | source"));
  // Not behind a persona feature: the line's only condition is that archon exists.
  const before = bashrc.slice(0, bashrc.indexOf("archon shell emit"));
  assertEquals((before.match(/\{\{- if/g) ?? []).length, (before.match(/\{\{- end/g) ?? []).length);
});

Deno.test("036: the comforts come from Ubuntu; VS Code only on a desktop workstation", async () => {
  const { TOOLS } = await import("../src/archon/tools/catalog.ts");
  for (
    const id of ["eza", "bat", "zoxide", "fzf", "ripgrep", "fd", "delta", "duf", "dust", "tealdeer"]
  ) {
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
});

Deno.test("036: fish 4 has no cd.fish file: zoxide gets fish's built-in cd instead", async () => {
  const { renderEmit } = await import("../src/archon/shell/emit.ts");
  const fish = renderEmit("fish");
  const copy = fish.indexOf("function __zoxide_cd_internal");
  const init = fish.indexOf("zoxide init fish");
  assert(copy > 0 && copy < init);
  assert(fish.includes("__fish_data_dir/functions/cd\\.fish"));
});
