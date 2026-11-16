/**
 * Spec 009: Ubuntu's unattended upgrades verified, the PPAs followed, and the DNS and IPv6 checks.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { fleet, host } from "./fixtures.ts";

const plan = resolvePlan(host(), fleet());

proves(
  ["009-updates FR-001"],
  "009: unattended-upgrades installed and enabled, apt-daily-upgrade.timer enabled, both verified",
  () => {
    // Ubuntu installs it (spec 001 relies on it too); spec 009 asks for it as well.
    assert(plan.packages.some((p) => p.name === "unattended-upgrades"));
    const timer = plan.units.find((u) => u.unitName === "apt-daily-upgrade.timer");
    assertEquals(
      [timer?.managed, timer?.state, timer?.verify],
      [false, "enabled", "systemctl is-enabled apt-daily-upgrade.timer"],
    );
    const service = plan.units.find((u) => u.unitName === "unattended-upgrades.service");
    assertEquals(
      [service?.managed, service?.verify],
      [false, "systemctl is-enabled unattended-upgrades.service"],
    );
  },
);

proves(
  ["009-updates FR-003"],
  "009: 52archon-ppas (spec 010) lets unattended-upgrades follow the PPAs and vendors' repositories",
  () => {
    const f = plan.files.find((x) => x.path === "/etc/apt/apt.conf.d/52archon-ppas");
    assertExists(f);
    assertEquals(f.spec, "010-tools");
    const text = f.content ?? "";
    // The maintainers' PPAs by origin, for this release.
    assertStringIncludes(text, "Unattended-Upgrade::Allowed-Origins {");
    for (const origin of ["LP-PPA-git-core", "LP-PPA-fish-shell-release-4"]) {
      assertStringIncludes(text, `"${origin}:\${distro_codename}";`);
    }
    // And each vendor's repository by its site (spec 010 FR-007).
    assertStringIncludes(text, "Unattended-Upgrade::Origins-Pattern {");
    assert(plan.aptRepos.length > 0);
    for (const r of plan.aptRepos) assertStringIncludes(text, `"site=${r.site}";`);
  },
);

proves(
  ["009-updates FR-009"],
  "009: verify warns, never fails, when DNS returns no IPv4, or IPv4-only apt is missing without IPv6",
  () => {
    const dns = plan.checks.find((c) => c.name === "dns:ipv4");
    assertExists(dns);
    assertEquals(
      [dns.command, dns.level, dns.fix],
      [
        "getent ahostsv4 archive.ubuntu.com",
        "warn",
        "DNS isn't returning IPv4 addresses; check the router's upstream DNS",
      ],
    );
    const v4 = plan.checks.find((c) => c.name === "apt:ipv4-only");
    assertExists(v4);
    assertEquals(v4.level, "warn");
    // Only where there is no global IPv6 default route; then 52archon-network must force IPv4.
    assertStringIncludes(v4.command, "ip -6 route show default | grep -q . ||");
    assertStringIncludes(v4.command, "/etc/apt/apt.conf.d/52archon-network");
    assertStringIncludes(v4.command, "Acquire::ForceIPv4");
  },
);
