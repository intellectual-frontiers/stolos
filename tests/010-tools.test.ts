/**
 * Spec 010: the weekly tools sync, release lookups (token, gh, anonymous, a mirror), binaries only,
 * and PPAs added only when they publish for the fleet's release.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/system";
import { serve } from "@intellectual-frontiers/net";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { aptDeps } from "../src/archon/apply/apt.ts";
import { addPpa, ppaHasRelease, ppaReleaseUrl } from "../src/archon/apply/ppa.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { TOOLS } from "../src/archon/tools/catalog.ts";
import { fleet, host } from "./fixtures.ts";
import { ENGINE_ROOT, sandbox } from "./sandbox.ts";

const posix = proc.build.os !== "windows";

proves(
  ["010-tools FR-002"],
  "010: tools sync runs weekly from a timer; --report-only is offered and changes nothing it reports",
  () => {
    const plan = resolvePlan(host(), fleet());
    const t = plan.units.find((u) => u.unitName === "archon-tools-sync.timer");
    assertExists(t);
    assertEquals([t.state, t.onCalendar], ["enabled", "Mon *-*-* 04:00:00"]);
    assertStringIncludes(t.content ?? "", "OnCalendar=Mon *-*-* 04:00:00");
    const s = plan.units.find((u) => u.unitName === "archon-tools-sync.service");
    assertStringIncludes(s?.content ?? "", "ExecStart=/usr/local/bin/archon tools sync");
    const cmd = COMMANDS.find((c) => c.name === "tools sync");
    assertExists(cmd);
    assert(cmd.args.some((a) => a.name === "report-only"));
    // The first boot runs it once (install/first-boot.ts calls syncTools before the dotfiles);
    // the VM end-to-end run (tests/e2e) reaches Ready only when that sync installed every tool.
  },
);

/** Runs a release lookup in a fresh process (the token is looked up once per process). */
async function lookup(
  env: Record<string, string>,
  api: string,
): Promise<{ code: number; out: string }> {
  const sb = await sandbox("archon-release-test-");
  try {
    const file = path.join(sb.home, "lookup.ts");
    const src = JSON.stringify(
      path.toFileUrl(path.join(ENGINE_ROOT, "src", "archon", "tools", "sync.ts")).href,
    );
    await fs.writeTextFile(
      file,
      `import { latestRelease } from ${src};\nconsole.log(JSON.stringify(await latestRelease("twpayne/chezmoi", "v")));\n`,
    );
    return await sb.run(file, [], "", { ARCHON_GITHUB_API: api, ARCHON_REPO: sb.home, ...env });
  } finally {
    await fs.remove(sb.home, { recursive: true });
  }
}

proves(
  ["010-tools FR-003"],
  "010: release lookups use GITHUB_TOKEN, else gh's login, else none; ARCHON_GITHUB_API is the mirror",
  async () => {
    const seen: Array<{ path: string; auth: string | null }> = [];
    const server = await serve({ port: 0 }, (req) => {
      seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
      return Response.json({
        tag_name: "v2.70.0",
        prerelease: false,
        assets: [
          {
            name: "chezmoi_2.70.0_linux_amd64.tar.gz",
            browser_download_url: "https://example.net/c.tgz",
            digest: "sha256:" + "a".repeat(64),
          },
        ],
      });
    });
    const api = `http://127.0.0.1:${server.addr.port}`;
    const dir = await fs.makeTempDir({ prefix: "archon-gh-test-" });
    try {
      // A gh signed in, and a PATH without one.
      await fs.mkdir(path.join(dir, "with"));
      await fs.writeTextFile(path.join(dir, "with", "gh"), "#!/bin/sh\necho gho_fromgh\n");
      await fs.chmod(path.join(dir, "with", "gh"), 0o755);
      const base = ["/usr/bin", "/bin"].join(":");

      let r = await lookup({ GITHUB_TOKEN: "ghp_fromenv", PATH: `${dir}/with:${base}` }, api);
      assertEquals(r.code, 0, r.out);
      const rel = JSON.parse(r.out.trim().split("\n").pop() ?? "{}") as {
        version: string;
        assets: Array<{ digest?: string }>;
      };
      assertEquals(rel.version, "2.70.0");
      assertEquals(rel.assets[0]?.digest, "sha256:" + "a".repeat(64));
      r = await lookup({ PATH: `${dir}/with:${base}` }, api);
      assertEquals(r.code, 0, r.out);
      r = await lookup({ PATH: base }, api);
      assertEquals(r.code, 0, r.out);
      assertEquals(seen, [
        { path: "/repos/twpayne/chezmoi/releases/latest", auth: "Bearer ghp_fromenv" },
        { path: "/repos/twpayne/chezmoi/releases/latest", auth: "Bearer gho_fromgh" },
        { path: "/repos/twpayne/chezmoi/releases/latest", auth: null },
      ]);
    } finally {
      await server.shutdown();
      await fs.remove(dir, { recursive: true });
    }
  },
  { skip: posix ? false : "a stand-in gh written as a POSIX shell script" },
);

proves(
  ["010-tools FR-004"],
  "010: nothing is built from source: binaries and packages only",
  () => {
    for (const t of TOOLS) {
      assert(
        ["apt", "upstream-binary", "self-updating"].includes(t.source),
        `${t.id}: ${t.source}`,
      );
      if (t.source === "upstream-binary") {
        // A release asset, checked against its digest (or the engine's pin), never a source tarball.
        assertExists(t.github, t.id);
        assert(
          !t.github.asset("amd64", "1.0.0").test("v1.0.0.tar.gz"),
          `${t.id}: not the source archive`,
        );
        assert(!t.github.asset("amd64", "1.0.0").test("source.tar.gz"), t.id);
      }
      for (const c of [t.verify, t.versionCommand]) {
        assert(!/\b(make|cargo build|go build|cmake|configure)\b/.test(c), `${t.id}: ${c}`);
      }
    }
  },
);

proves(
  ["010-tools FR-005"],
  "010: a PPA is added only when it publishes InRelease for the release; add-apt-repository adds it",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-ppa-test-" });
    const saved = proc.env.get("PATH") ?? "";
    const sleep = aptDeps.sleep;
    try {
      assertEquals(
        ppaReleaseUrl("git-core/ppa", "resolute"),
        "https://ppa.launchpadcontent.net/git-core/ppa/ubuntu/dists/resolute/InRelease",
      );
      // A curl that answers with the HTTP status in $STATUS and logs what it was asked.
      await fs.writeTextFile(
        path.join(dir, "curl"),
        `#!/bin/sh\necho "$*" >> "${dir}/curl.log"\nprintf '%s' "$(cat "${dir}/status")"\n`,
      );
      await fs.writeTextFile(
        path.join(dir, "add-apt-repository"),
        `#!/bin/sh\necho "$*" >> "${dir}/aar.log"\n`,
      );
      for (const f of ["curl", "add-apt-repository"]) await fs.chmod(path.join(dir, f), 0o755);
      proc.env.set("PATH", `${dir}:${saved}`);
      aptDeps.sleep = () => Promise.resolve();
      const answer = async (status: string, o = {}) => {
        await fs.writeTextFile(path.join(dir, "status"), status);
        return (await ppaHasRelease("git-core/ppa", "resolute", o)).answer;
      };
      assertEquals(await answer("200"), "yes");
      assertEquals(await answer("404"), "no", "no builds for this release: Ubuntu's package stays");
      assertEquals(await answer("000", { retries: false }), "unreachable");
      const asked = (await fs.readTextFile(path.join(dir, "curl.log"))).trim().split("\n");
      assert(
        asked.every((l) =>
          l.endsWith(
            " https://ppa.launchpadcontent.net/git-core/ppa/ubuntu/dists/resolute/InRelease",
          ),
        ),
      );
      // IPv4 only where the network routes no IPv6 (spec 009).
      await answer("200", { ipv4Only: true });
      assertStringIncludes(
        (await fs.readTextFile(path.join(dir, "curl.log"))).trim().split("\n").pop() ?? "",
        "-sS -4 ",
      );
      // Ubuntu's add-apt-repository adds it (it fetches the key from Launchpad, deb822 with Signed-By).
      assert((await addPpa("git-core/ppa")).ok);
      assertEquals(
        (await fs.readTextFile(path.join(dir, "aar.log"))).trim(),
        "--yes --no-update ppa:git-core/ppa",
      );
    } finally {
      proc.env.set("PATH", saved);
      aptDeps.sleep = sleep;
      await fs.remove(dir, { recursive: true });
    }
  },
  {
    skip: posix
      ? false
      : "stand-ins for curl and add-apt-repository written as POSIX shell scripts",
  },
);
