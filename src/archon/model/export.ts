/**
 * `stolos export` (spec 002 FR-006, spec 014): the fleet, hosts, specs,
 * provenance, and snapshots as RDF (Turtle) under out/rdf/. RDF is an export
 * only (Article 10); vocabularies are reused (Article 3): W3C PROV, Dublin
 * Core terms, FOAF, and a small archon: namespace for the rest.
 *
 * @module
 */

import { fs, path as paths } from "@intellectual-frontiers/system";
import { P } from "../core/paths.ts";
import { engineFile, engineSpecs } from "../core/assets.ts";
import { loadFleet, loadHosts } from "./load.ts";
import { loadActivities } from "../prov/prov.ts";
import type { SiteDef } from "./site.ts";
import type { HostDef } from "./types.ts";
import { SECRET_INVENTORY } from "./secret-inventory.ts";

const BASE = "https://w3id.org/archon/";
const PREFIXES = `@prefix archon: <${BASE}vocab#> .
@prefix id: <${BASE}id/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

`;

/** A Turtle string literal. */
export function lit(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
const dt = (iso: string) => `${lit(iso)}^^xsd:dateTime`;
const iri = (path: string) => `<${BASE}id/${path.split("/").map(encodeURIComponent).join("/")}>`;

/** One subject with predicate-object pairs. */
export function subject(s: string, pairs: Array<[string, string | string[]]>): string {
  const body = pairs
    .filter(([, o]) => (Array.isArray(o) ? o.length : o))
    .map(([p, o]) => `    ${p} ${Array.isArray(o) ? o.join(", ") : o}`)
    .join(" ;\n");
  return `${s}\n${body} .\n`;
}

/**
 * Write the fleet as RDF Turtle into out/rdf/: fleet.ttl (people, hosts,
 * specs, and what was applied), plus site.ttl when the fleet has a site.
 * Returns the paths written.
 */
export async function exportRdf(): Promise<string[]> {
  const fleet = await loadFleet();
  const hosts = await loadHosts();
  const written: string[] = [];
  const dir = paths.join(P.out, "rdf");
  await fs.ensureDir(dir);

  const specs = engineSpecs();
  const specTitle = (s: string): string =>
    engineFile(`specs/${s}/spec.md`).match(/^# Feature Specification: (.+)$/m)?.[1] ?? s;

  let ttl = PREFIXES;
  const gh = fleet.admin.github;
  ttl += subject(iri(`person/${gh.login}`), [
    ["a", "foaf:Person, prov:Agent"],
    ["foaf:name", lit(gh.name)],
    ["foaf:account", `<https://github.com/${gh.login}>`],
  ]);
  ttl += subject(iri(`fleet/${fleet.id}`), [
    ["a", "archon:Fleet"],
    ["dcterms:title", lit(fleet.title)],
    ["dcterms:source", `<${fleet.repository.url}>`],
    ["archon:admin", iri(`person/${gh.login}`)],
    ["archon:host", hosts.map((h) => iri(`host/${h.name}`))],
  ]);
  for (const s of specs) {
    ttl += subject(iri(`spec/${s}`), [
      ["a", "archon:Spec"],
      ["dcterms:title", lit(specTitle(s))],
    ]);
  }
  for (const h of hosts) {
    ttl += subject(iri(`host/${h.name}`), [
      ["a", "archon:Host"],
      ["dcterms:identifier", lit(h.name)],
      ["archon:mac", h.mac ? lit(h.mac) : ""],
      ["archon:os", lit(`Ubuntu Server ${fleet.ubuntu.release}`)],
      ["dcterms:conformsTo", iri(`spec/${h.spec}`)],
      // Spec 018: the host's out-of-band management (Intel AMT), as recorded.
      ["archon:amtAddress", h.outOfBand?.amt?.address ? lit(h.outOfBand.amt.address) : ""],
      ["archon:amtNotes", h.outOfBand?.amt?.notes ? lit(h.outOfBand.amt.notes) : ""],
    ]);
    for (const a of await loadActivities(h.name)) {
      const id = iri(`host/${h.name}/activity/${a.started}`);
      ttl += subject(id, [
        ["a", "prov:Activity"],
        ["prov:startedAtTime", dt(a.started)],
        ["prov:endedAtTime", dt(a.ended)],
        ["prov:wasAssociatedWith", iri(`agent/${a.agent}`)],
        ["prov:used", `<${fleet.repository.url}/commit/${a.commit}>`],
        ["archon:changed", iri(`host/${h.name}`)],
        ["archon:change", a.changes.map(lit)],
        ["archon:failed", `${lit(String(a.failed))}^^xsd:boolean`],
      ]);
    }
  }
  const path = paths.join(dir, "fleet.ttl");
  await fs.writeTextFile(path, ttl);
  written.push(path);
  if (fleet.site) {
    const sitePath = paths.join(dir, "site.ttl");
    await fs.writeTextFile(sitePath, siteTurtle(fleet.site, hosts));
    written.push(sitePath);
  }
  return written;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Spec 028: the site as RDF, with SKOS labels: archon:Site, archon:Network,
 * archon:Zone, archon:FirewallPolicy, archon:SecretRef (names only, never
 * values). An export only (Article 10): TypeScript validates the model.
 */
export function siteTurtle(site: SiteDef, hosts: HostDef[]): string {
  let ttl = PREFIXES + `@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n\n`;
  const s = iri(`site/${slug(site.name)}`);
  const z = (zone: string) => iri(`site/${slug(site.name)}/zone/${slug(zone)}`);
  const nw = (name: string) => iri(`site/${slug(site.name)}/network/${slug(name)}`);
  ttl += subject(s, [
    ["a", "archon:Site"],
    ["skos:prefLabel", lit(site.name)],
    ["archon:network", site.networks.map((n) => nw(n.name))],
    ["archon:zone", site.zones.map(z)],
    ["archon:policy", site.policies.map((p) => iri(`site/${slug(site.name)}/policy/${p.id}`))],
    ["archon:secret", SECRET_INVENTORY.map((x) => iri(`secret/${x.id}`))],
  ]);
  for (const zone of site.zones) {
    ttl += subject(z(zone), [
      ["a", "archon:Zone"],
      ["skos:prefLabel", lit(zone)],
    ]);
  }
  for (const n of site.networks) {
    ttl += subject(nw(n.name), [
      ["a", "archon:Network"],
      ["skos:prefLabel", lit(n.name)],
      ["archon:vlan", n.vlan ? `${n.vlan}` : ""],
      ["archon:cidr", lit(n.cidr)],
      ["archon:gateway", lit(n.gateway)],
      ["archon:inZone", z(n.zone)],
      ["archon:mdnsReflect", `${lit(String(n.mdnsReflect))}^^xsd:boolean`],
      ["archon:ipv6", `${lit(String(n.ipv6))}^^xsd:boolean`],
    ]);
  }
  for (const p of site.policies) {
    ttl += subject(iri(`site/${slug(site.name)}/policy/${p.id}`), [
      ["a", "archon:FirewallPolicy"],
      ["skos:prefLabel", lit(p.name)],
      ["skos:notation", lit(String(p.id))],
      ["archon:fromZone", z(p.from.zone)],
      ["archon:toZone", z(p.to.zone)],
      ["archon:toAddress", p.to.address ? lit(p.to.address) : ""],
      ["archon:protocol", lit(p.protocol)],
      ["archon:port", (p.ports ?? []).map((x) => `${x}`)],
      ["archon:action", lit(p.action)],
      ["skos:definition", lit(p.purpose)],
    ]);
  }
  for (const h of hosts) {
    if (!h.network) continue;
    ttl += subject(iri(`host/${h.name}`), [
      ["archon:onNetwork", nw(h.network)],
      ["archon:address", h.ip ? lit(h.ip) : ""],
      ["archon:dnsName", h.dnsName ? lit(h.dnsName) : ""],
    ]);
  }
  for (const x of SECRET_INVENTORY) {
    ttl += subject(iri(`secret/${x.id}`), [
      ["a", "archon:SecretRef"],
      ["skos:prefLabel", lit(x.id)],
      ["skos:definition", lit(x.purpose)],
      ["archon:holder", lit(x.holder)],
      ["archon:location", lit(x.path)],
      ["archon:recreate", lit(x.recreate)],
    ]);
  }
  return ttl;
}
