/**
 * # Your Archon server: a guide for newcomers
 *
 * This server is managed by Archon. That changes how you work on it, in a good way: the server is
 * described in one place, the fleet's repository on GitHub, and it keeps itself matching that
 * description. This guide explains what that means for you, what you'll find on the server, and how to
 * do the common things.
 *
 * ## The one idea to remember
 *
 * **Changes go in the repository, not on the server.** Every 15 minutes the server pulls the
 * repository and applies it. If you install something by hand, or edit a settings file under `/etc`,
 * it may be undone, and it is certainly gone the next time the server is set up again (which is
 * routine). So:
 *
 * - to try something out, use a container (below): it leaves the server untouched;
 * - to keep something, describe it in the repository, commit, and push.
 *
 * Pushing to the repository is how a change is approved.
 *
 * ## First steps
 *
 * 1. **Log in** from a terminal on your computer: `ssh <you>@<server>` (the welcome page shows the
 *    exact command).
 * 2. **Check it's healthy**: `archon verify` runs every check and shows a fix for anything that fails.
 * 3. **See what's here**: `archon guide` lists what is installed and how to use each part. The welcome
 *    page (open the server's name in a browser) shows the same, with links.
 * 4. **Look around in your browser**: Cockpit, at `https://cockpit.<server>`, with your own username
 *    and password.
 * 5. **Run an app** in a container (below).
 *
 * ## Manage this server with an AI agent
 *
 * An AI coding agent on your own computer (Claude Code, Codex, or any agent that speaks MCP) can check
 * on the server, explain what it finds, and make changes for you, through the repository. Nothing
 * AI-related runs on the server, and the server itself limits what an agent may do.
 *
 * 1. **Get the repository on your computer** and pull before every session:
 *    `git clone https://github.com/<owner>/<repo>.git`, then `git pull`.
 * 2. **Check your SSH key reaches the server**: `ssh -T ops@<server>` connects and waits silently
 *    (that is the server's MCP endpoint); press Ctrl+C.
 * 3. **Claude Code**: run `claude` in the repository folder; its `.mcp.json` already lists
 *    `archon-<server>`. Approve it once; `/mcp` shows it connected.
 * 4. **Codex**: add the server to `~/.codex/config.toml` (the welcome page shows the exact lines),
 *    then run `codex` in the repository folder; `AGENTS.md` there points it at the rules. **Any other
 *    MCP client**: a stdio server whose command is `ssh -T -o BatchMode=yes ops@<server>`.
 * 5. **Ask in plain words**: "Is it healthy?", "What would change if it updated now?", "Summarize
 *    today's daily report."
 * 6. **Keep the fleet up to date through Git**: the agent changes the repository, never the server. It
 *    edits the model, runs `bun run stolos build` to validate it, shows what each server would
 *    change; you review it and send it with `bun run stolos apply`. Pushing to main is the approval: every server
 *    applies it within 15 minutes, or at once when the agent runs `archon_update`. Then `git pull` to
 *    see what the servers recorded.
 *
 * The server answers through archon commands up to the fleet's tier, refuses anything above it, never
 * runs destructive commands, and logs every call (`journalctl -t archon-mcp`). More in the
 * [agent guide](../mcp/mod.ts).
 *
 * ## Your shell
 *
 * When you log in you land in **fish**, a friendly shell: it suggests commands as you type (press → to
 * accept), Tab completes names, and ↑ searches what you typed before. The prompt shows the server's
 * name, your folder, git status, and how Archon's last run went. Type `bash` if you prefer bash for a
 * moment.
 *
 * Modern comforts come with it: `ls`, `ll`, and `tree` show colors and git status, `cat` shows syntax
 * colors, `z <part of a name>` jumps to a folder you use, Ctrl+R searches what you typed before, and
 * Ctrl+T finds files. They come from one line in your shell's settings (`archon shell status` shows
 * it). If your prompt shows boxes instead of icons, your computer lacks a Nerd Font: install one, or
 * choose the plain prompt with `set -Ux ARCHON_PROMPT plain`.
 *
 * **tmux** keeps your work alive if the connection drops: run `tmux`, and after reconnecting,
 * `tmux attach`.
 *
 * ## Your settings (dotfiles)
 *
 * Your shell, prompt, tmux, and git settings are files in your home folder whose names start with a
 * dot. Archon manages them with **chezmoi**, from the repository, in layers: settings for everyone,
 * for this server, and for you. To find out where one comes from, run `archon dotfiles`; to see what
 * the next update would change, `chezmoi diff`.
 *
 * For tweaks on this machine only, use `~/.bashrc.local` or `~/.config/fish/local.fish`: Archon never
 * touches them. Don't run `chezmoi add` or `chezmoi edit` here. The full story is in
 * `man archon-dotfiles`.
 *
 * ## Apps and containers
 *
 * A **container** is an app packaged with everything it needs. Podman runs them here, and any
 * container with the label `traefik.enable=true` gets its own secure web address at once:
 *
 * ```sh
 * sudo podman run -d --name hello --label traefik.enable=true docker.io/traefik/whoami
 * ```
 *
 * Then open `https://hello.<server>`. `sudo podman ps` lists what runs, `sudo podman logs hello` shows
 * its output, and `sudo podman rm -f hello` removes it. Who reaches them is the router's decision (the
 * machine restricts no network).
 *
 * ## Opt-in services and containers
 *
 * Some services are on every server but **off** until an operator turns one on: SMB file sharing
 * (`archon fs smb`), PostgreSQL (`archon pg`), and S3 object storage (`archon fs s3`, a container).
 * Once on, each stays on (reboots and reinstalls included) until an operator turns it off.
 * `archon opt-in` lists them, on or off, and who turned each on and when. Each uses your Linux
 * account: your Linux username and password for SMB and PostgreSQL, and your username (with a key only
 * you can read) for S3: its web console signs in with that key (`archon fs s3 key --show`), not your
 * Linux password.
 *
 * ## Watching the server
 *
 * - **Cockpit** (in your browser): health, services, logs, metric history, and a terminal.
 * - **btop** (in the terminal): processes, CPU, memory, disks, and network, live.
 * - `journalctl -f`: the system's log as it happens.
 * - A health report arrives by email every morning.
 *
 * ## What happens by itself
 *
 * - Security updates install every day; if one needs a restart, the welcome page and Cockpit say so.
 * - A firewall lets in only the ports the server uses (SSH, the web, Cockpit), each open to every
 *   network: which networks reach the server is the router's decision.
 * - The server's data is backed up every night.
 * - Every change to the system's settings is recorded, with who made it: `sudo etckeeper vcs log`.
 * - Logins, failures, and anything that needs attention are emailed to the fleet's mailbox.
 *
 * ## Durable or ephemeral
 *
 * Every source of people's data (a PostgreSQL database, S3 buckets, SMB shares, a guest) is marked
 * **durable** or **ephemeral** by the operator who turns it on: there is no default (constitution
 * Article 23). Durable means its data exists nowhere else: it is archived every night, and nobody can
 * reinstall or wipe the server without repeating its name. Ephemeral means losing it is harmless. A
 * server holding anything durable is durable; `archon data` says which this one is and why, and the
 * login banner, the welcome page, and the prompt show it too. Your home directory is not kept across a
 * reinstall, on any server: keep data in a share, a bucket, or a database.
 *
 * ## Words you'll see
 *
 * - **SSH**: how you log in from a terminal, securely, with a key or a password.
 * - **HTTPS** and **certificate**: the padlock in your browser; the certificate proves the server is
 *   who it says it is, and renews by itself.
 * - **Repository**: the folder on GitHub that describes every server.
 * - **Converge**: the server making itself match the repository.
 * - **Local networks**: the networks at this site, not the internet.
 * - **Opt-in service** (or **opt-in container**): on every server, off until an operator turns it on,
 *   then on until an operator turns it off.
 * - **Durable** and **ephemeral**: data that exists nowhere else, and data whose loss is harmless (a
 *   server is durable when it holds anything durable).
 *
 * ## Getting help
 *
 * `archon verify` tells you what's wrong and how to fix it. `man archon` lists every command;
 * `man archon-<command>` explains one. The other guides: [dotfiles](../dotfiles/mod.ts),
 * [HTTPS and containers](../web/mod.ts), [day-to-day work](../commands/mod.ts), and [AI agents](../mcp/mod.ts).
 *
 * @module
 */

export {};
