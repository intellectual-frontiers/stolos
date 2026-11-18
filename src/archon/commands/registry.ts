/**
 * The command registry (Article 6). One definition per capability; the CLI,
 * MCP tools, man pages, completions, and the agent's permissions come from here.
 * Implementations load lazily.
 *
 * @module
 */
// Spec: 098-pair FR-001, FR-010
// Spec: 099-engine-update FR-001
// Spec: 100-remote-access FR-003, FR-005, FR-008
// Spec: 117-adopted-in-status FR-001
// Spec: 103-three-ports FR-008, FR-009
// Spec: 105-calm-output FR-001, FR-010
// Spec: 109-integrations-api FR-018
// Spec: 110-network-assets FR-003, FR-005, FR-009
// Spec: 108-tags FR-006, FR-007, FR-008, FR-013, FR-016
// Spec: 112-machine-reported-tags FR-007, FR-011, FR-012
// Spec: 115-compatibility FR-005, FR-016

import { fs, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { CHOICE_ARGS, chooseData, CONFIRM_DESTROY_ARG } from "../model/durable.ts";
import type { Command, Parsed, RunContext } from "../core/registry-types.ts";
import type { HostDef } from "../model/types.ts";

async function requireHost(name: string): Promise<HostDef> {
  const { loadHosts } = await import("../model/load.ts");
  const h = (await loadHosts()).find((x) => x.name === name);
  if (!h) {
    throw new Error(`no host model named '${name}': add it with stolos host add, or pass --host`);
  }
  return h;
}

/** Spec 108-tags FR-013: choosing machines by tag, the same three options wherever machines are chosen. */
const TAG_SELECT_ARGS: Command["args"] = [
  {
    name: "tag",
    type: "string",
    repeatable: true,
    description:
      "Only machines with this tag; repeat it for more (all of them must hold): --tag env:prod --tag role:nas. dimension:* is any value of a dimension.",
  },
  {
    name: "any-tag",
    type: "string",
    repeatable: true,
    description:
      "Only machines with at least one of these tags: --any-tag role:nas --any-tag role:web.",
  },
  {
    name: "select",
    type: "string",
    description:
      "Only machines the expression chooses: and, or, not, parentheses, tags (--select 'env:prod and not role:database').",
  },
];

/** Spec 112-machine-reported-tags FR-011: the hints machines reported are never used to choose machines unless this says so. */
const REPORTED_ARG: Command["args"][number] = {
  name: "reported",
  type: "boolean",
  description:
    "Also choose by the hints machines reported about themselves (shown, never used otherwise); the fleet's own tags and the accepted claims are always used.",
};

/** Every archon command, in help order: the single source for the CLI, MCP tools, man pages, and completions. */
export const COMMANDS: Command[] = [
  {
    name: "validate",
    output: "report",
    summary: "Validate the fleet and every host (TypeScript); change nothing",
    description: `Loads fleets/<fleet>/fleet.ts and fleets/<fleet>/hosts/*/host.ts, resolves each host's plan, and runs every validation rule (spec 002). Each problem is reported with where, what, and a fix. Exits non-zero when anything is wrong.`,
    tier: "read",
    operation: true,
    args: [],
    async run(): Promise<number> {
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
    output: "action",
    summary: "Validate, then render every host's files into out/",
    description: `Validates the model (an invalid model renders nothing, Article 10), then renders each host's files under out/hosts/<host>/rootfs/. Deterministic: building twice changes no file.`,
    tier: "repo",
    operation: true,
    args: [],
    async run(): Promise<number> {
      const { build } = await import("../build.ts");
      return (await build()) ? 0 : 1;
    },
  },
  {
    name: "apply",
    output: "action",
    aliases: ["push"],
    summary: "Your changes to the fleet, to every machine: check, build, one signed commit, push",
    description: `One command instead of build, git add, git commit, and git push (spec 060; stolos push is the same command). In order, stopping at the first problem with its fix: checks (a fleet is chosen, this is its branch, your keys can sign); catches up with GitHub (fast-forward only; your uncommitted edits are kept); builds (validate and render: an invalid model commits nothing); shows what changes, by fleet and host; shows its compliance impact (spec 074: the SCF controls the change weakens or strengthens, with their framework requirements; with compliance.gate { block: "weakens" } in fleet.ts, a weakening without an accepted risk or an approval commits nothing, and --approve <keys> approves it in the signed commit); makes one signed commit (your passphrase, once; -m gives the message, else it is written from what changed); verifies that servers will trust it; and pushes. Every machine applies it within 15 minutes. With nothing new, it says so and does nothing. --check stops before the commit.`,
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
      {
        name: "approve",
        type: "string",
        description:
          'Approve weakenings the compliance gate blocks, in the signed commit (trailer Compliance-Approved): keys such as "updates/beta", "NET-02", or "all".',
      },
    ],
    examples: [
      {
        cmd: 'bun run stolos apply -m "fcr: olympia\'s packages"',
        text: "Build, sign, and push.",
      },
      { cmd: "bun run stolos push", text: "The same (push is another name for apply)." },
      {
        cmd: 'bun run stolos apply -m "lab: beta off unattended upgrades" --approve updates/beta',
        text: "Approve the one weakening the gate blocks, as a fleet signer.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { fleetApply } = await import("../fleet/apply.ts");
      return await fleetApply({
        ...(typeof a["message"] === "string" ? { message: a["message"] } : {}),
        check: !!a["check"],
        ...(a["approve"] ? { approve: a["approve"] as string } : {}),
      });
    },
  },
  {
    name: "fleet use",
    output: "action",
    summary: "Choose which fleet of this repository archon works on (remembered here)",
    description: `For a repository with more than one fleet (fleets/<id>/): every archon command in this checkout is then for that fleet, at once, in every terminal, until you choose another. The choice is kept in .git/stolos/fleet, so it is never committed and each checkout makes its own. --fleet <id> (or ARCHON_FLEET) still chooses another for one command. fleet init chooses the fleet it creates.`,
    tier: "read",
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The fleet: a folder of fleets/.",
      },
    ],
    examples: [{ cmd: "bun run stolos fleet use fcr", text: "Work on fleets/fcr from now on." }],
    async run(a: Parsed): Promise<number> {
      const { fleetUse } = await import("../fleet/use.ts");
      return await fleetUse(a["id"] as string);
    },
  },
  // Spec 082: a provider's clients, each its own repository, vault, and signers.
  {
    name: "clients add",
    output: "action",
    summary: "Register a client's checkout on this provider's PC (spec 082)",
    description: `Spec 082. For managed service providers and virtual CISOs: adds a client to this PC's registry of clients (clients.json in your Stolos config folder, never in any repository): its id, its title, the path of its checkout (a clone of the client's own fleet repository), and the fleet in it. One checkout belongs to one client. Then any command runs for that client with --client <id>: its repository, its state, its secrets, and its key store on this PC, apart from every other client's.`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "path",
        type: "string",
        positional: true,
        required: true,
        description: "The client's checkout (the folder holding fleets/).",
      },
      {
        name: "fleet",
        type: "string",
        description: "The fleet in it (default: its only fleet).",
      },
      { name: "id", type: "string", description: "The client's id (default: the fleet's id)." },
      { name: "title", type: "string", description: "Its name (default: the fleet's title)." },
    ],
    examples: [
      {
        cmd: "bun run stolos clients add ../north-fleet --id north",
        text: "Register the client north, whose fleet repository is checked out beside this one.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { clientsAdd } = await import("../clients/commands.ts");
      return await clientsAdd({
        path: a["path"] as string,
        ...(a["fleet"] ? { fleet: a["fleet"] as string } : {}),
        ...(a["id"] ? { id: a["id"] as string } : {}),
        ...(a["title"] ? { title: a["title"] as string } : {}),
      });
    },
  },
  {
    name: "clients list",
    output: "report",
    summary: "The clients registered on this PC, and which one is chosen (spec 082)",
    description: `Spec 082. Each client's id, title, fleet, and checkout; the chosen one (clients use) is marked with *. With --json, the registry as JSON.`,
    tier: "read",
    noMcp: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { clientsList } = await import("../clients/commands.ts");
      return await clientsList(ctx.json);
    },
  },
  {
    name: "clients remove",
    output: "action",
    summary: "Forget a client on this PC (nothing is deleted) (spec 082)",
    description: `Spec 082. Removes the client from this PC's registry. Its checkout, its state and secrets on this PC, and its repository stay as they are.`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The client's id.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { clientsRemove } = await import("../clients/commands.ts");
      return await clientsRemove(a["id"] as string);
    },
  },
  {
    name: "clients use",
    output: "action",
    summary: "Choose the client every stolos command is for (spec 082)",
    description: `Spec 082. Every stolos command on this PC is then for that client (its checkout, state, and secrets), in every terminal, until you choose another; --client <id> still chooses another for one command. Without an id, says which is chosen; --clear goes back to the fleet repository you are in.`,
    tier: "read",
    noMcp: true,
    args: [
      { name: "id", type: "string", positional: true, description: "The client's id." },
      { name: "clear", type: "boolean", description: "Choose no client." },
    ],
    async run(a: Parsed): Promise<number> {
      const { clientsUse } = await import("../clients/commands.ts");
      return await clientsUse(a["id"] as string | undefined, !!a["clear"]);
    },
  },
  {
    name: "clients summary",
    output: "report",
    summary: "Every client's compliance in numbers, each read on its own (spec 082)",
    description: `Spec 082. For each client, read in its own scope: controls passing, failing, partial, without evidence, and with stale evidence; controls changed since --since (default a day) and how many got worse; the last observation; open POA&M items; and the newest evidence bundle's date. Numbers and dates only: nothing of what any client holds. With --json, as JSON.`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "since",
        type: "string",
        description: "The drift's starting point: a commit or a date (default: 1 day ago).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { clientsSummary } = await import("../clients/commands.ts");
      return await clientsSummary({
        json: ctx.json,
        ...(a["since"] ? { since: a["since"] as string } : {}),
      });
    },
  },
  {
    name: "clients report",
    output: "report",
    summary: "One compliance report per client, each in its own folder, and the summary (spec 082)",
    description: `Spec 082. Writes <out>/<client>/report.md, summary.json, and compliance.json for each client (each read in its own scope, so each folder holds that client's data only), then <out>/summary.md and summary.json (numbers only). A folder inside any client's checkout is refused. Each client's signed evidence bundle is still stolos --client <id> evidence export.`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "out",
        type: "string",
        required: true,
        description: "The provider's folder for the reports.",
      },
      {
        name: "since",
        type: "string",
        description: "The drift's starting point (default: 1 day ago).",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos clients report --out ~/reports/2026-11",
        text: "This month's reports, one folder per client.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { clientsReport } = await import("../clients/commands.ts");
      return await clientsReport({
        out: a["out"] as string,
        ...(a["since"] ? { since: a["since"] as string } : {}),
      });
    },
  },
  {
    name: "clients console",
    output: "report",
    summary: "Every client in one Stolos Console: switch between them, see the summary (spec 082)",
    description: `Spec 082. The Stolos Console for a provider, on 127.0.0.1 with a one-time launch link: /clients is the summary across clients (numbers only); opening a client starts a session for that client alone (its own pages, REST API, and commands, run in its checkout). Switching to another client ends that session and starts a new one. Ctrl+C stops it.`,
    tier: "read",
    noMcp: true,
    args: [
      { name: "port", type: "string", description: "The port on 127.0.0.1 (default 8092)." },
      { name: "no-open", type: "boolean", description: "Print the link; do not open a browser." },
    ],
    async run(a: Parsed): Promise<number> {
      const port = a["port"] ? Number(a["port"]) : undefined;
      if (port !== undefined && !(Number.isInteger(port) && port > 1023 && port < 65536)) {
        throw new Error(`--port ${a["port"]}: a port from 1024 to 65535`);
      }
      const { clientsConsole } = await import("../clients/commands.ts");
      return await clientsConsole({ ...(port ? { port } : {}), open: !a["no-open"] });
    },
  },
  {
    name: "fleet init",
    output: "action",
    summary: "Create the fleet from your GitHub identity (boot machine, once)",
    description: `With an id, the fleet is fleets/<id>/ of this repository (ARCHON_REPO, else the nearest folder holding fleets/, else the working directory); in a new, empty repository it also writes package.json pinned to this engine's release, archon.ts, stolos.ts, .gitignore, and bun.lock (specs 046 and 096). Reads your GitHub account with gh (login, ID, name, the noreply commit address) and your public SSH keys from github.com/<login>.keys, asks for your Unix account name and an admin password, and writes fleets/<fleet>/fleet.ts (spec 003). If fleets/<fleet>/fleet.ts already exists (a rebuilt boot machine), it is kept, with its admin account, and only the password hash and this checkout's git identity are set again; --rewrite starts the file over. Only the password's SHA-512 crypt hash is kept, in this machine's secret store, never in the repository (Article 13). Runs on Windows or Linux.`,
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
    examples: [
      {
        cmd: "bun run stolos fleet init lab",
        text: "Start the fleet fleets/lab/ (and, in an empty repository, the repository's files).",
      },
      {
        cmd: "bun run stolos fleet init",
        text: "On a rebuilt boot machine: store the admin password hash again; the fleet is kept.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { fleetInit } = await import("../identity/fleet-init.ts");
      await fleetInit({
        id: a["id"] as string | undefined,
        user: a["user"] as string | undefined,
        timezone: a["timezone"] as string | undefined,
        locale: a["locale"] as string | undefined,
        keyboard: a["keyboard"] as string | undefined,
        passwordStdin: !!a["password-stdin"],
        rewrite: !!a["rewrite"],
      });
      return 0;
    },
  },
  {
    name: "fleet status",
    output: "report",
    summary:
      "Every machine of the fleet: servers, workstations, adopted machines, devices, network assets",
    description: `Lists every host in the model with its last install as it recorded it (the host's own archon.sql (opt-in installed): when, checks, problems) and whether it is armed, then how to reach and observe each: ssh, Cockpit's address (servers; the router decides who reaches it), archon observe, btop, archon observe tui, archon verify. On the boot machine it also shows the address each host last installed from. Then every other machine the fleet knows, one line each (spec 117): the adopted machines (paired, integrated), the SNMP devices and the network assets, with how it joined, its operating system, when it was last observed, its policy result, its tags, and what is wrong or not observed yet. Read-only.`,
    tier: "read",
    operation: true,
    args: [],
    examples: [{ cmd: "bun run stolos fleet status", text: "On the boot machine." }],
    async run(): Promise<number> {
      const { fleetStatus } = await import("../observe/fleet-status.ts");
      return await fleetStatus();
    },
  },
  {
    name: "host add",
    output: "action",
    summary: "Add a host: its model, its GitHub deploy key, and one armed install",
    description: `Writes fleets/<fleet>/hosts/<name>/host.ts and registration.ts, creates the host's ed25519 deploy key with ssh-keygen and registers it on the repository read-only (hosts never push, spec 048) through your gh login (the private half stays in this machine's secret store), arms the host for one install by archon-boot, builds, commits, and pushes the new model (the install clones main; --no-push leaves it). Say how its machine is recognized when it network-boots, with exactly one of --claim (the next unknown machine to network-boot in 30 minutes becomes the host; its MAC is learned from it) or --mac-address <mac> (only that network card). The installer erases no disk that is not blank unless --confirm-destroy <name> is given, typed by a person (spec 051).`,
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
    examples: [
      {
        cmd: "bun run stolos host add alpha --claim",
        text: "Add alpha; the next unknown machine to network-boot in 30 minutes becomes alpha.",
      },
      {
        cmd: "bun run stolos host add alpha --mac-address 52:54:00:12:34:56",
        text: "Add alpha as the machine with that network card.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { hostAdd } = await import("../install/host-add.ts");
      return await hostAdd({
        name: a["name"] as string,
        claim: !!a["claim"],
        ...(typeof a["mac-address"] === "string" ? { macAddress: a["mac-address"] } : {}),
        ...(typeof a["confirm-destroy"] === "string"
          ? { confirmDestroy: a["confirm-destroy"] }
          : {}),
        ...(typeof a["disk"] === "string"
          ? { disk: a["disk"] as "largest" | `/dev/${string}` }
          : {}),
        ...(typeof a["layout"] === "string" ? { layout: a["layout"] as "lvm" | "direct" } : {}),
        noDeployKey: !!a["no-deploy-key"],
        force: !!a["force"],
        push: !a["no-push"],
      });
    },
  },
  {
    name: "where",
    output: "report",
    summary:
      "Where you are, and the one thing to do next (also: bun run stolos, with no arguments)",
    description: `In a fleet repository (the boot machine, a workstation's checkout): every step from a new repository to running hosts (the fleet, the engine pin and lock, signers and this machine's signing, the admin password, mail and Cloudflare tokens, each server, and whether everything is committed and pushed), each marked done, next, to do, or not set up yet, as the real state says, with the one command to run next. Nothing about progress is stored: it is computed each time. On a host: archon state (spec 053).`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { whereCommand } = await import("../guide/where.ts");
      return await whereCommand(ctx.json);
    },
  },
  {
    name: "explain",
    output: "report",
    summary: "What a problem's code means, its likely cause, and its fix",
    description: `Every problem archon can explain has a stable code (E for a problem, P for something not set up yet), shown as "explain: archon explain <code>" under it. Without a code, lists them all. Runs anywhere, offline (spec 052).`,
    tier: "read",
    args: [
      {
        name: "code",
        type: "string",
        positional: true,
        description: "The code, for example E051-DISK-NOT-BLANK (none: list them).",
      },
    ],
    examples: [{ cmd: "archon explain E051-DISK-NOT-BLANK", text: "Why an install stopped." }],
    async run(a: Parsed): Promise<number> {
      const { explainText, EXPLAIN } = await import("../core/explain.ts");
      const code = a["code"] as string | undefined;
      stdio.stdout.writeSync(`${explainText(code)}\n`);
      return !code || EXPLAIN[code.toUpperCase()] ? 0 : 1;
    },
  },
  {
    name: "log",
    output: "report",
    summary: "The last run's log, or where it is",
    description: `Prints the log of the last run of this command (every step, including the raw system messages a calm run keeps off the screen), or with --path where it is. --last N prints only its last N lines. Runs offline (spec 105-calm-output).`,
    tier: "read",
    place: "pc",
    args: [
      { name: "last", type: "string", description: "Only the last N lines." },
      { name: "path", type: "boolean", description: "Print only where the log is." },
    ],
    examples: [
      { cmd: "bun run stolos log --path", text: "Where the last run's log is." },
      { cmd: "bun run stolos log --last 40", text: "The end of the last run's log." },
    ],
    async run(a: Parsed): Promise<number> {
      const { lastLogPath } = await import("../core/ui.ts");
      const file = lastLogPath();
      if (file === undefined) {
        stdio.stdout.writeSync("no run log yet\n");
        return 1;
      }
      if (a["path"]) {
        stdio.stdout.writeSync(`${file}\n`);
        return 0;
      }
      const lines = (await fs.readTextFile(file)).replace(/\n$/, "").split("\n");
      const n = Number(a["last"]);
      stdio.stdout.writeSync(
        `${(Number.isInteger(n) && n > 0 ? lines.slice(-n) : lines).join("\n")}\n`,
      );
      return 0;
    },
  },
  {
    name: "state",
    output: "report",
    summary: "What this machine recorded about itself: install, latest verify, switches, data",
    description: `Reads this machine's own archon.sql (spec 048): its install record, its latest verify, the operators' switches (pg, s3, smb), and whether it holds durable data. Spec 115: also the engine it runs and the version of each seam of the contract between a PC and its machines (model, signed-records, query, mcp), which the PC compares with its own. Fleet status on the boot machine asks each server for this over MCP; nothing is pushed to Git.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { stateCommand } = await import("../state/state-command.ts");
      // Spec 115-compatibility FR-005: the engine and the seams this machine has, for the PC's check.
      const { ownReport } = await import("../core/compat.ts");
      return await stateCommand(ctx.hostName, ctx.json, { compat: ownReport() });
    },
  },
  {
    name: "compat",
    place: "pc",
    output: "report",
    summary:
      "Whether this PC and each machine understand each other: the seams, their versions, and every machine's status",
    description: `Spec 115. Archon and Stolos are one engine with one version; what is versioned on its own is the contract between a PC and its machines, in five seams (the fleet model, the signed records, the probe's facts, the machine query views, the MCP tools), each with a version and the oldest version the other side may have. This lists this PC's seams and every machine against them, from what each last reported (stolos fleet status and host observe keep it; nothing is asked here): compatible (the engine may differ), too old for this PC (run archon update on it), newer than this PC (run bun run stolos update), or unknown (not reported yet). A host held at an engine tag (enginePin in its host.ts, engineHolds in fleet.ts) is shown with the tag it is held at, and the tag is checked against the engine's repository (git ls-remote, with a time limit). Exits 1 where a machine is too old or newer, or a hold names a tag that does not exist. --json for scripts.`,
    tier: "read",
    args: [],
    examples: [
      {
        cmd: "bun run stolos compat",
        text: "The seams and every machine's status, with the fix for each.",
      },
      { cmd: "bun run stolos compat --json", text: "The same, for a script." },
    ],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { compatCommand } = await import("../observe/compat-command.ts");
      return await compatCommand({ json: ctx.json });
    },
  },
  {
    name: "query",
    output: "report",
    summary: "Ask this machine one SQL question through osquery (read-only, allowlisted tables)",
    description: `Runs one SELECT through osqueryi, with Archon's own tables (archon_install, archon_verify, archon_prov, archon_optin, from archon.sql) next to osquery's. This server limits it: one statement, only tables on the allowlist (never shadow, process_envs, curl, file, yara, ...), at most 1000 rows, 20 seconds (spec 048, Article 17).`,
    tier: "read",
    args: [
      { name: "sql", type: "string", positional: true, required: true, description: "One SELECT." },
    ],
    examples: [
      {
        cmd: 'archon query "select name, port, protocol from listening_ports join processes using (pid)"',
        text: "What listens, by process.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { query, table } = await import("../state/query.ts");
      const rows = await query(a["sql"] as string);
      stdio.stdout.writeSync(`${ctx.json ? JSON.stringify(rows, null, 2) : table(rows)}\n`);
      return 0;
    },
  },
  {
    name: "fleet upgrade",
    output: "action",
    summary: "Move this repository to another released engine version, locked and signed",
    description: `Run in the fleet repository, on the boot machine or a workstation. Checks that the tag is a release (the engine's own version.ts at that tag says the same version), refuses an older version unless --downgrade, rewrites the engine's release URL in package.json, runs bun install so bun.lock holds the new release's integrity (hosts install with --frozen-lockfile, so the lock is what makes your signature cover the engine's code), validates every fleet with the new engine, and makes one signed commit of package.json and bun.lock. Send it with stolos apply to approve it (stolos update does all of this, and the apply, by itself: spec 099). If anything fails, nothing is committed (spec 046; the fleet-repository guide (bun run stolos docs fleet-repository)).`,
    tier: "repo",
    noMcp: true,
    operation: true,
    args: [
      {
        name: "tag",
        type: "string",
        positional: true,
        required: true,
        description: "The version tag, for example stolos-v0.8.0.",
      },
      { name: "downgrade", type: "boolean", description: "Allow an older (or the same) version." },
      {
        name: "no-commit",
        type: "boolean",
        description: "Change the files only; you review and commit.",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos fleet upgrade stolos-v0.8.0",
        text: "Adopt the engine stolos-v0.8.0, then bun run stolos apply to approve it.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { fleetUpgrade } = await import("../fleet/upgrade.ts");
      return await fleetUpgrade({
        tag: a["tag"] as string,
        downgrade: !!a["downgrade"],
        noCommit: !!a["no-commit"],
      });
    },
  },
  {
    name: "fleet trust",
    output: "action",
    summary: "Trust every host's SSH keys from Git (registration.ts) in your known_hosts",
    description: `On a workstation or the boot machine: writes each registered host's SSH host public keys (fleets/<fleet>/hosts/<host>/registration.ts, written by stolos host add) into your known_hosts, for every name it has (host, DNS name, address, web name), replacing older lines. Plain ssh and MCP clients then check each server against Git, never trusting a first connection blindly. stolos fleet status and fleet query do the same on their own, with known_hosts.auto (spec 047).`,
    tier: "repo",
    noMcp: true,
    operation: true,
    args: [],
    async run(): Promise<number> {
      const { fleetTrust } = await import("../fleet/registration.ts");
      return await fleetTrust();
    },
  },
  {
    name: "signers",
    output: "report",
    summary: "Who may approve this fleet's changes, and your own signing setup",
    description: `Lists the fleet's signers (fleets/<fleet>/signers.ts): each one's role (daily, which approves changes; recovery, kept offline to replace a lost or stolen daily key), key, and when it was added. Then checks your own signing setup: Git signs commits with SSH, the key is protected by a passphrase, and it is not loaded in an ssh-agent (so every signature asks you, and an agent cannot approve on its own). A host applies only a tip of main signed by one of these keys (spec 047, Article 9).`,
    tier: "read",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { signersList } = await import("../identity/signers-commands.ts");
      return await signersList(ctx.json);
    },
  },
  {
    name: "signers add",
    output: "action",
    summary: "Add a signer (or replace one by name) in the fleet's signers.ts",
    description: `Writes fleets/<fleet>/signers.ts in its fixed form. --key is the public key or its .pub file. Hosts accept the new list only from a commit signed by a key already on it: commit with git commit -S and push (spec 047).`,
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
    async run(a: Parsed): Promise<number> {
      const { signersAdd } = await import("../identity/signers-commands.ts");
      return await signersAdd(a["name"] as string, a["role"] as string, a["key"] as string);
    },
  },
  {
    name: "signers remove",
    output: "action",
    summary: "Remove a signer from the fleet's signers.ts",
    description: `Removes the signer by name. Commit signed by another listed key and push; hosts stop accepting the removed key once they apply that commit (spec 047).`,
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
    async run(a: Parsed): Promise<number> {
      const { signersRemove } = await import("../identity/signers-commands.ts");
      return await signersRemove(a["name"] as string);
    },
  },
  {
    name: "signers trust",
    output: "action",
    summary: "Emergency: trust a signing key on this host, typed by a person here",
    description: `For when every signing key is lost: a person logged in to the host (never an agent, never over MCP) trusts a new public key in /etc/archon/allowed_signers.local, and the mailbox is told. Then add it to the fleet's signers.ts, commit signed by it, push, and remove the local file (spec 047).`,
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
    async run(a: Parsed): Promise<number> {
      const { signersTrust } = await import("../identity/signers-commands.ts");
      return await signersTrust(a["key"] as string, a["name"] as string);
    },
  },
  {
    name: "keys",
    output: "report",
    summary: "Your signing keys: every check, and the one command that fixes each",
    description: `Checks this PC's signing setup for the fleet (spec 057): OpenSSH can sign (8.2 or newer); your daily key exists, is locked by a passphrase, and is not in an ssh-agent; Git signs every commit in this repository with it; signers.ts lists it; a recovery key is listed, its private file is not on this PC, and it was checked in the last six months; and every push is checked first. Each problem shows its code (archon explain E057-...) and its fix, usually bun run stolos keys setup. Changes nothing; never asks for a passphrase. Exits 1 when signing does not work.`,
    tier: "read",
    noMcp: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { keysStatus } = await import("../identity/keys-commands.ts");
      return await keysStatus(ctx.json);
    },
  },
  {
    name: "keys setup",
    output: "action",
    summary: "Set up (or repair) signing on this PC: keys, Git, signers.ts, the push check",
    description: `Does only what is missing, so it is safe to run again at any time (spec 057): checks OpenSSH; makes your daily key (~/.ssh/fleet-signing; ssh-keygen asks for its passphrase, which is never stored); sets Git, for this repository only, to sign every commit with it; lists it in signers.ts; makes a recovery key in this PC's key store (beside the secrets, so every backup holds it) and lists it; installs the pre-push check; and makes one test signature when anything changed (or with --test). Never overwrites a key.`,
    tier: "repo",
    operation: true,
    noMcp: true,
    args: [
      {
        name: "test",
        type: "boolean",
        description: "Make the test signature even when nothing changed.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { keysSetup } = await import("../identity/keys-commands.ts");
      return await keysSetup({ test: !!a["test"] });
    },
  },
  {
    name: "keys check-recovery",
    output: "report",
    summary: "Prove the recovery key still works (a test signature; changes nothing)",
    description: `Checks that the key store's recovery key (or --key <file>) is the fleet's recovery key and that you still know its passphrase, by signing a test message and verifying it against signers.ts. Records the date on this PC: stolos keys and boot doctor remind you after six months (spec 057).`,
    tier: "read",
    operation: true,
    noMcp: true,
    args: [
      {
        name: "key",
        type: "string",
        human: true,
        description: "The recovery key's private file (default: the one in the key store).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { keysCheckRecovery } = await import("../identity/keys-commands.ts");
      return await keysCheckRecovery(a["key"] as string | undefined);
    },
  },
  {
    name: "keys rotate",
    output: "action",
    summary: "Replace your daily key with a new one, approved by the current one",
    description: `Makes a new daily key, puts it in signers.ts in place of the current one (same signer name), and commits that alone, signed with the current key. Then the new key takes the old one's place (the old pair is kept as <file>.retired-<date>, never used again); Git's settings do not change. If interrupted, run it again: it continues. Push to approve (spec 057).`,
    tier: "repo",
    operation: true,
    noMcp: true,
    args: [],
    async run(): Promise<number> {
      const { keysRotate } = await import("../identity/keys-commands.ts");
      return await keysRotate();
    },
  },
  {
    name: "keys lost",
    output: "action",
    summary: "Your daily key is lost or stolen: replace it, approved by the recovery key",
    description: `Makes a new daily key (with --stolen, the old one still here is retired first; without it, a key that is here and listed is left alone), puts it in signers.ts in place of the lost one, and commits that alone, signed with the recovery key you pass. Once pushed, servers stop trusting the old key. If interrupted, run it again: it continues (spec 057).`,
    tier: "repo",
    operation: true,
    noMcp: true,
    args: [
      {
        name: "recovery",
        type: "string",
        human: true,
        description: "The recovery key's private file (default: the one in the key store).",
      },
      {
        name: "stolen",
        type: "boolean",
        description: "The daily key is still here but someone may have a copy: replace it too.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { keysLost } = await import("../identity/keys-commands.ts");
      return await keysLost(a["recovery"] as string | undefined, !!a["stolen"]);
    },
  },
  {
    name: "keys rotate-recovery",
    output: "action",
    summary:
      "Replace the recovery key, approved by the old one (or by the daily key if it is lost)",
    description: `Makes a new recovery key in the key store, tests it with a signature, puts it in signers.ts in place of the old one (same signer name), and commits that alone, signed with the OLD recovery key (the key store's, or --recovery <file>), which proves you still hold it. The old pair stays in the key store as fleet-recovery.retired-<date>. With --old-lost, the daily key signs instead, and it says so: a copied daily key could do the same. If interrupted, run it again: it continues; once done, it does nothing (spec 057).`,
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
    async run(a: Parsed): Promise<number> {
      const { keysRotateRecovery } = await import("../identity/keys-commands.ts");
      return await keysRotateRecovery({
        old: a["recovery"] as string | undefined,
        oldLost: !!a["old-lost"],
      });
    },
  },
  {
    name: "keys check-push",
    output: "report",
    summary: "The pre-push check: what you push is signed by a key the fleet trusts",
    description: `Run by Git before each push (the hook keys setup installs): each pushed tip of the fleet's branch must be signed by a key signers.ts lists as of what the remote has now, the same check servers make (spec 047). Refuses the push otherwise, with the fix. Skip it once with git push --no-verify.`,
    tier: "read",
    noMcp: true,
    args: [],
    async run(): Promise<number> {
      const { keysCheckPush } = await import("../identity/keys-commands.ts");
      return await keysCheckPush();
    },
  },
  {
    name: "host bootstrap",
    output: "action",
    summary: "Finish a host whose Ubuntu was installed by hand (over SSH)",
    description: `For a server installed from Ubuntu's ISO (or any other way) instead of by network boot: copies the host's first-boot files and its deploy key over SSH and runs the same first boot with sudo (spec 005). Run it from the boot machine after stolos host add.`,
    tier: "repo",
    operation: true,
    args: [
      { name: "name", type: "string", positional: true, required: true, description: "Host name." },
      { name: "ssh", type: "string", required: true, description: "user@address of the server." },
    ],
    examples: [
      {
        cmd: "bun run stolos host bootstrap alpha --ssh alice@10.0.30.57",
        text: "Finish alpha after a manual Ubuntu install.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { hostBootstrap } = await import("../install/host-bootstrap.ts");
      return await hostBootstrap({ name: a["name"] as string, ssh: a["ssh"] as string });
    },
  },
  {
    name: "device add",
    output: "action",
    summary:
      "Add a device (printer, router, switch, NAS, camera, UPS) read over SNMPv3: encrypted, read-only",
    description: `Spec 069. Records the device in fleets/<fleet>/devices/<name>/device.ts, asks for its SNMPv3 passphrases here (not echoed; from the Stolos Console, in the console's terminal) and keeps them in this PC's vault, then reads it once: model, serial, firmware, uptime, contact and location. It shows where to make a read-only SNMPv3 user on common devices. Only SNMPv3 with authentication and privacy (authPriv): never v1 or v2c. Stolos only reads (GET and GETNEXT).`,
    tier: "repo",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        required: true,
        description: "Its name in the fleet: front-printer, core-switch.",
      },
      {
        name: "address",
        type: "string",
        required: true,
        description: "Its address or name on the network.",
      },
      {
        name: "kind",
        type: "string",
        required: true,
        description: "What it is.",
        choices: [
          "router",
          "switch",
          "access-point",
          "firewall",
          "printer",
          "nas",
          "camera",
          "ups",
          "other",
        ],
      },
      {
        name: "user",
        type: "string",
        required: true,
        description: "The SNMPv3 user made on the device for Stolos.",
      },
      {
        name: "auth",
        type: "string",
        description: "Authentication: sha256 (default) or sha.",
        choices: ["sha256", "sha"],
      },
      { name: "port", type: "string", description: "Its SNMP port (default 161)." },
      {
        name: "title",
        type: "string",
        description: 'What it is, for people: "Front desk printer".',
      },
      { name: "owner", type: "string", description: "Who is responsible for it." },
      { name: "location", type: "string", description: "Where it is: a room, a rack." },
    ],
    examples: [
      {
        cmd: "bun run stolos device add front-printer --address 10.0.30.40 --kind printer --user stolos",
        text: "A printer, read over SNMPv3.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { deviceAdd } = await import("../device/commands.ts");
      return await deviceAdd({
        name: a["name"] as string,
        address: a["address"] as string,
        kind: a["kind"] as string,
        user: a["user"] as string,
        ...(a["auth"] ? { auth: a["auth"] as string } : {}),
        ...(a["port"] ? { port: a["port"] as string } : {}),
        ...(a["title"] ? { title: a["title"] as string } : {}),
        ...(a["owner"] ? { owner: a["owner"] as string } : {}),
        ...(a["location"] ? { location: a["location"] as string } : {}),
      });
    },
  },
  {
    name: "device observe",
    output: "action",
    summary: "Read every device (or one) now over SNMPv3, and record what it said in Git",
    description: `Spec 069. Writes fleets/<fleet>/devices/<name>/observed.ts (GENERATED). Keep it with bun run stolos apply.`,
    tier: "repo",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        description: "One device (default: all).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { deviceObserve } = await import("../device/commands.ts");
      return await deviceObserve(a["name"] as string | undefined);
    },
  },
  {
    name: "device check",
    output: "report",
    summary:
      "The devices' policies: observed, encrypted SNMPv3, an owner and location, restarted for firmware",
    description: `Spec 069. From the last observations, each with its SCF controls. Exits 1 when any fails; --json for auditors.`,
    tier: "read",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        description: "One device (default: all).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { deviceCheck } = await import("../device/commands.ts");
      return await deviceCheck(a["name"] as string | undefined, ctx.json);
    },
  },
  {
    name: "device remove",
    output: "action",
    summary: "Stop reading a device: its files and its SNMP passphrases go",
    description: `Spec 069. Removes fleets/<fleet>/devices/<name>/ and its passphrases from the vault. Remove the SNMPv3 user on the device too.`,
    tier: "repo",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        required: true,
        description: "The device.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { deviceRemove } = await import("../device/commands.ts");
      return await deviceRemove(a["name"] as string);
    },
  },
  {
    name: "host integrate",
    output: "action",
    summary:
      "The one line to run on a machine to bring it into the fleet (discover, adopt, server, workstation)",
    description: `Spec 069. Prints the command to run on the machine itself (Linux, macOS, WSL: integrate.sh; Windows: integrate.windows.ps1), at this engine's release, with the fleet filled in. It says what it will do, asks once, and ends with a check-in code to paste back here (or in the Stolos Console). --as discover changes nothing on the machine; adopt adds the read-only probe (its key is made in the vault now); osquery also installs osquery; server prepares a hand-installed Ubuntu for host bootstrap; workstation makes a managed workstation.`,
    tier: "repo",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        required: true,
        description: "Its name in the fleet (a DNS label): alice-laptop.",
      },
      {
        name: "as",
        type: "string",
        required: true,
        description: "discover, adopt, osquery, server, or workstation (several: adopt,osquery).",
      },
      {
        name: "github",
        type: "string",
        description: "--as server: whose GitHub keys may sign in (default: the fleet admin).",
      },
      {
        name: "repo",
        type: "string",
        description: "--as workstation: the fleet repository (default: this one's origin).",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos host integrate alice-laptop --as adopt",
        text: "The line Alice runs on her laptop.",
      },
      {
        cmd: "bun run stolos host integrate front-desk --as discover",
        text: "Just record a machine; change nothing on it.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { hostIntegrate } = await import("../adopt/commands.ts");
      return await hostIntegrate({
        name: a["name"] as string,
        as: a["as"] as string,
        ...(a["github"] ? { github: a["github"] as string } : {}),
        ...(a["repo"] ? { repo: a["repo"] as string } : {}),
      });
    },
  },
  {
    name: "host adopt",
    output: "action",
    summary: "Adopt a machine over SSH (macOS, any Linux): observe and check it, never manage it",
    description: `Spec 067. Pins the machine's SSH host key in Git, makes a probe key in the vault, and installs a read-only probe in the account's ~/.local/bin (over your own SSH, once: it may ask your password). The probe key's line in authorized_keys runs that probe and nothing else. Then it observes the machine and checks its policies (disk encryption, firewall, updates, supported OS, administrators), each labeled with its SCF controls. Writes fleets/<fleet>/adopted/<name>/machine.ts and observed.ts: keep them with bun run stolos apply. Run it again to reinstall the probe; it keeps the pinned key.`,
    tier: "repo",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        required: true,
        description: "Its name in the fleet (a DNS label): macbook, omarchy-desk.",
      },
      {
        name: "ssh",
        type: "string",
        description:
          "How to reach it: user@address, or user@address:port (with --check-in: only to override).",
      },
      {
        name: "check-in",
        type: "string",
        description:
          "The check-in code the machine printed (integrate --adopt): its keys are pinned from it.",
      },
      {
        name: "title",
        type: "string",
        description: 'What it is, for people: "Shahid\'s MacBook Pro".',
      },
      { name: "owner", type: "string", description: "Who it belongs to." },
      {
        name: "until",
        type: "string",
        description: "When adoption ends (YYYY-MM-DD): a contractor's laptop, a loaner.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { hostAdopt } = await import("../adopt/commands.ts");
      return await hostAdopt({
        name: a["name"] as string,
        ...(a["ssh"] ? { ssh: a["ssh"] as string } : {}),
        ...(a["check-in"] ? { checkIn: a["check-in"] as string } : {}),
        ...(a["title"] ? { title: a["title"] as string } : {}),
        ...(a["owner"] ? { owner: a["owner"] as string } : {}),
        ...(a["until"] ? { until: a["until"] as string } : {}),
      });
    },
  },
  {
    name: "host observe",
    output: "action",
    summary: "Observe adopted machines now (all, or one): what their probe finds",
    description: `Spec 067. Runs the read-only probe on each adopted machine with its probe key and writes fleets/<fleet>/adopted/<name>/observed.ts (git log -p is the machine's history). Keep the observations with bun run stolos apply.`,
    tier: "repo",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        description: "One machine (default: all).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { hostObserve } = await import("../adopt/commands.ts");
      return await hostObserve(a["name"] as string | undefined);
    },
  },
  {
    name: "host check",
    output: "report",
    summary: "The policies of adopted machines: pass, fail, and the fix (SCF controls)",
    description: `Spec 067. Reads each adopted machine's last observation and checks its policies: observed recently, disk encryption, firewall, automatic updates, updates waiting, a supported OS, SSH keys only, few administrators, osquery. Each result names the Secure Controls Framework controls it is evidence for. Exits 1 when any fails. --json for scripts and auditors.`,
    tier: "read",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        description: "One machine (default: all).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { hostCheck } = await import("../adopt/commands.ts");
      return await hostCheck(a["name"] as string | undefined, ctx.json);
    },
  },
  {
    name: "host accept",
    output: "action",
    summary: "Record an accepted risk: a policy an adopted machine may fail, why, and until when",
    description: `Spec 067. Writes the acceptance into the machine's machine.ts (who, from git user.name; why; until a date at most a year away). Until then the policy shows as accepted, not as passing, and Compliance counts it as partial; after it, it fails again. Keep it with bun run stolos apply: the signed commit is the auditor's record.`,
    tier: "repo",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        required: true,
        description: "The adopted machine.",
      },
      {
        name: "policy",
        type: "string",
        positional: true,
        required: true,
        description: "The policy's id (disk-encryption, firewall, auto-updates, ...).",
      },
      {
        name: "reason",
        type: "string",
        required: true,
        description: "Why, in words an auditor reads.",
      },
      {
        name: "until",
        type: "string",
        required: true,
        description: "Until when (YYYY-MM-DD, within a year).",
      },
    ],
    examples: [
      {
        cmd: 'bun run stolos host accept bob-desk disk-encryption --reason "holds only open-source code; no customer data" --until 2027-06-30',
        text: "An accepted risk, recorded.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { hostAccept } = await import("../adopt/commands.ts");
      return await hostAccept(
        a["name"] as string,
        a["policy"] as string,
        a["reason"] as string,
        a["until"] as string,
      );
    },
  },
  {
    name: "host release",
    output: "action",
    summary: "Stop adopting a machine: remove its probe, its model, and its probe key",
    description: `Spec 067. Over your own SSH, removes ~/.local/bin/stolos-probe and the probe key's line from authorized_keys; then deletes fleets/<fleet>/adopted/<name>/ and the probe key from the vault. Nothing else on the machine changes. Spec 110: a network asset (a device adopted through a router's integration) is released the same way on a person's explicit request: its record goes and nothing at the controller changes (no SSH, no probe), and a rule of network.ts does not adopt it again. A device that is gone from the integration is never released for you. Keep it with bun run stolos apply.`,
    tier: "repo",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        required: true,
        description: "The adopted machine.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { hostRelease } = await import("../adopt/commands.ts");
      return await hostRelease(a["name"] as string);
    },
  },
  {
    name: "network discover",
    output: "report",
    summary:
      "The devices a connected router's controller manages that are not adopted yet (discovered via UniFi)",
    description: `Spec 110. Lists, from the last observation of the connected router (stolos estate observe unifi), the devices its controller manages that no network asset of this fleet records yet: each with its class (gateway, switch, access point, camera, recorder, door controller, phone, or other), model, firmware, address and state. It reads the observation only: no SSH, no probe, no request to the controller. Adopt them with stolos network adopt. --class lists one class. --json for scripts.`,
    tier: "read",
    args: [
      {
        name: "class",
        type: "string",
        description:
          "Only devices of this class: gateway, switch, access-point, camera, recorder, door-controller, phone, other.",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos network discover",
        text: "What the controller manages that is not adopted.",
      },
      { cmd: "bun run stolos network discover --class switch", text: "Only the switches." },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { networkDiscover } = await import("../connect/network-commands.ts");
      return await networkDiscover({
        ...(a["class"] ? { class: a["class"] as string } : {}),
        json: ctx.json,
      });
    },
  },
  {
    name: "network adopt",
    output: "action",
    summary:
      "Adopt devices a connected router's controller manages as assets of the fleet (one signed commit)",
    description: `Spec 110. Adopts devices the controller manages as machines of the fleet, through the integration: no SSH, no probe. A device is named by its name, its MAC address or its id at the controller (stolos network discover lists them); --all adopts every discovered device, and --all --class switch every switch. Each is recorded in fleets/<fleet>/adopted/<name>/network.ts (via, account, device id, MAC, serial where the API gives one, class, model) and sent with stolos apply (one signed commit, your key). The name is the device's name made a DNS label; a name a machine, a host or another asset already has is refused, with what to do, and nothing is written for it. Stolos reads the controller and never changes it; releasing the asset (stolos host release) removes only the record. --no-apply writes it and leaves the sending to stolos apply.`,
    tier: "repo",
    noMcp: true,
    operation: true,
    args: [
      {
        name: "devices",
        type: "string",
        positional: true,
        repeatable: true,
        description: "Devices by name, MAC or id (stolos network discover lists them).",
      },
      { name: "all", type: "boolean", description: "Every discovered device." },
      {
        name: "class",
        type: "string",
        description:
          "With --all: only this class (gateway, switch, access-point, camera, recorder, door-controller, phone, other).",
      },
      {
        name: "no-apply",
        type: "boolean",
        description: "Write the change but do not send it (stolos apply sends it later).",
      },
      {
        name: "message",
        short: "m",
        type: "string",
        description: "The commit message (default: 110-network-assets: adopt <names>).",
      },
    ],
    examples: [
      { cmd: "bun run stolos network adopt office-switch", text: "One device, by name." },
      {
        cmd: "bun run stolos network adopt --all --class access-point",
        text: "Every discovered access point.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { networkAdopt } = await import("../connect/network-commands.ts");
      return await networkAdopt({
        devices: String(a["devices"] ?? "")
          .split(/[\n,]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        all: !!a["all"],
        ...(a["class"] ? { class: a["class"] as string } : {}),
        noApply: !!a["no-apply"],
        ...(a["message"] ? { message: a["message"] as string } : {}),
      });
    },
  },
  {
    name: "network status",
    output: "report",
    summary:
      "The network assets by class, the devices discovered, the ones gone from the integration, and the unmanaged devices",
    description: `Spec 110. The Network group of stolos fleet status: the assets this fleet adopted through the connected router, by class; the devices discovered and not adopted; each asset gone from the integration (a warning with its fix: never an automatic deletion) or offline; and the clients no machine of the fleet matches (unmanaged devices on the network: observed, never adopted from here; stolos pair brings a machine in). Reads the last observation. --json for scripts.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { networkStatus } = await import("../connect/network-commands.ts");
      return await networkStatus(ctx.json);
    },
  },
  {
    name: "network check",
    output: "report",
    summary:
      "The posture of the network: nine policies over what the router's controller reports (SCF controls, fixes, gaps)",
    description: `Spec 111. Runs the network pack over the last observation of the connected router (stolos estate observe unifi), the network assets, the fleet's tags and network.ts, and asks the controller nothing: network/observed, devices-present, devices-online, firmware-current (the device's own update-available flag), wifi-no-open (the broadcast's security type), guest-isolated (the guest network's isolation flag), unknown-clients (informational until network.ts lists knownClients by MAC), assets-classified (the owner and criticality tags the fleet defines) and unused-poe (a port with its link down and PoE on). Each failing policy is a warning with its items, its SCF controls, its fix and its code (stolos explain E111-<WORD>); what was not observed yet is one waiting item; what the official API cannot support (a management interface reachable from guests, WEP, disabled ports, how far a firmware is behind, a firewall rule's effect) is listed as a gap with its reason. Accept a risk in controls/accepted.ts as network/<word>. The results are also evidence for stolos compliance, fleet status and the console. --tag, --any-tag and --select check only the network assets they choose. Exits 1 when a policy fails; --json for auditors.`,
    tier: "read",
    args: [...TAG_SELECT_ARGS],
    examples: [
      { cmd: "bun run stolos network check", text: "The posture of the whole network." },
      {
        cmd: "bun run stolos network check --tag criticality:high",
        text: "Only the assets tagged high criticality, and what is connected through them.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { networkCheck } = await import("../connect/network-check.ts");
      return await networkCheck(
        { tag: a["tag"], "any-tag": a["any-tag"], select: a["select"] },
        ctx.json,
      );
    },
  },
  {
    name: "network inventory",
    output: "report",
    summary:
      "The network inventory (NIST SP 800-53 CM-8): every device, Wi-Fi network and network, as deterministic Markdown or JSON",
    description: `Spec 111. Lists every network device the integration reports or the fleet adopted (name, class, model, firmware, whether an update waits, address, MAC, state, uplink, tags, how it joined, where it is against the integration, and when it was observed), then the Wi-Fi networks (security, guest, enabled), the networks (VLAN, isolation) and the gaps. It holds no time of its own, so the same observation and records give the same bytes: commit it, or attach it to an audit. Reads the last observation; asks the controller nothing. --format markdown (default) or json; --out writes a file, else it is printed.`,
    tier: "read",
    args: [
      {
        name: "format",
        type: "string",
        description: "markdown (default) or json.",
        choices: ["markdown", "json"],
      },
      { name: "out", type: "string", description: "Write the report to this file." },
    ],
    examples: [
      {
        cmd: "bun run stolos network inventory --out out/network-inventory.md",
        text: "The CM-8 inventory of the network, as a file.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { networkInventory } = await import("../connect/network-check.ts");
      return await networkInventory({
        ...(a["format"] ? { format: a["format"] as string } : {}),
        ...(a["out"] ? { out: a["out"] as string } : {}),
      });
    },
  },
  {
    name: "network changes",
    output: "report",
    summary:
      "What changed in the network since a commit or a date: devices, firmware, Wi-Fi security, networks, firewall rules",
    description: `Spec 111. The router's observation is a generated file committed in Git (fleets/<fleet>/estate/<id>.ts), so a difference between two of its versions is a recorded change (CM-3, CM-6). Lists, for each commit of the file since --since (a commit, or the last commit before a date; default "7 days ago"), what changed against the version before it: a device added, gone, renamed or with new firmware; a Wi-Fi network added, removed or with another security; a network added, removed or changed; a firewall rule added, removed or changed. The first version of the file is the baseline and gives no event; an observation not committed yet is listed as uncommitted. Each event names its SCF controls. stolos compliance drift includes the same events. Reads Git; asks the controller nothing. --json for scripts.`,
    tier: "read",
    args: [
      {
        name: "since",
        type: "string",
        description: 'A commit, or a date Git understands (default: "7 days ago").',
      },
    ],
    examples: [
      {
        cmd: "bun run stolos network changes --since 2026-11-01",
        text: "Every recorded change of the network since the first of November.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { networkChangesCommand } = await import("../connect/network-check.ts");
      return await networkChangesCommand({
        ...(a["since"] ? { since: a["since"] as string } : {}),
        json: ctx.json,
      });
    },
  },
  {
    name: "tag list",
    output: "report",
    summary: "The fleet's tags and which machines hold them; one machine's tags with their origins",
    description: `Spec 108. Lists the tags this fleet defines in fleets/<fleet>/tags.ts (dimensions, tags, colours, how many machines hold each) and every machine with its tags; free-form (custom) tags are always shown apart, marked custom. With a machine, each of its tags with its label and origin (person, a rule of tags.ts, or a group it inherits from) and what a stronger origin overrode. --tag, --any-tag and --select list only the machines they choose. Tags are defined by editing tags.ts (an environment, a role, a site, an owner, a criticality and a data class come with a new fleet), never by a command: this one says where. Spec 112: a machine's own claims (its /etc/machine-info, its firmware, its archon tag table) are listed as what it says, below the fleet's tags, and where it says another value than the fleet in a one-of dimension the fleet's wins and the disagreement is shown; hints are never used to choose machines unless --reported says so. --json for scripts.`,
    tier: "read",
    args: [
      {
        name: "machine",
        type: "string",
        positional: true,
        description: "One machine: each of its tags, with its origin.",
      },
      ...TAG_SELECT_ARGS,
      REPORTED_ARG,
    ],
    examples: [
      { cmd: "bun run stolos tag list", text: "The defined tags and every machine's." },
      {
        cmd: "bun run stolos tag list alpha",
        text: "One machine's tags, each with where it came from.",
      },
      {
        cmd: "bun run stolos tag list --select 'env:prod and not role:database'",
        text: "The machines that expression chooses.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { tagList } = await import("../fleet/tag-commands.ts");
      return await tagList(
        {
          ...(a["machine"] ? { machine: a["machine"] as string } : {}),
          ...(a["tag"] ? { tag: a["tag"] as string } : {}),
          ...(a["any-tag"] ? { anyTag: a["any-tag"] as string } : {}),
          ...(a["select"] ? { select: a["select"] as string } : {}),
          ...(a["reported"] ? { reported: true } : {}),
        },
        ctx.json,
        ctx.verbose === true,
      );
    },
  },
  {
    name: "tag add",
    output: "action",
    summary: "Give a machine tags (one signed commit): env:prod, role:nas, or a free-form word",
    description: `Spec 108. Gives a machine tags: a defined tag is <dimension>:<value> from fleets/<fleet>/tags.ts (a tag that is not defined is refused, with what is near it); a plain lowercase word is a free-form tag, always shown as custom (a word that is also a dimension's or a tag's own name, such as prod, is refused as a forgotten dimension unless --custom). A one-of dimension holds one value: a new value replaces the old one, and it says so. The change is written in the machine's own file (decisions.ts of a managed host, machine.ts of an adopted machine, the controller included) and sent with stolos apply (one signed commit, your key); it refuses while other changes are uncommitted. --no-apply writes it and leaves the sending to stolos apply.`,
    tier: "repo",
    noMcp: true,
    operation: true,
    args: [
      {
        name: "machine",
        type: "string",
        positional: true,
        required: true,
        description: "The machine's name (stolos tag list shows them).",
      },
      {
        name: "tags",
        type: "string",
        positional: true,
        repeatable: true,
        required: true,
        description: "One or more tags: env:prod role:nas pilot.",
      },
      {
        name: "custom",
        type: "boolean",
        description:
          "Read every word as a free-form tag, even a word that is also a defined tag's name.",
      },
      {
        name: "no-apply",
        type: "boolean",
        description: "Write the change but do not send it (stolos apply sends it later).",
      },
      {
        name: "message",
        short: "m",
        type: "string",
        description: "The commit message (default: 108-tags: tag <machine> <tags>).",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos tag add alpha env:prod role:web",
        text: "Two defined tags, sent in one signed commit.",
      },
      { cmd: "bun run stolos tag add alpha pilot", text: "A free-form tag: shown as custom." },
    ],
    async run(a: Parsed): Promise<number> {
      const { tagAdd } = await import("../fleet/tag-commands.ts");
      return await tagAdd({
        machine: a["machine"] as string,
        tags: String(a["tags"] ?? ""),
        custom: !!a["custom"],
        noApply: !!a["no-apply"],
        ...(a["message"] ? { message: a["message"] as string } : {}),
      });
    },
  },
  {
    name: "tag remove",
    output: "action",
    summary: "Take tags a person gave a machine off it (one signed commit)",
    description: `Spec 108. Removes tags from a machine's own file and sends the change with stolos apply, as stolos tag add does. Only a person's tags are removed here: a tag a rule or a group of tags.ts gives is refused, with where it comes from (change the rule or group, or give the machine another value of the dimension: a person's tag wins).`,
    tier: "repo",
    noMcp: true,
    operation: true,
    args: [
      {
        name: "machine",
        type: "string",
        positional: true,
        required: true,
        description: "The machine's name.",
      },
      {
        name: "tags",
        type: "string",
        positional: true,
        repeatable: true,
        required: true,
        description: "One or more tags it holds.",
      },
      {
        name: "no-apply",
        type: "boolean",
        description: "Write the change but do not send it (stolos apply sends it later).",
      },
      {
        name: "message",
        short: "m",
        type: "string",
        description: "The commit message (default: 108-tags: untag <machine> <tags>).",
      },
    ],
    examples: [{ cmd: "bun run stolos tag remove alpha pilot", text: "Take a free-form tag off." }],
    async run(a: Parsed): Promise<number> {
      const { tagRemove } = await import("../fleet/tag-commands.ts");
      return await tagRemove({
        machine: a["machine"] as string,
        tags: String(a["tags"] ?? ""),
        noApply: !!a["no-apply"],
        ...(a["message"] ? { message: a["message"] as string } : {}),
      });
    },
  },
  {
    name: "tag accept",
    output: "action",
    summary: "Accept what a machine says about itself as a tag a person gave (one signed commit)",
    description: `Spec 112. A machine says things about itself (its /etc/machine-info, its firmware, its own archon tag table): the fleet reads them as claims and never as its own tags (stolos tag list <machine> shows what it says, with where it was read and what the fleet did with it). This turns a claim into a tag a person gave, written in the machine's own file and sent with stolos apply (one signed commit, your key), by the same code as stolos tag add: a person's tag wins over a rule's and a group's, and a new value of a one-of dimension replaces the old one. It refuses a tag the machine does not claim, and a claim that tags.ts does not define (define it in the spec loop first). --no-apply writes it and leaves the sending to stolos apply. There is no command that ignores a claim: a dimension of tags.ts says fromMachine: "ignore", and the console's Ignore hides one for the session.`,
    tier: "repo",
    noMcp: true,
    operation: true,
    args: [
      {
        name: "machine",
        type: "string",
        positional: true,
        required: true,
        description: "The machine's name (stolos tag list shows them).",
      },
      {
        name: "tags",
        type: "string",
        positional: true,
        repeatable: true,
        required: true,
        description: "One or more tags it claims: env:prod role:nas.",
      },
      {
        name: "no-apply",
        type: "boolean",
        description: "Write the change but do not send it (stolos apply sends it later).",
      },
      {
        name: "message",
        short: "m",
        type: "string",
        description:
          "The commit message (default: 112-machine-reported-tags: accept <machine> <tags>).",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos tag accept alpha env:prod",
        text: "alpha says it is production: now a person says so too, in one signed commit.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { tagAccept } = await import("../fleet/tag-commands.ts");
      return await tagAccept({
        machine: a["machine"] as string,
        tags: String(a["tags"] ?? ""),
        noApply: !!a["no-apply"],
        ...(a["message"] ? { message: a["message"] as string } : {}),
      });
    },
  },
  {
    name: "tag list",
    place: "machine",
    output: "report",
    summary: "The tags this machine says about itself (its own table, osquery's archon_tags)",
    description: `Spec 112. Lists this machine's own tags table in its archon.sql: each tag with its source (local: said here by a person with archon tag add; fleet: what this machine worked out from the fleet repository it holds at its last apply) and who and when. osquery reads the same rows as the table archon_tags (archon query "select * from archon_tags"), and the PC reads them as claims over SSH. These are what the machine says about itself: none of it changes the machine's configuration, and the fleet decides what to do with it (a machine never overrides the fleet's tags). --json for scripts.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { tagListLocal } = await import("../fleet/machine-tags.ts");
      return await tagListLocal(ctx.hostName, ctx.json);
    },
  },
  {
    name: "tag add",
    place: "machine",
    output: "action",
    operation: true,
    summary: "Say a tag about this machine, in its own table (root; run log and journal)",
    description: `Spec 112. Writes tags into this machine's own tags table in its archon.sql (source local, with who and when): env:prod, role:nas, or a plain word (pilot). A tag is read with the fleet's tag grammar (<dimension>:<value>, lowercase, at most 64 characters); a new value of a one-of dimension of the fleet's tags replaces this machine's old one; a tag the fleet's tags.ts does not define is written and said to be one the PC cannot accept. Every change goes to the run log and the journal. This is what the machine says about itself, never configuration: the PC reads it as a claim, and the fleet decides (it never overrides the fleet's tags; where it disagrees, the disagreement is a finding). It changes nothing in the fleet repository.`,
    tier: "mutate",
    args: [
      {
        name: "tags",
        type: "string",
        positional: true,
        repeatable: true,
        required: true,
        description: "One or more tags: env:prod role:nas pilot.",
      },
      {
        name: "custom",
        type: "boolean",
        description:
          "Read every word as a free-form tag, even a word that is also a defined tag's name.",
      },
    ],
    examples: [
      {
        cmd: "archon tag add env:prod pilot",
        text: "This machine says it is production, and a pilot.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { tagAddLocal } = await import("../fleet/machine-tags.ts");
      return await tagAddLocal(ctx.hostName, String(a["tags"] ?? ""), { custom: !!a["custom"] });
    },
  },
  {
    name: "tag remove",
    place: "machine",
    output: "action",
    operation: true,
    summary: "Take tags off this machine's own table (root; only the ones said here)",
    description: `Spec 112. Removes tags from this machine's own tags table: only the ones a person said here (source local); what the fleet says of this machine (source fleet) is the fleet's, and is changed in the fleet repository. Every change goes to the run log and the journal.`,
    tier: "mutate",
    args: [
      {
        name: "tags",
        type: "string",
        positional: true,
        repeatable: true,
        required: true,
        description: "One or more tags it says.",
      },
    ],
    examples: [{ cmd: "archon tag remove pilot", text: "Take a tag back." }],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { tagRemoveLocal } = await import("../fleet/machine-tags.ts");
      return await tagRemoveLocal(ctx.hostName, String(a["tags"] ?? ""));
    },
  },
  {
    name: "fleet query",
    output: "report",
    summary: "Ask every machine one SQL question (osquery): managed and adopted, one table",
    description: `Specs 067 and 107. Runs one osquery SELECT on every machine at once (at most 8 at a time): managed servers through their MCP server (archon query, over SSH as ops) and adopted machines through their probe (where osquery is installed), this PC's included. Each machine has a time limit (15 seconds; --timeout changes it); one that fails or does not answer in time is named with its reason, and the last line says "N of M answered". Prints one table with a machine column; --json for scripts (each answer carries its state, and how long it took). Read-only: one SELECT on the allowlisted tables (as archon query), anything else is refused; each server also limits what it answers (spec 048). Spec 108: --tag, --any-tag and --select ask only the machines with those tags (--select 'env:prod and not role:database'), and each answer carries the machine's tags. Spec 112: they choose by the fleet's own tags and the claims its dimensions accept; the hints machines reported about themselves (shown, never used otherwise) are included only with --reported; every machine's own tags are the table archon_tags (select * from archon_tags). Examples: "select name, version from os_version"; "select name, bundle_short_version from apps where name like 'Google Chrome%'"; "select port, address from listening_ports".`,
    tier: "read",
    args: [
      {
        name: "sql",
        type: "string",
        positional: true,
        required: true,
        description: "One osquery SELECT.",
      },
      {
        name: "timeout",
        type: "string",
        description: "Seconds each machine has to answer (15 by default).",
      },
      ...TAG_SELECT_ARGS,
      REPORTED_ARG,
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { fleetQuery } = await import("../adopt/commands.ts");
      const t = a["timeout"] === undefined ? undefined : Number(a["timeout"]);
      if (t !== undefined && !(Number.isFinite(t) && t >= 1 && t <= 600)) {
        throw new Error(`--timeout ${a["timeout"]}: seconds, from 1 to 600`);
      }
      return await fleetQuery(a["sql"] as string, ctx.json, t, {
        tag: a["tag"],
        "any-tag": a["any-tag"],
        select: a["select"],
        reported: a["reported"],
      });
    },
  },
  {
    name: "compliance",
    output: "report",
    summary:
      "The fleet's evidence by SCF control, and by each framework's requirements (SOC 2, HIPAA, PCI DSS, CMMC, NIST, FedRAMP)",
    description: `Specs 068 and 071. From what this PC already knows (managed servers' last verify, adopted machines' and devices' policies, the SaaS and cloud accounts' posture, the repository's signatures): each Secure Controls Framework control's status and evidence, and each framework requirement's status through its controls, by the SCF Council's own mappings (STRM; bun run stolos compliance catalog downloads them once). Spec 073: each control's evidence age (newest and oldest), each source held to its cadence (managed servers verify every 15 minutes; adopted machines, devices, and accounts daily; compliance.cadence in fleet.ts overrides them); stale evidence is a failing check of its controls and of MON-02, with the command that observes it again. Exits 1 when a control fails; --json for auditors (with the ages). Spec 108: --tag, --any-tag and --select cut the evidence to the machines with those tags (managed, adopted and devices; a cloud account's and the estate's evidence is not about one machine and stays).`,
    tier: "read",
    args: [
      {
        name: "framework",
        type: "string",
        description:
          "soc2, hipaa, pci, cmmc, nist80053, nist800171, or fedramp (default: a summary of each).",
        choices: ["soc2", "hipaa", "pci", "cmmc", "nist80053", "nist800171", "fedramp"],
      },
      {
        name: "ocsf",
        type: "boolean",
        description:
          "Print every result as an OCSF 1.9.0 Compliance Finding (class 2003), one JSON object per line.",
      },
      ...TAG_SELECT_ARGS,
    ],
    examples: [
      {
        cmd: "bun run stolos compliance --framework hipaa",
        text: "Each HIPAA Security Rule requirement Stolos has evidence for.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { complianceCommand } = await import("../compliance/commands.ts");
      return await complianceCommand(a["framework"] as string | undefined, ctx.json, !!a["ocsf"], {
        tag: a["tag"],
        "any-tag": a["any-tag"],
        select: a["select"],
      });
    },
  },
  {
    name: "controls list",
    output: "report",
    summary: "The fleet's own control packs and their controls (TypeScript, tested like code)",
    description: `Spec 078. Lists each pack in fleets/<fleet>/controls/<pack>/pack.ts: its version, and each control's id (<pack>/<control>), subject (estate SQL, osquery on adopted machines, or an observation), SCF controls, and title. A pack that does not load is named with why. --json for scripts. How to write one: bun run stolos docs controls.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { controlsList } = await import("../controls/commands.ts");
      return await controlsList(ctx.json);
    },
  },
  {
    name: "controls run",
    output: "report",
    summary:
      "Run the fleet's control packs now: estate SQL, osquery on adopted machines, observations",
    description: `Spec 078. Runs every control of every pack (or one pack): estate controls over the estate graph built from Git, observation controls over the observations in Git, and osquery controls on each adopted machine through its probe (one SELECT, as fleet query; each answer is kept on this PC, so stolos compliance and the consoles show it without asking again). Accepted risks (fleets/<fleet>/controls/accepted.ts) apply. Read-only. Exits 1 when a control fails; --json for scripts.`,
    tier: "read",
    args: [
      {
        name: "pack",
        type: "string",
        positional: true,
        description: "Only this pack (its id).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { controlsRun } = await import("../controls/commands.ts");
      return await controlsRun(a["pack"] as string | undefined, ctx.json);
    },
  },
  {
    name: "controls test",
    output: "report",
    summary: "Run the control packs' tests (bun test fleets/<fleet>/controls/)",
    description: `Spec 078. Runs the tests of fleets/<fleet>/controls/ in the fleet repository: each pack's *.test.ts, which test its controls over fixtures with testControl. Nothing is asked of a machine or an account. The same as bun run test, for the packs only. Terminal only.`,
    tier: "read",
    noMcp: true,
    args: [],
    async run(): Promise<number> {
      const { controlsTest } = await import("../controls/commands.ts");
      return await controlsTest();
    },
  },
  {
    name: "risks list",
    output: "report",
    aliases: ["risks"],
    summary: "The risk register (fleets/<fleet>/risks.ts), highest level of risk first",
    description: `Spec 080. Lists each risk in fleets/<fleet>/risks.ts: its level (NIST SP 800-30 Rev 1 Table I-2, from its likelihood and impact), treatment (accept, mitigate, transfer, avoid), owner, next review, and status. --json for scripts. How to write it: bun run stolos docs risks.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { risksList } = await import("../risk/commands.ts");
      return await risksList(ctx.json);
    },
  },
  {
    name: "risks check",
    output: "report",
    summary: "Check the risk register and vendors: overdue reviews, owners, accepted risks, triage",
    description: `Spec 080. Runs the risk-register controls over the estate graph built from Git: an open risk past its next review fails (SCF RSK-14, RSK-13.2); an owner who is not an active person on the roster warns (RSK-11); an accepted risk past its date fails, and one no risk names warns (RSK-16.1); a discovered vendor not triaged in vendors.ts warns (TPM-08, TPM-09). Then names who approved the last change to risks.ts and vendors.ts (git verify-commit against signers.ts). Read-only. Exits 1 when a control fails; --json for scripts.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { risksCheck } = await import("../risk/commands.ts");
      return await risksCheck(ctx.json);
    },
  },
  {
    name: "risks review",
    output: "action",
    summary: "Record a risk's review: its next review date moves on, in a signed pull request",
    description: `Spec 080. From a clean checkout: a branch from the main branch on GitHub, risks.ts with the risk's nextReview moved on (by its reviewEveryDays, 90 by default, or to --next), one commit signed with your daily key (ssh-keygen asks its passphrase here), a push of that branch, and a pull request (gh pr create). Nothing is merged: a fleet signer approves by merging with a signed merge commit. --check shows the change and makes none. Terminal only.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The risk's id in risks.ts.",
      },
      { name: "next", type: "string", description: "The next review (YYYY-MM-DD)." },
      { name: "note", type: "string", description: "What the review found, for the pull request." },
      { name: "check", type: "boolean", description: "Show the change; make none." },
    ],
    async run(a: Parsed): Promise<number> {
      const { risksReview } = await import("../risk/commands.ts");
      return await risksReview(a["id"] as string, {
        ...(a["next"] ? { next: a["next"] as string } : {}),
        ...(a["note"] ? { note: a["note"] as string } : {}),
        check: !!a["check"],
      });
    },
  },
  {
    name: "vendors list",
    output: "report",
    aliases: ["vendors"],
    summary:
      "The fleet's vendors: discovered (SSO applications, DNS, connected accounts) and triaged",
    description: `Spec 080. Every vendor the estate reveals: the applications people sign in to through Okta or Entra, CNAME and MX records pointing at a third party, and each connected account's provider (and, later, billing), each as an organization (party_role supplier) in the estate graph, with its criticality (FIPS 199) and the data it holds (OCSF categories) from fleets/<fleet>/vendors.ts. Read-only; --json for scripts.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { vendorsList } = await import("../risk/commands.ts");
      return await vendorsList(ctx.json);
    },
  },
  {
    name: "vendors triage",
    output: "action",
    summary: "Vendors waiting for triage; --write opens a pull request adding them to vendors.ts",
    description: `Spec 080. Lists each discovered vendor that is not in fleets/<fleet>/vendors.ts, or whose criticality is still unassessed. With --write: from a clean checkout, a branch, vendors.ts with an entry for each new vendor (criticality "unassessed", for the reviewer to set), one signed commit, a push, and a pull request (gh pr create). A fleet signer approves by merging with a signed merge commit. Terminal only.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "write",
        type: "boolean",
        description: "Open a pull request adding the new vendors to vendors.ts.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { vendorsTriage } = await import("../risk/commands.ts");
      return await vendorsTriage({ write: !!a["write"], json: ctx.json });
    },
  },
  {
    name: "people status",
    output: "report",
    aliases: ["people"],
    summary:
      "People controls now: leavers, joiners, people on leave, access reviews, policies, training, screening",
    description: `Spec 077. Runs the estate's leavers check and every people check over the estate graph built from Git (no network): joiners without the accounts their role needs (fleets/<fleet>/people/roles.ts), active accounts of people on leave, how long each leaver's accounts stayed active after the end date (from the observations' history in Git), last quarter's access reviews (each approved by a commit signed by the manager's own key in people/keys.ts or a fleet signer), policy acknowledgements (commits signed by each person's own key) and overdue policy reviews (policies/*.md front matter), training within 12 months (people/training.ts), and screening on file (people/screening.ts). Accepted risks (controls/accepted.ts, as people/<control>) apply. Read-only. Exits 1 when a check fails; --json for scripts. How it works: bun run stolos docs people.`,
    tier: "read",
    args: [],
    examples: [{ cmd: "bun run stolos people status", text: "Every people check, now." }],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { peopleStatus } = await import("../people/commands.ts");
      return await peopleStatus(ctx.json);
    },
  },
  {
    name: "people review",
    output: "action",
    summary: "This quarter's access reviews: one file per manager, signed, as a pull request",
    description: `Spec 077. Writes fleets/<fleet>/people/reviews/<quarter>/<manager>.md for each manager in the HR system's reporting lines: each report's active accounts and admin rights, one line to tick each. Commits them signed (your passphrase) on the branch people/review-<quarter>, pushes it, and opens a pull request with gh. A manager approves by ticking every line in a commit signed with their own key (people/keys.ts) or a fleet signer's. A file already on this branch is kept. --check shows what it would write; --local commits on the branch without pushing. Terminal only.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "quarter",
        type: "string",
        description: "The quarter, as 2026-Q4 (default: this one).",
      },
      {
        name: "check",
        type: "boolean",
        description: "Show the files it would write; change nothing.",
      },
      {
        name: "local",
        type: "boolean",
        description: "Commit on the branch here; push nothing, open no pull request.",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos people review --quarter 2026-Q4",
        text: "The fourth quarter's reviews, as a pull request.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { peopleReview } = await import("../people/commands.ts");
      return await peopleReview({
        ...(a["quarter"] ? { quarter: a["quarter"] as string } : {}),
        check: !!a["check"],
        local: !!a["local"],
      });
    },
  },
  {
    name: "people ack",
    output: "action",
    summary: "Acknowledge a policy's current version, in a commit signed with your own key",
    description: `Spec 077. Adds you (Git's user.email) with the policy's current version (its front matter) to fleets/<fleet>/policies/acks/<policy>.ts and commits it signed with your own key, the one people/keys.ts lists for your email, with the trailer Acknowledges: <policy>@<version>. The signed commit is the e-signature. It does not push: send it to main in a pull request, or, as a fleet signer, with stolos apply. Terminal only.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "policy",
        type: "string",
        positional: true,
        required: true,
        description: "The policy: its file name in policies/, without .md.",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos people ack acceptable-use",
        text: "Acknowledge policies/acceptable-use.md's current version.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { peopleAck } = await import("../people/commands.ts");
      return await peopleAck(a["policy"] as string);
    },
  },
  {
    name: "evidence export",
    output: "report",
    summary: "A period's evidence as one signed bundle an auditor checks offline",
    description: `Spec 072. Gathers, for the period: every commit in the fleet repository (each raw, with its SSH signature), each observation Stolos recorded in it (adopted machines, devices, the estate), the verify and install results this PC recorded, signers.ts, and the OSCAL assessment results. Each item is stored under its SHA-256 and listed in a hash-chained manifest, which your daily key signs (ssh-keygen asks its passphrase here; Stolos never sees it). Terminal only.`,
    tier: "read",
    noMcp: true,
    args: [
      { name: "from", type: "string", required: true, description: "The first day (YYYY-MM-DD)." },
      { name: "to", type: "string", required: true, description: "The last day (YYYY-MM-DD)." },
      {
        name: "out",
        type: "string",
        description: "The ZIP to write (default: this PC's state directory, evidence/).",
      },
      {
        name: "key",
        type: "string",
        description: "The private key to sign with (default: Git's signing key, your daily key).",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos evidence export --from 2026-01-01 --to 2026-06-30",
        text: "The first half of 2026, for a SOC 2 Type 2 period.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { evidenceExport } = await import("../evidence/commands.ts");
      return await evidenceExport(a["from"] as string, a["to"] as string, {
        ...(a["out"] ? { out: a["out"] as string } : {}),
        ...(a["key"] ? { key: a["key"] as string } : {}),
      });
    },
  },
  {
    name: "evidence verify",
    output: "report",
    summary: "Check an evidence bundle, offline: unchanged, complete, chained, signed",
    description: `Spec 072. Checks that every item is unchanged (its SHA-256), none is missing or added, the chain is whole, the manifest is signed by an allowed signer, and every commit carries a valid Git signature. Each problem is named with its reason; exits 1 on any. Without --signers it trusts the signers inside the bundle, and says so.`,
    tier: "read",
    args: [
      {
        name: "bundle",
        type: "string",
        positional: true,
        required: true,
        description: "The bundle (a ZIP).",
      },
      {
        name: "signers",
        type: "string",
        description: "An allowed_signers file you trust (the fleet's, from elsewhere).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { evidenceVerify } = await import("../evidence/commands.ts");
      return await evidenceVerify(
        a["bundle"] as string,
        a["signers"] as string | undefined,
        ctx.json,
      );
    },
  },
  // Spec 083: the auditor portal.
  {
    name: "audit open",
    output: "action",
    summary:
      "Open an audit engagement: the firm, the period, the controls in scope, access until a day",
    description: `Spec 083. Writes fleets/<fleet>/audits/<id>/engagement.ts: the audit firm and its people, the period, the frameworks, the controls in scope (--controls "CC6.2=leavers,CC8.1=change": each control's id and the population it is tested on; populations: change, leavers, mfa, devices, repositories, access-reviews, verify; default: each population as its own control), and the last day the auditor's access works (--expires). One commit of that file, signed with your daily key (ssh-keygen asks its passphrase here); nothing is pushed. Terminal only.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The engagement's id (lowercase letters, digits, dashes).",
      },
      { name: "firm", type: "string", required: true, description: "The audit firm." },
      {
        name: "auditor",
        type: "string",
        required: true,
        repeatable: true,
        description: 'A person at the firm: "Name <email>" (repeat for each).',
      },
      {
        name: "from",
        type: "string",
        required: true,
        description: "The period's first day (YYYY-MM-DD).",
      },
      {
        name: "to",
        type: "string",
        required: true,
        description: "The period's last day (YYYY-MM-DD).",
      },
      {
        name: "expires",
        type: "string",
        required: true,
        description: "The last day the auditor's access works (YYYY-MM-DD, UTC).",
      },
      {
        name: "framework",
        type: "string",
        repeatable: true,
        description: "A framework in scope (soc2, iso27001, ...).",
      },
      {
        name: "controls",
        type: "string",
        description: 'The controls in scope: "<id>=<population>,..." (default: every population).',
      },
      { name: "title", type: "string", description: "Its name for people." },
    ],
    examples: [
      {
        cmd: 'bun run stolos audit open soc2-2026 --firm "Example CPA" --auditor "Dana Example <dana@example.com>" --from 2026-01-01 --to 2026-06-30 --expires 2026-09-30 --framework soc2 --controls "CC6.2=leavers,CC8.1=change"',
        text: "A SOC 2 Type 2 engagement for the first half of 2026.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { auditOpenCmd } = await import("../audit/commands.ts");
      return await auditOpenCmd(a);
    },
  },
  {
    name: "audit bundle",
    output: "action",
    summary:
      "Pin the period's evidence bundle to an engagement (its populations are drawn from it)",
    description: `Spec 083. Checks the bundle (spec 072: signed by a fleet signer, covering the engagement's period), copies it into this PC's evidence directory, and records its file name, SHA-256, and manifest head in engagement.ts, in a signed commit. Terminal only.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The engagement.",
      },
      {
        name: "bundle",
        type: "string",
        positional: true,
        required: true,
        description: "The evidence bundle (a ZIP from stolos evidence export).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { auditChangeCmd } = await import("../audit/commands.ts");
      return await auditChangeCmd("bundle", a);
    },
  },
  {
    name: "audit access",
    output: "action",
    summary: "Move the last day an engagement's auditor access works",
    description: `Spec 083. Sets access.expires in engagement.ts, in a signed commit. The portal refuses every request after that day. Terminal only.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The engagement.",
      },
      {
        name: "expires",
        type: "string",
        required: true,
        description: "The last day (YYYY-MM-DD, UTC).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { auditChangeCmd } = await import("../audit/commands.ts");
      return await auditChangeCmd("access", a);
    },
  },
  {
    name: "audit request",
    output: "action",
    summary: "Record an auditor's request in the engagement's trail (a signed commit)",
    description: `Spec 083. Adds the next numbered file to fleets/<fleet>/audits/<id>/trail/ with the request's text as the auditor sent it, in a commit signed with your daily key whose trailer names the file's SHA-256. --by is one of the engagement's auditors. Terminal only.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The engagement.",
      },
      {
        name: "by",
        type: "string",
        required: true,
        description: "The auditor who asked (their name in engagement.ts).",
      },
      {
        name: "text",
        type: "string",
        required: true,
        description: "The request, as they sent it.",
      },
      { name: "control", type: "string", description: "The control in scope it is about." },
    ],
    async run(a: Parsed): Promise<number> {
      const { auditEntryCmd } = await import("../audit/commands.ts");
      return await auditEntryCmd("request", a);
    },
  },
  {
    name: "audit respond",
    output: "action",
    summary: "Record the company's response to a request in the trail (a signed commit)",
    description: `Spec 083. Adds the next numbered file to the trail with the response, answering request --re, in a commit signed with your daily key. Point to evidence by its SHA-256 or its portal page, never paste a secret. Terminal only.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The engagement.",
      },
      {
        name: "re",
        type: "string",
        required: true,
        description: "The request it answers (its number).",
      },
      { name: "text", type: "string", required: true, description: "The response." },
      { name: "control", type: "string", description: "The control in scope it is about." },
    ],
    async run(a: Parsed): Promise<number> {
      const { auditEntryCmd } = await import("../audit/commands.ts");
      return await auditEntryCmd("response", a);
    },
  },
  {
    name: "audit sample",
    output: "action",
    summary: "Draw a sample from a control's population with the auditor's seed, and record it",
    description: `Spec 083. Computes the control's population from the pinned bundle, draws --size units with the auditor's --seed (simple random sampling without replacement by SHA-256 sort keys: stolos-srswor-sha256/1, which the auditor can redraw with a shell), and records the sample, seed, method, and population hash in the trail, in a signed commit. The sample size is the auditor's choice. Terminal only.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The engagement.",
      },
      { name: "control", type: "string", required: true, description: "The control in scope." },
      {
        name: "seed",
        type: "string",
        required: true,
        description: "The auditor's seed (one line of text).",
      },
      {
        name: "size",
        type: "string",
        required: true,
        description: "How many units (the auditor's choice).",
      },
      {
        name: "note",
        type: "string",
        description: "A note for the trail (where the seed came from).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { auditSampleCmd } = await import("../audit/commands.ts");
      return await auditSampleCmd(a);
    },
  },
  {
    name: "audit close",
    output: "action",
    summary: "Close an audit engagement: its portal refuses every request from then on",
    description: `Spec 083. Records the day it was closed and by whom in engagement.ts, in a signed commit. The trail and the files stay in the repository as the audit's record. Terminal only.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The engagement.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { auditChangeCmd } = await import("../audit/commands.ts");
      return await auditChangeCmd("close", a);
    },
  },
  {
    name: "audit list",
    output: "report",
    aliases: ["audit"],
    summary: "The fleet's audit engagements: firm, period, open, expired, or closed",
    description: `Spec 083. Each engagement in fleets/<fleet>/audits/ as committed, with where it stands. Read-only; --json for scripts.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { auditListCmd } = await import("../audit/commands.ts");
      return await auditListCmd(ctx.json);
    },
  },
  {
    name: "audit show",
    output: "report",
    summary:
      "An engagement checked: its populations, samples, trail, and anything an auditor would find wrong",
    description: `Spec 083. Reads the engagement as committed, verifies its bundle (verifyBundle) and each commit that records it and its trail, computes each control's population, and redraws each sample from its seed. Exits 1 when anything does not check out. Read-only; --json for scripts.`,
    tier: "read",
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The engagement.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { auditShowCmd } = await import("../audit/commands.ts");
      return await auditShowCmd(a["id"] as string, ctx.json);
    },
  },
  {
    name: "audit portal",
    output: "report",
    summary:
      "Start the auditor portal and print its one-time link (this engagement only, time-boxed)",
    description: `Spec 083. Starts the Stolos Console on 127.0.0.1 and prints a link that works once, for two minutes, and opens a read-only session that sees only /audit/<id>/ and /v1/audit/<id>/, for at most four hours, refused once the engagement has expired or been closed. For an auditor elsewhere, send the export package instead (stolos audit export). Terminal only.`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The engagement.",
      },
      { name: "port", type: "string", description: "The port (default 8091)." },
      { name: "no-open", type: "boolean", description: "Print the link; open no browser." },
    ],
    async run(a: Parsed): Promise<number> {
      const lanPort = a["lan-port"] ? Number(a["lan-port"]) : undefined;
      if (lanPort !== undefined && !(Number.isInteger(lanPort) && lanPort > 0 && lanPort < 65536)) {
        throw new Error(`--lan-port ${a["lan-port"]}: a port from 1 to 65535`);
      }
      const { stolosConsole } = await import("../console/stolos-launch.ts");
      return await stolosConsole({
        audit: a["id"] as string,
        ...(a["port"] ? { port: Number(a["port"]) } : {}),
        open: !a["no-open"],
      });
    },
  },
  {
    name: "audit export",
    output: "report",
    summary: "An engagement as one package an auditor verifies offline",
    description: `Spec 083. Writes a ZIP with the evidence bundle, engagement.ts and every trail entry each with the raw signed commit that recorded it, the populations, the fleet's signers, the portal as one static page, and a README saying how to check it by hand. Nothing new is signed: everything in it is signed already or recomputes from the bundle. The package is not time-boxed: sending it is your decision. Terminal only.`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The engagement.",
      },
      {
        name: "out",
        type: "string",
        description: "The ZIP to write (default: this PC's state directory, audits/).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { auditExportCmd } = await import("../audit/commands.ts");
      return await auditExportCmd(a["id"] as string, a["out"] as string | undefined);
    },
  },
  {
    name: "audit verify",
    output: "report",
    summary: "Check an audit export package, offline: bundle, signed trail, populations, samples",
    description: `Spec 083. Verifies the package's evidence bundle (verifyBundle), that engagement.ts and every trail entry are the exact text a commit signed by an allowed signer vouches for, recomputes every population from the bundle and redraws every sample from its seed. Each problem is named; exits 1 on any. Without --signers it trusts the signers inside the package, and says so.`,
    tier: "read",
    args: [
      {
        name: "package",
        type: "string",
        positional: true,
        required: true,
        description: "The package (a ZIP).",
      },
      {
        name: "signers",
        type: "string",
        description: "An allowed_signers file you trust (the fleet's, from elsewhere).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { auditVerifyCmd } = await import("../audit/commands.ts");
      return await auditVerifyCmd(
        a["package"] as string,
        a["signers"] as string | undefined,
        ctx.json,
      );
    },
  },
  {
    name: "trust build",
    output: "report",
    summary: "A Trust Center: a status page for customers, built from a verified evidence bundle",
    description: `Spec 081. Verifies the bundle first (as evidence verify does) and refuses it, with each reason, when anything is wrong. Then writes a static, self-contained page (index.html: no requests, light and dark, phone width) from the bundle alone: the company, the period, the signer; each framework requirement's status through the SCF Council's mappings of the SCF release the bundle names (without that catalog on this PC, NIST SP 800-53 from the bundle's own findings); each SCF control's status, its checks, and its evidence age when signed (stale evidence fails, spec 073; a bundle older than 7 days makes every status stale); and each claim's backing item by SHA-256, with how to check it with evidence verify, sha256sum, and ssh-keygen. --public (the default) leaves out subjects, hostnames, people, what each check found, and item names, and publishes a summary bundle beside the page, signed by the full bundle's signer (--key; ssh-keygen asks the passphrase), or with --on-request no bundle at all. --gated shows everything and publishes the full bundle: host it only behind your own access (the trust guide). Terminal only.`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "bundle",
        type: "string",
        required: true,
        description: "The evidence bundle (a ZIP, spec 072).",
      },
      {
        name: "out",
        type: "string",
        description:
          "The folder to write (default: this PC's state directory, trust/public or trust/gated).",
      },
      {
        name: "frameworks",
        type: "string",
        description: "Only these frameworks, by id, comma-separated (soc2,hipaa).",
      },
      { name: "public", type: "boolean", description: "Redacted, for anyone (the default)." },
      {
        name: "gated",
        type: "boolean",
        description: "Everything in the bundle, for people behind your own access.",
      },
      {
        name: "on-request",
        type: "boolean",
        description: "Public: publish no bundle; the evidence is available on request.",
      },
      {
        name: "key",
        type: "string",
        description:
          "Public: the private key to sign the summary with (default: Git's signing key, your daily key).",
      },
      {
        name: "signers",
        type: "string",
        description: "An allowed_signers file you trust, to verify the bundle with.",
      },
      {
        name: "contact",
        type: "string",
        description: "Where to ask for the evidence (an https: or mailto: link).",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos trust build --bundle lab-evidence-2026-07-01-to-2026-09-30.zip --out trust",
        text: "A public Trust Center, with a signed summary bundle beside it.",
      },
      {
        cmd: "bun run stolos trust build --bundle lab-evidence-2026-07-01-to-2026-09-30.zip --gated --frameworks soc2,hipaa",
        text: "SOC 2 and HIPAA with every detail, to host behind Cloudflare Access.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { trustBuild } = await import("../trust/commands.ts");
      return await trustBuild({
        bundle: a["bundle"] as string,
        ...(a["out"] ? { out: a["out"] as string } : {}),
        ...(a["frameworks"] ? { frameworks: a["frameworks"] as string } : {}),
        ...(a["public"] ? { public: true } : {}),
        ...(a["gated"] ? { gated: true } : {}),
        ...(a["on-request"] ? { onRequest: true } : {}),
        ...(a["key"] ? { key: a["key"] as string } : {}),
        ...(a["signers"] ? { signers: a["signers"] as string } : {}),
        ...(a["contact"] ? { contact: a["contact"] as string } : {}),
      });
    },
  },
  {
    name: "compliance drift",
    output: "report",
    summary:
      "Which SCF controls changed status since a commit or a date; --notify mails the fleet's mailbox",
    description: `Spec 073. Compares each SCF control's status now (the working tree) with its status at a past commit of the fleet repository (--since: a commit, or the last commit before a date such as 2026-11-01 or "1 day ago"; default "1 day ago"), from the observations Git records (adopted machines, devices, connected accounts), each side held to the evidence cadences as of its own time, so evidence that went stale is drift too. Lists the controls whose status changed and the evidence under them. --notify mails a summary to the fleet's mailbox (fleet.mail.to) through the fleet's notify path: control ids, subjects, checks, and statuses only, never what a check found. Managed servers' verifies are in this PC's state, not in Git, so they are not compared. Run it on a schedule with this PC's own scheduler (the compliance guide shows how).`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "since",
        type: "string",
        description: 'A commit, or a date Git understands (default: "1 day ago").',
      },
      {
        name: "notify",
        type: "boolean",
        description: "Mail a summary of the changes to the fleet's mailbox (nothing when none).",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos compliance drift --since 2026-11-01 --notify",
        text: "What changed since the first of November, mailed to the fleet's mailbox.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { driftCommand } = await import("../compliance/drift.ts");
      return await driftCommand({
        ...(a["since"] ? { since: a["since"] as string } : {}),
        notify: !!a["notify"],
        json: ctx.json,
      });
    },
  },
  {
    name: "compliance impact",
    output: "report",
    summary:
      "The SCF controls a change weakens or strengthens, with their framework requirements; the gate's verdict",
    description: `Spec 074. Compares the fleet at --base (default: the fleet's branch on GitHub, origin/<branch>; the merge base with the head is used) with --head (a commit; default: the working tree). Model changes: each host's plan and the fleet's settings, against Stolos's declarations of which setting implements which SCF control and which direction weakens it (unattended upgrades: VPM-08; SSH passwords: IAC-14; the host firewall and its ports: NET-02; backups: BCD-24; osquery and the evidence cadences: MON-02; etckeeper: CHG-03; administrators and the agents' tier: IAC-30). Evidence changes: the observations in Git and the fleet's control packs, per control, as compliance drift reads them. Each affected control is listed with its SCF name and, when the SCF catalog is cached, the framework requirements the SCF Council maps it to. The gate (compliance.gate in fleet.ts, read from the base): with block "weakens", a weakening blocks unless gate.allow names it, an accepted risk covers it (policy "impact/<key>" in controls/accepted.ts), or a commit in the change signed by one of the base's signers carries "Compliance-Approved: <key>". Exits 1 when the gate blocks, 2 when the impact cannot be computed. --markdown prints the pull request comment (the fleet repository's compliance-impact workflow runs it); --json for scripts. Runs each side's fleet.ts and host.ts (as build does), read-only.`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "base",
        type: "string",
        description: "The base commit, branch, or tag (default: origin/<branch>, else HEAD).",
      },
      {
        name: "head",
        type: "string",
        description: "The head commit (default: the working tree).",
      },
      {
        name: "markdown",
        type: "boolean",
        description: "Print the pull request comment (Markdown).",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos compliance impact",
        text: "What your uncommitted change does to the fleet's controls, against GitHub's main.",
      },
      {
        cmd: "bun run stolos compliance impact --base main --head feature --markdown",
        text: "A branch's impact, as the pull request comment shows it.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { impactCommand } = await import("../compliance/impact.ts");
      return await impactCommand({
        ...(a["base"] ? { base: a["base"] as string } : {}),
        ...(a["head"] ? { head: a["head"] as string } : {}),
        json: ctx.json,
        markdown: !!a["markdown"],
      });
    },
  },
  {
    name: "compliance catalog",
    output: "action",
    summary: "Download the SCF Council's and NIST's catalogs (pinned, SHA-256 checked), once",
    description: `Spec 071. Downloads the Secure Controls Framework workbook from the SCF Council's repository and NIST's OSCAL catalogs (SP 800-53 Rev 5, SP 800-171 Rev 3) from NIST's, each at a pinned commit; refuses any whose SHA-256 differs; reads them here and keeps what Stolos needs in this PC's state directory. Stolos does not redistribute them. --update downloads them again.`,
    tier: "repo",
    noMcp: true,
    args: [{ name: "update", type: "boolean", description: "Download them again." }],
    async run(a: Parsed): Promise<number> {
      const { catalogCommand } = await import("../compliance/commands.ts");
      return await catalogCommand(!!a["update"]);
    },
  },
  {
    name: "compliance export",
    output: "report",
    summary: "The fleet's OSCAL documents: component definition, SSP, assessment results, POA&M",
    description: `Spec 071. Writes four OSCAL ${"1.2.3"} JSON documents to NIST SP 800-53 Rev 5, each control reached through the SCF Council's mappings: Stolos's component definition; a system security plan importing NIST's moderate baseline, with the fleet's machines as its inventory; assessment results (every observation, a finding per control); and a POA&M (each failing check open, each accepted risk a deviation approved). A machine, control, risk, or POA&M item keeps its UUID from one export to the next.`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "oscal",
        type: "boolean",
        description: "OSCAL JSON (the default, and for now the only format).",
      },
      {
        name: "out",
        type: "string",
        description:
          "The directory to write to (default: this PC's state directory, oscal/<fleet>).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { exportCommand } = await import("../compliance/commands.ts");
      return await exportCommand(a["out"] as string | undefined);
    },
  },
  {
    name: "compliance fedramp",
    output: "report",
    summary:
      "FedRAMP 20x: each Key Security Indicator for Class A or B, and its validation package (the Security Decision Record)",
    description: `Spec 076. Each FedRAMP 20x Key Security Indicator (KSI) the class asks for, from FedRAMP's Consolidated Rules (Class A: the seven of FRC-CLA-MFR; Class B: all of them), with the Stolos checks that give evidence for it and their results and observation times, or why Stolos cannot observe it (a person's process, a document, a contract). --out writes the Security Decision Record in FedRAMP's JSON format (SDR-CSX-KSI), with the cadences the rules set for the class (VDR-TFR-MVX, CPO-CSX-CPM). From what this PC already knows; nothing is asked of a server. Exits 1 when a KSI's checks fail.`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "class",
        type: "string",
        description: "A or B (default B).",
        choices: ["A", "B", "a", "b"],
      },
      {
        name: "out",
        type: "string",
        description: "Write the Security Decision Record (JSON) to this file.",
      },
      {
        name: "overview",
        type: "string",
        description:
          "Your Certification Package Overview's URI, which the record names (default: a placeholder).",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos compliance fedramp --class A --out sdr-class-a.json",
        text: "The Class A Security Decision Record, from the fleet's current evidence.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { fedrampCommand } = await import("../fedramp/commands.ts");
      return await fedrampCommand({
        ...(a["class"] ? { cls: a["class"] as string } : {}),
        ...(a["out"] ? { out: a["out"] as string } : {}),
        ...(a["overview"] ? { overview: a["overview"] as string } : {}),
        json: ctx.json,
      });
    },
  },
  {
    name: "export list",
    output: "report",
    summary: "The export jobs: kinds, tenants, where each delivers, its schedule, its last run",
    description: `Spec 092. Lists estate.exports from fleets/<fleet>/fleet.ts: each job's kinds and tenants, where it delivers (the fleet's OpenTelemetry collector when one is configured, else a file on this PC, and email when it has recipients), its schedule, and how its last run on this PC went.`,
    tier: "read",
    noMcp: true,
    args: [],
    async run(): Promise<number> {
      const { exportList } = await import("../export/delivery-commands.ts");
      return await exportList();
    },
  },
  {
    name: "export run",
    output: "action",
    summary: "Make one export job's documents and deliver them: collector, file, encrypted email",
    description: `Spec 092. Makes the job's documents (its kinds, for its tenants) and delivers them: to the fleet's OpenTelemetry collector over OTLP/HTTP when telemetry.collector is configured, otherwise (or when it does not answer) to a file in this PC's state directory (exports/<job>/<time>/); with recipients, the files are also emailed, send-only, one message per recipient encrypted with S/MIME to that recipient's certificate (no shared secret). Mail leaves through the fleet's relay with the fleet's send-only credential (stolos boot mail-setup), or the job's own (stolos export credential <name>), over TLS only. What happened is in exports/<job>/last-run.json, without secrets. The scheduled job (stolos export schedule) runs this.`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "job",
        type: "string",
        positional: true,
        required: true,
        description: "The job's id.",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos export run auditor",
        text: "Deliver the job named auditor now.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { exportRun } = await import("../export/delivery-commands.ts");
      return await exportRun(a["job"] as string);
    },
  },
  {
    name: "export schedule",
    output: "action",
    summary:
      "Run an export job by itself: this PC's own scheduler (Task Scheduler, launchd, systemd)",
    description: `Spec 092. Creates the operating system's own scheduled job on this PC, so the export runs without Stolos open: on Windows a Task Scheduler task (Stolos\\export-<fleet>-<job>, as you, no stored password), on macOS a LaunchAgent in ~/Library/LaunchAgents, on Linux a systemd user service and timer in ~/.config/systemd/user. It runs bun run stolos --fleet <fleet> export run <job> in this fleet checkout, at the job's schedule (estate.exports[].schedule). Nothing secret is written into it. --remove takes it away; --dry-run prints the files and commands and changes nothing.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "job",
        type: "string",
        positional: true,
        required: true,
        description: "The job's id.",
      },
      { name: "remove", type: "boolean", description: "Remove the scheduled job instead." },
      {
        name: "dry-run",
        type: "boolean",
        description: "Print what would be written and run; change nothing.",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos export schedule auditor",
        text: "Run the auditor job on its schedule.",
      },
      { cmd: "bun run stolos export schedule auditor --remove", text: "Stop it." },
    ],
    async run(a: Parsed): Promise<number> {
      const { exportSchedule } = await import("../export/delivery-commands.ts");
      return await exportSchedule(a["job"] as string, {
        remove: !!a["remove"],
        dryRun: !!a["dry-run"],
      });
    },
  },
  {
    name: "export credential",
    output: "action",
    summary: "Store a separate send-only mail credential for export jobs, on this PC only",
    description: `Spec 092. For a tenant that sends through its own account (email.credential in an export job). Reads the credential without echo (or one line on stdin), logs in to the job's relay over TLS without sending, and stores it in this PC's secrets folder (mail-<name>.json, this user only; the vault backs it up). Use a send-only credential: a Cloudflare API token with only Email Sending: Edit, or an SMTP account with reading (IMAP, POP, the mail API) turned off. Stolos only submits mail; it never reads a mailbox. Terminal only.`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        required: true,
        description: "The credential's name, as the job's email.credential gives it.",
      },
      {
        name: "user",
        type: "string",
        description: "The SMTP user name (default: api_token, Cloudflare's).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { exportCredential } = await import("../export/delivery-commands.ts");
      return await exportCredential(a["name"] as string, a["user"] as string | undefined);
    },
  },
  {
    name: "console",
    output: "report",
    summary: "The Stolos Console: the fleet in your browser, on this PC only",
    description: `Spec 066. Checks that your GitHub account (gh) may push to the fleet repository, listens on 127.0.0.1, and prints a one-time launch link (it works once, for two minutes) and opens it. Every machine (managed, adopted, in a cloud), the clouds, one SQL question to every machine, the changes waiting and who may approve them, and the stolos commands as forms. Commands run here, in the fleet repository: a passphrase or token they ask for is typed in this terminal, never in the browser. Ctrl+C stops it.`,
    tier: "read",
    noMcp: true,
    args: [
      { name: "port", type: "string", description: "The port on 127.0.0.1 (default 8091)." },
      { name: "no-open", type: "boolean", description: "Print the link; do not open a browser." },
      { name: "no-github", type: "boolean", description: "Skip the GitHub check (offline)." },
      {
        name: "lan",
        type: "boolean",
        description:
          "Spec 100: also serve HTTPS on this PC's LAN address as stolos.<web domain> and <pc>.stolos.<web domain> (a Let's Encrypt certificate, DNS in Cloudflare), for devices a fleet signer approved. TCP 443 only: there is no fallback port.",
      },
      {
        name: "lan-port",
        type: "string",
        description:
          "Spec 103: with --lan, an explicit port for the HTTPS listener instead of 443 (it is outside the three standard ports: this prints its own firewall rule).",
      },
    ],
    examples: [
      { cmd: "bun run stolos console", text: "Open the console in your browser." },
      {
        cmd: "bun run stolos console --lan",
        text: "Also open it to approved devices on the site's network, over HTTPS.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const port = a["port"] ? Number(a["port"]) : undefined;
      if (port !== undefined && !(Number.isInteger(port) && port > 1023 && port < 65536)) {
        throw new Error(`--port ${a["port"]}: a port from 1024 to 65535`);
      }
      const lanPort = a["lan-port"] ? Number(a["lan-port"]) : undefined;
      if (lanPort !== undefined && !(Number.isInteger(lanPort) && lanPort > 0 && lanPort < 65536)) {
        throw new Error(`--lan-port ${a["lan-port"]}: a port from 1 to 65535`);
      }
      const { stolosConsole } = await import("../console/stolos-launch.ts");
      return await stolosConsole({
        ...(port === undefined ? {} : { port }),
        open: !a["no-open"],
        github: !a["no-github"],
        lan: !!a["lan"],
        ...(lanPort === undefined ? {} : { lanPort }),
      });
    },
  },
  // Spec 100: the devices that may sign in to the Stolos Console.
  {
    name: "devices",
    output: "report",
    summary: "The devices that may sign in to the Stolos Console, and when each last did",
    description: `Spec 100. Lists fleets/<fleet>/access.ts: each device's id, signer, name, passkey (synced or bound to the device), when and from where it registered, who approved it, and its last sign-in on this PC. Read-only.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { devicesList } = await import("../access/commands.ts");
      return await devicesList(ctx.json);
    },
  },
  {
    name: "devices approve",
    output: "action",
    summary: "Approve a device's code: it may sign in to the Stolos Console (one signed commit)",
    description: `Spec 100. Asks the controller (--controller, default https://stolos.<web domain>) for the registration waiting under the code (public fields only), shows it, asks, writes the device into fleets/<fleet>/access.ts with you as its approver, and sends it with stolos apply (your key signs). The controller honours it once it reads that signed commit from GitHub. Refuses while other changes are uncommitted.`,
    tier: "repo",
    noMcp: true,
    operation: true,
    args: [
      {
        name: "code",
        type: "string",
        positional: true,
        required: true,
        description: "The code the device shows (WDJB-MJHT).",
      },
      {
        name: "controller",
        type: "string",
        description: "The controller's address (default https://stolos.<web domain>).",
      },
      {
        name: "yes",
        type: "boolean",
        description: "Approve without asking (the console's button).",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos devices approve WDJB-MJHT",
        text: "Approve the device showing this code.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { devicesApprove } = await import("../access/commands.ts");
      return await devicesApprove({
        code: a["code"] as string,
        ...(a["controller"] ? { controller: a["controller"] as string } : {}),
        yes: !!a["yes"],
      });
    },
  },
  {
    name: "devices revoke",
    output: "action",
    summary: "Revoke a device: it may no longer sign in to the Stolos Console (one signed commit)",
    description: `Spec 100. Removes the device from fleets/<fleet>/access.ts and sends it with stolos apply (your key signs). The controller refuses the device once it reads that commit.`,
    tier: "repo",
    noMcp: true,
    operation: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The device's id (bun run stolos devices).",
      },
      {
        name: "yes",
        type: "boolean",
        description: "Revoke without asking (the console's button).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { devicesRevoke } = await import("../access/commands.ts");
      return await devicesRevoke({ id: a["id"] as string, yes: !!a["yes"] });
    },
  },
  {
    name: "mesh",
    output: "report",
    summary: "Zero trust mesh networks: the choices, and this PC's mesh addresses (guidance only)",
    description: `Spec 098 (constitution Article 28). The fleet's plain-HTTP exchanges (PXE, HTTP Boot, stolos pair) run on the site's LAN, or on a zero trust mesh network for a device that is not on it. Prints what that means, the common choices (Tailscale, Headscale, NetBird, ZeroTier, Nebula, WireGuard by hand) without preferring one, what to look for, and this PC's mesh addresses with the pair --address line to use. Changes nothing; Stolos installs no network product.`,
    tier: "read",
    args: [],
    async run(): Promise<number> {
      const { meshAddresses, meshGuide } = await import("../adopt/mesh.ts");
      const { stdio } = await import("@intellectual-frontiers/commons/ts/runtime");
      stdio.stdout.writeSync(meshGuide(meshAddresses()));
      return 0;
    },
  },
  {
    name: "pair",
    output: "action",
    summary:
      "Bring machines into the fleet with a short code: one line to run on each, approve each here",
    description: `Specs 098, 103 and 107. Opens a pairing session: one short line per door that is up (curl ... | sh, or irm ... | iex on Windows as administrator), HTTPS first, and an 8-character code, the same for every machine. Many machines can pair, at the same time or one after another; each is shown here as it says hello, installs and waits, and you answer each one in turn, seeing its name, OS, address, SSH host key and osquery. Nothing is adopted without your yes. The session stays open until you stop it (Ctrl+C): it has no expiry, so an open session is less safe than a short one, and you should close it when the machines you expect have joined. Pairing is /device/pair on two of the three ports this PC opens (Article 29): TCP 443, the console's TLS, when stolos console --lan serves and its name is this PC's; and TCP 8080, plain HTTP, the boot server's (this command serves just those routes there when boot serve is not running). The machine's script, served by this PC from this engine, asks for the code, turns on SSH, installs the read-only probe, and sends its check-in signed with the code. Wrong codes are counted for each client address: after 5 that address is refused for the rest of the session. Plain HTTP on the boot server's port on purpose: run it on a trusted LAN, or reach the machine over a zero trust mesh network (see stolos mesh), never over the internet.`,
    tier: "repo",
    args: [
      {
        name: "name",
        type: "string",
        description:
          "The first machine's name in the fleet (the others, and the first without it, are named by their hostnames as DNS labels).",
      },
      {
        name: "address",
        type: "string",
        description:
          "The address the machine reaches this PC at (default: this PC's LAN address; give the mesh network's address for a machine elsewhere).",
      },
      {
        name: "port",
        type: "string",
        description:
          "Spec 103: an explicit port for the plain HTTP door instead of the boot server's TCP 8080 (it is outside the three standard ports: this prints its own firewall rule).",
      },
      {
        name: "title",
        type: "string",
        description: 'What the machines are, for people: "Alice\'s laptop".',
      },
      { name: "owner", type: "string", description: "Who the machines belong to." },
      {
        name: "tag",
        type: "string",
        repeatable: true,
        description:
          "Spec 108: a tag every machine paired in this session gets (a defined tag such as env:lab, or a free-form word); repeat it. You may change a machine's tags when you approve it.",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos pair",
        text: "Open a session and pair as many machines as come; each is named by its hostname.",
      },
      {
        cmd: "bun run stolos pair --name alice-laptop --owner alice",
        text: "Name it, and say whose it is.",
      },
      {
        cmd: "bun run stolos pair --tag env:lab --tag role:nas",
        text: "Every machine paired in this session gets these tags (you can change them for each one when you approve it).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { pair } = await import("../adopt/pair-command.ts");
      const port = a["port"] ? Number(a["port"]) : undefined;
      if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
        throw new Error(`--port ${a["port"]}: a port from 1 to 65535`);
      }
      return await pair({
        ...(a["name"] ? { name: a["name"] as string } : {}),
        ...(a["address"] ? { address: a["address"] as string } : {}),
        ...(port === undefined ? {} : { port }),
        ...(a["title"] ? { title: a["title"] as string } : {}),
        ...(a["owner"] ? { owner: a["owner"] as string } : {}),
        ...(a["tag"] ? { tag: a["tag"] as string } : {}),
      });
    },
  },
  {
    name: "discover",
    output: "report",
    summary:
      "Machines seen on this PC's network or in the fleet's clouds, not yet managed or adopted",
    description: `Spec 067. Reads this PC's neighbor table (machines it has talked to; nothing is scanned) and the cloud observations in Git (servers and instances no fleet machine owns), and lists what the fleet does not know, by MAC, address, or name. Records nothing. Adopt the ones you are responsible for with host adopt.`,
    tier: "read",
    args: [
      {
        name: "import",
        type: "string",
        description:
          "A check-in code (integrate --discover): record that machine in discovered.ts.",
      },
      {
        name: "name",
        type: "string",
        description: "With --import: its name in the fleet (default: from its hostname).",
      },
      { name: "owner", type: "string", description: "With --import: who it belongs to." },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { discover, discoverImport } = await import("../adopt/commands.ts");
      if (a["import"]) {
        return await discoverImport(
          a["import"] as string,
          a["name"] as string | undefined,
          a["owner"] as string | undefined,
        );
      }
      return await discover(ctx.json);
    },
  },
  {
    name: "connect",
    output: "action",
    summary: "Connect a cloud account read-only: Cloudflare, Microsoft 365 and Azure, AWS, Hetzner",
    description: `Spec 067. Shows how to make a read-only credential in the provider's console (Stolos never changes a cloud), asks for it in the terminal where Stolos runs (secrets are not echoed; from the Stolos Console, type it in the console's terminal), keeps it in this PC's vault (connectors/<provider>/credential.json), and takes a first observation. Providers: cloudflare, microsoft (Microsoft 365 and Azure), aws, hetzner.`,
    tier: "repo",
    args: [
      {
        name: "provider",
        type: "string",
        positional: true,
        required: true,
        description:
          "cloudflare, microsoft, google, okta, jumpcloud, intune, defender, jamf, kandji, crowdstrike, sentinelone, github, gitlab, bitbucket, bamboohr, rippling, gusto, deel, justworks, jira, linear, slack, onepassword, bitwarden, snyk, tenable, knowbe4, checkr, aws, gcp, digitalocean, hetzner, or a connector the fleet added (stolos connector list).",
        choices: [
          "cloudflare",
          "microsoft",
          "google",
          "okta",
          "jumpcloud",
          "intune",
          "defender",
          "jamf",
          "kandji",
          "crowdstrike",
          "sentinelone",
          "github",
          "gitlab",
          "bitbucket",
          "bamboohr",
          "rippling",
          "gusto",
          "deel",
          "justworks",
          "jira",
          "linear",
          "slack",
          "onepassword",
          "bitwarden",
          "snyk",
          "tenable",
          "knowbe4",
          "checkr",
          "aws",
          "gcp",
          "digitalocean",
          "hetzner",
          "unifi",
        ],
      },
    ],
    examples: [
      {
        cmd: "bun run stolos connect cloudflare",
        text: "A read-only Cloudflare API token.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { connectorConnect } = await import("../connect/commands.ts");
      return await connectorConnect(a["provider"] as string);
    },
  },
  {
    name: "connector add",
    output: "action",
    summary: "Add a connector from a pinned URL (a tag or a commit), checked, with a lock entry",
    description: `Spec 088. Adds a connector Stolos does not ship, the way the fleet takes the engine: <source>@<ref>, where the source is https://github.com/<owner>/<repo>[/<path>] (read from raw.githubusercontent.com; the path defaults to mod.ts) and the ref a version tag or a full commit SHA (a branch is refused). It loads the module in its own process with no network, files, or secrets (imports from its host only), and checks it: a connector made with defineConnector, an id no other connector has, labels that follow the naming rules (D3FEND, OCSF, UDM), only SCF ids Stolos knows, a read-only credential, an engine range this engine is in, and its own recorded-fixture tests, which must pass. Then it writes the import and Stolos's lock entry to fleets/<fleet>/connectors.ts and the hash of every file it loads to the fleet's lock. Approve it with bun run stolos apply (spec 060). --index <url> finds <id>@<tag> in an index anyone can host (bun run stolos docs connectors).`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "source",
        type: "string",
        positional: true,
        required: true,
        description: "<source>@<ref>, or <id>@<tag> with --index.",
      },
      { name: "index", type: "string", description: "A connector index's URL (JSON)." },
    ],
    examples: [
      {
        cmd: "bun run stolos connector add https://github.com/example/stolos-connector-example@v1.0.0",
        text: "Check a connector, run its fixtures, and pin it with a lock entry.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { connectorAdd } = await import("../connect/registry-commands.ts");
      return await connectorAdd(a["source"] as string, {
        ...(a["index"] ? { index: a["index"] as string } : {}),
      });
    },
  },
  {
    name: "connector list",
    output: "report",
    aliases: ["connectors"],
    summary:
      "The connectors this fleet added (fleets/<fleet>/connectors.ts), each pin and engine range",
    description: `Spec 088. Each added connector: its id, title, pinned tag or commit, the engine versions it supports (and whether this engine is one), and where it came from. --json for scripts.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { connectorList } = await import("../connect/registry-commands.ts");
      return await connectorList(ctx.json);
    },
  },
  {
    name: "connector remove",
    output: "action",
    summary:
      "Remove an added connector: its import and lock entry (its last observation stays in Git)",
    description: `Spec 088. Removes the connector's import and entry from fleets/<fleet>/connectors.ts. Its credential stays in the vault until stolos disconnect <id>; its last observation stays in Git. Approve it with bun run stolos apply (spec 060).`,
    tier: "repo",
    noMcp: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The added connector's id.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { connectorRemove } = await import("../connect/registry-commands.ts");
      return await connectorRemove(a["id"] as string);
    },
  },
  {
    name: "connector test",
    output: "report",
    summary: "Test added connectors at their pins, or a connector module you are writing",
    description: `Spec 088. For each added connector (or the one named): its module still hashes as the fleet's lock and connectors.ts say, it supports this engine, and its recorded-fixture tests pass, run in a restricted process. Given a path or URL instead, it checks a module not added yet, as connector add would (an author's own check before tagging a release). Exits 1 when any check fails.`,
    tier: "read",
    args: [
      {
        name: "target",
        type: "string",
        positional: true,
        description:
          "An added connector's id, or a module's path or URL (default: every added one).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { connectorTest } = await import("../connect/registry-commands.ts");
      return await connectorTest(a["target"] as string | undefined);
    },
  },
  {
    name: "estate observe",
    output: "action",
    summary: "Read every connected cloud account and record what it holds in Git",
    description: `Spec 067. Lists each connected account's assets (zones, DNS records, Workers, R2; users, licenses, Azure resources; IAM users, S3, EC2; Hetzner servers, volumes, firewalls) and posture facts into fleets/<fleet>/estate/<provider>.ts (GENERATED); assets named after a fleet machine are marked as its. Keep it with bun run stolos apply.`,
    tier: "repo",
    args: [
      {
        name: "provider",
        type: "string",
        positional: true,
        description: "One provider (default: every connected one).",
        choices: [
          "cloudflare",
          "microsoft",
          "google",
          "okta",
          "jumpcloud",
          "intune",
          "defender",
          "jamf",
          "kandji",
          "crowdstrike",
          "sentinelone",
          "github",
          "gitlab",
          "bitbucket",
          "bamboohr",
          "rippling",
          "gusto",
          "deel",
          "justworks",
          "jira",
          "linear",
          "slack",
          "onepassword",
          "bitwarden",
          "snyk",
          "tenable",
          "knowbe4",
          "checkr",
          "aws",
          "gcp",
          "digitalocean",
          "hetzner",
          "unifi",
        ],
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { estateObserve } = await import("../connect/commands.ts");
      return await estateObserve(a["provider"] as string | undefined);
    },
  },
  {
    name: "estate check",
    output: "report",
    summary: "The cloud accounts' posture policies: pass, fail, and the fix (SCF controls)",
    description: `Spec 067. From the last observations: Cloudflare TLS (Full strict, HTTPS only, TLS 1.2), DNSSEC; Microsoft MFA enforced and registered, Global Administrators; AWS root MFA and keys, S3 public access, IMDSv2; Hetzner backups, firewalls, deletion protection. Exits 1 when any fails; --json for auditors.`,
    tier: "read",
    args: [
      {
        name: "provider",
        type: "string",
        positional: true,
        description: "One provider (default: all).",
        choices: [
          "cloudflare",
          "microsoft",
          "google",
          "okta",
          "jumpcloud",
          "intune",
          "defender",
          "jamf",
          "kandji",
          "crowdstrike",
          "sentinelone",
          "github",
          "gitlab",
          "bitbucket",
          "bamboohr",
          "rippling",
          "gusto",
          "deel",
          "justworks",
          "jira",
          "linear",
          "slack",
          "onepassword",
          "bitwarden",
          "snyk",
          "tenable",
          "knowbe4",
          "checkr",
          "aws",
          "gcp",
          "digitalocean",
          "hetzner",
          "unifi",
        ],
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { estateCheck } = await import("../connect/commands.ts");
      return await estateCheck(a["provider"] as string | undefined, ctx.json);
    },
  },
  {
    name: "estate query",
    output: "report",
    summary: "One SQL question across every source: people, accounts, machines, repositories",
    description: `Spec 090. The estate graph, built from the observations in Git (no network): Universal Data Model tables (party, person, organization, party_role, party_relationship, contact_mechanism, party_contact_mechanism, fixed_asset, party_fixed_asset_assignment), a property graph (tenant, node, node_label, edge, node_property_provenance), findings and observations, and views with OCSF's and D3FEND's names (user_account, code_repository, user_inventory, device, compliance_finding). One SELECT. Booleans are 0 and 1. The full schema: bun run stolos estate schema --docs.`,
    tier: "read",
    args: [
      {
        name: "sql",
        type: "string",
        positional: true,
        required: true,
        description: "One SELECT.",
      },
    ],
    examples: [
      {
        cmd: 'bun run stolos estate query "select connector, display_name from user_account where admin = 1 and mfa = 0"',
        text: "Administrators without a second factor, in every system.",
      },
      {
        cmd: "bun run stolos estate query \"select u.email_addr, a.connector from user_inventory u join edge e on e.src_uid = u.uid and e.verb = 'has_account' join user_account a on a.user_account_uid = e.dst_uid where u.status = 'terminated' and a.active = 1\"",
        text: "People who left, with accounts still on.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { estateQueryCommand } = await import("../estate/commands.ts");
      return await estateQueryCommand(a["sql"] as string, ctx.json);
    },
  },
  {
    name: "estate build",
    output: "report",
    summary: "Write the estate graph as canonical SQL and as the SQLite file osquery reads",
    description: `Spec 090. Builds the estate graph from the observations in Git and writes, in this PC's state directory, estate.sql (the schema and every row: the canonical form, loadable into other databases), estate.auto.sqlite.db made from it (what osquery reads), and estate.osquery.json (spec 093: osquery's configuration that makes each table and view an osquery table, stolos_<name>).`,
    tier: "read",
    args: [],
    async run(): Promise<number> {
      const { estateBuild } = await import("../estate/commands.ts");
      return await estateBuild();
    },
  },
  {
    name: "estate osquery",
    output: "report",
    summary: "The estate graph as osquery tables: write or print osquery's configuration",
    description: `Spec 093. Writes estate.osquery.json next to estate.auto.sqlite.db: an osquery configuration (Automatic Table Construction, no extension) that makes every estate table and view an osquery table named stolos_<name> (stolos_device, stolos_user_account, stolos_person, ...) with exactly its declared columns, read from that SQLite file. Prints how to load it: osqueryi --config_path <file>, an existing osqueryd configuration, or a fleet manager. Every column is text in osquery. bun run stolos estate build writes it too, with fresh data.`,
    tier: "read",
    args: [
      {
        name: "print",
        type: "boolean",
        description: "Print the configuration (JSON) instead of writing it.",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos estate osquery",
        text: "Write the configuration; say how to load it.",
      },
      {
        cmd: "bun run stolos estate osquery --print",
        text: "The configuration, to merge into another one.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { estateOsquery } = await import("../estate/commands.ts");
      return await estateOsquery(!!a["print"]);
    },
  },
  {
    name: "estate diff",
    output: "report",
    summary: "What a query gains and loses between a date or commit and now",
    description: `Spec 090. Runs one SELECT on the estate graph as Git had it at --since (a date, YYYY-MM-DD, or a commit) and as it is now, and lists the rows added and removed: drift, and a Type 2 period's record.`,
    tier: "read",
    args: [
      { name: "sql", type: "string", positional: true, required: true, description: "One SELECT." },
      {
        name: "since",
        type: "string",
        required: true,
        description: "A date (YYYY-MM-DD) or a commit.",
      },
    ],
    examples: [
      {
        cmd: 'bun run stolos estate diff "select connector, display_name from user_account where admin = 1" --since 2026-10-01',
        text: "Administrators added and removed since October 1.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { estateDiff } = await import("../estate/commands.ts");
      return await estateDiff(a["sql"] as string, a["since"] as string, ctx.json);
    },
  },
  {
    name: "estate schema",
    output: "report",
    summary: "The estate graph's schema: its SQL, or its documentation",
    description: `Spec 090. Prints the estate graph's schema as SQL (generated from its TypeScript declarations), or with --docs as documentation with an ER diagram: every table and view, what each column holds, and the standard each name comes from.`,
    tier: "read",
    args: [{ name: "docs", type: "boolean", description: "The documentation, not the SQL." }],
    async run(a: Parsed): Promise<number> {
      const { estateSchema } = await import("../estate/commands.ts");
      return estateSchema(!!a["docs"]);
    },
  },
  {
    name: "estate assets",
    output: "report",
    summary: "Everything in the fleet's cloud accounts, as one table",
    description: `Spec 067. From the last observations in Git (no network): provider, kind, name, where, the fleet machine it belongs to, and a few facts. --kind narrows it (zone, dns-record, worker, r2-bucket, user, license, azure-resource, s3-bucket, ec2-instance, server, ...); --json for scripts.`,
    tier: "read",
    args: [
      {
        name: "provider",
        type: "string",
        positional: true,
        description: "One provider (default: all).",
        choices: [
          "cloudflare",
          "microsoft",
          "google",
          "okta",
          "jumpcloud",
          "intune",
          "defender",
          "jamf",
          "kandji",
          "crowdstrike",
          "sentinelone",
          "github",
          "gitlab",
          "bitbucket",
          "bamboohr",
          "rippling",
          "gusto",
          "deel",
          "justworks",
          "jira",
          "linear",
          "slack",
          "onepassword",
          "bitwarden",
          "snyk",
          "tenable",
          "knowbe4",
          "checkr",
          "aws",
          "gcp",
          "digitalocean",
          "hetzner",
          "unifi",
        ],
      },
      { name: "kind", type: "string", description: "Only this kind of asset." },
    ],
    examples: [
      {
        cmd: "bun run stolos estate assets --kind dns-record",
        text: "Every DNS record, with the machine it points at.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { estateAssets } = await import("../connect/commands.ts");
      return await estateAssets(
        a["provider"] as string | undefined,
        a["kind"] as string | undefined,
        ctx.json,
      );
    },
  },
  {
    name: "disconnect",
    output: "action",
    summary: "Forget a cloud account's credential (the last observation stays in Git)",
    description: `Spec 067. Removes connectors/<provider>/credential.json from this PC's vault. Revoke the credential in the provider's console too.`,
    tier: "repo",
    args: [
      {
        name: "provider",
        type: "string",
        positional: true,
        required: true,
        description:
          "cloudflare, microsoft, google, okta, jumpcloud, intune, defender, jamf, kandji, crowdstrike, sentinelone, github, gitlab, bitbucket, bamboohr, rippling, gusto, deel, justworks, jira, linear, slack, onepassword, bitwarden, snyk, tenable, knowbe4, checkr, aws, gcp, digitalocean, hetzner, or a connector the fleet added (stolos connector list).",
        choices: [
          "cloudflare",
          "microsoft",
          "google",
          "okta",
          "jumpcloud",
          "intune",
          "defender",
          "jamf",
          "kandji",
          "crowdstrike",
          "sentinelone",
          "github",
          "gitlab",
          "bitbucket",
          "bamboohr",
          "rippling",
          "gusto",
          "deel",
          "justworks",
          "jira",
          "linear",
          "slack",
          "onepassword",
          "bitwarden",
          "snyk",
          "tenable",
          "knowbe4",
          "checkr",
          "aws",
          "gcp",
          "digitalocean",
          "hetzner",
          "unifi",
        ],
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { connectorDisconnect } = await import("../connect/commands.ts");
      return await connectorDisconnect(a["provider"] as string);
    },
  },
  {
    name: "workstation add",
    output: "action",
    summary:
      "Set up this Ubuntu on WSL (or desktop) as a workstation: tools, dotfiles, the agent layer",
    description: `Run inside Ubuntu on WSL (or on an Ubuntu desktop), from the checkout in /srv/archon, as your own user. Writes fleets/<fleet>/hosts/<name>/host.ts as a workstation (spec 020) and converges, through sudo, only the user-level parts: the tools at their newest releases, the dotfiles (fish, oh-my-posh, tmux, git), Claude Code (the agent layer, spec 030), the archon command, and Ubuntu's daily updates. It checks first that this is the fleet's Ubuntu release, that systemd runs, and where the checkout is.`,
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
    examples: [{ cmd: "bun run stolos workstation add", text: "Set up this WSL Ubuntu." }],
    async run(a: Parsed): Promise<number> {
      const { workstationAdd } = await import("../install/workstation.ts");
      return await workstationAdd({
        ...(typeof a["name"] === "string" ? { name: a["name"] } : {}),
        ...(typeof a["user"] === "string" ? { user: a["user"] } : {}),
        force: !!a["force"],
      });
    },
  },
  {
    name: "apply",
    output: "action",
    summary: "Converge this host to its plan",
    description: `Installs missing packages (apt or snap), converges accounts, writes files, and enables units, then runs queued actions. Idempotent (Article 11). With --check, shows what would change.`,
    tier: "mutate",
    readOnlyWith: "check",
    operation: true,
    args: [
      {
        name: "check",
        type: "boolean",
        description: "Show what would change; change nothing.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { apply } = await import("../apply/apply.ts");
      const r = await apply(await requireHost(ctx.hostName), { check: !!a["check"] });
      return r.failed ? 1 : 0;
    },
  },
  {
    name: "verify",
    output: "report",
    summary: "Run every verification command in this host's plan",
    description: `Checks every package, unit, and tool the plan declares (Article 15) and reports each failure with its command.`,
    tier: "read",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { failedChecks, verify } = await import("../state/verify.ts");
      const checks = await verify(await requireHost(ctx.hostName));
      // A warning check reports, but never counts as a failure (CheckDef).
      return failedChecks(checks).length ? 1 : 0;
    },
  },
  {
    name: "web status",
    output: "report",
    summary: "This server's HTTPS: Traefik, the certificate, DNS, and every route",
    description: `Shows whether Traefik and the welcome page run, which certificate answers on 443 (Let's Encrypt, or Traefik's self-signed one until it arrives), whether <host>.<domain> resolves to this server, and every route: the welcome page at https://<host>.<domain>, Traefik's dashboard at traefik.<host>.<domain>, each route from the model and its capabilities (cockpit.<host>.<domain>), and each guest that publishes a port. Containers (Podman) publish themselves with the label traefik.enable=true. Who reaches anything behind the proxy is the router's decision (spec 064). See the web guide (bun run stolos docs web).`,
    tier: "read",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { webStatus } = await import("../web/commands.ts");
      return await webStatus(ctx.hostName);
    },
  },
  {
    name: "web dns",
    output: "action",
    summary: "Keep <host>.<domain> and *.<host>.<domain> in Cloudflare, to this server",
    description: `Creates or corrects this server's two A records in Cloudflare (its name and its wildcard, not proxied, TTL 60) to the address it reaches the network from now (the source of its default route: no reserved IPs needed), with the token the boot machine delivered (Zone: Read and DNS: Edit on the zone). Runs after an install and when a token arrives; archon web dns-check runs it whenever the address changes. Without fleet.web it does nothing (spec 032).`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { webDns } = await import("../web/commands.ts");
      return await webDns(ctx.hostName);
    },
  },
  {
    name: "web dns-check",
    output: "action",
    summary: "Update Cloudflare if this server's address changed (the timer, every 5 minutes)",
    description: `Run by archon-web-dns.timer at boot and every 5 minutes: compares the address this server reaches the network from (its default route's source) with the one last published, and runs archon web dns only when it changed (a new DHCP lease) or a day has passed, so the records follow the server without reserved IPs. A change is journaled (archon-web) and the mailbox is told. Quiet otherwise: no run log (spec 032).`,
    tier: "mutate",
    unlocked: true,
    noMcp: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { webDnsCheck } = await import("../web/commands.ts");
      return await webDnsCheck(ctx.hostName);
    },
  },
  {
    name: "web credential",
    output: "action",
    summary: "Install the Cloudflare DNS token from stdin (bun run stolos boot web-push)",
    description: `Reads the web credential (JSON with a Cloudflare API token that has Zone: Read and DNS: Edit on the fleet's zone) on stdin and stores it root-only for archon web dns (/etc/archon/web/cloudflare.json) and for Traefik's DNS challenge (/etc/archon/web/cloudflare.env), restarts Traefik, then publishes this server's DNS records (spec 032). The boot machine sends it with bun run stolos boot web-push <host>; installs deliver it by themselves.`,
    tier: "mutate",
    operation: true,
    noMcp: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { webCredential } = await import("../web/commands.ts");
      return await webCredential(ctx.hostName);
    },
  },
  {
    name: "web acme-export",
    output: "report",
    summary: "Print Traefik's Let's Encrypt store as JSON (for boot reinstall)",
    description: `Prints this server's Traefik ACME store (the Let's Encrypt account, certificates, and keys) with each certificate's names and expiry, as JSON on stdout. bun run stolos boot reinstall runs it before rebooting the server and keeps the result on the boot machine; the install hands it back, so the new install serves the same trusted certificate from its first minute and does not ask Let's Encrypt again (spec 032). Root only; never offered over MCP.`,
    tier: "read",
    asOwner: true,
    noMcp: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { exportAcme } = await import("../web/acme.ts");
      return await exportAcme(ctx.hostName);
    },
  },
  {
    name: "web serve",
    output: "report",
    summary: "Serve this server's welcome page on loopback (the archon-web service)",
    description: `Serves the welcome page on http://127.0.0.1:8090, behind Traefik, which publishes it at https://<host>.<domain> and at any name or address no route claims: this server's health (last archon run, install record, certificate), its services with links, ports that listen but are not published (with the model line that would publish one), and how to work on it. Read-only; rendered per request (spec 032).`,
    tier: "read",
    unlocked: true,
    noMcp: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { webServe } = await import("../web/serve.ts");
      return await webServe(ctx.hostName);
    },
  },
  {
    name: "console exec",
    output: "action",
    summary: "Run a command for the Archon Console's signed-in person (the console's account only)",
    description: `Used by the Archon Console (spec 065), never by people: runs one archon command for the person signed in to the console, as a transient systemd service outside the console's sandbox, with SUDO_USER set to that person so every record names them. Accepts only the console's own account (archon-console, through sudo), and checks again that the person may run the command (their groups and the command's tier). After a command that changes the server, mails the fleet's mailbox.`,
    tier: "mutate",
    noMcp: true,
    args: [
      {
        name: "as",
        type: "string",
        required: true,
        description: "The person signed in to the console.",
      },
      {
        name: "argv",
        type: "string",
        required: true,
        description:
          'The command and its arguments, as a JSON list of strings (["pg","on","--durable"]).',
      },
    ],
    async run(a: Parsed): Promise<number> {
      let argv: unknown;
      try {
        argv = JSON.parse(a["argv"] as string);
      } catch {
        argv = undefined;
      }
      if (!Array.isArray(argv) || !argv.every((x) => typeof x === "string")) {
        stdio.stderr.writeSync("archon console exec: --argv must be a JSON list of strings\n");
        return 2;
      }
      const { consoleExec } = await import("../console/exec.ts");
      return await consoleExec(a["as"] as string, argv);
    },
  },
  {
    name: "docs",
    output: "report",
    summary: "The engine's guides, offline and at this version: list them, or read one",
    description: `Each guide is the documentation of the module beside the code it explains (bun run docs renders them, with diagrams, on GitHub Pages). Without a name: every guide, with its page online. With one: the guide, in the terminal (its diagrams are drawn online). For example: docs fleet-repository, docs disaster-recovery, docs adopted.`,
    tier: "read",
    unlocked: true,
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        description: "A guide (default: list them).",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos docs disaster-recovery",
        text: "What to do when the boot machine is lost.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { docsCommand } = await import("../guide/docs-command.ts");
      return docsCommand(a["name"] as string | undefined, ctx.json);
    },
  },
  {
    name: "guide",
    output: "report",
    summary: "What's on this machine and how to use it, in plain words",
    description: `Lists, for newcomers, what is installed on this machine and how to use each part: your shell and dotfiles, web apps and containers, watching the server, what happens by itself (updates, firewall, backups, the history of /etc), email, and how changes are made through the repository. It starts with how to manage the server with an AI agent (Claude Code, Codex, or any MCP client) and keep the fleet up to date through Git. The same text is on the welcome page (https://<host>.<domain>), computed from this machine's own model (spec 035). See archon-guide(7) for the narrative guide.`,
    tier: "read",
    unlocked: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { guide } = await import("../guide/command.ts");
      return await guide(ctx.hostName);
    },
  },
  {
    name: "fs smb on",
    output: "action",
    summary: "Turn on SMB file sharing (Windows, macOS, Linux) on this server",
    description: `Starts Samba on this server and records the decision in the host's own archon.sql (opt-in smb) (who, when), so every apply and reboot keeps it on until an operator runs archon fs smb off. Clients connect to smb.<host>.<domain> (who reaches it is the router's decision) (for example \\\\smb.alpha.lab.example.net\\shared): one share, shared, for everyone with an account, and each account's own home folder. --durable or --ephemeral is required (Article 23, spec 044): durable shares are archived nightly and guarded; ephemeral ones are not. SMB3 only, encryption when the client supports it, no guests. People sign in with their own Linux username and password: Samba keeps a copy, updated by PAM whenever the password is typed on the server (Cockpit, sudo, a password login, passwd); an account not on this server gets no access. The mailbox is told. The switch is in this machine's own archon.sql (spec 048).`,
    tier: "mutate",
    operation: true,
    args: [...CHOICE_ARGS, CONFIRM_DESTROY_ARG("the host's name")],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { smbOn } = await import("../smb/commands.ts");
      return await smbOn(ctx.hostName, chooseData(a, "the SMB shares"), a["confirm-destroy"]);
    },
  },
  {
    name: "fs smb off",
    output: "action",
    summary: "Turn off SMB file sharing on this server",
    description: `Stops and masks Samba and records the decision in the host's own archon.sql (opt-in smb), so it stays off across applies, reboots, and reinstalls until an operator runs archon fs smb on. Shared files and SMB passwords are kept (spec 037).`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { smbOff } = await import("../smb/commands.ts");
      return await smbOff(ctx.hostName);
    },
  },
  {
    name: "fs smb status",
    output: "report",
    summary: "Whether SMB file sharing is on, its shares, and how to connect",
    description: `Shows whether SMB is on (since when, and who turned it on), whether smbd runs and port 445 listens, the shares and who may use them, which accounts Samba already knows the password of (as root), and how to connect from Windows, macOS, and Linux (spec 037).`,
    tier: "read",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { smbStatus } = await import("../smb/commands.ts");
      return await smbStatus(ctx.hostName);
    },
  },
  {
    name: "pg list",
    output: "report",
    summary: "List this server's PostgreSQL instances",
    description: `Every PostgreSQL instance Archon keeps on this server (from the model and the host's record, the host's own archon.sql (opt-in pg)): name, version, port, status, environment, and whether it is published. Clusters Archon did not create are listed as not Archon's and left alone. --json prints {host, instances, notArchons} (spec 038). See archon-pg(7).`,
    tier: "read",
    unlocked: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgList(ctx.hostName, ctx.json);
    },
  },
  {
    name: "pg status",
    output: "report",
    summary: "One PostgreSQL instance: version, port, status, published",
    description: `Shows one instance (default prime): its version, port, postgresql-common unit, data directory, status, whether it accepts connections, environment, protected or not, and where it is published. Exits non-zero when it is not online. (spec 038). See archon-pg(7).`,
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
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgStatus(ctx.hostName, a["name"] as string, ctx.json);
    },
  },
  {
    name: "pg ensure",
    output: "action",
    summary: "Create a PostgreSQL instance, or make sure it is right (idempotent)",
    description: `Makes the instance exist and match the model: the cluster <version>/<name> (pg_createcluster, its own port from 5432 up, its own data directory, unit, and log), Archon's configuration (conf.d/50-archon.conf: localhost only, scram-sha-256, TLS 1.3), pg_hba.conf (peer on the socket, scram-sha-256 on loopback), its roles and their passwords, and their databases. An instance not in the model is recorded in the host's own archon.sql (opt-in pg), and every apply keeps it from then on. An instance that exists, is Archon's, and is online needs nothing, so ensure then answers without sudo: an app's service account runs it unattended. Never touches a cluster Archon did not create. --json prints {ok, name, version, port, status, unit, created, changes}; a failure exits non-zero with one sentence. (spec 038). See archon-pg(7).`,
    tier: "mutate",
    precheck: async (a, ctx) =>
      (await import("../pg/commands.ts")).pgEnsureReady(
        ctx.hostName,
        a["name"] as string,
        a["version"] as string | undefined,
        ctx.json,
      ),
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
      {
        name: "version",
        type: "string",
        description: "Major version for a new instance (default 18, Ubuntu's; others from PGDG).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgEnsure(
        ctx.hostName,
        a["name"] as string,
        a["version"] as string | undefined,
        ctx.json,
      );
    },
  },
  {
    name: "pg start",
    output: "action",
    summary: "Start a PostgreSQL instance",
    description: `pg_ctlcluster <version> <name> start, for an instance Archon created. (spec 038). See archon-pg(7).`,
    tier: "mutate",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgControl(ctx.hostName, a["name"] as string, "start");
    },
  },
  {
    name: "pg stop",
    output: "action",
    summary: "Stop a PostgreSQL instance",
    description: `pg_ctlcluster <version> <name> stop, for an instance Archon created. A stopped instance is started again by the next apply (the model says it runs). (spec 038). See archon-pg(7).`,
    tier: "mutate",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgControl(ctx.hostName, a["name"] as string, "stop");
    },
  },
  {
    name: "pg restart",
    output: "action",
    summary: "Restart a PostgreSQL instance",
    description: `pg_ctlcluster <version> <name> restart, for an instance Archon created. (spec 038). See archon-pg(7).`,
    tier: "mutate",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgControl(ctx.hostName, a["name"] as string, "restart");
    },
  },
  {
    name: "pg reload",
    output: "action",
    summary: "Reload the configuration of a PostgreSQL instance",
    description: `pg_ctlcluster <version> <name> reload, for an instance Archon created. (spec 038). See archon-pg(7).`,
    tier: "mutate",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgControl(ctx.hostName, a["name"] as string, "reload");
    },
  },
  {
    name: "pg upgrade",
    output: "action",
    summary: "Upgrade a PostgreSQL instance to a newer major version",
    description: `Dumps the instance first (never in place without a backup), installs the new version, and runs pg_upgradecluster; the old cluster is kept, stopped, until archon pg remove NAME --version OLD. Destructive: runs only when specs/038-pg/spec.md has the owner's approve: destructive line and --confirm-destroy repeats the name. Never served over MCP. (spec 038). See archon-pg(7).`,
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
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgUpgrade(
        ctx.hostName,
        a["name"] as string,
        a["to"] as string | undefined,
        a["confirm-destroy"] as string | undefined,
      );
    },
  },
  {
    name: "pg remove",
    output: "action",
    summary: "Remove a PostgreSQL instance (dumped first)",
    description: `Dumps the instance, drops its cluster (pg_dropcluster), and forgets its record and passwords; with --version, removes only an older cluster kept after an upgrade. An instance in the model must leave the model first. Destructive: runs only when specs/038-pg/spec.md has the owner's approve: destructive line and --confirm-destroy repeats the name. Never served over MCP. (spec 038). See archon-pg(7).`,
    tier: "destructive",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
      {
        name: "version",
        type: "string",
        description: "Remove only this older version, kept after an upgrade.",
      },
      {
        name: "confirm-destroy",
        type: "string",
        human: true,
        description:
          "The instance's name again (destructive operations; typed by a person, Article 23).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgRemove(
        ctx.hostName,
        a["name"] as string,
        a["version"] as string | undefined,
        a["confirm-destroy"] as string | undefined,
      );
    },
  },
  {
    name: "pg backup",
    output: "action",
    summary: "Dump a PostgreSQL instance now",
    description: `pg_dumpall, compressed with zstd, into /var/backups/archon/pg/<name>/ (root only), keeping the last 7; spec 016's nightly archive carries them, and a timer dumps every instance nightly before it (archon pg backup --all). (spec 038). See archon-pg(7).`,
    tier: "mutate",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
      { name: "all", type: "boolean", description: "Every instance Archon created." },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgBackup(ctx.hostName, a["name"] as string, !!a["all"], ctx.json);
    },
  },
  {
    name: "pg restore",
    output: "action",
    summary: "Restore a PostgreSQL instance from a dump",
    description: `Loads a dump (the newest in /var/backups/archon/pg/<name>/, or --from FILE) into the instance, after dumping what is there now, then sets Archon's passwords again. Destructive: runs only when specs/038-pg/spec.md has the owner's approve: destructive line and --confirm-destroy repeats the name. Never served over MCP. (spec 038). See archon-pg(7).`,
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
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgRestore(
        ctx.hostName,
        a["name"] as string,
        a["from"] as string | undefined,
        a["confirm-destroy"] as string | undefined,
      );
    },
  },
  {
    name: "pg maintain",
    output: "report",
    summary: "VACUUM ANALYZE an instance, and report connections, sizes, and bloat",
    description: `Runs VACUUM ANALYZE on every database (online; nothing is locked or rewritten) and reports connections by database and state against max_connections, database sizes, and the tables with the most dead rows. Read tier: it changes no data or configuration. Runs as root. (spec 038). See archon-pg(7).`,
    tier: "read",
    asOwner: true,
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgMaintain(ctx.hostName, a["name"] as string, ctx.json);
    },
  },
  {
    name: "pg publish",
    output: "action",
    summary: "Make a PostgreSQL instance reachable over TLS (the router decides from where)",
    description: `Records the decision in the host's own archon.sql (opt-in pg) and applies it: PostgreSQL also listens on the server's address, pg_hba.conf admits TLS with scram-sha-256 (hostssl; postgres refused over any network), the firewall opens the instance's port, and PostgreSQL serves the server's wildcard certificate, so clients use pg-<name>.<host>.<domain> with sslmode=verify-full sslrootcert=system (archon pg show NAME --form external prints it all). Every address may connect: the router decides what reaches the server (the machine restricts no network). PostgreSQL speaks TLS itself; Traefik is not involved. Undo with archon pg unpublish (spec 038).`,
    tier: "mutate",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgPublish(ctx.hostName, a["name"] as string, true);
    },
  },
  {
    name: "pg unpublish",
    output: "action",
    summary: "Make a PostgreSQL instance private again",
    description: `Records the decision and applies it: localhost only, the hostssl lines and the firewall rule removed. (spec 038). See archon-pg(7).`,
    tier: "mutate",
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance (default prime).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgPublish(ctx.hostName, a["name"] as string, false);
    },
  },
  {
    name: "pg connect",
    output: "report",
    summary: "Print, or write, your libpq service for an instance (no password on the server)",
    description: `Prints the libpq service block for ~/.pg_service.conf; with --write, writes it there (0600, replacing only that service). On the server you connect as your own role over the socket (peer): your Linux account is your PostgreSQL identity, and no password is involved. With --remote, the service uses the published name with TLS (sslmode=verify-full sslrootcert=system): a person types their Linux password (libpq asks; PAM keeps PostgreSQL's copy in step), and a service account also gets its generated password in its own ~/.pgpass. Services: everyone already has the instances in the system-wide service file, so psql service=<name> works without this. --json prints {ok, service, host, port, user, database, sslmode, published?, files?}; a failure exits non-zero with one sentence (specs 038, 039). See archon-pg(7).`,
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
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgConnect(
        ctx.hostName,
        a["name"] as string,
        !!a["write"],
        !!a["remote"],
        ctx.json,
      );
    },
  },
  {
    name: "pg admin-tui",
    output: "report",
    summary: "Browse, query, and edit an instance in rainfrog, already connected",
    description: `Starts rainfrog (a terminal UI for PostgreSQL: tables, a query editor, results) connected to NAME (default prime). NAME is found the way archon pg show finds it: an instance Archon keeps, any cluster on this host, or a section of your service files. On this server it connects through the socket as you (peer, no password); with --remote, to the published name over TLS with sslmode=verify-full against the system's trusted roots. A password never goes on rainfrog's command line (other accounts see those): it asks for one when it needs it. Needs a terminal; not an MCP tool (spec 043). See archon-pg(7).`,
    tier: "read",
    unlocked: true,
    // Full screen and interactive: nothing for an agent to read.
    noMcp: true,
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance, cluster, or service section (default prime).",
      },
      {
        name: "remote",
        type: "boolean",
        description:
          "Connect to the published name over TLS (verify-full), as from another machine.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { pgTui } = await import("../pg/tui.ts");
      return await pgTui(ctx.hostName, "rainfrog", a["name"] as string, !!a["remote"]);
    },
  },
  {
    name: "pg observe-tui",
    output: "report",
    summary: "Watch an instance live in pgcenter top, already connected",
    description: `Starts pgcenter top (live activity, statements, waits, tables, and the server's CPU, memory, and disks) connected to NAME (default prime). NAME is found the way archon pg show finds it: an instance Archon keeps, any cluster on this host, or a section of your service files. On this server it connects through the socket as you (peer, no password); with --remote, to the published name over TLS with sslmode=verify-full against the system's trusted roots. Over the network, the password comes from your ~/.pgpass when it has a line for the instance, else it is asked here and handed to pgcenter in its own environment only (never its command line, a file, or a log). pgcenter needs pg_monitor for every view, which people are given (spec 039). Needs a terminal; not an MCP tool (spec 043). See archon-pg(7).`,
    tier: "read",
    unlocked: true,
    // Full screen and interactive: nothing for an agent to read.
    noMcp: true,
    args: [
      {
        name: "name",
        type: "string",
        positional: true,
        default: "prime",
        description: "The instance, cluster, or service section (default prime).",
      },
      {
        name: "remote",
        type: "boolean",
        description:
          "Connect to the published name over TLS (verify-full), as from another machine.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { pgTui } = await import("../pg/tui.ts");
      return await pgTui(ctx.hostName, "pgcenter", a["name"] as string, !!a["remote"]);
    },
  },
  {
    name: "data",
    output: "report",
    summary: "Whether this server is durable or ephemeral, and why",
    description: `Article 23 (spec 044): every source of end users' data (PostgreSQL, S3, SMB shares, LXD guests) is either durable (it exists nowhere else) or ephemeral (losing it is harmless), chosen by the operator when it is turned on; there is no default. A server is durable when anything on it is durable, and ephemeral otherwise. Lists each source and its choice, says what the class means (a durable server is archived nightly and nothing reinstalls or wipes it without --confirm-destroy), and exits non-zero when a source has no recorded choice (it counts as durable). Home directories are ephemeral by rule. The boot machine asks this before a reinstall.`,
    tier: "read",
    operation: true,
    unlocked: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { dataShow } = await import("../optin/data.ts");
      return await dataShow(ctx.hostName, ctx.json);
    },
  },
  {
    name: "data set",
    output: "action",
    summary: "Record an opt-in's data as durable or ephemeral",
    description: `Changes the choice made when the opt-in was turned on (pg, s3, or smb; a guest's is in the model). Ephemeral to durable needs nothing; durable to ephemeral removes the protection, so it needs --confirm-destroy with the host's name, typed by a person (never over MCP). Recorded in an opt-in record in this machine's own archon.sql; the mailbox is told (spec 044).`,
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
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { dataSet } = await import("../optin/data.ts");
      return await dataSet(
        ctx.hostName,
        a["name"] as string,
        chooseData(a, a["name"] as string),
        a["confirm-destroy"],
      );
    },
  },
  {
    name: "opt-in",
    output: "report",
    summary: "This server's opt-in services and containers: on or off, since when, by whom",
    description: `Opt-in services and containers (spec 040) are on every server and off until an operator turns one on; then they stay on, across applies and reboots, until an operator turns them off. Each decision is the host's record, an opt-in record in this machine's own archon.sql. Lists each one: SMB file sharing (archon fs smb), PostgreSQL (archon pg), and S3 object storage (archon fs s3), whether it is on, since when, who turned it on, and the command that turns it on or shows it. Where an opt-in can use Linux accounts and their credentials, it does.`,
    tier: "read",
    unlocked: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { optInList } = await import("../optin/optin.ts");
      return await optInList(ctx.hostName, ctx.json);
    },
  },
  {
    name: "pg connections",
    output: "report",
    summary: "Your PostgreSQL password file and service files, as libpq reads them (no passwords)",
    description: `Lists every entry of your PostgreSQL password file (~/.pgpass, or PGPASSFILE) and every section of your service files (~/.pg_service.conf, or PGSERVICEFILE, then the system's /etc/postgresql-common/pg_service.conf), matched the way libpq matches them. For each password-file entry: host, port, database, and user, which services it serves, and whether libpq can use it. Problems are named with their reason: an entry without five fields, an entry no service uses, a password file that group or others can access (libpq then ignores the whole file), a service section that holds a password, and a network service without sslmode=verify-full. A password is never printed, logged, or returned, in text, JSON, an MCP result, or an error. Read-only; it works for entries Archon did not make (spec 043).`,
    tier: "read",
    unlocked: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { pgConnections } = await import("../pg/connections.ts");
      return await pgConnections(ctx.json);
    },
  },
  {
    name: "pg show",
    output: "report",
    summary:
      "How to reach an instance: conninfo, URL, PG* environment, a service section, or everything for an external client",
    description: `Prints how to reach NAME (default prime): an instance Archon keeps, any cluster on this host (Archon's or not), or a section of your service files. --form conninfo (the default, a libpq connection string), url (postgresql://user@host:port/db), env (PG* settings to export), service (a service-file section), jdbc (a JDBC URL for DBeaver, IntelliJ, and Java apps: sslmode=verify-full with Java's own trust store, since pgJDBC reads sslrootcert as a file), npgsql (a connection string for .NET, Power BI, and Excel's Power Query, which trust the system's store), odbc (psqlODBC connection strings for Windows and Linux), dotenv (DATABASE_URL lines for app frameworks: libpq-based, Node, and Prisma), pgadmin (a servers.json for pgAdmin's Import Servers), ca (the root certificate behind the server's chain, fetched with PostgreSQL's own STARTTLS and checked against the system's trusted roots, for clients without a system store: libpq's root.crt), or external (everything a client on another machine needs: the published name and the server's IP address as hostaddr, port, database, user, sslmode=verify-full, sslrootcert=system, where the password comes from, then the four forms filled in for that client). On this host it is the socket directory and you as yourself (peer); with --remote, or for a service whose host is on the network, the published name with sslmode=verify-full and sslrootcert=system, never a fallback to plain text. No password in any form: it stays in ~/.pgpass for libpq. An unknown form is a usage error that lists them all. Read-only (spec 043).`,
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
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { pgShow } = await import("../pg/connections.ts");
      return await pgShow(
        ctx.hostName,
        a["name"] as string,
        a["form"] as string,
        !!a["remote"],
        ctx.json,
      );
    },
  },
  {
    name: "pg test",
    output: "report",
    summary: "Test an external connection: TLS to the published name, with a password you type",
    description: `Connects to NAME (default prime) the way a client on another machine does: to its published name, never localhost, over TLS with the server's certificate verified (sslmode=verify-full), as you (or --user) with a password you type (not echoed, not stored: it reaches psql through a private, temporary password file removed at once). Reports who you connected as, the server's and your addresses, and the TLS version; on failure, the likely cause and its fix: the password (PostgreSQL learns your Linux password when you type it on the server after publishing: sudo -k && sudo -v there), the certificate, the name not resolving, or nothing answering (firewall, router). Run it from another machine (a workstation) to test the firewall and the router too. Interactive, so not an MCP tool (spec 043).`,
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
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { pgTest } = await import("../pg/connections.ts");
      return await pgTest(ctx.hostName, a["name"] as string, a["user"] as string | undefined);
    },
  },
  {
    name: "pg on",
    output: "action",
    summary: "Turn PostgreSQL on for this server (off until an operator does)",
    description: `PostgreSQL is an opt-in service (spec 040): every server has postgresql-common, and postgresql.service stays masked until an operator runs this. --durable or --ephemeral is required (Article 23, spec 044): durable makes the server durable (guarded against reinstalls and wipes). It records the decision in the host's own archon.sql (opt-in pg) (who, when, which) and applies it: postgresql.service is unmasked and started, and every instance in the model and the host's record is created or started. Every apply, reboot, and reinstall keeps it on until an operator runs archon pg off. The mailbox is told. See archon-pg(7) and archon-opt-in(1).`,
    tier: "mutate",
    operation: true,
    args: [...CHOICE_ARGS, CONFIRM_DESTROY_ARG("the host's name")],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { setOptIn } = await import("../optin/optin.ts");
      return await setOptIn(ctx.hostName, "pg", true, {
        data: chooseData(a, "PostgreSQL's data"),
        confirm: a["confirm-destroy"],
      });
    },
  },
  {
    name: "pg off",
    output: "action",
    summary: "Turn PostgreSQL off for this server: every instance stopped and held",
    description: `Records the decision and applies it: postgresql.service is masked and stopped, which stops every instance (each is PartOf it), and nothing starts them (a reboot included) until an operator runs archon pg on. Data, roles, and passwords are kept (spec 040).`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { setOptIn } = await import("../optin/optin.ts");
      return await setOptIn(ctx.hostName, "pg", false);
    },
  },
  {
    name: "pg who",
    output: "report",
    summary: "An instance's roles and the Linux accounts behind them",
    description: `Lists every role in the instance: its kind (human, service, group, the superuser postgres), whether a Linux account of that name exists, whether it can log in, whether it is a superuser, whether it has a password (as root), and its groups. Exits non-zero when a rule of spec 039 is broken: a role that can log in without a Linux account, a superuser other than postgres, or a person's password on a private instance. See archon-pg(7).`,
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
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgWho(ctx.hostName, a["name"] as string, ctx.json);
    },
  },
  {
    name: "pg passwd-sync",
    output: "action",
    summary: "Give PostgreSQL a person's Linux password (run by PAM)",
    description: `Run by Archon's PAM hook (as root, in the background) after Linux accepts or changes a password: reads it from standard input and, for each instance where that person has a role, sets a SCRAM verifier of the same password, so a published instance takes their Linux password. Nothing else is stored, printed, or logged. Not for people to run (spec 039).`,
    tier: "mutate",
    unlocked: true,
    noMcp: true,
    args: [
      {
        name: "user",
        type: "string",
        positional: true,
        required: true,
        description: "The account.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../pg/commands.ts");
      return await m.pgPasswdSync(ctx.hostName, a["user"] as string);
    },
  },
  {
    name: "decide",
    output: "action",
    summary:
      "Record an opt-in decision for a host in Git (on a workstation): on or off, durable or ephemeral",
    description: `Writes fleets/<fleet>/hosts/<host>/decisions.ts (spec 047): whether an opt-in (pg, s3, smb, otel-ui) is on for that host and, for one that holds end users' data, whether that data is durable or ephemeral (Article 23). A decision in Git wins over the host's own record, survives a re-install, and lets the boot machine know a host's data class while it is offline. Commit it signed and push: the host applies it within 15 minutes. Durable to ephemeral needs --confirm-destroy with the host's name, typed by a person.`,
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
    examples: [
      {
        cmd: "bun run stolos decide pg on --durable --host olympia",
        text: "PostgreSQL on for olympia, its data durable; then commit -S and push.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const state = String(a["state"]);
      if (state !== "on" && state !== "off") throw new Error("say on or off");
      const { decide } = await import("../fleet/decisions.ts");
      const { currentUser } = await import("../core/exec.ts");
      const data = a["durable"] ? "durable" : a["ephemeral"] ? "ephemeral" : undefined;
      if (a["durable"] && a["ephemeral"]) throw new Error("--durable or --ephemeral, not both");
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
    output: "action",
    summary: "Turn on the telemetry web UI (OpenObserve) on this server; it collects for the fleet",
    description: `The telemetry web UI is an opt-in container (specs 040, 050): every server has it, masked, until an operator runs this. --durable or --ephemeral is required (Article 23, spec 044); telemetry is usually ephemeral. OpenObserve (pinned by digest) starts under Podman, unprivileged, on 127.0.0.1; Traefik serves it at otel.<host>.<domain>; its admin password is generated here, root only (archon otel ui password --show). This server's Collector then forwards everything it collects (journald, PCP, Archon's and apps' OTLP) to it, adding the credential itself, and accepts OTLP on 4318 (the router decides from where): point otel.localdomain (router DNS) or telemetry.collector in fleet.ts at this server and the others find it within 15 minutes. Only telemetry from then on is forwarded. Until this is on anywhere, every server keeps its own telemetry and the headless Collector works as before. See the telemetry guide (bun run stolos docs telemetry).`,
    tier: "mutate",
    operation: true,
    args: [...CHOICE_ARGS, CONFIRM_DESTROY_ARG("the host's name")],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
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
    output: "action",
    summary: "Turn off the telemetry web UI on this server (its data kept)",
    description: `Records the decision and applies it: the container stops and its unit is masked, its route leaves Traefik, the Collector stops accepting OTLP from the network and goes back to local only (or to another collector it finds). /srv/otel-ui and the credentials are kept (specs 040, 050).`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
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
    output: "report",
    summary:
      "Whether the telemetry web UI is on here, ready, where, and where this server forwards",
    description: `Read-only (spec 050): on or off, whether OpenObserve answers, its address, and the collector this server forwards to (the web UI here, telemetry.collector, otel.localdomain, the boot PC, or none). --json for tools.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { otelUiStatus } = await import("../otelui/otelui.ts");
      return await otelUiStatus(ctx.hostName, ctx.json);
    },
  },
  {
    name: "otel ui password",
    output: "action",
    summary: "The telemetry web UI's sign-in (the password only with --show, typed by a person)",
    description: `Prints the admin's sign-in name; with --show, its password too. The password is root only on this server; --show is typed by a person and never offered over MCP (spec 050).`,
    tier: "mutate",
    noMcp: true,
    args: [
      {
        name: "show",
        type: "boolean",
        human: true,
        description: "Print the password (typed by a person).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { otelUiPassword } = await import("../otelui/otelui.ts");
      return await otelUiPassword(!!a["show"]);
    },
  },
  {
    name: "fs s3 on",
    output: "action",
    summary: "Turn on S3 object storage (RustFS) on this server",
    description: `S3 object storage is an opt-in container (specs 040, 041): every server has it, masked, until an operator runs this. --durable or --ephemeral is required (Article 23, spec 044): durable buckets (/srv/s3) are archived nightly and the server is guarded against reinstalls and wipes. Records the decision in the host's own archon.sql (opt-in s3) (who, when, which) and applies it: RustFS (pinned by digest) is pulled and started under Podman, as an unprivileged user with every capability dropped, on 127.0.0.1 only; Traefik serves it on the local networks at s3.<host>.<domain> (the S3 API, path-style) and s3-console.<host>.<domain> (the console). Every person on the server and every fleet service account gets an S3 user of the same name, allowed the buckets named <name>-*, with a secret only that account can read (archon fs s3 key). It stays on, across applies and reboots, until an operator runs archon fs s3 off. The mailbox is told.`,
    tier: "mutate",
    operation: true,
    args: [...CHOICE_ARGS, CONFIRM_DESTROY_ARG("the host's name")],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { setOptIn } = await import("../optin/optin.ts");
      return await setOptIn(ctx.hostName, "s3", true, {
        data: chooseData(a, "the S3 buckets"),
        confirm: a["confirm-destroy"],
      });
    },
  },
  {
    name: "fs s3 off",
    output: "action",
    summary: "Turn off S3 object storage on this server (data kept)",
    description: `Records the decision and applies it: the container is stopped and its unit masked, its routes leave Traefik, and it stays off until an operator runs archon fs s3 on. Buckets, users, and keys are kept (/srv/s3, /var/lib/archon/s3, /var/lib/archon-keys/s3) (specs 040, 041).`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { setOptIn } = await import("../optin/optin.ts");
      return await setOptIn(ctx.hostName, "s3", false);
    },
  },
  {
    name: "fs s3 status",
    output: "report",
    summary: "Whether S3 object storage is on, ready, and where",
    description: `Shows whether S3 is on (since when, who turned it on), whether its container runs and answers ready, the API and console addresses, and (as root) its users. Exits non-zero when it is on but not ready (spec 041).`,
    tier: "read",
    unlocked: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { s3Status } = await import("../s3/s3.ts");
      return await s3Status(ctx.hostName, ctx.json);
    },
  },
  {
    name: "fs s3 key",
    output: "action",
    summary: "Your S3 access key (your username) and secret, or an AWS profile with them",
    description: `Your S3 user is your Linux username; its secret was generated on the server and only you (and root) can read it: S3 signs every request with a secret the server keeps, so it cannot be your Linux password. Without --write, shows your access key, the endpoint, and your buckets (<you>-*). With --write, puts a profile s3-<host> in ~/.aws/credentials and ~/.aws/config (0600, replacing only that profile), for the aws CLI, rclone, and the SDKs. The web console (s3-console.<host>.<domain>) signs in with Account: your username and Key: this secret, not your Linux password; --show prints the secret on your terminal to paste there (never in JSON, a log, MCP, or for an agent). --rotate gives you a new secret at once (through sudo) and the old one stops working: use it when the secret may have been seen, then run --write again and update anything that uses it. Run it as the account that needs the key (a service: sudo -u s-<app> archon fs s3 key --write) (spec 041).`,
    tier: "read",
    mutateWith: "rotate",
    unlocked: true,
    args: [
      {
        name: "write",
        type: "boolean",
        description: "Write the s3-<host> profile into ~/.aws.",
      },
      {
        name: "show",
        type: "boolean",
        human: true,
        description:
          "Print your secret key on this terminal, to paste into the web console's Key field. Only on a terminal, never in JSON or a log, never over MCP or for an agent.",
      },
      {
        name: "rotate",
        type: "boolean",
        description:
          "Give your S3 user a new secret now (it asks sudo); the old one stops working at once.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const m = await import("../s3/s3.ts");
      if (a["rotate"]) return await m.s3Rotate(ctx.hostName);
      return await m.s3Key(ctx.hostName, !!a["write"], ctx.json, !!a["show"]);
    },
  },
  {
    name: "shell emit",
    output: "report",
    summary: "Print the shell code for Archon's aliases, keys, and prompt",
    description: `Prints, for bash, zsh, or fish, the code that turns on Archon's shell features: the modern ls, ll, la, and tree (eza), cat (bat), and fd; fzf's keys (Ctrl+R history, Ctrl+T files, Alt+C folders); zoxide's z; delta for git; the terminal title; and the prompt. One line in a shell's startup file turns it all on, and a shell without that line gets none of it:\n\n  bash  ~/.bashrc:                  eval "$(archon shell emit bash)"\n  zsh   ~/.zshrc:                   eval "$(archon shell emit zsh)"\n  fish  ~/.config/fish/config.fish: archon shell emit fish | source\n\nThe fleet's dotfiles carry the line for everyone (man archon-dotfiles). Without a shell name, the shell that runs the line is used (its parent process, else $SHELL). Everything is guarded: nothing happens in a non-interactive shell, and each piece only when its tool is installed. The prompt is plain (no icons, status in words) on a console terminal (the physical console or a serial line) and Oh My Posh everywhere else; ARCHON_PROMPT=plain or ARCHON_PROMPT=pretty overrides that. The output is rendered into /usr/local/share/archon/shell/init.<shell> by archon apply, and the archon launcher prints that file without starting the engine, so a new shell starts fast (spec 036).`,
    tier: "read",
    unlocked: true,
    noMcp: true,
    args: [
      {
        name: "shell",
        type: "string",
        positional: true,
        description: "bash, zsh, or fish (default: the shell that runs it).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { shellEmit } = await import("../shell/emit.ts");
      return await shellEmit(a["shell"] as string | undefined);
    },
  },
  {
    name: "shell status",
    output: "report",
    summary: "Which of your shells have Archon's shell features turned on",
    description: `Checks ~/.bashrc, ~/.zshrc, and ~/.config/fish/config.fish for the archon shell emit line, and shows the line to add where it is missing (spec 036).`,
    tier: "read",
    unlocked: true,
    args: [],
    async run(): Promise<number> {
      const { shellStatus } = await import("../shell/emit.ts");
      return await shellStatus();
    },
  },
  {
    name: "dotfiles",
    output: "report",
    summary: "Show where your dotfiles come from (layers in the repository)",
    description: `Lists the layers that make up a user's chezmoi source on this host, most general first: the engine's home/ (every fleet), fleets/<id>/home/ (everyone in this fleet), fleets/<id>/hosts/<host>/home/ (everyone on this host), fleets/<id>/users/<user>/home/ (this user everywhere), and fleets/<id>/hosts/<host>/users/<user>/home/ (this user here). A later layer replaces a file with the same target. With a path (~/.bashrc, .config/fish/config.fish), shows the one layer and repository file that provide it; without, every managed file and its layer. Read-only: archon apply composes the source into /var/lib/archon-dotfiles/<user> and runs chezmoi from there (spec 031). See archon-dotfiles(7).`,
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
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { dotfilesReport } = await import("../dotfiles/report.ts");
      return await dotfilesReport(
        ctx.hostName,
        a["user"] as string | undefined,
        a["path"] as string | undefined,
      );
    },
  },
  {
    name: "first-boot",
    output: "action",
    summary: "First boot of a freshly installed host (run by cloud-init)",
    description: `Run once by cloud-init after the first-boot script cloned the repository (spec 005): applies the host, hands the deploy key to ops, verifies, and pushes the host's first record.`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { firstBoot } = await import("../install/first-boot.ts");
      return await firstBoot(await requireHost(ctx.hostName));
    },
  },
  {
    name: "tools sync",
    output: "action",
    summary: "Install or upgrade the tool catalog and write the report",
    description: `Article 5: fish, tmux, and git come from Ubuntu; Bun, gh, chezmoi, and oh-my-posh are upstream binaries, verified against GitHub's published SHA-256 digests, installed side by side under /opt/tools/<tool>/<version>, smoke-tested, and linked into /usr/local/bin with rollback; Claude Code is installed on workstations only and updates itself (specs 010, 030).`,
    tier: "mutate",
    operation: true,
    readOnlyWith: "report-only",
    args: [
      {
        name: "report-only",
        type: "boolean",
        description: "Check versions; install nothing.",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { syncTools } = await import("../tools/sync.ts");
      const r = await syncTools(await requireHost(ctx.hostName), {
        reportOnly: !!a["report-only"],
      });
      if (r.failed && !a["report-only"]) {
        const { notify } = await import("../notify/events.ts");
        await notify({
          event: "✗ tools sync failed",
          level: "fail",
          what: r.rows
            .filter((x) => !x.ok)
            .map((x) => `- ${x.id}: ${x.action}`)
            .join("\n"),
          todo: "sudo archon tools sync shows each failure; the weekly timer retries.",
          key: `tools:${new Date().toISOString().slice(0, 10)}`,
        });
      }
      return r.failed ? 1 : 0;
    },
  },
  {
    name: "capture",
    output: "report",
    summary: "Report this host's drift from the model (writes nothing)",
    description: `Reads manually installed packages, snaps, enabled units, listening ports, accounts, and tool versions, compares them with the plan, and prints the drift. Nothing is recorded or pushed (spec 048): ask the machine directly with archon query.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { capture } = await import("../state/capture.ts");
      const r = await capture(await requireHost(ctx.hostName));
      if (ctx.json)
        stdio.stdout.writeSync(
          `${JSON.stringify({ snapshot: r.snapshot, drift: r.drift }, null, 2)}\n`,
        );
      else stdio.stdout.writeSync(`${r.summary}\n`);
      return 0;
    },
  },
  {
    name: "drift",
    output: "report",
    summary: "What changed on this host outside Stolos, not proposed yet (read-only)",
    description: `Spec 095: what this host has, minus its plan, minus the birth snapshot (what Ubuntu put here at install, so unattended upgrades are never drift). Each item shows who changed it and when (from sudo's journal, apt's history, etckeeper, osquery) and the model change that would adopt it (packages.add, units.enable, ports.open, files.override), or what a person does by hand. A file no package owns under /usr/local or /opt is flagged (Article 5); a modified package file is a SECURITY ALERT, never a proposal (exit 1). Reads what was collected (by the daily report, every apply, or --collect); --collect reads every source again first, as root. --all also lists items already proposed, accepted as local, or rejected. Propose them with archon propose.`,
    tier: "read",
    mutateWith: "collect",
    args: [
      {
        name: "all",
        type: "boolean",
        description: "Also items already proposed, kept local, or rejected.",
      },
      {
        name: "collect",
        type: "boolean",
        description: "Read every source again first (as root: journald, /etc's history).",
      },
    ],
    examples: [
      { cmd: "archon drift", text: "What changed outside Stolos and is not proposed yet." },
      { cmd: "sudo archon drift --collect", text: "Collect now, then show it." },
    ],
    seeAlso: ["archon-propose", "archon-capture"],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { driftCommand } = await import("../proposal/server.ts");
      return await driftCommand(await requireHost(ctx.hostName), {
        all: !!a["all"],
        collect: !!a["collect"],
        json: ctx.json,
      });
    },
  },
  {
    name: "propose",
    output: "action",
    summary: "Propose changes made outside Stolos: signed with the host key, mailed to the fleet",
    description: `Spec 095: anyone with sudo may propose. Collects again, then takes the drift items chosen (--all, --intent <id> for a change session, --item <key>, repeatable), each with an action: adopt (put it in the model), revert (let Stolos converge it back; Archon never removes anything itself, so the proposal names the command), or local (keep it here, recorded as accepted local drift until --until, default 30 days; not for an item the plan manages). A written --reason is required (a recording's counts). Builds proposal.json (format stolos-proposal/1: the host, the model commit it runs, the evidence, and per item the structured model edits), with no secrets (a secret path or key-like content is a hash only), signs it with the host's SSH host key (ssh-keygen -Y sign -n stolos-proposal), keeps it in /var/lib/archon/proposals/<id>/, and mails it to the fleet's mailbox with a readable summary. On your PC: stolos proposal import. --dry-run prints it and sends nothing.`,
    tier: "mutate",
    readOnlyWith: "dry-run",
    args: [
      { name: "all", type: "boolean", description: "Every item not proposed yet." },
      {
        name: "intent",
        type: "string",
        repeatable: true,
        description: "A change session's items (its id from archon drift).",
      },
      {
        name: "item",
        type: "string",
        repeatable: true,
        description: "One drift item, by key (package:nginx, file:/etc/...).",
      },
      {
        name: "action",
        type: "string",
        choices: ["adopt", "revert", "local"],
        default: "adopt",
        description: "What to do with every chosen item.",
      },
      {
        name: "revert",
        type: "string",
        repeatable: true,
        description: "This chosen item is reverted instead.",
      },
      {
        name: "local",
        type: "string",
        repeatable: true,
        description: "This chosen item stays local instead (until --until).",
      },
      {
        name: "until",
        type: "string",
        description: "Local drift is accepted until this day (YYYY-MM-DD; default 30 days).",
      },
      {
        name: "reason",
        short: "r",
        type: "string",
        description: "Why the change was made (required, unless a recording gives it).",
      },
      {
        name: "dry-run",
        type: "boolean",
        description: "Print the proposal; sign, record, and send nothing.",
      },
    ],
    examples: [
      {
        cmd: 'sudo archon propose --all --reason "nginx for the app"',
        text: "Propose every change not proposed yet, to adopt it.",
      },
      {
        cmd: 'sudo archon propose --item package:htop --item file:/etc/htoprc --local file:/etc/htoprc -r "debugging"',
        text: "Adopt htop, keep its settings here for 30 days.",
      },
    ],
    seeAlso: ["archon-drift"],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { proposeCommand } = await import("../proposal/propose.ts");
      return await proposeCommand(await requireHost(ctx.hostName), {
        all: !!a["all"],
        intent: a["intent"] as string | undefined,
        item: a["item"] as string | undefined,
        action: a["action"] as string | undefined,
        revert: a["revert"] as string | undefined,
        local: a["local"] as string | undefined,
        until: a["until"] as string | undefined,
        reason: a["reason"] as string | undefined,
        dryRun: !!a["dry-run"],
        json: ctx.json,
      });
    },
  },
  {
    name: "record",
    output: "action",
    summary: 'Record a change made by hand: archon record "reason", the work, archon record done',
    description: `Spec 095: archon record "why" starts a recording; archon record done ends it, collects, and shows everything that changed outside Stolos in between as one intent, with that reason (sudo archon propose --intent <its id> proposes it; the recording's reason counts as the written reason). archon record alone shows the recording that runs. One at a time per host.`,
    tier: "mutate",
    args: [
      {
        name: "reason",
        type: "string",
        positional: true,
        description: 'Why the change is made ("nginx for the app"), or done to end the recording.',
      },
    ],
    examples: [
      { cmd: 'archon record "nginx for the app"', text: "Start recording." },
      { cmd: "archon record done", text: "End it; its changes become one intent to propose." },
    ],
    seeAlso: ["archon-propose", "archon-drift"],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { recordCommand } = await import("../proposal/record.ts");
      const { proposer } = await import("../proposal/propose.ts");
      return await recordCommand(
        await requireHost(ctx.hostName),
        a["reason"] as string | undefined,
        proposer(),
      );
    },
  },
  {
    name: "proposal import",
    output: "action",
    summary: "Import proposals mailed by servers: verify each against the host's key in Git",
    description: `Spec 095: reads a saved message (.eml: its proposal.json and proposal.json.sig attachments, base64 or quoted-printable, gzipped or not), or proposal.json (or .json.gz) with proposal.json.sig beside it, or a folder of them. Each is checked: its format (stolos-proposal/1), that its host is in this fleet, and that it was signed with one of that host's SSH host keys in fleets/<fleet>/hosts/<host>/registration.ts (namespace stolos-proposal). A forged or altered proposal is refused with the reason. Good ones are kept in your state folder (not in Git; Article 4: no JSON in a fleet). No mailbox access and no credential: save the mail, then import it.`,
    tier: "repo",
    args: [
      {
        name: "path",
        type: "string",
        positional: true,
        required: true,
        description: "A saved .eml, a proposal.json, or a folder of them.",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos proposal import ~/Downloads/proposal.eml",
        text: "Verify and keep a proposal saved from the fleet's mailbox.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { importCommand } = await import("../proposal/pc.ts");
      return await importCommand(a["path"] as string);
    },
  },
  {
    name: "proposal list",
    output: "report",
    summary: "The imported proposals: host, who, items, and the decision",
    description: `Spec 095: every imported proposal, newest first, with its host, time, proposer, number of items, its reason, and its decision in Git (waiting, accepted, rejected).`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { listCommand } = await import("../proposal/pc.ts");
      return await listCommand(ctx.json);
    },
  },
  {
    name: "proposal show",
    output: "report",
    summary: "One proposal: its reason, items, evidence, and the model diff accepting makes",
    description: `Spec 095: verifies the proposal again, then shows who proposed it and why, the change sessions and their sudo commands, each item with its action (adopt, revert, local) and its structured edits, and the change to the host's host.ts that accepting makes. Items the model already has are named; so is every conflict (the model sets the item otherwise, with the spec that does), and a note when the host's model changed since the host made it.`,
    tier: "read",
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The proposal's id (or a unique start of it).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { showCommand } = await import("../proposal/pc.ts");
      return await showCommand(a["id"] as string, ctx.json);
    },
  },
  {
    name: "proposal accept",
    output: "action",
    summary: "Accept a proposal: edit the host's model, write a draft spec, record it, build",
    description: `Spec 095: verifies the proposal again, then compares each edit with the model now. A conflict (the model already sets the item otherwise) is named with the spec that owns it and nothing is written; --skip <key> leaves an item out (it stays flagged on the host). Otherwise: adds adopted({...}) (bare keys) to the host's capabilities in host.ts, with its import; writes a draft spec fleets/<fleet>/specs/NNN-<host>-<reason>/spec.md from the proposal's reason and evidence; records the decision in fleets/<fleet>/hosts/<host>/proposals.ts (with the items kept local and their dates); and runs stolos build. Review the change, then stolos apply: the host converges, and its holds end.`,
    tier: "repo",
    operation: true,
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The proposal's id (or a unique start of it).",
      },
      {
        name: "skip",
        type: "string",
        repeatable: true,
        description: "Leave this item out (a named conflict); it stays flagged on the host.",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos proposal accept alpha-20261114-1905-ab12",
        text: "Adopt it into the model; then review and stolos apply.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { acceptCommand } = await import("../proposal/pc.ts");
      return await acceptCommand(a["id"] as string, a["skip"] as string | undefined);
    },
  },
  {
    name: "proposal reject",
    output: "action",
    summary: "Reject a proposal: recorded in Git; managed items revert, the rest stays flagged",
    description: `Spec 095: records the rejection in fleets/<fleet>/hosts/<host>/proposals.ts. After stolos apply, the host ends the proposal's holds: the next apply reverts the items the plan manages; anything else stays flagged in archon drift.`,
    tier: "repo",
    args: [
      {
        name: "id",
        type: "string",
        positional: true,
        required: true,
        description: "The proposal's id (or a unique start of it).",
      },
      { name: "reason", short: "r", type: "string", description: "Why, for the record." },
    ],
    async run(a: Parsed): Promise<number> {
      const { rejectCommand } = await import("../proposal/pc.ts");
      return await rejectCommand(a["id"] as string, a["reason"] as string | undefined);
    },
  },
  {
    name: "reboot",
    output: "action",
    summary: "Reboot this host; --netboot boots it from the network once (for a re-install)",
    description: `Waits until nothing changes packages (apt, dpkg, unattended-upgrades: up to 15 minutes; --now does not wait, spec 054), then reboots in 5 seconds, so it can be run over SSH. With --netboot it first sets the firmware's one-time next boot (UEFI BootNext) to the network entry the install recorded (/etc/archon/netboot-entry), or the first PXE/HTTP IPv4 entry, so the boot server can re-install an armed host without anyone at the console; the boot order itself is unchanged. bun run stolos boot reinstall <host> runs this for you (spec 004).`,
    tier: "mutate",
    operation: true,
    args: [
      {
        name: "netboot",
        type: "boolean",
        description: "Boot from the network once (the boot server re-installs it if armed).",
      },
      {
        name: "now",
        type: "boolean",
        description: "Do not wait for apt or dpkg to finish (it can break dpkg's state).",
      },
    ],
    examples: [
      {
        cmd: "archon reboot --netboot",
        text: "Re-install this host (armed on the boot machine).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { reboot } = await import("../install/netboot.ts");
      return await reboot({ netboot: !!a["netboot"], now: !!a["now"] });
    },
  },
  {
    name: "poweroff",
    output: "action",
    summary: "Shut this host down cleanly, after apt and dpkg finish",
    description: `Waits until nothing changes packages (apt, dpkg, unattended-upgrades: up to 15 minutes, saying what it waits for), then shuts down cleanly in 5 seconds, so it can be run over SSH. Cutting the power while apt runs can break dpkg's state; this is the way to turn a server off (spec 054). --now does not wait.`,
    tier: "mutate",
    operation: true,
    args: [
      {
        name: "now",
        type: "boolean",
        description: "Do not wait for apt or dpkg to finish (it can break dpkg's state).",
      },
    ],
    examples: [{ cmd: "archon poweroff", text: "Turn this server off, cleanly." }],
    async run(a: Parsed): Promise<number> {
      const { reboot } = await import("../install/netboot.ts");
      return await reboot({ netboot: false, now: !!a["now"], poweroff: true });
    },
  },
  {
    name: "observe",
    output: "report",
    summary: "What this machine records about itself, where, and within which limits",
    // The Collector's files belong to its own service user; members of
    // archon-ops are not asked for a password.
    asOwner: true,
    description: `Shows this machine's local observability (spec 021): logs in journald, metrics in PCP's archives, and Archon's own OpenTelemetry (traces, metrics, logs) as the local OpenTelemetry Collector writes it, each with its size, how far back it goes, and its limits. Every local store is ephemeral: bounded by age and size, pruned first when the disk runs low, never backed up. Live views: btop, archon observe tui, journalctl -f.`,
    tier: "read",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { observe } = await import("../observe/observe.ts");
      return await observe(await requireHost(ctx.hostName));
    },
  },
  {
    name: "observe tui",
    output: "report",
    summary: "Open otel-tui on this machine's telemetry (PCP's metrics live, Archon's OTLP)",
    description: `Runs otel-tui, a terminal viewer for OpenTelemetry, on 127.0.0.1: PCP's core metrics live (through pmproxy's OpenMetrics endpoint) and Archon's recent traces, metrics, and logs from the local Collector's OTLP file. Quit with q. Runs through sudo, which does not prompt members of archon-ops.`,
    tier: "read",
    asOwner: true,
    args: [],
    async run(): Promise<number> {
      const { observeTui } = await import("../observe/observe.ts");
      return await observeTui();
    },
  },
  {
    name: "observe discover",
    output: "action",
    summary: "Look for a central OpenTelemetry collector and forward to it if one answers",
    description: `Looks for a central OpenTelemetry collector (spec 024): the fleet model's telemetry.collector, else the name "otel.localdomain" (telemetry.name), a Local DNS record in the router. Never mDNS or DNS-SD (constitution Article 20). A candidate counts only if it accepts OTLP. When one answers, the local Collector also reads journald and PCP (through pmproxy) and forwards them and Archon's own telemetry as OTLP, with a bounded queue on disk; when none does, everything stays local. The archon-observe-discover timer runs this every 15 minutes. With --check, only reports.`,
    tier: "mutate",
    operation: true,
    readOnlyWith: "check",
    args: [{ name: "check", type: "boolean", description: "Report what would change." }],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { discover } = await import("../observe/discover.ts");
      return await discover(await requireHost(ctx.hostName), !!a["check"]);
    },
  },
  {
    name: "doctor",
    output: "report",
    summary: "Can this machine reach what it needs? Network and email, with where to look",
    description: `A quick, read-only diagnosis (spec 026), each problem with what it means and where to look:\n\nLink: the default route, carrier, duplex, and interface errors (ip, sysfs). Gateway: loss and latency (ping), and whether full-size packets pass (ping with don't-fragment). DNS: the configured servers (resolvectl), five uncached lookups of archive.ubuntu.com to catch a flaky upstream, each server directly (dig), a public resolver only when they all fail (to tell the router's DNS from the internet's), and this host's Local DNS name. IPv6: a route, and whether apt is limited to IPv4 where there is none (spec 009). Time: synchronized, offset, sources (timedatectl, chronyc), because TLS needs the right time. Proxy and firewall: proxy settings, UFW's outgoing policy.\n\nInternet: every endpoint this machine uses, taken from its own configuration: each apt repository's InRelease (Ubuntu, security, PPAs, GitHub CLI), the checkout's remote (over SSH as ops with the deploy key), GitHub's API and a release download (tools sync), the Claude Code installer (workstations), the Snap Store (snapd's own snap debug connectivity), and the OpenTelemetry collector if the model names one; each with curl's DNS, connect, and TLS times, and a curl failure explained (DNS, refused, timeout, TLS, certificate, reset). With --trace, mtr follows the path to each failing site over TCP.\n\nEmail (specs 025, 027): the sending domain's records in DNS (Cloudflare's cf-bounce SPF, DKIM, and MX, and DMARC), the relay's credential, a login to the relay without sending (curl, EHLO, AUTH, NOOP), and on servers Postfix: running, relaying to the right place, and its queue. archon notify's queue and last send. With --send, it also mails what the Email phase found to the shared mailbox through archon's own sender and through Postfix, so the result arrives where it matters; this happens by itself after bun run stolos boot mail-setup, after an install, and when a server receives a new token.`,
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
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { doctor } = await import("../doctor/doctor.ts");
      return await doctor(await requireHost(ctx.hostName), {
        trace: !!a["trace"],
        send: a["send"] ? "archon doctor --send" : undefined,
      });
    },
  },
  {
    name: "vault status",
    output: "report",
    summary: "Boot machine: every secret, when it changed, and whether the last backup has it",
    description: `Lists every secret in the boot machine's secrets folder with its inventory name, when it last changed, and when it was last backed up (specs 029 and 056): ✓ backed up, ⚠ newer than the last backup. Exits 1 if anything is newer than the last backup. With --lost, prints how each secret would be made again if the boot machine were lost without a backup. Also writes the prompt's 🔐 backup status, installs the git pre-push reminder hook, and sends the "not backed up" email when due. Run as bun run stolos vault status.`,
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
    async run(a: Parsed): Promise<number> {
      const { vaultStatus } = await import("../vault/commands.ts");
      return await vaultStatus({ lost: !!a["lost"], hook: !!a["hook"] });
    },
  },
  {
    name: "vault backup",
    output: "action",
    summary: "Boot machine: one ZIP of every secret and your signing key, to keep somewhere safe",
    description: `Writes stolos-backup-<pc>-<UTC>.zip into stolos's backup folder (Windows: %LOCALAPPDATA%\\stolos\\backup; Linux and macOS: stolos's data folder, backup) with every fleet's secrets on this PC (except ephemeral install tokens), your signing key (both halves, from git config user.signingkey; the private half stays locked by its passphrase), a manifest (names, SHA-256, sizes; never a value), and RESTORE.txt (the restore steps). It reads the ZIP back and checks every file before reporting success, makes it readable by you only, and records it. Then move the ZIP wherever you keep important things safe (an encrypted place: it is not encrypted itself). Spec 056.`,
    tier: "repo",
    operation: true,
    noMcp: true,
    args: [],
    async run(): Promise<number> {
      const { vaultBackup } = await import("../vault/commands.ts");
      return await vaultBackup();
    },
  },
  {
    name: "vault restore",
    output: "action",
    summary:
      "Boot machine: restore a backup ZIP on a freshly cloned PC (secrets, both keys, signing)",
    description: `Run in the freshly cloned fleet repository: checks the backup ZIP (its format and every file's SHA-256), chooses the fleet it is for, puts every file back (the secrets readable by you only, the daily key in .ssh, the recovery key in the key store), records it as the last backup, then runs keys setup (Git's signing for this checkout and one test signature: your daily passphrase) and downloads the engine's types for VS Code. It never overwrites: a file already there with the same bytes is kept, and one that differs stops it before anything is written, so it can be run again. --destroy-existing restores clean: every fleet's secrets, the key store, and the backup's daily key files in .ssh are removed first (anything there the backup does not hold identically is saved as a backup ZIP of its own first; no other .ssh file is touched). --files-only stops after the files. Without a ZIP: prints the steps (the same as RESTORE.txt in every ZIP). Specs 056 and 061.`,
    tier: "repo",
    operation: true,
    noMcp: true,
    args: [
      {
        name: "zip",
        type: "string",
        positional: true,
        human: true,
        description: "The backup ZIP (from bun run stolos vault backup); none: print the steps.",
      },
      {
        name: "files-only",
        type: "boolean",
        description: "Put the files back, then stop (no keys setup, no editor step).",
      },
      {
        name: "destroy-existing",
        type: "boolean",
        human: true,
        description:
          "Restore clean: remove every fleet's secrets, the key store, and the backup's daily key in .ssh first (anything the backup lacks is saved as a ZIP of its own first).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      if (!a["zip"]) {
        const { vaultRestore } = await import("../vault/commands.ts");
        return await vaultRestore();
      }
      const { vaultRestoreZip } = await import("../vault/restore.ts");
      return await vaultRestoreZip(a["zip"] as string, {
        filesOnly: !!a["files-only"],
        destroyExisting: !!a["destroy-existing"],
      });
    },
  },
  {
    name: "vault list",
    output: "report",
    summary: "Boot machine: the backup ZIPs still in the backup folder",
    description: `Lists the backup ZIPs still in stolos's backup folder, newest first. Once you move one somewhere safe, it is no longer listed.`,
    tier: "repo",
    noMcp: true,
    args: [],
    async run(): Promise<number> {
      const { vaultList } = await import("../vault/commands.ts");
      return await vaultList();
    },
  },
  {
    name: "vault recover-host-keys",
    output: "action",
    summary: "Boot machine: pull a running host's SSH host keys and deploy key back over SSH",
    description: `For a boot machine lost without a backup: connects to the host as the fleet admin, runs archon host-keys export there, and stores its SSH host keys and ops' deploy key in the secrets folder, then trusts the host keys again (known_hosts). The rebuilt boot machine holds the same identities: nothing changes on GitHub, and the next re-install keeps the host's identity.`,
    tier: "repo",
    operation: true,
    noMcp: true,
    args: [
      {
        name: "host",
        type: "string",
        positional: true,
        required: true,
        description: "The host.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { recoverHostKeys } = await import("../vault/commands.ts");
      return await recoverHostKeys(String(a["host"]));
    },
  },
  {
    name: "host-keys export",
    output: "report",
    summary: "Print this host's SSH host keys as JSON (for vault recover-host-keys)",
    description: `Prints this host's SSH host keys and ops' deploy key (private and public) as JSON on stdout, for bun run stolos vault recover-host-keys <host> on a boot machine that lost its copy (spec 029). Root only; never offered over MCP.`,
    tier: "read",
    asOwner: true,
    noMcp: true,
    args: [],
    async run(): Promise<number> {
      const { exportHostKeys } = await import("../install/host-keys.ts");
      return await exportHostKeys();
    },
  },
  {
    name: "notify send",
    output: "action",
    summary: "Email the fleet's mailbox from this machine",
    description: `Queues one message to the fleet's shared mailbox (mail.to in fleets/<fleet>/fleet.ts), from root+<host>.<mail.tag>@<mail.domain>, and starts sending it through Cloudflare Email Service (specs 025, 027). A short subject becomes "[Archon] <host>: <subject>"; a subject that starts with "[" or "Lab " is sent as given (for example "Lab Network Runbook Change Log: ..." with the reference HTML attached).\n\nAttachments are trimmed or gzipped to keep a message under about 1 MB. Secrets are redacted from the subject, body, and text attachments: tokens, keys, password hashes, and the credential itself. With --key, a message with the same key in the last hour is dropped. Messages wait in /var/spool/archon/notify and are retried with backoff; sending never blocks or fails the command that asked for it.`,
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
        cmd: `archon notify send --subject "Lab Network Runbook Change Log: VLAN 40" --body-file notes.txt --attach runbook.html`,
        text: "a network change log with the reference HTML",
      },
    ],
    seeAlso: ["archon-notify-test", "archon-notify-status"],
    async run(a: Parsed): Promise<number> {
      const { notifySend } = await import("../notify/commands.ts");
      const level = String(a["level"] ?? "info");
      if (!["info", "warn", "fail"].includes(level)) {
        throw new Error("--level is info, warn, or fail");
      }
      return await notifySend(
        {
          subject: String(a["subject"]),
          ...(typeof a["body"] === "string" ? { body: a["body"] } : {}),
          ...(typeof a["body-file"] === "string" ? { bodyFile: a["body-file"] } : {}),
          attach: a["attach"] ? String(a["attach"]).split("\n") : [],
          level: level as "info" | "warn" | "fail",
          ...(typeof a["key"] === "string" ? { key: a["key"] } : {}),
        },
        { wait: !!a["wait"] },
      );
    },
  },
  {
    name: "notify test",
    output: "action",
    summary: "Send a test message and wait for the relay to accept it",
    description: `Sends "[Archon] <host>: notification test" to the fleet's mailbox right away and reports whether the relay accepted it (spec 025). If this machine has no credential: on the boot machine, bun run stolos boot mail-setup; for a host, bun run stolos boot mail-push <host>.`,
    tier: "mutate",
    unlocked: true,
    args: [],
    async run(): Promise<number> {
      const { notifyTest } = await import("../notify/commands.ts");
      return await notifyTest();
    },
  },
  {
    name: "notify status",
    output: "report",
    summary: "Mailbox, last send and its result, and messages waiting",
    description: `Shows where this machine's notifications go, the relay, whether it holds the relay's credential, the last send and its result, and how many messages wait in the queue (spec 025). With --check (archon verify uses it, as a warning): exits 1 if notifications are not configured, the last send failed, or a message has waited more than 6 hours.`,
    tier: "read",
    args: [{ name: "check", type: "boolean", description: "One line; exit 1 on a problem." }],
    async run(a: Parsed): Promise<number> {
      const { notifyStatus } = await import("../notify/commands.ts");
      return await notifyStatus({ check: !!a["check"] });
    },
  },
  {
    name: "notify flush",
    output: "action",
    summary: "Send what is waiting in the notify queue",
    description: `Sends the queued messages whose retry time has come, oldest first, and stops at the first failure (spec 025). Five or more messages older than an hour are sent as one "N messages were queued" summary. The archon-notify-flush timer runs this every 5 minutes, and every queued message starts it at once.`,
    tier: "mutate",
    unlocked: true,
    args: [],
    async run(): Promise<number> {
      const { notifyFlush } = await import("../notify/commands.ts");
      return await notifyFlush();
    },
  },
  {
    name: "notify watch",
    output: "report",
    summary: "Follow the journal and email logins and other major server events",
    description: `Runs as the archon-notify-watch service (spec 025). It follows the journal, where Ubuntu already records every event below, and emails the fleet's mailbox: SSH logins (user, address and its DNS name, local network or not, method, and the key's fingerprint and name; once per user, address, and method an hour, as a warning when the address is outside the local networks or new for that user); any root login; failed SSH logins, summarized hourly by address and users tried; console logins (keyboard or AMT); su; sudo refusals; account and group changes made outside archon apply; changes to any authorized_keys file; kernel out-of-memory kills, disk and filesystem errors, read-only remounts, and hardware errors; failed system units; each boot, and whether the previous one ended cleanly; and filesystems over 90% full. Nothing is added to sshd, PAM, or auditd.`,
    tier: "mutate",
    unlocked: true,
    noMcp: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { watch } = await import("../notify/watch.ts");
      return await watch(ctx.hostName);
    },
  },
  {
    name: "mail credential",
    output: "action",
    summary: "Install the mail relay's token from stdin (bun run stolos boot mail-push)",
    description: `Reads the mail credential (JSON with a Cloudflare API token that has Email Sending: Edit) on stdin and stores it as Postfix's /etc/postfix/sasl_passwd, readable by root only, then reloads Postfix (spec 027). archon's own messages use the same token. The boot machine sends it with bun run stolos boot mail-push <host>; installs deliver it by themselves.`,
    tier: "mutate",
    unlocked: true,
    noMcp: true,
    args: [],
    async run(): Promise<number> {
      const { mailCredential } = await import("../notify/commands.ts");
      return await mailCredential();
    },
  },
  {
    name: "mail test",
    output: "action",
    summary: "Send a test through Postfix, the way apps and cron jobs send mail",
    description: `Hands one message for root to /usr/sbin/sendmail (spec 027). This host's Postfix sends mail for local accounts to the fleet's mailbox, from root+<host>.<mail.tag>@<mail.domain>, through Cloudflare Email Service. archon notify test checks archon's own path; this checks the one every other program uses.`,
    tier: "mutate",
    unlocked: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { mailTest } = await import("../notify/commands.ts");
      return await mailTest(ctx.hostName);
    },
  },

  {
    name: "observe prune",
    output: "action",
    summary: "Keep PCP's metric archives within their size and free-space limits",
    description: `Removes PCP's oldest metric archives while they are over the size limit or the disk is below its free-space floor (spec 021); the archive being written is never removed. pmlogger_daily already removes archives past their age limit, and journald and the Collector's files limit themselves. The archon-observe-prune timer runs this daily. With --check, only reports.`,
    tier: "mutate",
    operation: true,
    readOnlyWith: "check",
    args: [{ name: "check", type: "boolean", description: "Report what would be removed." }],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { prune } = await import("../observe/observe.ts");
      return await prune(await requireHost(ctx.hostName), !!a["check"]);
    },
  },
  {
    name: "update",
    output: "action",
    summary: "Bring this machine up to date with GitHub: pull, apply, verify",
    description: `Pulls the repository (as its owner), then with the freshly pulled code validates the model, applies, syncs tools, applies dotfiles again when tools changed, and verifies (spec 015). An invalid model stops before anything is applied (Article 10). With --check, shows incoming commits and the plan.`,
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
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { update } = await import("../update/update.ts");
      const steps = await update(await requireHost(ctx.hostName), {
        check: !!a["check"],
        tools: !a["no-tools"],
        pull: !a["no-pull"],
      });
      return steps.every((s) => s.ok || s.step === "pull") ? 0 : 1;
    },
  },
  {
    name: "update",
    output: "action",
    summary: "Bring this PC's checkout up to date (use it instead of git pull), then the doctor",
    description: `Instead of git pull (spec 058): fetches and fast-forwards a clean checkout (never a merge); checks that what arrived is signed by a key the fleet trusted (as servers will); sends your own commits first (stolos apply), upgrades the pinned engine when a newer Stolos release is out (fleet upgrade: one signed commit) and sends that too (stolos apply), so every server follows within 15 minutes; --no-upgrade only reports; a pull that diverged from yours is rebased (yours on top), and a conflict is undone and named; repairs Git's allowed signers and the pre-push check; then runs boot doctor (on a boot machine) or stolos keys. Every step is safe to run again.`,
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
    async run(a: Parsed): Promise<number> {
      const { operatorUpdate } = await import("../update/operator.ts");
      return await operatorUpdate({ noUpgrade: !!a["no-upgrade"], noDoctor: !!a["no-doctor"] });
    },
  },
  {
    name: "reconcile",
    output: "action",
    summary: "Converge to the repository (run by the timer every 15 minutes)",
    description: `Fetches the fleet's branch, fast-forwards a clean checkout, and applies only when HEAD equals the remote (Article 9). Skips when another archon run holds the host lock, or when the checkout has local changes.`,
    tier: "mutate",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { reconcile } = await import("../reconcile/reconcile.ts");
      return await reconcile(await requireHost(ctx.hostName));
    },
  },
  {
    name: "export",
    output: "action",
    summary:
      "The fleet in a standard format: OCSF, OTLP, CycloneDX attestations, in-toto, OSCAL, or RDF",
    description: `Spec 092. Writes one document from what this PC knows, by default to this PC's state directory (export/): ocsf-jsonl (OCSF 1.9.0 events, one per line: each person and account, machine, and other node in the estate graph, and a Compliance Finding per check and SCF control); otlp-json (the same events as an OTLP/HTTP JSON logs request; --entities adds OpenTelemetry entity events); cyclonedx-attestation (CycloneDX 1.6: the SCF controls as a standard, a claim per control with its evidence and conformance, the evidence bundle's items by SHA-256 with --bundle); intoto-statement (an in-toto Statement v1 for an evidence bundle: --bundle, or the newest one here); the four OSCAL documents (oscal-component-definition, oscal-ssp, oscal-assessment-results, oscal-poam). Without a kind, or rdf: out/rdf/fleet.ttl, using W3C PROV, Dublin Core terms, FOAF, and the archon: namespace (specs 002 and 014). Changes nothing else.`,
    tier: "repo",
    args: [
      {
        name: "kind",
        type: "string",
        positional: true,
        description:
          "rdf (the default), ocsf-jsonl, otlp-json, cyclonedx-attestation, intoto-statement, oscal-component-definition, oscal-ssp, oscal-assessment-results, or oscal-poam.",
        choices: [
          "rdf",
          "ocsf-jsonl",
          "otlp-json",
          "cyclonedx-attestation",
          "intoto-statement",
          "oscal-component-definition",
          "oscal-ssp",
          "oscal-assessment-results",
          "oscal-poam",
        ],
      },
      {
        name: "out",
        type: "string",
        description: "The file to write (default: this PC's state directory, export/).",
      },
      {
        name: "bundle",
        type: "string",
        description:
          "An evidence bundle (ZIP, spec 072): the subject of intoto-statement, the evidence of cyclonedx-attestation.",
      },
      {
        name: "entities",
        type: "boolean",
        description:
          "otlp-json: also send inventory as OpenTelemetry entity events (Development status).",
      },
    ],
    examples: [
      {
        cmd: "bun run stolos export ocsf-jsonl",
        text: "The estate and every check as OCSF events, one per line.",
      },
      {
        cmd: "bun run stolos export cyclonedx-attestation --bundle lab-evidence.zip",
        text: "A CycloneDX attestation whose evidence is the bundle's items.",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { exportCommand } = await import("../export/commands.ts");
      return await exportCommand(a["kind"] as string | undefined, {
        ...(a["out"] ? { out: a["out"] as string } : {}),
        ...(a["bundle"] ? { bundle: a["bundle"] as string } : {}),
        ...(a["entities"] ? { entities: true } : {}),
      });
    },
  },
  {
    name: "report daily",
    output: "report",
    summary: "Write the daily health report",
    description: `Failed units, disk, pending upgrades, archon timers, drift, and the latest tools report, written to /var/lib/archon/reports/daily-<date>.md and the journal (tag archon-report). Facts only: no agent runs on a server (spec 030); a workstation agent reads reports as MCP resources.`,
    tier: "read",
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
      const { dailyReport } = await import("../report/daily.ts");
      const r = await dailyReport(await requireHost(ctx.hostName));
      stdio.stdout.writeSync(`${r.path}\n`);
      // Spec 025: the daily report is the daily message.
      const { notify } = await import("../notify/events.ts");
      const text = await fs.readTextFile(r.path).catch(() => "");
      const date = new Date().toISOString().slice(0, 10);
      await notify({
        // Spec 013: "[Archon] <host>: daily report <date>", once per day (the key).
        event: `daily report ${date}${r.failedUnits ? ` · ${r.failedUnits} failed unit(s)` : ""}`,
        level: r.failedUnits ? "warn" : "info",
        what:
          text.length > 6000 ? text.slice(0, 6000) + "\n[...the full report is attached]" : text,
        attach: [r.path],
        key: `daily:${date}`,
      });
      return 0;
    },
  },
  {
    name: "mcp",
    output: "report",
    summary: "Serve the commands to an agent as MCP tools (stdio)",
    description: `Starts a Model Context Protocol server on stdin/stdout. Each command within --max-tier becomes a tool named archon_<command>; man pages, specs, the constitution, and reports are resources. A command above the tier is not listed and is refused; one with a read-only flag (apply --check) is listed and runs only with that flag. The destructive tier is never served. Each call is journaled (tag archon-mcp, with SSH_CLIENT).

On a server, workstations reach it as ops over SSH (spec 030): ops' authorized_keys forces this command with the fleet's tier (fleet.mcp.maxTier, default mutate) and restrict, so an agent can do nothing else there. On a workstation, stolos build renders .mcp.json with one entry per server (archon-<fleet>-<host>: ssh ops@<host>).`,
    tier: "read",
    noMcp: true,
    args: [
      {
        name: "max-tier",
        type: "string",
        description: "The highest tier served: read, repo, or mutate (default mutate).",
      },
    ],
    async run(a: Parsed): Promise<number> {
      const { serveMcp } = await import("../mcp/server.ts");
      await serveMcp(a["max-tier"] as string | undefined);
      return 0;
    },
  },
  {
    name: "backup run",
    output: "action",
    summary: "Write a backup archive now (the timer runs it daily)",
    description: `Archives the host's own state and its durable data (S3 buckets and SMB shares recorded as durable, Article 23) with tar and zstd into the backup target (default /var/backups/archon), exports each durable LXD guest (lxc export), and keeps the newest N of each (specs 016, 044).`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
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
    output: "report",
    summary: "Restore-test the newest archive",
    description: `Lists the newest archive and extracts the host marker into a temporary directory to prove it restores (Article 14).`,
    tier: "read",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
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
    output: "action",
    summary: "Extract an archive into a directory to inspect (never in place)",
    description: `Extracts the newest (or a named) archive into --to/<archive>/ so you can copy back what you need. It never overwrites the live system.`,
    tier: "mutate",
    args: [
      { name: "archive", type: "string", description: "Archive file name (default: newest)." },
      {
        name: "to",
        type: "string",
        description: "Directory to extract into (default /var/tmp/archon-restore).",
      },
    ],
    async run(a: Parsed, ctx: RunContext): Promise<number> {
      const { backupRestore } = await import("../backup/backup.ts");
      const r = await backupRestore(
        await requireHost(ctx.hostName),
        a["archive"] as string | undefined,
        (a["to"] as string | undefined) ?? "/var/tmp/archon-restore",
      );
      stdio.stdout.writeSync(`${r.archive} extracted to ${r.dir}\n`);
      return 0;
    },
  },
  {
    name: "guest sync",
    output: "action",
    summary: "Create and start the LXD guests the model declares",
    description: `Creates missing LXD instances (containers or VMs) from the host model and starts stopped ones (spec 017). Never deletes: instances not in the model are listed and kept.`,
    tier: "mutate",
    operation: true,
    args: [],
    async run(_a: Parsed, ctx: RunContext): Promise<number> {
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
            ? `guests: ${[...created.map((n) => `+${n}`), ...deleted.map((n) => `-${n}`)].join(
                " ",
              )}`
            : "✗ guest sync failed",
          level: ok ? "info" : "fail",
          what: [
            created.length ? `Created: ${created.join(", ")}` : "",
            deleted.length ? `Deleted: ${deleted.join(", ")}` : "",
            ok ? "" : "archon guest sync failed; see the log.",
          ]
            .filter(Boolean)
            .join("\n"),
          ...(ok ? {} : { todo: "archon guest sync shows each failure with its fix." }),
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
  "connector add",
  "connector list",
  "connector remove",
  "connector test",
  "proposal import",
  "proposal list",
  "proposal show",
  "proposal accept",
  "proposal reject",
  "risks list",
  "risks check",
  "risks review",
  "vendors list",
  "vendors triage",
  "estate query",
  "estate build",
  "estate osquery",
  "estate diff",
  "estate schema",
  "device add",
  "device observe",
  "device check",
  "device remove",
  "host integrate",
  "pair",
  "mesh",
  "host accept",
  "compliance",
  "compliance catalog",
  "compliance drift",
  "compliance impact",
  "controls list",
  "controls run",
  "controls test",
  "compliance export",
  "compliance fedramp",
  "export list",
  "export run",
  "export schedule",
  "export credential",
  "evidence export",
  "evidence verify",
  "trust build",
  "audit open",
  "audit bundle",
  "audit access",
  "audit request",
  "audit respond",
  "audit sample",
  "audit close",
  "audit list",
  "audit show",
  "audit portal",
  "audit export",
  "audit verify",
  "people status",
  "people review",
  "people ack",
  "console",
  "devices",
  "devices approve",
  "devices revoke",
  "discover",
  "connect",
  "estate observe",
  "estate check",
  "estate assets",
  "disconnect",
  "host adopt",
  "host observe",
  "host check",
  "host release",
  "network discover",
  "network adopt",
  "network status",
  "network check",
  "network inventory",
  "network changes",
  "fleet query",
  "tag add",
  "tag remove",
  "tag accept",
  "tag list",
  "validate",
  "build",
  "fleet use",
  "fleet init",
  "fleet status",
  "clients add",
  "clients list",
  "clients remove",
  "clients use",
  "clients summary",
  "clients report",
  "clients console",
  "host add",
  "where",
  "fleet upgrade",
  "fleet trust",
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
  c.place ??=
    c.name === "explain" || c.name === "docs" ? "both" : PC_COMMANDS.has(c.name) ? "pc" : "machine";
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
    const cmd = COMMANDS.find(
      (c) => (c.name === name || c.aliases?.includes(name)) && offeredOn(c, place),
    );
    if (cmd) return { cmd, rest: argv.slice(n) };
  }
  return undefined;
}

export type { Parsed };
