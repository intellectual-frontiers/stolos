/**
 * 033-etckeeper: /etc's history in a local git repository (Ubuntu's
 * etckeeper package): a commit before and after every apt run, one a day for
 * anything else, and one per archon apply with its specs (spec 033). Archon
 * sees drift only in files it manages; etckeeper records every change to /etc,
 * and who made it. The history holds secrets (shadow, SSH host keys, the mail
 * relay's password file), so it stays local and root-only, and is never given
 * a remote (Article 13).
 *
 * Overrides of Ubuntu defaults: none (Ubuntu's etckeeper configuration: git,
 * daily autocommits, the apt hooks).
 *
 * @module
 */

import type { Capability } from "../model/types.ts";

const SPEC = "033-etckeeper" as const;

/** /etc's history in a local git repository, one commit per change (spec 033). */
export const etckeeper = (): Capability => () => ({
  spec: SPEC,
  packages: [{ name: "etckeeper", spec: SPEC }],
  units: [{
    unitName: "etckeeper.timer",
    managed: false,
    state: "enabled",
    start: true,
    verify: "systemctl is-enabled etckeeper.timer",
    spec: SPEC,
  }],
  checks: [
    {
      name: "/etc's history is a local git repository",
      command: "sh -c 'test -d /etc/.git'",
      level: "warn",
      fix: "sudo etckeeper init && sudo etckeeper commit 'initial'",
      spec: SPEC,
    },
    {
      // Never pushed anywhere: it holds secrets (Article 13).
      name: "/etc's history has no remote",
      command: "sh -c 'test -z \"$(git -C /etc remote 2>/dev/null)\"'",
      level: "fail",
      fix:
        "sudo git -C /etc remote remove <name> (the history holds secrets; it never leaves this host)",
      spec: SPEC,
    },
  ],
  notes: [
    "etckeeper keeps /etc's history in /etc/.git (root only, never pushed): sudo etckeeper vcs log; one commit per archon apply.",
  ],
});
