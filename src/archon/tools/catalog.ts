/**
 * Tool catalog (spec 010, Article 5): the newest stable release of each tool,
 * from its maintainers' PPA or the vendor's own apt repository when there is
 * one (apt keeps it current), else its official binary release
 * (checksum-verified), else Ubuntu's archive (tmux).
 * Nothing is built
 * from source.
 *
 * @module
 */

import type { ToolDef } from "../model/types.ts";
import { GITHUB_CLI_KEY } from "./keys/github-cli.ts";
import { OSQUERY_KEY } from "./keys/osquery.ts";

const SPEC = "010-tools" as const;
const x86 = () => "x86_64";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every tool Archon installs, with where it comes from and how it is verified. */
export const TOOLS: ToolDef[] = [
  {
    // The fish developers' own PPA (fish-shell/release-4) carries every 4.x release.
    id: "fish",
    name: "fish",
    source: "apt",
    package: "fish",
    ppa: "fish-shell/release-4",
    bins: ["fish"],
    versionCommand: "fish --version",
    verify: "fish --no-config -c 'exit 0'",
    spec: SPEC,
  },
  {
    // tmux publishes source only and has no maintainers' PPA: Ubuntu's build.
    id: "tmux",
    name: "tmux",
    source: "apt",
    package: "tmux",
    bins: ["tmux"],
    versionCommand: "tmux -V",
    verify: "tmux -V",
    spec: SPEC,
  },
  {
    // The Ubuntu Git Maintainers' PPA (git-core/ppa) carries the newest git.
    id: "git",
    name: "git",
    source: "apt",
    package: "git",
    ppa: "git-core/ppa",
    bins: ["git"],
    versionCommand: "git --version",
    verify: "git --version",
    spec: SPEC,
  },
  {
    // GitHub's own apt repository (Ubuntu 26.04 ships gh 2.46): apt and
    // unattended-upgrades keep it at the newest release.
    id: "gh",
    name: "GitHub CLI",
    source: "apt",
    package: "gh",
    repo: {
      id: "github-cli",
      uri: "https://cli.github.com/packages",
      suites: "stable",
      components: "main",
      key: GITHUB_CLI_KEY,
      site: "cli.github.com",
      spec: SPEC,
    },
    bins: ["gh"],
    versionCommand: "gh --version",
    verify: "gh --version",
    spec: SPEC,
  },
  {
    // Not in Ubuntu's archive: upstream binary.
    id: "chezmoi",
    name: "chezmoi",
    source: "upstream-binary",
    bins: ["chezmoi"],
    versionCommand: "chezmoi --version",
    verify: "/usr/local/bin/chezmoi --version",
    spec: SPEC,
    github: {
      repo: "twpayne/chezmoi",
      tagPrefix: "v",
      asset: (arch) => new RegExp(`^chezmoi-linux-${arch}$`),
    },
  },
  {
    // Not in Ubuntu's archive: upstream binary.
    id: "oh-my-posh",
    name: "oh-my-posh",
    source: "upstream-binary",
    bins: ["oh-my-posh"],
    versionCommand: "oh-my-posh version",
    verify: "/usr/local/bin/oh-my-posh version",
    spec: SPEC,
    github: {
      repo: "JanDeDobbeleer/oh-my-posh",
      tagPrefix: "v",
      asset: (arch) => new RegExp(`^posh-linux-${arch}$`),
    },
  },
  {
    // Live system view on every host and workstation (spec 021).
    id: "btop",
    name: "btop",
    source: "apt",
    package: "btop",
    bins: ["btop"],
    versionCommand: "btop --version",
    verify: "btop --version",
    spec: "021-observability",
  },
  {
    // The OpenTelemetry Collector (contrib distribution, the official release
    // archive): the one translator to OTLP on each machine (spec 021).
    id: "otelcol",
    name: "OpenTelemetry Collector",
    source: "upstream-binary",
    bins: ["otelcol-contrib"],
    versionCommand: "otelcol-contrib --version",
    verify: "/usr/local/bin/otelcol-contrib --version",
    spec: "021-observability",
    github: {
      repo: "open-telemetry/opentelemetry-collector-releases",
      tagPrefix: "v",
      asset: (arch, v) => new RegExp(`^otelcol-contrib_${esc(v)}_linux_${arch}\\.tar\\.gz$`),
    },
    restarts: ["archon-otelcol.service"],
  },
  {
    // A terminal viewer for OTLP (spec 021): archon observe tui.
    id: "otel-tui",
    name: "otel-tui",
    source: "upstream-binary",
    bins: ["otel-tui"],
    versionCommand: "otel-tui --version",
    verify: "/usr/local/bin/otel-tui --version",
    spec: "021-observability",
    github: {
      repo: "ymtdzzz/otel-tui",
      tagPrefix: "v",
      asset: () => new RegExp(`^otel-tui_Linux_${x86()}\\.tar\\.gz$`),
    },
  },
  // Spec 036: modern command-line comforts. Ubuntu 26.04's packages (checked
  // 2026-11-12 at packages.ubuntu.com/resolute): eza 0.23.4, bat 0.25.0,
  // zoxide 0.9.8, fzf 0.67.0, ripgrep 15.1.0, fd-find 10.3.0, git-delta 0.18.2,
  // duf 0.9.1, du-dust 1.2.4, tealdeer 1.8.1. Recent enough: Ubuntu's (Article 2),
  // kept current with security fixes by unattended-upgrades. archon shell emit
  // turns on the aliases (ls, ll, la, tree, cat, fd) and fzf's and zoxide's keys.
  {
    // a modern ls and tree
    id: "eza",
    name: "eza",
    source: "apt",
    package: "eza",
    bins: ["eza"],
    versionCommand: "eza --version",
    verify: "eza --version",
    spec: "036-cli-comforts",
  },
  {
    // cat with syntax colors (Ubuntu names it batcat)
    id: "bat",
    name: "bat",
    source: "apt",
    package: "bat",
    bins: ["batcat"],
    versionCommand: "batcat --version",
    verify: "batcat --version",
    spec: "036-cli-comforts",
  },
  {
    // z jumps to folders you use
    id: "zoxide",
    name: "zoxide",
    source: "apt",
    package: "zoxide",
    bins: ["zoxide"],
    versionCommand: "zoxide --version",
    verify: "zoxide --version",
    spec: "036-cli-comforts",
  },
  {
    // fuzzy finder: Ctrl+R history, Ctrl+T files, Alt+C folders
    id: "fzf",
    name: "fzf",
    source: "apt",
    package: "fzf",
    bins: ["fzf"],
    versionCommand: "fzf --version",
    verify: "fzf --version",
    spec: "036-cli-comforts",
  },
  {
    // rg: fast search through files
    id: "ripgrep",
    name: "ripgrep",
    source: "apt",
    package: "ripgrep",
    bins: ["rg"],
    versionCommand: "rg --version",
    verify: "rg --version",
    spec: "036-cli-comforts",
  },
  {
    // fd: fast, friendly find (Ubuntu names it fdfind)
    id: "fd",
    name: "fd",
    source: "apt",
    package: "fd-find",
    bins: ["fdfind"],
    versionCommand: "fdfind --version",
    verify: "fdfind --version",
    spec: "036-cli-comforts",
  },
  {
    // readable git diffs
    id: "delta",
    name: "git-delta",
    source: "apt",
    package: "git-delta",
    bins: ["delta"],
    versionCommand: "delta --version",
    verify: "delta --version",
    spec: "036-cli-comforts",
  },
  {
    // disk usage at a glance
    id: "duf",
    name: "duf",
    source: "apt",
    package: "duf",
    bins: ["duf"],
    versionCommand: "duf --version",
    verify: "duf --version",
    spec: "036-cli-comforts",
  },
  {
    // which folders take the space
    id: "dust",
    name: "dust",
    source: "apt",
    package: "du-dust",
    bins: ["dust"],
    versionCommand: "dust --version",
    verify: "dust --version",
    spec: "036-cli-comforts",
  },
  {
    // tldr: short examples for a command
    id: "tealdeer",
    name: "tealdeer",
    source: "apt",
    package: "tealdeer",
    bins: ["tldr"],
    versionCommand: "tldr --version",
    verify: "tldr --version",
    spec: "036-cli-comforts",
  },
  // Spec 038: PostgreSQL tools, small single binaries (not in Ubuntu 26.04's archive,
  // checked 2026-11-12), from each project's own release with its SHA-256 digest.
  {
    // a terminal UI for PostgreSQL: browse, query, and edit (psql service=... works too)
    id: "rainfrog",
    name: "rainfrog",
    source: "upstream-binary",
    bins: ["rainfrog"],
    versionCommand: "rainfrog --version",
    verify: "/usr/local/bin/rainfrog --version",
    spec: "038-pg",
    github: {
      repo: "achristmascarl/rainfrog",
      tagPrefix: "v",
      // The static (musl) build: no shared libraries to match.
      asset: (_arch, v) =>
        new RegExp(`^rainfrog-v${esc(v)}-${x86()}-unknown-linux-musl\\.tar\\.gz$`),
    },
  },
  {
    // top for PostgreSQL: live activity, statements, I/O, replication
    id: "pgcenter",
    name: "pgcenter",
    source: "upstream-binary",
    bins: ["pgcenter"],
    versionCommand: "pgcenter --version",
    verify: "/usr/local/bin/pgcenter --version",
    spec: "038-pg",
    github: {
      repo: "lesovsky/pgcenter",
      tagPrefix: "v",
      asset: (arch, v) => new RegExp(`^pgcenter_${esc(v)}_linux_${arch}\\.tar\\.gz$`),
    },
  },
  // Spec 042: SQL over infrastructure. osquery (the machine), DuckDB (files, S3,
  // PostgreSQL, SQLite), jc (command output as JSON for DuckDB), sqlite3, and on
  // workstations Steampipe (cloud and SaaS APIs, with the operator's credentials).
  {
    // PostgreSQL's own client (spec 043: archon pg test from any host, workstations included)
    id: "psql",
    name: "psql",
    source: "apt",
    package: "postgresql-client",
    bins: ["psql"],
    versionCommand: "psql --version",
    verify: "psql --version",
    spec: "043-pg-connections",
  },
  {
    // the machine as SQL tables: processes, ports, users, packages, units, files
    id: "osquery",
    name: "osquery",
    source: "apt",
    package: "osquery",
    repo: {
      id: "osquery",
      uri: "https://pkg.osquery.io/deb",
      suites: "deb",
      components: "main",
      key: OSQUERY_KEY,
      site: "pkg.osquery.io",
      spec: "042-sql",
    },
    bins: ["osqueryi"],
    versionCommand: "osqueryi --version",
    verify: "osqueryi --version",
    spec: "042-sql",
  },
  {
    // SQL over CSV, JSON, Parquet, S3 buckets, PostgreSQL, and SQLite
    id: "duckdb",
    name: "DuckDB",
    source: "upstream-binary",
    bins: ["duckdb"],
    versionCommand: "duckdb --version",
    verify: "/usr/local/bin/duckdb --version",
    spec: "042-sql",
    github: {
      repo: "duckdb/duckdb",
      tagPrefix: "v",
      // 2.x publishes duckdb-cli-linux-amd64.tar.gz (1.x: duckdb_cli-linux-amd64.zip).
      asset: (arch) => new RegExp(`^duckdb[-_]cli-linux-${arch}\\.(tar\\.gz|zip)$`),
    },
  },
  {
    // command output (ps, df, ss, dig, systemctl...) as JSON, for DuckDB or jq
    id: "jc",
    name: "jc",
    source: "apt",
    package: "jc",
    bins: ["jc"],
    versionCommand: "jc --version",
    verify: "jc --version",
    spec: "042-sql",
  },
  {
    // SQLite databases (many apps keep their state in one)
    id: "sqlite3",
    name: "sqlite3",
    source: "apt",
    package: "sqlite3",
    bins: ["sqlite3"],
    versionCommand: "sqlite3 --version",
    verify: "sqlite3 --version",
    spec: "042-sql",
  },
  {
    // SQL over live APIs (GitHub, clouds, DNS, certificates) with the operator's
    // own credentials, so workstations only (secrets stay off servers).
    id: "steampipe",
    name: "Steampipe",
    source: "upstream-binary",
    bins: ["steampipe"],
    versionCommand: "steampipe --version",
    // It refuses to run as root; checked as nobody, with a home it can write.
    verify: "env HOME=/tmp /usr/local/bin/steampipe --version",
    unprivileged: true,
    spec: "042-sql",
    workstationOnly: true,
    github: {
      repo: "turbot/steampipe",
      tagPrefix: "v",
      asset: (arch) => new RegExp(`^steampipe_linux_${arch}\\.tar\\.gz$`),
    },
  },
  {
    // The HTTPS front door (spec 032): the official release archive, servers only.
    id: "traefik",
    name: "Traefik",
    source: "upstream-binary",
    bins: ["traefik"],
    versionCommand: "traefik version",
    verify: "/usr/local/bin/traefik version",
    spec: "032-web",
    serverOnly: true,
    github: {
      repo: "traefik/traefik",
      tagPrefix: "v",
      asset: (arch, v) => new RegExp(`^traefik_v${esc(v)}_linux_${arch}\\.tar\\.gz$`),
    },
    restarts: ["traefik.service"],
  },
];

/** Where an upstream binary tool installs (/opt/tools/<id>); undefined for apt-installed tools. */
export function installPathFor(t: ToolDef): string | undefined {
  return t.source === "upstream-binary" ? `/opt/tools/${t.id}` : undefined;
}
