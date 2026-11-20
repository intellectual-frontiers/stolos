/**
 * Spec 005: where the first boot's logs go.
 *
 * @module
 */
import { assert, assertStringIncludes, proves } from "@intellectual-frontiers/test";
import { firstBootScript } from "../src/archon/render/autoinstall.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { fleet, host } from "./fixtures.ts";

proves(
  ["005-first-boot FR-003"],
  "005: the first boot logs to /var/log/archon-first-boot.log, and its run log to /var/log/archon",
  () => {
    const s = firstBootScript(fleet(), host());
    // Everything the script and what it runs print, from its second line on.
    const lines = s.split("\n");
    const at = lines.indexOf("exec >>/var/log/archon-first-boot.log 2>&1");
    assert(at > 0 && at < 10, "the script's output goes to the log at once");
    // archon first-boot runs as root (cloud-init's runcmd): its run log is under /var/log/archon,
    // which tmpfiles.d makes for the run logs (kept 30 days). Where a root run's log goes is
    // checked by spec 019's test (defaultLogPath).
    const tmp = resolvePlan(host(), fleet()).files.find(
      (f) => f.path === "/etc/tmpfiles.d/archon.conf",
    );
    assertStringIncludes(tmp?.content ?? "", "d /var/log/archon 2750 root archon-ops 30d");
  },
);
