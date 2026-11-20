/**
 * Spec 011: chezmoi's config per user from personas, the base dotfile layer, bash as the login
 * shell with fish interactive, the prompt's Archon status, and git's identity from the model.
 *
 * @module
 */
import { fs, path } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { composedDir, ENGINE_LAYER, layersFor } from "../src/archon/dotfiles/layers.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { featuresFor } from "../src/archon/personas/mod.ts";
import { renderEmit } from "../src/archon/shell/emit.ts";
import { at, fleet, host } from "./fixtures.ts";
import { ENGINE_ROOT } from "./sandbox.ts";

const plan = resolvePlan(host(), fleet());
const home = (rel: string) => fs.readTextFile(path.join(ENGINE_ROOT, "home", rel));

/** Every file of the base dotfile layer, relative to home/. */
async function homeFiles(): Promise<string[]> {
  return (await fs.walkFiles(path.join(ENGINE_ROOT, "home"))).map((f) => f.replace(/\\/g, "/"));
}

proves(
  ["011-shell FR-001"],
  "011: apply renders chezmoi.json for every account from its personas, so chezmoi never prompts",
  async () => {
    for (const u of plan.users) {
      const f = plan.files.find((x) => x.path === `/home/${u.name}/.config/chezmoi/chezmoi.json`);
      assertExists(f, u.name);
      assertEquals([f.owner, f.mode], [u.name, "0600"]);
      const cfg: unknown = JSON.parse(f.content ?? "");
      assertEquals(at(cfg, "sourceDir"), composedDir(u.name));
      assertEquals(at(cfg, "data", "archon", "user"), u.name);
      assertEquals(at(cfg, "data", "archon", "host"), "alpha");
      assertEquals(at(cfg, "data", "archon", "email"), "1000001+alice@users.noreply.github.com");
      assertEquals(at(cfg, "data", "archon", "features"), featuresFor(u.personas));
    }
    // Every template takes its data from the config: none asks a question.
    for (const rel of await homeFiles()) {
      const text = await home(rel);
      assert(!/\bprompt(String|Bool|Int|Choice|Multichoice)(Once)?\b/.test(text), `${rel} prompts`);
      for (const m of text.matchAll(/\{\{-?\s*(?:if\s+)?\.([a-z]+)\./g)) {
        assertEquals(m[1], "archon", `${rel}: every value comes from the archon data`);
      }
    }
  },
);

proves(
  ["011-shell FR-002"],
  "011: home/ is the most general layer of every user's chezmoi source",
  async () => {
    const layers = layersFor("alpha", "alice", "lab");
    assertEquals(layers[0]?.dir, ENGINE_LAYER);
    assertEquals(layers[0]?.kind, "engine");
    assertEquals(layers[1]?.dir, "fleets/lab/home");
    // The engine's layer is this repository's home/ (carried in assets.auto.ts).
    const files = await homeFiles();
    for (const f of ["dot_bashrc.tmpl", "dot_gitconfig.tmpl", "dot_config/fish/config.fish.tmpl"]) {
      assert(files.includes(f), f);
    }
  },
);

proves(
  ["011-shell FR-003"],
  "011: bash stays the login shell; developers and operators get fish interactively, with the Archon status",
  async () => {
    const bashrc = await home("dot_bashrc.tmpl");
    // fish only for personas with the feature, interactive shells only, and $SHELL says fish.
    const at = bashrc.indexOf("{{- if .archon.features.fish }}");
    assert(at > bashrc.indexOf("case $- in"), "after the non-interactive return");
    const block = bashrc.slice(at, bashrc.indexOf("{{- end }}", at));
    assertStringIncludes(block, "[ -t 0 ] && [ -x /usr/bin/fish ]");
    assertStringIncludes(block, "SHELL=/usr/bin/fish exec /usr/bin/fish --login");
    assertEquals(featuresFor(["operator"]).fish, true);
    assertEquals(featuresFor(["developer"]).fish, true);
    assertEquals(featuresFor(["standard"]).fish, false);
    // Accounts are made with bash as their login shell (spec 006: apply's useradd --shell /bin/bash).
    assert((plan.notes["011-shell"] ?? []).some((n) => n.startsWith("Login shells stay bash")));
    // The prompt reads the last archon result from the status file, in every shell.
    for (const sh of ["bash", "zsh", "fish"] as const) {
      assertStringIncludes(renderEmit(sh), "/var/lib/archon/status/prompt");
    }
  },
);

proves(
  ["011-shell FR-004"],
  "011: git's identity comes from the model (name and noreply address)",
  async () => {
    const git = await home("dot_gitconfig.tmpl");
    assertStringIncludes(git, "name = {{ .archon.fullName }}");
    assertStringIncludes(git, "email = {{ .archon.email }}");
    const alice = plan.files.find((x) => x.path === "/home/alice/.config/chezmoi/chezmoi.json");
    const cfg: unknown = JSON.parse(alice?.content ?? "");
    assertEquals(at(cfg, "data", "archon", "fullName"), "Alice Example");
    assertEquals(at(cfg, "data", "archon", "email"), "1000001+alice@users.noreply.github.com");
    // GitHub access is ops' deploy key over SSH (spec 006).
    const ssh = plan.files.find((x) => x.path === "/home/ops/.ssh/config")?.content ?? "";
    assertStringIncludes(ssh, "IdentityFile /home/ops/.ssh/archon_deploy_key");
  },
);
