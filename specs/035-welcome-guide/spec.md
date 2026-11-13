# Feature Specification: A welcome page and guide for newcomers

**Feature Branch**: `035-welcome-guide` (committed directly to main) **Created**: 2026-11-12
**Status**: Implemented **Input**: Make each server's welcome page useful for newcomers and
non-technical people: what the server is, whether it's healthy (in plain words), its apps, what's
installed by default and how to use it, how dotfiles (chezmoi) work, and, prominently, how to manage
the server with Claude Code, Codex, or another MCP client while keeping the fleet up to date through
the Git repository. Link to anything live; the page itself stays static, rendered per request. Show
the fleet's mailbox. Offer the same in the terminal (`archon guide`) and point to it from the login
banner.

## User Scenarios & Testing _(mandatory)_

1. **Given** someone opens `https://alpha.<domain>` for the first time, **When** the page loads,
   **Then** they read what the server is and that changes go through the repository, one plain
   health sentence (with what to do when it isn't healthy), and first steps with copyable commands.
2. **Given** they want an agent to look after the server, **When** they read "Manage this server
   with an AI agent", **Then** they get the exact steps for this server: clone and pull the
   repository, test the SSH key, Claude Code (`.mcp.json`, or `claude mcp add`), Codex
   (`~/.codex/config.toml`), any MCP client (`ssh` and its arguments), what to ask, and the Git loop
   (build, commit, push, pull; servers apply main within 15 minutes or on `archon_update`).
3. **Given** a Podman container with the label `traefik.enable=true` starts, **When** the page is
   reloaded, **Then** the container is listed among the apps with its address (Traefik's own
   routes).
4. **Given** someone runs `archon guide` on a server, **When** it prints, **Then** it shows the same
   agent steps and the same "what's here" list as the page.
5. **Given** the page, **When** it renders the last run, **Then** no Nerd Font glyph appears (they
   show as boxes in a browser).

## Requirements _(mandatory)_

- **FR-001**: One source for "what's here": `guideFor(plan)` (`src/archon/guide/guide.ts`) returns
  items by category (shell, web, watch, safety, email, work), each with a plain description,
  commands with what they do, live links (Cockpit's overview, logs, services, metrics, terminal;
  Traefik's dashboard; the repository), and a longer guide. An item appears only when the plan has
  what it describes.
- **FR-002**: Agent steps: `agentSetup(plan)` and `agentSteps()`, using the same MCP server name and
  SSH target as the repository's `.mcp.json` (spec 030). `AGENTS.md` at the repository's root points
  any agent at `CLAUDE.md`.
- **FR-003**: The welcome page: what this is; "How it's doing" (one sentence; checks now from the
  last `archon verify` as root, `/var/lib/archon/status/verify.json`; the last run in words from
  `/var/lib/archon/status/last.json`; the certificate; updates waiting, when they last installed by
  themselves, and whether a restart is needed; the last backup; when it was set up); the agent
  section; apps (from the plan and Traefik's live routes, containers included); first steps; what's
  here (the guide items, folded by category); guides; a glossary. Commands carry a copy button. Only
  ports open to the network and unpublished are listed (loopback-only services are not). The mailbox
  is shown; nothing secret is.
- **FR-004**: Guides served at `/guide/<name>` from `docs/guide.md`, `docs/dotfiles.md`,
  `docs/web.md`, `docs/daily-use.md`, and `docs/agent.md`, rendered from Markdown; links to other
  guides stay on the server, the rest go to GitHub.
- **FR-005**: `archon guide` prints the agent steps and the guide items; `man archon-guide`
  (section 7) is `docs/guide.md`.
- **FR-006**: The login banner's Archon line points to `archon guide`.

### Overrides of Ubuntu defaults

None.
