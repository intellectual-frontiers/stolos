/**
 * 041-s3: S3 object storage (RustFS), an opt-in container (spec 040), managed
 * with archon fs s3. Identities are Linux accounts: every person on the server
 * and every fleet service account has an S3 user of the same name, allowed the
 * buckets named <name>-*. S3 signs requests with a secret the server keeps, so
 * it cannot use the Linux password (Archon never puts a Linux password where it
 * can be read back): each account's secret is generated on the server, and only
 * that account (and root) can read it.
 *
 * @module
 */

import { dirname, join } from "../core/path.ts";
import { ensureDir, exists, readTextOr } from "../core/fsx.ts";
import { currentUser, homeDir, isRoot, run } from "../core/exec.ts";
import { journal } from "../core/log.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import type { FleetDef, HostDef, UserDef } from "../model/types.ts";
import { fqdn } from "../web/config.ts";
import { newPassword, upsertSection } from "../pg/config.ts";
import { S3 } from "../containers/catalog.ts";
import type { Sink } from "../pg/converge.ts";

export const S3_PATHS = {
  dir: dirname(S3.secrets),
  /** The admin alias for rc inside the container (root only). */
  rcEnv: join(dirname(S3.secrets), "rc.env"),
  /** Each account's own secret, 0400 (P.keys: anyone may pass, nobody may list). */
  keys: "/var/lib/archon-keys/s3",
  admin: "archon-root",
  alias: "archon",
} as const;

/** The S3 users: every person on the server (not ops) and every fleet service account. */
export function s3Identities(users: UserDef[], fleet: FleetDef): string[] {
  return [
    ...users.filter((u) => u.name !== "ops").map((u) => u.name),
    ...(fleet.services ?? []).map((s) => s.name),
  ];
}

/** Each identity's policy: list buckets; everything in its own buckets, <name>-*. */
export function s3Policy(name: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:ListAllMyBuckets", "s3:GetBucketLocation"],
        Resource: ["arn:aws:s3:::*"],
      },
      {
        Effect: "Allow",
        Action: ["s3:*"],
        Resource: [`arn:aws:s3:::${name}-*`, `arn:aws:s3:::${name}-*/*`],
      },
    ],
  });
}

export const s3Name = (fleet: FleetDef, host: HostDef) => {
  const n = fqdn(fleet, host);
  return { api: `s3.${n ?? host.name}`, console: `s3-console.${n ?? host.name}` };
};

/** Before the container first starts: its admin credentials, root only (never in /etc). */
export async function prepareS3(s: Sink): Promise<void> {
  if (await exists(S3.secrets)) return;
  s.change(`${S3.secrets} (S3 admin credentials, root only)`);
  if (s.check) return;
  const secret = newPassword();
  await ensureDir(S3_PATHS.dir);
  await Deno.chmod(S3_PATHS.dir, 0o700);
  await Deno.writeTextFile(
    S3.secrets,
    `RUSTFS_ACCESS_KEY=${S3_PATHS.admin}\nRUSTFS_SECRET_KEY=${secret}\n`,
    { mode: 0o600 },
  );
  await Deno.writeTextFile(
    S3_PATHS.rcEnv,
    `RC_HOST_${S3_PATHS.alias}=http://${S3_PATHS.admin}:${secret}@127.0.0.1:9000\n`,
    { mode: 0o600 },
  );
}

/**
 * rc, the RustFS CLI inside the container, as the admin. A secret travels in
 * Podman's own environment (`-e NAME` copies it in): never on a command line,
 * where a process list would show it.
 */
function rc(args: string[], o: { stdin?: string; secret?: string } = {}) {
  return run(
    [
      "podman",
      "exec",
      "-i",
      "--env-file",
      S3_PATHS.rcEnv,
      ...(o.secret ? ["-e", "ARCHON_S3_SECRET"] : []),
      `archon-${S3.name}`,
      "rc",
      ...args,
    ],
    { stdin: o.stdin ?? "", env: o.secret ? { ARCHON_S3_SECRET: o.secret } : undefined },
  );
}

async function ready(timeoutMs = 120_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await run(["curl", "-fsS", "-o", "/dev/null", "--max-time", "3", S3.health])).ok) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

const keyPath = (name: string) => join(S3_PATHS.keys, name);

/** Give an S3 user this secret (through Podman's environment, never argv); an error, or undefined. */
async function setSecret(name: string, secret: string): Promise<string | undefined> {
  const pw = await rc(
    ["admin", "user", "passwd", S3_PATHS.alias, name, "--password-from-env", "ARCHON_S3_SECRET"],
    { secret },
  );
  return pw.ok ? undefined : (pw.stderr || pw.stdout).trim().split("\n").pop();
}

/** The account's key file: 0400, owned by the account (root for a name without one). */
async function writeKey(name: string, secret: string): Promise<void> {
  const path = keyPath(name);
  await ensureDir(S3_PATHS.keys);
  await Deno.chmod(S3_PATHS.keys, 0o711);
  const owner = (await run(["getent", "passwd", name])).ok ? name : "root";
  const tmp = `${path}.archon-${Deno.pid}`;
  await Deno.writeTextFile(tmp, secret + "\n", { mode: 0o400 });
  await Deno.chmod(tmp, 0o400);
  await run(["chown", `${owner}:root`, tmp]);
  await Deno.rename(tmp, path);
  await Deno.writeTextFile(path + ".set", new Date().toISOString() + "\n", { mode: 0o600 });
}

/**
 * Every identity has its S3 user, its secret (readable by that account only),
 * and its policy; an identity Archon made that is not a person here or a fleet
 * service account is disabled.
 */
export async function convergeS3(
  plan: { host: HostDef; fleet: FleetDef; users: UserDef[] },
  s: Sink,
): Promise<boolean> {
  const want = s3Identities(plan.users, plan.fleet);
  const have: string[] = [];
  if (await exists(S3_PATHS.keys)) {
    for await (const e of Deno.readDir(S3_PATHS.keys)) {
      if (e.isFile && !e.name.includes(".")) have.push(e.name);
    }
  }
  const todo = want;
  if (s.check) {
    for (const w of want.filter((w) => !have.includes(w))) s.change(`S3 user ${w}`);
    for (const h of have.filter((h) => !want.includes(h))) s.change(`disable S3 user ${h}`);
    return true;
  }
  if (!(await ready())) {
    s.fail("S3 (RustFS) did not become ready in 2 minutes", "journalctl -u archon-s3 -n 50");
    return false;
  }
  await ensureDir(S3_PATHS.keys);
  await Deno.chmod(S3_PATHS.keys, 0o711);
  for (const name of todo) {
    const path = keyPath(name);
    let secret = (await readTextOr(path))?.trim();
    const fresh = !secret;
    if (!secret) secret = newPassword();
    const known = (await rc(["admin", "user", "info", S3_PATHS.alias, name])).ok;
    if (!known) {
      // rc takes a new user's secret as an argument; a throwaway one, replaced at once below.
      const add = await rc(["admin", "user", "add", S3_PATHS.alias, name, newPassword()]);
      if (!add.ok) {
        s.fail(`S3 user ${name}: ${(add.stderr || add.stdout).trim().split("\n").pop()}`);
        continue;
      }
    }
    if (fresh || !known || !(await exists(path + ".set"))) {
      const bad = await setSecret(name, secret);
      if (bad) {
        s.fail(`S3 secret for ${name}: ${bad}`);
        continue;
      }
      const pol = await rc(
        ["admin", "policy", "create", S3_PATHS.alias, `archon-${name}`, "/dev/stdin"],
        { stdin: s3Policy(name) },
      );
      const att = await rc([
        "admin",
        "policy",
        "attach",
        S3_PATHS.alias,
        `archon-${name}`,
        "--user",
        name,
      ]);
      if (!pol.ok || !att.ok) {
        s.fail(`S3 policy for ${name}: ${(pol.ok ? att : pol).stderr.trim().split("\n").pop()}`);
        continue;
      }
      await writeKey(name, secret);
      s.change(`S3 user ${name} (its key: archon fs s3 key, as ${name})`);
    }
  }
  for (const name of have.filter((h) => !want.includes(h))) {
    await rc(["admin", "user", "disable", S3_PATHS.alias, name]);
    await Deno.remove(keyPath(name)).catch(() => {});
    await Deno.remove(keyPath(name) + ".set").catch(() => {});
    s.change(`S3 user ${name} disabled (not a person here or a fleet service account)`);
  }
  return true;
}

// ------------------------------------------------------------------ commands

async function server(name: string) {
  const fleet = await loadFleet();
  const host = (await loadHosts()).find((h) => h.name === name);
  if (!host) throw new Error(`There is no host named ${name} in the model.`);
  return { fleet, host };
}

/** archon fs s3 status: on or off, since when, health, addresses, and (as root) its users. */
export async function s3Status(hostName: string, json: boolean): Promise<number> {
  const { fleet, host } = await server(hostName);
  const rec = host.optIn?.s3;
  const active = (await run(["systemctl", "is-active", `archon-${S3.name}.service`])).stdout.trim();
  const healthy = active === "active" &&
    (await run(["curl", "-fsS", "-o", "/dev/null", "--max-time", "3", S3.health])).ok;
  const users: string[] = [];
  if (isRoot() && (await exists(S3_PATHS.keys))) {
    for await (const e of Deno.readDir(S3_PATHS.keys)) {
      if (!e.name.includes(".")) users.push(e.name);
    }
  }
  const names = s3Name(fleet, host);
  const out = {
    on: rec?.enabled === true,
    since: rec?.at ?? null,
    by: rec?.by ?? null,
    unit: active,
    healthy,
    api: `https://${names.api}`,
    console: `https://${names.console}`,
    users: isRoot() ? users.sort() : null,
  };
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(
      out.on
        ? `S3 is on since ${
          out.since?.slice(0, 16).replace("T", " ")
        } UTC by ${out.by} · ${active}${healthy ? " · ready" : " · not ready"}`
        : `S3 is off${
          out.since ? ` since ${out.since.slice(0, 16).replace("T", " ")} UTC by ${out.by}` : ""
        } · turn it on: archon fs s3 on`,
    );
    console.log(`API:     ${out.api} (path-style: ${out.api}/<bucket>/<key>)`);
    console.log(`Console: ${out.console}`);
    if (out.users) console.log(`Users:   ${out.users.join(", ") || "none yet"}`);
    console.log("Your S3 user is your Linux username; your key: archon fs s3 key --write");
    console.log(
      "The console signs in with Account: your username and Key: your S3 secret (archon fs s3 key --show), not your Linux password.",
    );
  }
  return out.on && !healthy ? 1 : 0;
}

/**
 * archon fs s3 key: your access key (your username) and secret, readable only
 * by you. --write puts an AWS profile s3-<host> in ~/.aws/credentials and
 * ~/.aws/config (0600), replacing only that profile.
 */
export async function s3Key(
  hostName: string,
  write: boolean,
  json: boolean,
  show = false,
): Promise<number> {
  const { fleet, host } = await server(hostName);
  const me = currentUser();
  if (host.optIn?.s3?.enabled !== true) {
    console.error(`S3 is off on ${host.name}: an operator turns it on with archon fs s3 on.`);
    return 1;
  }
  let secret: string;
  try {
    secret = (await Deno.readTextFile(keyPath(me))).trim();
  } catch (e) {
    console.error(
      e instanceof Deno.errors.NotFound
        ? `${me} has no S3 key on ${host.name} yet: S3 users are the people on the server and the fleet's service accounts (the next apply makes it: archon update).`
        : `${me} cannot read ${keyPath(me)}: ${
          (e as Error).message
        } (it should be 0400 and owned by ${me}; archon update sets it).`,
    );
    return 1;
  }
  const names = s3Name(fleet, host);
  const profile = `s3-${host.name}`;
  const endpoint = `https://${names.api}`;
  const consoleLogin =
    `Web console: https://${names.console}: Account ${me}, Key your secret (archon fs s3 key --show), not your Linux password.`;
  if (show) {
    // The person's own secret, on their own terminal: never JSON, a pipe, or a log.
    if (json || !Deno.stdout.isTerminal()) {
      console.error("--show prints the secret only on a terminal (not JSON, not a pipe).");
      return 2;
    }
    console.log(secret);
    console.error(`Paste it as the Key at https://${names.console} (Account: ${me}).`);
    return 0;
  }
  if (!write) {
    if (json) {
      console.log(
        JSON.stringify(
          { ok: true, profile, endpoint, accessKey: me, region: "us-east-1" },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `Access key: ${me}\nSecret:     (in your key file; archon fs s3 key --write puts it in ~/.aws)\nEndpoint:   ${endpoint} (path-style)\nBuckets:    ${me}-*\n${consoleLogin}`,
      );
    }
    return 0;
  }
  const home = Deno.env.get("HOME") ?? await homeDir(me);
  const aws = join(home, ".aws");
  await ensureDir(aws);
  await Deno.chmod(aws, 0o700);
  const write0600 = async (path: string, content: string) => {
    const tmp = `${path}.archon-${Deno.pid}`;
    await Deno.writeTextFile(tmp, content, { mode: 0o600 });
    await Deno.chmod(tmp, 0o600);
    await Deno.rename(tmp, path);
  };
  const creds = join(aws, "credentials");
  const config = join(aws, "config");
  await write0600(
    creds,
    upsertSection(
      (await readTextOr(creds)) ?? "",
      profile,
      `[${profile}]\naws_access_key_id = ${me}\naws_secret_access_key = ${secret}\n`,
    ),
  );
  await write0600(
    config,
    upsertSection(
      (await readTextOr(config)) ?? "",
      `profile ${profile}`,
      `[profile ${profile}]\nendpoint_url = ${endpoint}\nregion = us-east-1\ns3 =\n    addressing_style = path\n`,
    ),
  );
  await journal("archon-s3", `${me} wrote their S3 profile ${profile}`);
  if (json) {
    console.log(
      JSON.stringify(
        { ok: true, profile, endpoint, accessKey: me, files: { credentials: creds, config } },
        null,
        2,
      ),
    );
  } else {console.log(
      `Wrote the ${profile} profile (0600). Try: aws --profile ${profile} s3 mb s3://${me}-files`,
    );}
  return 0;
}

/**
 * archon fs s3 key --rotate: a new secret for the caller's S3 user, set in
 * RustFS and written to their key file at once, so the old one stops working.
 * Runs as root (sudo); the account is the person behind sudo. The secret is
 * never printed, logged, or journaled; only that it changed.
 */
export async function s3Rotate(hostName: string): Promise<number> {
  const { host } = await server(hostName);
  const who = Deno.env.get("SUDO_USER") || currentUser();
  if (!who || who === "root") {
    console.error(
      "Rotate as the account whose key it is: archon fs s3 key --rotate (it asks sudo).",
    );
    return 2;
  }
  if (host.optIn?.s3?.enabled !== true) {
    console.error(`S3 is off on ${host.name}: an operator turns it on with archon fs s3 on.`);
    return 1;
  }
  if (!isRoot()) {
    console.error("Rotating a key needs root (archon elevates through sudo).");
    return 1;
  }
  if (!(await exists(keyPath(who)))) {
    console.error(
      `${who} has no S3 key on ${host.name} yet (the next apply makes it: archon update).`,
    );
    return 1;
  }
  const secret = newPassword();
  const bad = await setSecret(who, secret);
  if (bad) {
    console.error(`S3 secret for ${who} was not changed: ${bad}`);
    return 1;
  }
  await writeKey(who, secret);
  await journal("archon-s3", `S3 secret for ${who} rotated`);
  console.log(
    `${who}'s S3 secret is new; the old one no longer works. Update what uses it: archon fs s3 key --write (~/.aws), and archon fs s3 key --show for the web console.`,
  );
  return 0;
}
