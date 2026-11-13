# Plan: 026-doctor

- `src/archon/doctor/probe.ts`: curl probe with `-w` timings, `explainCurl`, and pure parsers (apt
  sources, ping, resolvectl, chronyc, snap, ufw).
- `src/archon/doctor/doctor.ts`: the phases; endpoints from apt sources, the git remote, the tools
  catalog, and the model.
- `src/archon/doctor/email.ts`: the Email phase, also used by `deno task boot doctor`.
- `src/archon/capabilities/doctor.ts`: declares the tools (all already in Ubuntu Server).
- `sendSmtp` takes an optional message: without one it stops after AUTH (the SMTP check).

## Decisions

- Call Ubuntu's tools rather than reimplementing them: they are what an operator would run by hand,
  and their output is what the docs and forums explain.
- The public resolver is consulted only when every configured server fails, and only to tell the
  router's DNS from the internet's; hosts still never use it (Article 20).
- mtr only with `--trace`: it takes tens of seconds per site.
