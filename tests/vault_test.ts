// Specs 029 and 056: the vault (a ZIP backup), the backup panel, and the secret inventory's coverage.
// The flow tests run the real commands in a subprocess with a throwaway home.
import { assert, assertEquals } from "./assert.ts";
import { panelLines, width } from "../src/archon/vault/panel.ts";
import type { Assessment } from "../src/archon/vault/state.ts";
import { unzipSync } from "npm:fflate@0.8.2";
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
    assert(r.out.includes("move it wherever you keep important things safe"), r.out);
    assert(r.out.includes("It is not encrypted itself"), r.out);
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
    assert(text("RESTORE.txt").includes("no command does it for you"));
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

Deno.test("vault: restore only explains (changes nothing); backup without a signing key warns", async () => {
  const s = await vaultSandbox();
  try {
    const before = await fingerprint([join(s.home, "config"), join(s.home, "data")]);
    let r = await s.archon(["vault", "restore"]);
    assertEquals(r.code, 0, r.out);
    assert(r.out.includes("How to restore an archon backup"), r.out);
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
