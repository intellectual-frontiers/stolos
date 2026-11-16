/**
 * # Remote access to the Stolos Console
 *
 * `bun run stolos console` answers on 127.0.0.1 only. `bun run stolos console --lan` (or
 * `stolos: { console: { lan: true } }` in fleet.ts) also serves it over HTTPS on this PC's LAN
 * address, so a phone or a laptop on the site's network can open it (spec 100):
 *
 * | Address                                  | What                                       |
 * | ---------------------------------------- | ------------------------------------------ |
 * | `https://stolos.lab.example.net`         | the primary controller                     |
 * | `https://alpha-pc.stolos.lab.example.net` | one controller by its name (`<pc>.stolos`) |
 *
 * The first time, it proposes the names under the fleet's `web.domain` and writes them into
 * fleet.ts (send them: `bun run stolos apply`). It keeps their A records in Cloudflare (this PC's
 * LAN address, not proxied), with the token of `bun run stolos boot web-setup`, and gets a Let's
 * Encrypt certificate through the DNS challenge, kept in the vault (`console/tls.json`, in every
 * backup) and renewed 30 days before it expires. It never listens on a public address (Article 28):
 * from outside the LAN, use a zero trust mesh network (`bun run stolos mesh`).
 *
 * ## Signing in from a device
 *
 * There is no password. A device makes a passkey, and a fleet signer approves it with a signed
 * commit, as every other decision:
 *
 * ```mermaid
 * sequenceDiagram
 *   participant D as A new device
 *   participant C as The controller
 *   participant S as A signer's PC
 *   participant G as GitHub
 *   D->>C: pick your name, name the device, create a passkey
 *   C->>D: a code (15 minutes)
 *   S->>C: bun run stolos devices approve CODE (the public fields)
 *   S->>G: access.ts, in a commit signed by the signer
 *   C->>G: every 30 s: the tip signed by a signer?
 *   C->>D: approved: sign in with the passkey
 * ```
 *
 * 1. Open `https://stolos.lab.example.net`, choose **Register this device**: pick your signer name,
 *    name the device, and let the browser create the passkey. The page shows a code.
 * 2. A signer approves it: on the controller's **Remote Access** page (**Approve**; the passphrase
 *    is asked on the page), or on their own PC:
 *    `bun run stolos devices approve WDJB-MJHT --controller https://stolos.lab.example.net`. Either
 *    writes the device into `fleets/<fleet>/access.ts` and sends it with `stolos apply`, signed by
 *    their key.
 * 3. Once the controller reads that signed commit from GitHub, the waiting page offers **Sign in
 *    with your passkey**.
 *
 * ## Who may do what
 *
 * A signer whose key is on the controller (its daily key, or a recovery key in its vault) may run
 * every command the console offers. Every other signer looks: each page, and the read-only
 * commands; a command that changes the repository answers with the line to run on their own PC.
 *
 * ## Keeping it reviewed
 *
 * | Where                       | What                                                                |
 * | --------------------------- | ------------------------------------------------------------------- |
 * | Remote Access page          | names, certificate, every device and its last sign-in, codes, refusals |
 * | `bun run stolos devices`    | the devices (access.ts) and their last sign-in here                 |
 * | `bun run stolos devices revoke <id>` | remove one (signed); refused once the controller reads it   |
 * | the fleet's mailbox         | each registration, approval, denial, revoke, five failed sign-ins; a daily digest |
 * | `bun run stolos boot doctor` | the listener, the certificate's expiry, devices unused for 90 days, the firewall |
 *
 * `access.ts` is a decision, not a record: `stolos update` never sends it by itself (the commands
 * that change it send it at once, signed by whoever decided).
 *
 * @module
 */

export {};
