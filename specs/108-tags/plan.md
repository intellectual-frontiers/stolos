# Implementation Plan: Tags: the labels a fleet gives its machines, and choosing machines by them

**Branch**: `108-tags` (committed directly to main) | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/108-tags/spec.md`

## Summary

A fleet defines its tags in TypeScript (`tags.ts`: dimensions, rules, groups); a pure module resolves each machine's tags with their
origins; people give tags with `stolos tag` and `stolos pair --tag`, written in the machine's own file and sent as one signed commit;
a small typed parser chooses machines by tag for `fleet query`, the Ask page, `tag list` and `compliance`; and the Stolos Console
draws chips, a filter, facets and a group-by, with free-form tags always apart.

## Technical Context

**Language/Version**: TypeScript 7, run by Bun, with Node 26 as the backup (Article 4, spec 096-bun-runtime)

**Primary Dependencies**: IFC TypeScript's kernel and runtime (`@intellectual-frontiers/commons`); nothing new

**Storage**: the fleet repository: `fleets/<fleet>/tags.ts` (definitions), `decisions.ts` of a managed host and `machine.ts` of an
adopted machine (a person's tags); nothing on a host

**Testing**: `tests/tags108.test.ts` (with a type-level check that a tag not defined does not compile), `tests/decisions.test.ts`,
`tests/query107.test.ts`, `tests/console066.test.ts`, all through `proves([...])`; the project's runner on Bun and Node 26

**Target Platform**: the controller PC (Linux, macOS, Windows); nothing is run on a machine

**Project Type**: command line (headless first), then the Stolos Console

## Constitution Check

- Article 0 (the ladder): the terms are in the ontology (rung 0) and cited in `spec.md` (rung 1); `defineTags`, resolution and the
  expression parser are pure data operations (rung 3, `src/archon/model/tags.ts`); loading the fleet's tags, the commands and the
  scoping are business rules (rung 5, `src/archon/fleet/`); the commands are in the one registry and the console draws what the
  rules give (rung 6); the guide is rung 7. The command and its test are written before the console that draws them.
- Article 4 (code over config): tags, rules and groups are TypeScript; no JSON in a fleet. Article 10: a tag that is not defined
  fails the build. Article 9 and 25: a tag is a decision in Git, sent as a signed commit, never written any other way. Article 13:
  nothing secret is a tag. Article 24: the engine's tests use the example lab.
- Article 6 (one registry): `tag list|add|remove`, and `--tag`, `--any-tag`, `--select` on `fleet query` and `compliance`, `--tag` on
  `pair`; the console calls the same operations (`askFleet`, the tags' resolution).
- Article 19 (calm output): `tag add|remove` are actions (calm); `tag list` is a report.

## Project Structure

### Documentation (this feature)

```text
specs/108-tags/
  spec.md          the requirements, the ontology terms they use, the standards considered, the decisions
  plan.md          this file
  tasks.md         the tasks, each with its files and requirements, and the later items
  reviewed.tsv     the requirements proven by review
```

### Source Code (by rung of the ladder)

```text
rung 0: ontology/stolos/{vocabulary,codes,mod}.ts (Tag, TagDimension, TagRule, TagGroup, TagSelection, TagColour, TagCardinality, TagOrigin)
rung 2: src/archon/model/types.ts (HostDecisions.tags, HostDef.tags)
rung 3: src/archon/model/{tags,load}.ts
rung 4: src/archon/core/registry-types.ts (a repeatable last positional), src/archon/identity/fleet-init.ts (the starter tags.ts)
rung 5: src/archon/fleet/{tags,tag-commands,decisions,mod}.ts, src/archon/adopt/{adopt,commands,controller,pair-command,query}.ts,
        src/archon/compliance/commands.ts, src/archon/build.ts
rung 6: src/archon/commands/registry.ts, src/archon/console/{assets,pc,tags,stolos-pages,stolos-server}.ts
rung 7: examples/fleets/lab/{tags.ts,hosts/*/decisions.ts}, tests/tags108.test.ts
```

**Structure Decision**: the engine's existing folders; `fleet/tags.ts` (rung 5) is what the consoles and commands read, and
`model/tags.ts` (rung 3) holds what is pure (and is what a fleet's `tags.ts` imports).

## Design notes

- **One resolution.** `resolveTags(set, facts, assigned, networks)` is pure: a person's tags, then each rule over the facts, then
  each group; a one-of dimension keeps the strongest origin. Everything that shows tags calls it through `loadFleetTags`.
- **One file per machine.** `writeAssignment` writes `decisions.ts` (managed) or `machine.ts` (adopted) in the form the engine
  writes, so the build can tell a hand edit from a written file, and a re-adoption keeps the tags.
- **The parser is a recursive descent over tokens**, bounded in length and depth; its result is data (`Selection`) that `matches`
  folds over a set of tag ids. There is no `eval`, no `Function`, no regular expression built from the text.
- **Free-form is a different list, not a different spelling.** `customTags` is a field of its own, so no code path can mistake one
  for a defined tag, and every renderer marks it from the field it came from (`standing: "custom"`).

## Standards considered

The same ones as the specification (`spec.md`, Standards considered): RFC 2119 and RFC 8174 for the requirement words,
NIST SP 800-53 Rev 5 CM-8 and SP 800-128 for the inventory and its configuration, and W3C SKOS for tags, dimensions and groups
(a tag is a `skos:Concept`, a dimension a `skos:ConceptScheme`, a group a `skos:Collection`; `ontology/stolos/audit.ts` maps them).
A tag rule and a tag selection have no standard to adopt: the rule is TypeScript over facts, the selection a small expression
parsed by the engine itself.
