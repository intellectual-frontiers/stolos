/**
 * Spec 052: every problem archon knows how to explain, by a stable code. A
 * problem shown with a code says "explain: archon explain <code>"; the code
 * stays the same across versions, so it can be searched for and written down.
 * Raw errors from other tools (ssh, apt, git, Deno) that people meet often are
 * recognized here too, and given their plain cause and fix.
 *
 * Codes: E<spec>-<WORD> for a problem, P<spec>-<WORD> for something not set up
 * yet (pending).
 *
 * ```mermaid
 * flowchart LR
 *   raw["a problem, or a raw tool error<br/>(ssh, apt, dpkg, Deno)"] --> tr{"known?"}
 *   tr -->|yes| code["its code and fix"]
 *   tr -->|no| plain["shown as it is"]
 *   code --> show["fix: ...<br/>explain: archon explain CODE"]
 * ```
 *
 * @module
 */

export interface Explanation {
  /** Its title, in one line. */
  title: string;
  /** What happened, in plain words. */
  what: string;
  /** The likely cause. */
  why: string;
  /** The fix: what to do, with the exact command where there is one. */
  fix: string;
  /** Where the guide explains more (a file of the engine's docs). */
  doc: string;
}

/** Every explanation, by code. */
export const EXPLAIN: Record<string, Explanation> = {
  "E046-LOCK-INTEGRITY": {
    title: "An engine file does not match deno.lock",
    what:
      "Deno refused to run: a file of the engine, as downloaded, is not the file whose hash deno.lock holds.",
    why:
      "The engine at that tag changed after the lock was made (tags are immutable, so this should not happen), or something between you and GitHub altered it.",
    fix:
      "Stop. Do not regenerate deno.lock. Report it; the lock is what makes your signature cover the engine's code.",
    doc: "docs/fleet-repository.md",
  },
  "E047-UNSIGNED": {
    title: "The newest commit is not signed",
    what: "A host refused to move to the newest commit of main: it carries no signature.",
    why:
      "It was pushed without signing (git commit -S), or from a machine without your signing setup.",
    fix: "Make a signed commit on top (git commit -S --allow-empty -m approve) and push it.",
    doc: "docs/fleet-repository.md",
  },
  "E047-UNTRUSTED": {
    title: "The newest commit is signed by a key the fleet does not trust",
    what: "A host refused the newest commit: its signature is by a key not in signers.ts.",
    why:
      "It was signed with another key (an agent's, a CI's, a new laptop's), or the signer was removed.",
    fix:
      "Sign it again with a key in fleets/<fleet>/signers.ts (archon signers lists them); to add a key, archon signers add, in a commit signed by a key already listed.",
    doc: "docs/fleet-repository.md",
  },
  "E047-ROLLBACK": {
    title: "The newest commit is not a descendant of the one the host runs",
    what: "A host refused to move: main was rewritten or went back.",
    why: "A force-push, or a reset of main.",
    fix:
      "Never rewrite main. Put the history back, or make a new signed commit on top of the host's.",
    doc: "docs/fleet-repository.md",
  },
  "E047-NO-SIGNERS": {
    title: "The fleet has no signer",
    what: "No change can be approved: signers.ts lists no daily signer.",
    why: "The fleet is new.",
    fix: "deno task archon signers add <name> --role daily --key <public key file>",
    doc: "docs/fleet-repository.md",
  },
  "E047-HOST-KEY": {
    title: "A host's SSH identity is not the one this machine expects",
    what:
      "ssh refused to connect: the host answered with keys your known_hosts does not hold for it.",
    why:
      "The host was reinstalled before host identities, your known_hosts predates them, or it is not the machine you meant.",
    fix:
      "deno task archon fleet trust (writes the keys registered in Git into your known_hosts); if it still refuses, check that the address is the right machine.",
    doc: "docs/troubleshooting.md",
  },
  "E004-SSH-KEY": {
    title: "SSH refused your key",
    what: "The host does not accept the key you offered.",
    why:
      "Your key is not on your GitHub account (the fleet takes the admin's keys from there), or ssh offered another key.",
    fix:
      "gh ssh-key list (is your key there?); then archon fleet status, or ssh -i <your key> <user>@<host>.",
    doc: "docs/troubleshooting.md",
  },
  "E009-DNS": {
    title: "A name does not resolve",
    what: "The machine could not look up a name.",
    why: "No network yet, the router's DNS is down, or the name is wrong.",
    fix:
      "archon doctor network (on the machine): it checks the link, the gateway, and DNS in turn.",
    doc: "docs/troubleshooting.md",
  },
  "E009-APT-BUSY": {
    title: "apt is busy",
    what: "Another apt or dpkg run holds its lock.",
    why:
      "Ubuntu's unattended-upgrades runs, often in the first hour after an install. It finishes by itself.",
    fix: "Wait a few minutes and run it again. Do not power the machine off while apt runs.",
    doc: "docs/troubleshooting.md",
  },
  "E009-DPKG-DAMAGED": {
    title: "dpkg's state is damaged",
    what: "dpkg cannot read its own records.",
    why: "The machine lost power (or was killed) while apt was installing.",
    fix:
      "On the machine: sudo dpkg --configure -a, then sudo apt-get -f install; if dpkg's files are empty, reinstall the host (deno task boot reinstall <host>).",
    doc: "docs/troubleshooting.md",
  },
  "E051-NO-RECOGNITION": {
    title: "How the machine is recognized was not said",
    what: "Arming a host needs exactly one of --claim and --mac-address.",
    why:
      "There is no default: a choice made without thinking is how the wrong machine gets erased.",
    fix:
      "--claim (the next unknown machine to network-boot in 30 minutes becomes the host) or --mac-address <mac> (only that network card).",
    doc: "docs/hosts.md",
  },
  "E051-DISK-NOT-BLANK": {
    title: "The install stopped: the machine's disks are not blank",
    what:
      "Before writing anything, the installer found partitions or filesystems, and nobody confirmed they may be erased. Nothing was written; the machine powered off.",
    why:
      "It is a used machine, or not the machine you meant (a claim takes the next unknown machine).",
    fix:
      "If it is the right machine and its disks may be erased: deno task boot arm <host> --claim --confirm-destroy <host> (or --mac-address <mac>), then network-boot it again.",
    doc: "docs/hosts.md",
  },
  "E051-INSTALLER-STALLED": {
    title: "The installer went quiet after taking Ubuntu's image",
    what: "The machine downloaded the installer image and never asked for its configuration.",
    why:
      "Too little memory: Ubuntu's network installer holds the whole image in memory and needs about 8 GiB.",
    fix:
      "Install Ubuntu by hand (or from its cloud image), then: deno task archon host bootstrap <host> --ssh <user>@<address>.",
    doc: "docs/hosts.md",
  },
  "E051-MAC-MISMATCH": {
    title: "A machine booted, but not the one the host waits for",
    what: "An unknown network card network-booted while a host is armed for another card.",
    why: "The MAC was mistyped, or another machine on the network boots from the network first.",
    fix:
      "If it is the host: deno task boot arm <host> --mac-address <the card shown> (or --claim). Nothing was installed.",
    doc: "docs/hosts.md",
  },
  "E051-WRONG-RELEASE": {
    title: "The machine runs another Ubuntu release",
    what: "archon host bootstrap needs the fleet's Ubuntu release.",
    why: "It was installed from another image.",
    fix:
      "Install the fleet's release (fleets/<fleet>/fleet.ts, ubuntu.release) on it, then bootstrap again.",
    doc: "docs/hosts.md",
  },
  "E051-WRONG-MACHINE": {
    title: "The machine lacks the host's registered network card",
    what: "archon host bootstrap stopped: the machine at that address is not the registered one.",
    why: "The wrong address, a replaced network card, or a typo in --mac-address.",
    fix:
      "Check the address; if it is the host, register its card: archon host add <host> --mac-address <mac> --force.",
    doc: "docs/hosts.md",
  },
  "P027-MAIL-TOKEN": {
    title: "Mail is not set up on this machine yet",
    what: "The machine has no relay token, so it sends no mail.",
    why: "The token is delivered from the boot machine, after it is created once.",
    fix:
      "On the boot machine: deno task boot mail-setup (once), then deno task boot mail-push <host>.",
    doc: "docs/boot-machine.md",
  },
  "P032-WEB-TOKEN": {
    title: "HTTPS names are not set up on this machine yet",
    what:
      "The machine has no Cloudflare token: no DNS record and no Let's Encrypt certificate yet (it answers with a self-signed one).",
    why: "The token is delivered from the boot machine, after it is created once.",
    fix:
      "On the boot machine: deno task boot web-setup (once), then deno task boot web-push <host>.",
    doc: "docs/web.md",
  },
};

/** Raw errors from other tools, recognized (spec 052). The first match wins. */
const PATTERNS: Array<[RegExp, string]> = [
  [
    /Integrity check failed|integrity.*deno\.lock|lockfile.*(mismatch|integrity)/i,
    "E046-LOCK-INTEGRITY",
  ],
  [/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/, "E047-HOST-KEY"],
  [/Permission denied \(publickey/, "E004-SSH-KEY"],
  [
    /Could not resolve host|Temporary failure in name resolution|Name or service not known/,
    "E009-DNS",
  ],
  [/Could not get lock .*(dpkg|apt)|dpkg frontend lock/, "E009-APT-BUSY"],
  [
    /dpkg was interrupted|fgets gave an empty string|parsing file '\/var\/lib\/dpkg/,
    "E009-DPKG-DAMAGED",
  ],
];

/** A known raw error's code and fix, or undefined. */
export function translate(message: string): { code: string; fix: string } | undefined {
  for (const [re, code] of PATTERNS) {
    if (re.test(message)) return { code, fix: EXPLAIN[code].fix };
  }
  return undefined;
}

/** `archon explain [code]`: one explanation, or the list. */
export function explainText(code?: string): string {
  if (!code) {
    const w = Math.max(...Object.keys(EXPLAIN).map((k) => k.length));
    return [
      "Every problem archon explains (archon explain <code>):",
      "",
      ...Object.entries(EXPLAIN).map(([k, e]) => `  ${k.padEnd(w)}  ${e.title}`),
    ].join("\n");
  }
  const e = EXPLAIN[code.toUpperCase()];
  if (!e) return `no explanation named ${code}: archon explain lists them`;
  return [
    `${code.toUpperCase()}: ${e.title}`,
    "",
    `What happened  ${e.what}`,
    `Likely cause   ${e.why}`,
    `Fix            ${e.fix}`,
    `More           ${e.doc} (in the engine's repository, intellectual-frontiers/stolos)`,
  ].join("\n");
}
