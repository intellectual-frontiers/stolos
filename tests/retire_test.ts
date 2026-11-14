// Spec 045: deno task stolos boot retire.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { publishedNames, retireRefusal } from "../src/archon-boot/retire.ts";
import { deleteRecords } from "../src/archon/web/cloudflare.ts";

Deno.test("045: retiring always needs the name repeated, by a person", () => {
  assertStringIncludes(retireRefusal("alpha", undefined, "")!, "--confirm-destroy alpha");
  assertStringIncludes(retireRefusal("alpha", "beta", "")!, "does not name alpha");
  assertEquals(retireRefusal("alpha", "alpha", ""), undefined);
  assertStringIncludes(retireRefusal("alpha", "alpha", "mcp")!, "typed by a person");
});

Deno.test("045: its two published names leave Cloudflare, and nothing else", async () => {
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
  assertEquals(calls.filter((c) => c.startsWith("DELETE")), ["DELETE /zones/z1/dns_records/r1"]);
  assert(!calls.some((c) => c.includes("beta")));
});

Deno.test("045/004: the change is committed and pushed, and nothing else in the tree", async () => {
  const { publishChange } = await import("../src/archon/install/publish.ts");
  const root = await Deno.makeTempDir({ prefix: "archon-publish-" });
  const sh = (cwd: string, ...a: string[]) =>
    new Deno.Command("git", { args: a, cwd, stdout: "null", stderr: "null" }).output();
  try {
    await sh(root, "init", "-q", "--bare", "-b", "main", "remote.git");
    await sh(root, "clone", "-q", "remote.git", "work");
    const work = `${root}/work`;
    await sh(work, "config", "user.email", "test@example.invalid");
    await sh(work, "config", "user.name", "test");
    await Deno.mkdir(`${work}/fleets/lab/hosts/beta`, { recursive: true });
    await Deno.writeTextFile(`${work}/fleets/lab/hosts/beta/host.ts`, "export {};\n");
    await Deno.writeTextFile(`${work}/.mcp.json`, "{}\n");
    await Deno.writeTextFile(`${work}/unrelated.txt`, "mine\n");
    const ok = await publishChange(
      ["fleets/lab/hosts/beta/host.ts"],
      "004-install: add host beta",
      {
        repo: work,
        build: false,
      },
    );
    assert(ok);
    const log = await new Deno.Command("git", {
      args: ["--git-dir", `${root}/remote.git`, "log", "--name-only", "--format=%s", "main"],
      stdout: "piped",
    }).output();
    const out = new TextDecoder().decode(log.stdout);
    assertStringIncludes(out, "004-install: add host beta");
    assertStringIncludes(out, "fleets/lab/hosts/beta/host.ts");
    assertStringIncludes(out, ".mcp.json");
    assert(!out.includes("unrelated.txt"), "only the change and what build renders");
    // Nothing new: no empty commit.
    assert(
      await publishChange(["fleets/lab/hosts/beta/host.ts"], "again", { repo: work, build: false }),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("045/004: a boot machine without a Git identity commits as the fleet's admin", async () => {
  const { publishChange } = await import("../src/archon/install/publish.ts");
  const root = await Deno.makeTempDir({ prefix: "archon-publish-id-" });
  const saved = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "EMAIL"].map((k) =>
    [k, Deno.env.get(k)] as const
  );
  Deno.env.set("GIT_CONFIG_GLOBAL", `${root}/no-global`);
  Deno.env.set("GIT_CONFIG_NOSYSTEM", "1");
  Deno.env.delete("EMAIL");
  const sh = (cwd: string, ...a: string[]) =>
    new Deno.Command("git", { args: a, cwd, stdout: "piped", stderr: "null" }).output();
  try {
    await sh(root, "init", "-q", "--bare", "-b", "main", "remote.git");
    await sh(root, "clone", "-q", "remote.git", "work");
    const work = `${root}/work`;
    await Deno.writeTextFile(`${work}/a.txt`, "a\n");
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
    for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("004: a new host's model has prime and is formatted as the repository is", async () => {
  const { hostSource } = await import("../src/archon/install/host-add.ts");
  const dir = await Deno.makeTempDir({ prefix: "archon-hostsrc-" });
  try {
    const src = hostSource({ name: "beta", disk: { match: "largest", layout: "lvm" } });
    assertStringIncludes(src, "pg: { instances: [PRIME] }");
    assertStringIncludes(src, 'disk: { match: "largest", layout: "lvm" }');
    await Deno.writeTextFile(`${dir}/beta.ts`, src);
    const fmt = await new Deno.Command(Deno.execPath(), {
      args: ["fmt", "--check", "--line-width", "100", `${dir}/beta.ts`],
      stdout: "null",
      stderr: "null",
    }).output();
    assert(fmt.success, "deno fmt leaves a new host's file as it is");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
