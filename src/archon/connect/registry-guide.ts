/**
 * # The connector registry
 *
 * Stolos ships its own connectors (`bun run stolos connect <id>`). A fleet can add others, from
 * the community or written for itself: a TypeScript module published at a pinned URL (a version
 * tag or a commit, never a branch), copied into the fleet repository with a lock entry that holds
 * its SHA-256, and approved by the signed commit you push (spec 088). There is no central
 * server: a connector lives in its author's Git repository, and an index is a JSON file anyone can
 * host.
 *
 * ```mermaid
 * flowchart LR
 *   repo["github.com/owner/stolos-connector-x (tag v1.2.0)"] --> add["stolos connector add …@v1.2.0"]
 *   add --> probe["probe: its own process, with none of your secrets"]
 *   probe --> checks["id, labels, SCF ids, read-only credential, engine range, fixtures"]
 *   checks --> copy["fleets/&lt;fleet&gt;/connectors/&lt;id&gt;.ts: the module, as checked"]
 *   checks --> file["fleets/&lt;fleet&gt;/connectors.ts: import + Stolos's lock entry (SHA-256)"]
 *   copy & file --> commit["a signed commit, pushed: the approval"]
 *   commit --> engine["the engine loads it beside its own connectors"]
 * ```
 *
 * ## Adding a connector
 *
 * ```bash
 * bun run stolos connector add https://github.com/example/stolos-connector-example@v1.0.0
 * bun run stolos connector list
 * bun run stolos connect example-scanner
 * ```
 *
 * The source is `https://github.com/<owner>/<repo>[/<path>]` (the path defaults to `mod.ts`),
 * read from `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` as the engine is. The ref is
 * a version tag (`v1.0.0`) or a full commit SHA: a branch moves under you, so it is refused.
 *
 * `connector add` downloads the module and runs the probe on it, in a process of its own that is
 * given none of your environment (only the variables the engine reads for its paths), so none of
 * your secrets. Bun and Node give a process no permission sandbox, so the
 * probe does not stop the module's own code from reaching the network or files: read the module
 * before you add it. The probe reads what the connector declares and runs its recorded-fixture tests; the
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
 * Otherwise it copies the module, byte for byte as it checked it, to
 * `fleets/<fleet>/connectors/<id>.ts`, and writes `fleets/<fleet>/connectors.ts`: an import of that
 * copy, and Stolos's own lock entry (where it came from, the module's SHA-256, its engine range, the
 * engine that checked it, and how many fixtures passed). Review the change and commit it, signed;
 * pushing is the approval. The engine loads an added connector only while its copy still hashes as
 * its entry says: a file that differs from its lock is left out, with a warning.
 *
 * `bun run stolos fleet upgrade` checks the added connectors against the new engine, and refuses an
 * engine version an added connector does not support: move that connector to a newer tag first
 * (`connector add` with the new tag replaces the old pin), or remove it.
 *
 * ```bash
 * bun run stolos connector test                 # every added one, at its pin, on this engine
 * bun run stolos connector remove example-scanner
 * ```
 *
 * An added connector runs in Stolos's own process when it observes, with the credential you give
 * it, like the engine's own: the read-only guard refuses anything but GET (and its declared token
 * endpoints), but the code is trusted as the engine is. Read it before you add it, as you would
 * read a change to the engine; the pin, the copy in Git and its hash make sure the code you read
 * is the code that runs.
 *
 * ## Writing a connector
 *
 * Start from the template in the engine's repository, `examples/connector-template/`: one
 * module, `mod.ts`, and its test. A connector module:
 *
 * - default-exports a `defineConnector` result (`@intellectual-frontiers/stolos/archon/connect/sdk`): its id, title,
 *   credential fields, connect steps for a read-only credential, the resources it reads (each an
 *   async generator over the vendor's public API, mapped to a label and an OCSF class), its posture
 *   facts, and its policies, each citing SCF ids;
 * - exports `engine`, the range of engine versions it supports (`">=0.112.0 <1.0.0"`; comparators
 *   `>=`, `>`, `<=`, `<`, `=`, and `^`, all of which must hold);
 * - exports `fixtures`, its recorded-fixture tests (`ConnectorFixture` in
 *   `@intellectual-frontiers/stolos/archon/connect/registry-contract`): a made-up credential, the vendor's recorded
 *   answers by URL, and what the observation must say (its account, records per label, gaps,
 *   posture facts, and policy results). Record at least one denied call (403) as a gap.
 *
 * It is one file that imports only the engine (`@intellectual-frontiers/stolos/archon/...`, the
 * package the fleet repository installs): no other dependency, and no file of its own beside it,
 * since the module alone is copied. Use the engine's labels where one fits
 * (`@intellectual-frontiers/stolos/archon/connect/labels`: `vulnerability`, `user_account`, `person_record`, ...);
 * a new one is declared with `defineLabel` and named from D3FEND, OCSF, or UDM.
 *
 * In the connector's own repository, a `package.json` depends on the engine by Git at a tag, as a fleet
 * repository does, for its tests:
 *
 * ```json
 * {
 *   "dependencies": {
 *     "@intellectual-frontiers/stolos": "github:intellectual-frontiers/stolos#v0.118.0"
 *   }
 * }
 * ```
 *
 * `bun test` runs its fixtures with the engine's own runner (`runFixtures`), and
 * `bun run stolos connector test ./mod.ts`, run in a fleet repository, checks it exactly as
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
