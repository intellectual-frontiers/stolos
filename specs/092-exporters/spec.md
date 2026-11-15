# 092: Exporters in standard formats

Epic intellectual-frontiers/stolos#7; issue intellectual-frontiers/stolos#29. Part A (this part):
the documents and the `exports` API. Part B is delivery: sending OTLP, writing files, send-only
encrypted email, and OS scheduling. It calls the API and knows nothing about the formats.

## Requirements

- **FR-001** OCSF JSON Lines (`ocsf-jsonl`): one OCSF 1.9.0 event per line, typed by the generated
  OCSF types.
  - User Inventory Info (5003) per person, then one per account of theirs (tied by
    `metadata.correlation_uid`), then the accounts of no one.
  - Device Inventory Info (5001) per fixed asset.
  - Cloud Resources Inventory Info (5023) per other node.
  - Compliance Finding (2003) per evidence item and SCF control (`ocsf/finding.ts`).
  - `metadata.product` is Stolos, by Intellectual Frontiers LLC, at the engine's version.
  - Only what the estate already holds goes out (no phone, location, title, or other OCSF personal
    attribute).
- **FR-002** OTLP JSON (`otlp-json`): an `ExportLogsServiceRequest` in the OTLP/HTTP JSON encoding.
  - Each OCSF event is a LogRecord: the body is the event; `eventName` is `ocsf.<class>`; the
    attributes are `ocsf.class_uid` and `ocsf.category_uid`.
  - The resource is `service.name` stolos, `service.version`, and `service.namespace` (the fleet).
  - OpenTelemetry entity events (`entity.state`, Development status) for machines and other nodes,
    behind an option, off by default. People and accounts are never entity events.
  - Only the request body is built here.
- **FR-003** CycloneDX 1.6 attestation (`cyclonedx-attestation`).
  - `definitions.standards` holds SCF, by release; its requirements are the SCF controls Stolos
    covers.
  - `declarations.claims` holds one claim per control: the target is the fleet, and the predicate is
    `scf.ts`'s `how`.
  - `declarations.evidence` holds each check's result, named by its OSCAL observation UUID, and,
    with a spec 072 bundle, each item by `objects/<sha256>`. Each claim names the bundle by its
    SHA-256.
  - The attestation's conformance score is the share of a control's checks that pass.
  - The signatory is the fleet signer, without a signature (signing stays spec 072's).
  - The official schemas are vendored in `vendor/cyclonedx/1.6/`, and the tests validate against
    them.
- **FR-004** in-toto Statement v1 (`intoto-statement`) for a 072 evidence bundle.
  - The subject is the bundle (its name and SHA-256), then each item (`objects/<sha256>`).
  - The predicate is the manifest's summary, under Stolos's predicate type
    `https://github.com/intellectual-frontiers/stolos/attestation/evidence-bundle/v1`. It is
    documented in `src/archon/export/intoto.ts`. No predicate in the in-toto attestation framework's
    list describes a set of compliance evidence.
  - `dsseEnvelope` wraps a statement for a signature callback, by DSSE's PAE. The tests check PAE
    against the DSSE specification's example.
- **FR-005** The exports API: `buildExports(kind, input)` returns `{ fileName, mediaType, bytes }`.
  It covers the kinds above and the four OSCAL documents (spec 071): `oscal-component-definition`,
  `oscal-ssp`, `oscal-assessment-results`, and `oscal-poam`. The same input gives the same bytes.
- **FR-006** `stolos export <kind> [--out <file>] [--bundle <zip>] [--entities]`.
  - It writes to this PC's state directory, `export/`, by default.
  - Without a kind, or with `rdf`, it is the RDF export it was (specs 002 and 014).
  - It is a `read`-tier command and is offered over MCP (the fleet group).

## Success criteria

- **SC-001** `tests/export092_test.ts` checks the following:
  - Every OCSF event validates against its vendored OCSF class schema.
  - The CycloneDX attestation validates against CycloneDX 1.6, with and without a bundle, and every
    reference in it resolves.
  - The OTLP request has the right shape, and each body round-trips to its event.
  - The in-toto subject digests match the bundle and its items, and a DSSE envelope verifies.
  - Every kind gives the same bytes for the same input.
  - No email address or name goes out that the estate does not hold.

## Part B: delivery

- **FR-B01** Export jobs live in `fleet.ts` (`estate.exports`). Each job has:
  - an id;
  - kinds (`oscal`, `ocsf`, `otlp`, `cyclonedx`, `in-toto`);
  - tenants (`<connector>:<account>`, with `*`), which limit what the estate formats carry (other
    tenants' nodes and gaps are dropped; the fleet's people and machines only with `fleet:<id>`);
  - OTLP on or off;
  - email recipients, each with their S/MIME certificate;
  - a sender, relay, and credential;
  - a schedule.
- **FR-B02** Delivery follows the owner's order:
  1. to the fleet's OpenTelemetry collector (OTLP/HTTP) when one is configured;
  2. otherwise, or when the collector fails, a file in the PC's state directory;
  3. email when the job has recipients.
- **FR-B03** Email is send-only (SMTP submission with TLS only, never reading a mailbox), through
  the fleet's mail setup or a per-tenant credential (`stolos export credential <name>`). Every
  message is S/MIME encrypted to its recipient's certificate:
  - CMS AuthEnvelopedData with AES-256-GCM and RSA-OAEP SHA-256, written in TypeScript with
    WebCrypto;
  - `openssl cms -decrypt` reads it;
  - one message per recipient;
  - nothing is ever sent unencrypted.
- **FR-B04** `stolos export schedule <job>` creates the operating system's own scheduled job:
  - Windows Task Scheduler;
  - a macOS LaunchAgent;
  - a Linux systemd user timer.

  `stolos export run <job>` is what it runs, and `stolos export list` lists the jobs. No secret is
  written into a job.
- **SC-B01** `tests/deliver092_test.ts` covers:
  - DER vectors;
  - an S/MIME round trip through openssl;
  - the OTLP-or-file choice;
  - job validation and tenant filters;
  - the schedule files for each operating system;
  - the SMTP dialogue against a fake TLS server, refusing plain text;
  - no secret in any job file or run record.

OpenPGP and EC certificates are later.
