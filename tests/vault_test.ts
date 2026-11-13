// Spec 029: the vault, the backup panel, and the secret inventory's coverage.
// The flow tests run the real commands in a subprocess with a throwaway home.
import { assert, assertEquals } from "./assert.ts";
import { panelLines, width } from "../src/archon/vault/panel.ts";
import type { Assessment } from "../src/archon/vault/state.ts";
import { compare } from "../src/archon/vault/commands.ts";
import { SECRET_INVENTORY, secretFor } from "../src/archon/model/secret-inventory.ts";
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
  const secrets = join(home, "config", "archon", "secrets", "lab");
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
  const vault = join(home, "vault");
  const archon = (args: string[], stdin = "", extra: Record<string, string> = {}) =>
    sb.run("src/archon/main.ts", args, stdin, extra);
  return { home, secrets, vault, archon, put };
}

Deno.test("vault: status, backup (copied as they are), status again, rehearse, prune", async () => {
  const s = await vaultSandbox();
  try {
    let r = await s.archon(["vault", "status"]);
    assertEquals(r.code, 1, r.out);
    assert(r.out.includes("never been backed up"), r.out);
    assert(r.out.includes("hosts/alpha/deploy_key") && r.out.includes("alpha deploy key"), r.out);
    assert(!r.out.includes("PRIVATE-DEPLOY-KEY"), "never a value");

    r = await s.archon(["vault", "backup", "--to", s.vault]);
    assertEquals(r.code, 0, r.out);
    assert(r.out.includes("read back and verified"), r.out);
    assert(
      r.out.includes("not the Personal Vault"),
      "a folder outside the Personal Vault is flagged",
    );
    const b = newest(s.vault);
    assertEquals(
      Deno.readTextFileSync(`${b}/hosts/alpha/deploy_key`),
      "PRIVATE-DEPLOY-KEY\n",
      "copied as it is",
    );
    assert(!(await exists(`${b}/install-tokens.json`)), "ephemeral secrets are left out");
    const manifest = JSON.parse(Deno.readTextFileSync(`${b}/manifest.json`));
    const names = manifest.files.map((f: { name: string }) => f.name).sort();
    assertEquals(names, [
      "admin-password.hash",
      "hosts/alpha/deploy_key",
      "hosts/alpha/ssh_host_ed25519_key",
      "mail.json",
    ]);
    assert(!JSON.stringify(manifest).includes("PRIVATE"), "the manifest holds no value");

    r = await s.archon(["vault", "status"]);
    assertEquals(r.code, 0, r.out);

    // A changed secret is newer than the backup.
    await s.put("mail.json", '{"token":"t2"}\n');
    r = await s.archon(["vault", "status"]);
    assertEquals(r.code, 1);
    assert(/newer than your last vault backup/.test(r.out), r.out);
    r = await s.archon(["vault", "verify", "--to", s.vault]);
    assertEquals(r.code, 1);
    assert(r.out.includes("mail.json: differs from the backup"), r.out);

    await new Promise((x) => setTimeout(x, 1100)); // backup names carry the time
    r = await s.archon(["vault", "backup", "--to", s.vault]);
    assertEquals(r.code, 0, r.out);
    r = await s.archon(["vault", "rehearse", "--to", s.vault]);
    assertEquals(r.code, 0, r.out);
    assert(r.out.includes("nothing was changed"), r.out);

    r = await s.archon(["vault", "prune", "--keep", "1", "--to", s.vault]);
    assertEquals(r.code, 0, r.out);
    assertEquals([...Deno.readDirSync(s.vault)].length, 1);
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("vault: restore brings back a lost secret, and keeps a newer one", async () => {
  const s = await vaultSandbox();
  try {
    let r = await s.archon(["vault", "backup", "--to", s.vault]);
    assertEquals(r.code, 0, r.out);
    await Deno.remove(`${s.secrets}/hosts/alpha/deploy_key`);
    r = await s.archon(["vault", "restore", "--to", s.vault, "--dry-run"]);
    assertEquals(r.code, 0, r.out);
    assert(!(await exists(`${s.secrets}/hosts/alpha/deploy_key`)), "a dry run writes nothing");
    await new Promise((x) => setTimeout(x, 1100));
    await s.put("mail.json", '{"token":"newer"}\n');
    r = await s.archon(["vault", "restore", "--to", s.vault]);
    assertEquals(
      Deno.readTextFileSync(`${s.secrets}/hosts/alpha/deploy_key`),
      "PRIVATE-DEPLOY-KEY\n",
    );
    assertEquals(
      Deno.readTextFileSync(`${s.secrets}/mail.json`),
      '{"token":"newer"}\n',
      "newer live secret kept",
    );
    assert(r.out.includes("newer than the backup: kept"), r.out);
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("vault: a lost machine restored from the vault has nothing left to back up", async () => {
  const s = await vaultSandbox();
  try {
    let r = await s.archon(["vault", "backup", "--to", s.vault]);
    assertEquals(r.code, 0, r.out);
    // Lose everything: the secrets and the local ledger (%APPDATA% and %LOCALAPPDATA%).
    await Deno.remove(s.secrets, { recursive: true });
    await Deno.remove(join(s.home, "data", "archon"), { recursive: true });
    r = await s.archon(["vault", "restore", "--to", s.vault]);
    assert(r.out.includes("written"), r.out);
    assert(!r.out.includes("never been backed up"), r.out);
    assert(!r.out.includes("Secrets changed"), r.out);
    r = await s.archon(["vault", "status", "--to", s.vault]);
    assert(!r.out.includes("never been backed up"), r.out);
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

function newest(dir: string): string {
  return `${dir}/${[...Deno.readDirSync(dir)].map((e) => e.name).sort().pop()}`;
}

async function exists(p: string) {
  return await Deno.stat(p).then(() => true).catch(() => false);
}

Deno.test("vault: compare names what is missing, changed, and extra", () => {
  const live = [
    { name: "a", sha256: "1" },
    { name: "b", sha256: "x" },
    { name: "d", sha256: "4" },
    {
      name: "install-tokens.json",
      sha256: "9",
      ref: SECRET_INVENTORY.find((x) => x.id === "install-tokens"),
    },
  ].map((x) => ({ path: "", size: 0, changedAt: "", ...x }));
  assertEquals(
    compare(
      [{ name: "a", sha256: "1" }, { name: "b", sha256: "2" }, { name: "c", sha256: "3" }],
      live,
    ),
    { missing: ["c"], changed: ["b"], extra: ["d"], same: 1 },
  );
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
    lastBackup: { at: "2026-11-08T10:00:00Z", file: "archon-secrets-x", names: {} },
    backupCheck: { state: "ok" },
    severity: "amber",
  };
  const lines = panelLines(a, "BOOTPC", now)!;
  const text = lines.join("\n");
  assert(text.includes("🔐  Secrets changed: back them up"));
  assert(text.includes("2 secrets are newer than your last vault backup (3 days ago):"));
  assert(text.includes("mail relay token") && text.includes("hermes deploy key"));
  assert(text.includes("If BOOTPC failed now") && text.includes("deno task boot vault backup"));
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

Deno.test("vault: rehearse an empty vault (a round trip), and ARCHON_VAULT_DIR as the destination", async () => {
  const s = await vaultSandbox();
  try {
    let r = await s.archon(["vault", "rehearse", "--to", s.vault]);
    assertEquals(r.code, 0, r.out);
    assert(r.out.includes("the round trip works"), r.out);
    assert(r.out.includes(s.vault), "the destination is shown");
    assertEquals([...Deno.readDirSync(s.vault)].length, 0, "an empty vault stays empty");
    r = await s.archon(["vault", "backup"], "", { ARCHON_VAULT_DIR: s.vault });
    assertEquals(r.code, 0, r.out);
    assertEquals([...Deno.readDirSync(s.vault)].length, 1);
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("vault: a recorded backup that is gone does not count; a locked vault is not verifiable", async () => {
  const s = await vaultSandbox();
  try {
    // A backup to the (sandboxed) OneDrive Personal Vault, the default destination.
    const pv = join(s.home, "OneDrive", "Personal Vault");
    await Deno.mkdir(pv, { recursive: true });
    let r = await s.archon(["vault", "backup"]);
    assertEquals(r.code, 0, r.out);
    r = await s.archon(["vault", "status"]);
    assertEquals(r.code, 0, r.out);

    // Locked: the Personal Vault's folder is not there. The record cannot be checked: amber, not ✓.
    await Deno.rename(pv, `${pv}.locked`);
    r = await s.archon(["vault", "status"]);
    assertEquals(r.code, 1, r.out);
    assert(r.out.includes("not verifiable: Personal Vault locked"), r.out);
    assert(r.out.includes("cannot be checked"), "the panel says so");
    assert(
      !/Secrets changed[\s\S]*never been backed up/.test(r.out),
      "not 'never backed up' while it cannot be checked",
    );

    // Unlocked again, but the backup folder is gone: as if never backed up.
    await Deno.rename(`${pv}.locked`, pv);
    for (const e of Deno.readDirSync(join(pv, "Archon"))) {
      Deno.removeSync(join(pv, "Archon", e.name), { recursive: true });
    }
    r = await s.archon(["vault", "status"]);
    assertEquals(r.code, 1, r.out);
    assert(r.out.includes("the recorded backup is gone"), r.out);
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("sandbox: archon refuses to start when a per-user path escapes ARCHON_SANDBOX", async () => {
  const sb = await sandbox("archon-guard-test-");
  try {
    // One root left pointing at the real profile (the Windows bug: APPDATA inherited).
    const escaped: Record<string, string> = Deno.build.os === "windows"
      ? { APPDATA: Deno.env.get("APPDATA") ?? "C:\\" }
      : { XDG_CONFIG_HOME: "/" };
    const r = await sb.run("src/archon/main.ts", ["vault", "status"], "", escaped);
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
