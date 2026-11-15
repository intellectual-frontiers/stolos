/**
 * Spec 045: bun run stolos boot retire.
 *
 * @module
 */
import { fs, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  test,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { publishedNames, retireRefusal } from "../src/archon-boot/retire.ts";
import { deleteRecords } from "../src/archon/web/cloudflare.ts";

proves(
  ["045-retire FR-001", "044-durable FR-005"],
  "045: retiring always needs the name repeated, by a person",
  () => {
    assertStringIncludes(retireRefusal("alpha", undefined, "") ?? "", "--confirm-destroy alpha");
    assertStringIncludes(retireRefusal("alpha", "beta", "") ?? "", "does not name alpha");
    assertEquals(retireRefusal("alpha", "alpha", ""), undefined);
    assertStringIncludes(retireRefusal("alpha", "alpha", "mcp") ?? "", "typed by a person");
  },
);

proves(
  ["045-retire FR-003"],
  "045: its two published names leave Cloudflare, and nothing else",
  async () => {
    assertEquals(publishedNames("alpha", "lab.example.net"), [
      "alpha.lab.example.net",
      "*.alpha.lab.example.net",
    ]);
    const calls: string[] = [];
    const fake = ((url: string, init?: RequestInit) => {
      calls.push(
        `${init?.method ?? "GET"} ${url.replace("https://api.cloudflare.com/client/v4", "")}`,
      );
      const result = url.includes("/zones?name=")
        ? [{ id: "z1", name: "example.net" }]
        : url.includes("dns_records?type=A&name=alpha.")
          ? [{ id: "r1" }]
          : url.includes("dns_records?type=A&name=")
            ? []
            : {};
      return Promise.resolve(new Response(JSON.stringify({ success: true, result })));
    }) as typeof fetch;
    const gone = await deleteRecords(
      "t",
      "example.net",
      publishedNames("alpha", "lab.example.net"),
      fake,
    );
    assertEquals(gone, ["alpha.lab.example.net"]);
    assertEquals(
      calls.filter((c) => c.startsWith("DELETE")),
      ["DELETE /zones/z1/dns_records/r1"],
    );
    assert(!calls.some((c) => c.includes("beta")));
  },
);

proves(
  ["045-retire FR-006"],
  "045/004: the change is committed and pushed, and nothing else in the tree",
  async () => {
    const { publishChange } = await import("../src/archon/install/publish.ts");
    const root = await fs.makeTempDir({ prefix: "archon-publish-" });
    const sh = (cwd: string, ...a: string[]) =>
      proc.output(["git", ...a], { cwd, stdout: "null", stderr: "null" });
    try {
      await sh(root, "init", "-q", "--bare", "-b", "main", "remote.git");
      await sh(root, "clone", "-q", "remote.git", "work");
      const work = `${root}/work`;
      await sh(work, "config", "user.email", "test@example.invalid");
      await sh(work, "config", "user.name", "test");
      await fs.mkdir(`${work}/fleets/lab/hosts/beta`, { recursive: true });
      await fs.writeTextFile(`${work}/fleets/lab/hosts/beta/host.ts`, "export {};\n");
      await fs.writeTextFile(`${work}/.mcp.json`, "{}\n");
      await fs.writeTextFile(`${work}/unrelated.txt`, "mine\n");
      const ok = await publishChange(
        ["fleets/lab/hosts/beta/host.ts"],
        "004-install: add host beta",
        {
          repo: work,
          build: false,
        },
      );
      assert(ok);
      const log = await proc.output(
        ["git", "--git-dir", `${root}/remote.git`, "log", "--name-only", "--format=%s", "main"],
        { stdout: "piped" },
      );
      const out = new TextDecoder().decode(log.stdout);
      assertStringIncludes(out, "004-install: add host beta");
      assertStringIncludes(out, "fleets/lab/hosts/beta/host.ts");
      assertStringIncludes(out, ".mcp.json");
      assert(!out.includes("unrelated.txt"), "only the change and what build renders");
      // Nothing new: no empty commit.
      assert(
        await publishChange(["fleets/lab/hosts/beta/host.ts"], "again", {
          repo: work,
          build: false,
        }),
      );
    } finally {
      await fs.remove(root, { recursive: true });
    }
  },
);

test("045/004: a boot machine without a Git identity commits as the fleet's admin", async () => {
  const { publishChange } = await import("../src/archon/install/publish.ts");
  const root = await fs.makeTempDir({ prefix: "archon-publish-id-" });
  const saved = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "EMAIL"].map(
    (k) => [k, proc.env.get(k)] as const,
  );
  proc.env.set("GIT_CONFIG_GLOBAL", `${root}/no-global`);
  proc.env.set("GIT_CONFIG_NOSYSTEM", "1");
  proc.env.delete("EMAIL");
  const sh = (cwd: string, ...a: string[]) =>
    proc.output(["git", ...a], { cwd, stdout: "piped", stderr: "null" });
  try {
    await sh(root, "init", "-q", "--bare", "-b", "main", "remote.git");
    await sh(root, "clone", "-q", "remote.git", "work");
    const work = `${root}/work`;
    await fs.writeTextFile(`${work}/a.txt`, "a\n");
    assert(
      await publishChange(["a.txt"], "045-retire: test", {
        repo: work,
        build: false,
        identity: { name: "Alice Example", email: "1000001+alice@users.noreply.github.com" },
      }),
    );
    const log = await sh(`${root}/remote.git`, "log", "--format=%an <%ae>", "main");
    assertEquals(
      new TextDecoder().decode(log.stdout).trim(),
      "Alice Example <1000001+alice@users.noreply.github.com>",
    );
  } finally {
    for (const [k, v] of saved) v === undefined ? proc.env.delete(k) : proc.env.set(k, v);
    await fs.remove(root, { recursive: true });
  }
});

test("004: a new host's model has prime and is formatted as the repository is", async () => {
  const { hostSource } = await import("../src/archon/install/host-add.ts");
  const dir = await fs.makeTempDir({ prefix: "archon-hostsrc-" });
  try {
    const src = hostSource({ name: "beta", disk: { match: "largest", layout: "lvm" } });
    assertStringIncludes(src, "pg: { instances: [PRIME] }");
    assertStringIncludes(src, 'disk: { match: "largest", layout: "lvm" }');
    await fs.writeTextFile(`${dir}/beta.ts`, src);
    // bun fmt, as the engine's bunfig.toml sets it (width 100), run from the engine's folder.
    const fmt = await proc.output(["bun", "fmt", "--check", `${dir}/beta.ts`], {
      stdout: "null",
      stderr: "null",
    });
    assert(fmt.success, "bun fmt leaves a new host's file as it is");
  } finally {
    await fs.remove(dir, { recursive: true });
  }
});
