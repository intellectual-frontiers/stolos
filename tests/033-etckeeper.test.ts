/**
 * Spec 033 (etckeeper): Ubuntu's package with Ubuntu's configuration, and its daily timer.
 *
 * @module
 */

import { assert, assertEquals, proves } from "@intellectual-frontiers/ifc-ts/runtime/test";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { fleet, host } from "./fixtures.ts";

proves(
  ["033-etckeeper FR-001"],
  "033: Ubuntu's etckeeper with Ubuntu's configuration, and its daily commit timer enabled",
  () => {
    const plan = resolvePlan(host(), fleet());
    const pkg = plan.packages.find((p) => p.name === "etckeeper");
    assert(pkg !== undefined);
    // Ubuntu's archive, as Ubuntu configures it: no PPA, no repository, no preseeding, and no
    // file of Archon's in /etc/etckeeper (git, the apt hooks, and daily autocommits are its own).
    assertEquals([pkg.ppa, pkg.repo, pkg.debconf], [undefined, undefined, undefined]);
    assertEquals(
      plan.files.filter((f) => f.path.startsWith("/etc/etckeeper")).map((f) => f.path),
      [],
    );
    const t = plan.units.find((u) => u.unitName === "etckeeper.timer");
    assertEquals([t?.managed, t?.state, t?.start], [false, "enabled", true]);
    assertEquals(t?.verify, "systemctl is-enabled etckeeper.timer");
  },
);
