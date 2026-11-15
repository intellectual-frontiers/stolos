/**
 * Spec 037 (SMB): what `archon verify` checks, run against stand-ins for systemctl and ss. The VM
 * e2e (tests/e2e/ci.sh, `archon verify` after install and after a reboot) runs the "off" check on
 * a real Ubuntu host.
 *
 * @module
 */

import { splitArgs } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { assert, assertEquals, proves } from "@intellectual-frontiers/ifc-ts/runtime/test";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { fleet, host } from "./fixtures.ts";

const posix = proc.build.os !== "windows";

proves(
  ["037-smb FR-008"],
  "037: verify: on, smbd is active and 445 answers; off, smbd is not running",
  async () => {
    const verify = (enabled: boolean): string => {
      const h = host(enabled ? { optIn: { smb: { enabled: true, by: "alice", at: "t" } } } : {});
      const u = resolvePlan(h, fleet()).units.find((x) => x.unitName === "smbd.service");
      assert(u?.verify !== undefined);
      return u.verify;
    };
    const dir = await fs.makeTempDir({ prefix: "archon-037-" });
    try {
      // systemctl answers $ACTIVE (0: active); ss lists a listener on 445 when $LISTEN is 1.
      await fs.writeTextFile(path.join(dir, "systemctl"), '#!/bin/sh\nexit "$ACTIVE"\n');
      await fs.writeTextFile(
        path.join(dir, "ss"),
        '#!/bin/sh\n[ "$LISTEN" = 1 ] && echo "LISTEN 0 50 0.0.0.0:445 0.0.0.0:*"\nexit 0\n',
      );
      for (const f of ["systemctl", "ss"]) await fs.chmod(path.join(dir, f), 0o755);
      const check = async (command: string, active: boolean, listen: boolean) => {
        const argv = splitArgs(command);
        assert(argv.kind === "ok", command);
        const r = await proc.run(argv.value, {
          env: {
            PATH: `${dir}:${proc.env.get("PATH") ?? ""}`,
            ACTIVE: active ? "0" : "3",
            LISTEN: listen ? "1" : "0",
          },
        });
        return r.code === 0;
      };
      const on = verify(true);
      assertEquals(await check(on, true, true), true, "running and listening");
      assertEquals(await check(on, true, false), false, "running, but 445 does not answer");
      assertEquals(await check(on, false, false), false, "not running");
      const off = verify(false);
      assertEquals(await check(off, false, false), true, "off and not running");
      assertEquals(await check(off, true, true), false, "off, but running");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  { skip: posix ? false : "stand-ins for systemctl and ss written as POSIX shell scripts" },
);
