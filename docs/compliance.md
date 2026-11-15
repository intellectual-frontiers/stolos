# Compliance

Stolos turns what it already checks into evidence for an auditor (spec 068). Each check names the
Secure Controls Framework (SCF) controls it supports; each SCF control maps to requirements in
HIPAA, PCI DSS, CMMC, and SOC 2.

```bash
deno task stolos compliance
deno task stolos compliance --framework hipaa
```

In the consoles, the Compliance tab shows the same: each framework's requirements, and under each
control the evidence (machine, check, result, what was found) and how to fix what fails. The Stolos
Console downloads it all as JSON for the auditor.

## What it is, and is not

- It is evidence from machines and accounts: disk encryption, firewalls, updates, MFA, signed
  changes, TLS settings, the asset list.
- It is not a policy, training, or a contract: those controls are not shown at all, and need
  evidence of their own.
- The mapping is a starter set, for orientation. Check it against the SCF's own mappings (its STRM
  for each framework) before an auditor relies on it.
- SOC 2 Type 1 asks about one date; Type 2 about a period. Every observation is a commit, so
  `git log -p fleets/<fleet>/adopted fleets/<fleet>/clouds` is the period's record.
