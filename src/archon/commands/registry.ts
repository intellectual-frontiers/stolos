/**
 * The command registry (Article 6). One definition per capability; the CLI,
 * MCP tools, man pages, completions, and the agent's permissions come from here.
 * Implementations load lazily.
 *
 * @module
 */

import { CHOICE_ARGS, chooseData, CONFIRM_DESTROY_ARG } from "../model/durable.ts";
import type { Command, Parsed } from "../core/registry-types.ts";
import type { HostDef } from "../model/types.ts";

async function requireHost(name: string): Promise<HostDef> {
  const { loadHosts } = await import("../model/load.ts");
  const h = (await loadHosts()).find((x) => x.name === name);
  if (!h) {
    throw new Error(`no host model named '${name}': add it with stolos host add, or pass --host`);
  }
  return h;
}

/** Every archon command, in help order: the single source for the CLI, MCP tools, man pages, and completions. */
export const COMMANDS: Command[] = [
  {
    name: "validate",
    summary: "Validate the fleet and every host (TypeScript); change nothing",
    description:
      `Loads fleets/<fleet>/fleet.ts and fleets/<fleet>/hosts/*/host.ts, resolves each host's plan, and runs every validation rule (spec 002). Each problem is reported with where, what, and a fix. Exits non-zero when anything is wrong.`,
    tier: "read",
    operation: true,
    args: [],
    async run() {
      const { loadModel, report } = await import("../build.ts");
      const { ui } = await import("../core/ui.ts");
      const p = ui.phase("Model");
      const m = await loadModel();
      const ok = report(p, m);
      p.done(ok ? `${m.hosts.length} host(s) valid` : `${m.problems.length} problem(s)`);
      return ok ? 0 : 1;
    },
  },
  {
    name: "build",
    summary: "Validate, then render every host's files into out/",
    description:
      `Validates the model (an invalid model renders nothing, Article 10), then renders each host's files under out/hosts/<host>/rootfs/. Deterministic: building twice changes no file.`,
    tier: "repo",
    operation: true,
    args: [],
    async run() {
      const { build } = await import("../build.ts");
      return (await build()) ? 0 : 1;
    },
  },
  {
    name: "apply",
    aliases: ["push"],
    summary: "Your changes to the fleet, to every machine: check, build, one signed commit, push",
    description:
      `One command instead of build, git add, git commit, and git push (spec 060; stolos push is the same command). In order, stopping at the first problem with its fix: checks (a fleet is chosen, this is its branch, your keys can sign); catches up with GitHub (fast-forward only; your uncommitted edits are kept); builds (validate and render: an invalid model commits nothing); shows what changes, by fleet and host; makes one signed commit (your passphrase, once; -m gives the message, else it is written from what changed); verifies that servers will trust it; and pushes. Every machine applies it within 15 minutes. With nothing new, it says so and does nothing. --check stops before the commit.`,
    tier: "repo",
    place: "pc",
    operation: true,
    noMcp: true,
    args: [
      {
        name: "message",
        short: "m",
        type: "string",
        description: "The commit message (default: written from what changed).",
      },
      {
        name: "check",
        type: "boolean",
        description: "Checks, catch-up report, build, and what would be committed; change nothing.",
      },
    ],
    examples: [
      {
        cmd: 'deno task stolos apply -m "fcr: olympia\'s packages"',
        text: "Build, sign, and push.",
      },
      { cmd: "deno task stolos push", text: "The same (push is another name for apply)." },
    ],
    async run(a) {
      const { fleetApply } = await import("../fleet/apply.ts");
      return await fleetApply({ message: a.message as string | undefined, check: !!a.check });
    },
  },
  {
    name: "fleet use",
    summary: "Choose which fleet of this repository archon works on (remembered here)",
    description:
      `For a repository with more than one fleet (fleets/<id>/): every archon command in this checkout is then for that fleet, at once, in every terminal, until you choose another. The choice is kept in .git/stolos/fleet, so it is never committed and each checkout makes its own. --fleet <id> (or ARCHON_FLEET) still chooses another for one command. fleet init chooses the fleet it creates.`,
    tier: "read",
    args: [{
      name: "id",
      type: "string",
      positional: true,
      required: true,
      description: "The fleet: a folder of fleets/.",
    }],
    examples: [{ cmd: "deno task stolos fleet use fcr", text: "Work on fleets/fcr from now on." }],
    async run(a) {
      const { fleetUse } = await import("../fleet/use.ts");
      return await fleetUse(a.id as string);
    },
  },
  {
    name: "fleet init",
    summary: "Create the fleet from your GitHub identity (boot machine, once)",
    description:
      `With an id, the fleet is fleets/<id>/ of this repository (ARCHON_REPO, else the nearest folder holding fleets/, else the working directory); in a new, empty repository it also writes deno.json pinned to this engine's release, archon.ts, boot.ts, engine.ts, .gitignore, and deno.lock (spec 046). Reads your GitHub account with gh (login, ID, name, the noreply commit address) and your public SSH keys from github.com/<login>.keys, asks for your Unix account name and an admin password, and writes fleets/<fleet>/fleet.ts (spec 003). If fleets/<fleet>/fleet.ts already exists (a rebuilt boot machine), it is kept, with its admin account, and only the password hash and this checkout's git identity are set again; --rewrite starts the file over. Only the password's SHA-512 crypt hash is kept, in this machine's secret store, never in the repository (Article 13). Runs on Windows or Linux.`,
    tier: "repo",
    operation: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        description:
          "The fleet's id: fleets/<id>/ (lowercase letters, digits, hyphens). Default: the active fleet.",
      },
      {
        name: "user",
        type: "string",
        description: "Unix account name for you on every host (default: your GitHub login).",
      },
      {
        name: "timezone",
        type: "string",
        description: "IANA time zone (default: this machine's).",
      },
      { name: "locale", type: "string", description: "Locale (default en_US.UTF-8)." },
      { name: "keyboard", type: "string", description: "Keyboard layout (default us)." },
      {
        name: "password-stdin",
        type: "boolean",
        description: "Read the admin password from stdin (automation).",
      },
      {
        name: "rewrite",
        type: "boolean",
        description: "Rewrite fleets/<fleet>/fleet.ts even if it exists (otherwise it is kept).",
      },
    ],
    examples: [{
      cmd: "deno task stolos fleet init lab",
      text: "Start the fleet fleets/lab/ (and, in an empty repository, the repository's files).",
    }, {
      cmd: "deno task stolos fleet init",
      text: "On a rebuilt boot machine: store the admin password hash again; the fleet is kept.",
    }],
    async run(a) {
      const { fleetInit } = await import("../identity/fleet-init.ts");
      await fleetInit({
        id: a.id as string | undefined,
        user: a.user as string | undefined,
        timezone: a.timezone as string | undefined,
        locale: a.locale as string | undefined,
        keyboard: a.keyboard as string | undefined,
        passwordStdin: !!a["password-stdin"],
        rewrite: !!a.rewrite,
      });
      return 0;
    },
  },
  {
    name: "fleet status",
    summary: "Every server and workstation: last install, and how to reach and observe it",
    description:
      `Lists every host in the model with its last install as it recorded it (the host's own archon.sql (opt-in installed): when, checks, problems) and whether it is armed, then how to reach and observe each: ssh, Cockpit's address (servers, from the local networks), archon observe, btop, archon observe tui, archon verify. On the boot machine it also shows the address each host last installed from. Read-only.`,
    tier: "read",
    operation: true,
    args: [],
    examples: [{ cmd: "deno task stolos fleet status", text: "On the boot machine." }],
    async run() {
      const { fleetStatus } = await import("../observe/fleet-status.ts");
      return await fleetStatus();
    },
  },
  {
    name: "host add",
    summary: "Add a host: its model, its GitHub deploy key, and one armed install",
    description:
      `Writes fleets/<fleet>/hosts/<name>/host.ts and registration.ts, creates the host's ed25519 deploy key with ssh-keygen and registers it on the repository read-only (hosts never push, spec 048) through your gh login (the private half stays in this machine's secret store), arms the host for one install by archon-boot, builds, commits, and pushes the new model (the install clones main; --no-push leaves it). Say how its machine is recognized when it network-boots, with exactly one of --claim (the next unknown machine to network-boot in 30 minutes becomes the host; its MAC is learned from it) or --mac-address <mac> (only that network card). The installer erases no disk that is not blank unless --confirm-destroy <name> is given, typed by a person (spec 051).`,
    tier: "repo",
    operation: true,
    args: [
      { name: "name", type: "string", positional: true, required: true, description: "Host name." },
      {
        name: "claim",
        type: "boolean",
        description:
          "The next unknown machine to network-boot in 30 minutes becomes this host (its MAC is learned from it).",
      },
      {
        name: "mac-address",
        type: "string",
        description:
          "Only the network card with this MAC address is this host (aa:bb:cc:dd:ee:ff; dashes or none also work).",
      },
      {
        name: "confirm-destroy",
        type: "string",
        human: true,
        description:
          "The host's name again: its install may erase disks that are not blank (typed by a person; once).",
      },
      {
        name: "disk",
        type: "string",
        description: "Install disk: largest (default) or a /dev path.",
      },
      {
        name: "layout",
        type: "string",
        description: "Ubuntu's guided layout: lvm (default) or direct.",
      },
      { name: "no-deploy-key", type: "boolean", description: "Do not create a GitHub deploy key." },
      { name: "force", type: "boolean", description: "Rewrite an existing host file." },
      {
        name: "no-push",
        type: "boolean",
        description: "Leave the new model uncommitted (default: build, commit, and push it).",
      },
    ],
    examples: [{
      cmd: "deno task stolos host add alpha --claim",
      text: "Add alpha; the next unknown machine to network-boot in 30 minutes becomes alpha.",
    }, {
      cmd: "deno task stolos host add alpha --mac-address 52:54:00:12:34:56",
      text: "Add alpha as the machine with that network card.",
    }],
    async run(a) {
      const { hostAdd } = await import("../install/host-add.ts");
      return await hostAdd({
        name: a.name as string,
        claim: !!a.claim,
        macAddress: a["mac-address"] as string | undefined,
        confirmDestroy: a["confirm-destroy"] as string | undefined,
        disk: a.disk as "largest" | `/dev/${string}` | undefined,
        layout: a.layout as "lvm" | "direct" | undefined,
        noDeployKey: !!a["no-deploy-key"],
        force: !!a.force,
        push: !a["no-push"],
      });
    },
  },
  {
    name: "where",
    summary:
      "Where you are, and the one thing to do next (also: deno task stolos, with no arguments)",
    description:
      `In a fleet repository (the boot machine, a workstation's checkout): every step from a new repository to running hosts (the fleet, the engine pin and lock, signers and this machine's signing, the admin password, mail and Cloudflare tokens, each server, and whether everything is committed and pushed), each marked done, next, to do, or not set up yet, as the real state says, with the one command to run next. Nothing about progress is stored: it is computed each time. On a host: archon state (spec 053).`,
    tier: "read",
    args: [],
    async run(_a, ctx) {
      const { whereCommand } = await import("../guide/where.ts");
      return await whereCommand(ctx.json);
    },
  },
  {
    name: "explain",
    summary: "What a problem's code means, its likely cause, and its fix",
    description:
      `Every problem archon can explain has a stable code (E for a problem, P for something not set up yet), shown as "explain: archon explain <code>" under it. Without a code, lists them all. Runs anywhere, offline (spec 052).`,
    tier: "read",
    args: [{
      name: "code",
      type: "string",
      positional: true,
      description: "The code, for example E051-DISK-NOT-BLANK (none: list them).",
    }],
    examples: [{ cmd: "archon explain E051-DISK-NOT-BLANK", text: "Why an install stopped." }],
    async run(a) {
      const { explainText, EXPLAIN } = await import("../core/explain.ts");
      const code = a.code as string | undefined;
      console.log(explainText(code));
      return !code || EXPLAIN[code.toUpperCase()] ? 0 : 1;
    },
  },
  {
    name: "state",
    summary: "What this machine recorded about itself: install, latest verify, switches, data",
    description:
      `Reads this machine's own archon.sql (spec 048): its install record, its latest verify, the operators' switches (pg, s3, smb), and whether it holds durable data. Fleet status on the boot machine asks each server for this over MCP; nothing is pushed to Git.`,
    tier: "read",
    args: [],
    async run(_a, ctx) {
      const { stateCommand } = await import("../state/state-command.ts");
      return await stateCommand(ctx.hostName, ctx.json);
    },
  },
  {
    name: "query",
    summary: "Ask this machine one SQL question through osquery (read-only, allowlisted tables)",
    description:
      `Runs one SELECT through osqueryi, with Archon's own tables (archon_install, archon_verify, archon_prov, archon_optin, from archon.sql) next to osquery's. This server limits it: one statement, only tables on the allowlist (never shadow, process_envs, curl, file, yara, ...), at most 1000 rows, 20 seconds (spec 048, Article 17).`,
    tier: "read",
    args: [
      { name: "sql", type: "string", positional: true, required: true, description: "One SELECT." },
    ],
    examples: [{
      cmd:
        'archon query "select name, port, protocol from listening_ports join processes using (pid)"',
      text: "What listens, by process.",
    }],
    async run(a, ctx) {
      const { query, table } = await import("../state/query.ts");
      const rows = await query(a.sql as string);
      console.log(ctx.json ? JSON.stringify(rows, null, 2) : table(rows));
      return 0;
    },
  },
  {
    name: "fleet upgrade",
    summary: "Move this repository to another released engine version, locked and signed",
    description:
      `Run in the fleet repository, on the boot machine or a workstation. Checks that the tag is a release (the engine's own version.ts at that tag says the same version), refuses an older version unless --downgrade, rewrites the @stolos/ pin in deno.json, builds deno.lock again through engine.ts (a hash of every engine file: hosts run with --frozen, so the lock is what makes your signature cover the engine's code), validates every fleet with the new engine, and makes one signed commit of deno.json, deno.lock, and engine.ts. Push it to approve it. If anything fails, nothing is committed (spec 046; docs/fleet-repository.md).`,
    tier: "repo",
    noMcp: true,
    operation: true,
    args: [
      {
        name: "tag",
        type: "string",
        positional: true,
        required: true,
        description: "The version tag, for example v0.8.0.",
      },
      { name: "downgrade", type: "boolean", description: "Allow an older (or the same) version." },
      {
        name: "no-commit",
        type: "boolean",
        description: "Change the files only; you review and commit.",
      },
    ],
    examples: [{
      cmd: "deno task stolos fleet upgrade v0.8.0",
      text: "Adopt the engine v0.8.0, then git push to approve it.",
    }],
    async run(a) {
      const { fleetUpgrade } = await import("../fleet/upgrade.ts");
      return await fleetUpgrade({
        tag: a.tag as string,
        downgrade: !!a.downgrade,
        noCommit: !!a["no-commit"],
      });
    },
  },
  {
    name: "fleet trust",
    summary: "Trust every host's SSH keys from Git (registration.ts) in your known_hosts",
    description:
      `On a workstation or the boot machine: writes each registered host's SSH host public keys (fleets/<fleet>/hosts/<host>/registration.ts, written by stolos host add) into your known_hosts, for every name it has (host, DNS name, address, web name), replacing older lines. Plain ssh and MCP clients then check each server against Git, never trusting a first connection blindly. stolos fleet status and fleet query do the same on their own, with known_hosts.auto (spec 047).`,
    tier: "repo",
    noMcp: true,
    operation: true,
    args: [],
    async run() {
      const { fleetTrust } = await import("../fleet/registration.ts");
      return await fleetTrust();
    },
  },
  {
    name: "fleet query",
    summary: "Ask every server the same SQL question, through each one's MCP server",
    description:
      `From the boot machine or a workstation: runs archon query on each server in parallel, over SSH as ops (each server limits what it answers), and prints the rows with a host column. Unreachable servers are named (spec 048).`,
    tier: "read",
    noMcp: true,
    args: [
      { name: "sql", type: "string", positional: true, required: true, description: "One SELECT." },
    ],
    async run(a, ctx) {
      const { fleetQuery } = await import("../observe/fleet-query.ts");
      return await fleetQuery(a.sql as string, ctx.json);
    },
  },
  {
    name: "signers",
    summary: "Who may approve this fleet's changes, and your own signing setup",
    description:
      `Lists the fleet's signers (fleets/<fleet>/signers.ts): each one's role (daily, which approves changes; recovery, kept offline to replace a lost or stolen daily key), key, and when it was added. Then checks your own signing setup: Git signs commits with SSH, the key is protected by a passphrase, and it is not loaded in an ssh-agent (so every signature asks you, and an agent cannot approve on its own). A host applies only a tip of main signed by one of these keys (spec 047, Article 9).`,
    tier: "read",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { signersList } = await import("../identity/signers-commands.ts");
      return await signersList(ctx.json);
    },
  },
  {
    name: "signers add",
    summary: "Add a signer (or replace one by name) in the fleet's signers.ts",
    description:
      `Writes fleets/<fleet>/signers.ts in its fixed form. --key is the public key or its .pub file. Hosts accept the new list only from a commit signed by a key already on it: commit with git commit -S and push (spec 047).`,
    tier: "repo",
    operation: true,
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        required: true,
        description: "Signer name.",
      },
      { name: "role", type: "string", required: true, description: "daily or recovery." },
      { name: "key", type: "string", required: true, description: "Public key, or a .pub file." },
    ],
    async run(a) {
      const { signersAdd } = await import("../identity/signers-commands.ts");
      return await signersAdd(a.name as string, a.role as string, a.key as string);
    },
  },
  {
    name: "signers remove",
    summary: "Remove a signer from the fleet's signers.ts",
    description:
      `Removes the signer by name. Commit signed by another listed key and push; hosts stop accepting the removed key once they apply that commit (spec 047).`,
    tier: "repo",
    operation: true,
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        required: true,
        description: "Signer name.",
      },
    ],
    async run(a) {
      const { signersRemove } = await import("../identity/signers-commands.ts");
      return await signersRemove(a.name as string);
    },
  },
  {
    name: "signers trust",
    summary: "Emergency: trust a signing key on this host, typed by a person here",
    description:
      `For when every signing key is lost: a person logged in to the host (never an agent, never over MCP) trusts a new public key in /etc/archon/allowed_signers.local, and the mailbox is told. Then add it to the fleet's signers.ts, commit signed by it, push, and remove the local file (spec 047).`,
    tier: "mutate",
    operation: true,
    noMcp: true,
    args: [
      {
        name: "key",
        type: "string",
        positional: true,
        required: true,
        human: true,
        description: "The new public key, or its .pub file.",
      },
      { name: "name", type: "string", required: true, description: "A name for it." },
    ],
    async run(a) {
      const { signersTrust } = await import("../identity/signers-commands.ts");
      return await signersTrust(a.key as string, a.name as string);
    },
  },
  {
    name: "keys",
    summary: "Your signing keys: every check, and the one command that fixes each",
    description:
      `Checks this PC's signing setup for the fleet (spec 057): OpenSSH can sign (8.2 or newer); your daily key exists, is locked by a passphrase, and is not in an ssh-agent; Git signs every commit in this repository with it; signers.ts lists it; a recovery key is listed, its private file is not on this PC, and it was checked in the last six months; and every push is checked first. Each problem shows its code (archon explain E057-...) and its fix, usually deno task stolos keys setup. Changes nothing; never asks for a passphrase. Exits 1 when signing does not work.`,
    tier: "read",
    noMcp: true,
    args: [],
    async run(_a, ctx) {
      const { keysStatus } = await import("../identity/keys-commands.ts");
      return await keysStatus(ctx.json);
    },
  },
  {
    name: "keys setup",
    summary: "Set up (or repair) signing on this PC: keys, Git, signers.ts, the push check",
    description:
      `Does only what is missing, so it is safe to run again at any time (spec 057): checks OpenSSH; makes your daily key (~/.ssh/fleet-signing; ssh-keygen asks for its passphrase, which is never stored); sets Git, for this repository only, to sign every commit with it; lists it in signers.ts; makes a recovery key in this PC's key store (beside the secrets, so every backup holds it) and lists it; installs the pre-push check; and makes one test signature when anything changed (or with --test). Never overwrites a key.`,
    tier: "repo",
    operation: true,
    noMcp: true,
    args: [{
      name: "test",
      type: "boolean",
      description: "Make the test signature even when nothing changed.",
    }],
    async run(a) {
      const { keysSetup } = await import("../identity/keys-commands.ts");
      return await keysSetup({ test: !!a.test });
    },
  },
  {
    name: "keys check-recovery",
    summary: "Prove the recovery key still works (a test signature; changes nothing)",
    description:
      `Checks that the key store's recovery key (or --key <file>) is the fleet's recovery key and that you still know its passphrase, by signing a test message and verifying it against signers.ts. Records the date on this PC: stolos keys and boot doctor remind you after six months (spec 057).`,
    tier: "read",
    operation: true,
    noMcp: true,
    args: [{
      name: "key",
      type: "string",
      human: true,
      description: "The recovery key's private file (default: the one in the key store).",
    }],
    async run(a) {
      const { keysCheckRecovery } = await import("../identity/keys-commands.ts");
      return await keysCheckRecovery(a.key as string | undefined);
    },
  },
  {
    name: "keys rotate",
    summary: "Replace your daily key with a new one, approved by the current one",
    description:
      `Makes a new daily key, puts it in signers.ts in place of the current one (same signer name), and commits that alone, signed with the current key. Then the new key takes the old one's place (the old pair is kept as <file>.retired-<date>, never used again); Git's settings do not change. If interrupted, run it again: it continues. Push to approve (spec 057).`,
    tier: "repo",
    operation: true,
    noMcp: true,
    args: [],
    async run() {
      const { keysRotate } = await import("../identity/keys-commands.ts");
      return await keysRotate();
    },
  },
  {
    name: "keys lost",
    summary: "Your daily key is lost or stolen: replace it, approved by the recovery key",
    description:
      `Makes a new daily key (with --stolen, the old one still here is retired first; without it, a key that is here and listed is left alone), puts it in signers.ts in place of the lost one, and commits that alone, signed with the recovery key you pass. Once pushed, servers stop trusting the old key. If interrupted, run it again: it continues (spec 057).`,
    tier: "repo",
    operation: true,
    noMcp: true,
    args: [{
      name: "recovery",
      type: "string",
      human: true,
      description: "The recovery key's private file (default: the one in the key store).",
    }, {
      name: "stolen",
      type: "boolean",
      description: "The daily key is still here but someone may have a copy: replace it too.",
    }],
    async run(a) {
      const { keysLost } = await import("../identity/keys-commands.ts");
      return await keysLost(a.recovery as string | undefined, !!a.stolen);
    },
  },
  {
    name: "keys rotate-recovery",
    summary:
      "Replace the recovery key, approved by the old one (or by the daily key if it is lost)",
    description:
      `Makes a new recovery key in the key store, tests it with a signature, puts it in signers.ts in place of the old one (same signer name), and commits that alone, signed with the OLD recovery key (the key store's, or --recovery <file>), which proves you still hold it. The old pair stays in the key store as fleet-recovery.retired-<date>. With --old-lost, the daily key signs instead, and it says so: a copied daily key could do the same. If interrupted, run it again: it continues; once done, it does nothing (spec 057).`,
    tier: "repo",
    place: "pc",
    operation: true,
    noMcp: true,
    args: [
      {
        name: "recovery",
        type: "string",
        human: true,
        description: "The OLD recovery key's private file (default: the one in the key store).",
      },
      {
        name: "old-lost",
        type: "boolean",
        human: true,
        description: "The old recovery key is lost: the daily key approves the change.",
      },
    ],
    async run(a) {
      const { keysRotateRecovery } = await import("../identity/keys-commands.ts");
      return await keysRotateRecovery({
        old: a.recovery as string | undefined,
        oldLost: !!a["old-lost"],
      });
    },
  },
  {
    name: "keys check-push",
    summary: "The pre-push check: what you push is signed by a key the fleet trusts",
    description:
      `Run by Git before each push (the hook keys setup installs): each pushed tip of the fleet's branch must be signed by a key signers.ts lists as of what the remote has now, the same check servers make (spec 047). Refuses the push otherwise, with the fix. Skip it once with git push --no-verify.`,
    tier: "read",
    noMcp: true,
    args: [],
    async run() {
      const { keysCheckPush } = await import("../identity/keys-commands.ts");
      return await keysCheckPush();
    },
  },
  {
    name: "host bootstrap",
    summary: "Finish a host whose Ubuntu was installed by hand (over SSH)",
    description:
      `For a server installed from Ubuntu's ISO (or any other way) instead of by network boot: copies the host's first-boot files and its deploy key over SSH and runs the same first boot with sudo (spec 005). Run it from the boot machine after stolos host add.`,
    tier: "repo",
    operation: true,
    args: [
      { name: "name", type: "string", positional: true, required: true, description: "Host name." },
      { name: "ssh", type: "string", required: true, description: "user@address of the server." },
    ],
    examples: [{
      cmd: "deno task stolos host bootstrap alpha --ssh alice@10.0.30.57",
      text: "Finish alpha after a manual Ubuntu install.",
    }],
    async run(a) {
      const { hostBootstrap } = await import("../install/host-bootstrap.ts");
      return await hostBootstrap({ name: a.name as string, ssh: a.ssh as string });
    },
  },
  {
    name: "workstation add",
    summary:
      "Set up this Ubuntu on WSL (or desktop) as a workstation: tools, dotfiles, the agent layer",
    description:
      `Run inside Ubuntu on WSL (or on an Ubuntu desktop), from the checkout in /srv/archon, as your own user. Writes fleets/<fleet>/hosts/<name>/host.ts as a workstation (spec 020) and converges, through sudo, only the user-level parts: the tools at their newest releases, the dotfiles (fish, oh-my-posh, tmux, git), Claude Code (the agent layer, spec 030), the archon command, and Ubuntu's daily updates. It checks first that this is the fleet's Ubuntu release, that systemd runs, and where the checkout is.`,
    tier: "repo",
    operation: true,
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        description: "Workstation name (default: this machine's hostname).",
      },
      { name: "user", type: "string", description: "Account to set up (default: you)." },
      { name: "force", type: "boolean", description: "Rewrite an existing host file." },
    ],
    examples: [{ cmd: "deno task stolos workstation add", text: "Set up this WSL Ubuntu." }],
    async run(a) {
      const { workstationAdd } = await import("../install/workstation.ts");
      return await workstationAdd({
        name: a.name as string | undefined,
        user: a.user as string | undefined,
        force: !!a.force,
      });
    },
  },
  {
    name: "apply",
    summary: "Converge this host to its plan",
    description:
      `Installs missing packages (apt or snap), converges accounts, writes files, and enables units, then runs queued actions. Idempotent (Article 11). With --check, shows what would change.`,
    tier: "mutate",
    readOnlyWith: "check",
    operation: true,
    args: [{
      name: "check",
      type: "boolean",
      description: "Show what would change; change nothing.",
    }],
    async run(a, ctx) {
      const { apply } = await import("../apply/apply.ts");
      const r = await apply(await requireHost(ctx.hostName), { check: !!a.check });
      return r.failed ? 1 : 0;
    },
  },
  {
    name: "verify",
    summary: "Run every verification command in this host's plan",
    description:
      `Checks every package, unit, and tool the plan declares (Article 15) and reports each failure with its command.`,
    tier: "read",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { failedChecks, verify } = await import("../state/verify.ts");
      const checks = await verify(await requireHost(ctx.hostName));
      // A warning check reports, but never counts as a failure (CheckDef).
      return failedChecks(checks).length ? 1 : 0;
    },
  },
  {
    name: "web status",
    summary: "This server's HTTPS: Traefik, the certificate, DNS, and every route",
    description:
      `Shows whether Traefik and the welcome page run, which certificate answers on 443 (Let's Encrypt, or Traefik's self-signed one until it arrives), whether <host>.<domain> resolves to this server, and every route: the welcome page at https://<host>.<domain>, Traefik's dashboard at traefik.<host>.<domain>, each route from the model and its capabilities (cockpit.<host>.<domain>), and each guest that publishes a port. Containers (Podman) publish themselves with the label traefik.enable=true. Everything behind the proxy answers the local networks only (spec 032). See docs/web.md.`,
    tier: "read",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { webStatus } = await import("../web/commands.ts");
      return await webStatus(ctx.hostName);
    },
  },
  {
    name: "web dns",
    summary: "Keep <host>.<domain> and *.<host>.<domain> in Cloudflare, to this server",
    description:
      `Creates or corrects this server's two A records in Cloudflare (its name and its wildcard, not proxied, TTL 60) to the address it reaches the network from now (the source of its default route: no reserved IPs needed), with the token the boot machine delivered (Zone: Read and DNS: Edit on the zone). Runs after an install and when a token arrives; archon web dns-check runs it whenever the address changes. Without fleet.web it does nothing (spec 032).`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { webDns } = await import("../web/commands.ts");
      return await webDns(ctx.hostName);
    },
  },
  {
    name: "web dns-check",
    summary: "Update Cloudflare if this server's address changed (the timer, every 5 minutes)",
    description:
      `Run by archon-web-dns.timer at boot and every 5 minutes: compares the address this server reaches the network from (its default route's source) with the one last published, and runs archon web dns only when it changed (a new DHCP lease) or a day has passed, so the records follow the server without reserved IPs. A change is journaled (archon-web) and the mailbox is told. Quiet otherwise: no run log (spec 032).`,
    tier: "mutate",
    unlocked: true,
    noMcp: true,
    args: [],
    async run(_a, ctx) {
      const { webDnsCheck } = await import("../web/commands.ts");
      return await webDnsCheck(ctx.hostName);
    },
  },
  {
    name: "web credential",
    summary: "Install the Cloudflare DNS token from stdin (deno task stolos boot web-push)",
    description:
      `Reads the web credential (JSON with a Cloudflare API token that has Zone: Read and DNS: Edit on the fleet's zone) on stdin and stores it root-only for archon web dns (/etc/archon/web/cloudflare.json) and for Traefik's DNS challenge (/etc/archon/web/cloudflare.env), restarts Traefik, then publishes this server's DNS records (spec 032). The boot machine sends it with deno task stolos boot web-push <host>; installs deliver it by themselves.`,
    tier: "mutate",
    operation: true,
    noMcp: true,
    args: [],
    async run(_a, ctx) {
      const { webCredential } = await import("../web/commands.ts");
      return await webCredential(ctx.hostName);
    },
  },
  {
    name: "web acme-export",
    summary: "Print Traefik's Let's Encrypt store as JSON (for boot reinstall)",
    description:
      `Prints this server's Traefik ACME store (the Let's Encrypt account, certificates, and keys) with each certificate's names and expiry, as JSON on stdout. deno task stolos boot reinstall runs it before rebooting the server and keeps the result on the boot machine; the install hands it back, so the new install serves the same trusted certificate from its first minute and does not ask Let's Encrypt again (spec 032). Root only; never offered over MCP.`,
    tier: "read",
    asOwner: true,
    noMcp: true,
    args: [],
    async run(_a, ctx) {
      const { exportAcme } = await import("../web/acme.ts");
      return await exportAcme(ctx.hostName);
    },
  },
  {
    name: "web serve",
    summary: "Serve this server's welcome page on loopback (the archon-web service)",
    description:
      `Serves the welcome page on http://127.0.0.1:8090, behind Traefik, which publishes it at https://<host>.<domain> and at any name or address no route claims: this server's health (last archon run, install record, certificate), its services with links, ports that listen but are not published (with the model line that would publish one), and how to work on it. Read-only; rendered per request (spec 032).`,
    tier: "read",
    unlocked: true,
    noMcp: true,
    args: [],
    async run(_a, ctx) {
      const { webServe } = await import("../web/serve.ts");
      return await webServe(ctx.hostName);
    },
  },
  {
    name: "guide",
    summary: "What's on this machine and how to use it, in plain words",
    description:
      `Lists, for newcomers, what is installed on this machine and how to use each part: your shell and dotfiles, web apps and containers, watching the server, what happens by itself (updates, firewall, backups, the history of /etc), email, and how changes are made through the repository. It starts with how to manage the server with an AI agent (Claude Code, Codex, or any MCP client) and keep the fleet up to date through Git. The same text is on the welcome page (https://<host>.<domain>), computed from this machine's own model (spec 035). See archon-guide(7) for the narrative guide.`,
    tier: "read",
    unlocked: true,
    args: [],
    async run(_a, ctx) {
      const { guide } = await import("../guide/command.ts");
      return await guide(ctx.hostName);
    },
  },
  {
    name: "fs smb on",
    summary: "Turn on SMB file sharing (Windows, macOS, Linux) on this server",
    description:
      `Starts Samba on this server and records the decision in the host's own archon.sql (opt-in smb) (who, when), so every apply and reboot keeps it on until an operator runs archon fs smb off. Clients on the local networks connect to smb.<host>.<domain> (for example \\\\smb.alpha.lab.example.net\\shared): one share, shared, for everyone with an account, and each account's own home folder. --durable or --ephemeral is required (Article 23, spec 044): durable shares are archived nightly and guarded; ephemeral ones are not. SMB3 only, encryption when the client supports it, no guests. People sign in with their own Linux username and password: Samba keeps a copy, updated by PAM whenever the password is typed on the server (Cockpit, sudo, a password login, passwd); an account not on this server gets no access. The mailbox is told. The switch is in this machine's own archon.sql (spec 048).`,
    tier: "mutate",
    operation: true,
    args: [...CHOICE_ARGS, CONFIRM_DESTROY_ARG("the host's name")],
    async run(a, ctx) {
      const { smbOn } = await import("../smb/commands.ts");
      return await smbOn(ctx.hostName, chooseData(a, "the SMB shares"), a["confirm-destroy"]);
    },
  },
  {
    name: "fs smb off",
    summary: "Turn off SMB file sharing on this server",
    description:
      `Stops and masks Samba and records the decision in the host's own archon.sql (opt-in smb), so it stays off across applies, reboots, and reinstalls until an operator runs archon fs smb on. Shared files and SMB passwords are kept (spec 037).`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { smbOff } = await import("../smb/commands.ts");
      return await smbOff(ctx.hostName);
    },
  },
  {
    name: "fs smb status",
    summary: "Whether SMB file sharing is on, its shares, and how to connect",
    description:
      `Shows whether SMB is on (since when, and who turned it on), whether smbd runs and port 445 listens, the shares and who may use them, which accounts Samba already knows the password of (as root), and how to connect from Windows, macOS, and Linux (spec 037).`,
    tier: "read",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { smbStatus } = await import("../smb/commands.ts");
      return await smbStatus(ctx.hostName);
    },
  },
  {
    name: "pg list",
    summary: "List this server's PostgreSQL instances",
    description:
      `Every PostgreSQL instance Archon keeps on this server (from the model and the host's record, the host's own archon.sql (opt-in pg)): name, version, port, status, environment, and whether it is published. Clusters Archon did not create are listed as not Archon's and left alone. --json prints {host, instances, notArchons} (spec 038). See archon-pg(7).`,
    tier: "read",
    unlocked: true,
    args: [],
    async run(_a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgList(ctx.hostName, ctx.json);
    },
  },
  {
    name: "pg status",
    summary: "One PostgreSQL instance: version, port, status, published",
    description:
      `Shows one instance (default prime): its version, port, postgresql-common unit, data directory, status, whether it accepts connections, environment, protected or not, and where it is published. Exits non-zero when it is not online. (spec 038). See archon-pg(7).`,
    tier: "read",
    unlocked: true,
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance (default prime).",
    }],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgStatus(ctx.hostName, a.name as string, ctx.json);
    },
  },
  {
    name: "pg ensure",
    summary: "Create a PostgreSQL instance, or make sure it is right (idempotent)",
    description:
      `Makes the instance exist and match the model: the cluster <version>/<name> (pg_createcluster, its own port from 5432 up, its own data directory, unit, and log), Archon's configuration (conf.d/50-archon.conf: localhost only, scram-sha-256, TLS 1.3), pg_hba.conf (peer on the socket, scram-sha-256 on loopback), its roles and their passwords, and their databases. An instance not in the model is recorded in the host's own archon.sql (opt-in pg), and every apply keeps it from then on. An instance that exists, is Archon's, and is online needs nothing, so ensure then answers without sudo: an app's service account runs it unattended. Never touches a cluster Archon did not create. --json prints {ok, name, version, port, status, unit, created, changes}; a failure exits non-zero with one sentence. (spec 038). See archon-pg(7).`,
    tier: "mutate",
    precheck: async (a, ctx) =>
      (await import("../pg/commands.ts")).pgEnsureReady(
        ctx.hostName,
        a.name as string,
        a.version as string | undefined,
        ctx.json,
      ),
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance (default prime).",
    }, {
      name: "version",
      type: "string",
      description: "Major version for a new instance (default 18, Ubuntu's; others from PGDG).",
    }],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgEnsure(
        ctx.hostName,
        a.name as string,
        a.version as string | undefined,
        ctx.json,
      );
    },
  },
  {
    name: "pg start",
    summary: "Start a PostgreSQL instance",
    description:
      `pg_ctlcluster <version> <name> start, for an instance Archon created. (spec 038). See archon-pg(7).`,
    tier: "mutate",
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance (default prime).",
    }],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgControl(ctx.hostName, a.name as string, "start");
    },
  },
  {
    name: "pg stop",
    summary: "Stop a PostgreSQL instance",
    description:
      `pg_ctlcluster <version> <name> stop, for an instance Archon created. A stopped instance is started again by the next apply (the model says it runs). (spec 038). See archon-pg(7).`,
    tier: "mutate",
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance (default prime).",
    }],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgControl(ctx.hostName, a.name as string, "stop");
    },
  },
  {
    name: "pg restart",
    summary: "Restart a PostgreSQL instance",
    description:
      `pg_ctlcluster <version> <name> restart, for an instance Archon created. (spec 038). See archon-pg(7).`,
    tier: "mutate",
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance (default prime).",
    }],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgControl(ctx.hostName, a.name as string, "restart");
    },
  },
  {
    name: "pg reload",
    summary: "Reload the configuration of a PostgreSQL instance",
    description:
      `pg_ctlcluster <version> <name> reload, for an instance Archon created. (spec 038). See archon-pg(7).`,
    tier: "mutate",
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance (default prime).",
    }],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgControl(ctx.hostName, a.name as string, "reload");
    },
  },
  {
    name: "pg upgrade",
    summary: "Upgrade a PostgreSQL instance to a newer major version",
    description:
      `Dumps the instance first (never in place without a backup), installs the new version, and runs pg_upgradecluster; the old cluster is kept, stopped, until archon pg remove NAME --version OLD. Destructive: runs only when specs/038-pg/spec.md has the owner's approve: destructive line and --confirm-destroy repeats the name. Never served over MCP. (spec 038). See archon-pg(7).`,
    tier: "destructive",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
      { name: "to", type: "string", description: "The major version to upgrade to." },
      {
        name: "confirm-destroy",
        type: "string",
        human: true,
        description:
          "The instance's name again (destructive operations; typed by a person, Article 23).",
      },
    ],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgUpgrade(
        ctx.hostName,
        a.name as string,
        a.to as string | undefined,
        a["confirm-destroy"] as string | undefined,
      );
    },
  },
  {
    name: "pg remove",
    summary: "Remove a PostgreSQL instance (dumped first)",
    description:
      `Dumps the instance, drops its cluster (pg_dropcluster), and forgets its record and passwords; with --version, removes only an older cluster kept after an upgrade. An instance in the model must leave the model first. Destructive: runs only when specs/038-pg/spec.md has the owner's approve: destructive line and --confirm-destroy repeats the name. Never served over MCP. (spec 038). See archon-pg(7).`,
    tier: "destructive",
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance (default prime).",
    }, {
      name: "version",
      type: "string",
      description: "Remove only this older version, kept after an upgrade.",
    }, {
      name: "confirm-destroy",
      type: "string",
      human: true,
      description:
        "The instance's name again (destructive operations; typed by a person, Article 23).",
    }],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgRemove(
        ctx.hostName,
        a.name as string,
        a.version as string | undefined,
        a["confirm-destroy"] as string | undefined,
      );
    },
  },
  {
    name: "pg backup",
    summary: "Dump a PostgreSQL instance now",
    description:
      `pg_dumpall, compressed with zstd, into /var/backups/archon/pg/<name>/ (root only), keeping the last 7; spec 016's nightly archive carries them, and a timer dumps every instance nightly before it (archon pg backup --all). (spec 038). See archon-pg(7).`,
    tier: "mutate",
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance (default prime).",
    }, { name: "all", type: "boolean", description: "Every instance Archon created." }],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgBackup(ctx.hostName, a.name as string, !!a.all, ctx.json);
    },
  },
  {
    name: "pg restore",
    summary: "Restore a PostgreSQL instance from a dump",
    description:
      `Loads a dump (the newest in /var/backups/archon/pg/<name>/, or --from FILE) into the instance, after dumping what is there now, then sets Archon's passwords again. Destructive: runs only when specs/038-pg/spec.md has the owner's approve: destructive line and --confirm-destroy repeats the name. Never served over MCP. (spec 038). See archon-pg(7).`,
    tier: "destructive",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
      { name: "from", type: "string", description: "The dump to load (.sql.zst)." },
      {
        name: "confirm-destroy",
        type: "string",
        human: true,
        description:
          "The instance's name again (destructive operations; typed by a person, Article 23).",
      },
    ],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgRestore(
        ctx.hostName,
        a.name as string,
        a.from as string | undefined,
        a["confirm-destroy"] as string | undefined,
      );
    },
  },
  {
    name: "pg maintain",
    summary: "VACUUM ANALYZE an instance, and report connections, sizes, and bloat",
    description:
      `Runs VACUUM ANALYZE on every database (online; nothing is locked or rewritten) and reports connections by database and state against max_connections, database sizes, and the tables with the most dead rows. Read tier: it changes no data or configuration. Runs as root. (spec 038). See archon-pg(7).`,
    tier: "read",
    asOwner: true,
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance (default prime).",
    }],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgMaintain(ctx.hostName, a.name as string, ctx.json);
    },
  },
  {
    name: "pg publish",
    summary: "Make a PostgreSQL instance reachable over TLS (every address, or --local-only)",
    description:
      `Records the decision in the host's own archon.sql (opt-in pg) and applies it: PostgreSQL also listens on the server's address, pg_hba.conf admits TLS with scram-sha-256 (hostssl; postgres refused over any network), the firewall opens the instance's port, and PostgreSQL serves the server's wildcard certificate, so clients use pg-<name>.<host>.<domain> with sslmode=verify-full sslrootcert=system (archon pg show NAME --form external prints it all). By default every address may connect: the router decides what reaches the server from outside. With --local-only, the local networks only, in pg_hba.conf and the firewall. Publishing again changes the scope. PostgreSQL speaks TLS itself; Traefik is not involved. Undo with archon pg unpublish (spec 038).`,
    tier: "mutate",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
      {
        name: "local-only",
        type: "boolean",
        description: "Only the local networks may connect (pg_hba.conf and the firewall).",
      },
    ],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgPublish(ctx.hostName, a.name as string, true, !!a["local-only"]);
    },
  },
  {
    name: "pg unpublish",
    summary: "Make a PostgreSQL instance private again",
    description:
      `Records the decision and applies it: localhost only, the hostssl lines and the firewall rule removed. (spec 038). See archon-pg(7).`,
    tier: "mutate",
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance (default prime).",
    }],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgPublish(ctx.hostName, a.name as string, false);
    },
  },
  {
    name: "pg connect",
    summary: "Print, or write, your libpq service for an instance (no password on the server)",
    description:
      `Prints the libpq service block for ~/.pg_service.conf; with --write, writes it there (0600, replacing only that service). On the server you connect as your own role over the socket (peer): your Linux account is your PostgreSQL identity, and no password is involved. With --remote, the service uses the published name with TLS (sslmode=verify-full sslrootcert=system): a person types their Linux password (libpq asks; PAM keeps PostgreSQL's copy in step), and a service account also gets its generated password in its own ~/.pgpass. Services: everyone already has the instances in the system-wide service file, so psql service=<name> works without this. --json prints {ok, service, host, port, user, database, sslmode, published?, files?}; a failure exits non-zero with one sentence (specs 038, 039). See archon-pg(7).`,
    tier: "read",
    unlocked: true,
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
      {
        name: "write",
        type: "boolean",
        description: "Write ~/.pg_service.conf (and, for a service with --remote, ~/.pgpass).",
      },
      {
        name: "remote",
        type: "boolean",
        description: "The published name, for clients on another machine.",
      },
    ],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgConnect(ctx.hostName, a.name as string, !!a.write, !!a.remote, ctx.json);
    },
  },
  {
    name: "pg admin-tui",
    summary: "Browse, query, and edit an instance in rainfrog, already connected",
    description:
      `Starts rainfrog (a terminal UI for PostgreSQL: tables, a query editor, results) connected to NAME (default prime). NAME is found the way archon pg show finds it: an instance Archon keeps, any cluster on this host, or a section of your service files. On this server it connects through the socket as you (peer, no password); with --remote, to the published name over TLS with sslmode=verify-full against the system's trusted roots. A password never goes on rainfrog's command line (other accounts see those): it asks for one when it needs it. Needs a terminal; not an MCP tool (spec 043). See archon-pg(7).`,
    tier: "read",
    unlocked: true,
    // Full screen and interactive: nothing for an agent to read.
    noMcp: true,
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance, cluster, or service section (default prime).",
    }, {
      name: "remote",
      type: "boolean",
      description: "Connect to the published name over TLS (verify-full), as from another machine.",
    }],
    async run(a, ctx) {
      const { pgTui } = await import("../pg/tui.ts");
      return await pgTui(ctx.hostName, "rainfrog", a.name as string, !!a.remote);
    },
  },
  {
    name: "pg observe-tui",
    summary: "Watch an instance live in pgcenter top, already connected",
    description:
      `Starts pgcenter top (live activity, statements, waits, tables, and the server's CPU, memory, and disks) connected to NAME (default prime). NAME is found the way archon pg show finds it: an instance Archon keeps, any cluster on this host, or a section of your service files. On this server it connects through the socket as you (peer, no password); with --remote, to the published name over TLS with sslmode=verify-full against the system's trusted roots. Over the network, the password comes from your ~/.pgpass when it has a line for the instance, else it is asked here and handed to pgcenter in its own environment only (never its command line, a file, or a log). pgcenter needs pg_monitor for every view, which people are given (spec 039). Needs a terminal; not an MCP tool (spec 043). See archon-pg(7).`,
    tier: "read",
    unlocked: true,
    // Full screen and interactive: nothing for an agent to read.
    noMcp: true,
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance, cluster, or service section (default prime).",
    }, {
      name: "remote",
      type: "boolean",
      description: "Connect to the published name over TLS (verify-full), as from another machine.",
    }],
    async run(a, ctx) {
      const { pgTui } = await import("../pg/tui.ts");
      return await pgTui(ctx.hostName, "pgcenter", a.name as string, !!a.remote);
    },
  },
  {
    name: "data",
    summary: "Whether this server is durable or ephemeral, and why",
    description:
      `Article 23 (spec 044): every source of end users' data (PostgreSQL, S3, SMB shares, LXD guests) is either durable (it exists nowhere else) or ephemeral (losing it is harmless), chosen by the operator when it is turned on; there is no default. A server is durable when anything on it is durable, and ephemeral otherwise. Lists each source and its choice, says what the class means (a durable server is archived nightly and nothing reinstalls or wipes it without --confirm-destroy), and exits non-zero when a source has no recorded choice (it counts as durable). Home directories are ephemeral by rule. The boot machine asks this before a reinstall.`,
    tier: "read",
    operation: true,
    unlocked: true,
    args: [],
    async run(_a, ctx) {
      const { dataShow } = await import("../optin/data.ts");
      return await dataShow(ctx.hostName, ctx.json);
    },
  },
  {
    name: "data set",
    summary: "Record an opt-in's data as durable or ephemeral",
    description:
      `Changes the choice made when the opt-in was turned on (pg, s3, or smb; a guest's is in the model). Ephemeral to durable needs nothing; durable to ephemeral removes the protection, so it needs --confirm-destroy with the host's name, typed by a person (never over MCP). Recorded in an opt-in record in this machine's own archon.sql; the mailbox is told (spec 044).`,
    tier: "mutate",
    operation: true,
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        required: true,
        description: "The opt-in: pg, s3, or smb.",
      },
      ...CHOICE_ARGS,
      CONFIRM_DESTROY_ARG("the host's name"),
    ],
    async run(a, ctx) {
      const { dataSet } = await import("../optin/data.ts");
      return await dataSet(
        ctx.hostName,
        a.name as string,
        chooseData(a, a.name as string),
        a["confirm-destroy"],
      );
    },
  },
  {
    name: "opt-in",
    summary: "This server's opt-in services and containers: on or off, since when, by whom",
    description:
      `Opt-in services and containers (spec 040) are on every server and off until an operator turns one on; then they stay on, across applies and reboots, until an operator turns them off. Each decision is the host's record, an opt-in record in this machine's own archon.sql. Lists each one: SMB file sharing (archon fs smb), PostgreSQL (archon pg), and S3 object storage (archon fs s3), whether it is on, since when, who turned it on, and the command that turns it on or shows it. Where an opt-in can use Linux accounts and their credentials, it does.`,
    tier: "read",
    unlocked: true,
    args: [],
    async run(_a, ctx) {
      const { optInList } = await import("../optin/optin.ts");
      return await optInList(ctx.hostName, ctx.json);
    },
  },
  {
    name: "pg connections",
    summary: "Your PostgreSQL password file and service files, as libpq reads them (no passwords)",
    description:
      `Lists every entry of your PostgreSQL password file (~/.pgpass, or PGPASSFILE) and every section of your service files (~/.pg_service.conf, or PGSERVICEFILE, then the system's /etc/postgresql-common/pg_service.conf), matched the way libpq matches them. For each password-file entry: host, port, database, and user, which services it serves, and whether libpq can use it. Problems are named with their reason: an entry without five fields, an entry no service uses, a password file that group or others can access (libpq then ignores the whole file), a service section that holds a password, and a network service without sslmode=verify-full. A password is never printed, logged, or returned, in text, JSON, an MCP result, or an error. Read-only; it works for entries Archon did not make (spec 043).`,
    tier: "read",
    unlocked: true,
    args: [],
    async run(_a, ctx) {
      const { pgConnections } = await import("../pg/connections.ts");
      return await pgConnections(ctx.json);
    },
  },
  {
    name: "pg show",
    summary:
      "How to reach an instance: conninfo, URL, PG* environment, a service section, or everything for an external client",
    description:
      `Prints how to reach NAME (default prime): an instance Archon keeps, any cluster on this host (Archon's or not), or a section of your service files. --form conninfo (the default, a libpq connection string), url (postgresql://user@host:port/db), env (PG* settings to export), service (a service-file section), jdbc (a JDBC URL for DBeaver, IntelliJ, and Java apps: sslmode=verify-full with Java's own trust store, since pgJDBC reads sslrootcert as a file), npgsql (a connection string for .NET, Power BI, and Excel's Power Query, which trust the system's store), odbc (psqlODBC connection strings for Windows and Linux), dotenv (DATABASE_URL lines for app frameworks: libpq-based, Node, and Prisma), pgadmin (a servers.json for pgAdmin's Import Servers), ca (the root certificate behind the server's chain, fetched with PostgreSQL's own STARTTLS and checked against the system's trusted roots, for clients without a system store: libpq's root.crt), or external (everything a client on another machine needs: the published name and the server's IP address as hostaddr, port, database, user, sslmode=verify-full, sslrootcert=system, where the password comes from, then the four forms filled in for that client). On this host it is the socket directory and you as yourself (peer); with --remote, or for a service whose host is on the network, the published name with sslmode=verify-full and sslrootcert=system, never a fallback to plain text. No password in any form: it stays in ~/.pgpass for libpq. An unknown form is a usage error that lists them all. Read-only (spec 043).`,
    tier: "read",
    unlocked: true,
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance, cluster, or service (default prime).",
      },
      {
        name: "form",
        type: "string",
        default: "conninfo",
        description:
          "conninfo, url, env, service, jdbc, npgsql, odbc, dotenv, pgadmin, ca, or external.",
      },
      {
        name: "remote",
        type: "boolean",
        description: "The published name, for a client on another machine.",
      },
    ],
    async run(a, ctx) {
      const { pgShow } = await import("../pg/connections.ts");
      return await pgShow(ctx.hostName, a.name as string, a.form as string, !!a.remote, ctx.json);
    },
  },
  {
    name: "pg test",
    summary: "Test an external connection: TLS to the published name, with a password you type",
    description:
      `Connects to NAME (default prime) the way a client on another machine does: to its published name, never localhost, over TLS with the server's certificate verified (sslmode=verify-full), as you (or --user) with a password you type (not echoed, not stored: it reaches psql through a private, temporary password file removed at once). Reports who you connected as, the server's and your addresses, and the TLS version; on failure, the likely cause and its fix: the password (PostgreSQL learns your Linux password when you type it on the server after publishing: sudo -k && sudo -v there), the certificate, the address not admitted (--local-only), the name not resolving, or nothing answering (firewall, router). Run it from another machine (a workstation) to test the firewall and the router too. Interactive, so not an MCP tool (spec 043).`,
    tier: "read",
    unlocked: true,
    noMcp: true,
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The published instance (default prime).",
      },
      { name: "user", type: "string", description: "The role (default: you)." },
    ],
    async run(a, ctx) {
      const { pgTest } = await import("../pg/connections.ts");
      return await pgTest(ctx.hostName, a.name as string, a.user as string | undefined);
    },
  },
  {
    name: "pg on",
    summary: "Turn PostgreSQL on for this server (off until an operator does)",
    description:
      `PostgreSQL is an opt-in service (spec 040): every server has postgresql-common, and postgresql.service stays masked until an operator runs this. --durable or --ephemeral is required (Article 23, spec 044): durable makes the server durable (guarded against reinstalls and wipes). It records the decision in the host's own archon.sql (opt-in pg) (who, when, which) and applies it: postgresql.service is unmasked and started, and every instance in the model and the host's record is created or started. Every apply, reboot, and reinstall keeps it on until an operator runs archon pg off. The mailbox is told. See archon-pg(7) and archon-opt-in(1).`,
    tier: "mutate",
    operation: true,
    args: [...CHOICE_ARGS, CONFIRM_DESTROY_ARG("the host's name")],
    async run(a, ctx) {
      const { setOptIn } = await import("../optin/optin.ts");
      return await setOptIn(ctx.hostName, "pg", true, {
        data: chooseData(a, "PostgreSQL's data"),
        confirm: a["confirm-destroy"],
      });
    },
  },
  {
    name: "pg off",
    summary: "Turn PostgreSQL off for this server: every instance stopped and held",
    description:
      `Records the decision and applies it: postgresql.service is masked and stopped, which stops every instance (each is PartOf it), and nothing starts them (a reboot included) until an operator runs archon pg on. Data, roles, and passwords are kept (spec 040).`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { setOptIn } = await import("../optin/optin.ts");
      return await setOptIn(ctx.hostName, "pg", false);
    },
  },
  {
    name: "pg who",
    summary: "An instance's roles and the Linux accounts behind them",
    description:
      `Lists every role in the instance: its kind (human, service, group, the superuser postgres), whether a Linux account of that name exists, whether it can log in, whether it is a superuser, whether it has a password (as root), and its groups. Exits non-zero when a rule of spec 039 is broken: a role that can log in without a Linux account, a superuser other than postgres, or a person's password on a private instance. See archon-pg(7).`,
    tier: "read",
    unlocked: true,
    args: [{
      name: "name",
      type: "string",
      positional: true,
      default: "prime",
      description: "The instance (default prime).",
    }],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgWho(ctx.hostName, a.name as string, ctx.json);
    },
  },
  {
    name: "pg passwd-sync",
    summary: "Give PostgreSQL a person's Linux password (run by PAM)",
    description:
      `Run by Archon's PAM hook (as root, in the background) after Linux accepts or changes a password: reads it from standard input and, for each instance where that person has a role, sets a SCRAM verifier of the same password, so a published instance takes their Linux password. Nothing else is stored, printed, or logged. Not for people to run (spec 039).`,
    tier: "mutate",
    unlocked: true,
    noMcp: true,
    args: [{
      name: "user",
      type: "string",
      positional: true,
      required: true,
      description: "The account.",
    }],
    async run(a, ctx) {
      const m = await import("../pg/commands.ts");
      return await m.pgPasswdSync(ctx.hostName, a.user as string);
    },
  },
  {
    name: "decide",
    summary:
      "Record an opt-in decision for a host in Git (on a workstation): on or off, durable or ephemeral",
    description:
      `Writes fleets/<fleet>/hosts/<host>/decisions.ts (spec 047): whether an opt-in (pg, s3, smb, otel-ui) is on for that host and, for one that holds end users' data, whether that data is durable or ephemeral (Article 23). A decision in Git wins over the host's own record, survives a re-install, and lets the boot machine know a host's data class while it is offline. Commit it signed and push: the host applies it within 15 minutes. Durable to ephemeral needs --confirm-destroy with the host's name, typed by a person.`,
    tier: "repo",
    noMcp: true,
    operation: true,
    args: [
      {
        name: "opt-in",
        type: "string",
        positional: true,
        required: true,
        description: "pg, s3, smb, or otel-ui.",
      },
      {
        name: "state",
        type: "string",
        positional: true,
        required: true,
        description: "on or off.",
      },
      ...CHOICE_ARGS,
      CONFIRM_DESTROY_ARG("the host's name"),
    ],
    examples: [{
      cmd: "deno task stolos decide pg on --durable --host olympia",
      text: "PostgreSQL on for olympia, its data durable; then commit -S and push.",
    }],
    async run(a, ctx) {
      const state = String(a.state);
      if (state !== "on" && state !== "off") throw new Error("say on or off");
      const { decide } = await import("../fleet/decisions.ts");
      const { currentUser } = await import("../core/exec.ts");
      const data = a.durable ? "durable" : a.ephemeral ? "ephemeral" : undefined;
      if (a.durable && a.ephemeral) throw new Error("--durable or --ephemeral, not both");
      return await decide(
        ctx.hostName,
        String(a["opt-in"]),
        state === "on",
        data,
        a["confirm-destroy"],
        currentUser() || "operator",
      );
    },
  },
  {
    name: "otel ui on",
    summary: "Turn on the telemetry web UI (OpenObserve) on this server; it collects for the fleet",
    description:
      `The telemetry web UI is an opt-in container (specs 040, 050): every server has it, masked, until an operator runs this. --durable or --ephemeral is required (Article 23, spec 044); telemetry is usually ephemeral. OpenObserve (pinned by digest) starts under Podman, unprivileged, on 127.0.0.1; Traefik serves it on the local networks at otel.<host>.<domain>; its admin password is generated here, root only (archon otel ui password --show). This server's Collector then forwards everything it collects (journald, PCP, Archon's and apps' OTLP) to it, adding the credential itself, and accepts OTLP from the local networks on 4318: point otel.localdomain (router DNS) or telemetry.collector in fleet.ts at this server and the others find it within 15 minutes. Only telemetry from then on is forwarded. Until this is on anywhere, every server keeps its own telemetry and the headless Collector works as before. See docs/telemetry.md.`,
    tier: "mutate",
    operation: true,
    args: [...CHOICE_ARGS, CONFIRM_DESTROY_ARG("the host's name")],
    async run(a, ctx) {
      const { setOptIn } = await import("../optin/optin.ts");
      const code = await setOptIn(ctx.hostName, "otel-ui", true, {
        data: chooseData(a, "the telemetry the web UI keeps"),
        confirm: a["confirm-destroy"],
      });
      // Forward to it at once (the discovery timer would within 15 minutes).
      const { discover } = await import("../observe/discover.ts");
      // A fresh load: the record just written is part of the host's model.
      await discover(await requireHost(ctx.hostName)).catch(() => 0);
      return code;
    },
  },
  {
    name: "otel ui off",
    summary: "Turn off the telemetry web UI on this server (its data kept)",
    description:
      `Records the decision and applies it: the container stops and its unit is masked, its route leaves Traefik, the Collector stops accepting OTLP from the network and goes back to local only (or to another collector it finds). /srv/otel-ui and the credentials are kept (specs 040, 050).`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { setOptIn } = await import("../optin/optin.ts");
      const code = await setOptIn(ctx.hostName, "otel-ui", false);
      const { discover } = await import("../observe/discover.ts");
      // A fresh load: the record just written is part of the host's model.
      await discover(await requireHost(ctx.hostName)).catch(() => 0);
      return code;
    },
  },
  {
    name: "otel ui status",
    summary:
      "Whether the telemetry web UI is on here, ready, where, and where this server forwards",
    description:
      `Read-only (spec 050): on or off, whether OpenObserve answers, its address, and the collector this server forwards to (the web UI here, telemetry.collector, otel.localdomain, the boot PC, or none). --json for tools.`,
    tier: "read",
    args: [],
    async run(_a, ctx) {
      const { otelUiStatus } = await import("../otelui/otelui.ts");
      return await otelUiStatus(ctx.hostName, ctx.json);
    },
  },
  {
    name: "otel ui password",
    summary: "The telemetry web UI's sign-in (the password only with --show, typed by a person)",
    description:
      `Prints the admin's sign-in name; with --show, its password too. The password is root only on this server; --show is typed by a person and never offered over MCP (spec 050).`,
    tier: "mutate",
    noMcp: true,
    args: [{
      name: "show",
      type: "boolean",
      human: true,
      description: "Print the password (typed by a person).",
    }],
    async run(a) {
      const { otelUiPassword } = await import("../otelui/otelui.ts");
      return await otelUiPassword(!!a.show);
    },
  },
  {
    name: "fs s3 on",
    summary: "Turn on S3 object storage (RustFS) on this server",
    description:
      `S3 object storage is an opt-in container (specs 040, 041): every server has it, masked, until an operator runs this. --durable or --ephemeral is required (Article 23, spec 044): durable buckets (/srv/s3) are archived nightly and the server is guarded against reinstalls and wipes. Records the decision in the host's own archon.sql (opt-in s3) (who, when, which) and applies it: RustFS (pinned by digest) is pulled and started under Podman, as an unprivileged user with every capability dropped, on 127.0.0.1 only; Traefik serves it on the local networks at s3.<host>.<domain> (the S3 API, path-style) and s3-console.<host>.<domain> (the console). Every person on the server and every fleet service account gets an S3 user of the same name, allowed the buckets named <name>-*, with a secret only that account can read (archon fs s3 key). It stays on, across applies and reboots, until an operator runs archon fs s3 off. The mailbox is told.`,
    tier: "mutate",
    operation: true,
    args: [...CHOICE_ARGS, CONFIRM_DESTROY_ARG("the host's name")],
    async run(a, ctx) {
      const { setOptIn } = await import("../optin/optin.ts");
      return await setOptIn(ctx.hostName, "s3", true, {
        data: chooseData(a, "the S3 buckets"),
        confirm: a["confirm-destroy"],
      });
    },
  },
  {
    name: "fs s3 off",
    summary: "Turn off S3 object storage on this server (data kept)",
    description:
      `Records the decision and applies it: the container is stopped and its unit masked, its routes leave Traefik, and it stays off until an operator runs archon fs s3 on. Buckets, users, and keys are kept (/srv/s3, /var/lib/archon/s3, /var/lib/archon-keys/s3) (specs 040, 041).`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { setOptIn } = await import("../optin/optin.ts");
      return await setOptIn(ctx.hostName, "s3", false);
    },
  },
  {
    name: "fs s3 status",
    summary: "Whether S3 object storage is on, ready, and where",
    description:
      `Shows whether S3 is on (since when, who turned it on), whether its container runs and answers ready, the API and console addresses, and (as root) its users. Exits non-zero when it is on but not ready (spec 041).`,
    tier: "read",
    unlocked: true,
    args: [],
    async run(_a, ctx) {
      const { s3Status } = await import("../s3/s3.ts");
      return await s3Status(ctx.hostName, ctx.json);
    },
  },
  {
    name: "fs s3 key",
    summary: "Your S3 access key (your username) and secret, or an AWS profile with them",
    description:
      `Your S3 user is your Linux username; its secret was generated on the server and only you (and root) can read it: S3 signs every request with a secret the server keeps, so it cannot be your Linux password. Without --write, shows your access key, the endpoint, and your buckets (<you>-*). With --write, puts a profile s3-<host> in ~/.aws/credentials and ~/.aws/config (0600, replacing only that profile), for the aws CLI, rclone, and the SDKs. The web console (s3-console.<host>.<domain>) signs in with Account: your username and Key: this secret, not your Linux password; --show prints the secret on your terminal to paste there (never in JSON, a log, MCP, or for an agent). --rotate gives you a new secret at once (through sudo) and the old one stops working: use it when the secret may have been seen, then run --write again and update anything that uses it. Run it as the account that needs the key (a service: sudo -u s-<app> archon fs s3 key --write) (spec 041).`,
    tier: "read",
    mutateWith: "rotate",
    unlocked: true,
    args: [{
      name: "write",
      type: "boolean",
      description: "Write the s3-<host> profile into ~/.aws.",
    }, {
      name: "show",
      type: "boolean",
      human: true,
      description:
        "Print your secret key on this terminal, to paste into the web console's Key field. Only on a terminal, never in JSON or a log, never over MCP or for an agent.",
    }, {
      name: "rotate",
      type: "boolean",
      description:
        "Give your S3 user a new secret now (it asks sudo); the old one stops working at once.",
    }],
    async run(a, ctx) {
      const m = await import("../s3/s3.ts");
      if (a.rotate) return await m.s3Rotate(ctx.hostName);
      return await m.s3Key(ctx.hostName, !!a.write, ctx.json, !!a.show);
    },
  },
  {
    name: "shell emit",
    summary: "Print the shell code for Archon's aliases, keys, and prompt",
    description:
      `Prints, for bash, zsh, or fish, the code that turns on Archon's shell features: the modern ls, ll, la, and tree (eza), cat (bat), and fd; fzf's keys (Ctrl+R history, Ctrl+T files, Alt+C folders); zoxide's z; delta for git; the terminal title; and the prompt. One line in a shell's startup file turns it all on, and a shell without that line gets none of it:\n\n  bash  ~/.bashrc:                  eval "$(archon shell emit bash)"\n  zsh   ~/.zshrc:                   eval "$(archon shell emit zsh)"\n  fish  ~/.config/fish/config.fish: archon shell emit fish | source\n\nThe fleet's dotfiles carry the line for everyone (man archon-dotfiles). Without a shell name, the shell that runs the line is used (its parent process, else $SHELL). Everything is guarded: nothing happens in a non-interactive shell, and each piece only when its tool is installed. The prompt is plain (no icons, status in words) on a console terminal (the physical console or a serial line) and Oh My Posh everywhere else; ARCHON_PROMPT=plain or ARCHON_PROMPT=pretty overrides that. The output is rendered into /usr/local/share/archon/shell/init.<shell> by archon apply, and the archon launcher prints that file without starting Deno, so a new shell starts fast (spec 036).`,
    tier: "read",
    unlocked: true,
    noMcp: true,
    args: [{
      name: "shell",
      type: "string",
      positional: true,
      description: "bash, zsh, or fish (default: the shell that runs it).",
    }],
    async run(a) {
      const { shellEmit } = await import("../shell/emit.ts");
      return await shellEmit(a.shell as string | undefined);
    },
  },
  {
    name: "shell status",
    summary: "Which of your shells have Archon's shell features turned on",
    description:
      `Checks ~/.bashrc, ~/.zshrc, and ~/.config/fish/config.fish for the archon shell emit line, and shows the line to add where it is missing (spec 036).`,
    tier: "read",
    unlocked: true,
    args: [],
    async run() {
      const { shellStatus } = await import("../shell/emit.ts");
      return await shellStatus();
    },
  },
  {
    name: "dotfiles",
    summary: "Show where your dotfiles come from (layers in the repository)",
    description:
      `Lists the layers that make up a user's chezmoi source on this host, most general first: the engine's home/ (every fleet), fleets/<id>/home/ (everyone in this fleet), fleets/<id>/hosts/<host>/home/ (everyone on this host), fleets/<id>/users/<user>/home/ (this user everywhere), and fleets/<id>/hosts/<host>/users/<user>/home/ (this user here). A later layer replaces a file with the same target. With a path (~/.bashrc, .config/fish/config.fish), shows the one layer and repository file that provide it; without, every managed file and its layer. Read-only: archon apply composes the source into /var/lib/archon-dotfiles/<user> and runs chezmoi from there (spec 031). See archon-dotfiles(7).`,
    tier: "read",
    unlocked: true,
    args: [
      {
        name: "path",
        type: "string",
        positional: true,
        description: "A file in the home directory (~/.bashrc or .bashrc).",
      },
      { name: "user", type: "string", description: "Whose dotfiles (default: you)." },
    ],
    async run(a, ctx) {
      const { dotfilesReport } = await import("../dotfiles/report.ts");
      return await dotfilesReport(
        ctx.hostName,
        a.user as string | undefined,
        a.path as string | undefined,
      );
    },
  },
  {
    name: "first-boot",
    summary: "First boot of a freshly installed host (run by cloud-init)",
    description:
      `Run once by cloud-init after the first-boot script cloned the repository (spec 005): applies the host, hands the deploy key to ops, verifies, and pushes the host's first record.`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { firstBoot } = await import("../install/first-boot.ts");
      return await firstBoot(await requireHost(ctx.hostName));
    },
  },
  {
    name: "tools sync",
    summary: "Install or upgrade the tool catalog and write the report",
    description:
      `Article 5: fish, tmux, and git come from Ubuntu; Deno, gh, chezmoi, and oh-my-posh are upstream binaries, verified against GitHub's published SHA-256 digests, installed side by side under /opt/tools/<tool>/<version>, smoke-tested, and linked into /usr/local/bin with rollback; Claude Code is installed on workstations only and updates itself (specs 010, 030).`,
    tier: "mutate",
    operation: true,
    readOnlyWith: "report-only",
    args: [{
      name: "report-only",
      type: "boolean",
      description: "Check versions; install nothing.",
    }],
    async run(a, ctx) {
      const { syncTools } = await import("../tools/sync.ts");
      const r = await syncTools(await requireHost(ctx.hostName), {
        reportOnly: !!a["report-only"],
      });
      if (r.failed && !a["report-only"]) {
        const { notify } = await import("../notify/events.ts");
        await notify({
          event: "✗ tools sync failed",
          level: "fail",
          what: r.rows.filter((x) => !x.ok).map((x) => `- ${x.id}: ${x.action}`).join("\n"),
          todo: "sudo archon tools sync shows each failure; the weekly timer retries.",
          key: `tools:${new Date().toISOString().slice(0, 10)}`,
        });
      }
      return r.failed ? 1 : 0;
    },
  },
  {
    name: "capture",
    summary: "Report this host's drift from the model (writes nothing)",
    description:
      `Reads manually installed packages, snaps, enabled units, listening ports, accounts, and tool versions, compares them with the plan, and prints the drift. Nothing is recorded or pushed (spec 048): ask the machine directly with archon query.`,
    tier: "read",
    args: [],
    async run(_a, ctx) {
      const { capture } = await import("../state/capture.ts");
      const r = await capture(await requireHost(ctx.hostName));
      if (ctx.json) console.log(JSON.stringify({ snapshot: r.snapshot, drift: r.drift }, null, 2));
      else console.log(r.summary);
      return 0;
    },
  },
  {
    name: "reboot",
    summary: "Reboot this host; --netboot boots it from the network once (for a re-install)",
    description:
      `Waits until nothing changes packages (apt, dpkg, unattended-upgrades: up to 15 minutes; --now does not wait, spec 054), then reboots in 5 seconds, so it can be run over SSH. With --netboot it first sets the firmware's one-time next boot (UEFI BootNext) to the network entry the install recorded (/etc/archon/netboot-entry), or the first PXE/HTTP IPv4 entry, so the boot server can re-install an armed host without anyone at the console; the boot order itself is unchanged. deno task stolos boot reinstall <host> runs this for you (spec 004).`,
    tier: "mutate",
    operation: true,
    args: [{
      name: "netboot",
      type: "boolean",
      description: "Boot from the network once (the boot server re-installs it if armed).",
    }, {
      name: "now",
      type: "boolean",
      description: "Do not wait for apt or dpkg to finish (it can break dpkg's state).",
    }],
    examples: [{
      cmd: "archon reboot --netboot",
      text: "Re-install this host (armed on the boot machine).",
    }],
    async run(a) {
      const { reboot } = await import("../install/netboot.ts");
      return await reboot({ netboot: !!a.netboot, now: !!a.now });
    },
  },
  {
    name: "poweroff",
    summary: "Shut this host down cleanly, after apt and dpkg finish",
    description:
      `Waits until nothing changes packages (apt, dpkg, unattended-upgrades: up to 15 minutes, saying what it waits for), then shuts down cleanly in 5 seconds, so it can be run over SSH. Cutting the power while apt runs can break dpkg's state; this is the way to turn a server off (spec 054). --now does not wait.`,
    tier: "mutate",
    operation: true,
    args: [{
      name: "now",
      type: "boolean",
      description: "Do not wait for apt or dpkg to finish (it can break dpkg's state).",
    }],
    examples: [{ cmd: "archon poweroff", text: "Turn this server off, cleanly." }],
    async run(a) {
      const { reboot } = await import("../install/netboot.ts");
      return await reboot({ netboot: false, now: !!a.now, poweroff: true });
    },
  },
  {
    name: "observe",
    summary: "What this machine records about itself, where, and within which limits",
    // The Collector's files belong to its own service user; members of
    // archon-ops are not asked for a password.
    asOwner: true,
    description:
      `Shows this machine's local observability (spec 021): logs in journald, metrics in PCP's archives, and Archon's own OpenTelemetry (traces, metrics, logs) as the local OpenTelemetry Collector writes it, each with its size, how far back it goes, and its limits. Every local store is ephemeral: bounded by age and size, pruned first when the disk runs low, never backed up. Live views: btop, archon observe tui, journalctl -f.`,
    tier: "read",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { observe } = await import("../observe/observe.ts");
      return await observe(await requireHost(ctx.hostName));
    },
  },
  {
    name: "observe tui",
    summary: "Open otel-tui on this machine's telemetry (PCP's metrics live, Archon's OTLP)",
    description:
      `Runs otel-tui, a terminal viewer for OpenTelemetry, on 127.0.0.1: PCP's core metrics live (through pmproxy's OpenMetrics endpoint) and Archon's recent traces, metrics, and logs from the local Collector's OTLP file. Quit with q. Runs through sudo, which does not prompt members of archon-ops.`,
    tier: "read",
    asOwner: true,
    args: [],
    async run() {
      const { observeTui } = await import("../observe/observe.ts");
      return await observeTui();
    },
  },
  {
    name: "observe discover",
    summary: "Look for a central OpenTelemetry collector and forward to it if one answers",
    description:
      `Looks for a central OpenTelemetry collector (spec 024): the fleet model's telemetry.collector, else the name "otel.localdomain" (telemetry.name), a Local DNS record in the router. Never mDNS or DNS-SD (constitution Article 20). A candidate counts only if it accepts OTLP. When one answers, the local Collector also reads journald and PCP (through pmproxy) and forwards them and Archon's own telemetry as OTLP, with a bounded queue on disk; when none does, everything stays local. The archon-observe-discover timer runs this every 15 minutes. With --check, only reports.`,
    tier: "mutate",
    operation: true,
    readOnlyWith: "check",
    args: [{ name: "check", type: "boolean", description: "Report what would change." }],
    async run(a, ctx) {
      const { discover } = await import("../observe/discover.ts");
      return await discover(await requireHost(ctx.hostName), !!a.check);
    },
  },
  {
    name: "doctor",
    summary: "Can this machine reach what it needs? Network and email, with where to look",
    description:
      `A quick, read-only diagnosis (spec 026), each problem with what it means and where to look:\n\nLink: the default route, carrier, duplex, and interface errors (ip, sysfs). Gateway: loss and latency (ping), and whether full-size packets pass (ping with don't-fragment). DNS: the configured servers (resolvectl), five uncached lookups of archive.ubuntu.com to catch a flaky upstream, each server directly (dig), a public resolver only when they all fail (to tell the router's DNS from the internet's), and this host's Local DNS name. IPv6: a route, and whether apt is limited to IPv4 where there is none (spec 009). Time: synchronized, offset, sources (timedatectl, chronyc), because TLS needs the right time. Proxy and firewall: proxy settings, UFW's outgoing policy.\n\nInternet: every endpoint this machine uses, taken from its own configuration: each apt repository's InRelease (Ubuntu, security, PPAs, GitHub CLI), the checkout's remote (over SSH as ops with the deploy key), GitHub's API and a release download (tools sync), the Claude Code installer (workstations), the Snap Store (snapd's own snap debug connectivity), and the OpenTelemetry collector if the model names one; each with curl's DNS, connect, and TLS times, and a curl failure explained (DNS, refused, timeout, TLS, certificate, reset). With --trace, mtr follows the path to each failing site over TCP.\n\nEmail (specs 025, 027): the sending domain's records in DNS (Cloudflare's cf-bounce SPF, DKIM, and MX, and DMARC), the relay's credential, a login to the relay without sending (curl, EHLO, AUTH, NOOP), and on servers Postfix: running, relaying to the right place, and its queue. archon notify's queue and last send. With --send, it also mails what the Email phase found to the shared mailbox through archon's own sender and through Postfix, so the result arrives where it matters; this happens by itself after deno task stolos boot mail-setup, after an install, and when a server receives a new token.`,
    tier: "read",
    asOwner: true,
    operation: true,
    args: [
      {
        name: "trace",
        type: "boolean",
        description: "Trace the path to failing sites with mtr (slower).",
      },
      {
        name: "send",
        type: "boolean",
        description:
          "Also mail the Email phase's findings to the shared mailbox, through archon and Postfix.",
      },
    ],
    examples: [
      { cmd: "archon doctor", text: "the quick look" },
      { cmd: "archon doctor --trace", text: "and where the path to a failing site stops" },
      { cmd: "archon doctor --send", text: "and mail the email findings to the shared mailbox" },
    ],
    seeAlso: ["archon-verify", "archon-notify-status"],
    async run(a, ctx) {
      const { doctor } = await import("../doctor/doctor.ts");
      return await doctor(await requireHost(ctx.hostName), {
        trace: !!a.trace,
        send: a.send ? "archon doctor --send" : undefined,
      });
    },
  },
  {
    name: "vault status",
    summary: "Boot machine: every secret, when it changed, and whether the last backup has it",
    description:
      `Lists every secret in the boot machine's secrets folder with its inventory name, when it last changed, and when it was last backed up (specs 029 and 056): ✓ backed up, ⚠ newer than the last backup. Exits 1 if anything is newer than the last backup. With --lost, prints how each secret would be made again if the boot machine were lost without a backup. Also writes the prompt's 🔐 backup status, installs the git pre-push reminder hook, and sends the "not backed up" email when due. Run as deno task stolos vault status.`,
    tier: "repo",
    noMcp: true,
    args: [
      { name: "lost", type: "boolean", description: "Print the rebuild plan for each secret." },
      {
        name: "hook",
        type: "boolean",
        description: "The git pre-push hook: the panel only, never a failure.",
      },
    ],
    async run(a) {
      const { vaultStatus } = await import("../vault/commands.ts");
      return await vaultStatus({ lost: !!a.lost, hook: !!a.hook });
    },
  },
  {
    name: "vault backup",
    summary: "Boot machine: one ZIP of every secret and your signing key, to keep somewhere safe",
    description:
      `Writes stolos-backup-<pc>-<UTC>.zip into stolos's backup folder (Windows: %LOCALAPPDATA%\\stolos\\backup; Linux and macOS: stolos's data folder, backup) with every fleet's secrets on this PC (except ephemeral install tokens), your signing key (both halves, from git config user.signingkey; the private half stays locked by its passphrase), a manifest (names, SHA-256, sizes; never a value), and RESTORE.txt (the restore steps). It reads the ZIP back and checks every file before reporting success, makes it readable by you only, and records it. Then move the ZIP wherever you keep important things safe (an encrypted place: it is not encrypted itself). Spec 056.`,
    tier: "repo",
    operation: true,
    noMcp: true,
    args: [],
    async run() {
      const { vaultBackup } = await import("../vault/commands.ts");
      return await vaultBackup();
    },
  },
  {
    name: "vault restore",
    summary:
      "Boot machine: restore a backup ZIP on a freshly cloned PC (secrets, both keys, signing)",
    description:
      `Run in the freshly cloned fleet repository: checks the backup ZIP (its format and every file's SHA-256), chooses the fleet it is for, puts every file back (the secrets readable by you only, the daily key in .ssh, the recovery key in the key store), records it as the last backup, then runs keys setup (Git's signing for this checkout and one test signature: your daily passphrase) and downloads the engine's types for VS Code. It never overwrites: a file already there with the same bytes is kept, and one that differs stops it before anything is written, so it can be run again. --files-only stops after the files. Without a ZIP: prints the steps (the same as RESTORE.txt in every ZIP). Specs 056 and 061.`,
    tier: "repo",
    operation: true,
    noMcp: true,
    args: [
      {
        name: "zip",
        type: "string",
        positional: true,
        human: true,
        description: "The backup ZIP (from deno task stolos vault backup); none: print the steps.",
      },
      {
        name: "files-only",
        type: "boolean",
        description: "Put the files back, then stop (no keys setup, no editor step).",
      },
    ],
    async run(a) {
      if (!a.zip) {
        const { vaultRestore } = await import("../vault/commands.ts");
        return vaultRestore();
      }
      const { vaultRestoreZip } = await import("../vault/restore.ts");
      return await vaultRestoreZip(a.zip as string, { filesOnly: !!a["files-only"] });
    },
  },
  {
    name: "vault list",
    summary: "Boot machine: the backup ZIPs still in the backup folder",
    description:
      `Lists the backup ZIPs still in stolos's backup folder, newest first. Once you move one somewhere safe, it is no longer listed.`,
    tier: "repo",
    noMcp: true,
    args: [],
    async run() {
      const { vaultList } = await import("../vault/commands.ts");
      return await vaultList();
    },
  },
  {
    name: "vault recover-host-keys",
    summary: "Boot machine: pull a running host's SSH host keys and deploy key back over SSH",
    description:
      `For a boot machine lost without a backup: connects to the host as the fleet admin, runs archon host-keys export there, and stores its SSH host keys and ops' deploy key in the secrets folder, then trusts the host keys again (known_hosts). The rebuilt boot machine holds the same identities: nothing changes on GitHub, and the next re-install keeps the host's identity.`,
    tier: "repo",
    operation: true,
    noMcp: true,
    args: [{
      name: "host",
      type: "string",
      positional: true,
      required: true,
      description: "The host.",
    }],
    async run(a) {
      const { recoverHostKeys } = await import("../vault/commands.ts");
      return await recoverHostKeys(String(a.host));
    },
  },
  {
    name: "host-keys export",
    summary: "Print this host's SSH host keys as JSON (for vault recover-host-keys)",
    description:
      `Prints this host's SSH host keys and ops' deploy key (private and public) as JSON on stdout, for deno task stolos vault recover-host-keys <host> on a boot machine that lost its copy (spec 029). Root only; never offered over MCP.`,
    tier: "read",
    asOwner: true,
    noMcp: true,
    args: [],
    async run() {
      const { exportHostKeys } = await import("../install/host-keys.ts");
      return await exportHostKeys();
    },
  },
  {
    name: "notify send",
    summary: "Email the fleet's mailbox from this machine",
    description:
      `Queues one message to the fleet's shared mailbox (mail.to in fleets/<fleet>/fleet.ts), from root+<host>.<mail.tag>@<mail.domain>, and starts sending it through Cloudflare Email Service (specs 025, 027). A short subject becomes "[Archon] <host>: <subject>"; a subject that starts with "[" or "Lab " is sent as given (for example "Lab Network Runbook Change Log: ..." with the reference HTML attached).\n\nAttachments are trimmed or gzipped to keep a message under about 1 MB. Secrets are redacted from the subject, body, and text attachments: tokens, keys, password hashes, and the credential itself. With --key, a message with the same key in the last hour is dropped. Messages wait in /var/spool/archon/notify and are retried with backoff; sending never blocks or fails the command that asked for it.`,
    tier: "mutate",
    unlocked: true,
    args: [
      { name: "subject", type: "string", required: true, description: "The subject." },
      { name: "body", type: "string", description: "The body text." },
      { name: "body-file", type: "string", description: "Read the body from this file." },
      {
        name: "attach",
        type: "string",
        repeatable: true,
        description: "Attach a file (repeatable).",
      },
      { name: "level", type: "string", default: "info", description: "info, warn, or fail." },
      { name: "key", type: "string", description: "Dedupe key: one message per key per hour." },
      {
        name: "wait",
        type: "boolean",
        description: "Send now and report whether the relay accepted it.",
      },
    ],
    examples: [
      {
        cmd: `archon notify send --subject "disk replaced" --body "sdb swapped, resilvered"`,
        text: "a short note",
      },
      {
        cmd:
          `archon notify send --subject "Lab Network Runbook Change Log: VLAN 40" --body-file notes.txt --attach runbook.html`,
        text: "a network change log with the reference HTML",
      },
    ],
    seeAlso: ["archon-notify-test", "archon-notify-status"],
    async run(a) {
      const { notifySend } = await import("../notify/commands.ts");
      const level = String(a.level ?? "info");
      if (!["info", "warn", "fail"].includes(level)) {
        throw new Error("--level is info, warn, or fail");
      }
      return await notifySend({
        subject: String(a.subject),
        body: a.body as string | undefined,
        bodyFile: a["body-file"] as string | undefined,
        attach: a.attach ? String(a.attach).split("\n") : [],
        level: level as "info" | "warn" | "fail",
        key: a.key as string | undefined,
      }, { wait: !!a.wait });
    },
  },
  {
    name: "notify test",
    summary: "Send a test message and wait for the relay to accept it",
    description:
      `Sends "[Archon] <host>: notification test" to the fleet's mailbox right away and reports whether the relay accepted it (spec 025). If this machine has no credential: on the boot machine, deno task stolos boot mail-setup; for a host, deno task stolos boot mail-push <host>.`,
    tier: "mutate",
    unlocked: true,
    args: [],
    async run() {
      const { notifyTest } = await import("../notify/commands.ts");
      return await notifyTest();
    },
  },
  {
    name: "notify status",
    summary: "Mailbox, last send and its result, and messages waiting",
    description:
      `Shows where this machine's notifications go, the relay, whether it holds the relay's credential, the last send and its result, and how many messages wait in the queue (spec 025). With --check (archon verify uses it, as a warning): exits 1 if notifications are not configured, the last send failed, or a message has waited more than 6 hours.`,
    tier: "read",
    args: [{ name: "check", type: "boolean", description: "One line; exit 1 on a problem." }],
    async run(a) {
      const { notifyStatus } = await import("../notify/commands.ts");
      return await notifyStatus({ check: !!a.check });
    },
  },
  {
    name: "notify flush",
    summary: "Send what is waiting in the notify queue",
    description:
      `Sends the queued messages whose retry time has come, oldest first, and stops at the first failure (spec 025). Five or more messages older than an hour are sent as one "N messages were queued" summary. The archon-notify-flush timer runs this every 5 minutes, and every queued message starts it at once.`,
    tier: "mutate",
    unlocked: true,
    args: [],
    async run() {
      const { notifyFlush } = await import("../notify/commands.ts");
      return await notifyFlush();
    },
  },
  {
    name: "notify watch",
    summary: "Follow the journal and email logins and other major server events",
    description:
      `Runs as the archon-notify-watch service (spec 025). It follows the journal, where Ubuntu already records every event below, and emails the fleet's mailbox: SSH logins (user, address and its DNS name, local network or not, method, and the key's fingerprint and name; once per user, address, and method an hour, as a warning when the address is outside the local networks or new for that user); any root login; failed SSH logins, summarized hourly by address and users tried; console logins (keyboard or AMT); su; sudo refusals; account and group changes made outside archon apply; changes to any authorized_keys file; kernel out-of-memory kills, disk and filesystem errors, read-only remounts, and hardware errors; failed system units; each boot, and whether the previous one ended cleanly; and filesystems over 90% full. Nothing is added to sshd, PAM, or auditd.`,
    tier: "mutate",
    unlocked: true,
    noMcp: true,
    args: [],
    async run(_a, ctx) {
      const { watch } = await import("../notify/watch.ts");
      return await watch(ctx.hostName);
    },
  },
  {
    name: "mail credential",
    summary: "Install the mail relay's token from stdin (deno task stolos boot mail-push)",
    description:
      `Reads the mail credential (JSON with a Cloudflare API token that has Email Sending: Edit) on stdin and stores it as Postfix's /etc/postfix/sasl_passwd, readable by root only, then reloads Postfix (spec 027). archon's own messages use the same token. The boot machine sends it with deno task stolos boot mail-push <host>; installs deliver it by themselves.`,
    tier: "mutate",
    unlocked: true,
    noMcp: true,
    args: [],
    async run() {
      const { mailCredential } = await import("../notify/commands.ts");
      return await mailCredential();
    },
  },
  {
    name: "mail test",
    summary: "Send a test through Postfix, the way apps and cron jobs send mail",
    description:
      `Hands one message for root to /usr/sbin/sendmail (spec 027). This host's Postfix sends mail for local accounts to the fleet's mailbox, from root+<host>.<mail.tag>@<mail.domain>, through Cloudflare Email Service. archon notify test checks archon's own path; this checks the one every other program uses.`,
    tier: "mutate",
    unlocked: true,
    args: [],
    async run(_a, ctx) {
      const { mailTest } = await import("../notify/commands.ts");
      return await mailTest(ctx.hostName);
    },
  },

  {
    name: "observe prune",
    summary: "Keep PCP's metric archives within their size and free-space limits",
    description:
      `Removes PCP's oldest metric archives while they are over the size limit or the disk is below its free-space floor (spec 021); the archive being written is never removed. pmlogger_daily already removes archives past their age limit, and journald and the Collector's files limit themselves. The archon-observe-prune timer runs this daily. With --check, only reports.`,
    tier: "mutate",
    operation: true,
    readOnlyWith: "check",
    args: [{ name: "check", type: "boolean", description: "Report what would be removed." }],
    async run(a, ctx) {
      const { prune } = await import("../observe/observe.ts");
      return await prune(await requireHost(ctx.hostName), !!a.check);
    },
  },
  {
    name: "update",
    summary: "Bring this machine up to date with GitHub: pull, apply, verify",
    description:
      `Pulls the repository (as its owner), then with the freshly pulled code validates the model, applies, syncs tools, applies dotfiles again when tools changed, and verifies (spec 015). An invalid model stops before anything is applied (Article 10). With --check, shows incoming commits and the plan.`,
    tier: "mutate",
    place: "machine",
    operation: true,
    readOnlyWith: "check",
    args: [
      {
        name: "check",
        type: "boolean",
        description: "Show incoming commits and the plan; change nothing.",
      },
      { name: "no-tools", type: "boolean", description: "Skip the tools sync." },
      { name: "no-pull", type: "boolean", description: "Use the local checkout as it is." },
    ],
    async run(a, ctx) {
      const { update } = await import("../update/update.ts");
      const steps = await update(await requireHost(ctx.hostName), {
        check: !!a.check,
        tools: !a["no-tools"],
        pull: !a["no-pull"],
      });
      return steps.every((s) => s.ok || s.step === "pull") ? 0 : 1;
    },
  },
  {
    name: "update",
    summary: "Bring this PC's checkout up to date (use it instead of git pull), then the doctor",
    description:
      `Instead of git pull (spec 058): fetches and fast-forwards a clean checkout (never a merge); checks that what arrived is signed by a key the fleet trusted (as servers will); upgrades the pinned engine when a newer Stolos release is out (fleet upgrade: one signed commit you push; --no-upgrade only reports); repairs Git's allowed signers and the pre-push check; then runs boot doctor (on a boot machine) or stolos keys. Every step is safe to run again.`,
    tier: "repo",
    place: "pc",
    operation: true,
    noMcp: true,
    args: [
      {
        name: "no-upgrade",
        type: "boolean",
        description: "Report a newer engine release, without upgrading.",
      },
      { name: "no-doctor", type: "boolean", description: "Skip the doctor at the end." },
    ],
    async run(a) {
      const { operatorUpdate } = await import("../update/operator.ts");
      return await operatorUpdate({ noUpgrade: !!a["no-upgrade"], noDoctor: !!a["no-doctor"] });
    },
  },
  {
    name: "reconcile",
    summary: "Converge to the repository (run by the timer every 15 minutes)",
    description:
      `Fetches the fleet's branch, fast-forwards a clean checkout, and applies only when HEAD equals the remote (Article 9). Skips when another archon run holds the host lock, or when the checkout has local changes.`,
    tier: "mutate",
    args: [],
    async run(_a, ctx) {
      const { reconcile } = await import("../reconcile/reconcile.ts");
      return await reconcile(await requireHost(ctx.hostName));
    },
  },
  {
    name: "export",
    summary: "Write the fleet, specs, provenance, and snapshots as RDF (Turtle)",
    description:
      `Writes out/rdf/fleet.ttl using W3C PROV, Dublin Core terms, FOAF, and the archon: namespace (specs 002 and 014). RDF is an export only; TypeScript validates (Article 10).`,
    tier: "repo",
    args: [],
    async run() {
      const { exportRdf } = await import("../model/export.ts");
      for (const f of await exportRdf()) console.log(f);
      return 0;
    },
  },
  {
    name: "report daily",
    summary: "Write the daily health report",
    description:
      `Failed units, disk, pending upgrades, archon timers, drift, and the latest tools report, written to /var/lib/archon/reports/daily-<date>.md and the journal (tag archon-report). Facts only: no agent runs on a server (spec 030); a workstation agent reads reports as MCP resources.`,
    tier: "read",
    args: [],
    async run(_a, ctx) {
      const { dailyReport } = await import("../report/daily.ts");
      const r = await dailyReport(await requireHost(ctx.hostName));
      console.log(r.path);
      // Spec 025: the daily report is the daily message.
      const { notify } = await import("../notify/events.ts");
      const text = await Deno.readTextFile(r.path).catch(() => "");
      await notify({
        event: `daily report${r.failedUnits ? ` · ${r.failedUnits} failed unit(s)` : ""}`,
        level: r.failedUnits ? "warn" : "info",
        what: text.length > 6000
          ? text.slice(0, 6000) + "\n[...the full report is attached]"
          : text,
        attach: [r.path],
        key: `daily:${new Date().toISOString().slice(0, 10)}`,
      });
      return 0;
    },
  },
  {
    name: "mcp",
    summary: "Serve the commands to an agent as MCP tools (stdio)",
    description:
      `Starts a Model Context Protocol server on stdin/stdout. Each command within --max-tier becomes a tool named archon_<command>; man pages, specs, the constitution, and reports are resources. A command above the tier is not listed and is refused; one with a read-only flag (apply --check) is listed and runs only with that flag. The destructive tier is never served. Each call is journaled (tag archon-mcp, with SSH_CLIENT).

On a server, workstations reach it as ops over SSH (spec 030): ops' authorized_keys forces this command with the fleet's tier (fleet.mcp.maxTier, default mutate) and restrict, so an agent can do nothing else there. On a workstation, stolos build renders .mcp.json with one entry per server (archon-<fleet>-<host>: ssh ops@<host>).`,
    tier: "read",
    noMcp: true,
    args: [{
      name: "max-tier",
      type: "string",
      description: "The highest tier served: read, repo, or mutate (default mutate).",
    }],
    async run(a) {
      const { serveMcp } = await import("../mcp/server.ts");
      await serveMcp(a["max-tier"] as string | undefined);
      return 0;
    },
  },
  {
    name: "backup run",
    summary: "Write a backup archive now (the timer runs it daily)",
    description:
      `Archives the host's own state and its durable data (S3 buckets and SMB shares recorded as durable, Article 23) with tar and zstd into the backup target (default /var/backups/archon), exports each durable LXD guest (lxc export), and keeps the newest N of each (specs 016, 044).`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { backupRun } = await import("../backup/backup.ts");
      const { ui } = await import("../core/ui.ts");
      const p = ui.phase("Backup");
      const { backupOutcome } = await import("../notify/events.ts");
      try {
        const r = await backupRun(await requireHost(ctx.hostName));
        const failed = r.guests.filter((g) => g.error);
        for (const g of r.guests) {
          if (g.error) p.warn(`lxc export ${g.guest} failed: ${g.error}`, `lxc info ${g.guest}`);
          else p.note(`durable guest ${g.guest}: ${g.file}`);
        }
        p.done(`${r.archive} · keeping ${r.kept}`);
        await backupOutcome(
          ctx.hostName,
          !failed.length,
          `Newest archive: ${r.archive} (keeping ${r.kept}).${
            failed.length
              ? ` Durable guests not exported: ${failed.map((g) => g.guest).join(", ")}.`
              : ""
          }`,
          ui.logPath,
        );
        return failed.length ? 1 : 0;
      } catch (e) {
        await backupOutcome(ctx.hostName, false, (e as Error).message, ui.logPath);
        throw e;
      }
    },
  },
  {
    name: "backup verify",
    summary: "Restore-test the newest archive",
    description:
      `Lists the newest archive and extracts the host marker into a temporary directory to prove it restores (Article 14).`,
    tier: "read",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { backupVerify } = await import("../backup/backup.ts");
      const { ui } = await import("../core/ui.ts");
      const p = ui.phase("Restore test");
      const r = await backupVerify(await requireHost(ctx.hostName));
      if (r.ok) p.done(`${r.archive} restores`);
      else p.fail(r.reason || "restore test failed", "archon backup run");
      return r.ok ? 0 : 1;
    },
  },
  {
    name: "backup restore",
    summary: "Extract an archive into a directory to inspect (never in place)",
    description:
      `Extracts the newest (or a named) archive into --to/<archive>/ so you can copy back what you need. It never overwrites the live system.`,
    tier: "mutate",
    args: [
      { name: "archive", type: "string", description: "Archive file name (default: newest)." },
      {
        name: "to",
        type: "string",
        description: "Directory to extract into (default /var/tmp/archon-restore).",
      },
    ],
    async run(a, ctx) {
      const { backupRestore } = await import("../backup/backup.ts");
      const r = await backupRestore(
        await requireHost(ctx.hostName),
        a.archive as string | undefined,
        (a.to as string | undefined) ?? "/var/tmp/archon-restore",
      );
      console.log(`${r.archive} extracted to ${r.dir}`);
      return 0;
    },
  },
  {
    name: "guest sync",
    summary: "Create and start the LXD guests the model declares",
    description:
      `Creates missing LXD instances (containers or VMs) from the host model and starts stopped ones (spec 017). Never deletes: instances not in the model are listed and kept.`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a, ctx) {
      const { guestSync, instances } = await import("../guests/guests.ts");
      const { notify } = await import("../notify/events.ts");
      const names = async () => new Set((await instances().catch(() => [])).map((i) => i.name));
      const before = await names();
      const ok = await guestSync(await requireHost(ctx.hostName));
      const after = await names();
      const created = [...after].filter((n) => !before.has(n));
      const deleted = [...before].filter((n) => !after.has(n));
      // Spec 025: guests created or deleted, and failures.
      if (created.length || deleted.length || !ok) {
        await notify({
          event: ok
            ? `guests: ${
              [...created.map((n) => `+${n}`), ...deleted.map((n) => `-${n}`)].join(" ")
            }`
            : "✗ guest sync failed",
          level: ok ? "info" : "fail",
          what: [
            created.length ? `Created: ${created.join(", ")}` : "",
            deleted.length ? `Deleted: ${deleted.join(", ")}` : "",
            ok ? "" : "archon guest sync failed; see the log.",
          ].filter(Boolean).join("\n"),
          todo: ok ? undefined : "archon guest sync shows each failure with its fix.",
        });
      }
      return ok ? 0 : 1;
    },
  },
];

/**
 * Finds the command named by the leading words of argv (the longest matching
 * name wins) and returns it with the remaining arguments, or undefined.
 */
/** Commands run with `stolos` on your PC (the rest run with `archon` on each machine). */
const PC_COMMANDS = new Set([
  "validate",
  "build",
  "fleet use",
  "fleet init",
  "fleet status",
  "host add",
  "where",
  "fleet upgrade",
  "fleet trust",
  "fleet query",
  "signers",
  "signers add",
  "signers remove",
  "keys",
  "keys setup",
  "keys check-recovery",
  "keys rotate",
  "keys lost",
  "keys check-push",
  "host bootstrap",
  "workstation add",
  "decide",
  "vault status",
  "vault backup",
  "vault restore",
  "vault list",
  "vault recover-host-keys",
  "export",
]);

for (const c of COMMANDS) {
  c.place ??= c.name === "explain" ? "both" : PC_COMMANDS.has(c.name) ? "pc" : "machine";
}

/** Whether a command is offered where `place` runs ("pc": stolos, "machine": archon). */
export function offeredOn(c: Command, place: "pc" | "machine"): boolean {
  return c.place === "both" || c.place === place;
}

/** Find the command named by the start of argv, among those offered at `place`; returns it and the rest of argv. */
export function findCommand(
  argv: string[],
  place: "pc" | "machine" = "machine",
): { cmd: Command; rest: string[] } | undefined {
  // The longest name first: "fs smb status" before "fs smb", before "fs".
  const longest = Math.max(...COMMANDS.map((c) => c.name.split(" ").length));
  for (let n = longest; n >= 1; n--) {
    const name = argv.slice(0, n).join(" ");
    const cmd = COMMANDS.find((c) =>
      (c.name === name || c.aliases?.includes(name)) && offeredOn(c, place)
    );
    if (cmd) return { cmd, rest: argv.slice(n) };
  }
  return undefined;
}

export type { Parsed };
