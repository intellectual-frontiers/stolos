/**
 * Written by stolos signers (spec 047): who may approve this fleet's changes.
 * Change it with stolos signers add/remove, in a commit signed by a key below.
 *
 * @module
 */
import type { SignerDef } from "@intellectual-frontiers/stolos/archon/model/types";

export default [
  {
    name: "alice-daily",
    role: "daily",
    key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGrUkdy4/6JRfMjw0H6l4evcoxLH1msHwjLZWC2e2Uv1",
    added: "2026-11-13",
  },
  {
    name: "alice-recovery",
    role: "recovery",
    key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfIyufBCPO+XOYkn3+holvM2Zir00+Gfo++ms4jmxk+",
    added: "2026-11-13",
  },
] satisfies SignerDef[];
