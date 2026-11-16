/**
 * # PostgreSQL databases
 *
 * A server can keep several PostgreSQL instances side by side, each with a name, a major version, its
 * own port, its own data directory, its own systemd unit, and its own log (spec 038). Each instance is
 * one of Ubuntu's PostgreSQL "clusters" (`pg_lsclusters` lists them), named `<version>/<name>`. The
 * default instance is `prime`, PostgreSQL 18.
 *
 * PostgreSQL is an **opt-in service**: every server has Ubuntu's PostgreSQL tooling and no database,
 * and nothing runs until an operator turns it on (`archon opt-in` lists every opt-in service and
 * container). Instances are **private** to the server until an operator publishes one for the local
 * networks.
 *
 * Every PostgreSQL login is a Linux account (spec 039). People use their own account; apps run as
 * their own service account (`s-<app>`); nobody needs a password on the server.
 *
 * ## Turn it on (an operator, once per server)
 *
 * ```sh
 * archon pg on --durable      # or --ephemeral: there is no default
 * ```
 *
 * `--durable` or `--ephemeral` is required, with no default (constitution Article 23, spec 044):
 * **durable** when its data exists nowhere else (it is archived nightly, and nothing reinstalls or
 * wipes this server without `--confirm-destroy`, typed by a person); **ephemeral** when losing it is
 * harmless. `archon data` shows the server's class and why; `archon data set` changes a choice later.
 *
 * `archon pg on` unmasks and starts `postgresql.service`, creates or starts every instance in the
 * model, and records the decision in `the host's own archon.sql (opt-in pg)`. It stays on this machine
 * (spec 048), so a reinstall keeps it on. `archon pg off` masks `postgresql.service`, which stops
 * every instance and keeps it stopped, a reboot included, until `archon pg on` (data is kept, and so
 * is its choice).
 *
 * ## Use one (anyone with an account)
 *
 * ```sh
 * psql service=prime        # you, as yourself, over the server's socket: no password
 * archon pg list            # every instance: version, port, status
 * ```
 *
 * `psql service=prime` works for everyone: the server lists each instance in its system-wide service
 * file (`/etc/postgresql-common/pg_service.conf`). Your PostgreSQL role is your Linux username, and
 * the server's kernel vouches for who you are (`peer`), so there is no password to type or store.
 *
 * `archon pg connect prime --write` puts a `[prime]` service in your own `~/.pg_service.conf`
 * (readable by you only) that also opens the database you have access to. It changes nothing else in
 * that file, and no dotfile layer manages it.
 *
 * ## Your connections, and how to reach an instance
 *
 * Two read-only commands (also tools for an AI agent over MCP) show what your PostgreSQL client would
 * use. Neither ever shows a password: passwords stay in `~/.pgpass`, where libpq reads them.
 *
 * ```sh
 * archon pg connections          # your password file and service files, as libpq reads them
 * archon pg show prime           # how to reach prime: a libpq connection string
 * archon pg show prime --form url
 * archon pg show prime --form env       # PG* settings to export
 * archon pg show prime --form service   # a section for ~/.pg_service.conf
 * archon pg show prime --remote         # the published name, for another machine
 * archon pg show prime --form external  # everything a client on another machine needs
 * archon pg show prime --form jdbc --remote  # for DBeaver, IntelliJ, and other Java tools
 * archon pg show prime --form npgsql --remote   # .NET, Power BI, Excel's Power Query
 * archon pg show prime --form odbc --remote     # Excel, Access, Tableau, LibreOffice (psqlODBC)
 * archon pg show prime --form dotenv --remote   # DATABASE_URL for app frameworks
 * archon pg show prime --form pgadmin --remote > servers.json   # pgAdmin, Import/Export Servers
 * archon pg show prime --form ca --remote > root.crt            # the root certificate, as libpq's file
 * archon pg test prime                  # connect as an external client would, with your password
 * ```
 *
 * `archon pg connections` lists every entry of your password file (`~/.pgpass`, or `PGPASSFILE`) with
 * its host, port, database, and user, which service it serves, and whether libpq can use it; and every
 * section of your service files (`~/.pg_service.conf`, or `PGSERVICEFILE`, then the server's
 * `/etc/postgresql-common/pg_service.conf`), with the password-file line libpq would use for it. It
 * names each problem and why:
 *
 * - **a password file that group or others can access:** libpq ignores the whole file
 *   (`chmod 600 ~/.pgpass`);
 * - **an entry without five fields** (`host:port:database:user:password`): libpq skips it, and its
 *   fields are not shown, since a password may sit in any of them;
 * - **an entry no service uses**, and why when it nearly matches: a service whose socket directory is
 *   not the default (`/var/run/postgresql`) is looked up under that directory's path, not `localhost`;
 * - **a service that holds a password:** it belongs in `~/.pgpass`;
 * - **a network service without `sslmode=verify-full`:** it could fall back to plain text or skip
 *   checking the server.
 *
 * `archon pg show NAME` works for an instance Archon keeps, any cluster on the server
 * (`archon pg list` shows them, Archon's or not), or a section of your service files. On the server it
 * is the socket directory and you as yourself (peer, no password); over a network it is always
 * `sslmode=verify-full` with the system's certificate authorities (`sslrootcert=system`), never a
 * fallback to plain text. The forms are `conninfo` (the default), `url`, `env`, `service`, `jdbc`,
 * `npgsql`, `odbc`, `dotenv`, `pgadmin`, `ca`, and `external`; anything else is a usage error that
 * lists them. `external` is for a client on another machine, once the instance is published: the
 * published name, the server's IP address (as `hostaddr`, to connect without DNS while TLS still
 * checks the name), port, database, user, `sslmode=verify-full` and `sslrootcert=system` (libpq 16 or
 * newer; an older client points `sslrootcert` at `/etc/ssl/certs/ca-certificates.crt`), where the
 * password comes from (yours: your Linux password; a service account's: its own `~/.pgpass` line),
 * then the other forms filled in for that client.
 *
 * Which form a client needs depends on the library inside it, because each reads the TLS settings its
 * own way:
 *
 * | Client                                                                                    | Library                 | Form                                               |
 * | ----------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------- |
 * | psql, pgAdmin, Python (psycopg, SQLAlchemy, Django), Ruby (Rails), Go (pgx), PHP, Grafana | libpq                   | `conninfo`, `url`, `env`, `service`, `dotenv`      |
 * | DBeaver, IntelliJ, DataGrip, Java apps                                                    | pgJDBC                  | `jdbc`                                             |
 * | .NET, Power BI, Excel's Power Query                                                       | Npgsql                  | `npgsql` (it trusts the Windows certificate store) |
 * | Excel's classic import, Access, Tableau, LibreOffice                                      | psqlODBC (libpq inside) | `odbc`                                             |
 * | Node (pg, Drizzle, Knex), Prisma                                                          | their own               | the commented lines in `dotenv`                    |
 *
 * **Windows and libpq.** libpq on Windows (inside pgAdmin and psqlODBC) has no system certificate
 * store, so `sslrootcert=system` fails there. It does read libpq's own root certificate file when
 * `sslrootcert` is not given: save `archon pg show prime --form ca --remote` as
 * `%APPDATA%\postgresql\root.crt` (or `~/.postgresql/root.crt` elsewhere). The `pgadmin` and Windows
 * `odbc` forms rely on that file. `ca` fetches the chain the server presents (with PostgreSQL's own
 * STARTTLS, so it works from any machine), finds the root among the system's trusted roots, and checks
 * that it really signs the chain; it prints the root's subject and fingerprint on standard error.
 *
 * `jdbc` is for tools built on the PostgreSQL JDBC driver (DBeaver, IntelliJ, Java apps), which do not
 * use libpq: pgJDBC reads `sslrootcert` as a file name, so `sslrootcert=system` fails there ("Could
 * not open SSL root certificate file system"). Its URL keeps `sslmode=verify-full` and trusts Java's
 * own certificate store instead (`sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory`). If the tool
 * then says "PKIX path building failed", its Java does not know the certificate's root: in DBeaver,
 * Window, Preferences, Connections, Use Windows trust store. The password goes in the tool's own
 * password field. Use it in a program as `psql "$(archon pg show prime)"`, or
 * `eval "$(archon pg show prime --form env)"`.
 *
 * ## Who may use what
 *
 * The model says, for each database, who owns it, who may write, and who may read. Each name is a
 * person in the model, a service account, or `@group` (a Linux group's members):
 *
 * ```ts ignore
 * pg: { instances: [{ ...PRIME, databases: [
 *   { name: "app1", owner: "s-app1", write: ["s-app2"], read: ["@analysts"] },
 * ] }] },
 * ```
 *
 * - **Owner**: owns the database and its `public` schema: creates and changes tables.
 * - **Write**: reads and writes every table, now and later (`app1_rw`).
 * - **Read**: reads every table, now and later (`app1_ro`).
 * - **Everyone else**: cannot connect to it.
 *
 * Every person on the server has a role of their own name; fleet admins may also create databases and
 * watch and stop sessions (`pg_monitor`, `pg_signal_backend`). **Nobody is a superuser** except
 * `postgres`.
 *
 * ## Apps: service accounts
 *
 * An app gets its own Linux account, the same on every server, declared once in the fleet
 * (`fleets/<fleet>/fleet.ts`):
 *
 * ```ts ignore
 * services: [{ name: "s-app1", uid: 851, description: "what the app is" }],
 * ```
 *
 * The account has no password and no shell. Run the app as that account (`User=s-app1` in its systemd
 * unit, or a rootless container started by it): it reaches `service=prime` as the role `s-app1`, over
 * the socket, with no password.
 *
 * For an app on another machine, publish the instance; the service account then also has a generated
 * password, readable only by itself (`archon pg connect prime --remote --write`, run as that account,
 * puts it in its own `~/.pgpass`).
 *
 * ## The superuser, and acting as an app
 *
 * ```sh
 * sudo -u postgres psql --cluster 18/prime    # the superuser (operators; your own password)
 * sudo -u s-app1 psql service=prime           # see exactly what the app sees
 * ```
 *
 * Both go through sudo, so every use is in sudo's log. `postgres` is refused over any network.
 *
 * ## Your password, for a published instance
 *
 * On a published instance, you sign in from another machine with your **Linux password**. PostgreSQL
 * learns it the same way Samba does (spec 037): whenever you type it on the server (logging in with a
 * password, `sudo`, Cockpit, `passwd`), PAM hands it to Archon, which stores a SCRAM verifier of it
 * (never the password) in each published instance where you have a role. A private instance holds no
 * person's password at all.
 *
 * **Initialize it once.** Your password reaches PostgreSQL only when you type it on the server after
 * the instance is published. If you log in with an SSH key and sudo remembers you, nothing has been
 * typed yet, so a client gets "password authentication failed". On the server, once:
 *
 * ```sh
 * sudo -k && sudo -v      # forget sudo's cached credentials, then type your password
 * ```
 *
 * (`sudo -v` alone does not ask while sudo still remembers you.) Every connection detail Archon prints
 * for a published instance repeats this. The journal shows each sync (never the password):
 * `journalctl -t archon-pg`.
 *
 * **Test it like an external client.** `archon pg test prime` asks for your password (not echoed, not
 * stored) and connects to the published name, never localhost, over TLS with the server's certificate
 * verified. It reports who you are, the addresses, and the TLS version, or the likely cause and its
 * fix: the password (initialize it, above), the certificate, an address the instance does not admit
 * (not published), a name that does not resolve, or nothing answering (the firewall or the router). On
 * the server itself the firewall is not crossed; run it from your workstation to test the whole path.
 *
 * ## Other tools
 *
 * Two terminal UIs, already connected (every host has them):
 *
 * ```sh
 * archon pg admin-tui           # rainfrog: browse tables, run queries, edit rows
 * archon pg observe-tui         # pgcenter top: live activity, statements, waits, CPU, memory, disks
 * archon pg admin-tui --remote  # the published name over TLS, as from another machine
 * ```
 *
 * Each takes NAME (default `prime`) the way `archon pg show` does: an instance Archon keeps, any
 * cluster on this host, or a section of your service files. On the server it connects through the
 * socket as you (peer, no password). With `--remote`, to the published name with `sslmode=verify-full`
 * against the system's trusted roots. A password never goes on the tool's command line (other accounts
 * can see those): rainfrog asks for one when it needs it; pgcenter uses your `~/.pgpass` line, or asks
 * here and passes it in its own environment only. Both need a terminal, so they are not MCP tools.
 * pgcenter's views need `pg_monitor`, which every person has (spec 039).
 *
 * ## The psql prompt
 *
 * The fleet's `~/.psqlrc` (from `home/dot_psqlrc`) shows, on the first line, the instance, its
 * environment (red for production) and whether it is protected, your role and database, the host and
 * port, the backend PID, and a red `*` while a transaction is open. The second line is the arrow, red
 * when you are the superuser. Tables have unicode borders, NULL shows as ∅, every query is timed, and
 * a typo inside a transaction does not lose the transaction.
 *
 * On a **protected** database (production, unless the model says otherwise) psql turns AUTOCOMMIT off
 * and says so in red: nothing is saved until you type `COMMIT`, and `ROLLBACK` undoes it.
 *
 * ## Operators: instances
 *
 * Instances come from the model (`pg: { instances: [...] }` in `fleets/<fleet>/hosts/<host>/host.ts`)
 * and from the host's record (`the host's own archon.sql (opt-in pg)`). While PostgreSQL is on, every
 * apply, including the 15-minute reconcile, keeps both.
 *
 * ```sh
 * archon pg ensure lab --version 17     # another instance (recorded on the host)
 * archon pg status prime
 * archon pg who prime                   # roles, the Linux accounts behind them, and any problem
 * archon pg start|stop|restart|reload prime
 * archon pg maintain prime              # VACUUM ANALYZE; connections, sizes, dead rows
 * archon pg backup prime                # a dump now (a timer dumps every instance nightly)
 * ```
 *
 * Versions: 18 is Ubuntu's. Any other comes from PostgreSQL's own apt repository (PGDG), signed with
 * the key Ubuntu's `postgresql-common` ships; PGDG may not publish every version for a new Ubuntu
 * release yet, in which case `ensure` says so.
 *
 * Archon touches only clusters it created: the ones in the host's record. A cluster with the same name
 * that Archon did not create is reported and left alone, and Ubuntu's own `main` cluster is never
 * made.
 *
 * Each instance gets `conf.d/50-archon.conf` (listen on localhost, scram-sha-256, TLS 1.3, connection
 * logging, and the facts the prompt reads) and a `pg_hba.conf`: peer on the socket, scram-sha-256 on
 * loopback, `postgres` refused over any network, nothing weaker. A role that can log in without a
 * Linux account of its name, or a second superuser, is reported by `archon pg who` (and
 * `archon verify`) and fixed by the next apply.
 *
 * ## Operators: publish
 *
 * ```sh
 * archon pg publish prime              # every address the router lets through, over TLS
 * ```
 *
 * Publishing makes `prime` reachable at `pg-prime.<server>.<domain>` (for alpha,
 * `pg-prime.alpha.lab.example.net`), on its own port, over TLS with scram-sha-256: PostgreSQL also
 * listens on the server's address, `pg_hba.conf` admits TLS connections (and refuses `postgres` from
 * any address), the firewall opens that one port, and PostgreSQL serves the server's wildcard
 * certificate (the one Traefik gets from Let's Encrypt).
 *
 * By default any address may connect: what reaches the server from outside is up to the router (its
 * port forwarding and the public DNS), as for HTTPS. The server restricts no network itself (spec
 * 064). `archon pg show prime --form external` prints everything a client needs. Clients connect with:
 *
 * ```
 * host=pg-prime.alpha.lab.example.net port=5432 sslmode=verify-full sslrootcert=system
 * ```
 *
 * PostgreSQL speaks TLS itself: Traefik is not in the path. A person signs in with their Linux
 * password, so let the router admit networks beyond the site only for people whose passwords are
 * strong. `archon pg unpublish prime` undoes all of it, people's passwords included.
 *
 * ## Operators: upgrade, restore, remove (destructive)
 *
 * `archon pg upgrade NAME --to N`, `archon pg restore NAME`, and `archon pg remove NAME` change or
 * lose data. Each runs only when the owner has added a line `approve: destructive` to
 * `specs/038-pg/spec.md` and asked for it, and with `--confirm-destroy NAME`. None is served over MCP.
 *
 * - `upgrade` dumps the instance first, then runs `pg_upgradecluster`; the old cluster is kept,
 *   stopped, until `archon pg remove NAME --version OLD --confirm-destroy NAME`.
 * - `restore` dumps what is there now, then loads the newest dump (or `--from FILE`), then sets
 *   Archon's passwords again.
 * - `remove` dumps the instance, then drops it and forgets its record and passwords. An instance in
 *   the model must leave the model first.
 *
 * Dumps (`pg_dumpall`, zstd) are in `/var/backups/archon/pg/<name>/`, root only, the last 7 kept; the
 * nightly backup (spec 016) carries them.
 *
 * ## For programs (the app contract)
 *
 * Run as the app's service account:
 *
 * ```sh
 * archon pg ensure prime --json
 * archon pg connect prime --write --json
 * psql service=prime     # or any libpq client: service=prime
 * ```
 *
 * Both commands work unattended, without sudo, once PostgreSQL is on and `prime` runs.
 * `connect --json` prints
 * `{"ok": true, "service", "host", "port", "user", "database", "sslmode", "files"}` (and `published`
 * when it is); a failure, PostgreSQL being off included, exits non-zero and prints one sentence
 * (`{"ok": false, "error": "..."}` with `--json`).
 *
 * See also `man archon-pg`, `pg_lsclusters(1)`, `psql(1)`.
 *
 * @module
 */
// Spec: 038-pg

export {};
