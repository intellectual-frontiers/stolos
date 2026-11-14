// Specs 029 and 056: the vault (a ZIP backup), the backup panel, and the secret inventory's coverage.
// The flow tests run the real commands in a subprocess with a throwaway home.
import { assert, assertEquals } from "./assert.ts";
import { panelLines, width } from "../src/archon/vault/panel.ts";
import type { Assessment } from "../src/archon/vault/state.ts";
import { unzipSync, zipSync } from "npm:fflate@0.8.2";
import { targetOf } from "../src/archon/vault/restore.ts";
import { exists } from "../src/archon/core/fsx.ts";
import { secretFor } from "../src/archon/model/secret-inventory.ts";
import { SECRETS } from "../src/archon/core/secrets.ts";
import { P } from "../src/archon/core/paths.ts";
import { join } from "../src/archon/core/path.ts";
import { fingerprint, sandbox } from "./sandbox.ts";

// The real archon folders of this test process: they must not change (checked at the end).
const REAL = [join(P.secrets, ".."), join(P.bootCache, "..")];
const before = await fingerprint(REAL);

async function vaultSandbox() {
  const sb = await sandbox("archon-vault-test-");
  const home = sb.home;
  const secrets = join(home, "config", "stolos", "secrets", "lab");
  const put = async (rel: string, text: string) => {
    const path = join(secrets, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  };
  await put("admin-password.hash", "$6$fake$hash\n");
  await put("hosts/alpha/deploy_key", "PRIVATE-DEPLOY-KEY\n");
  await put("hosts/alpha/ssh_host_ed25519_key", "PRIVATE-HOST-KEY\n");
  await put("mail.json", '{"token":"t1"}\n');
  await put("install-tokens.json", "[]\n");
  const archon = (args: string[], stdin = "", extra: Record<string, string> = {}) =>
    sb.run("src/stolos/main.ts", args, stdin, extra);
  return { home, secrets, archon, put };
}

Deno.test("vault: status, backup (one ZIP with the secrets and the signing key), status again", async () => {
  const s = await vaultSandbox();
  try {
    let r = await s.archon(["vault", "status"]);
    assertEquals(r.code, 1, r.out);
    assert(r.out.includes("never been backed up"), r.out);
    assert(r.out.includes("hosts/alpha/deploy_key") && r.out.includes("alpha deploy key"), r.out);
    assert(!r.out.includes("PRIVATE-DEPLOY-KEY"), "never a value");

    // A signing key, as Git's settings name it (a sandboxed global config).
    const ssh = join(s.home, "ssh");
    await Deno.mkdir(ssh, { recursive: true });
    await Deno.writeTextFile(join(ssh, "fleet-signing"), "PRIVATE-SIGNING-KEY\n");
    await Deno.writeTextFile(join(ssh, "fleet-signing.pub"), "ssh-ed25519 AAAA me\n");
    const gitconfig = join(s.home, "gitconfig");
    await Deno.writeTextFile(
      gitconfig,
      `[user]\n\tsigningkey = ${join(ssh, "fleet-signing").replace(/\\/g, "/")}\n`,
    );
    const git = { GIT_CONFIG_GLOBAL: gitconfig };

    r = await s.archon(["vault", "backup"], "", git);
    assertEquals(r.code, 0, r.out);
    assert(r.out.includes("read back and checked"), r.out);
    assert(r.out.includes("Move it wherever you keep important things safe"), r.out);
    assert(r.out.includes("The ZIP itself is not encrypted"), r.out);
    const dir = join(s.home, "data", "stolos", "backup");
    const zips = [...Deno.readDirSync(dir)].map((e) => e.name);
    assertEquals(zips.length, 1, zips.join(","));
    assert(/^stolos-backup-.+-\d{8}T\d{6}Z\.zip$/.test(zips[0]), zips[0]);
    if (Deno.build.os !== "windows") {
      assertEquals((Deno.statSync(join(dir, zips[0])).mode ?? 0) & 0o777, 0o600, "owner only");
    }
    const files = unzipSync(Deno.readFileSync(join(dir, zips[0])));
    const text = (n: string) => new TextDecoder().decode(files[n]);
    assertEquals(text("secrets/lab/hosts/alpha/deploy_key"), "PRIVATE-DEPLOY-KEY\n");
    assertEquals(text("signing/fleet-signing"), "PRIVATE-SIGNING-KEY\n");
    assertEquals(text("signing/fleet-signing.pub"), "ssh-ed25519 AAAA me\n");
    assert(!files["secrets/lab/install-tokens.json"], "ephemeral secrets are left out");
    assert(text("RESTORE.txt").includes("deno task stolos vault restore <path to this ZIP>"));
    const manifest = JSON.parse(text("manifest.json"));
    assertEquals(manifest.files.map((f: { name: string }) => f.name).sort(), [
      "secrets/lab/admin-password.hash",
      "secrets/lab/hosts/alpha/deploy_key",
      "secrets/lab/hosts/alpha/ssh_host_ed25519_key",
      "secrets/lab/mail.json",
      "signing/fleet-signing",
      "signing/fleet-signing.pub",
    ]);
    assert(!JSON.stringify(manifest).includes("PRIVATE"), "the manifest holds no value");

    r = await s.archon(["vault", "status"]);
    assertEquals(r.code, 0, r.out);
    assert(r.out.includes("still in"), "a ZIP not yet moved is pointed out");
    r = await s.archon(["vault", "list"]);
    assert(r.out.includes(zips[0]), r.out);

    // Moved somewhere safe: still counts (the record), and no longer listed.
    await Deno.rename(join(dir, zips[0]), join(s.home, zips[0]));
    r = await s.archon(["vault", "status"]);
    assertEquals(r.code, 0, r.out);
    assert(!r.out.includes("still in"), r.out);

    // A changed secret is newer than the backup.
    await s.put("mail.json", '{"token":"t2"}\n');
    r = await s.archon(["vault", "status"]);
    assertEquals(r.code, 1);
    assert(/newer than your last backup/.test(r.out), r.out);
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("vault: restore without a ZIP only explains; backup without a signing key warns", async () => {
  const s = await vaultSandbox();
  try {
    const before = await fingerprint([join(s.home, "config"), join(s.home, "data")]);
    let r = await s.archon(["vault", "restore"]);
    assertEquals(r.code, 0, r.out);
    assert(r.out.includes("How to restore a stolos backup"), r.out);
    assert(r.out.includes("vault restore <path to this ZIP>"), r.out);
    assert(r.out.includes("Copy-Item") && r.out.includes("keys setup"), r.out);
    assertEquals(await fingerprint([join(s.home, "config"), join(s.home, "data")]), before);

    const empty = join(s.home, "empty-gitconfig");
    await Deno.writeTextFile(empty, "");
    r = await s.archon(["vault", "backup"], "", { GIT_CONFIG_GLOBAL: empty });
    assertEquals(r.code, 0, r.out);
    assert(r.out.includes("no signing key"), r.out);
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("vault: restore <zip> puts back every secret and both keys on a fresh PC, idempotent, never overwrites", async () => {
  const s = await vaultSandbox();
  try {
    // The old PC: secrets, a daily key, a recovery key in the key store; one backup.
    const ssh = join(s.home, ".ssh");
    await Deno.mkdir(ssh, { recursive: true });
    await Deno.writeTextFile(join(ssh, "fleet-signing"), "PRIVATE-SIGNING-KEY\n");
    await Deno.writeTextFile(join(ssh, "fleet-signing.pub"), "ssh-ed25519 AAAA me\n");
    const store = join(s.home, "config", "stolos", "keys");
    await Deno.mkdir(store, { recursive: true });
    await Deno.writeTextFile(join(store, "fleet-recovery"), "PRIVATE-RECOVERY-KEY\n");
    await Deno.writeTextFile(join(store, "fleet-recovery.pub"), "ssh-ed25519 BBBB rec\n");
    const gitconfig = join(s.home, "gitconfig");
    await Deno.writeTextFile(
      gitconfig,
      `[user]\n\tsigningkey = ${join(ssh, "fleet-signing").replace(/\\/g, "/")}\n`,
    );
    const git = { GIT_CONFIG_GLOBAL: gitconfig };
    let r = await s.archon(["vault", "backup"], "", git);
    assertEquals(r.code, 0, r.out);
    const dir = join(s.home, "data", "stolos", "backup");
    const zip = join(s.home, [...Deno.readDirSync(dir)][0].name);
    await Deno.rename(join(dir, zip.split(/[\\/]/).pop()!), zip); // kept somewhere safe

    // A fresh PC: none of it.
    for (const d of [join(s.home, "config"), join(s.home, "data"), ssh]) {
      await Deno.remove(d, { recursive: true });
    }
    await Deno.mkdir(join(s.home, "config"));
    await Deno.mkdir(join(s.home, "data"));
    const empty = { GIT_CONFIG_GLOBAL: join(s.home, "empty-gitconfig") };
    await Deno.writeTextFile(empty.GIT_CONFIG_GLOBAL, "");

    r = await s.archon(["vault", "restore", zip, "--files-only"], "", empty);
    assertEquals(r.code, 0, r.out);
    assert(/8 put back/.test(r.out), r.out);
    assertEquals(
      await Deno.readTextFile(join(s.secrets, "hosts", "alpha", "deploy_key")),
      "PRIVATE-DEPLOY-KEY\n",
    );
    assertEquals(await Deno.readTextFile(join(ssh, "fleet-signing")), "PRIVATE-SIGNING-KEY\n");
    assertEquals(await Deno.readTextFile(join(store, "fleet-recovery")), "PRIVATE-RECOVERY-KEY\n");
    if (Deno.build.os !== "windows") {
      for (const f of [join(ssh, "fleet-signing"), join(s.secrets, "mail.json")]) {
        assertEquals((Deno.statSync(f).mode ?? 0) & 0o777, 0o600, `${f} owner only`);
      }
    }
    assert(!r.out.includes("PRIVATE"), "never a value");
    // The ZIP counts as the last backup: nothing is newer than it.
    r = await s.archon(["vault", "status"]);
    assertEquals(r.code, 0, r.out);

    // Again: nothing to do.
    r = await s.archon(["vault", "restore", zip, "--files-only"], "", empty);
    assertEquals(r.code, 0, r.out);
    assert(/0 put back, 8 already here/.test(r.out), r.out);

    // A file that differs (perhaps newer): nothing is written, and it says which.
    await s.put("mail.json", '{"token":"newer"}\n');
    await Deno.remove(join(ssh, "fleet-signing.pub"));
    r = await s.archon(["vault", "restore", zip, "--files-only"], "", empty);
    assertEquals(r.code, 1, r.out);
    assert(r.out.includes("differ from the backup") && r.out.includes("mail.json"), r.out);
    assertEquals(await Deno.readTextFile(join(s.secrets, "mail.json")), '{"token":"newer"}\n');
    assert(!(await exists(join(ssh, "fleet-signing.pub"))), "nothing written when one differs");

    // A damaged ZIP, and a file that is not a backup: refused.
    const bytes = await Deno.readFile(zip);
    const files = unzipSync(bytes);
    files["secrets/lab/mail.json"] = new TextEncoder().encode("tampered\n");
    const bad = join(s.home, "bad.zip");
    await Deno.writeFile(bad, zipSync(files));
    r = await s.archon(["vault", "restore", bad, "--files-only"], "", empty);
    assertEquals(r.code, 1, r.out);
    assert(r.out.includes("does not match its SHA-256"), r.out);
    await Deno.writeTextFile(join(s.home, "not.zip"), "hello");
    r = await s.archon(["vault", "restore", join(s.home, "not.zip")], "", empty);
    assertEquals(r.code, 1, r.out);
    assert(r.out.includes("not a ZIP file"), r.out);
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("vault: restore --destroy-existing restores clean; what the backup lacks is saved first", async () => {
  const s = await vaultSandbox();
  try {
    const ssh = join(s.home, ".ssh");
    await Deno.mkdir(ssh, { recursive: true });
    await Deno.writeTextFile(join(ssh, "fleet-signing"), "PRIVATE-SIGNING-KEY\n");
    await Deno.writeTextFile(join(ssh, "fleet-signing.pub"), "ssh-ed25519 AAAA me\n");
    const gitconfig = join(s.home, "gitconfig");
    await Deno.writeTextFile(
      gitconfig,
      `[user]\n\tsigningkey = ${join(ssh, "fleet-signing").replace(/\\/g, "/")}\n`,
    );
    let r = await s.archon(["vault", "backup"], "", { GIT_CONFIG_GLOBAL: gitconfig });
    assertEquals(r.code, 0, r.out);
    const dir = join(s.home, "data", "stolos", "backup");
    const zip = join(s.home, "kept.zip");
    await Deno.rename(join(dir, [...Deno.readDirSync(dir)][0].name), zip);

    // This PC drifted: a changed secret, one the backup lacks, another daily key, a GitHub key.
    await s.put("mail.json", '{"token":"newer"}\n');
    await s.put("hosts/beta/deploy_key", "STRAY\n");
    await Deno.writeTextFile(join(ssh, "fleet-signing"), "ANOTHER-KEY\n");
    await Deno.writeTextFile(join(ssh, "id_ed25519"), "GITHUB-KEY\n");
    const empty = { GIT_CONFIG_GLOBAL: join(s.home, "empty-gitconfig") };
    await Deno.writeTextFile(empty.GIT_CONFIG_GLOBAL, "");

    r = await s.archon(["vault", "restore", zip, "--files-only"], "", empty);
    assertEquals(r.code, 1, "without the flag: refused");
    assert(r.out.includes("--destroy-existing"), r.out);

    r = await s.archon(["vault", "restore", zip, "--files-only", "--destroy-existing"], "", empty);
    assertEquals(r.code, 0, r.out);
    assert(r.out.includes("saved in"), r.out);
    assertEquals(await Deno.readTextFile(join(s.secrets, "mail.json")), '{"token":"t1"}\n');
    assert(!(await exists(join(s.secrets, "hosts", "beta"))), "only what the backup holds");
    assertEquals(await Deno.readTextFile(join(ssh, "fleet-signing")), "PRIVATE-SIGNING-KEY\n");
    const aside = [...Deno.readDirSync(ssh)].map((e) => e.name).filter((n) =>
      n.startsWith("fleet-signing.replaced-")
    );
    assertEquals(aside.length, 1, "the other daily key moved aside, not deleted");
    assertEquals(await Deno.readTextFile(join(ssh, aside[0])), "ANOTHER-KEY\n");
    assertEquals(await Deno.readTextFile(join(ssh, "id_ed25519")), "GITHUB-KEY\n");
    // The saved ZIP holds what was here (the stray secret, the newer mail token).
    const saved = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith(".zip"));
    assertEquals(saved.length, 1, saved.join(","));
    const files = unzipSync(Deno.readFileSync(join(dir, saved[0])));
    assertEquals(new TextDecoder().decode(files["secrets/lab/hosts/beta/deploy_key"]), "STRAY\n");
    r = await s.archon(["vault", "status"]);
    assertEquals(r.code, 0, r.out);

    // Clean already: run again, nothing saved, nothing lost.
    r = await s.archon(["vault", "restore", zip, "--files-only", "--destroy-existing"], "", empty);
    assertEquals(r.code, 0, r.out);
    assertEquals([...Deno.readDirSync(dir)].filter((e) => e.name.endsWith(".zip")).length, 1);
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("vault: restore refuses a ZIP entry outside its places (no path escapes)", () => {
  const roots = { secrets: "/s", ssh: "/h/.ssh", keys: "/k" };
  assertEquals(targetOf("secrets/lab/mail.json", roots)?.fleet, "lab");
  assert(targetOf("signing/fleet-signing", roots)?.to.endsWith("fleet-signing"));
  assert(targetOf("signing/recovery/fleet-recovery", roots)?.to.startsWith("/k"));
  for (
    const bad of [
      "secrets/../x/y",
      "../etc/passwd",
      "signing/a/b",
      "secrets/lab",
      "other/x",
      "signing/C:x",
    ]
  ) {
    assertEquals(targetOf(bad, roots), undefined, bad);
  }
});

Deno.test("vault: the panel, amber, and red for identity keys never backed up", () => {
  const now = Date.parse("2026-11-11T19:00:00Z");
  const item = (name: string, changedAt: string) => ({
    name,
    path: "",
    ref: secretFor(name),
    sha256: "",
    size: 0,
    changedAt,
    backedUp: false,
  });
  const a: Assessment = {
    items: [],
    unbacked: [
      item("mail.json", "2026-11-11T14:02:00Z"),
      item("hosts/hermes/deploy_key", "2026-11-11T14:05:00Z"),
    ],
    removed: [],
    lastBackup: { at: "2026-11-08T10:00:00Z", file: "stolos-backup-x.zip", names: {} },
    backupCheck: { state: "ok" },
    severity: "amber",
  };
  const lines = panelLines(a, "BOOTPC", now)!;
  const text = lines.join("\n");
  assert(text.includes("🔐  Secrets changed: back them up"));
  assert(text.includes("2 secrets are newer than your last backup (3 days ago):"));
  assert(text.includes("mail relay token") && text.includes("hermes deploy key"));
  assert(text.includes("If BOOTPC failed now") && text.includes("deno task stolos vault backup"));
  // A frame: every line the same visible width.
  assertEquals(new Set(lines.map(width)).size, 1, text);
  assertEquals(panelLines({ ...a, unbacked: [], severity: "ok" }, "BOOTPC", now), undefined);
});

// --------------------------------------------- the inventory covers the code

Deno.test("inventory: every secret path the code writes is in the inventory", () => {
  const rel = (p: string) => p.slice(P.secrets.length + 1).replace(/\\/g, "/");
  const paths = [
    SECRETS.adminPasswordHash,
    SECRETS.deployKey("alpha"),
    SECRETS.deployKeyPub("alpha"),
    SECRETS.hostKey("alpha", "ed25519"),
    `${SECRETS.hostKey("alpha", "rsa")}.pub`,
    SECRETS.mail,
    SECRETS.web,
    SECRETS.acme("alpha"),
    SECRETS.tokens,
  ];
  // Every SECRETS entry is among them (a new one must be added here and to the inventory).
  const keys = Object.keys(SECRETS).filter((k) => k !== "dir");
  assertEquals(keys.sort(), [
    "acme",
    "adminPasswordHash",
    "deployKey",
    "deployKeyPub",
    "hostKey",
    "mail",
    "tokens",
    "web",
  ]);
  for (const p of paths) assert(secretFor(rel(p)), `not in the inventory: ${rel(p)}`);
});

Deno.test("inventory: every secret write goes through writeSecret", async () => {
  const offenders: string[] = [];
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (p.endsWith(".ts") && !p.endsWith("core/secrets.ts")) {
        const lines = (await Deno.readTextFile(p)).split("\n");
        lines.forEach((l, i) => {
          // A direct file write whose target is in the secrets folder.
          if (/Deno\.(writeTextFile|writeFile)\(\s*(SECRETS\.|P\.secrets)/.test(l)) {
            offenders.push(`${p}:${i + 1}`);
          }
          // ssh-keygen writing straight into the secrets folder.
          if (
            /"-f",?\s*$/.test(l.trim()) &&
            /SECRETS\.|P\.secrets|\bkey\b,?$|\bpath\b,?$/.test(lines[i + 1]?.trim() ?? "")
          ) {
            offenders.push(`${p}:${i + 2}`);
          }
        });
      }
    }
  };
  await walk("src");
  assertEquals(offenders, []);
});

Deno.test("sandbox: archon refuses to start when a per-user path escapes ARCHON_SANDBOX", async () => {
  const sb = await sandbox("archon-guard-test-");
  try {
    // One root left pointing at the real profile (the Windows bug: APPDATA inherited).
    const escaped: Record<string, string> = Deno.build.os === "windows"
      ? { APPDATA: Deno.env.get("APPDATA") ?? "C:\\" }
      : { XDG_CONFIG_HOME: "/" };
    const r = await sb.run("src/stolos/main.ts", ["vault", "status"], "", escaped);
    assert(r.code !== 0, r.out);
    assert(r.out.includes("outside the sandbox"), r.out);
  } finally {
    await Deno.remove(sb.home, { recursive: true });
  }
});

Deno.test("recover-host-keys: reads the host's export, old (host keys only) and new (with the deploy key)", async () => {
  const { parseHostExport } = await import("../src/archon/install/host-keys.ts");
  const k = { type: "ed25519" as const, private: "PRIVATE\n", public: "ssh-ed25519 AAAA" };
  assertEquals(parseHostExport(JSON.stringify([k])), { hostKeys: [k] });
  const now = parseHostExport(
    JSON.stringify({ hostKeys: [k], deployKey: { private: "D\n", public: "ssh-ed25519 BBBB" } }),
  );
  assertEquals(now.deployKey?.public, "ssh-ed25519 BBBB");
});

Deno.test("sandbox: the real archon folders were not touched by any of these tests", async () => {
  assertEquals(
    await fingerprint(REAL),
    before,
    "the vault tests changed the real secrets or ledger",
  );
});
