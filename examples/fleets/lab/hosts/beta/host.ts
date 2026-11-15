/**
 * Host beta (spec 004). Written by `stolos host add`; edit freely, then
 * `stolos build`. Capabilities come from foundation(); add more per spec.
 *
 * @module
 */

import type { HostDef } from "@intellectual-frontiers/stolos/archon/model/types";
import { foundation } from "@intellectual-frontiers/stolos/archon/capabilities/mod";
import { PRIME } from "@intellectual-frontiers/stolos/archon/pg/config";

export const host: HostDef = {
  name: "beta",
  arch: "amd64",
  disk: { match: "largest", layout: "lvm" },
  capabilities: foundation(),
  // Specs 038, 039: PostgreSQL 18 "prime" (off until an operator runs archon pg on).
  pg: { instances: [PRIME] },
  spec: "004-install",
};
