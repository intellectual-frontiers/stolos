// Spec 047 (Article 25): who a host is lives in Git (registration.ts), and an
// operator's machine checks each server's SSH key against it.

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { hostNames, knownHostsText, registrationSource } from "../src/archon/fleet/registration.ts";
import { sshArgs } from "../src/archon/observe/remote.ts";
import { fleet, host } from "./fixtures.ts";

const ED = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGV4YW1wbGUtaG9zdC1rZXktbm90LXJlYWwtMDAwMDE";
const RSA = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ";

Deno.test("047: registration.ts has one form; known_hosts lines name every way to reach a host", () => {
  const src = registrationSource({ sshHostKeys: [RSA, ED], mac: "aa:bb:cc:dd:ee:ff", added: "t" });
  assert(src.indexOf(ED) < src.indexOf(RSA), "keys sorted");
  assertStringIncludes(src, '  mac: "aa:bb:cc:dd:ee:ff",');
  assertEquals(
    registrationSource({ sshHostKeys: [ED, RSA], mac: "aa:bb:cc:dd:ee:ff", added: "t" }),
    src,
  );

  const f = fleet({ web: { domain: "lab.example.net" } });
  const h = { ...host({ name: "alpha", dnsName: "alpha.localdomain", ip: "10.0.30.57" }) };
  assertEquals(hostNames(f, h), [
    "alpha",
    "alpha.localdomain",
    "10.0.30.57",
    "alpha.lab.example.net",
  ]);
  const text = knownHostsText(f, [
    { ...h, registration: { sshHostKeys: [ED], added: "t" } },
    host({ name: "beta" }), // not registered: no line
  ]);
  assertStringIncludes(text, `alpha,alpha.localdomain,10.0.30.57,alpha.lab.example.net ${ED}\n`);
  assert(!text.includes("beta"));
});

Deno.test("047: fleet commands check servers against known_hosts.auto, then the user's own", () => {
  const args = sshArgs("ops@alpha", 8, "/home/a/.local/share/archon/state/lab/known_hosts.auto");
  assertStringIncludes(
    args.join(" "),
    "UserKnownHostsFile=/home/a/.local/share/archon/state/lab/known_hosts.auto ~/.ssh/known_hosts",
  );
  assert(
    !sshArgs("ops@alpha", 8, "/a b/known_hosts.auto").join(" ").includes("UserKnownHostsFile"),
  );
});
