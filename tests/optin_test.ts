// Specs 040 (opt-in services and containers) and 041 (S3 object storage).
import { engineFile } from "../src/archon/core/assets.ts";
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { fleet, host } from "./fixtures.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import type { HostDef } from "../src/archon/model/types.ts";
import { CONTAINERS, quadletPath, S3 } from "../src/archon/containers/catalog.ts";
import { quadlet } from "../src/archon/containers/quadlet.ts";

const webFleet = () =>
  fleet({
    web: { domain: "lab.example.net" },
    services: [{ name: "s-app1", uid: 851, description: "app one" }],
  });
const on = (...names: string[]): Partial<HostDef> => ({
  optIn: Object.fromEntries(
    names.map((n) => [n, { enabled: true, by: "alice", at: "2026-11-12T20:00:00Z" }]),
  ),
});

Deno.test("040: a fresh server: every opt-in service and container present and masked; nothing routed", () => {
  const plan = resolvePlan(host(), webFleet());
  for (
    const [unit, sw] of [
      ["smbd.service", "smb"],
      ["postgresql.service", "pg"],
      ["archon-s3.service", "s3"],
    ]
  ) {
    const u = plan.units.find((x) => x.unitName === unit)!;
    assertEquals([u.state, u.switch], ["masked", sw], unit);
  }
  assert(plan.files.some((f) => f.path === quadletPath(S3)));
  assert(!plan.routes.some((r) => r.name.startsWith("s3")), "no routes while off");
  // Nothing pulled while off: the image is fetched only when the unit first starts.
  assertStringIncludes(quadlet(S3), "Pull=missing");
  // Turned on: the routes appear (LAN only through Traefik, spec 032).
  const lit = resolvePlan(host(on("s3")), webFleet());
  assertEquals(
    lit.routes.filter((r) => r.name.startsWith("s3")).map((r) => [r.name, r.port]),
    [["s3", 9300], ["s3-console", 9301]],
  );
});

Deno.test("040: the record: model input for every plan; writing keeps what else it holds", async () => {
  const { readOptIns } = await import("../src/archon/model/load.ts");
  const { writeOptIn } = await import("../src/archon/optin/optin.ts");
  const root = await Deno.makeTempDir({ prefix: "archon-optin-" });
  try {
    assertEquals(await readOptIns("alpha", root), {});
    await Deno.mkdir(`${root}/hosts/alpha`, { recursive: true });
    // pg.json also lists the instances Archon made: the switch must not lose them.
    await Deno.writeTextFile(
      `${root}/hosts/alpha/pg.json`,
      JSON.stringify({ instances: { prime: { version: 18, port: 5432, created: "x", by: "y" } } }),
    );
    await writeOptIn("alpha", "pg", true, "alice", root);
    await writeOptIn("alpha", "smb", false, "alice", root);
    await Deno.writeTextFile(`${root}/hosts/alpha/installed.json`, JSON.stringify({ ok: true }));
    const got = await readOptIns("alpha", root);
    assertEquals(Object.keys(got).sort(), ["pg", "smb"], "only records with a boolean enabled");
    assertEquals([got.pg.enabled, got.pg.by, got.smb.enabled], [true, "alice", false]);
    const pg = JSON.parse(await Deno.readTextFile(`${root}/hosts/alpha/pg.json`));
    assertEquals(pg.instances.prime.port, 5432);
    // The same record is the unit's switch at apply time.
    const { switchOn } = await import("../src/archon/apply/apply.ts");
    assertEquals(await switchOn("alpha", "pg", root), true);
    assertEquals(await switchOn("alpha", "smb", root), false);
    assertEquals(await switchOn("alpha", "s3", root), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("040: opt-in containers: pinned image, unprivileged, loopback only, no secret in the file", async () => {
  for (const c of CONTAINERS) {
    const q = quadlet(c);
    assert(/@sha256:[0-9a-f]{64}$/m.test(c.image), "pinned by digest (Article 12)");
    assertStringIncludes(q, `Image=${c.image}`);
    assertStringIncludes(q, `User=${c.uid}:${c.uid}`);
    assertStringIncludes(q, "NoNewPrivileges=true");
    assertStringIncludes(q, "DropCapability=ALL");
    assertStringIncludes(q, `EnvironmentFile=${c.secrets}`);
    assert(!c.secrets.startsWith("/etc/"), "secrets stay out of /etc (and etckeeper)");
    for (const p of c.ports) {
      assertStringIncludes(q, `PublishPort=127.0.0.1:${p.host}:${p.container}`);
    }
    assert(!/PublishPort=(0\.0\.0\.0:)?\d+:/.test(q), "never on every address");
    assert(!/SECRET_KEY|ACCESS_KEY|PASSWORD/i.test(q.replace(/^EnvironmentFile=.*$/m, "")));
    assertStringIncludes(q, "WantedBy=multi-user.target");
  }
  // Podman's own generator accepts the file, where Podman is installed.
  const gen = "/usr/lib/systemd/system-generators/podman-system-generator";
  if (await Deno.stat(gen).then(() => true, () => false)) {
    const dir = await Deno.makeTempDir({ prefix: "archon-quadlet-" });
    try {
      await Deno.writeTextFile(`${dir}/archon-s3.container`, quadlet(S3));
      const r = await new Deno.Command(gen, {
        args: ["--dryrun"],
        env: { QUADLET_UNIT_DIRS: dir },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(r.stdout);
      assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
      assertStringIncludes(out, "archon-s3.service");
      assert(/--name[= ]archon-s3/.test(out), out);
      assert(/--cap-drop=all/.test(out) && /--security-opt=no-new-privileges/.test(out));
      assert(!/unsupported|unknown key/i.test(new TextDecoder().decode(r.stderr)));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
  const plan = resolvePlan(host(), webFleet());
  const u = plan.units.find((x) => x.unitName === "archon-s3.service")!;
  assert(u.generated, "a generated unit: started, never enabled");
  // Spec 048: verify follows the host's own record: off, it is not running.
  assertStringIncludes(u.verify!, "! systemctl is-active --quiet archon-s3.service");
  const on = resolvePlan(
    host({ optIn: { s3: { enabled: true, by: "alice", at: "t", data: "durable" } } }),
    webFleet(),
  ).units.find((x) => x.unitName === "archon-s3.service")!;
  assertStringIncludes(on.verify!, S3.health);
});

Deno.test("041: S3 identities are Linux accounts; each may use only its own buckets", async () => {
  const { s3Identities, s3Policy } = await import("../src/archon/s3/s3.ts");
  const { usersFor } = await import("../src/archon/model/load.ts");
  assertEquals(s3Identities(usersFor(webFleet(), host()), webFleet()), ["alice", "s-app1"]);
  const p = JSON.parse(s3Policy("alice"));
  assertEquals(p.Statement[1].Resource, ["arn:aws:s3:::alice-*", "arn:aws:s3:::alice-*/*"]);
  assertEquals(p.Statement[0].Action, ["s3:ListAllMyBuckets", "s3:GetBucketLocation"]);
  assert(!JSON.stringify(p).includes("arn:aws:s3:::*/*"), "no one else's objects");
});

Deno.test("040/041: commands and tiers", async () => {
  const { COMMANDS } = await import("../src/archon/commands/registry.ts");
  const by = (n: string) => COMMANDS.find((c) => c.name === n)!;
  assertEquals(by("opt-in").tier, "read");
  for (
    const n of [
      "fs s3 on",
      "fs s3 off",
      "pg on",
      "pg off",
      "fs smb on",
      "fs smb off",
      "otel ui on",
      "otel ui off",
    ]
  ) {
    assertEquals(by(n).tier, "mutate", n);
  }
  assertEquals(by("fs s3 status").tier, "read");
  assertEquals(by("fs s3 key").tier, "read");
  assert(by("fs s3 key").unlocked, "your own key, without sudo");
  const { OPT_INS } = await import("../src/archon/optin/optin.ts");
  assertEquals(OPT_INS.map((o) => [o.name, o.kind]), [
    ["smb", "service"],
    ["pg", "service"],
    ["s3", "container"],
    ["otel-ui", "container"],
  ]);
});

Deno.test("040: a fresh machine converges once: a second apply changes nothing", async () => {
  const { apply } = await import("../src/archon/apply/apply.ts");
  const alpha = host({ pg: { instances: [(await import("../src/archon/pg/config.ts")).PRIME] } });
  const root = await Deno.makeTempDir({ prefix: "archon-fresh-" });
  try {
    const first = await apply(alpha, { check: false, root, only: ["files"] });
    assert(first.changes.length > 0);
    const second = await apply(alpha, { check: false, root, only: ["files"] });
    assertEquals(second.changes, [], "idempotent");
    const check = await apply(alpha, { check: true, root, only: ["files"] });
    assertEquals(check.changes, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("041: the console's Key is the S3 secret: --show is typed by a person, never over MCP", async () => {
  const { COMMANDS } = await import("../src/archon/commands/registry.ts");
  const { toolFor } = await import("../src/archon/mcp/server.ts");
  const c = COMMANDS.find((x) => x.name === "fs s3 key")!;
  assert(c.args.find((a) => a.name === "show")?.human === true);
  assert(!("show" in (toolFor(c).inputSchema.properties as Record<string, unknown>)));
  assertStringIncludes(c.description, "not your Linux password");
  const doc = engineFile("docs/s3.md");
  assertStringIncludes(doc, "archon fs s3 key --show");
  assertStringIncludes(doc, "Login Failed");
});

Deno.test("041/039: each account's own secret is reachable by that account (not behind archon-ops)", async () => {
  const { S3_PATHS } = await import("../src/archon/s3/s3.ts");
  const { PG } = await import("../src/archon/pg/config.ts");
  const { P } = await import("../src/archon/core/paths.ts");
  for (const dir of [S3_PATHS.keys, PG.secrets]) {
    assert(dir.startsWith(`${P.keys}/`), `${dir} is under ${P.keys}`);
    assert(
      !dir.startsWith(`${P.varLib}/`),
      `${dir} must not sit behind ${P.varLib} (0750 archon-ops)`,
    );
  }
  const plan = resolvePlan(host(), webFleet());
  const tmp = plan.files.find((f) => f.path === "/etc/tmpfiles.d/archon.conf")!.content!;
  assertStringIncludes(tmp, `d ${P.keys} 0711 root root -`);
  const { backupPolicy } = await import("../src/archon/capabilities/backup.ts");
  assert(backupPolicy(host()).paths.includes(P.keys), "the keys are backed up (Article 14)");
});
