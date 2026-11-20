/**
 * Spec 022 (Cockpit): Ubuntu's web console on every server, as the plan renders it. The VM e2e
 * (tests/e2e/ci.sh, lib.sh: install to Ready, `archon verify` after a reboot) checks beyond it that
 * cockpit.socket is active on a real Ubuntu host (its verify command).
 *
 * @module
 */

import { assert, assertEquals, proves } from "@intellectual-frontiers/test";
import { aptDeps, aptInstall } from "../src/archon/apply/apt.ts";
import { workstation } from "../src/archon/capabilities/mod.ts";
import { LOCAL_NETWORKS } from "../src/archon/capabilities/ssh.ts";
import { ui } from "../src/archon/core/ui.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { fleet, host } from "./fixtures.ts";

proves(
  ["022-cockpit FR-001"],
  "022: the cockpit package, installed without apt's recommended extras",
  async () => {
    const plan = resolvePlan(host(), fleet());
    assert(plan.packages.some((p) => p.name === "cockpit"));
    // No separate cockpit-pcp (cockpit-bridge provides it), nor the desktop stack beside netplan.
    for (const n of ["cockpit-pcp", "network-manager", "packagekit", "udisks2"]) {
      assert(!plan.packages.some((p) => p.name === n), n);
    }
    const calls: string[][] = [];
    const real = { ...aptDeps };
    aptDeps.stream = (argv) => {
      calls.push([...argv]);
      return Promise.resolve(0);
    };
    try {
      const r = await aptInstall(ui.phase("Packages"), ["cockpit"]);
      assertEquals(r.ok, true);
    } finally {
      Object.assign(aptDeps, real);
    }
    const install = calls.find((c) => c.includes("install"));
    assert(install !== undefined, JSON.stringify(calls));
    assert(install.includes("--no-install-recommends"), JSON.stringify(calls));
    assert(install.includes("cockpit"));
  },
);

proves(
  ["022-cockpit FR-002"],
  "022: cockpit.socket is enabled and started (socket activation)",
  () => {
    const u = resolvePlan(host(), fleet()).units.find((x) => x.unitName === "cockpit.socket");
    assertEquals(u?.managed, false, "Ubuntu's own unit");
    assertEquals(u?.state, "enabled");
    assertEquals(u?.start, true);
    assertEquals(u?.verify, "systemctl is-active cockpit.socket");
  },
);

// Spec 064 revised this: the port is open to every network (the router decides who reaches the
// server); what still holds is that it is modeled from the fleet's local networks and closed
// with none.
proves(
  ["022-cockpit FR-003"],
  "022: 9090/tcp is open while the fleet allows password logins, closed with passwordFrom []",
  () => {
    const open = resolvePlan(host(), fleet());
    assert(LOCAL_NETWORKS.length > 0);
    assert(open.ports.some((p) => p.port === 9090 && p.protocol === "tcp"));
    const ufw = open.files.find((f) => f.path === "/etc/ufw/applications.d/archon")?.content ?? "";
    assert(/ports=.*9090\/tcp/.test(ufw), ufw);

    const keysOnly = resolvePlan(host(), fleet({ ssh: { passwordFrom: [] } }));
    assert(!keysOnly.ports.some((p) => p.port === 9090));
    assert(
      keysOnly.packages.some((p) => p.name === "cockpit"),
      "installed, but closed",
    );
    const closed =
      keysOnly.files.find((f) => f.path === "/etc/ufw/applications.d/archon")?.content ?? "";
    assert(!closed.includes("9090"), closed);
  },
);

proves(
  ["022-cockpit FR-004"],
  "022: Cockpit as Ubuntu configures it: PAM logins, root refused, its own certificate",
  () => {
    const plan = resolvePlan(host(), fleet());
    // Archon writes nothing of Cockpit's: no cockpit.conf, no disallowed-users, no certificate,
    // so Ubuntu's defaults hold (PAM, root in /etc/cockpit/disallowed-users, a self-signed cert).
    assertEquals(
      plan.files.filter((f) => f.path.startsWith("/etc/cockpit")).map((f) => f.path),
      [],
    );
    assert(!plan.files.some((f) => f.path.startsWith("/etc/pam.d/cockpit")));
    // Spec 032: through the proxy, Traefik speaks TLS to Cockpit's own certificate.
    const r = plan.routes.find((x) => x.name === "cockpit");
    assertEquals([r?.port, r?.https], [9090, true]);
  },
);

proves(["022-cockpit FR-005"], "022: servers only; a workstation gets no Cockpit", () => {
  const ws = host({
    name: "pc",
    kind: "workstation",
    user: "alice",
    mac: undefined,
    disk: undefined,
    capabilities: workstation(),
    spec: "020-workstation",
  });
  const plan = resolvePlan(ws, fleet());
  assert(!plan.packages.some((p) => p.name.startsWith("cockpit")));
  assert(!plan.units.some((u) => u.unitName.startsWith("cockpit")));
  assert(!plan.ports.some((p) => p.port === 9090));
  assert(!plan.specsUsed.includes("022-cockpit"));
});
