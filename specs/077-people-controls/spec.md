# 077: People controls as code

Issue intellectual-frontiers/stolos#17: joiners, leavers, access reviews, policies, and training,
built on the estate graph, the Git way.

## Why

An auditor asks the same questions every year about people: did everyone who left lose their access,
on time; did managers review who has access to what, every quarter; did everyone read the policies;
were they trained and screened. Each answer is usually a spreadsheet and a screenshot. The estate
graph (spec 090) already joins the HR system with every account, and the fleet repository already
proves who signed what. A review is a pull request; an approval and an acknowledgement are signed
commits; the evidence is Git's own.

## Requirements

- **FR-001** Leavers: a terminated person with an active account fails a check. It is the estate's
  own `leavers` control (IAC-04), reused, not repeated; `stolos people status` shows it first.
- **FR-002** Joiners: `fleets/<fleet>/people/roles.ts` (`export const roles`) maps a `role_type`
  from the HR system (or `"*"` for everyone) to the connectors it needs. The control
  `people/joiners` (IAC-04, HRS-08) names each active person without an active account in a
  connected system their roles need, and how many days since they started. Without roles.ts it does
  not apply. A team mapping is not offered: the estate has no team yet.
- **FR-003** On leave: `people/on-leave` (IAC-08, HRS-08) warns about the active accounts of people
  on leave (a decision to keep them is an accepted risk, `people/on-leave`).
- **FR-004** Time to deprovision: for each account of a leaver with an end date, the days it stayed
  active after the end date, from the history of the observations in Git (the last version in which
  it could sign in, and the first after that in which it could not or was gone; an account missing
  from a version whose source read everything is gone). `people/time-to-deprovision` (IAC-04,
  HRS-12) warns past one day; `people status` lists every measure.
- **FR-005** Access reviews: `stolos people review [--quarter 2026-Q4]` writes
  `fleets/<fleet>/people/reviews/<quarter>/<manager>.md` for each manager (`party_relationship`
  `reports_to`, reports active or on leave): each report's active accounts (`has_account`) and admin
  rights, one unticked line each, under front matter (quarter, manager, generated). It keeps a file
  already on the branch, refuses a dirty checkout, commits the new files signed on
  `people/review-<quarter>`, pushes the branch, and opens a pull request with `gh` (the GitHub CLI
  the engine already uses). `--check` changes nothing; `--local` commits without pushing.
- **FR-006** Approval: a review is approved when, at HEAD, the last commit that changed it has every
  line ticked and is signed by the manager's own key or a fleet signer; or when a later commit with
  the trailer `Access-Review: <quarter>/<manager>`, signed the same way, approves it as it stands. A
  manager's key is in `fleets/<fleet>/people/keys.ts` (`export const keys`, work email to one
  `ssh-ed25519` public key); its principal in the allowed-signers file is the email, and a fleet
  signer's is their name in signers.ts. Another person's key approves nothing.
- **FR-007** `people/access-reviews` (IAC-12) fails unless every current manager has an approved
  review for the last quarter that ended; it applies when the fleet keeps people files.
- **FR-008** Evidence by itself: each review file as approved and the raw approving commit (with its
  signature) are evidence items (`reviewEvidence`); `stolos evidence export` adds them for the
  quarters its period overlaps (a new item kind, `people`, beside the `commit`).
- **FR-009** Policies: Markdown in `fleets/<fleet>/policies/<policy>.md`, front matter `title`,
  `version`, `owner`, `review` (the next review date). `people/policy-reviews` (GOV-04.1) fails for
  a policy past its review date or without one.
- **FR-010** Acknowledgements: `stolos people ack <policy>` adds the person (Git's user.email) and
  the current version to `policies/acks/<policy>.ts` and commits it signed with their own key, with
  the trailer `Acknowledges: <policy>@<version>`. Only a commit with that trailer signed by the key
  people/keys.ts lists for the person counts. `people/policy-acks` (HRS-08.2) fails while an active
  person owes a current version.
- **FR-011** Training and screening: `people/training.ts` (`email`, `course`, `date`, `result`) and
  `people/screening.ts` (`email`, `check`, `date`, `result`), nothing more. `people/training`
  (SAT-04, SAT-10) fails for an active person without a passed training in 12 months;
  `people/screening` (HRS-05) for one with none on file or none clear. Connectors hook in with the
  label `person_record` (`kind` training or screening); none supplies it yet.
- **FR-012** Controls are on the SDK (spec 078): estate controls whose SQL reads the graph and whose
  assertions compare it with the people facts from Git. With people files kept (a `people/` or
  `policies/` folder), they run as the built-in pack `people` in the consoles' facts, so they show
  in `stolos compliance` as control-pack evidence; accepted risks apply as `people/<control>`.
- **FR-013** Commands: `stolos people status` (alias `stolos people`; read-only, MCP and the
  console's People group), `stolos people review` and `stolos people ack` (terminal only).
- **FR-014** SCF ids added to `scf.ts`, each checked against SCF 2026.3 (the pinned workbook):
  IAC-12, HRS-05, HRS-08, HRS-08.2, HRS-12, GOV-04.1, SAT-04, SAT-10.
- **FR-015** The guide `people` (`src/archon/people/mod.ts`).

## Merging a review

A review's pull request is merged so the signed commits stay: a fast-forward or a merge commit made
by a fleet signer on this PC (`git merge --ff-only`, then `stolos apply`), never a squash or a
rebase, which would replace the manager's signature.

## Success criteria

- **SC-001** `tests/people077.test.ts`: a leaver with active accounts fails; a joiner without the
  accounts their role needs is named; time to deprovision from a fixture history; review files per
  manager from a fixture estate; approval verified with real SSH-signed commits in a temporary
  repository (the manager's key, a fleet signer's trailer; another person's key and an unknown key
  refused), and the evidence items; acknowledgements signed by each person's own key; training and
  screening, from files and a connector; every cited SCF id in the catalog when it is cached; and,
  in a temporary fleet repository, `people status`, `people review --check`, and `compliance`.
- **SC-002** Existing tests pass unchanged.
