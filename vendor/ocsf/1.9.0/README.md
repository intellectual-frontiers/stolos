# OCSF 1.9.0 class schemas

JSON Schemas (draft-07) for the OCSF classes whose events Stolos's tests validate, from
https://schema.ocsf.io/schema/1.9.0/classes/<class>?profiles= (the base classes, with no profiles; OCSF is Apache-2.0, a Linux Foundation
project). Written by `bun run ocsf`; their SHA-256s are in src/archon/ocsf/ocsf.lock.json. The
tests validate Stolos's OCSF output against them (spec 089); they are not shipped in the engine.
