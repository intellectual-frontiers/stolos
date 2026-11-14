/**
 * 035-welcome-guide: what is on this server and how to use it, in plain words,
 * computed from the server's own plan (Article 4: one source). The welcome
 * page, `archon guide`, and the login banner's pointer all read this; an item
 * appears only when the plan really has what it describes.
 *
 * @module
 */

import type { HostPlan } from "../model/types.ts";
import { fqdn } from "../web/config.ts";
import { hostData } from "../model/durable.ts";

/** A guide section. */
export type Category = "shell" | "web" | "watch" | "safety" | "email" | "work";

/** Each section's emoji, title, and introduction. */
export const CATEGORIES: Record<Category, { emoji: string; title: string; intro: string }> = {
  shell: {
    emoji: "💻",
    title: "Your shell and your files",
    intro: "What you get when you log in with SSH.",
  },
  web: {
    emoji: "🌐",
    title: "Web apps and containers",
    intro: "How apps on this server get a secure web address.",
  },
  watch: {
    emoji: "📊",
    title: "Watching the server",
    intro: "Where to look when you want to know what the server is doing.",
  },
  safety: {
    emoji: "🛡️",
    title: "Kept safe automatically",
    intro: "Things that happen by themselves, so you don't have to remember them.",
  },
  email: {
    emoji: "✉️",
    title: "Email",
    intro: "Where this server's mail and alerts go.",
  },
  work: {
    emoji: "🧭",
    title: "Changing this server",
    intro: "How changes are made: in the repository, not by hand.",
  },
};

/** One item of the guide: what is on this machine and how to use it. */
export interface GuideItem {
  /** Its id. */
  id: string;
  /** Its section. */
  category: Category;
  /** Its title. */
  title: string;
  /** One or two plain sentences: what it is and why you'd care. */
  what: string;
  /** Commands to try, each with what it does. */
  use?: Array<{ cmd: string; why: string }>;
  /** Live places to open (Cockpit pages, dashboards, the repository). */
  links?: Array<{ label: string; href: string }>;
  /** A longer guide on the welcome page (/guide/<name>) and in the repository. */
  guide?: string;
}

/** The guide's items for a host's plan. */
export function guideFor(plan: HostPlan): GuideItem[] {
  const { fleet, host } = plan;
  const name = fqdn(fleet, host);
  const tool = (id: string) => plan.tools.some((t) => t.id === id);
  const unit = (u: string) => plan.units.some((x) => x.unitName === u);
  const pkg = (p: string) => plan.packages.some((x) => x.name === p);
  const server = host.kind !== "workstation";
  const cockpitBase = name ? `https://cockpit.${name}` : `https://${host.name}:9090`;
  const repo = `https://github.com/${fleet.repository.slug}`;
  const items: GuideItem[] = [];
  const add = (i: GuideItem) => items.push(i);

  // ------------------------------------------------------------------ shell
  add({
    id: "archon",
    category: "shell",
    title: "archon: one command for this server",
    what:
      "Everything Archon does here is an archon command, and every command has a manual page. Start with these.",
    use: [
      { cmd: "archon guide", why: "this list, in the terminal" },
      { cmd: "archon verify", why: "check everything, with a fix for anything that fails" },
      { cmd: "man archon", why: "every command, explained" },
    ],
  });
  if (tool("fish")) {
    add({
      id: "fish",
      category: "shell",
      title: "fish, the friendly shell, and the Archon prompt",
      what:
        "When you log in you land in fish: it suggests commands as you type (press → to accept one). The prompt shows the server's name, your folder, git status, and how Archon's last run went.",
      use: [
        { cmd: "Tab", why: "complete a command, a file name, or an option" },
        { cmd: "↑", why: "search earlier commands that start with what you typed" },
        { cmd: "bash", why: "switch to bash for a moment (exit to come back)" },
      ],
    });
  }
  if (tool("eza") || tool("bat") || tool("fzf")) {
    add({
      id: "comforts",
      category: "shell",
      title: "Modern command-line comforts",
      what:
        "ls, ll, la, and tree show colors and git status (eza); cat shows syntax colors (bat); z jumps to folders you use (zoxide); Ctrl+R searches your history and Ctrl+T finds files (fzf). One line in your shell's startup file turns them on, and the fleet's settings include it; take it out and you get the classic tools.",
      use: [
        { cmd: "archon shell status", why: "whether your shells have them turned on" },
        { cmd: "z proj", why: "jump to the folder you use most that matches 'proj'" },
        { cmd: "rg 'some text'", why: "search every file below here, fast" },
        { cmd: "fd name", why: "find files by name" },
        { cmd: "duf", why: "disks and free space" },
        { cmd: "dust", why: "which folders take the space" },
        { cmd: "tldr tar", why: "short examples for a command" },
        { cmd: "command ls", why: "the original ls (likewise command cat)" },
      ],
      guide: "dotfiles",
    });
  }
  {
    const ws = host.kind === "workstation";
    add({
      id: "prompt",
      category: "shell",
      title: "The prompt, and the font it needs",
      what: ws
        ? host.desktop
          ? "The colorful prompt uses a Nerd Font for its icons. Install one for your account, then choose it in your terminal's preferences."
          : "The colorful prompt uses a Nerd Font for its icons. On WSL the font belongs to Windows: install it there, then choose it in Windows Terminal (Settings, Ubuntu, Appearance, Font face)."
        : "The colorful prompt needs a Nerd Font on the computer you connect from; on the server's own console the prompt is plain, without icons. Seeing boxes instead of icons? Install a Nerd Font on your computer, or choose the plain prompt here.",
      use: ws
        ? host.desktop
          ? [{
            cmd: "oh-my-posh font install meslo",
            why: "install the MesloLGM Nerd Font for you",
          }]
          : [
            {
              cmd: "winget install JanDeDobbeleer.OhMyPosh",
              why: "on Windows (PowerShell), once: the tool that installs fonts",
            },
            {
              cmd: "oh-my-posh font install meslo",
              why: "on Windows: install the MesloLGM Nerd Font",
            },
          ]
        : [
          { cmd: "set -Ux ARCHON_PROMPT plain", why: "fish: the plain prompt from now on" },
          {
            cmd: "echo 'export ARCHON_PROMPT=plain' >> ~/.bashrc.local",
            why: "bash: the same",
          },
          { cmd: "set -Ue ARCHON_PROMPT", why: "fish: back to the colorful prompt" },
        ],
    });
    add({
      id: "vscode",
      category: "shell",
      title: "Editing with VS Code",
      what: ws
        ? host.desktop
          ? "VS Code is installed here (Microsoft's package, kept current with the system's updates)."
          : "VS Code runs on Windows and edits files here through its WSL extension."
        : `Use VS Code on your own computer with the Remote - SSH extension: connect to ${fleet.admin.user}@${
          name ?? host.name
        } and open a folder. Nothing extra is installed on the server.`,
      use: ws ? [{ cmd: "code .", why: "open this folder in VS Code" }] : [],
    });
  }
  if (tool("tmux")) {
    add({
      id: "tmux",
      category: "shell",
      title: "tmux: keep working when the connection drops",
      what:
        "Start long jobs inside tmux. If your SSH connection drops, log in again and pick up where you were.",
      use: [
        { cmd: "tmux", why: "start a session" },
        { cmd: "tmux attach", why: "return to it after reconnecting" },
        { cmd: "Ctrl+b then d", why: "leave it running in the background" },
      ],
    });
  }
  if (tool("git")) {
    add({
      id: "git",
      category: "shell",
      title: "git and GitHub's CLI",
      what: "git is set up with your name and GitHub's private email address; gh talks to GitHub.",
      use: [{ cmd: "gh auth login", why: "sign in to GitHub from this server, once" }],
    });
  }
  if (tool("chezmoi")) {
    add({
      id: "dotfiles",
      category: "shell",
      title: "Your settings (dotfiles), by chezmoi",
      what:
        "Your shell, prompt, tmux, and git settings come from the fleet's repository, in layers: for everyone, for this server, and for you. Archon applies them; you change them in the repository. Tweaks for this machine only go in files Archon never touches.",
      use: [
        { cmd: "archon dotfiles", why: "where each of your files comes from" },
        { cmd: "chezmoi diff", why: "what the next update would change in your home" },
        { cmd: "~/.bashrc.local and ~/.config/fish/local.fish", why: "this machine only" },
        { cmd: "man archon-dotfiles", why: "the whole story" },
      ],
      guide: "dotfiles",
    });
  }

  // -------------------------------------------------------------------- web
  if (unit("traefik.service")) {
    add({
      id: "https",
      category: "web",
      title: "Secure web addresses (HTTPS) for every app",
      what: name
        ? `Every app here gets its own address under ${name}, with a certificate that renews by itself. Only the local networks can reach them.`
        : "Apps here are served over HTTPS (with a self-signed certificate until the fleet has a domain). Only the local networks can reach them.",
      use: [{ cmd: "archon web status", why: "the certificate, the DNS name, and every address" }],
      links: name
        ? [{ label: "Traefik's dashboard: every route, live", href: `https://traefik.${name}` }]
        : [],
      guide: "web",
    });
  }
  if (pkg("podman")) {
    const app = name ? `https://hello.${name}` : "its address";
    add({
      id: "containers",
      category: "web",
      title: "Run an app in a container (Podman)",
      what:
        `Containers run apps without installing them on the server. Give one the label traefik.enable=true and it gets its own HTTPS address at once, for example ${app}.`,
      use: [
        {
          cmd:
            "sudo podman run -d --name hello --label traefik.enable=true docker.io/traefik/whoami",
          why: `start a tiny test app at ${app}`,
        },
        { cmd: "sudo podman ps", why: "what is running" },
        { cmd: "sudo podman logs hello", why: "its output" },
        { cmd: "sudo podman rm -f hello", why: "stop and remove it" },
      ],
      guide: "web",
    });
  }
  if (unit("smbd.service")) {
    const smbHost = name ? `smb.${name}` : host.name;
    add({
      id: "smb",
      category: "web",
      title: "File shares for Windows, macOS, and Linux (SMB)",
      what:
        `One shared folder for everyone with an account, and your own home folder, at ${smbHost}, from the local networks. Sign in with your Linux username and password. Off until an operator turns it on; then it stays on until turned off.`,
      use: [
        { cmd: "archon fs smb status", why: "on or off, and how to connect" },
        {
          cmd: "archon fs smb on --durable",
          why: "operators: turn it on, durable or --ephemeral",
        },
        { cmd: `\\\\${smbHost}\\shared`, why: "Windows: Map network drive" },
        { cmd: `smb://${smbHost}/shared`, why: "macOS (Finder, Connect to Server) and Linux" },
      ],
      guide: "smb",
    });
  }
  if (unit("archon-s3.service")) {
    const s3Host = name ? `s3.${name}` : host.name;
    add({
      id: "s3",
      category: "web",
      title: "S3 object storage",
      what:
        `An S3-compatible object store (RustFS) at https://${s3Host}, from the local networks, off until an operator turns it on. Your S3 user is your Linux username; your buckets are the ones named <you>-*.`,
      use: [
        { cmd: "archon fs s3 status", why: "on or off, and the addresses" },
        { cmd: "archon fs s3 key --write", why: "your key, as the AWS profile s3-<server>" },
        {
          cmd: "archon fs s3 key --show",
          why: "your secret, for the web console's Key (not your Linux password)",
        },
        { cmd: "archon fs s3 key --rotate", why: "a new secret, if yours may have been seen" },
        {
          cmd: "archon fs s3 on --durable",
          why: "operators: turn it on, durable or --ephemeral",
        },
        { cmd: "archon opt-in", why: "every opt-in service and container, on or off" },
      ],
      guide: "s3",
    });
  }
  if (plan.notes["038-pg"]) {
    const pgHost = name ? `pg-prime.${name}` : host.name;
    add({
      id: "pg",
      category: "web",
      title: "PostgreSQL databases",
      what:
        `Named PostgreSQL instances (prime is PostgreSQL 18), off until an operator turns them on. You connect as yourself (your Linux account is your database identity, no password on the server); apps run as their own service accounts. Private to this server unless an operator publishes one (then ${pgHost} over TLS with your Linux password, from wherever the router lets clients through, or the local networks only). A protected database needs an explicit COMMIT.`,
      use: [
        { cmd: "psql service=prime", why: "connect as yourself (no password)" },
        { cmd: "archon pg list", why: "every instance, its version, port, and status" },
        {
          cmd: "archon pg on --durable",
          why: "operators: turn PostgreSQL on, durable or --ephemeral",
        },
        { cmd: "archon pg who prime", why: "who can log in, and as which Linux account" },
        {
          cmd: "archon pg admin-tui",
          why: "browse, query, and edit in rainfrog, connected as you",
        },
        { cmd: "archon pg observe-tui", why: "watch it live in pgcenter top" },
      ],
      guide: "pg",
    });
  }
  if (unit("osqueryd.service")) {
    add({
      id: "sql",
      category: "watch",
      title: "Ask the server in SQL",
      what:
        "osquery answers questions about this machine in SQL (processes, ports, users, packages, units), and records what changes; DuckDB queries files, S3 buckets, and PostgreSQL; jc turns command output into tables.",
      use: [
        { cmd: "sudo osqueryi", why: "the machine as SQL tables (.tables lists them)" },
        { cmd: "duckdb", why: "SQL over CSV, JSON, Parquet, S3, and PostgreSQL" },
        {
          cmd: "df | jc --df | duckdb -c \"SELECT * FROM read_json_auto('/dev/stdin')\"",
          why: "command output as a table",
        },
        {
          cmd: "sudo tail -f /var/log/osquery/osqueryd.results.log",
          why: "what changed, as osquery sees it",
        },
      ],
      guide: "sql",
    });
  }
  if (host.guests?.length) {
    add({
      id: "guests",
      category: "web",
      title: "Virtual machines and system containers (LXD)",
      what: `This server also runs ${
        host.guests.map((g) => g.name).join(", ")
      }, described in its model.`,
      use: [{ cmd: "lxc list", why: "each one and its state" }],
    });
  }

  // ------------------------------------------------------------------ watch
  if (unit("cockpit.socket")) {
    add({
      id: "cockpit",
      category: "watch",
      title: "Cockpit: the server in your browser",
      what:
        "A web console for this server: its health, services, logs, and metric history, plus a terminal. Log in with your own username and password.",
      links: [
        { label: "Overview", href: cockpitBase },
        { label: "Logs", href: `${cockpitBase}/system/logs` },
        { label: "Services", href: `${cockpitBase}/system/services` },
        { label: "Metrics", href: `${cockpitBase}/metrics` },
        { label: "Terminal", href: `${cockpitBase}/system/terminal` },
      ],
    });
  }
  if (tool("btop") || unit("archon-otelcol.service")) {
    add({
      id: "observe",
      category: "watch",
      title: "Logs and metrics, in the terminal",
      what:
        "The server keeps its logs and metrics for a while. These show what it's doing right now and what happened earlier.",
      use: [
        { cmd: "btop", why: "processes, CPU, memory, disks, network, live (q quits)" },
        { cmd: "journalctl -f", why: "the system's log as it happens (Ctrl+C stops)" },
        { cmd: "archon observe", why: "how far back logs and metrics go, and their limits" },
      ],
    });
  }
  if (unit("archon-daily-report.timer")) {
    add({
      id: "report",
      category: "watch",
      title: "A health report every morning",
      what: `Every morning the server writes a short health report${
        fleet.mail ? ` and emails it to ${fleet.mail.to}` : ""
      }.`,
      use: [{ cmd: "ls /var/lib/archon/reports", why: "the reports kept here" }],
    });
  }

  // ----------------------------------------------------------------- safety
  add({
    id: "updates",
    category: "safety",
    title: "Security updates install themselves",
    what:
      "Ubuntu installs security and stable updates every day, and Archon keeps its own tools current every week. If an update needs a restart, it shows below and in Cockpit.",
    use: [{ cmd: "apt list --upgradable", why: "updates waiting, if any" }],
  });
  if (server) {
    const d = hostData(host);
    add({
      id: "data",
      category: "safety",
      title: d.class === "durable"
        ? `This server is durable: ${d.reasons.join(", ")}`
        : "This server is ephemeral",
      what: `${
        d.class === "durable"
          ? "Something here holds people's data that exists nowhere else: it is archived every night, and nobody can reinstall or wipe this server without repeating its name."
          : "Nothing here holds people's data that exists nowhere else; it can be reinstalled from the repository at any time."
      } Every database, bucket, file share, and guest is marked durable or ephemeral when it is turned on (constitution Article 23). Your home directory is not kept across a reinstall: keep data in a share, a bucket, or a database.`,
      use: [{ cmd: "archon data", why: "durable or ephemeral, and why" }],
    });
    add({
      id: "firewall",
      category: "safety",
      title: "A firewall that only lets in what's needed",
      what:
        "Only SSH (22) and the web (80, 443) answer here; Cockpit (9090) and file sharing (445, when turned on) answer the local networks only. Everything behind the web address is local-networks only too.",
      use: [{ cmd: "sudo ufw status verbose", why: "the rules in force" }],
    });
    add({
      id: "ssh",
      category: "safety",
      title: "Logging in safely",
      what:
        "SSH accepts your key from anywhere and your password only from the local networks. Every login is emailed to the fleet's mailbox.",
    });
  }
  if (unit("archon-backup.timer")) {
    add({
      id: "backup",
      category: "safety",
      title: "Backups every night",
      what: "The server's data folders are archived every night; the newest few are kept.",
      use: [
        { cmd: "archon backup run", why: "make one now" },
        { cmd: "archon backup verify", why: "check the newest one can be read back" },
      ],
    });
  }
  if (pkg("etckeeper")) {
    add({
      id: "etckeeper",
      category: "safety",
      title: "A history of every settings change",
      what:
        "Every change to the system's settings (/etc) is recorded, with who made it: Ubuntu's updates, Archon, or a person.",
      use: [{ cmd: "sudo etckeeper vcs log --stat -5", why: "the last five changes" }],
    });
  }

  // ------------------------------------------------------------------ email
  if (fleet.mail && pkg("postfix")) {
    add({
      id: "mail",
      category: "email",
      title: "Mail from this server",
      what:
        `Mail sent by programs here (scheduled jobs, apps, alerts) goes to ${fleet.mail.to}, from addresses like root+${host.name}.${
          fleet.mail.tag ?? host.name
        }@${fleet.mail.domain}.`,
      use: [{ cmd: "archon mail test", why: "send a test message" }],
    });
  }
  if (fleet.mail && unit("archon-notify-watch.service")) {
    add({
      id: "notify",
      category: "email",
      title: "Alerts",
      what:
        `Archon emails ${fleet.mail.to} about logins, failures, and anything that needs attention, and sends the daily report.`,
      use: [{ cmd: "archon notify status", why: "what was sent, and anything waiting" }],
    });
  }

  // ------------------------------------------------------------------- work
  if (server) {
    add({
      id: "repository",
      category: "work",
      title: "Changes come from the repository",
      what:
        "Everything about this server is described in the fleet's repository. To change it, change the repository and push: every 15 minutes the server pulls it and applies it. Installing things by hand is undone or lost at the next reinstall.",
      use: [
        { cmd: "archon update", why: "pull and apply now, instead of waiting" },
        { cmd: "archon apply --check", why: "what applying would change" },
      ],
      links: [{ label: `The repository: ${fleet.repository.slug}`, href: repo }],
    });
    add({
      id: "agent",
      category: "work",
      title: "An AI assistant can help, within limits",
      what:
        `An agent (any MCP client) on a workstation can look after this server through Archon's commands, over SSH, within limits this server enforces. Nothing AI-related runs on the server.`,
      links: [{ label: "How to set it up", href: name ? `https://${name}/#agent` : "/#agent" }],
      guide: "agent",
    });
  }
  return items;
}

/** How to reach this server from an AI agent (MCP over SSH), and the Git loop. */
export interface AgentSetup {
  /** The MCP server's name, as the repository's .mcp.json calls it. */
  server: string;
  /** ssh's target: ops@<this server>. */
  target: string;
  /** ssh's arguments for any MCP client (stdio). */
  args: string[];
  /** The tier the server serves (it refuses the rest; destructive never). */
  tier: string;
  /** The URL to clone the fleet repository. */
  cloneUrl: string;
  /** The fleet repository's page. */
  repoUrl: string;
  /** owner/name. */
  slug: string;
}

/** How an MCP client reaches this server. */
export function agentSetup(plan: HostPlan): AgentSetup {
  const { fleet, host } = plan;
  // The same target stolos build writes into .mcp.json (render/agent.ts).
  const target = `ops@${host.dnsName ?? host.ip ?? host.name}`;
  return {
    server: `archon-${fleet.id}-${host.name}`,
    target,
    args: ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", target],
    tier: fleet.mcp?.maxTier ?? "mutate",
    cloneUrl: `https://github.com/${fleet.repository.slug}.git`,
    repoUrl: `https://github.com/${fleet.repository.slug}`,
    slug: fleet.repository.slug,
  };
}

/** The steps, as plain data: [title, explanation, commands]. */
export function agentSteps(a: AgentSetup): Array<{ title: string; text: string; cmds: string[] }> {
  const folder = a.slug.split("/")[1];
  return [
    {
      title: "Get the repository on your own computer, and keep it current",
      text:
        "The agent works in your copy of the fleet's repository, on your computer (not on this server). Pull before every session: it brings other people's changes and what the servers recorded.",
      cmds: [`git clone ${a.cloneUrl}`, `cd ${folder}`, "git pull"],
    },
    {
      title: "Check that your SSH key reaches the server",
      text:
        `The agent connects as ops with your SSH key (one listed in the fleet's model). This should connect and wait silently: that is the server's MCP endpoint. Press Ctrl+C.`,
      cmds: [`ssh -T ${a.target}`],
    },
    {
      title: "Connect your MCP client",
      text:
        `Any agent that speaks MCP works. In the repository folder, its .mcp.json already lists ${a.server}; AGENTS.md there gives the operating rules. Elsewhere, add a stdio MCP server whose command is ssh with these arguments:`,
      cmds: [`ssh ${a.args.join(" ")}`],
    },
    {
      title: "Ask in plain words",
      text: `For example: "Is ${
        a.server.replace(/^archon-/, "")
      } healthy?", "What would change if it updated now?", "Summarize today's daily report." The server answers through archon commands up to the ${a.tier} tier, refuses anything above it, never runs destructive commands, and logs every call (journalctl -t archon-mcp).`,
      cmds: [],
    },
    {
      title: "Keep the fleet up to date through Git",
      text:
        "To change a server, the agent changes the repository, never the server: it edits the model, runs the build to validate it, shows you what each server would change, and commits. You review and push: pushing to main is the approval. Every server applies main within 15 minutes, or at once when the agent runs archon_update on it. Then pull again to see what the servers recorded.",
      cmds: [
        "deno task stolos apply --check   (what would change)",
        'deno task stolos apply -m "<what changed>"',
        "deno task stolos update",
      ],
    },
  ];
}
