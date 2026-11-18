/**
 * Spec 052: every problem archon knows how to explain, by a stable code. A
 * problem shown with a code says "explain: archon explain <code>"; the code
 * stays the same across versions, so it can be searched for and written down.
 * Raw errors from other tools (ssh, apt, git, Bun) that people meet often are
 * recognized here too, and given their plain cause and fix.
 *
 * Codes: E<spec>-<WORD> for a problem, P<spec>-<WORD> for something not set up
 * yet (pending).
 *
 * ```mermaid
 * flowchart LR
 *   raw["a problem, or a raw tool error<br/>(ssh, apt, dpkg, Bun)"] --> tr{"known?"}
 *   tr -->|yes| code["its code and fix"]
 *   tr -->|no| plain["shown as it is"]
 *   code --> show["fix: ...<br/>explain: archon explain CODE"]
 * ```
 *
 * @module
 */
// Spec: 052-self-describing
// Spec: 105-calm-output FR-009, FR-013
// Spec: 115-compatibility FR-012

import { guideRef, guideUrl } from "./guides.ts";

/** One problem's explanation: what, why, the fix, and the guide. */
export interface Explanation {
  /** Its title, in one line. */
  title: string;
  /** What happened, in plain words. */
  what: string;
  /** The likely cause. */
  why: string;
  /** The fix: what to do, with the exact command where there is one. */
  fix: string;
  /** The guide that explains more (its name: bun run stolos docs <name>). */
  doc: string;
}

/** Every explanation, by code. */
export const EXPLAIN: Record<string, Explanation> = {
  "E105-RUNTIME-OLD": {
    title: "Bun is older than the version Stolos is pinned to",
    what: "The Bun on this PC is older than the pinned version.",
    why: "Bun was installed before the pin moved.",
    fix: "bun upgrade",
    doc: "fleet-repository",
  },
  "E105-GITHUB": {
    title: "GitHub could not be reached",
    what: "A step that needs GitHub (fetch, the list of releases) got no answer; nothing was changed.",
    why: "The network is down, or the GitHub sign-in expired.",
    fix: "gh auth status",
    doc: "fleet-repository",
  },
  "E105-CONFLICT": {
    title: "Your commits and GitHub's went different ways",
    what: "Your commits and the new ones on GitHub change the same lines, or you have changes not committed; nothing was moved.",
    why: "Someone else changed the fleet while you did.",
    fix: "git pull --rebase",
    doc: "fleet-repository",
  },
  "E105-INSTALL": {
    title: "The engine could not be installed on this PC",
    what: "bun install --frozen-lockfile failed; the run log has its raw message.",
    why: "The network, or a full disk.",
    fix: "bun run stolos update",
    doc: "fleet-repository",
  },
  "E105-OPERATOR": {
    title: "The engine release asks you to do something",
    what: "A commit of the engine you just adopted says the operator has to act (an Operator action line).",
    why: "A change in the engine needs a decision or a command only you can make.",
    fix: "Do what the line says.",
    doc: "fleet-repository",
  },
  "E105-FAILED": {
    title: "A step failed",
    what: "A step of the command stopped; the command's own message says which.",
    why: "See the run log for the raw message (stolos log).",
    fix: "stolos log --last 40",
    doc: "fleet-repository",
  },
  "E105-WARNING": {
    title: "Something needs a look",
    what: "A step finished, with something that is worth a look.",
    why: "See the run log for the raw message (stolos log).",
    fix: "stolos log --last 40",
    doc: "fleet-repository",
  },
  "E115-TOO-OLD": {
    title: "A machine is too old for this PC",
    what: "A machine reports a version of one part of the contract between a PC and its machines (the fleet model, the signed records, the query views, the MCP tools, or an adopted machine's probe) that is older than this PC still reads.",
    why: "It has not updated: a server follows the fleet repository, but its engine is the one the fleet pinned when it last pulled; an adopted machine runs the probe installed once.",
    fix: "ssh <machine> archon update (for an adopted machine: bun run stolos host adopt <machine>, which installs the current probe); then bun run stolos fleet status. bun run stolos compat lists every part and what each needs.",
    doc: "fleet-repository",
  },
  "E115-NEWER": {
    title: "A machine is newer than this PC",
    what: "A machine reports a part of the contract this PC is too old to read (a newer major, or a minimum above this PC's version).",
    why: "The fleet's engine moved on and this PC did not: another PC of the fleet updated it, or the machine updated by itself.",
    fix: "bun run stolos update (it pulls the fleet and moves this PC to the engine the fleet pins).",
    doc: "fleet-repository",
  },
  "P115-UNKNOWN": {
    title: "A machine has not reported its engine yet",
    what: "This PC has no record of the engine and the contract versions of a machine, so it cannot say whether the two understand each other.",
    why: "It has not been asked since this check began, or it runs an engine from before the check (it answers, but says nothing of its engine).",
    fix: "bun run stolos fleet status (asks every server); for one that answers and still says nothing: ssh <machine> archon update. For an adopted machine: bun run stolos host observe <machine>.",
    doc: "fleet-repository",
  },
  "E105-YOURS": {
    title: "A step is yours to take",
    what: "Nothing is wrong: this is a step only you can take (send a change, back up, approve).",
    why: "Stolos does not take it for you: it needs your passphrase, your decision or your hands.",
    fix: "The command shown under it.",
    doc: "fleet-repository",
  },
  "E105-BACKUP": {
    title: "Secrets changed since the last backup",
    what: "Secrets on this PC are newer than its last backup; if this PC failed now they would have to be recreated.",
    why: "A command made or changed them (a key, a token, a deploy key).",
    fix: "bun run stolos vault backup (then move the ZIP it makes somewhere safe)",
    doc: "boot-machine",
  },
  "E105-SIGN-PASSPHRASE": {
    title: "The passphrase did not unlock your daily key",
    what: "Git could not sign: the passphrase typed was not the one of your daily signing key. Nothing was sent and your files are safe.",
    why: "A typo, or another key's passphrase.",
    fix: "bun run stolos update (type the passphrase of your daily key; it is never stored)",
    doc: "fleet-repository",
  },
  "E105-UPGRADE-WAITING": {
    title: "An engine upgrade is waiting for its signature",
    what: "An earlier engine upgrade changed package.json and bun.lock but was not signed.",
    why: "Signing failed or was cancelled (a wrong passphrase).",
    fix: "bun run stolos update (it signs the upgrade and sends it)",
    doc: "fleet-repository",
  },
  "E105-UNSENT": {
    title: "Changes here are not sent yet",
    what: "Commits or files in this checkout are not on GitHub, so no server has them.",
    why: "They were made here and not sent yet; pushing is the approval.",
    fix: "bun run stolos apply",
    doc: "fleet-repository",
  },
  "E105-FILE-LOCKED": {
    title: "A file could not be changed because another program holds it",
    what: "The system refused to change or remove a file (EPERM, EBUSY): another program has it open, or this account may not touch it.",
    why: "An editor, a virus scanner or a sync client holds the file.",
    fix: "Close the program that holds it, then run the command again.",
    doc: "fleet-repository",
  },
  "P105-WAITING": {
    title: "Waiting on time or on someone else",
    what: "Nothing is wrong: this is expected to become ready by itself or when someone else acts.",
    why: "It depends on time (a certificate, a timer) or on another person.",
    fix: "Run the command again later.",
    doc: "fleet-repository",
  },
  "E046-LOCK-INTEGRITY": {
    title: "The engine's package does not match bun.lock",
    what: "bun install --frozen-lockfile refused the engine: what it downloaded is not the commit, with the integrity, that bun.lock holds.",
    why: "The engine's commit at that tag is no longer what it was when the lock was made (tags are immutable, so this should not happen), or something between you and GitHub altered it.",
    fix: "Stop. Do not regenerate bun.lock. Report it; the lock is what makes your signature cover the engine's code.",
    doc: "fleet-repository",
  },
  "E047-UNSIGNED": {
    title: "The newest commit is not signed",
    what: "A host refused to move to the newest commit of main: it carries no signature.",
    why: "It was pushed without signing (git commit -S), or from a machine without your signing setup.",
    fix: "Approve it on your PC: bun run stolos apply lists the unsigned commits and approves them with one signed commit on top; check this PC's signing with: bun run stolos keys",
    doc: "fleet-repository",
  },
  "E047-UNTRUSTED": {
    title: "The newest commit is signed by a key the fleet does not trust",
    what: "A host refused the newest commit: its signature is by a key not in signers.ts.",
    why: "It was signed with another key (an agent's, a CI's, a new laptop's), or the signer was removed.",
    fix: "Approve it on your PC: bun run stolos apply lists the commits not signed by a fleet signer and approves them with one commit signed by your key (servers check the newest commit). For a new PC's own key: bun run stolos keys setup, then approval from a PC whose key is listed.",
    doc: "fleet-repository",
  },
  "E047-ROLLBACK": {
    title: "The newest commit is not a descendant of the one the host runs",
    what: "A host refused to move: main was rewritten or went back.",
    why: "A force-push, or a reset of main.",
    fix: "Never rewrite main. Put the history back, or make a new signed commit on top of the host's.",
    doc: "fleet-repository",
  },
  "E047-NO-SIGNERS": {
    title: "The fleet has no signer",
    what: "No change can be approved: signers.ts lists no daily signer.",
    why: "The fleet is new.",
    fix: "bun run stolos keys setup (it makes your keys and lists them)",
    doc: "fleet-repository",
  },
  "E047-HOST-KEY": {
    title: "A host's SSH identity is not the one this machine expects",
    what: "ssh refused to connect: the host answered with keys your known_hosts does not hold for it.",
    why: "The host was reinstalled before host identities, your known_hosts predates them, or it is not the machine you meant.",
    fix: "bun run stolos fleet trust (writes the keys registered in Git into your known_hosts); if it still refuses, check that the address is the right machine.",
    doc: "troubleshooting",
  },
  "E057-SSH": {
    title: "OpenSSH cannot sign commits on this PC",
    what: "Git signs commits with OpenSSH's ssh-keygen, which needs version 8.2 or newer.",
    why: "OpenSSH is missing, or an old one comes first on the PATH.",
    fix: "Install a current OpenSSH (Windows: Settings > Optional features > OpenSSH Client; macOS: brew install openssh; Ubuntu: sudo apt install openssh-client), then: bun run stolos keys",
    doc: "fleet-repository",
  },
  "E057-NO-KEY": {
    title: "No daily signing key on this PC",
    what: "Your daily key signs every change you push; without it, servers refuse your commits.",
    why: "Signing was never set up on this PC, or the key file was moved or deleted.",
    fix: "bun run stolos keys setup (it makes the key; if the old one was lost, use keys lost instead)",
    doc: "fleet-repository",
  },
  "E057-NO-PASSPHRASE": {
    title: "The daily signing key has no passphrase",
    what: "Anyone (or any program) with a copy of the file could approve changes to every server.",
    why: "It was made with an empty passphrase.",
    fix: "ssh-keygen -p -f <the key file> (choose a passphrase; it is never stored)",
    doc: "fleet-repository",
  },
  "E057-AGENT": {
    title: "The daily signing key is loaded in an ssh-agent",
    what: "While it is loaded, anything running as you, an AI agent included, can sign without asking you.",
    why: "It was added with ssh-add, or an agent loads keys automatically.",
    fix: "ssh-add -d <the key file> (and turn off automatic loading)",
    doc: "fleet-repository",
  },
  "E057-GIT": {
    title: "Git does not sign your commits in this repository",
    what: "Unsigned commits are refused by every server (E047-UNSIGNED).",
    why: "Git's signing settings are missing or point at another key.",
    fix: "bun run stolos keys setup",
    doc: "fleet-repository",
  },
  "E057-NOT-LISTED": {
    title: "signers.ts does not list your daily key",
    what: "Servers trust only the keys in signers.ts: they would refuse your commits.",
    why: "The key is new (a new PC, or a rotation not committed yet).",
    fix: "bun run stolos keys setup, then commit signed by a key already listed (or use keys lost with the recovery key)",
    doc: "fleet-repository",
  },
  "E057-NO-RECOVERY": {
    title: "No recovery key",
    what: "If the daily key is lost, only the recovery key can approve its replacement.",
    why: "None was ever made, or it was removed from signers.ts.",
    fix: "bun run stolos keys setup (it makes one; then move it off this PC)",
    doc: "fleet-repository",
  },
  "E057-RECOVERY-LOOSE": {
    title: "The recovery key is outside the key store",
    what: "Backups hold the recovery key from the key store (%APPDATA%\\stolos\\keys; ~/.config/stolos/keys); this one is elsewhere, so they miss it.",
    why: "An earlier version made it in a fleet-recovery folder on the Desktop or in the home folder.",
    fix: "bun run stolos vault backup: it puts the key in the ZIP, checks the ZIP, then moves the key into the key store and removes the old folder.",
    doc: "fleet-repository",
  },
  "E057-RECOVERY-MISSING": {
    title: "The recovery key's private file is not in the key store",
    what: "The fleet lists a recovery key, but this PC does not have it, so backups cannot hold it.",
    why: "A new PC that was not restored from a backup, or the file was deleted.",
    fix: "Copy it back from your latest backup ZIP (signing/recovery/ into %APPDATA%\\stolos\\keys), or replace it: bun run stolos keys rotate-recovery --old-lost.",
    doc: "fleet-repository",
  },
  "E057-RECOVERY-CHECK": {
    title: "The recovery key has not been checked for six months",
    what: "A recovery key you cannot use (a forgotten passphrase, a dead USB drive) is no key.",
    why: "It is checked twice a year.",
    fix: "bun run stolos keys check-recovery --key <its private file>",
    doc: "fleet-repository",
  },
  "E057-IDENTITY": {
    title: "Git does not know who you are in this checkout",
    what: 'No commit can be made here, signed or not (Git says "Author identity unknown").',
    why: "A fresh clone (a new or restored PC) has no user.name and user.email, and none is set for every repository on this PC.",
    fix: "bun run stolos keys setup (it sets them from your GitHub account, for this checkout)",
    doc: "fleet-repository",
  },
  "E057-HOOK": {
    title: "Pushes are not checked on this PC first",
    what: "A commit servers would refuse is found only after it is pushed.",
    why: "The pre-push check is not installed (or another program owns the hook).",
    fix: "bun run stolos keys setup",
    doc: "fleet-repository",
  },
  "E063-TIP-UNSIGNED": {
    title: "GitHub's branch is not signed by a fleet signer",
    what: "A server installed now would clone the branch, find its newest commit not signed by a key in signers.ts, and run nothing (its first boot stops).",
    why: "The newest commit on GitHub was made somewhere without your signing key (another tool, the GitHub website, a pushed commit that skipped the pre-push check).",
    fix: "bun run stolos apply: one commit signed by your key on top is enough (servers check the newest commit). Then arm again; a server that already refused: sudo /usr/local/sbin/archon-first-boot on it",
    doc: "fleet-repository",
  },
  "E063-HOST-NOT-PUSHED": {
    title: "The host's model is not on GitHub yet",
    what: "Its first boot clones the fleet from GitHub and would find no fleets/<fleet>/hosts/<host>/host.ts.",
    why: "host add wrote the model on this PC, and it was not pushed (or not committed).",
    fix: 'bun run stolos apply -m "004-install: add host <host>", then arm again',
    doc: "hosts",
  },
  "E004-SSH-KEY": {
    title: "SSH refused your key",
    what: "The host does not accept the key you offered.",
    why: "Your key is not on your GitHub account (the fleet takes the admin's keys from there), or ssh offered another key.",
    fix: "gh ssh-key list (is your key there?); then stolos fleet status, or ssh -i <your key> <user>@<host>.",
    doc: "troubleshooting",
  },
  "E009-DNS": {
    title: "A name does not resolve",
    what: "The machine could not look up a name.",
    why: "No network yet, the router's DNS is down, or the name is wrong.",
    fix: "archon doctor network (on the machine): it checks the link, the gateway, and DNS in turn.",
    doc: "troubleshooting",
  },
  "E009-APT-BUSY": {
    title: "apt is busy",
    what: "Another apt or dpkg run holds its lock.",
    why: "Ubuntu's unattended-upgrades runs, often in the first hour after an install. It finishes by itself.",
    fix: "Wait a few minutes and run it again. Do not power the machine off while apt runs.",
    doc: "troubleshooting",
  },
  "E009-DPKG-DAMAGED": {
    title: "dpkg's state is damaged",
    what: "dpkg cannot read its own records.",
    why: "The machine lost power (or was killed) while apt was installing.",
    fix: "On the machine: sudo dpkg --configure -a, then sudo apt-get -f install; if dpkg's files are empty, reinstall the host (bun run stolos boot reinstall <host>).",
    doc: "troubleshooting",
  },
  "E051-NO-RECOGNITION": {
    title: "How the machine is recognized was not said",
    what: "Arming a host needs exactly one of --claim and --mac-address.",
    why: "There is no default: a choice made without thinking is how the wrong machine gets erased.",
    fix: "--claim (the next unknown machine to network-boot in 30 minutes becomes the host) or --mac-address <mac> (only that network card).",
    doc: "hosts",
  },
  "E051-DISK-NOT-BLANK": {
    title: "The install stopped: the machine's disks are not blank",
    what: "Before writing anything, the installer found partitions or filesystems, and nobody confirmed they may be erased. Nothing was written; the machine powered off.",
    why: "It is a used machine, or not the machine you meant (a claim takes the next unknown machine).",
    fix: "If it is the right machine and its disks may be erased: bun run stolos boot arm <host> --claim --confirm-destroy <host> (or --mac-address <mac>), then network-boot it again.",
    doc: "hosts",
  },
  "E051-INSTALLER-STALLED": {
    title: "The installer went quiet after taking Ubuntu's image",
    what: "The machine downloaded the installer image and never asked for its configuration.",
    why: "Too little memory: Ubuntu's network installer holds the whole image in memory and needs about 8 GiB.",
    fix: "Install Ubuntu by hand (or from its cloud image), then: bun run stolos host bootstrap <host> --ssh <user>@<address>.",
    doc: "hosts",
  },
  "E051-MAC-MISMATCH": {
    title: "A machine booted, but not the one the host waits for",
    what: "An unknown network card network-booted while a host is armed for another card.",
    why: "The MAC was mistyped, or another machine on the network boots from the network first.",
    fix: "If it is the host: bun run stolos boot arm <host> --mac-address <the card shown> (or --claim). Nothing was installed.",
    doc: "hosts",
  },
  "E051-WRONG-RELEASE": {
    title: "The machine runs another Ubuntu release",
    what: "stolos host bootstrap needs the fleet's Ubuntu release.",
    why: "It was installed from another image.",
    fix: "Install the fleet's release (fleets/<fleet>/fleet.ts, ubuntu.release) on it, then bootstrap again.",
    doc: "hosts",
  },
  "E051-WRONG-MACHINE": {
    title: "The machine lacks the host's registered network card",
    what: "stolos host bootstrap stopped: the machine at that address is not the registered one.",
    why: "The wrong address, a replaced network card, or a typo in --mac-address.",
    fix: "Check the address; if it is the host, register its card: stolos host add <host> --mac-address <mac> --force.",
    doc: "hosts",
  },
  "P027-MAIL-TOKEN": {
    title: "Mail is not set up on this machine yet",
    what: "The machine has no relay token, so it sends no mail.",
    why: "The token is delivered from the boot machine, after it is created once.",
    fix: "On the boot machine: bun run stolos boot mail-setup (once), then bun run stolos boot mail-push <host>.",
    doc: "boot-machine",
  },
  "P032-WEB-TOKEN": {
    title: "HTTPS names are not set up on this machine yet",
    what: "The machine has no Cloudflare token: no DNS record and no Let's Encrypt certificate yet (it answers with a self-signed one).",
    why: "The token is delivered from the boot machine, after it is created once.",
    fix: "On the boot machine: bun run stolos boot web-setup (once), then bun run stolos boot web-push <host>.",
    doc: "web",
  },
};

/** Raw errors from other tools, recognized (spec 052). The first match wins. */
const PATTERNS: Array<[RegExp, string]> = [
  [
    /Integrity check failed|integrity.*bun\.lock|lockfile.*(mismatch|integrity)/i,
    "E046-LOCK-INTEGRITY",
  ],
  [/incorrect passphrase|bad passphrase|Load key .*: incorrect/i, "E105-SIGN-PASSPHRASE"],
  [
    /\bEPERM\b|\bEBUSY\b|operation not permitted|being used by another process/i,
    "E105-FILE-LOCKED",
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
    if (re.test(message)) return { code, fix: EXPLAIN[code]?.fix ?? "" };
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
    `More           ${guideRef(e.doc)}   (online: ${guideUrl(e.doc)})`,
  ].join("\n");
}
