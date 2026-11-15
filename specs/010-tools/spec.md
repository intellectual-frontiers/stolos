# Feature Specification: Tools

**Feature Branch**: `010-tools` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: The developer and operator tools at their newest stable release: the
maintainers' PPA when they publish one, else the upstream binary release, else Ubuntu's archive
(Article 5).

## Requirements _(mandatory)_

| Tool       | Source                                                                                                             | Why                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| fish       | apt, `ppa:fish-shell/release-4` (the fish developers)                                                              | newest 4.x; Ubuntu 26.04 has 4.2                                |
| tmux       | Ubuntu (3.6a)                                                                                                      | upstream publishes source only, no maintainers' PPA             |
| git        | apt, `ppa:git-core/ppa` (Ubuntu Git Maintainers)                                                                   | newest git                                                      |
| Bun        | upstream binary at the engine's pin (its version and SHA-256 per platform, spec 096), not the newest               | the engine's runtime; not in Ubuntu's archive                   |
| gh         | apt, GitHub's repository `https://cli.github.com/packages` (key `7F38BBB59D064DBCB3D84D725612B36462313325` pinned) | the vendor's own apt repository; Ubuntu 26.04 ships 2.46 (2024) |
| chezmoi    | upstream binary                                                                                                    | not in Ubuntu's archive                                         |
| oh-my-posh | upstream binary                                                                                                    | not in Ubuntu's archive                                         |

The catalog holds no agent: the agent is the workstation's own MCP client (spec 030).

- **FR-001**: Upstream binaries are verified against the release's published SHA-256 digest,
  installed under `/opt/tools/<tool>/<version>`, smoke-tested, linked into `/usr/local/bin`, and
  rolled back on failure.
- **FR-002**: `archon tools sync` runs weekly (timer) and once at first boot; `--report-only`
  changes nothing.
- **FR-003**: Release lookups use `GITHUB_TOKEN`, else the checkout owner's `gh` login when present,
  else anonymous; `ARCHON_GITHUB_API` points at a mirror.
- **FR-004**: Nothing is built from source.
- **FR-005**: A PPA is added only when it has published builds for the fleet's release
  (`dists/<codename>/InRelease` exists); otherwise Ubuntu's package stays and apply warns. Ubuntu's
  `add-apt-repository` adds it, fetching the PPA's signing key from Launchpad over HTTPS into a
  deb822 source with `Signed-By`. A package installed from Ubuntu before its PPA was added is
  upgraded to the PPA's build at once.
- **FR-007**: A vendor's apt repository is written by apply before packages: its pinned
  ASCII-armored key in `/etc/apt/keyrings/archon-<id>.asc` (fingerprint checked against the vendor's
  published one when pinned) and a deb822 source `/etc/apt/sources.list.d/archon-<id>.sources` with
  `Signed-By`. unattended-upgrades follows it by `site=` in `52archon-ppas`.
- **FR-006**: `/etc/apt/apt.conf.d/52archon-ppas` lets unattended-upgrades follow the PPAs
  (`LP-PPA-git-core`, `LP-PPA-fish-shell-release-4`), so git and fish are upgraded daily like
  security updates.

### Overrides of Ubuntu defaults

- gh: GitHub's apt repository; tools sync removes the `/usr/local/bin/gh` link from the earlier
  upstream-binary install.
- git and fish: the maintainers' PPAs, and unattended-upgrades follows them as well as Ubuntu's
  security pocket. A `/usr/local/bin/fish` left by an earlier upstream-binary install is removed by
  tools sync.
