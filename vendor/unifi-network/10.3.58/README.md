# UniFi Network application, integration API 10.3.58

The official OpenAPI 3.1 description of the UniFi Network application's local integration API, as Ubiquiti publishes it
for developers on its CDN. Stolos reads it only to generate the TypeScript types of the API (spec 109-integrations-api,
`tools/unifi-api-gen.ts`, `src/archon/connect/unifi-api.auto.ts`). Nothing here is edited: the file is byte for byte what the
URL answered.

| File | Source | SHA-256 |
| --- | --- | --- |
| `integration.json` | https://apidoc-cdn.ui.com/network/v10.3.58/integration.json | `c6824fe526b0a0030153b52e117348ab651af3fc6540d8c9de73e4fab57ca0d7` |

- Fetched on 2026-11-17 (HTTP 200, 406914 bytes). `info.title` is "UniFi Network API", `info.version` is 10.3.58, `openapi` is 3.1.0, and
  its one server is the relative URL `/integration`; the paths begin `/v1/`. On a controller running the Network application on
  UniFi OS the API is at `https://<controller>/proxy/network/integration/v1/...`; on a standalone Network application at
  `https://<controller>/integration/v1/...`.
- Why this version: it is the newest the official CDN answers for. The versions tried on the CDN that exist are 10.1.68, 10.1.84 and
  10.3.58; every other version tried (10.2.x, 10.3.0 to 10.3.75 except 10.3.58, 10.4.x, 10.5.0 and 11.0.0) was refused. The community
  mirror https://opastorello.github.io/unifi-api-docs/ (not official, not used) lists 10.0.162, 10.1.84 and 10.3.58.
- A newer version is a new folder beside this one, the pin of the generator moved, and the generated module regenerated, in the spec
  loop (`bun run unifi-api`).

## Origin and terms

The document is Ubiquiti Inc.'s publication, offered on a public CDN for the developers of the Network application's API. It carries
no licence of its own (`info.license` is empty). Stolos keeps an unmodified copy as third-party data, only so that the types it
generates can be checked against the document they came from; it does not redistribute the document as part of any product. Ubiquiti
and UniFi are trademarks of Ubiquiti Inc.
