// Host alpha (spec 004): the example lab's first server. Written by
// `stolos host add`; edit freely, then `stolos build`.

import type { HostDef } from "@stolos/archon/model/types.ts";
import { foundation } from "@stolos/archon/capabilities/mod.ts";

export const host: HostDef = {
  name: "alpha",
  arch: "amd64",
  disk: { match: "largest", layout: "lvm" },
  capabilities: foundation(),
  spec: "004-install",
};
