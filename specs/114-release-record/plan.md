# Implementation Plan: The release record

**Branch**: `114-release-record` (committed directly to main) | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/114-release-record/spec.md`

## Summary

Stolos becomes one work of commons' 0026-works-versioning: `release.ts` at the root is its record, `tools/version.ts` writes the version into it next to `package.json`
and checks that the three agree, a release is the annotated tag `stolos-v<version>` that CI makes with commons' `versions tag`, commons' `versions check` joins the
version check in CI and in `bun run ci`, and every consumer of the old tag `v<version>` (the pin, `stolos update`, `fleet upgrade`, the scripts, the workflows, the
documentation site, the tests' fixtures) moves to the new spelling, with no support for the old one. The first version is 0.150.0.

## Technical Context

**Language/Version**: TypeScript 7, run by Bun, with Node 26 as the backup (Article 4, spec 096-bun-runtime)

**Primary Dependencies**: IFC TypeScript's kernel and runtime and Mizan's `versions` tool (`@intellectual-frontiers/commons`, pinned by commit), nothing else

**Storage**: Git (the record, the tags); no secret anywhere (Article 13)

**Testing**: `tests/release114.test.ts` through `bun run test` (`proves([...])`), and the updated `tests/upgrade.test.ts`, `update058`, `update099`, `calm105`, `passphrase106`,
`speed106`, `scaffold`, `guides070` and the other tests whose fixtures name a tag; every one runs real Git

**Target Platform**: the engine's CI (Linux, with the suite on macOS and Windows) and every fleet's controller PC

**Project Type**: command line (headless first), then the consoles, which draw what the headless operations return

## Constitution Check

- Article 0 (the ladder): no new term (rung 0: `stolos:EngineRelease` is reworded and mapped to commons' `ifr:Release`); the requirements are rung 1; the version source is
  rung 4 (`src/archon/version.ts`), the pin and the lookups are rung 5 (`src/archon/fleet/`), the tool and the workflows are rung 6, the guide and the tests are rung 7.
  Every source file names its requirements on a `// Spec:` line.
- Article 4 (code over config): the version is TypeScript; `release.ts` is data that a program reads, written by the tool, never by hand.
- Article 5 (binaries only) and Article 12 (the lock): a release is a tag and nothing is built; `bun.lock` still pins the commit a tag named.
- Article 13 (no plaintext secrets): CI holds no signing key, so the tag is not signed.

## Project Structure

### Documentation (this feature)

```text
specs/114-release-record/
  spec.md          the requirements, the standards considered, the decisions
  plan.md          this file
  tasks.md         the tasks, each with its files and requirements, and the later items
  reviewed.tsv     the requirements proven by review
```

### Source Code (by rung of the ladder)

```text
rung 0: ontology/stolos/{vocabulary,audit}.ts (stolos:EngineRelease reworded, mapped to ifr:Release; the ontology is 1.0.1)
rung 4: src/archon/version.ts (VERSION, TAG_PREFIX, tagOf, TAG), package.json (the version)
rung 5: src/archon/fleet/{upgrade,releases,signing,bootstrap,scaffold}.ts, src/archon/adopt/{integrate,pair-service}.ts, src/archon/identity/fleet-init.ts,
        src/archon/core/guides.ts, src/archon/capabilities/cli.ts
rung 6: release.ts (the record), tools/version.ts, tools/smoke.ts, .github/workflows/{ci,fleet-e2e}.yml, src/archon-boot/main.ts
rung 7: src/releasing.ts (the guide), AGENTS.md, README.md, src/archon/fleet/mod.ts and the other guides that name the tag, tests/release114.test.ts and the tests' fixtures
```

**Structure Decision**: the engine's existing folders; the one new root file is `release.ts`, on rung 6 with the tools that read it.

## Design notes

- **One place names the tag.** `TAG_PREFIX` (`stolos-v`) is in `src/archon/version.ts`; the pin's and the lookup's regular expressions are built from it, so a change of
  spelling is one line, and a test fails on any other spelling.
- **The tool writes the record by one line.** `release.ts` is written in commons' template (`versions bump` writes the same text); `tools/version.ts` replaces only the
  `version: "x.y.z",` line, so a diff of two records shows the version and nothing else, and commons' check reads the result.
- **CI makes the tag with commons' tool.** `versions tag stolos` writes the message (commit, tree, scheme, tier), refuses a tag that exists, an uncommitted record and a version
  that is not greater than the last tag; the workflow only sets the identity of the annotated tag and pushes it.
- **The tool is tested on a real repository.** `STOLOS_VERSION_ROOT` names the repository `tools/version.ts` works on; the test makes a Git repository in a temporary folder, runs
  the tool and commons' `versions check` on it, and nothing is a stand-in.
- **The first release re-pins every fleet once.** Nothing reads the old tags, so a fleet pinned at `#v0.145.0` cannot follow; the error says the one command, and the commit that
  brings 0.150.0 carries it as an `Operator action:`.

## Standards considered

The same ones as the specification (`spec.md`, Standards considered): RFC 2119 and RFC 8174 for the requirement words, Semantic Versioning 2.0.0 for the scheme and the order,
Git's annotated tags for the release, commons' 0026-works-versioning for the work, its record and its checks, NIST SP 800-53 Rev 5 CM-3, CM-8, SA-10 and SI-7 and NIST SP 800-218
PS.3.2 for a release that is one immutable set of files. No new term is defined, so nothing is added to `ontology/stolos/audit.ts` beyond the mapping of `stolos:EngineRelease` to
`ifr:Release`.
