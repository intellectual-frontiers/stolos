/**
 * Specs 029 and 056: the vault (a ZIP backup), the backup panel, and the secret inventory's coverage.
 * The flow tests run the real commands in a subprocess with a throwaway home.
 *
 * @module
 */
import { zipManifest } from "../src/archon/vault/zip.ts";
import { compact, json, unzip, zip as zipFiles } from "@intellectual-frontiers/commons/ts/kernel";
import { fs, path as paths, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { assert, assertEquals, proves, the } from "@intellectual-frontiers/commons/ts/runtime/test";
import { panelLines, width } from "../src/archon/vault/panel.ts";
import type { Assessment } from "../src/archon/vault/state.ts";
import { targetOf } from "../src/archon/vault/restore.ts";
import { secretFor } from "../src/archon/model/secret-inventory.ts";
import { SECRETS } from "../src/archon/core/secrets.ts";
import { P } from "../src/archon/core/paths.ts";
import { fingerprint, sandbox } from "./sandbox.ts";

// The real archon folders of this test process: they must not change (checked at the end).
const REAL = [paths.join(P.secrets, ".."), paths.join(P.bootCache, "..")];
const before = await fingerprint(REAL);

/** A ZIP's files (the kernel reads stored and deflated entries). */
async function unzipped(file: string): Promise<ReadonlyMap<string, Uint8Array>> {
  const r = await unzip(await fs.readFile(file));
  assert(r.kind === "ok", `${file} is a ZIP`);
  return r.value;
}

async function vaultSandbox() {
  const sb = await sandbox("archon-vault-test-");
  const home = sb.home;
  const secrets = paths.join(home, "config", "stolos", "secrets", "lab");
  const put = async (rel: string, text: string) => {
    const path = paths.join(secrets, ...rel.split("/"));
    await fs.mkdir(paths.join(path, ".."), { recursive: true });
    await fs.writeTextFile(path, text);
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

proves(
  [
    "029-vault FR-002",
    "056-zip-backup FR-001",
    "056-zip-backup FR-002",
    "056-zip-backup FR-003",
    "056-zip-backup FR-004",
    "056-zip-backup FR-005",
    "056-zip-backup FR-006",
  ],
  "vault: status, backup (one ZIP with the secrets and the signing key), status again",
  async () => {
    const s = await vaultSandbox();
    try {
      let r = await s.archon(["vault", "status"]);
      assertEquals(r.code, 1, r.out);
      assert(r.out.includes("never been backed up"), r.out);
      assert(r.out.includes("hosts/alpha/deploy_key") && r.out.includes("alpha deploy key"), r.out);
      assert(!r.out.includes("PRIVATE-DEPLOY-KEY"), "never a value");

      // A signing key, as Git's settings name it (a sandboxed global config).
      const ssh = paths.join(s.home, "ssh");
      await fs.mkdir(ssh, { recursive: true });
      await fs.writeTextFile(paths.join(ssh, "fleet-signing"), "PRIVATE-SIGNING-KEY\n");
      await fs.writeTextFile(paths.join(ssh, "fleet-signing.pub"), "ssh-ed25519 AAAA me\n");
      const gitconfig = paths.join(s.home, "gitconfig");
      await fs.writeTextFile(
        gitconfig,
        `[user]\n\tsigningkey = ${paths.join(ssh, "fleet-signing").replace(/\\/g, "/")}\n`,
      );
      const git = { GIT_CONFIG_GLOBAL: gitconfig };

      r = await s.archon(["vault", "backup"], "", git);
      assertEquals(r.code, 0, r.out);
      assert(r.out.includes("read back and checked"), r.out);
      assert(r.out.includes("Move it wherever you keep important things safe"), r.out);
      assert(r.out.includes("The ZIP itself is not encrypted"), r.out);
      const dir = paths.join(s.home, "data", "stolos", "backup");
      const zips = [...fs.readDirSync(dir)].map((e) => e.name);
      assertEquals(zips.length, 1, zips.join(","));
      const [zipName = ""] = zips;
      assert(/^stolos-backup-.+-\d{8}T\d{6}Z\.zip$/.test(zipName), zipName);
      if (proc.build.os !== "windows") {
        assertEquals(
          (fs.statSync(paths.join(dir, zipName)).mode ?? 0) & 0o777,
          0o600,
          "owner only",
        );
      }
      const files = await unzipped(paths.join(dir, zipName));
      const text = (n: string): string => new TextDecoder().decode(files.get(n));
      assertEquals(text("secrets/lab/hosts/alpha/deploy_key"), "PRIVATE-DEPLOY-KEY\n");
      assertEquals(text("signing/fleet-signing"), "PRIVATE-SIGNING-KEY\n");
      assertEquals(text("signing/fleet-signing.pub"), "ssh-ed25519 AAAA me\n");
      assert(!files.has("secrets/lab/install-tokens.json"), "ephemeral secrets are left out");
      assert(text("RESTORE.txt").includes("bun run stolos vault restore <path to this ZIP>"));
      const decoded = json(text("manifest.json"), zipManifest);
      assert(decoded.kind === "ok", text("manifest.json"));
      const manifest = decoded.value;
      assertEquals(manifest.files.map((f) => f.name).sort(), [
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
      assert(r.out.includes(zipName), r.out);

      // Without a ZIP, vault restore prints the restore steps, as RESTORE.txt has them, and
      // changes nothing.
      const kept = [paths.join(s.home, "config"), dir];
      const untouched = await fingerprint(kept);
      r = await s.archon(["vault", "restore"]);
      assertEquals(r.code, 0, r.out);
      const steps = (t: string): string => t.slice(t.indexOf("On the new or rebuilt PC")).trim();
      assert(steps(text("RESTORE.txt")).length > 200, "RESTORE.txt has the steps");
      assert(r.out.includes(steps(text("RESTORE.txt"))), r.out);
      assertEquals(
        await fingerprint(kept),
        untouched,
        "vault restore without a ZIP changes nothing",
      );

      // Moved somewhere safe: still counts (the record), and no longer listed.
      await fs.rename(paths.join(dir, zipName), paths.join(s.home, zipName));
      r = await s.archon(["vault", "status"]);
      assertEquals(r.code, 0, r.out);
      assert(!r.out.includes("still in"), r.out);
      assert(r.out.includes(`Last backup: `) && r.out.includes(zipName), "the record still counts");
      r = await s.archon(["vault", "list"]);
      assert(!r.out.includes(zipName), r.out);

      // A changed secret is newer than the backup.
      await s.put("mail.json", '{"token":"t2"}\n');
      r = await s.archon(["vault", "status"]);
      assertEquals(r.code, 1);
      assert(/newer than your last backup/.test(r.out), r.out);
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
);

proves(
  ["061-vault-restore FR-007", "056-zip-backup FR-004"],
  "vault: restore without a ZIP only explains; backup without a signing key warns",
  async () => {
    const s = await vaultSandbox();
    try {
      // Every run writes its own log: on Windows into %LOCALAPPDATA% (data here), elsewhere state.
      const runLog = /[\\/]stolos[\\/]log[\\/][^\\/]+\.log$/;
      const before = await fingerprint(
        [paths.join(s.home, "config"), paths.join(s.home, "data")],
        runLog,
      );
      let r = await s.archon(["vault", "restore"]);
      assertEquals(r.code, 0, r.out);
      assert(r.out.includes("How to restore a stolos backup"), r.out);
      assert(r.out.includes("vault restore <path to this ZIP>"), r.out);
      assert(r.out.includes("Copy-Item") && r.out.includes("keys setup"), r.out);
      assertEquals(
        await fingerprint([paths.join(s.home, "config"), paths.join(s.home, "data")], runLog),
        before,
      );

      const empty = paths.join(s.home, "empty-gitconfig");
      await fs.writeTextFile(empty, "");
      r = await s.archon(["vault", "backup"], "", { GIT_CONFIG_GLOBAL: empty });
      assertEquals(r.code, 0, r.out);
      assert(r.out.includes("no signing key"), r.out);
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
);

proves(
  [
    "061-vault-restore FR-001",
    "061-vault-restore FR-003",
    "061-vault-restore FR-004",
    "061-vault-restore FR-005",
  ],
  "vault: restore <zip> puts back every secret and both keys on a fresh PC, idempotent, never overwrites",
  async () => {
    const s = await vaultSandbox();
    try {
      // The old PC: secrets, a daily key, a recovery key in the key store; one backup.
      const ssh = paths.join(s.home, ".ssh");
      await fs.mkdir(ssh, { recursive: true });
      await fs.writeTextFile(paths.join(ssh, "fleet-signing"), "PRIVATE-SIGNING-KEY\n");
      await fs.writeTextFile(paths.join(ssh, "fleet-signing.pub"), "ssh-ed25519 AAAA me\n");
      const store = paths.join(s.home, "config", "stolos", "keys");
      await fs.mkdir(store, { recursive: true });
      await fs.writeTextFile(paths.join(store, "fleet-recovery"), "PRIVATE-RECOVERY-KEY\n");
      await fs.writeTextFile(paths.join(store, "fleet-recovery.pub"), "ssh-ed25519 BBBB rec\n");
      const gitconfig = paths.join(s.home, "gitconfig");
      await fs.writeTextFile(
        gitconfig,
        `[user]\n\tsigningkey = ${paths.join(ssh, "fleet-signing").replace(/\\/g, "/")}\n`,
      );
      const git = { GIT_CONFIG_GLOBAL: gitconfig };
      let r = await s.archon(["vault", "backup"], "", git);
      assertEquals(r.code, 0, r.out);
      const dir = paths.join(s.home, "data", "stolos", "backup");
      const zip = paths.join(s.home, the(fs.readDirSync(dir)[0]).name);
      await fs.rename(paths.join(dir, the(zip.split(/[\\/]/).pop())), zip); // kept somewhere safe

      // A fresh PC: none of it.
      for (const d of [paths.join(s.home, "config"), paths.join(s.home, "data"), ssh]) {
        await fs.remove(d, { recursive: true });
      }
      await fs.mkdir(paths.join(s.home, "config"));
      await fs.mkdir(paths.join(s.home, "data"));
      const empty = { GIT_CONFIG_GLOBAL: paths.join(s.home, "empty-gitconfig") };
      await fs.writeTextFile(empty.GIT_CONFIG_GLOBAL, "");

      r = await s.archon(["vault", "restore", zip, "--files-only"], "", empty);
      assertEquals(r.code, 0, r.out);
      assert(/8 put back/.test(r.out), r.out);
      assertEquals(
        await fs.readTextFile(paths.join(s.secrets, "hosts", "alpha", "deploy_key")),
        "PRIVATE-DEPLOY-KEY\n",
      );
      assertEquals(
        await fs.readTextFile(paths.join(ssh, "fleet-signing")),
        "PRIVATE-SIGNING-KEY\n",
      );
      assertEquals(
        await fs.readTextFile(paths.join(store, "fleet-recovery")),
        "PRIVATE-RECOVERY-KEY\n",
      );
      if (proc.build.os !== "windows") {
        for (const f of [paths.join(ssh, "fleet-signing"), paths.join(s.secrets, "mail.json")]) {
          assertEquals((fs.statSync(f).mode ?? 0) & 0o777, 0o600, `${f} owner only`);
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
      await fs.remove(paths.join(ssh, "fleet-signing.pub"));
      r = await s.archon(["vault", "restore", zip, "--files-only"], "", empty);
      assertEquals(r.code, 1, r.out);
      assert(r.out.includes("differ from the backup") && r.out.includes("mail.json"), r.out);
      assertEquals(
        await fs.readTextFile(paths.join(s.secrets, "mail.json")),
        '{"token":"newer"}\n',
      );
      assert(
        !(await fs.exists(paths.join(ssh, "fleet-signing.pub"))),
        "nothing written when one differs",
      );

      // A damaged ZIP, and a file that is not a backup: refused.
      const bytes = await fs.readFile(zip);
      const opened = await unzip(bytes);
      assert(opened.kind === "ok", "the backup is a ZIP");
      const files = new Map(opened.value);
      files.set("secrets/lab/mail.json", new TextEncoder().encode("tampered\n"));
      const bad = paths.join(s.home, "bad.zip");
      await fs.writeFile(bad, zipFiles(files));
      r = await s.archon(["vault", "restore", bad, "--files-only"], "", empty);
      assertEquals(r.code, 1, r.out);
      assert(r.out.includes("does not match its SHA-256"), r.out);
      await fs.writeTextFile(paths.join(s.home, "not.zip"), "hello");
      r = await s.archon(["vault", "restore", paths.join(s.home, "not.zip")], "", empty);
      assertEquals(r.code, 1, r.out);
      assert(r.out.includes("not a ZIP file"), r.out);
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
);

proves(
  ["061-vault-restore FR-004a"],
  "vault: restore --destroy-existing restores clean; what the backup lacks is saved first",
  async () => {
    const s = await vaultSandbox();
    try {
      const ssh = paths.join(s.home, ".ssh");
      await fs.mkdir(ssh, { recursive: true });
      await fs.writeTextFile(paths.join(ssh, "fleet-signing"), "PRIVATE-SIGNING-KEY\n");
      await fs.writeTextFile(paths.join(ssh, "fleet-signing.pub"), "ssh-ed25519 AAAA me\n");
      const gitconfig = paths.join(s.home, "gitconfig");
      await fs.writeTextFile(
        gitconfig,
        `[user]\n\tsigningkey = ${paths.join(ssh, "fleet-signing").replace(/\\/g, "/")}\n`,
      );
      let r = await s.archon(["vault", "backup"], "", { GIT_CONFIG_GLOBAL: gitconfig });
      assertEquals(r.code, 0, r.out);
      const dir = paths.join(s.home, "data", "stolos", "backup");
      const zip = paths.join(s.home, "kept.zip");
      await fs.rename(paths.join(dir, the(fs.readDirSync(dir)[0]).name), zip);

      // This PC drifted: a changed secret, one the backup lacks, another daily key, a GitHub key.
      await s.put("mail.json", '{"token":"newer"}\n');
      await s.put("hosts/beta/deploy_key", "STRAY\n");
      await fs.writeTextFile(paths.join(ssh, "fleet-signing"), "ANOTHER-KEY\n");
      await fs.writeTextFile(paths.join(ssh, "id_ed25519"), "GITHUB-KEY\n");
      const empty = { GIT_CONFIG_GLOBAL: paths.join(s.home, "empty-gitconfig") };
      await fs.writeTextFile(empty.GIT_CONFIG_GLOBAL, "");

      r = await s.archon(["vault", "restore", zip, "--files-only"], "", empty);
      assertEquals(r.code, 1, "without the flag: refused");
      assert(r.out.includes("--destroy-existing"), r.out);

      r = await s.archon(
        ["vault", "restore", zip, "--files-only", "--destroy-existing"],
        "",
        empty,
      );
      assertEquals(r.code, 0, r.out);
      assert(r.out.includes("saved in"), r.out);
      assertEquals(await fs.readTextFile(paths.join(s.secrets, "mail.json")), '{"token":"t1"}\n');
      assert(
        !(await fs.exists(paths.join(s.secrets, "hosts", "beta"))),
        "only what the backup holds",
      );
      assertEquals(
        await fs.readTextFile(paths.join(ssh, "fleet-signing")),
        "PRIVATE-SIGNING-KEY\n",
      );
      const aside = [...fs.readDirSync(ssh)]
        .map((e) => e.name)
        .filter((n) => n.startsWith("fleet-signing.replaced-"));
      assertEquals(aside.length, 1, "the other daily key moved aside, not deleted");
      assertEquals(await fs.readTextFile(paths.join(ssh, the(aside[0]))), "ANOTHER-KEY\n");
      assertEquals(await fs.readTextFile(paths.join(ssh, "id_ed25519")), "GITHUB-KEY\n");
      // The saved ZIP holds what was here (the stray secret, the newer mail token).
      const saved = [...fs.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith(".zip"));
      assertEquals(saved.length, 1, saved.join(","));
      const files = await unzipped(paths.join(dir, the(saved[0])));
      assertEquals(
        new TextDecoder().decode(files.get("secrets/lab/hosts/beta/deploy_key")),
        "STRAY\n",
      );
      r = await s.archon(["vault", "status"]);
      assertEquals(r.code, 0, r.out);

      // Clean already: run again, nothing saved, nothing lost.
      r = await s.archon(
        ["vault", "restore", zip, "--files-only", "--destroy-existing"],
        "",
        empty,
      );
      assertEquals(r.code, 0, r.out);
      assertEquals([...fs.readDirSync(dir)].filter((e) => e.name.endsWith(".zip")).length, 1);
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
);

proves(
  ["061-vault-restore FR-001"],
  "vault: restore refuses a ZIP entry outside its places (no path escapes)",
  () => {
    const roots = { secrets: "/s", ssh: "/h/.ssh", keys: "/k" };
    assertEquals(targetOf("secrets/lab/mail.json", roots)?.fleet, "lab");
    assert(targetOf("signing/fleet-signing", roots)?.to.endsWith("fleet-signing"));
    // A path of this system's (Windows: \k).
    assert(
      targetOf("signing/recovery/fleet-recovery", roots)?.to.startsWith(paths.normalize("/k")),
    );
    for (const bad of [
      "secrets/../x/y",
      "../etc/passwd",
      "signing/a/b",
      "secrets/lab",
      "other/x",
      "signing/C:x",
    ]) {
      assertEquals(targetOf(bad, roots), undefined, bad);
    }
  },
);

proves(
  ["029-vault FR-010"],
  "vault: the panel, amber, and red for identity keys never backed up",
  () => {
    const now = Date.parse("2026-11-11T19:00:00Z");
    const item = (name: string, changedAt: string) => ({
      name,
      path: "",
      ...compact({ ref: secretFor(name) }),
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
    const lines = the(panelLines(a, "BOOTPC", now));
    const text = lines.join("\n");
    assert(text.includes("🔐  Secrets changed: back them up"));
    assert(text.includes("2 secrets are newer than your last backup (3 days ago):"));
    assert(text.includes("mail relay token") && text.includes("hermes deploy key"));
    assert(text.includes("If BOOTPC failed now") && text.includes("bun run stolos vault backup"));
    // A frame: every line the same visible width.
    assertEquals(new Set(lines.map(width)).size, 1, text);
    assertEquals(panelLines({ ...a, unbacked: [], severity: "ok" }, "BOOTPC", now), undefined);
  },
);

// --------------------------------------------- the inventory covers the code

proves(
  ["028-site-network FR-005"],
  "inventory: every secret path the code writes is in the inventory",
  () => {
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
      SECRETS.exportMail("acme"),
      SECRETS.consoleTls,
      SECRETS.pairing,
      `${SECRETS.pairing}-lock`,
      `${SECRETS.pairing}-tmp`,
    ];
    // Every SECRETS entry is among them (a new one must be added here and to the inventory).
    const keys = Object.keys(SECRETS).filter((k) => k !== "dir");
    assertEquals(keys.sort(), [
      "acme",
      "adminPasswordHash",
      "consoleTls",
      "deployKey",
      "deployKeyPub",
      "exportMail",
      "hostKey",
      "mail",
      "pairing",
      "tokens",
      "web",
    ]);
    for (const p of paths) assert(secretFor(rel(p)), `not in the inventory: ${rel(p)}`);
  },
);

proves(["029-vault FR-009"], "inventory: every secret write goes through writeSecret", async () => {
  const offenders: string[] = [];
  const walk = async (dir: string) => {
    for await (const e of fs.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (p.endsWith(".ts") && !p.endsWith("core/secrets.ts")) {
        const lines = (await fs.readTextFile(p)).split("\n");
        lines.forEach((l, i) => {
          // A direct file write whose target is in the secrets folder.
          if (/\bfs\.(writeTextFile|writeFile)(Sync)?\(\s*(SECRETS\.|P\.secrets)/.test(l)) {
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

proves(
  ["029-vault FR-015"],
  "sandbox: archon refuses to start when a per-user path escapes ARCHON_SANDBOX",
  async () => {
    const sb = await sandbox("archon-guard-test-");
    try {
      // One root left pointing at the real profile (the Windows bug: APPDATA inherited).
      const escaped: Record<string, string> =
        proc.build.os === "windows"
          ? { APPDATA: proc.env.get("APPDATA") ?? "C:\\" }
          : { XDG_CONFIG_HOME: "/" };
      const r = await sb.run("src/stolos/main.ts", ["vault", "status"], "", escaped);
      assert(r.code !== 0, r.out);
      assert(r.out.includes("outside the sandbox"), r.out);
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

proves(
  ["029-vault FR-008"],
  "recover-host-keys: reads the host's export, old (host keys only) and new (with the deploy key)",
  async () => {
    const { parseHostExport } = await import("../src/archon/install/host-keys.ts");
    const k = { type: "ed25519" as const, private: "PRIVATE\n", public: "ssh-ed25519 AAAA" };
    assertEquals(parseHostExport(JSON.stringify([k])), { hostKeys: [k] });
    const now = parseHostExport(
      JSON.stringify({ hostKeys: [k], deployKey: { private: "D\n", public: "ssh-ed25519 BBBB" } }),
    );
    assertEquals(now.deployKey?.public, "ssh-ed25519 BBBB");
  },
);

proves(
  ["056-zip-backup FR-007"],
  "056: verify, rehearse, prune, and the Personal Vault detection are gone",
  async () => {
    const { COMMANDS } = await import("../src/archon/commands/registry.ts");
    const vault = COMMANDS.filter((c) => c.name.startsWith("vault ")).map((c) => c.name);
    for (const gone of ["vault verify", "vault rehearse", "vault prune"]) {
      assert(!vault.includes(gone), `${gone} is removed`);
    }
    const backup = COMMANDS.find((c) => c.name === "vault backup");
    assert(backup !== undefined);
    assertEquals(
      backup.args.map((a) => a.name),
      [],
      "no --to, no --wait: the ZIP goes to the backup folder",
    );
    const root = paths.fromFileUrl(new URL("../src/", import.meta.url));
    for (const f of await fs.walkFiles(root)) {
      if (!f.endsWith(".ts") || f.endsWith(".auto.ts")) continue;
      const t = await fs.readTextFile(paths.join(root, f));
      assert(!t.includes("ARCHON_VAULT_DIR"), `${f} reads ARCHON_VAULT_DIR`);
      assert(!/rehears/i.test(t), `${f} still rehearses`);
    }
    const s = await vaultSandbox();
    try {
      const r = await s.archon(["vault", "rehearse"]);
      assert(r.code !== 0, r.out);
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
);

proves(
  ["029-vault FR-015"],
  "sandbox: the real archon folders were not touched by any of these tests",
  async () => {
    assertEquals(
      await fingerprint(REAL),
      before,
      "the vault tests changed the real secrets or ledger",
    );
  },
);

proves(
  ["061-vault-restore FR-002"],
  "061: restore writes only into a repository with one of the backup's fleets, and chooses it",
  async () => {
    const s = await vaultSandbox();
    try {
      let r = await s.archon(["vault", "backup"]);
      assertEquals(r.code, 0, r.out);
      const dir = paths.join(s.home, "data", "stolos", "backup");
      const zip = paths.join(s.home, "kept.zip");
      await fs.rename(paths.join(dir, the(fs.readDirSync(dir)[0]).name), zip);
      await fs.remove(paths.join(s.home, "config", "stolos", "secrets"), { recursive: true });

      // A Git checkout holding the given fleets (each a fleets/<id>/fleet.ts).
      const repoWith = async (name: string, fleets: string[]): Promise<string> => {
        const repo = paths.join(s.home, name);
        for (const f of fleets) {
          await fs.mkdir(paths.join(repo, "fleets", f), { recursive: true });
          await fs.writeTextFile(paths.join(repo, "fleets", f, "fleet.ts"), "export {};\n");
        }
        const g = await proc.run(["git", "init", "-q", repo]);
        assertEquals(g.code, 0, g.stderr);
        return repo;
      };
      const restore = (repo: string) =>
        s.archon(["vault", "restore", zip, "--files-only"], "", { ARCHON_REPO: repo });

      // The wrong repository: refused, nothing written.
      const other = await repoWith("other", ["zeta"]);
      r = await restore(other);
      assertEquals(r.code, 1, r.out);
      assert(r.out.includes("the backup is for lab; this repository has zeta"), r.out);
      assert(!(await fs.exists(s.secrets)), "nothing written");

      // Two fleets here, none chosen, exactly one in the backup: that one is chosen (fleet use).
      const mine = await repoWith("mine", ["lab", "zeta"]);
      r = await restore(mine);
      assertEquals(r.code, 0, r.out);
      assert(r.out.includes("lab (the backup holds lab)"), r.out);
      assertEquals(
        (await fs.readTextFile(paths.join(mine, ".git", "stolos", "fleet"))).trim(),
        "lab",
      );
      assertEquals(await fs.readTextFile(paths.join(s.secrets, "mail.json")), '{"token":"t1"}\n');
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
);
