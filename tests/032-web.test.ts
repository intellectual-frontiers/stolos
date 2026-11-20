/**
 * Spec 032 (HTTPS on every server): Traefik's unit and tool, the Cloudflare token's path from the
 * boot machine to a server, the verify checks, and Traefik's telemetry.
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
  test,
} from "@intellectual-frontiers/test";
import { workstation } from "../src/archon/capabilities/mod.ts";
import { SECRET_INVENTORY } from "../src/archon/model/secret-inventory.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { userData } from "../src/archon/render/autoinstall.ts";
import { TOOLS } from "../src/archon/tools/catalog.ts";
import { zoneId } from "../src/archon/web/cloudflare.ts";
import { traefikStatic, WEB } from "../src/archon/web/config.ts";
import { at, fleet, host, list } from "./fixtures.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";

const posix = proc.build.os !== "windows";
const webFleet = () => fleet({ web: { domain: "lab.example.net" } });

// Spec 032 FR-001 says "a dynamic user"; Traefik runs as its own system account (sysusers.d, in
// the group that may read Podman's socket). What else FR-001 says is checked here.
test("032: Traefik is the official release, servers only, with CAP_NET_BIND_SERVICE alone and its state in /var/lib/traefik", () => {
  const t = TOOLS.find((x) => x.id === "traefik");
  assert(t?.github !== undefined);
  assertEquals(
    [t.source, t.github.repo, t.serverOnly],
    ["upstream-binary", "traefik/traefik", true],
  );
  assert(t.github.asset("amd64", "3.5.0").test("traefik_v3.5.0_linux_amd64.tar.gz"));
  assertEquals(t.restarts, ["traefik.service"]);
  const plan = resolvePlan(host(), webFleet());
  const u = plan.units.find((x) => x.unitName === WEB.unit)?.content?.split("\n") ?? [];
  for (const l of [
    "AmbientCapabilities=CAP_NET_BIND_SERVICE",
    "CapabilityBoundingSet=CAP_NET_BIND_SERVICE",
    "NoNewPrivileges=true",
    "StateDirectory=traefik",
    "StateDirectoryMode=0700",
    "ConditionPathExists=/usr/local/bin/traefik",
  ]) {
    assert(u.includes(l) || u.includes(l.replace("=true", "=yes")), l);
  }
  const ws = resolvePlan(
    host({
      name: "pc",
      kind: "workstation",
      user: "alice",
      mac: undefined,
      disk: undefined,
      capabilities: workstation(),
      spec: "020-workstation",
    }),
    webFleet(),
  );
  assert(!ws.tools.some((x) => x.id === "traefik"));
});

proves(
  ["032-web FR-008"],
  "032: the Cloudflare token: checked against the zone, kept on the boot machine and in the vault, delivered by the install or web-push",
  async () => {
    // web-setup stores it only once Cloudflare shows the zone to it.
    const answer =
      (zones: Array<{ id: string; name: string }>): typeof fetch =>
      (input) => {
        assert(typeof input === "string", "a URL");
        assertStringIncludes(input, "/zones?name=example.net");
        return Promise.resolve(Response.json({ success: true, result: zones }));
      };
    assertEquals(
      await zoneId("t", "example.net", answer([{ id: "z1", name: "example.net" }])),
      "z1",
    );
    const e = await zoneId("t", "example.net", answer([])).then(
      () => "",
      (x: unknown) => String(x),
    );
    assertStringIncludes(e, "needs Zone: Read and DNS: Edit on example.net");
    // On the boot machine: web.json, in the inventory the vault backs up.
    const ref = SECRET_INVENTORY.find((s) => s.path === "web.json");
    assertEquals([ref?.holder, ref?.ephemeral ?? false], ["boot-machine", false]);
    // The install delivers it root only; Traefik reads its environment file.
    const cred = JSON.stringify({ token: "cfut_exampleexampleexample01234", created: "" });
    const u = userData(
      { fleet: webFleet(), host: host(), base: "http://10.0.0.5:8080/install/alpha/tok/" },
      { passwordHash: "$6$abc$def", webCredential: cred },
    );
    const files: unknown = JSON.parse(u.slice("#cloud-config\n".length));
    const written = list(at(files, "autoinstall", "user-data", "write_files"));
    const f = written.find((x) => at(x, "path") === "/etc/archon/web_credential.json");
    assertEquals([at(f, "permissions"), at(f, "content")], ["0600", `${cred}\n`]);
    const unit = resolvePlan(host(), webFleet()).units.find((x) => x.unitName === WEB.unit);
    assert(unit?.content?.split("\n").includes(`EnvironmentFile=-${WEB.env}`));
    assert(WEB.credential.startsWith("/etc/archon/web/") && WEB.env.startsWith("/etc/archon/web/"));

    // web-push: over SSH, `archon web credential` with the token on stdin.
    if (!posix) return;
    const sb = await sandbox("archon-032-");
    try {
      const repo = path.join(sb.home, "fleet");
      const bin = path.join(sb.home, "bin");
      for (const d of [path.join(repo, "fleets"), bin]) await fs.mkdir(d, { recursive: true });
      await proc.output([
        "cp",
        "-r",
        path.join(ENGINE_ROOT, "examples/fleets/lab"),
        path.join(repo, "fleets/lab"),
      ]);
      await linkEngine(repo);
      const log = path.join(sb.home, "ssh");
      await fs.writeTextFile(
        path.join(bin, "ssh"),
        `#!/bin/sh\necho "$@" > "${log}.args"\ncat > "${log}.stdin"\n`,
      );
      await fs.chmod(path.join(bin, "ssh"), 0o755);
      const secrets = path.join(sb.home, "config", "stolos", "secrets", "lab");
      await fs.mkdir(secrets, { recursive: true });
      await fs.writeTextFile(path.join(secrets, "web.json"), `${cred}\n`);
      const r = await sb.run(
        path.join(ENGINE_ROOT, "src/stolos/main.ts"),
        ["boot", "web-push", "alpha"],
        "",
        {
          ARCHON_REPO: repo,
          ARCHON_FLEET: "lab",
          PATH: `${bin}:${proc.env.get("PATH") ?? ""}`,
        },
      );
      assertEquals(r.code, 0, r.out);
      const args = (await fs.readTextFile(`${log}.args`)).trim();
      assert(args.endsWith("alice@alpha archon web credential"), args);
      assertEquals((await fs.readTextFile(`${log}.stdin`)).trim(), cred);
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

proves(
  ["032-web FR-010"],
  "032: verify: HTTPS answers (fail), the certificate is trusted (warn), the name resolves (warn)",
  () => {
    const plan = resolvePlan(host(), webFleet());
    const level = (n: string) => plan.checks.find((c) => c.name === n)?.level;
    assertEquals(level("HTTPS answers with the Archon Console"), "fail");
    assertEquals(level("alpha.lab.example.net has a trusted certificate"), "warn");
    assertEquals(level("alpha.lab.example.net resolves to this server"), "warn");
    const cert = plan.checks.find((c) => c.name.endsWith("has a trusted certificate"));
    // curl without -k: the certificate must verify; without the token, not set up yet (exit 3).
    assert(cert !== undefined);
    assert(cert.command.includes("curl -s --max-time 5") && !cert.command.includes(" -k"));
    assertStringIncludes(cert.command, "--resolve alpha.lab.example.net:443:127.0.0.1");
    assertStringIncludes(cert.command, "|| exit 3");
    const name = plan.checks.find((c) => c.name.endsWith("resolves to this server"));
    assertStringIncludes(name?.command ?? "", "getent ahostsv4 alpha.lab.example.net");
  },
);

proves(
  ["032-web FR-011"],
  "032: Traefik sends its metrics and traces to the local Collector over OTLP/HTTP",
  () => {
    const cfg: unknown = JSON.parse(traefikStatic(resolvePlan(host(), webFleet())));
    assertEquals(
      at(cfg, "metrics", "otlp", "http", "endpoint"),
      "http://127.0.0.1:4318/v1/metrics",
    );
    assertEquals(at(cfg, "tracing", "otlp", "http", "endpoint"), "http://127.0.0.1:4318/v1/traces");
    // Without the local Collector, nothing is sent anywhere.
    const plan = resolvePlan(host(), webFleet());
    const bare: unknown = JSON.parse(
      traefikStatic({
        ...plan,
        units: plan.units.filter((u) => u.unitName !== "archon-otelcol.service"),
      }),
    );
    assertEquals([at(bare, "metrics"), at(bare, "tracing")], [undefined, undefined]);
  },
);
