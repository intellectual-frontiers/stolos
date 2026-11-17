/**
 * Written by stolos decide (spec 047): what operators decided for this host.
 * Change it with stolos decide, in a signed commit; a decision here wins over the host's own record.
 *
 * @module
 */
import type { HostDecisions } from "@intellectual-frontiers/stolos/archon/model/types";
import type { TagId } from "../../tags.ts";

export default {
  optIns: {},
  tags: ["env:staging", "role:web", "owner:engineering", "criticality:moderate"],
} satisfies HostDecisions<TagId>;
