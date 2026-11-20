/**
 * Spec 045: bun run stolos boot retire.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  test,
  proves,
} from "@intellectual-frontiers/test";
import { publishedNames, retireRefusal } from "../src/archon-boot/retire.ts";
import { deleteRecords } from "../src/archon/web/cloudflare.ts";
import { at, list } from "./fixtures.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";

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

/**
 * A fleet repository (the example lab) in a sandbox, as a boot machine holds it before retiring
 * beta: an install token, beta's secrets folder, known_hosts lines, a mail credential, and `ssh`
 * and `gh` on the PATH as stand-ins (the host's answer, GitHub's deploy keys), each logging what it
 * was asked.
 */
async function retireSandbox() {
  const sb = await sandbox("archon-retire-test-");
  const home = sb.home;
  const repo = path.join(home, "fleet");
  const fleetDir = path.join(repo, "fleets", "lab");
  await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
  await proc.output(["cp", "-r", path.join(ENGINE_ROOT, "examples/fleets/lab"), fleetDir]);
  await linkEngine(repo);
  // beta has a local DNS name on the router (site.ts), an address, and was installed from another.
  const betaFile = path.join(fleetDir, "hosts", "beta", "host.ts");
  await fs.writeTextFile(
    betaFile,
    (await fs.readTextFile(betaFile)).replace(
      '  name: "beta",',
      '  name: "beta",\n  ip: "10.0.1.20",\n  dnsName: "beta.lan",',
    ),
  );
  const siteFile = path.join(fleetDir, "site.ts");
  await fs.writeTextFile(siteFile, `${await fs.readTextFile(siteFile)}// beta.lan 10.0.1.20\n`);
  const secrets = path.join(home, "config", "stolos", "secrets", "lab");
  await fs.mkdir(path.join(secrets, "hosts", "beta", "letsencrypt"), { recursive: true });
  await fs.mkdir(path.join(secrets, "hosts", "alpha"), { recursive: true });
  await fs.writeTextFile(path.join(secrets, "hosts", "beta", "deploy-key"), "k\n");
  await fs.writeTextFile(path.join(secrets, "hosts", "alpha", "deploy-key"), "k\n");
  await fs.writeTextFile(
    path.join(secrets, "install-tokens.json"),
    JSON.stringify([
      { host: "beta", token: "tb", armed: "2026-11-01T00:00:00Z", addresses: ["10.0.30.99"] },
      { host: "alpha", token: "ta", armed: "2026-11-01T00:00:00Z" },
    ]),
  );
  await fs.writeTextFile(
    path.join(secrets, "mail.json"),
    JSON.stringify({ token: "cfat_test", created: "2026-11-01T00:00:00Z" }),
  );
  // known_hosts: beta under its name, DNS name, IP, and install address; alpha too.
  const ssh = path.join(home, ".ssh");
  await fs.mkdir(ssh, { recursive: true });
  const key = path.join(home, "hostkey");
  await proc.output(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]);
  const pub = (await fs.readTextFile(`${key}.pub`)).trim().split(" ").slice(0, 2).join(" ");
  await fs.writeTextFile(
    path.join(ssh, "known_hosts"),
    ["beta", "beta.lan", "10.0.1.20", "10.0.30.99", "alpha"].map((n) => `${n} ${pub}\n`).join(""),
  );
  const bin = path.join(home, "bin");
  await fs.mkdir(bin);
  const log = path.join(home, "calls.log");
  // ssh: beta answers `archon data --json` as durable; alpha does not answer.
  await fs.writeTextFile(
    path.join(bin, "ssh"),
    `#!/bin/sh\necho "ssh $*" >> '${log}'\ncase "$*" in *@beta*) echo '{"host":"beta","class":"durable","reasons":["PostgreSQL"]}';; *) exit 255;; esac\n`,
  );
  await fs.writeTextFile(
    path.join(bin, "gh"),
    `#!/bin/sh\necho "gh $*" >> '${log}'\ncase "$*" in *--paginate*) echo '[{"id":1,"title":"archon host beta"},{"id":2,"title":"archon host alpha"},{"id":3,"title":"archon host beta"}]';; esac\n`,
  );
  for (const f of ["ssh", "gh"]) await fs.chmod(path.join(bin, f), 0o755);
  // The relay does not answer, so the message stays in the boot machine's spool, to be read.
  const script = path.join(home, "retire.ts");
  const src = (rel: string) => JSON.stringify(new URL(`../src/${rel}`, import.meta.url).href);
  await fs.writeTextFile(
    script,
    `import { sendDeps } from ${src("archon/notify/notify.ts")};
import { retire } from ${src("archon-boot/retire.ts")};
sendDeps.smtp = () => Promise.reject(new Error("no relay in tests"));
const [name, confirm] = process.argv.slice(2);
process.exitCode = await retire(name, confirm === "-" ? undefined : confirm, false);
`,
  );
  const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab", PATH: `${bin}:${proc.env.get("PATH")}` };
  const run = (name: string, confirm?: string) => sb.run(script, [name, confirm ?? "-"], "", env);
  const spool = path.join(home, "data", "stolos", "notify");
  const messages = async (): Promise<string[]> => {
    const out: string[] = [];
    for await (const e of fs.readDir(spool)) {
      const t = await fs.readTextFile(path.join(spool, e.name));
      if (t.includes('"subject"')) out.push(t);
    }
    return out;
  };
  return { home, repo, fleetDir, secrets, ssh, log, run, messages };
}

proves(
  [
    "045-retire FR-002",
    "045-retire FR-004",
    "045-retire FR-005",
    "045-retire FR-007",
    "045-retire FR-008",
  ],
  "045: retire asks the host first, then removes its deploy keys, this PC's traces, and tells the mailbox",
  async () => {
    const s = await retireSandbox();
    try {
      // Without the name repeated: the host's class is said, and nothing is removed.
      let r = await s.run("beta");
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "beta is durable");
      assertStringIncludes(r.out, "--confirm-destroy beta");
      assert(await fs.exists(path.join(s.secrets, "hosts", "beta")), "nothing removed yet");
      assert(!((await fs.readTextOr(s.log)) ?? "").includes("gh "), "GitHub not touched");

      r = await s.run("beta", "beta");
      assertEquals(r.code, 0, r.out);
      // FR-002: asked over SSH, and the durable warning comes before any removal.
      assertStringIncludes(await fs.readTextFile(s.log), "archon data --json");
      const warned = r.out.indexOf("its data is lost with it");
      assert(warned >= 0, r.out);
      assert(warned < r.out.indexOf("install token and secrets removed"), "said before removing");
      // FR-004: every deploy key titled "archon host beta", and no other.
      const calls = (await fs.readTextFile(s.log)).split("\n");
      assertEquals(
        calls.filter((c) => c.startsWith("gh api -X DELETE")),
        [
          "gh api -X DELETE repos/example/fleet/keys/1",
          "gh api -X DELETE repos/example/fleet/keys/3",
        ],
      );
      // FR-005: its install token, secrets folder, and known_hosts lines; alpha's stay.
      const tokens: unknown = JSON.parse(
        await fs.readTextFile(path.join(s.secrets, "install-tokens.json")),
      );
      assertEquals(
        list(tokens).map((t) => at(t, "host")),
        ["alpha"],
      );
      assert(!(await fs.exists(path.join(s.secrets, "hosts", "beta"))));
      assert(await fs.exists(path.join(s.secrets, "hosts", "alpha", "deploy-key")));
      const known = await fs.readTextFile(path.join(s.ssh, "known_hosts"));
      assertEquals(
        known
          .trim()
          .split("\n")
          .map((l) => l.split(" ")[0]),
        ["alpha"],
      );
      assert(!(await fs.exists(path.join(s.fleetDir, "hosts", "beta"))), "its model is gone");
      // FR-007: the router's record is the owner's; the vault keeps the old secrets until a backup.
      assertStringIncludes(r.out, "remove the local DNS record beta.lan");
      assertStringIncludes(r.out, "fleets/<fleet>/site.ts");
      assertStringIncludes(r.out, "bun run stolos vault backup");
      assertStringIncludes(await fs.readTextFile(path.join(s.fleetDir, "site.ts")), "beta.lan");
      // FR-008: the mailbox is told what was removed.
      const mail = (await s.messages()).join("\n");
      assertStringIncludes(mail, "beta retired");
      assertStringIncludes(mail, "deploy key, install token, SSH identity, model, and records");

      // A host that does not answer: its records say what it is, before anything is removed.
      r = await s.run("alpha", "alpha");
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "not answering; its records say");
      assert(!r.out.includes("remove the local DNS record"), "alpha has no router record");
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
  {
    skip: proc.build.os === "windows" && "the stand-ins for ssh and gh are shell scripts",
  },
);
