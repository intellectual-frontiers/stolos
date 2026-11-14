/**
 * `stolos fleet init` (spec 003): the fleet's identity, from your GitHub
 * account as `gh` reports it. Runs on the boot machine (Windows or Linux).
 * Public data goes into fleets/<fleet>/fleet.ts; the admin password hash goes
 * only into the boot machine's secret store (Article 13).
 *
 * @module
 */

import { P, resetRoots } from "../core/paths.ts";
import { exists } from "../core/fsx.ts";
import { dirname, join, resolve, toFileUrl } from "../core/path.ts";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { sha512Crypt } from "../core/crypt.ts";
import { SECRETS, writeSecret } from "../core/secrets.ts";
import type { FleetDef, GitHubIdentity } from "../model/types.ts";

/** What stolos fleet init is given. */
export interface FleetInitOptions {
  /** The new fleet's id: fleets/<id>/ (spec 046). Without it, the active fleet. */
  id?: string;
  /** Your Unix account name on every host. */
  user?: string;
  /** An IANA time zone (default: this machine's). */
  timezone?: string;
  /** A locale (default en_US.UTF-8). */
  locale?: string;
  /** A keyboard layout (default us). */
  keyboard?: string;
  /** Read the admin password from stdin instead of prompting (automation). */
  passwordStdin?: boolean;
  /** Rewrite fleets/<fleet>/fleet.ts even though it exists (otherwise it is kept). */
  rewrite?: boolean;
}

/** GitHub's anonymized commit address for an account. */
export function noreply(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

/** Your GitHub account, as gh reports it, with your public SSH keys. */
export async function githubIdentity(): Promise<GitHubIdentity> {
  const r = await run(["gh", "api", "user"]);
  if (!r.ok) {
    throw new Error(
      `gh is not signed in (${
        r.stderr.trim().split("\n").pop()
      }); run: gh auth login --web --git-protocol https`,
    );
  }
  const u = JSON.parse(r.stdout) as { login: string; id: number; name: string | null };
  const url = `https://github.com/${u.login}.keys`;
  const res = await fetch(url).catch((e) => {
    throw new Error(`could not read your SSH keys from ${url}: ${(e as Error).message}`);
  });
  if (!res.ok) throw new Error(`could not read your SSH keys from ${url}: HTTP ${res.status}`);
  const keys = (await res.text()).split("\n").map((l) => l.trim()).filter(Boolean);
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
  if (!m) throw new Error("the checkout has no GitHub origin; clone it from GitHub first");
  return m[1];
}

/**
 * Read a line without echoing the characters: a `*` per character shows the
 * keystrokes arrive (Windows Terminal, PowerShell, and Linux terminals).
 */
export async function readHidden(question: string): Promise<string> {
  const enc = new TextEncoder();
  const out = (t: string) => Deno.stderr.writeSync(enc.encode(t));
  out(question);
  if (!Deno.stdin.isTerminal()) {
    // Piped (a password manager's CLI, or a test): one line from stdin, nothing echoed.
    out("\n");
    return await readLine();
  }
  Deno.stdin.setRaw(true);
  const buf = new Uint8Array(64);
  const bytes: number[] = [];
  try {
    read: while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      for (const c of buf.subarray(0, n)) {
        if (c === 13 || c === 10) break read;
        if (c === 3) throw new Error("cancelled");
        if (c === 127 || c === 8) {
          // Drop one whole UTF-8 character.
          while (bytes.length && (bytes[bytes.length - 1] & 0xc0) === 0x80) bytes.pop();
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
    Deno.stdin.setRaw(false);
    out("\n");
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

async function readStdin(): Promise<string> {
  return (await new Response(Deno.stdin.readable).text()).replace(/\r?\n$/, "");
}

function sshDir(): string {
  const home = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME") ?? ".";
  return `${home}/.ssh`;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return (await Deno.readTextFile(path)).trim();
  } catch {
    return undefined;
  }
}

/** Run a command attached to this terminal (ssh-keygen and gh may ask questions). */
async function interactive(argv: string[]): Promise<boolean> {
  try {
    const r = await new Deno.Command(argv[0], {
      args: argv.slice(1),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).output();
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
  console.error(
    `\nYour GitHub account (${login}) has no SSH public keys, so you could not log in to your hosts.`,
  );
  if (!pub) {
    path = `${dir}/id_ed25519.pub`;
    if (!confirm(`Create an SSH key on this PC now (${dir}/id_ed25519)?`)) {
      throw new Error(
        "no SSH key: add one at https://github.com/settings/keys, then run stolos fleet init again",
      );
    }
    await Deno.mkdir(dir, { recursive: true });
    console.error("ssh-keygen asks for an optional passphrase that protects the key on this PC.");
    if (!await interactive(["ssh-keygen", "-t", "ed25519", "-f", `${dir}/id_ed25519`])) {
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
  const title = `archon ${Deno.hostname()}`;
  let added = await interactive(["gh", "ssh-key", "add", path, "--title", title]);
  if (!added) {
    // gh's default sign-in cannot add keys: grant that one extra scope, then retry.
    console.error("gh needs permission to add SSH keys; it opens your browser once to ask.");
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

import type { FleetDef } from "@stolos/archon/model/types.ts";

export const fleet: FleetDef = ${JSON.stringify(f, null, 2)};
`;
}

/** A fleet id: a folder name and a DNS label (lowercase letters, digits, hyphens). */
export const FLEET_ID = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$|^[a-z]$/;

/**
 * The repository a new fleet goes into: ARCHON_REPO, else the nearest folder
 * at or above the working directory that holds fleets/, else the working
 * directory (a new, empty repository).
 */
export function initRepository(cwd = Deno.cwd()): string {
  const env = Deno.env.get("ARCHON_REPO");
  if (env) return resolve(env);
  let d = resolve(cwd);
  for (;;) {
    try {
      if (Deno.statSync(join(d, "fleets")).isDirectory) return d;
    } catch { /* keep looking */ }
    const up = dirname(d);
    if (up === d) return resolve(cwd);
    d = up;
  }
}

/**
 * `fleet init <id>`: make fleets/<id>/ the active fleet and, in a repository
 * without them, write the pinned deno.json, the entry files, and deno.lock.
 */
async function prepareRepository(id: string): Promise<void> {
  if (!FLEET_ID.test(id)) {
    throw new Error(
      `fleet id ${
        JSON.stringify(id)
      }: use lowercase letters, digits, and hyphens (it names a folder and a DNS label)`,
    );
  }
  const repo = initRepository();
  Deno.env.set("ARCHON_REPO", repo);
  Deno.env.set("ARCHON_FLEET", id);
  resetRoots();
  const r = ui.phase("Repository");
  await Deno.mkdir(join(repo, "fleets", id), { recursive: true });
  const { scaffoldRepository } = await import("../fleet/scaffold.ts");
  const { VERSION } = await import("../version.ts");
  const tag = `v${VERSION}`;
  const written = await scaffoldRepository(repo, tag);
  if (!written.includes("deno.json")) {
    r.done(`${repo} · fleets/${id}/ · the engine pin in deno.json is kept`);
    return;
  }
  // The lock is what makes the pin safe (docs/fleet-repository.md): make it now.
  r.status(`pinning the engine at ${tag} and hashing every file into deno.lock`);
  const cache = await run([
    Deno.execPath(),
    "cache",
    "--allow-import",
    "--lock=deno.lock",
    "archon.ts",
    "stolos.ts",
    "engine.ts",
  ], { cwd: repo });
  if (!cache.ok) {
    r.warn(
      `wrote ${written.join(", ")}, but deno.lock could not be made: ${
        cache.stderr.trim().split("\n").pop()
      }`,
      `when the network is back: deno task stolos fleet upgrade ${tag}`,
    );
    return;
  }
  r.done(`${repo} · fleets/${id}/ · wrote ${written.join(", ")}, deno.lock (engine ${tag})`);
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
  if (!o.id && !P.fleetId) await prepareRepository(slug.split("/")[0].toLowerCase());
  // A model that already exists keeps its admin account (a rebuilt boot machine).
  const existing = (await exists(P.fleet)) && !o.rewrite
    ? await import(toFileUrl(P.fleet).href).then((m) => m.fleet as FleetDef).catch(() => undefined)
    : undefined;
  const user = existing?.admin.user ?? o.user ??
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
  let pw = "";
  if (o.passwordStdin) pw = await readStdin();
  else {
    while (true) {
      pw = await readHidden(`Admin password for ${user} (console, AMT, and sudo): `);
      if (pw.length < 8) {
        console.error("Use at least 8 characters.");
        continue;
      }
      if (pw === await readHidden("Again: ")) break;
      console.error("The passwords differ; try again.");
    }
  }
  if (pw.length < 8) throw new Error("use at least 8 characters");
  const s = ui.phase("Password");
  s.status("hashing");
  await writeSecret(SECRETS.adminPasswordHash, (await sha512Crypt(pw)) + "\n");
  s.done(`hash stored on this machine only (${SECRETS.adminPasswordHash})`);
  // Spec 029: a git pre-push hook that reminds you to back up the secrets (never blocks).
  const { installPrePushHook } = await import("../vault/reminder.ts");
  await installPrePushHook().catch(() => false);

  const w = ui.phase("Fleet");
  // An existing model is kept (a rebuilt boot machine needs only its secrets
  // again): rewriting it would drop everything added since (site, mail, ...).
  const kept = (await exists(P.fleet)) && !o.rewrite;
  await Deno.mkdir(P.fleetDir, { recursive: true });
  // This checkout now works on the new fleet, without --fleet (stolos fleet use).
  const { chooseFleet } = await import("../fleet/use.ts");
  await chooseFleet(P.fleetId);
  if (!kept) await Deno.writeTextFile(P.fleet, fleetSource(fleet));
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
      "a rebuilt boot machine: deno task stolos vault recover-host-keys <host> for each host (docs/disaster-recovery.md)",
    );
    return;
  }
  w.done(
    `fleets/<fleet>/fleet.ts · admin ${user} · ${tz} · ${fleet.locale} · git commits as ${gh.email}`,
  );
  ui.next.push(
    "next: your signing keys (spec 057): deno task stolos keys setup",
    `then: git add -A; git commit -m "${
      P.fleetId || "<fleet>"
    }: the fleet and its signers"; git push`,
    "then: deno task stolos (it shows the next step)",
  );
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
    const n = await Deno.stdin.read(buf);
    if (n === null) {
      const rest = pending.splice(0);
      return new TextDecoder().decode(new Uint8Array(rest)).replace(/\r$/, "");
    }
    pending.push(...buf.subarray(0, n));
  }
}
