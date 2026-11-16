/**
 * # The agent layer: managing servers from your workstation
 *
 * No AI agent runs on a server, and no server holds an AI credential (constitution Article 17, spec
 * 030). An agent (the MCP client you choose) runs on your workstation, in this repository's checkout,
 * and reaches each server through **MCP over SSH**:
 *
 * ```
 * your workstation (BOOTPC, or Ubuntu on WSL)             a server (e.g. alpha)
 * ────────────────────────────────────────────             ──────────────────────
 * C:\archon (or /srv/archon)   your MCP client             sshd
 *   .mcp.json  archon-alpha: ssh ops@alpha.localdomain ─▶  ops' authorized_keys:
 *                                                            restrict,command="... archon mcp --max-tier mutate"
 *                                                            │
 *                                                            ▼
 *                                                          archon mcp: only tools up to the tier;
 *                                                          each call journaled (tag archon-mcp)
 * ```
 *
 * - **The server enforces the limit.** ops' keys may only start `archon mcp --max-tier <tier>`, with
 *   `restrict` (no shell, no forwarding, no other command). The tier is `fleet.mcp.maxTier` in
 *   `fleets/<fleet>/fleet.ts`: `read`, `repo`, or `mutate` (the default). Destructive commands are
 *   never served. A tool above the tier is not listed, and a call to it is refused.
 * - **Your client decides what it asks first.** The engine renders no agent's settings: whatever
 *   your client allows, the server refuses anything above its tier.
 * - **Everything is recorded.** Each call is in the server's journal (`journalctl -t archon-mcp`),
 *   with your workstation's address, and in its provenance (agent `mcp`). Each new SSH session as ops
 *   also arrives as a login email (spec 025), at most once an hour per address.
 *
 * ## Set it up
 *
 * 1. **Your key.** ops accepts the keys in `fleet.admin.github.sshKeys` (or, to use separate keys for
 *    the agent, `fleet.mcp.keys`). The workstation's SSH key must be one of them; check with
 *    `ssh -o BatchMode=yes ops@alpha.localdomain` (it waits for MCP input: press Ctrl+C).
 * 2. **Your MCP client.** Install and sign in to the one you choose; the engine installs none.
 * 3. **Run it in the checkout.** `bun run stolos build` writes `.mcp.json` there, one server per
 *    host (`archon-<fleet>-<host>`); the client finds them in the project's `.mcp.json`.
 *
 * ## Use it
 *
 * Ask in plain words; the agent picks the tools:
 *
 * - "Is alpha healthy?" (`archon_verify`, `archon_capture`, the `archon://reports/...` resources)
 * - "What would change if alpha converged now?" (`archon_apply` with `check`)
 * - "Read today's daily report for alpha and tell me what needs attention."
 * - "Why did the reconcile timer fail last night on alpha?" (`archon_observe`, the journal)
 * - "Add ripgrep to the tools" (the spec loop in [`AGENTS.md`](../../../AGENTS.md): a spec, the model,
 *   `bun run stolos build`, a commit you approve, then `archon_update` on each server, or the
 *   reconcile timer)
 *
 * Model changes happen in your checkout and reach the servers through `main`; MCP is for looking at
 * servers and for running `archon` on them. Anything the tier does not allow, you run yourself over
 * SSH as the admin.
 *
 * ## Choosing the tier
 *
 * | `fleet.mcp.maxTier` | The agent can                                                 |
 * | ------------------- | ------------------------------------------------------------- |
 * | `read`              | look: verify, capture, apply with check, reports, logs        |
 * | `repo`              | also change the repository (signers, hosts)                   |
 * | `mutate` (default)  | also converge, restart, update, back up (each asks you first) |
 *
 * Change it in `fleets/<fleet>/fleet.ts`, then `bun run stolos apply` (build, a signed commit, the
 * push); every server rewrites ops' keys at its next converge.
 *
 * ## Another agent, or a local model
 *
 * The `.mcp.json` entries are plain SSH commands, so any MCP-capable agent can use them, and the
 * server's limits apply whichever one connects. Pointing the agent at a local model (a gateway and
 * Ollama) is a workstation choice; servers do not change for it.
 *
 * @module
 */

export {};
