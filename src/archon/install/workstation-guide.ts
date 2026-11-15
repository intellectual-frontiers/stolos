/**
 * # Your PC's Ubuntu (WSL) as a workstation
 *
 * Ubuntu on WSL (Windows Subsystem for Linux) can be an Archon **workstation**: it gets what makes the
 * hosts pleasant to work on, managed the same way, and nothing that belongs to a server.
 *
 * | A workstation gets                                                                                                              | A workstation does not get                       |
 * | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
 * | the tools at their newest releases (git and fish from their PPAs, gh from GitHub's repository, Bun, chezmoi, oh-my-posh, tmux) | an installer, netplan, or anything about booting |
 * | your dotfiles: fish with the Archon prompt, tmux, git with your GitHub identity                                                 | the firewall or SSH server hardening             |
 * | Claude Code, for your own account: the agent layer, which reaches the servers over MCP ([agent.md](agent.md))                   | the `ops` account                                |
 * | the `archon` command, its man pages and completions                                                                             | the converge, capture, and backup timers         |
 * | Ubuntu's daily security and stable updates, and the weekly tools sync                                                           | a deploy key or pushes of recorded state         |
 * | local observability: journald, PCP, btop, the OpenTelemetry Collector, `archon observe`                                         |                                                  |
 *
 * The workstation is described in the repository like a host (`fleets/<fleet>/hosts/<name>/host.ts`,
 * with `kind: "workstation"`), so the same spec loop applies; the boot machine never installs it.
 *
 * ## Set it up (once)
 *
 * **1. Install Ubuntu 26.04 LTS** from the Microsoft Store, or in PowerShell (`wsl --list --online`
 * shows the exact name):
 *
 * ```powershell
 * wsl --install -d Ubuntu-26.04
 * ```
 *
 * Open it from the Start menu (or a Windows Terminal tab) and create your account when asked. Use the
 * same name as `user` in `fleets/<fleet>/fleet.ts` if you like; any name works.
 *
 * **2. Make sure systemd runs.** Ubuntu's WSL images turn it on. To check, in Ubuntu:
 * `ls /run/systemd/system`. If that fails:
 *
 * ```sh
 * printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
 * ```
 *
 * then in PowerShell `wsl --shutdown`, and open Ubuntu again.
 *
 * **3. Get the repository and Bun**, in Ubuntu:
 *
 * ```sh
 * sudo apt update && sudo apt install -y git gh unzip
 * gh auth login --web --git-protocol https
 * gh auth setup-git
 * sudo mkdir -p /srv/archon && sudo chown "$USER": /srv/archon
 * git clone https://github.com/example/fleet.git /srv/archon
 * curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"
 * exec bash
 * ```
 *
 * The checkout must be `/srv/archon` (the `archon` command runs from there) and belongs to you. The
 * Bun installed here only starts things off: Archon installs the pinned Bun in `/usr/local/bin`.
 *
 * **4. Set it up as a workstation:**
 *
 * ```sh
 * cd /srv/archon
 * bun run stolos workstation add
 * ```
 *
 * It checks that this is Ubuntu 26.04 with systemd and the checkout in `/srv/archon`, writes
 * `fleets/<fleet>/hosts/<name>/host.ts` (the name defaults to the PC's hostname; pass one to choose:
 * `workstation add pc`), then asks for your password once and applies: packages and PPAs, Archon's
 * groups, the tools, Claude Code, your dotfiles, and `archon verify`. Commit the new file:
 *
 * ```sh
 * git add -A; git commit -m "020-workstation: add workstation pc"; git push
 * ```
 *
 * **5. Open a new Ubuntu tab.** You are in fish with the Archon prompt, which starts with the
 * machine's name; the tab's title reads `fish in <you>@<machine>`. Sign Claude Code in once with
 * `claude`; in `/srv/archon` it reaches every server through MCP ([agent.md](agent.md)).
 *
 * Windows Terminal needs a Nerd Font for the prompt's icons (the same one you use for the hosts).
 *
 * ## Afterwards
 *
 * ```sh
 * sudo archon update        # pull from GitHub, apply, tools, dotfiles, verify
 * archon verify             # every check, with a fix for anything failing
 * sudo archon tools sync    # upgrade the release-binary tools now
 * ```
 *
 * Ubuntu's own updates and the PPA tools (git, fish, gh) update daily while WSL runs; WSL stops when
 * idle, so `sudo archon update` now and then picks up anything missed. Edit the dotfiles in `home/`,
 * or the workstation's file in `fleets/<fleet>/hosts/`, then `sudo archon update`, as on a host.
 *
 * ## Troubleshooting
 *
 * | Symptom                                                               | Fix                                                                                       |
 * | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
 * | `this is Ubuntu 24.04, the fleet is Ubuntu 26.04`                     | install Ubuntu 26.04 LTS from the Microsoft Store (WSL keeps several side by side)        |
 * | `systemd is not running here`                                         | step 2                                                                                    |
 * | `the checkout is /home/...; the archon command runs from /srv/archon` | clone to `/srv/archon` (step 3)                                                           |
 * | `sudo archon update` cannot pull                                      | `gh auth status`, then `gh auth setup-git`                                                |
 * | The prompt shows boxes instead of icons                               | set a Nerd Font in Windows Terminal (Settings, the Ubuntu profile, Appearance, Font face) |
 *
 * ## The prompt's font, and VS Code
 *
 * The colorful prompt draws its icons with a Nerd Font. On WSL the font belongs to Windows: in
 * PowerShell, `winget install JanDeDobbeleer.OhMyPosh`, then `oh-my-posh font install meslo`, then in
 * Windows Terminal choose Settings, Ubuntu, Appearance, Font face: MesloLGM Nerd Font. On an Ubuntu
 * desktop workstation, `oh-my-posh font install meslo` installs it for your account; choose it in your
 * terminal's preferences. Without the font, use the plain prompt: `set -Ux ARCHON_PROMPT plain`
 * (fish).
 *
 * VS Code is installed only on a workstation with a graphical desktop (`desktop: true` in its host
 * model, set by `stolos workstation add`), from Microsoft's apt repository. On WSL, use VS Code on
 * Windows with its WSL extension (`code .` here opens it); for servers, VS Code's Remote - SSH
 * extension.
 *
 * @module
 */

export {};
