/**
 * Spec 004: adding a host, the install config's site options and what it installs, the boot
 * server's own HTTP/1.1, and the boot doctor.
 *
 * @module
 */
import { createConnection } from "node:net";
import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { listen } from "../src/archon-boot/http.ts";
import { handler } from "../src/archon-boot/server.ts";
import type { ArchonEvent } from "../src/archon/telemetry/events.ts";
import { firstBootScript, userData } from "../src/archon/render/autoinstall.ts";
import { fleet, host } from "./fixtures.ts";
import { ENGINE_ROOT, linkEngine, sandbox, type Sandbox } from "./sandbox.ts";

const posix = proc.build.os !== "windows";

/** A fleet repository with the example lab, the engine installed, in a fresh sandbox. */
async function lab(): Promise<{ sb: Sandbox; repo: string; env: Record<string, string> }> {
  const sb = await sandbox("archon-install-test-");
  const repo = path.join(sb.home, "fleet");
  await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
  await fs.copy(
    path.join(ENGINE_ROOT, "examples", "fleets", "lab"),
    path.join(repo, "fleets", "lab"),
  );
  await linkEngine(repo);
  return { sb, repo, env: { ARCHON_REPO: repo, ARCHON_FLEET: "lab" } };
}

const stolos = (l: Awaited<ReturnType<typeof lab>>, args: string[], extra = {}) =>
  l.sb.run(path.join(ENGINE_ROOT, "src", "stolos", "main.ts"), args, "", { ...l.env, ...extra });

/** The autoinstall section of a rendered user-data file, as JSON. */
const autoinstall = (u: string): Record<string, unknown> => {
  const doc: unknown = JSON.parse(u.slice("#cloud-config\n".length));
  const ai: unknown =
    typeof doc === "object" && doc !== null ? Reflect.get(doc, "autoinstall") : {};
  return typeof ai === "object" && ai !== null ? (ai as Record<string, unknown>) : {};
};

proves(
  ["004-install FR-001"],
  "004: host add writes host.ts, makes and registers an ed25519 deploy key, arms the host, prints its Boot URI",
  async () => {
    const l = await lab();
    try {
      // A gh signed in as a repository admin: it lists no keys, then adds the new one.
      const bin = path.join(l.sb.home, "bin");
      await fs.mkdir(bin);
      await fs.writeTextFile(
        path.join(bin, "gh"),
        `#!/bin/sh\necho "$*" >> "${bin}/gh.log"\ncase "$*" in *--paginate*) echo '[]';; *) echo '{"id":1}';; esac\n`,
      );
      await fs.chmod(path.join(bin, "gh"), 0o755);
      const r = await stolos(
        l,
        ["host", "add", "gamma", "--mac-address", "52:54:00:12:34:56", "--no-push"],
        {
          PATH: `${bin}:${proc.env.get("PATH") ?? ""}`,
        },
      );
      assertEquals(r.code, 0, r.out);
      // The model: hosts/gamma/host.ts, a host of the fleet.
      const src = await fs.readTextFile(
        path.join(l.repo, "fleets", "lab", "hosts", "gamma", "host.ts"),
      );
      assertStringIncludes(src, 'name: "gamma"');
      // The deploy key: ed25519, private half in the secret store only.
      const secrets = path.join(l.sb.home, "config", "stolos", "secrets", "lab", "hosts", "gamma");
      const pub = (await fs.readTextFile(path.join(secrets, "deploy_key.pub"))).trim();
      assert(pub.startsWith("ssh-ed25519 "), pub);
      assertStringIncludes(
        await fs.readTextFile(path.join(secrets, "deploy_key")),
        "BEGIN OPENSSH PRIVATE KEY",
      );
      // Registered on the fleet's repository through gh.
      const gh = await fs.readTextFile(path.join(bin, "gh.log"));
      assertStringIncludes(gh, "api repos/example/fleet/keys --paginate");
      assertStringIncludes(
        gh,
        `api repos/example/fleet/keys -f title=archon host gamma -f key=${pub.split(" ").slice(0, 2).join(" ")}`,
      );
      // Armed: one install token for gamma, with the MAC it is recognized by.
      const tokens = JSON.parse(
        await fs.readTextFile(
          path.join(l.sb.home, "config", "stolos", "secrets", "lab", "install-tokens.json"),
        ),
      ) as Array<{ host: string; mac?: string }>;
      assertEquals(
        tokens.map((t) => [t.host, t.mac]),
        [["gamma", "52:54:00:12:34:56"]],
      );
      // Its Boot URI, for firmware that takes one.
      assert(/http:\/\/\S+:8080\/boot\/gamma\/bootx64\.efi/.test(r.out), r.out);

      // The MAC is optional: a host is recognized by its Boot URI (or claimed).
      const again = await stolos(
        l,
        ["host", "add", "delta", "--claim", "--no-push", "--no-deploy-key"],
        {
          PATH: `${bin}:${proc.env.get("PATH") ?? ""}`,
        },
      );
      assertEquals(again.code, 0, again.out);
      assert(/\/boot\/delta\/bootx64\.efi/.test(again.out), again.out);
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: posix ? false : "a stand-in gh written as a POSIX shell script", timeout: 120_000 },
);

proves(
  ["004-install FR-006"],
  "004: --proxy, --ca-file and --github-api reach the installer, the first boot, and the system store",
  async () => {
    const base = "http://10.0.0.5:8080/install/alpha/tok/";
    const ca = "-----BEGIN CERTIFICATE-----\nMIIBsite\n-----END CERTIFICATE-----\n";
    const u = userData(
      {
        fleet: fleet(),
        host: host(),
        base,
        proxy: "http://proxy.lab.example.net:3128",
        caPem: ca,
        githubApi: "http://10.0.0.9:8001",
      },
      { passwordHash: "x" },
    );
    const ai = autoinstall(u);
    // The installer uses the proxy, and Ubuntu's HTTPS mirrors behind it.
    assertEquals(ai["proxy"], "http://proxy.lab.example.net:3128");
    assertEquals(JSON.stringify(ai["apt"]).includes("https://archive.ubuntu.com/ubuntu"), true);
    assertEquals(JSON.stringify(ai["apt"]).includes("https://security.ubuntu.com/ubuntu"), true);
    // The CA: fetched from the boot server and trusted inside the installer ...
    const early = JSON.stringify(ai["early-commands"]);
    assertStringIncludes(early, "http://10.0.0.5:8080/site-ca.crt");
    assertStringIncludes(early, "update-ca-certificates");
    // ... and by the installed system (cloud-init's ca_certs), Bun and Node through its store.
    const ud = JSON.stringify(ai["user-data"]);
    const cloud = ai["user-data"];
    assert(typeof cloud === "object" && cloud !== null);
    assertEquals(Reflect.get(cloud, "ca_certs"), { trusted: [ca] });
    assertStringIncludes(ud, "NODE_USE_SYSTEM_CA=1");
    // The first boot uses the proxy (not for the boot server or the mirror) and the API mirror.
    assertStringIncludes(ud, "export http_proxy=http://proxy.lab.example.net:3128");
    assertStringIncludes(ud, "no_proxy=localhost,127.0.0.1,10.0.0.5,10.0.0.9");
    assertStringIncludes(ud, "export ARCHON_GITHUB_API=http://10.0.0.9:8001");
    // Without site options, none of it.
    const plain = autoinstall(
      userData({ fleet: fleet(), host: host(), base }, { passwordHash: "x" }),
    );
    assertEquals([plain["proxy"], plain["apt"]], [undefined, undefined]);
    assert(!JSON.stringify(plain).includes('"path":"/etc/archon/proxy.env"'));
    assert(JSON.stringify(ai).includes('"path":"/etc/archon/proxy.env"'));

    // The boot server serves the CA at /site-ca.crt.
    const events: ArchonEvent[] = [];
    const h = handler(
      { files: {}, iso: "" },
      { port: 8080, caPem: ca, emit: (e) => events.push(e) },
    );
    const res = await h(new Request("http://10.0.0.5:8080/site-ca.crt"), "10.0.30.57");
    assertEquals([res.status, await res.text()], [200, ca]);
  },
);

proves(
  ["004-install FR-007"],
  "004: the install adds no packages; what the first boot needs is installed at first boot",
  () => {
    const ai = autoinstall(
      userData(
        { fleet: fleet(), host: host(), base: "http://10.0.0.5:8080/install/alpha/tok/" },
        { passwordHash: "x" },
      ),
    );
    assertEquals(ai["packages"], undefined);
    const ud = ai["user-data"];
    assert(typeof ud === "object" && ud !== null);
    assertEquals(Reflect.get(ud, "packages"), undefined);
    // Only security updates during the install; everything else comes after it.
    assertEquals(ai["updates"], "security");
    // The first boot installs unzip (for Bun's zip) itself, only when it is missing.
    assertStringIncludes(
      firstBootScript(fleet(), host()),
      "command -v unzip >/dev/null 2>&1 || { apt-get update -q && apt-get install -y -q unzip; }",
    );
  },
);

/** One raw HTTP exchange: what was sent, everything received until the server closes or `ms` pass. */
function exchange(
  port: number,
  request: string,
  ms = 1500,
): Promise<{ data: string; closed: boolean }> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    let data = "";
    let done = false;
    const end = (closed: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve({ data, closed });
    };
    s.setEncoding("latin1");
    s.on("data", (d: string) => (data += d));
    s.on("end", () => end(true));
    s.on("close", () => end(true));
    s.on("error", () => end(true));
    setTimeout(() => end(false), ms);
    s.write(request);
  });
}

proves(
  ["004-install FR-008"],
  "004: HTTP/1.1 with canonical header names, closed after HEAD, and shim's \\grubx64.efi path",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-http-test-" });
    const grub = path.join(dir, "grubx64.efi");
    await fs.writeTextFile(grub, "GRUB".repeat(256));
    const events: ArchonEvent[] = [];
    // Port 0: the system picks a free one; the listener says which.
    const h = handler(
      { files: { "grubx64.efi": grub, "bootx64.efi": grub }, iso: "" },
      { port: 8080, emit: (e) => events.push(e) },
    );
    const listener = await listen(0, h, "127.0.0.1");
    const port = listener.addr.port;
    try {
      // GET over a kept-alive connection: canonical names, exact length, connection stays open.
      const get = await exchange(port, "GET /grubx64.efi HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      assert(get.data.startsWith("HTTP/1.1 200 OK\r\n"), get.data.slice(0, 80));
      assertStringIncludes(get.data, "\r\nContent-Length: 1024\r\n");
      assert(
        !/\r\ncontent-length:/.test(get.data),
        "never lowercase (GRUB compares case-sensitively)",
      );
      assert(get.data.endsWith("GRUB".repeat(256)));
      assertEquals(get.closed, false, "a GET keeps the connection for GRUB's next request");
      // HEAD: the head only, then the server closes (UEFI's HTTP driver waits for a body otherwise).
      const head = await exchange(port, "HEAD /grubx64.efi HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      assert(head.data.startsWith("HTTP/1.1 200 OK\r\n"), head.data.slice(0, 80));
      assertStringIncludes(head.data, "\r\nContent-Length: 1024\r\n");
      assert(head.data.endsWith("\r\n\r\n"), "no body after HEAD");
      assertEquals(head.closed, true, "closed after HEAD");
      // Shim asks for its second stage with a backslash.
      const shim = await exchange(
        port,
        "GET /%5Cgrubx64.efi HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
      );
      assert(shim.data.startsWith("HTTP/1.1 200 OK\r\n"), shim.data.slice(0, 80));
      assert(shim.data.endsWith("GRUB".repeat(256)));
      assert(events.some((e) => e.name === "boot.file" && e.message.endsWith("grubx64.efi")));
    } finally {
      listener.close();
      await fs.remove(dir, { recursive: true });
    }
  },
  { timeout: 120_000 },
);

proves(
  ["004-install FR-016"],
  "004: boot doctor checks the checkout, model, secrets, Ubuntu's files, ports, firewall; read-only, each with a fix",
  async () => {
    const l = await lab();
    try {
      // A checkout cloned from its origin, then a host change nobody committed.
      const git = (...args: string[]) => proc.output(["git", "-C", l.repo, ...args]);
      const origin = path.join(l.sb.home, "origin.git");
      await proc.output(["git", "init", "-q", "--bare", origin]);
      await git("init", "-q", "-b", "main");
      await git("-c", "user.name=t", "-c", "user.email=t@example.net", "add", "fleets");
      await git("-c", "user.name=t", "-c", "user.email=t@example.net", "commit", "-q", "-m", "lab");
      await git("remote", "add", "origin", origin);
      await git("push", "-q", "origin", "main");
      const beta = path.join(l.repo, "fleets", "lab", "hosts", "beta", "host.ts");
      await fs.writeTextFile(beta, (await fs.readTextFile(beta)) + "// changed\n");
      const before = (await git("status", "--porcelain")).stdout;
      // A port nothing listens on, so the doctor checks it is free.
      const probe = await listen(0, () => Promise.resolve(new Response("")), "127.0.0.1");
      const port = probe.addr.port;
      probe.close();
      const r = await stolos(l, ["boot", "doctor", "--port", String(port)]);
      assert(r.code !== 0, r.out);
      for (const phase of ["Checkout", "Model", "Secrets", "Ubuntu files", "Network", "Firewall"]) {
        assertStringIncludes(r.out, phase);
      }
      // Uncommitted host changes: hosts would not see them, and the fix.
      assertStringIncludes(r.out, "not committed");
      assertStringIncludes(r.out, 'bun run stolos apply -m "<what changed>"');
      // No admin password hash, and how to make one.
      assertStringIncludes(r.out, "no admin password hash");
      assertStringIncludes(r.out, "bun run stolos fleet init");
      // Hosts without a deploy key.
      assertStringIncludes(r.out, "alpha has no deploy key");
      // Ubuntu's files not downloaded yet: what downloads them.
      assertStringIncludes(r.out, "not downloaded yet");
      assertStringIncludes(r.out, "boot serve is not running");
      // Read-only: the checkout is as it was.
      assertEquals((await git("status", "--porcelain")).stdout, before);
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: posix ? false : "git and the checkout's setup in POSIX paths", timeout: 120_000 },
);
