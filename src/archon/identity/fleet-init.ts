/**
 * `stolos fleet init` (spec 003): the fleet's identity, from your GitHub
 * account as `gh` reports it. Runs on the boot machine (Windows or Linux).
 * Public data goes into fleets/<fleet>/fleet.ts; the admin password hash goes
 * only into the boot machine's secret store (Article 13).
 *
 * @module
 */
// Spec: 003-identity
// Spec: 097-controller FR-001
// Spec: 100-remote-access FR-001
// Spec: 108-tags FR-003
// Spec: 114-release-record FR-005

import { fs, path as paths, proc, stdio, tty } from "@intellectual-frontiers/commons/ts/runtime";
import { cryptSalt, sha512Crypt } from "@intellectual-frontiers/crypto";
import { tsLiteral } from "@intellectual-frontiers/formats";
import { P, resetRoots } from "../core/paths.ts";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { SECRETS, writeSecret } from "../core/secrets.ts";
import type { FleetDef, GitHubIdentity } from "../model/types.ts";

/** What stolos fleet init is given. */
export interface FleetInitOptions {
  /** The new fleet's id: fleets/<id>/ (spec 046). Without it, the active fleet. */
  id?: string | undefined;
  /** Your Unix account name on every host. */
  user?: string | undefined;
  /** An IANA time zone (default: this machine's). */
  timezone?: string | undefined;
  /** A locale (default en_US.UTF-8). */
  locale?: string | undefined;
  /** A keyboard layout (default us). */
  keyboard?: string | undefined;
  /** Read the admin password from stdin instead of prompting (automation). */
  passwordStdin?: boolean | undefined;
  /** Rewrite fleets/<fleet>/fleet.ts even though it exists (otherwise it is kept). */
  rewrite?: boolean | undefined;
}

/** GitHub's anonymized commit address for an account. */
export function noreply(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

/**
 * Spec 108-tags FR-003: a new fleet comes with its tags, the starter kit (`fleets/<fleet>/tags.ts`), to edit freely. Written only
 * where the file is missing; true when it was written.
 */
export async function writeStarterTags(fleetDir: string): Promise<boolean> {
  const file = paths.join(fleetDir, "tags.ts");
  if (await fs.exists(file)) return false;
  const { starterTagsSource } = await import("../model/tags.ts");
  await fs.mkdir(fleetDir, { recursive: true });
  await fs.writeTextFile(file, starterTagsSource());
  return true;
}

/** Your GitHub account, as gh reports it, with your public SSH keys. */
export async function githubIdentity(): Promise<GitHubIdentity> {
  const r = await run(["gh", "api", "user"]);
  if (!r.ok) {
    throw new Error(
      `gh is not signed in (${r.stderr
        .trim()
        .split("\n")
        .pop()}); run: gh auth login --web --git-protocol https`,
    );
  }
  const u = JSON.parse(r.stdout) as { login: string; id: number; name: string | null };
  const url = `https://github.com/${u.login}.keys`;
  const res = await fetch(url).catch((e) => {
    throw new Error(`could not read your SSH keys from ${url}: ${(e as Error).message}`);
  });
  if (!res.ok) throw new Error(`could not read your SSH keys from ${url}: HTTP ${res.status}`);
  const keys = (await res.text())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    login: u.login,
    id: u.id,
    name: u.name || u.login,
    email: noreply(u.id, u.login),
    sshKeys: keys,
  };
}

/** The fleet repository's owner/name, from its origin. */
export async function repositorySlug(): Promise<string> {
  const r = await run(["git", "-C", P.repo, "remote", "get-url", "origin"]);
  const m = r.stdout.trim().match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/);
  if (!m?.[1]) throw new Error("the checkout has no GitHub origin; clone it from GitHub first");
  return m[1];
}

/**
 * Read a line without echoing the characters: a `*` per character shows the
 * keystrokes arrive (Windows Terminal, PowerShell, and Linux terminals).
 */
export async function readHidden(question: string): Promise<string> {
  const enc = new TextEncoder();
  const out = (t: string) => stdio.stderr.writeSync(enc.encode(t));
  out(question);
  if (!tty.isTerminal("stdin")) {
    // Piped (a password manager's CLI, or a test): one line from stdin, nothing echoed.
    out("\n");
    return await readLine();
  }
  tty.setRaw(true);
  const buf = new Uint8Array(64);
  const bytes: number[] = [];
  try {
    read: while (true) {
      const n = await stdio.stdin.read(buf);
      if (n === null) break;
      for (const c of buf.subarray(0, n)) {
        if (c === 13 || c === 10) break read;
        if (c === 3) throw new Error("cancelled");
        if (c === 127 || c === 8) {
          // Drop one whole UTF-8 character.
          while (((bytes.at(-1) ?? 0) & 0xc0) === 0x80) bytes.pop();
          if (bytes.length) {
            bytes.pop();
            out("\b \b");
          }
        } else if (c >= 32) {
          bytes.push(c);
          if ((c & 0xc0) !== 0x80) out("*");
        }
      }
    }
  } finally {
    tty.setRaw(false);
    out("\n");
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

async function readStdin(): Promise<string> {
  return (await new Response(stdio.stdin.readable).text()).replace(/\r?\n$/, "");
}

function sshDir(): string {
  const home = proc.env.get("USERPROFILE") ?? proc.env.get("HOME") ?? ".";
  return `${home}/.ssh`;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return (await fs.readTextFile(path)).trim();
  } catch {
    return undefined;
  }
}

/** Run a command attached to this terminal (ssh-keygen and gh may ask questions). */
async function interactive(argv: string[]): Promise<boolean> {
  try {
    const r = await proc.output(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return r.success;
  } catch {
    return false;
  }
}

/**
 * Your GitHub account has no SSH public key, so you could not log in to a
 * host. Use this PC's key (or make one with ssh-keygen) and add it to GitHub
 * with gh. Only the public half leaves this PC.
 */
export async function addLocalKey(login: string): Promise<string[]> {
  const dir = sshDir();
  const names = ["id_ed25519", "id_ecdsa", "id_rsa"];
  let pub: string | undefined;
  let path = "";
  for (const n of names) {
    path = `${dir}/${n}.pub`;
    pub = await readText(path);
    if (pub) break;
  }
  stdio.stderr.writeSync(
    `\nYour GitHub account (${login}) has no SSH public keys, so you could not log in to your hosts.\n`,
  );
  if (!pub) {
    path = `${dir}/id_ed25519.pub`;
    if (!confirm(`Create an SSH key on this PC now (${dir}/id_ed25519)?`)) {
      throw new Error(
        "no SSH key: add one at https://github.com/settings/keys, then run stolos fleet init again",
      );
    }
    await fs.mkdir(dir, { recursive: true });
    stdio.stderr.writeSync(
      "ssh-keygen asks for an optional passphrase that protects the key on this PC.\n",
    );
    if (!(await interactive(["ssh-keygen", "-t", "ed25519", "-f", `${dir}/id_ed25519`]))) {
      throw new Error(
        "ssh-keygen failed; on Windows: Settings, System, Optional features, OpenSSH Client",
      );
    }
    pub = await readText(path);
    if (!pub) throw new Error(`ssh-keygen wrote no ${path}`);
  }
  if (!confirm(`Add ${path} to your GitHub account with gh?`)) {
    throw new Error(
      `add ${path} at https://github.com/settings/keys, then run stolos fleet init again`,
    );
  }
  const title = `archon ${proc.hostname()}`;
  let added = await interactive(["gh", "ssh-key", "add", path, "--title", title]);
  if (!added) {
    // gh's default sign-in cannot add keys: grant that one extra scope, then retry.
    stdio.stderr.writeSync(
      "gh needs permission to add SSH keys; it opens your browser once to ask.\n",
    );
    if (
      await interactive(["gh", "auth", "refresh", "-h", "github.com", "-s", "admin:public_key"])
    ) {
      added = await interactive(["gh", "ssh-key", "add", path, "--title", title]);
    }
  }
  if (!added) {
    throw new Error(
      `could not add the key with gh; add ${path} at https://github.com/settings/keys, then run stolos fleet init again`,
    );
  }
  // github.com/<login>.keys can lag a moment behind; use the key just added.
  return [pub.split(/\s+/).slice(0, 2).join(" ")];
}

/** fleet.ts as fleet init writes it. */
export function fleetSource(f: FleetDef): string {
  return `// The fleet (spec 003). Written by \`stolos fleet init\` from your GitHub
// account; public data only. Edit freely, then \`stolos build\`.

import type { FleetDef } from "@intellectual-frontiers/stolos/archon/model/types";

export const fleet: FleetDef = ${tsLiteral(f)};
`;
}

/** A fleet id: a folder name and a DNS label (lowercase letters, digits, hyphens). */
export const FLEET_ID = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$|^[a-z]$/;

/**
 * The repository a new fleet goes into: ARCHON_REPO, else the nearest folder
 * at or above the working directory that holds fleets/, else the working
 * directory (a new, empty repository).
 */
export function initRepository(cwd = proc.cwd()): string {
  const env = proc.env.get("ARCHON_REPO");
  if (env) return paths.resolve(env);
  let d = paths.resolve(cwd);
  for (;;) {
    try {
      if (fs.statSync(paths.join(d, "fleets")).isDirectory) return d;
    } catch {
      /* keep looking */
    }
    const up = paths.dirname(d);
    if (up === d) return paths.resolve(cwd);
    d = up;
  }
}

/**
 * `fleet init <id>`: make fleets/<id>/ the active fleet and, in a repository
 * without them, write package.json (the engine pinned by its release URL), the
 * entry files, and bun.lock (spec 096 FR-006).
 */
async function prepareRepository(id: string): Promise<void> {
  if (!FLEET_ID.test(id)) {
    throw new Error(
      `fleet id ${JSON.stringify(
        id,
      )}: use lowercase letters, digits, and hyphens (it names a folder and a DNS label)`,
    );
  }
  const repo = initRepository();
  proc.env.set("ARCHON_REPO", repo);
  proc.env.set("ARCHON_FLEET", id);
  resetRoots();
  const r = ui.phase("Repository");
  await fs.mkdir(paths.join(repo, "fleets", id), { recursive: true });
  const { scaffoldRepository } = await import("../fleet/scaffold.ts");
  const { TAG } = await import("../version.ts");
  const tag = TAG;
  const written = await scaffoldRepository(repo, tag);
  // The lock is what makes the pin safe (bun run stolos docs fleet-repository): bun install
  // records the engine's integrity in bun.lock, and puts its files where VS Code finds its types.
  const fresh = written.includes("package.json");
  r.status(
    fresh
      ? `pinning the engine at ${tag} and recording its integrity in bun.lock`
      : "installing the pinned engine (checked against bun.lock)",
  );
  const { installDependencies } = await import("../install/bun.ts");
  const install = await installDependencies(repo, { frozen: !fresh });
  if (!install.ok) {
    r.warn(
      `${fresh ? `wrote ${written.join(", ")}, but ` : ""}the engine could not be installed: ${
        install.stderr.trim().split("\n").pop() ?? `exit ${install.code}`
      }`,
      `when the network is back: bun install (in ${repo})`,
    );
    return;
  }
  r.done(
    fresh
      ? `${repo} · fleets/${id}/ · wrote ${written.join(", ")}, bun.lock (engine ${tag})`
      : `${repo} · fleets/${id}/ · the engine pin in package.json is kept, its files here`,
  );
}

/** stolos fleet init: the fleet (and a new repository's files), from your GitHub account. */
export async function fleetInit(o: FleetInitOptions): Promise<void> {
  if (o.id) await prepareRepository(o.id);
  const p = ui.phase("GitHub");
  p.status("reading your account with gh");
  const gh = await githubIdentity();
  if (!gh.sshKeys.length) {
    ui.pause();
    gh.sshKeys = await addLocalKey(gh.login);
    ui.resume();
  }
  p.done(`${gh.login} (${gh.name}) · ${gh.sshKeys.length} SSH key(s) · ${gh.email}`);

  const slug = await repositorySlug();
  // No id and no fleet yet: the fleet is named after the repository's owner.
  if (!o.id && !P.fleetId) await prepareRepository((slug.split("/")[0] ?? "").toLowerCase());
  // A model that already exists keeps its admin account (a rebuilt boot machine).
  const { fleetExport } = await import("../model/load.ts");
  const existing =
    (await fs.exists(P.fleet)) && !o.rewrite
      ? await fleetExport<FleetDef>(P.fleet, "fleet").catch(() => undefined)
      : undefined;
  const user =
    existing?.admin.user ??
    o.user ??
    (prompt(`Unix account name for you on every host [${gh.login.toLowerCase()}]:`) ||
      gh.login.toLowerCase());
  const tz = o.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fleet: FleetDef = {
    id: P.fleetId,
    title: `${gh.name}'s fleet`,
    repository: { slug, url: `https://github.com/${slug}` },
    ubuntu: { release: "26.04", codename: "resolute" },
    timezone: tz,
    locale: o.locale ?? "en_US.UTF-8",
    keyboard: o.keyboard ?? "us",
    admin: { user, uid: 1000, github: gh },
  };

  // Ask before the Password phase starts: its spinner would draw over the prompt.
  let pw: string;
  if (o.passwordStdin) pw = await readStdin();
  else {
    while (true) {
      pw = await readHidden(`Admin password for ${user} (console, AMT, and sudo): `);
      if (pw.length < 8) {
        stdio.stderr.writeSync("Use at least 8 characters.\n");
        continue;
      }
      if (pw === (await readHidden("Again: "))) break;
      stdio.stderr.writeSync("The passwords differ; try again.\n");
    }
  }
  if (pw.length < 8) throw new Error("use at least 8 characters");
  const s = ui.phase("Password");
  s.status("hashing");
  const salt = cryptSalt(crypto.getRandomValues(new Uint8Array(16)));
  await writeSecret(SECRETS.adminPasswordHash, (await sha512Crypt(pw, salt)) + "\n");
  s.done(`hash stored on this machine only (${SECRETS.adminPasswordHash})`);
  // Spec 029: a git pre-push hook that reminds you to back up the secrets (never blocks).
  const { installPrePushHook } = await import("../vault/reminder.ts");
  await installPrePushHook().catch(() => false);

  const w = ui.phase("Fleet");
  // An existing model is kept (a rebuilt boot machine needs only its secrets
  // again): rewriting it would drop everything added since (site, mail, ...).
  const kept = (await fs.exists(P.fleet)) && !o.rewrite;
  await fs.mkdir(P.fleetDir, { recursive: true });
  // This checkout now works on the new fleet, without --fleet (stolos fleet use).
  const { chooseFleet } = await import("../fleet/use.ts");
  await chooseFleet(P.fleetId);
  if (!kept) await fs.writeTextFile(P.fleet, fleetSource(fleet));
  if (!kept) await writeStarterTags(P.fleetDir);
  // Commits from this checkout carry your GitHub identity (noreply address),
  // set for this repository only; a global identity, if any, is left alone.
  await run(["git", "-C", P.repo, "config", "user.name", gh.name]);
  await run(["git", "-C", P.repo, "config", "user.email", gh.email]);
  if (kept) {
    w.done(
      `fleets/<fleet>/fleet.ts exists (kept; --rewrite starts it over) · git commits as ${gh.email}`,
    );
    ui.next.push(
      "the admin password hash is stored again; hosts keep theirs until their next install or apply",
      "a rebuilt boot machine: bun run stolos vault recover-host-keys <host> for each host (bun run stolos docs disaster-recovery)",
    );
    await (await import("../adopt/controller.ts")).recordController();
    await proposeConsoleNames();
    return;
  }
  w.done(
    `fleets/<fleet>/fleet.ts · admin ${user} · ${tz} · ${fleet.locale} · git commits as ${gh.email}`,
  );
  ui.next.push(
    "next: your signing keys (spec 057): bun run stolos keys setup",
    `then: bun run stolos apply -m "${P.fleetId || "<fleet>"}: the fleet and its signers"`,
    "then: bun run stolos (it shows the next step)",
  );
  // Spec 097: this PC is a fleet machine too.
  await (await import("../adopt/controller.ts")).recordController();
  await proposeConsoleNames();
}

/**
 * Spec 100 FR-001: with a web domain, propose the Stolos Console's names under it (asked; the
 * defaults when there is no terminal). Never fails fleet init.
 */
async function proposeConsoleNames(): Promise<void> {
  try {
    const { loadFleet } = await import("../model/load.ts");
    const fleet = await loadFleet();
    if (!fleet.web || fleet.stolos?.console) return;
    const { controllerName } = await import("../adopt/controller.ts");
    const { consoleNamesSetup } = await import("../access/commands.ts");
    await consoleNamesSetup(await controllerName());
  } catch {
    /* the names can be set later: bun run stolos console --lan */
  }
}

/** One line from a piped stdin (bytes up to the first newline; the rest is left for the next call). */
const pending: number[] = [];
async function readLine(): Promise<string> {
  const buf = new Uint8Array(256);
  for (;;) {
    const nl = pending.indexOf(10);
    if (nl >= 0) {
      const line = pending.splice(0, nl + 1).slice(0, -1);
      return new TextDecoder().decode(new Uint8Array(line)).replace(/\r$/, "");
    }
    const n = await stdio.stdin.read(buf);
    if (n === null) {
      const rest = pending.splice(0);
      return new TextDecoder().decode(new Uint8Array(rest)).replace(/\r$/, "");
    }
    pending.push(...buf.subarray(0, n));
  }
}
