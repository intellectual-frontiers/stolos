/**
 * Written by stolos host add (spec 047): who this host is. Public facts only.
 * Its SSH host public keys are what operators' machines trust (known_hosts.auto).
 *
 * @module
 */
import type { HostRegistration } from "@intellectual-frontiers/stolos/archon/model/types";

export default {
  sshHostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ9EST1bXe0/xjNH2fUOpNwlg/nDfkXXseXM+rEXx2cH"],
  added: "2026-11-13",
} satisfies HostRegistration;
