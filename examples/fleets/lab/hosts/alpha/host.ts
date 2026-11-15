/**
 * Host alpha (spec 004): the example lab's first server. Written by
 * `stolos host add`; edit freely, then `stolos build`.
 *
 * @module
 */

import type { HostDef } from "@intellectual-frontiers/stolos/archon/model/types";
import { foundation } from "@intellectual-frontiers/stolos/archon/capabilities/mod";

export const host: HostDef = {
  name: "alpha",
  arch: "amd64",
  disk: { match: "largest", layout: "lvm" },
  capabilities: foundation(),
  spec: "004-install",
};
