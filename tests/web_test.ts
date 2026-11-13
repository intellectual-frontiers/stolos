// Specs 032 (HTTPS on every server) and 033 (etckeeper).
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { fleet, host } from "./fixtures.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { validateFleet } from "../src/archon/model/validate.ts";
import {
  dnsRecords,
  fqdn,
  traefikDynamic,
  traefikStatic,
  WEB,
  zoneOf,
} from "../src/archon/web/config.ts";
import { upsertRecords } from "../src/archon/web/cloudflare.ts";
import { renderWelcome } from "../src/archon/web/welcome.ts";
import { listeningPorts } from "../src/archon/web/serve.ts";

const webFleet = () => ({ ...fleet(), web: { domain: "lab.example.net" } });

Deno.test("032: names live under the domain; the zone is its last two labels", () => {
  assertEquals(fqdn(webFleet(), { name: "alpha" }), "alpha.lab.example.net");
  assertEquals(fqdn(fleet(), { name: "alpha" }), undefined);
  assertEquals(zoneOf({ domain: "lab.example.net" }), "example.net");
  assertEquals(
    dnsRecords(webFleet(), host(), "10.0.30.57").map((r) => r.name),
    ["alpha.lab.example.net", "*.alpha.lab.example.net"],
  );
});

Deno.test("032: Traefik redirects 80, limits 443 to the LAN, and gets Let's Encrypt through Cloudflare", () => {
  const plan = resolvePlan(host(), webFleet());
  const s = JSON.parse(traefikStatic(plan));
  assertEquals(s.entryPoints.web.http.redirections.entryPoint.to, "websecure");
  assertEquals(s.entryPoints.websecure.http.middlewares, ["lan@file"]);
  assertEquals(s.entryPoints.websecure.http.tls.domains, [{
    main: "alpha.lab.example.net",
    sans: ["*.alpha.lab.example.net"],
  }]);
  assertEquals(s.certificatesResolvers[WEB.resolver].acme.dnsChallenge.provider, "cloudflare");
  assertEquals(s.providers.docker.endpoint, "unix:///run/podman/podman.sock");
  assertEquals(s.providers.docker.exposedByDefault, false);
  assertStringIncludes(s.providers.docker.defaultRule, ".alpha.lab.example.net`)");
  // Without fleet.web: self-signed, and no resolver.
  const bare = JSON.parse(traefikStatic(resolvePlan(host(), fleet())));
  assertEquals(bare.entryPoints.websecure.http.tls, {});
  assertEquals(bare.certificatesResolvers, undefined);
});

Deno.test("046: the ACME provider is an explicit choice: Let's Encrypt, or its staging service", () => {
  const prod = JSON.parse(traefikStatic(resolvePlan(host(), webFleet())));
  assertEquals(
    prod.certificatesResolvers[WEB.resolver].acme.caServer,
    "https://acme-v02.api.letsencrypt.org/directory",
  );
  const staging = JSON.parse(
    traefikStatic(
      resolvePlan(host(), { ...webFleet(), providers: { acme: "letsencrypt-staging" } }),
    ),
  );
  assertEquals(
    staging.certificatesResolvers[WEB.resolver].acme.caServer,
    "https://acme-staging-v02.api.letsencrypt.org/directory",
  );
});

Deno.test("032: routes from capabilities, the model, and guests; LAN-only; Cockpit over TLS", () => {
  const h = host({
    web: { routes: [{ name: "grafana", port: 3000, description: "dashboards" }] },
    guests: [{
      name: "db",
      kind: "container",
      image: "ubuntu:26.04",
      data: "ephemeral",
      web: { port: 8080 },
    }],
  });
  const plan = resolvePlan(h, webFleet());
  assertEquals(plan.routes.map((r) => r.name).sort(), ["cockpit", "db", "grafana"]);
  const d = JSON.parse(traefikDynamic(plan)).http;
  assert(d.middlewares.lan.ipAllowList.sourceRange.includes("127.0.0.1/32"));
  assert(d.middlewares.lan.ipAllowList.sourceRange.includes("10.0.0.0/16"));
  assertEquals(d.routers.grafana.rule, "Host(`grafana.alpha.lab.example.net`)");
  assertEquals(d.services.grafana.loadBalancer.servers[0].url, "http://127.0.0.1:3000");
  assertEquals(d.services.db.loadBalancer.servers[0].url, "http://db.lxd:8080");
  assertEquals(d.services.cockpit.loadBalancer.servers[0].url, "https://127.0.0.1:9090");
  assertEquals(d.services.cockpit.loadBalancer.serversTransport, "backend-tls");
  assertEquals(d.routers["welcome-any"].priority, 1);
  assertEquals(d.routers.traefik.service, "api@internal");
  // A guest that publishes a port gets .lxd names through systemd-resolved.
  assert(plan.units.some((u) => u.unitName === "archon-lxd-dns.service"));
});

Deno.test("032: 80 and 443 open to everyone; Podman, Traefik on servers only, the welcome page", () => {
  const plan = resolvePlan(host(), webFleet());
  for (const [port, protocol] of [[80, "tcp"], [443, "tcp"], [443, "udp"]] as const) {
    const p = plan.ports.find((x) => x.port === port && x.protocol === protocol);
    assert(p && !p.from, `${port}/${protocol}`);
  }
  assert(plan.packages.some((p) => p.name === "podman"));
  assert(plan.tools.some((t) => t.id === "traefik"));
  assert(plan.files.some((f) => f.path === WEB.staticConfig));
  assert(plan.files.some((f) => f.path === WEB.dynamicConfig));
  assert(plan.files.some((f) => f.path === "/etc/systemd/system/podman.socket.d/50-archon.conf"));
  assert(plan.units.some((u) => u.unitName === "archon-web-dns.timer"));
  const welcome = plan.units.find((u) => u.unitName === WEB.welcomeUnit)!;
  assertStringIncludes(welcome.content!, "ExecStart=/usr/local/bin/archon web serve");
  const traefik = plan.units.find((u) => u.unitName === WEB.unit)!;
  assertStringIncludes(traefik.content!, `EnvironmentFile=-${WEB.env}`);
  assertStringIncludes(traefik.content!, "AmbientCapabilities=CAP_NET_BIND_SERVICE");
});

Deno.test("032: route names, ports, and the domain are validated", () => {
  const bad = validateFleet(
    { ...webFleet(), web: { domain: "Not A Domain" } },
    [host({ web: { routes: [{ name: "cockpit", port: 70000 }, { name: "Bad_Name", port: 80 }] } })],
  ).map((p) => p.message);
  assert(bad.some((m) => m.includes("is not a DNS name")));
  assert(bad.some((m) => m.includes("'cockpit' is taken")));
  assert(bad.some((m) => m.includes("port 70000")));
  assert(bad.some((m) => m.includes("not a DNS label")));
  const noWeb = validateFleet(fleet(), [host({ web: { routes: [{ name: "app", port: 3000 }] } })]);
  assert(noWeb.some((p) => p.message.includes("routes need fleet.web")));
  assertEquals(validateFleet(webFleet(), [host()]), []);
});

Deno.test("032: Cloudflare records are created, corrected, or left alone", async () => {
  const records = new Map<
    string,
    { id: string; content: string; proxied: boolean; ttl: number }
  >([
    ["alpha.lab.example.net", {
      id: "r1",
      content: "10.0.30.57",
      proxied: false,
      ttl: 60,
    }],
    ["*.alpha.lab.example.net", { id: "r2", content: "10.0.0.9", proxied: false, ttl: 60 }],
  ]);
  const calls: string[] = [];
  const fake = ((input: string, init?: RequestInit) => {
    const u = new URL(input);
    calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
    const ok = (result: unknown) => Promise.resolve(Response.json({ success: true, result }));
    if (u.pathname.endsWith("/zones")) return ok([{ id: "z", name: "example.net" }]);
    if ((init?.method ?? "GET") === "GET") {
      const r = records.get(u.searchParams.get("name")!);
      return ok(r ? [r] : []);
    }
    return ok({});
  }) as typeof fetch;
  const done = await upsertRecords(
    "t".repeat(40),
    "example.net",
    [
      { type: "A", name: "alpha.lab.example.net", content: "10.0.30.57" },
      { type: "A", name: "*.alpha.lab.example.net", content: "10.0.30.57" },
      { type: "A", name: "rome.lab.example.net", content: "10.0.30.58" },
    ],
    "archon test",
    fake,
  );
  assertEquals(done.map((d) => d.action), ["unchanged", "updated", "created"]);
  assert(calls.includes("PUT /client/v4/zones/z/dns_records/r2"));
  assert(calls.includes("POST /client/v4/zones/z/dns_records"));
});

Deno.test("035: the welcome page explains the server in plain words, with an agent section", async () => {
  const { guideFor, agentSetup } = await import("../src/archon/guide/guide.ts");
  const { stripGlyphs } = await import("../src/archon/web/welcome.ts");
  const plan = resolvePlan(host(), {
    ...webFleet(),
    mail: { to: "box@example.com", domain: "example.net", tag: "lab" },
  });
  const now = new Date("2026-11-12T14:00:00Z");
  const html = renderWelcome({
    host: "alpha",
    fqdn: "alpha.lab.example.net",
    title: "Alice <Example>'s fleet",
    os: "Ubuntu 26.04.1 LTS",
    address: "10.0.30.57",
    repo: { slug: "example/fleet", url: "https://github.com/example/fleet" },
    lastRun: {
      command: "update",
      failures: 0,
      warnings: 0,
      deferred: 0,
      push: true,
      at: "2026-11-12T13:55:00Z",
    },
    verify: { at: "2026-11-12T13:55:00Z", passed: 96, total: 96, failed: [] },
    installed: { at: "2026-11-12T13:43:21Z", ok: false, checks: { passed: 92, total: 96 } },
    certificate: { issuer: "C=US, O=Let's Encrypt, CN=YR2", notAfter: "Feb 10 12:52:55 2027 GMT" },
    updates: { pending: 0, reboot: false, rebootPackages: [] },
    backup: { last: "2026-11-12T05:00:00Z", ok: true },
    services: [{
      name: "cockpit",
      url: "https://cockpit.alpha.lab.example.net",
      source: "system",
    }, { name: "hello", url: "https://hello.alpha.lab.example.net", source: "container" }],
    unrouted: [3000],
    guide: guideFor(plan),
    agent: agentSetup(plan),
    guides: [{ name: "guide", title: "Guide" }, { name: "agent", title: "Agents" }],
    admin: "alice",
    mailbox: "box@example.com",
    generated: "2026-11-12 14:00 UTC",
  }, now);
  assertStringIncludes(html, "Alice &lt;Example&gt;&#39;s fleet");
  assertStringIncludes(html, "Healthy: all 96 checks pass.");
  assertStringIncludes(html, "96 of 96 pass, checked 5 minutes ago");
  assertStringIncludes(html, "archon update, succeeded, 5 minutes ago");
  assertStringIncludes(html, "Trusted (Let's Encrypt)");
  assertStringIncludes(html, 'href="https://hello.alpha.lab.example.net"');
  assertStringIncludes(html, ">container<");
  // The agent section: any MCP client, and the Git loop.
  assertStringIncludes(html, 'id="agent"');
  assertStringIncludes(html, "ssh -T -o BatchMode=yes");
  assertStringIncludes(html, "Keep the fleet up to date through Git");
  assertStringIncludes(html, "git clone https://github.com/example/fleet.git");
  // What's here, by category, with live links; the mailbox; copy buttons.
  assertStringIncludes(html, "https://cockpit.alpha.lab.example.net/system/logs");
  assertStringIncludes(html, "Run an app in a container (Podman)");
  assertStringIncludes(html, "box@example.com");
  assertStringIncludes(html, 'data-copy="archon verify"');
  assertStringIncludes(html, "port <code>3000</code>");
  // No Nerd Font glyphs (they render as boxes).
  assert(!/[\uE000-\uF8FF]/.test(html));
  assertEquals(stripGlyphs("\uF00C update  \uF0EE push"), "update push");
});

Deno.test("035: health in plain words, and what to do", async () => {
  const { health } = await import("../src/archon/web/welcome.ts");
  const base = {
    host: "alpha",
    title: "t",
    os: "o",
    repo: { slug: "a/b", url: "u" },
    services: [],
    unrouted: [],
    guide: [],
    guides: [],
    admin: "a",
    generated: "g",
  };
  assertEquals(
    health({ ...base, verify: { at: "x", passed: 5, total: 5, failed: [] } }).level,
    "ok",
  );
  const h = health({
    ...base,
    fqdn: "alpha.example.org",
    verify: { at: "x", passed: 4, total: 5, failed: ["traefik.service"] },
    updates: { reboot: true, rebootPackages: ["linux-image"] },
    certificate: { issuer: "CN=TRAEFIK DEFAULT CERT", notAfter: "x" },
  });
  assertEquals(h.level, "warn");
  assertEquals(h.todo.length, 3);
});

Deno.test("035: only ports open to the network are offered for publishing", () => {
  const ss = [
    "LISTEN 0 4096 127.0.0.1:8090 0.0.0.0:*",
    "LISTEN 0 100 127.0.0.1:25 0.0.0.0:*",
    "LISTEN 0 4096 [::1]:4318 [::]:*",
    "LISTEN 0 4096 *:443 *:*",
    "LISTEN 0 4096 [::]:3000 [::]:*",
    "LISTEN 0 4096 0.0.0.0:5000 0.0.0.0:*",
  ].join("\n");
  assertEquals(listeningPorts(ss), [443, 3000, 5000]);
});

Deno.test("035: containers come from Traefik's live routes; unit times parse", async () => {
  const { routersToServices, parseLastRun } = await import("../src/archon/web/serve.ts");
  assertEquals(
    routersToServices([
      {
        name: "hello@docker",
        rule: "Host(`hello.alpha.example.org`)",
        provider: "docker",
        status: "enabled",
      },
      { name: "cockpit@file", rule: "Host(`cockpit.alpha.example.org`)", provider: "file" },
    ]),
    [{ name: "hello", url: "https://hello.alpha.example.org", source: "container" }],
  );
  assertEquals(parseLastRun("ExecMainExitTimestamp=@1762955462\nResult=success\n"), {
    at: "2025-11-12T13:51:02.000Z",
    ok: true,
  });
  assertEquals(parseLastRun("ExecMainExitTimestamp=\nResult=success\n"), {});
});

Deno.test("035: guides render from Markdown; links to other guides stay on the server", async () => {
  const { markdownToHtml } = await import("../src/archon/web/markdown.ts");
  const ctx = { served: ["dotfiles", "web"], repoBlob: "https://github.com/a/b/blob/main/" };
  const html = markdownToHtml(
    "# T\n\n## Layers\n\nSee [dotfiles](dotfiles.md) and [hosts](hosts.md) or [AGENTS.md](../AGENTS.md).\n\n| a | b |\n|---|---|\n| `x` | <y> |\n\n```sh\necho <hi>\n```\n\n- one\n- **two**\n",
    ctx,
  );
  assertStringIncludes(html, '<h3 id="layers">Layers</h3>');
  assertStringIncludes(html, 'href="/guide/dotfiles"');
  assertStringIncludes(html, 'href="https://github.com/a/b/blob/main/docs/hosts.md"');
  assertStringIncludes(html, 'href="https://github.com/a/b/blob/main/AGENTS.md"');
  assertStringIncludes(html, "<td><code>x</code></td><td>&lt;y&gt;</td>");
  assertStringIncludes(html, "<pre><code>echo &lt;hi&gt;</code></pre>");
  assertStringIncludes(html, "<li><strong>two</strong></li>");
  assert(!html.includes("<y>"));
});

Deno.test("035: archon guide and its man page exist; the banner points to it", async () => {
  const { COMMANDS } = await import("../src/archon/commands/registry.ts");
  assert(COMMANDS.some((c) => c.name === "guide" && c.tier === "read"));
  const { renderManPages } = await import("../src/archon/render/man.ts");
  assertStringIncludes(
    renderManPages().get("man7/archon-guide.7")!,
    "MANAGE THIS SERVER WITH AN AI AGENT",
  );
  const { archonMotd } = await import("../src/archon/render/motd.ts");
  assertStringIncludes(archonMotd(webFleet(), host(), true), "archon guide");
  assert((await Deno.readTextFile("AGENTS.md")).includes("constitution"));
});

Deno.test("033: etckeeper keeps /etc's history locally, never with a remote", () => {
  const plan = resolvePlan(host(), webFleet());
  assert(plan.packages.some((p) => p.name === "etckeeper"));
  const remote = plan.checks.find((c) => c.name === "/etc's history has no remote")!;
  assertEquals(remote.level, "fail");
  assert(plan.units.some((u) => u.unitName === "etckeeper.timer"));
});

Deno.test("032: a reinstall carries the Let's Encrypt store; an expiring one is not delivered", async () => {
  const { storeCertificates, deliverable, describeCarry, validUntil } = await import(
    "../src/archon/web/acme.ts"
  );
  const store = JSON.stringify({
    letsencrypt: {
      Account: { Email: "x@example.com" },
      Certificates: [{
        domain: { main: "alpha.lab.example.net", sans: ["*.alpha.lab.example.net"] },
        certificate: btoa("-----BEGIN CERTIFICATE-----\n...\n"),
        key: btoa("KEY"),
        Store: "default",
      }],
    },
  });
  const certs = storeCertificates(store);
  assertEquals(certs.map((c) => c.main), ["alpha.lab.example.net"]);
  assertEquals(storeCertificates("not json"), []);
  const now = Date.parse("2026-11-12T00:00:00Z");
  const carry = {
    host: "alpha",
    exported: "2026-11-12T00:00:00Z",
    certificates: [{
      main: "alpha.lab.example.net",
      sans: ["*.alpha.lab.example.net"],
      notAfter: "2027-02-09T00:00:00.000Z",
    }],
    acme: store,
  };
  assert(deliverable(carry, now));
  assertEquals(validUntil(carry)?.toISOString().slice(0, 10), "2027-02-09");
  assertEquals(
    describeCarry(carry),
    "alpha.lab.example.net and *.alpha.lab.example.net, valid until 2027-02-09",
  );
  // Expiring within a day, or no certificates: not delivered.
  assert(!deliverable(carry, Date.parse("2027-02-08T12:00:00Z")));
  assert(!deliverable({ ...carry, certificates: [] }, now));

  // The install hands it back; the first boot puts it in place before Traefik starts.
  const { userData } = await import("../src/archon/render/autoinstall.ts");
  const u = userData(
    { fleet: webFleet(), host: host(), base: "http://10.0.0.5:8080/install/alpha/tok/" },
    {
      passwordHash: "$6$abc$def",
      hostKeys: [{ type: "ed25519", private: "PRIVATE\n", public: "ssh-ed25519 AAAA" }],
      acme: store,
    },
  );
  const files = JSON.parse(u.slice("#cloud-config\n".length)).autoinstall["user-data"].write_files;
  const f = files.find((x: { path: string }) => x.path === "/etc/archon/acme.json");
  assertEquals(f.permissions, "0600");
  assertEquals(f.content, store);

  // Traefik runs as its own account, so the first boot can hand it the store.
  const plan = resolvePlan(host(), webFleet());
  const users = plan.files.find((x) => x.path === "/etc/sysusers.d/archon-web.conf")!.content!;
  assertStringIncludes(users, 'u traefik - "Archon Traefik" /var/lib/traefik');
  const unit = plan.units.find((x) => x.unitName === WEB.unit)!.content!;
  assertStringIncludes(unit, "User=traefik");
  assert(!unit.includes("DynamicUser"));

  // A cache: never backed up, never a backup reminder.
  const { secretFor } = await import("../src/archon/model/secret-inventory.ts");
  assertEquals(secretFor("hosts/alpha/acme.json")?.ephemeral, true);
});

Deno.test("archon's own daemons are restarted when the code changes (not oneshots, not timers)", async () => {
  const { archonDaemons } = await import("../src/archon/apply/apply.ts");
  const plan = resolvePlan(host(), webFleet());
  const d = archonDaemons(plan.units);
  assert(d.includes("archon-web.service"));
  assert(!d.includes("archon-web-dns.service"));
  assert(!d.some((u) => u.endsWith(".timer")));
});

Deno.test("no dynamic account shares a name with an account or group sysusers creates", () => {
  for (const f of [fleet(), webFleet()]) {
    const plan = resolvePlan(host(), f);
    const taken = new Set(
      plan.files
        .filter((x) => x.path.startsWith("/etc/sysusers.d/") && x.content)
        .flatMap((x) => x.content!.split("\n"))
        .map((l) => l.trim().split(/\s+/))
        .filter((w) => w[0] === "u" || w[0] === "g")
        .map((w) => w[1]),
    );
    for (const u of plan.units.filter((x) => x.content?.includes("DynamicUser=true"))) {
      const user = u.content!.match(/^User=(\S+)$/m)?.[1] ??
        u.unitName.replace(/\.service$/, "");
      assert(!taken.has(user), `${u.unitName}: its dynamic account ${user} already exists`);
    }
  }
});

Deno.test("032: Cloudflare follows the server's address: on a change, else once a day", async () => {
  const { dnsDue } = await import("../src/archon/web/commands.ts");
  const now = new Date("2026-11-13T12:00:00Z");
  assertEquals(dnsDue("10.0.30.59", undefined, now), "changed", "never published");
  assertEquals(
    dnsDue("10.0.30.60", { address: "10.0.30.59", at: "2026-11-13T11:55:00Z" }, now),
    "changed",
    "a new DHCP lease",
  );
  assertEquals(
    dnsDue("10.0.30.59", { address: "10.0.30.59", at: "2026-11-13T11:55:00Z" }, now),
    undefined,
    "nothing to do: no call to Cloudflare",
  );
  assertEquals(
    dnsDue("10.0.30.59", { address: "10.0.30.59", at: "2026-11-12T11:00:00Z" }, now),
    "daily",
    "repairs drift once a day",
  );
  const plan = resolvePlan(host(), webFleet());
  const timer = plan.units.find((u) => u.unitName === "archon-web-dns.timer")!.content!;
  assertStringIncludes(timer, "OnBootSec=30s");
  assertStringIncludes(timer, "OnUnitActiveSec=5min");
  const svc = plan.units.find((u) => u.unitName === "archon-web-dns.service")!.content!;
  assertStringIncludes(svc, "ExecStart=/usr/local/bin/archon web dns-check");
});

Deno.test("032: records are written with a 60-second TTL (a new address spreads fast)", async () => {
  const { upsertRecords } = await import("../src/archon/web/cloudflare.ts");
  const bodies: string[] = [];
  const fake = ((url: string, init?: RequestInit) => {
    if (init?.body) bodies.push(String(init.body));
    const result = url.includes("/zones?name=")
      ? [{ id: "z", name: "example.net" }]
      : url.includes("dns_records?type=A")
      ? [{ id: "r", content: "10.0.30.57", proxied: false, ttl: 300 }]
      : {};
    return Promise.resolve(new Response(JSON.stringify({ success: true, result })));
  }) as typeof fetch;
  const out = await upsertRecords(
    "t",
    "example.net",
    [{ type: "A", name: "beta.lab.example.net", content: "10.0.30.59" }],
    "test",
    fake,
  );
  assertEquals(out[0].action, "updated");
  assertEquals(JSON.parse(bodies[0]).ttl, 60);
});

Deno.test("046: reserved test domains (a synthetic fleet's) are known as such", async () => {
  const { isReservedDomain } = await import("../src/archon/model/providers.ts");
  for (const d of ["example.net", "uat.example.net", "EXAMPLE.com.", "x.test", "a.invalid"]) {
    assert(isReservedDomain(d), d);
  }
  for (const d of ["acme.dev", "srv.acme.dev", "notexample.net", "example.network"]) {
    assert(!isReservedDomain(d), d);
  }
});
