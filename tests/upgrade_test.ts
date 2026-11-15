// Spec 046 (Articles 9, 12, 24): stolos fleet upgrade moves a fleet
// repository to a released engine version, locks every engine file, validates
// every fleet, and makes one signed commit; anything else is refused.

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import {
  compare,
  ENGINE_ENTRY_TEXT,
  fleetUpgrade,
  parseTag,
  readPin,
  writePin,
} from "../src/archon/fleet/upgrade.ts";
import { VERSION } from "../src/archon/version.ts";
import { ui } from "../src/archon/core/ui.ts";

/** One run, as from the command line (the ui's problems are per run). */
const upgrade = (o: Parameters<typeof fleetUpgrade>[0]) => {
  ui.problems.length = 0;
  return fleetUpgrade(o);
};

const ENGINE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("046: tags, order, and the pin in deno.json", () => {
  assertEquals(parseTag("v1.2.3"), [1, 2, 3]);
  assertEquals(parseTag("1.2.3"), undefined);
  assertEquals(parseTag("v1.2"), undefined);
  assertEquals(compare([0, 7, 0], [0, 10, 0]), -1, "numbers, not text");
  const json = `{
  "imports": {
    "@stolos/": "https://raw.githubusercontent.com/intellectual-frontiers/stolos/v0.7.0/src/"
  },
  "tasks": { "archon": "deno run -A --frozen archon.ts" }
}
`;
  const pin = readPin(json)!;
  assertEquals(pin, {
    base: "https://raw.githubusercontent.com/intellectual-frontiers/stolos/",
    tag: "v0.7.0",
  });
  const moved = writePin(json, pin, "v0.8.0");
  assertEquals(moved, json.replace("v0.7.0", "v0.8.0"), "only the pin changes");
  assertEquals(readPin('{ "imports": { "@stolos/": "http://x/stolos/main/src/" } }'), undefined);
  assertEquals(readPin("not json"), undefined);
});

/** A local "GitHub": the engine checkout served under stolos/<tag>/ for each tag. */
function engineServer(tags: string[], root: string) {
  for (const t of tags) {
    Deno.mkdirSync(`${root}/stolos`, { recursive: true });
    Deno.symlinkSync(ENGINE, `${root}/stolos/${t}`);
  }
  return Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    try {
      const body = await Deno.readFile(`${root}${path}`);
      return new Response(body, {
        headers: { "content-type": path.endsWith(".ts") ? "application/typescript" : "text/plain" },
      });
    } catch {
      return new Response("not found\n", { status: 404 });
    }
  });
}

const sh = async (cwd: string, ...a: string[]) => {
  const r = await new Deno.Command(a[0], {
    args: a.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  if (!r.success) throw new Error(`${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
};

Deno.test("046: fleet upgrade locks, validates, and signs; refuses what is not a release", async () => {
  const dir = await Deno.makeTempDir({ prefix: "archon-upgrade-" });
  const server = engineServer([`v${VERSION}`, "v0.0.2"], `${dir}/www`);
  const base = `http://127.0.0.1:${server.addr.port}/stolos/`;
  const repo = `${dir}/fleet`;
  try {
    // A fleet repository, pinned to an old tag, with the example lab fleet.
    await Deno.mkdir(`${repo}/fleets`, { recursive: true });
    await sh(ENGINE, "cp", "-r", "examples/fleets/lab", `${repo}/fleets/lab`);
    await Deno.writeTextFile(
      `${repo}/deno.json`,
      JSON.stringify({ imports: { "@stolos/": `${base}v0.0.1/src/` } }, null, 2) + "\n",
    );
    await Deno.writeTextFile(
      `${repo}/archon.ts`,
      'import { run } from "@stolos/archon/main.ts";\n\nawait run();\n',
    );
    await Deno.writeTextFile(
      `${repo}/stolos.ts`,
      'import { run } from "@stolos/stolos/main.ts";\n\nawait run();\n',
    );
    await sh(dir, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", `${dir}/key`);
    await sh(repo, "git", "init", "-q", "-b", "main");
    for (
      const [k, v] of [
        ["user.name", "test"],
        ["user.email", "test@example.invalid"],
        ["gpg.format", "ssh"],
        ["gpg.ssh.program", "ssh-keygen"],
        ["user.signingkey", `${dir}/key`],
      ]
    ) await sh(repo, "git", "config", k, v);
    await sh(repo, "git", "add", "-A");
    await sh(repo, "git", "commit", "-q", "--no-gpg-sign", "-m", "start");

    // Not a release: the engine at "v0.0.2" says it is another version.
    assertEquals(await upgrade({ tag: "v0.0.2", repo }), 1);
    // Not a tag at all, and not on the server.
    assertEquals(await upgrade({ tag: "main", repo }), 1);
    assertEquals(await upgrade({ tag: "v9.9.9", repo }), 1);
    assertStringIncludes(await Deno.readTextFile(`${repo}/deno.json`), "v0.0.1", "unchanged");

    // A change waiting in the tree: the upgrade must be a commit of its own.
    await Deno.writeTextFile(`${repo}/archon.ts`, "// changed\n", { append: true });
    assertEquals(await upgrade({ tag: `v${VERSION}`, repo }), 1);
    await sh(repo, "git", "checkout", "--", "archon.ts");

    // The real thing.
    assertEquals(await upgrade({ tag: `v${VERSION}`, repo }), 0);
    assertStringIncludes(await Deno.readTextFile(`${repo}/deno.json`), `${base}v${VERSION}/src/`);
    assertEquals(await Deno.readTextFile(`${repo}/engine.ts`), ENGINE_ENTRY_TEXT);
    const lock = await Deno.readTextFile(`${repo}/deno.lock`);
    assert(
      lock.includes(`${base}v${VERSION}/src/archon/render/man.ts`),
      "modules loaded on demand",
    );
    assert(lock.includes(`${base}v${VERSION}/src/archon/fleet/upgrade.ts`));
    const log = await sh(repo, "git", "log", "-1", "--format=%s%n%B");
    assertStringIncludes(log, `stolos v${VERSION}: adopt the engine v${VERSION}`);
    assertStringIncludes(
      await sh(repo, "git", "cat-file", "commit", "HEAD"),
      "BEGIN SSH SIGNATURE",
    );
    assertEquals(await sh(repo, "git", "status", "--porcelain"), "", "nothing left over");
    assertEquals(
      (await sh(repo, "git", "show", "--name-only", "--format=", "HEAD")).split("\n").sort(),
      // Spec 062: the bootstrap scripts and .gitattributes come with the engine;
      // spec 074: the compliance-impact workflow too.
      [
        ".gitattributes",
        ".github/workflows/compliance-impact.yml",
        "bin/bootstrap.sh",
        "bin/bootstrap.windows.ps1",
        "deno.json",
        "deno.lock",
        "engine.ts",
      ],
    );
    assertStringIncludes(
      await sh(repo, "git", "ls-files", "-s", "bin/bootstrap.sh"),
      "100755",
      "bootstrap.sh is executable on every system",
    );

    // Back to an older version: only with --downgrade (and only to a release).
    assertEquals(await upgrade({ tag: "v0.0.2", repo }), 1);
    assertEquals(await upgrade({ tag: `v${VERSION}`, repo }), 0, "already there");
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("046: an upgrade moves the engine's reusable workflows to the same tag as the pin", async () => {
  const { engineRepository, rewriteWorkflowRefs } = await import(
    "../src/archon/fleet/upgrade.ts"
  );
  const pin = { base: "https://raw.githubusercontent.com/acme/stolos/", tag: "v0.1.0" };
  assertEquals(engineRepository(pin), "acme/stolos");
  const yml = [
    "    uses: acme/stolos/.github/workflows/fleet-e2e.yml@v0.1.0",
    "    uses: other/stolos/.github/workflows/fleet-e2e.yml@v0.1.0",
    "    uses: actions/checkout@v5",
  ].join("\n");
  assertEquals(
    rewriteWorkflowRefs(yml, "acme/stolos", "v0.2.0").split("\n"),
    [
      "    uses: acme/stolos/.github/workflows/fleet-e2e.yml@v0.2.0",
      "    uses: other/stolos/.github/workflows/fleet-e2e.yml@v0.1.0",
      "    uses: actions/checkout@v5",
    ],
  );
});
