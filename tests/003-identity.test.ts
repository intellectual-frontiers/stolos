/**
 * Spec 003: the fleet's identity from GitHub, and the boot machine's secret store.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { githubIdentity } from "../src/archon/identity/fleet-init.ts";
import { KEY } from "./fixtures.ts";
import { ENGINE_ROOT, sandbox } from "./sandbox.ts";

const posix = proc.build.os !== "windows";

proves(
  ["003-identity FR-001"],
  "003: the identity comes from gh api user and the account's published .keys",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-identity-test-" });
    const savedPath = proc.env.get("PATH") ?? "";
    const savedFetch = globalThis.fetch;
    const asked: string[] = [];
    try {
      // A gh that is signed in: what `gh api user` prints (GitHub's REST user object).
      await fs.writeTextFile(
        path.join(dir, "gh"),
        `#!/bin/sh
echo "$*" >> "${dir}/gh.log"
[ "$1 $2" = "api user" ] || exit 2
echo '{"login":"alice","id":1000001,"name":"Alice Example","type":"User"}'
`,
      );
      await fs.chmod(path.join(dir, "gh"), 0o755);
      proc.env.set("PATH", `${dir}:${savedPath}`);
      globalThis.fetch = (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        asked.push(url);
        return Promise.resolve(
          new Response(
            `${KEY}\n\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsecondsecondsecondsecondsecondsecondsec\n`,
          ),
        );
      };
      const id = await githubIdentity();
      assertEquals(asked, ["https://github.com/alice.keys"]);
      assertEquals((await fs.readTextFile(path.join(dir, "gh.log"))).trim(), "api user");
      assertEquals(id, {
        login: "alice",
        id: 1000001,
        name: "Alice Example",
        email: "1000001+alice@users.noreply.github.com",
        sshKeys: [
          KEY,
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsecondsecondsecondsecondsecondsecondsec",
        ],
      });
      // An account without a display name is named by its login.
      await fs.writeTextFile(
        path.join(dir, "gh"),
        `#!/bin/sh\necho '{"login":"bob","id":7,"name":null}'\n`,
      );
      assertEquals((await githubIdentity()).name, "bob");
      // gh signed out: the fix says how to sign in.
      await fs.writeTextFile(path.join(dir, "gh"), "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n");
      const e = await githubIdentity().then(
        () => "",
        (x: unknown) => (x instanceof Error ? x.message : String(x)),
      );
      assertStringIncludes(e, "gh auth login");
    } finally {
      proc.env.set("PATH", savedPath);
      globalThis.fetch = savedFetch;
      await fs.remove(dir, { recursive: true });
    }
  },
  { skip: posix ? false : "a stand-in gh written as a POSIX shell script" },
);

proves(
  ["003-identity FR-002"],
  "003: the secret store is per user, outside the repository, owner-only, with its three kinds of secret",
  async () => {
    const sb = await sandbox("archon-secrets-test-");
    try {
      const file = path.join(sb.home, "probe.ts");
      const src = (rel: string) =>
        JSON.stringify(path.toFileUrl(path.join(ENGINE_ROOT, "src", "archon", rel)).href);
      await fs.writeTextFile(
        file,
        `import { statSync } from "node:fs";
import { SECRETS, writeSecret, armHost } from ${src("core/secrets.ts")};
await writeSecret(SECRETS.adminPasswordHash, "$6$salt$hash\\n");
await writeSecret(SECRETS.deployKey("alpha"), "-----BEGIN OPENSSH PRIVATE KEY-----\\nx\\n-----END OPENSSH PRIVATE KEY-----\\n");
await armHost("alpha");
const mode = (p) => statSync(p).mode & 0o777;
console.log(JSON.stringify({
  dir: SECRETS.dir,
  files: [SECRETS.adminPasswordHash, SECRETS.deployKey("alpha"), SECRETS.tokens],
  modes: [SECRETS.dir, SECRETS.adminPasswordHash, SECRETS.deployKey("alpha"), SECRETS.tokens].map(mode),
}));`,
      );
      const repo = path.join(sb.home, "fleet");
      await fs.mkdir(path.join(repo, "fleets", "lab"), { recursive: true });
      const r = await sb.run(file, [], "", { ARCHON_REPO: repo, ARCHON_FLEET: "lab" });
      assertEquals(r.code, 0, r.out);
      const got = JSON.parse(r.out.trim().split("\n").pop() ?? "{}") as {
        dir: string;
        files: string[];
        modes: number[];
      };
      // ~/.config (XDG_CONFIG_HOME) on Linux, %APPDATA% on Windows: the sandbox points both at one
      // folder, so the layout is the same on either. Per fleet, never inside the repository.
      const dir = path.join(sb.home, "config", "stolos", "secrets", "lab");
      assertEquals(got.dir, dir);
      assertEquals(got.files, [
        path.join(dir, "admin-password.hash"),
        path.join(dir, "hosts", "alpha", "deploy_key"),
        path.join(dir, "install-tokens.json"),
      ]);
      if (posix) assertEquals(got.modes, [0o700, 0o600, 0o600, 0o600]);
      const tokens = JSON.parse(
        await fs.readTextFile(path.join(dir, "install-tokens.json")),
      ) as Array<{
        host: string;
      }>;
      assertEquals(
        tokens.map((t) => t.host),
        ["alpha"],
      );
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);
