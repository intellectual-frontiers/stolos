# 072: Evidence bundles, signed and verifiable offline

Epic intellectual-frontiers/stolos#7; issue intellectual-frontiers/stolos#9.

## Why

Collected evidence asks an auditor to trust whoever collected it. Evidence they can check again
themselves (that each item is what was recorded, that none was dropped, and that the fleet signed
it) is re-performable, which is what an assessor needs for a Type 2 period.

## Requirements

- **FR-001** `stolos evidence export --from <date> --to <date> [--out <zip>] [--key <file>]` gathers
  the period's evidence: every commit in the fleet repository, raw (`git cat-file commit`, with its
  SSH signature); each observation a commit recorded (`observed.ts`, `discovered.ts`, the estate's
  files, but not the people-written `links.ts`); the verify and install results this PC recorded;
  `signers.ts`; and the OSCAL assessment results (spec 071), or a note why one was omitted.
- **FR-002** Each item is stored as `objects/<sha256>` (content-addressed). `manifest.json` lists
  them in order, each entry chained to the one before:
  `chain = sha256("<previous>\n<sha256>\n<size>\n<kind>\n<name>\n<at>\n")`, starting from the
  format, the fleet, and the period. Its `head` is the last link.
- **FR-003** The manifest is signed with the operator's daily key (`ssh-keygen -Y sign`, namespace
  `stolos-evidence`): ssh-keygen asks the passphrase in the terminal; Stolos never sees it. The key
  must be one of the fleet's signers. Terminal only (never over MCP).
- **FR-004** The ZIP (deflated, as any `unzip` reads it) holds `allowed_signers` (the fleet's
  signers, for `git` and `stolos-evidence`) and a README saying how to check it with `sha256sum` and
  `ssh-keygen` alone.
- **FR-005** `stolos evidence verify <bundle> [--signers <file>]`, offline, names each problem with
  its reason: an item changed, missing, or not in the manifest; the chain broken or cut off; the
  manifest's signature wrong or by a key that is not an allowed signer; a commit unsigned or with a
  bad Git signature. Without `--signers` it trusts the bundle's own signers and says so; the fleet's
  Git `allowed_signers` (namespaces="git") work as `--signers`.

## Success criteria

- **SC-001** `tests/evidence072.test.ts`, against a real Git repository with SSH-signed commits: a
  good bundle verifies (naming the one unsigned commit); a tampered, missing, or added item, a
  reordered or cut manifest, and a signature by a key that is not a signer each fail with their
  reason.

## Later

The Stolos Console's download of a bundle (it needs the passphrase, so it stays in the terminal for
now), and RFC 3161 timestamps from a time-stamping authority.
