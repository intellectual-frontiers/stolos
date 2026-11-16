/**
 * Spec 027 (mail from every server): the model's `fleet.mail`, and what verify and `archon mail
 * test` check on a server. On a real Ubuntu host the VM e2e (tests/e2e/ci.sh, whose fleet has
 * `mail`; lib.sh's install to Ready and `archon verify` after a reboot) also runs the plan's
 * `systemctl is-active postfix.service`.
 *
 * @module
 */

import { fs } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { mainCf } from "../src/archon/capabilities/mail.ts";
import { ui } from "../src/archon/core/ui.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { mailTest } from "../src/archon/notify/commands.ts";
import { DEFAULT_RELAY, senderAddress } from "../src/archon/notify/transport.ts";
import { fleet, host } from "./fixtures.ts";

const MAIL = { to: "fleet@example.net", domain: "example.net", tag: "lab" };

proves(
  ["027-mail FR-001"],
  "027: fleet.mail { to, domain, tag?, relay? }, Cloudflare's relay by default, nothing without it",
  () => {
    assertEquals(DEFAULT_RELAY, "smtp.mx.cloudflare.net:465");
    const lines = (m: object) => mainCf(fleet({ mail: { ...MAIL, ...m } }), host()).split("\n");
    assert(lines({}).includes("relayhost = [smtp.mx.cloudflare.net]:465"));
    assert(lines({ relay: "smtp.example.net:587" }).includes("relayhost = [smtp.example.net]:587"));
    // The tag is optional: without it the machine alone is the subaddress.
    assertEquals(senderAddress(MAIL, "alpha", "root"), "root+alpha.lab@example.net");
    assertEquals(
      senderAddress({ domain: "example.net" }, "alpha", "root"),
      "root+alpha@example.net",
    );
    const withMail = resolvePlan(host(), fleet({ mail: MAIL }));
    assert(withMail.specsUsed.includes("027-mail"));
    assert(withMail.files.some((f) => f.spec === "027-mail"));
    // Without it: no Postfix, no files, no checks of spec 027.
    const without = resolvePlan(host(), fleet());
    for (const xs of [without.packages, without.files, without.units, without.checks]) {
      assertEquals(
        xs.filter((x) => x.spec === "027-mail"),
        [],
      );
    }
  },
);

proves(
  ["027-mail FR-006"],
  "027: verify checks Postfix is active and warns while the token is missing; mail test uses /usr/sbin/sendmail",
  async () => {
    const plan = resolvePlan(host(), fleet({ mail: MAIL }));
    const u = plan.units.find((x) => x.unitName === "postfix.service");
    assertEquals([u?.state, u?.verify], ["enabled", "systemctl is-active postfix.service"]);
    const c = plan.checks.find((x) => x.name === "mail:credential");
    assertEquals(c?.level, "warn");
    assertEquals(c?.command, "sh -c 'test -s /etc/postfix/sasl_passwd || exit 3'");
    assertEquals(c?.code, "P027-MAIL-TOKEN");
    // Where Postfix is not installed, `archon mail test` says so and hands nothing elsewhere.
    if (!(await fs.exists("/usr/sbin/sendmail"))) {
      const before = ui.problems.length;
      assertEquals(await mailTest("alpha"), 1);
      const [p] = ui.problems.slice(before);
      assertStringIncludes(p?.message ?? "", "no /usr/sbin/sendmail");
    }
  },
);
