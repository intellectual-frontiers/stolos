# Plan: 028-site-network

- `src/archon/model/site.ts`: branded types, the ontology, `validateSite`, `siteNetwork`.
- `fleets/<fleet>/site.ts`: the data, from the owner's network reference.
- `fleets/<fleet>/fleet.ts`: `site` referenced from the fleet, so `networkOf()` stays synchronous.
- `src/archon/model/secret-inventory.ts`: `SecretRef` and `SECRET_INVENTORY`; `secretFor()` maps a
  file in the secrets folder to its entry.
- `src/archon/model/validate.ts`: hosts' networks; `validateSite` with the fleet.
- `src/archon/model/export.ts`: `site.ttl` with SKOS.
- `src/archon/render/network-doc.ts`, `build.ts`: `out/site/network-reference.html`.

## Decisions

- The site lives beside the fleet as code (Article 4) and is checked by TypeScript first (Article
  10); the router stays the authority (Article 21), so the model never generates router changes, it
  lists them.
- Same-zone network boot (Default, Internal, like BOOTPC) needs no policy; only other zones do.
