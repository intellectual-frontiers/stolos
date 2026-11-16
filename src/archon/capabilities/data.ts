/**
 * 044-durable (Article 23): what this server's data class is, where people
 * see it. /etc/archon/data holds "durable" or "ephemeral" (the prompt reads
 * it), and the login banner says which, why, and that home directories are
 * not kept across a reinstall. Both are worked out from the model each build.
 *
 * @module
 */
// Spec: 044-durable

import type { Capability } from "../model/types.ts";
import { hostData, SPEC } from "../model/durable.ts";
import { dataMotd } from "../render/motd.ts";

/** The server's data class (durable or ephemeral), where people see it (spec 044). */
export const data =
  (): Capability =>
  ({ host }) => {
    if (host.kind === "workstation") return { spec: SPEC };
    const d = hostData(host);
    return {
      spec: SPEC,
      files: [
        {
          path: "/etc/archon/data",
          content: `${d.class}\n`,
          mode: "0644",
          owner: "root",
          spec: SPEC,
        },
        {
          path: "/etc/update-motd.d/72-archon-data",
          content: dataMotd(d),
          mode: "0755",
          owner: "root",
          spec: SPEC,
        },
      ],
      notes: [
        d.class === "durable"
          ? `Durable (${d.reasons.join(
              ", ",
            )}): archived nightly; reinstalls and wipes need --confirm-destroy.`
          : "Ephemeral: nothing here holds end users' data that exists nowhere else.",
      ],
    };
  };
