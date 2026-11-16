/**
 * Spec 054: power off and reboot wait for apt and dpkg.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { ENGINE_ROOT, sandbox } from "./sandbox.ts";
import { packageWork } from "../src/archon/install/apt-busy.ts";

proves(["054-safe-power FR-001"], "054: what is changing packages, from ps's command lines", () => {
  assertEquals(packageWork("/sbin/init\n-bash\nsshd: tester [priv]\n"), []);
  // Always running on Ubuntu servers, waiting for a shutdown: not package work.
  assertEquals(
    packageWork(
      "/usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal\n",
    ),
    [],
  );
  assertEquals(
    packageWork(
      "/usr/bin/python3 /usr/bin/unattended-upgrade --download-only\n/usr/bin/dpkg --status-fd 3 --configure\n",
    ),
    ["dpkg", "unattended-upgrade"],
  );
  assertEquals(packageWork("apt-get install -y curl\n"), ["apt-get"]);
  // PackageKit idles in the background; names that merely contain one do not count.
  assertEquals(
    packageWork("/usr/libexec/packagekitd\n/usr/bin/dpkg-deb -x a b\naptd-helper\n"),
    [],
  );
});

proves(
  ["054-safe-power FR-002", "053-where-am-i FR-004", "059-stolos-and-archon FR-003"],
  "054/053: on a machine, archon (no arguments) is archon state, and warns while packages change",
  async () => {
    const sb = await sandbox("archon-power-test-");
    try {
      // ps as it reads while unattended-upgrades runs, then while nothing changes packages.
      const bin = path.join(sb.home, "bin");
      await fs.mkdir(bin);
      const ps = path.join(bin, "ps");
      const env = {
        ARCHON_REPO: path.join(ENGINE_ROOT, "examples"),
        ARCHON_FLEET: "lab",
        PATH: `${bin}:${proc.env.get("PATH")}`,
      };
      const archon = (...args: string[]) => sb.run("src/archon/main.ts", args, "", env);
      const steady = (s: string) =>
        s
          .replace(/ in \d+(\.\d+)?m?s/g, "")
          .replace(/log: \S+/g, "log")
          .replace(/"at": "[^"]*"/g, '"at"')
          .trim();
      await fs.writeTextFile(
        ps,
        "#!/bin/sh\necho '/sbin/init'\necho '/usr/bin/python3 /usr/bin/unattended-upgrade'\n",
      );
      await fs.chmod(ps, 0o755);
      const bare = await archon("--host", "alpha");
      const state = await archon("--host", "alpha", "state");
      assertEquals(steady(bare.out), steady(state.out), "archon is archon state");
      assertEquals(bare.code, state.code);
      assertStringIncludes(bare.out, "State of alpha");
      assertStringIncludes(
        bare.out,
        "unattended-upgrade is changing packages now: do not power this machine off",
      );
      assertStringIncludes(bare.out, "E009-APT-BUSY");
      assertEquals(
        steady((await archon("--host", "alpha", "--json")).out),
        steady((await archon("--host", "alpha", "--json", "state")).out),
      );
      await fs.writeTextFile(ps, "#!/bin/sh\necho '/sbin/init'\n");
      const quiet = await archon("--host", "alpha");
      assert(!quiet.out.includes("E009-APT-BUSY"), quiet.out);
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  {
    timeout: 120_000,
    skip: proc.build.os === "windows" && "a machine is Linux (its ps here is a shell script)",
  },
);
