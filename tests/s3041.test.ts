/**
 * Spec 041: S3 object storage (RustFS), what the engine renders and decides for it. The container's
 * own behaviour on a real host (pulling, starting, `rc` inside it) needs Podman and root.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  assertThrows,
  proves,
  test,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { ENGINE_ROOT, sandbox } from "./sandbox.ts";
import { engineFile } from "../src/archon/core/assets.ts";
import { P } from "../src/archon/core/paths.ts";
import { at, fleet, host } from "./fixtures.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import type { DataClass, HostDef } from "../src/archon/model/types.ts";
import { S3 } from "../src/archon/containers/catalog.ts";
import { quadlet } from "../src/archon/containers/quadlet.ts";
import { s3Name, S3_PATHS } from "../src/archon/s3/s3.ts";

const webFleet = () =>
  fleet({
    web: { domain: "lab.example.net" },
    services: [{ name: "s-app1", uid: 851, description: "app one" }],
  });
const s3On = (data: DataClass = "ephemeral"): HostDef =>
  host({ optIn: { s3: { enabled: true, by: "alice", at: "2026-11-12T20:00:00Z", data } } });

proves(["041-s3 FR-001"], "041: RustFS 1.0.5 from Docker Hub, pinned by digest", () => {
  assertEquals(
    S3.image,
    "docker.io/rustfs/rustfs:1.0.5@sha256:b81d16a90ee25bd9511280127ca1471788c6e874cf0f0da759645f46b2dc1d74",
  );
  assert(!S3.image.includes("quay.io"), "quay.io is not used");
  assertStringIncludes(quadlet(S3), `Image=${S3.image}`);
});

proves(
  ["041-s3 FR-002"],
  "041: the container: UID 10001, no capabilities, /srv/s3 as /data, loopback ports, settings, ready",
  () => {
    const q = quadlet(S3);
    for (const line of [
      "User=10001:10001",
      "DropCapability=ALL",
      "NoNewPrivileges=true",
      "Volume=/srv/s3:/data",
      "PublishPort=127.0.0.1:9300:9000",
      "PublishPort=127.0.0.1:9301:9001",
      "Environment=RUSTFS_VOLUMES=/data",
      "Environment=RUSTFS_ADDRESS=:9000",
      "Environment=RUSTFS_CONSOLE_ENABLE=true",
      "Environment=RUSTFS_CONSOLE_ADDRESS=:9001",
    ]) {
      assert(q.split("\n").includes(line), `${line} in the quadlet`);
    }
    const plan = resolvePlan(host(), webFleet());
    const tmp = plan.files.find((f) => f.path === "/etc/tmpfiles.d/archon-s3.conf")?.content;
    assertExists(tmp);
    assertStringIncludes(tmp, "d /srv/s3 0750 10001 10001 -");
    // Ready: the API's /health/ready, on its loopback port.
    assertEquals(S3.health, "http://127.0.0.1:9300/health/ready");
  },
);

proves(
  ["041-s3 FR-003"],
  "041: s3.<host>.<domain> and s3-console.<host>.<domain>, routed by Traefik only while on",
  async () => {
    const { traefikDynamic } = await import("../src/archon/web/config.ts");
    assertEquals(s3Name(webFleet(), host()), {
      api: "s3.alpha.lab.example.net",
      console: "s3-console.alpha.lab.example.net",
    });
    const off: unknown = JSON.parse(traefikDynamic(resolvePlan(host(), webFleet())));
    assertEquals(at(off, "http", "routers", "s3"), undefined, "no route while off");
    const on: unknown = JSON.parse(traefikDynamic(resolvePlan(s3On(), webFleet())));
    assertEquals(at(on, "http", "routers", "s3", "rule"), "Host(`s3.alpha.lab.example.net`)");
    assertEquals(
      at(on, "http", "routers", "s3-console", "rule"),
      "Host(`s3-console.alpha.lab.example.net`)",
    );
    assertEquals(
      at(on, "http", "services", "s3", "loadBalancer", "servers", 0, "url"),
      "http://127.0.0.1:9300",
    );
    assertEquals(
      at(on, "http", "services", "s3-console", "loadBalancer", "servers", 0, "url"),
      "http://127.0.0.1:9301",
    );
    // Path-style: buckets are paths under the one name the wildcard certificate covers.
    assertStringIncludes(engineFile("docs/s3.md"), "https://s3.<server>.<domain>/<bucket>/<key>");
  },
);

proves(
  ["041-s3 FR-007"],
  "041: verify: on, the unit is active and /health/ready answers; off, it is not running",
  () => {
    const unit = (h: HostDef) => {
      const u = resolvePlan(h, webFleet()).units.find((x) => x.unitName === "archon-s3.service");
      assertExists(u);
      return u.verify;
    };
    assertEquals(unit(host()), "sh -c '! systemctl is-active --quiet archon-s3.service'");
    assertEquals(
      unit(s3On()),
      "sh -c 'systemctl is-active --quiet archon-s3.service && curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:9300/health/ready'",
    );
  },
);

proves(
  ["041-s3 FR-008"],
  "041/044: /srv/s3 is not in the nightly backups (unless durable); its credentials and keys are",
  async () => {
    const { backupPolicy } = await import("../src/archon/capabilities/backup.ts");
    const p = backupPolicy(s3On("ephemeral"));
    assert(!p.paths.includes("/srv/s3"), "the buckets are left out");
    assert(p.paths.includes(P.varLib), "the admin credentials (/var/lib/archon/s3)");
    assert(S3.secrets.startsWith(`${P.varLib}/`) && S3_PATHS.rcEnv.startsWith(`${P.varLib}/`));
    assert(p.paths.includes(P.keys), "every account's key (/var/lib/archon-keys/s3)");
    assert(S3_PATHS.keys.startsWith(`${P.keys}/`));
    // Spec 044 revised this: buckets recorded as durable join the archive.
    assert(backupPolicy(s3On("durable")).paths.includes("/srv/s3"));
  },
);

proves(
  ["041-s3 FR-009"],
  "041: the guide and docs/s3.md (served at /guide/s3): turning it on, a key, aws, rclone, SDKs",
  async () => {
    const doc = engineFile("docs/s3.md");
    for (const s of [
      "archon fs s3 on --durable",
      "archon fs s3 key --write",
      "aws --profile s3-alpha s3 mb",
      "rclone",
      "SDK",
      "boto3",
      "forcePathStyle",
    ]) {
      assertStringIncludes(doc, s);
    }
    const { GUIDES } = await import("../src/archon/web/serve.ts");
    assert(
      GUIDES.some((g) => g.name === "s3"),
      "served at /guide/s3",
    );
    const { guideFor } = await import("../src/archon/guide/guide.ts");
    const item = guideFor(resolvePlan(host(), webFleet())).find((x) => x.id === "s3");
    assertExists(item);
    assertEquals(item.guide, "s3");
    const cmds = (item.use ?? []).map((u) => u.cmd);
    for (const c of ["archon fs s3 on --durable", "archon fs s3 key --write"]) {
      assert(cmds.includes(c), `${c} in the guide`);
    }
  },
);

proves(
  ["041-s3 FR-010"],
  "041: the console signs in with the username and the S3 secret; every place says so",
  async () => {
    const { COMMANDS } = await import("../src/archon/commands/registry.ts");
    const { parseArgs } = await import("../src/archon/core/registry-types.ts");
    const { handle } = await import("../src/archon/mcp/server.ts");
    const by = (n: string) => {
      const c = COMMANDS.find((x) => x.name === n);
      assertExists(c, n);
      return c;
    };
    const key = by("fs s3 key");
    assertStringIncludes(key.description, "Account: your username and Key: this secret");
    assertStringIncludes(key.description, "not your Linux password");
    assertStringIncludes(by("fs s3 on").description, "(archon fs s3 key)");
    const doc = engineFile("docs/s3.md");
    assertStringIncludes(doc, "**Account**: your Linux username");
    assertStringIncludes(doc, "**Key**: your S3 secret");
    const { guideFor } = await import("../src/archon/guide/guide.ts");
    const item = guideFor(resolvePlan(host(), webFleet())).find((x) => x.id === "s3");
    assert(
      item?.use?.some(
        (u) => u.cmd === "archon fs s3 key --show" && u.why.includes("not your Linux password"),
      ) === true,
    );
    // `archon fs s3 status`, run on the example lab (no systemd unit here: off, not ready).
    const sb = await sandbox("archon-s3-test-");
    try {
      const script = path.join(sb.home, "status.ts");
      const s3 = new URL("../src/archon/s3/s3.ts", import.meta.url).href;
      await fs.writeTextFile(
        script,
        `import { s3Status } from ${JSON.stringify(s3)};\nawait s3Status("alpha", false);\n`,
      );
      const r = await sb.run(script, [], "", {
        ARCHON_REPO: path.join(ENGINE_ROOT, "examples"),
        ARCHON_FLEET: "lab",
      });
      assertStringIncludes(r.out, "S3 is off");
      assertStringIncludes(
        r.out,
        "The console signs in with Account: your username and Key: your S3 secret (archon fs s3 key --show), not your Linux password.",
      );
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
    // --show is typed by a person: refused for an agent, and over MCP.
    const prev = proc.env.get("ARCHON_AGENT");
    proc.env.set("ARCHON_AGENT", "an-agent");
    try {
      assertThrows(() => parseArgs(key, ["--show"]), Error, "typed by a person");
    } finally {
      if (prev === undefined) proc.env.delete("ARCHON_AGENT");
      else proc.env.set("ARCHON_AGENT", prev);
    }
    const r = (await handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "archon_fs_s3_key", arguments: { show: true } },
      },
      "read",
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert(r.result.isError);
    assertStringIncludes(r.result.content[0]?.text ?? "", "typed by a person");
  },
);

// Spec 041 FR-011's rotation itself (a new secret set in RustFS, the key file rewritten) needs
// Podman, root, and /var/lib/archon-keys: not run here.
test("041: key --rotate changes the host: it elevates, and counts as mutate over MCP", async () => {
  const { COMMANDS } = await import("../src/archon/commands/registry.ts");
  const { effectiveTier, parseArgs } = await import("../src/archon/core/registry-types.ts");
  const { allowed } = await import("../src/archon/mcp/server.ts");
  const key = COMMANDS.find((x) => x.name === "fs s3 key");
  assertExists(key);
  assertEquals(key.mutateWith, "rotate");
  assertEquals(effectiveTier(key, parseArgs(key, [])), "read");
  assertEquals(effectiveTier(key, parseArgs(key, ["--rotate"])), "mutate", "elevates through sudo");
  assert(allowed(key, {}, "read"));
  assert(!allowed(key, { rotate: true }, "read"), "over MCP, --rotate is a mutate call");
  assert(allowed(key, { rotate: true }, "mutate"));
  const { commandPage } = await import("../src/archon/render/man.ts");
  assertStringIncludes(commandPage(key), "changes the host and elevates through sudo");
});
