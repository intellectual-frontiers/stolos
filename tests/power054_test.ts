// Spec 054: power off and reboot wait for apt and dpkg.
import { assertEquals } from "./assert.ts";
import { packageWork } from "../src/archon/install/apt-busy.ts";

Deno.test("054: what is changing packages, from ps", () => {
  assertEquals(packageWork("systemd\nbash\nsshd\n"), []);
  assertEquals(packageWork("systemd\nunattended-upgr\ndpkg\n"), ["dpkg", "unattended-upgrades"]);
  assertEquals(packageWork("apt-get\n"), ["apt-get"]);
  // PackageKit idles in the background: alone, it is not work.
  assertEquals(packageWork("packagekitd\n"), []);
  assertEquals(packageWork("packagekitd\napt\n"), ["apt", "packagekitd"]);
  // Names that merely contain one do not count.
  assertEquals(packageWork("aptd-helper\ndpkg-deb-x\n"), []);
});
