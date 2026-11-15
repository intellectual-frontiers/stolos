/**
 * Spec 054: power off and reboot wait for apt and dpkg.
 *
 * @module
 */
import { assertEquals, proves } from "@intellectual-frontiers/ifc-ts/runtime/test";
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
