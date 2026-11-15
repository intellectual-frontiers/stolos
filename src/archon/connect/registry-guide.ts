/**
 * # The connector registry
 *
 * Stolos ships its own connectors (`deno task stolos connect <id>`). A fleet can add others, from
 * the community or written for itself, the way it takes the engine: a TypeScript module published
 * at a pinned URL (a version tag or a commit, never a branch), declared in the fleet repository,
 * with a lock entry, and approved by the signed commit you push (spec 088). There is no central
 * server: a connector lives in its author's Git repository, and an index is a JSON file anyone can
 * host.
 *
 * ```mermaid
 * flowchart LR
 *   repo["github.com/owner/stolos-connector-x (tag v1.2.0)"] --> add["stolos connector add …@v1.2.0"]
 *   add --> probe["probe: a Deno process with no network, files, or secrets"]
 *   probe --> checks["id, labels, SCF ids, read-only credential, engine range, fixtures"]
 *   checks --> file["fleets/&lt;fleet&gt;/connectors.ts: import + Stolos's lock entry"]
 *   checks --> lock["deno.lock: the hash of every file"]
 *   file & lock --> commit["a signed commit, pushed: the approval"]
 *   commit --> engine["the engine loads it beside its own connectors"]
 * ```
 *
 * ## Adding a connector
 *
 * ```bash
 * deno task stolos connector add https://github.com/example/stolos-connector-example@v1.0.0
 * deno task stolos connector list
 * deno task stolos connect example-scanner
 * ```
 *
 * The source is `https://github.com/<owner>/<repo>[/<path>]` (the path defaults to `mod.ts`),
 * read from `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` as the engine is. The ref is
 * a version tag (`v1.0.0`) or a full commit SHA: a branch moves under you, so it is refused.
 *
 * `connector add` downloads the module and runs the probe on it, in a Deno process allowed only to
 * import from the module's host and the engine's, with no network, no files, and none of your
 * secrets. The probe reads what the connector declares and runs its recorded-fixture tests; the
 * engine then refuses it, changing nothing, when:
 *
 * - its default export is not made with `defineConnector`;
 * - its id is one of the engine's connectors, or another added one;
 * - a label it fills breaks the naming rules (a D3FEND, OCSF, or UDM term, singular,
 *   lower_snake_case, never an SQL keyword), or redeclares a built-in label differently;
 * - a policy cites an SCF id the engine does not know;
 * - its credential has no secret field, or its connect steps do not say how to make a read-only
 *   credential;
 * - it declares no engine range, or this engine is not in it;
 * - it has no fixture tests, or one fails.
 *
 * Otherwise it writes `fleets/<fleet>/connectors.ts`: an import of the pinned URL, and Stolos's
 * own lock entry (the module's SHA-256, its engine range, the engine that checked it, and how many
 * fixtures passed). It then runs `deno cache --lock=deno.lock` on that file, so `deno.lock` holds
 * the hash of every file the connector loads, beside the engine's, and checks that the lock's hash
 * of the module is the one it checked. Review the change and commit it, signed; pushing is the
 * approval. Hosts run the engine with `--frozen`: a file that differs from its lock is refused.
 *
 * `deno task stolos fleet upgrade` locks the added connectors with the new engine, and refuses an
 * engine version an added connector does not support: move that connector to a newer tag first
 * (`connector add` with the new tag replaces the old pin), or remove it.
 *
 * ```bash
 * deno task stolos connector test                 # every added one, at its pin, on this engine
 * deno task stolos connector remove example-scanner
 * ```
 *
 * An added connector runs in Stolos's own process when it observes, with the credential you give
 * it, like the engine's own: the read-only guard refuses anything but GET (and its declared token
 * endpoints), but the code is trusted as the engine is. Read it before you add it, as you would
 * read a change to the engine; the pin and the lock make sure the code you read is the code that
 * runs.
 *
 * ## Writing a connector
 *
 * Start from the template in the engine's repository, `examples/connector-template/`: one
 * module, `mod.ts`, and its test. A connector module:
 *
 * - default-exports a `defineConnector` result (`@stolos/archon/connect/sdk.ts`): its id, title,
 *   credential fields, connect steps for a read-only credential, the resources it reads (each an
 *   async generator over the vendor's public API, mapped to a label and an OCSF class), its posture
 *   facts, and its policies, each citing SCF ids;
 * - exports `engine`, the range of engine versions it supports (`">=0.112.0 <1.0.0"`; comparators
 *   `>=`, `>`, `<=`, `<`, `=`, and `^`, all of which must hold);
 * - exports `fixtures`, its recorded-fixture tests (`ConnectorFixture` in
 *   `@stolos/archon/connect/registry-contract.ts`): a made-up credential, the vendor's recorded
 *   answers by URL, and what the observation must say (its account, records per label, gaps,
 *   posture facts, and policy results). Record at least one denied call (403) as a gap.
 *
 * It imports only the engine (`@stolos/archon/...`, which the fleet's import map points at the
 * engine it pins) and its own files: no other dependency. Use the engine's labels where one fits
 * (`@stolos/archon/connect/labels.ts`: `vulnerability`, `user_account`, `person_record`, ...);
 * a new one is declared with `defineLabel` and named from D3FEND, OCSF, or UDM.
 *
 * In the connector's own repository, a `deno.json` maps the engine for its tests:
 *
 * ```json
 * {
 *   "imports": {
 *     "@stolos/": "https://raw.githubusercontent.com/intellectual-frontiers/stolos/v0.112.0/src/"
 *   }
 * }
 * ```
 *
 * `deno test` runs its fixtures with the engine's own runner (`runFixtures`), and
 * `deno task stolos connector test ./mod.ts`, run in a fleet repository, checks it exactly as
 * `connector add` will. Then tag a release (`git tag v1.0.0 && git push --tags`) and publish the
 * source and tag.
 *
 * ## An index
 *
 * An index lists connectors and their tags, as a JSON file at any URL; Stolos runs no server of its
 * own. `connector add <id>@<tag> --index <url>` finds the source in it (the tag must be one the
 * index lists; without a tag, its last one).
 *
 * ```json
 * {
 *   "format": "stolos-connector-index/1",
 *   "connectors": [{
 *     "id": "example-scanner",
 *     "title": "Example Scanner",
 *     "source": "https://github.com/example/stolos-connector-example",
 *     "path": "mod.ts",
 *     "tags": ["v1.0.0"],
 *     "engine": ">=0.112.0 <1.0.0",
 *     "markets": ["vulnerability-assessment"],
 *     "description": "Open findings as OCSF vulnerabilities."
 *   }]
 * }
 * ```
 *
 * The index only says where to look: `connector add` checks the module itself, whoever lists it.
 *
 * @module
 */

export {};
