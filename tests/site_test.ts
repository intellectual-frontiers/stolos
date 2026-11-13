// Spec 028: the site model, its rules, and its exports.
import { assert, assertEquals } from "./assert.ts";
import {
  cidr,
  inCidr,
  ipv4,
  port,
  type SiteDef,
  validateSite,
  vlan,
} from "../src/archon/model/site.ts";
import { site as owners } from "../examples/fleets/lab/site.ts";
import { host } from "./fixtures.ts";
import { networkOf } from "../src/archon/model/resolve.ts";
import { renderNetworkDoc } from "../src/archon/render/network-doc.ts";
import { siteTurtle } from "../src/archon/model/export.ts";
import { SECRET_INVENTORY } from "../src/archon/model/secret-inventory.ts";

// A server on the owner's site, as a host's model and the router both record it
// (fixtures: the tests never depend on which hosts the fleet has today).
const alpha = host({
  network: "Servers",
  ip: "10.0.30.57",
  dnsName: "alpha.localdomain",
  switchPort: "flex-2.5g/3",
});
const site: SiteDef = {
  ...owners,
  dns: {
    ...owners.dns,
    localRecords: [{ name: "alpha.localdomain", address: ipv4("10.0.30.57") }],
  },
};
const clone = (): SiteDef => structuredClone(site);
const messages = (s: SiteDef, hosts = [alpha]) => validateSite(s, hosts).map((p) => p.message);

Deno.test("site: branded values reject malformed literals", () => {
  assertEquals(ipv4("10.0.30.57"), "10.0.30.57");
  for (const bad of ["10.0.1", "256.1.1.1", "a.b.c.d"]) {
    let threw = false;
    try {
      ipv4(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
  assert(inCidr("10.0.30.57", cidr("10.0.30.0/24")));
  assert(!inCidr("10.0.31.1", cidr("10.0.30.0/24")));
  let threw = 0;
  for (const f of [() => vlan(0), () => vlan(4095), () => port(70000), () => cidr("10.0.0.0/33")]) {
    try {
      f();
    } catch {
      threw++;
    }
  }
  assertEquals(threw, 4);
});

Deno.test("site: the owner's network is valid as modeled", () => {
  assertEquals(validateSite(owners, []), [], "the owner's site, with the fleet's hosts today");
  assertEquals(validateSite(site, [alpha]), []);
  // The reference's facts (spec 028).
  assertEquals(site.networks.find((n) => n.name === "Servers")?.netboot?.file, "bootx64.efi");
  assert(
    site.policies.some((p) => p.id === 4 && p.protocol === "udp" && p.ports?.includes(port(69))),
  );
  assert(
    site.policies.some((p) => p.id === 7 && p.protocol === "tcp" && p.ports?.includes(port(8080))),
  );
  assertEquals(site.dns.upstream, ["1.1.1.1", "9.9.9.9"]);
  assertEquals(site.mdnsProxy.networks, ["Default", "IoT"]);
});

Deno.test("site: a network that boots from Archon needs UDP 69 and TCP 8080 to the boot server", () => {
  const s = clone();
  s.policies = s.policies.filter((p) => p.id !== 7);
  assert(messages(s).some((m) => /no policy allows Servers to reach it on TCP 8080/.test(m)));
  // Default is in the boot server's own zone: no policy needed.
  assert(!messages(clone()).some((m) => /Default boots/.test(m)));
});

Deno.test("site: a moved boot server lists exactly what to change in UniFi", () => {
  const s = clone();
  s.bootServer.address = ipv4("10.0.1.158");
  const ps = validateSite(s, [alpha]);
  const netboot = ps.filter((p) => /Network Boot points at/.test(p.message)).map((p) => p.where);
  assertEquals(netboot.sort(), ["site.networks.Default.netboot", "site.networks.Servers.netboot"]);
  assert(ps.some((p) => /no policy allows Servers/.test(p.message)), "and the two policies");
  assert(ps.every((p) => p.fix.length > 0));
});

Deno.test("site: Servers and DMZ are never in the mDNS proxy", () => {
  const s = clone();
  s.mdnsProxy.networks.push("Servers");
  assert(messages(s).some((m) => /Servers \(Servers\) is in the mDNS proxy's scope/.test(m)));
  const d = clone();
  d.networks.find((n) => n.name === "DMZ")!.mdnsReflect = true;
  assert(messages(d).some((m) => /DMZ \(DMZ\) is in the mDNS proxy's scope/.test(m)));
});

Deno.test("site: fixed addresses are unique and inside their network", () => {
  assert(
    messages(clone(), [{ ...alpha, ip: "10.0.20.5" }]).some((m) => /outside Servers/.test(m)),
  );
  assert(
    messages(clone(), [alpha, { ...alpha, name: "rome", dnsName: undefined }]).some((m) =>
      /10\.0\.30\.57 is also host alpha/.test(m)
    ),
  );
});

Deno.test("site: guest Wi-Fi is WPA3; every host's name is a Local DNS record", () => {
  const s = clone();
  s.wifi.find((w) => w.guest)!.security = "wpa2/wpa3";
  assert(messages(s).some((m) => /guest Wi-Fi uses wpa2\/wpa3/.test(m)));
  const r = clone();
  r.dns.localRecords = [];
  assert(messages(r).some((m) => /alpha\.localdomain is not in the router's Local DNS/.test(m)));
  assert(
    validateSite(clone(), [alpha], { collector: "otel.localdomain" }).some((p) =>
      /otel\.localdomain/.test(p.message)
    ),
  );
});

Deno.test("site: a host's IPv6 follows its network, with a per-host override", () => {
  const f = { site, network: { ipv6: true } };
  assertEquals(networkOf(f, { network: "Servers" }).ipv6, false);
  assertEquals(networkOf(f, { network: "Servers", ipv6: true }).ipv6, true);
  assertEquals(networkOf(f, {}).ipv6, true, "outside the site: the fleet's fallback");
});

Deno.test("site: the network reference and RDF carry names, never secrets", () => {
  const html = renderNetworkDoc(site, [alpha]);
  assert(html.includes("GENERATED by archon build"));
  for (
    const s of [
      "Example Guest",
      "10.0.1.157 / bootx64.efi",
      "Allow Servers netboot HTTP to Archon",
      "alpha.localdomain",
      "flex-2.5g/3",
    ]
  ) {
    assert(html.includes(s), s);
  }
  const ttl = siteTurtle(site, [alpha]);
  for (
    const s of [
      "archon:Site",
      "archon:Network",
      "archon:Zone",
      "archon:FirewallPolicy",
      "archon:SecretRef",
      "skos:prefLabel",
    ]
  ) {
    assert(ttl.includes(s), s);
  }
  assertEquals(SECRET_INVENTORY.filter((x) => x.holder === "owner").length >= 5, true);
});
