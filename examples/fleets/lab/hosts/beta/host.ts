// Host beta (spec 004). Written by `stolos host add`; edit freely, then
// `stolos build`. Capabilities come from foundation(); add more per spec.

import type { HostDef } from "@stolos/archon/model/types.ts";
import { foundation } from "@stolos/archon/capabilities/mod.ts";
import { PRIME } from "@stolos/archon/pg/config.ts";

export const host: HostDef = {
  name: "beta",
  arch: "amd64",
  disk: { match: "largest", layout: "lvm" },
  capabilities: foundation(),
  // Specs 038, 039: PostgreSQL 18 "prime" (off until an operator runs archon pg on).
  pg: { instances: [PRIME] },
  spec: "004-install",
};
