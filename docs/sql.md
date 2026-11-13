# SQL over your infrastructure

Every host can answer questions about itself, its files, its databases, and its buckets in SQL (spec
042):

| Tool        | Asks                                                                                 | Where        |
| ----------- | ------------------------------------------------------------------------------------ | ------------ |
| `osqueryi`  | the machine: processes, ports, users, packages, units, files, about 280 tables       | every host   |
| `duckdb`    | files (CSV, JSON, Parquet), S3 buckets, PostgreSQL, SQLite                           | every host   |
| `jc`        | turns command output (`ps`, `df`, `ss`, `dig`, `systemctl`...) into JSON, for DuckDB | every host   |
| `sqlite3`   | SQLite files                                                                         | every host   |
| `steampipe` | live APIs: GitHub, clouds, DNS, certificates, with your own credentials              | workstations |

## The machine (osquery)

`osqueryi` is an interactive SQL shell over the machine. Run it with `sudo` to see everything
(without it, some tables show only your own processes and files):

```sh
sudo osqueryi
```

```sql
-- What listens on which port, by process
SELECT p.name, l.port, l.protocol, l.address
  FROM listening_ports l JOIN processes p USING (pid) WHERE l.port != 0;

-- Who may use sudo, and how
SELECT * FROM sudoers;

-- SSH keys that can log in
SELECT u.username, k.key_file, k.comment FROM users u JOIN authorized_keys k USING (uid);

-- The ten processes using the most memory
SELECT pid, name, resident_size / 1048576 AS mib FROM processes ORDER BY resident_size DESC LIMIT 10;

-- Failed systemd units
SELECT id, sub_state FROM systemd_units WHERE active_state = 'failed';
```

`.tables` lists the tables, `.schema processes` shows one, and `.exit` leaves. One query from the
command line: `sudo osqueryi --json "SELECT * FROM uptime;"`.

osquery's daemon (`osqueryd`) runs on every host as infrastructure. It listens on no port: it runs
Archon's scheduled queries (ports, logins, users, sudoers, SSH keys, packages, kernel modules,
failed units) and writes what changed to `/var/log/osquery/osqueryd.results.log` (rotated), so the
machine's recent history is there to read:

```sh
sudo tail -f /var/log/osquery/osqueryd.results.log | jq .
```

## Files, buckets, and databases (DuckDB)

```sh
duckdb
```

```sql
-- A CSV or JSON file, as a table
SELECT * FROM 'report.csv' LIMIT 10;
SELECT count(*) FROM read_json_auto('events.json');

-- Your S3 bucket (spec 041), with the key archon fs s3 key --write put in ~/.aws
INSTALL httpfs; LOAD httpfs;
CREATE SECRET (TYPE s3, PROVIDER credential_chain, PROFILE 's3-alpha',
               ENDPOINT 's3.alpha.lab.example.net', URL_STYLE 'path');
SELECT * FROM 's3://alice-files/*.csv';

-- A PostgreSQL instance (spec 038), as yourself over the socket
INSTALL postgres; LOAD postgres;
ATTACH 'dbname=postgres host=/var/run/postgresql port=5432' AS pg (TYPE postgres, READ_ONLY);
SELECT relname, n_dead_tup FROM pg.pg_catalog.pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;
```

DuckDB downloads an extension the first time it is used and checks its signature.

## Command output as tables (jc and DuckDB)

```sh
# Disks over 80% full
df | jc --df | duckdb -c "SELECT filesystem, use_percent FROM read_json_auto('/dev/stdin') WHERE use_percent > 80"

# Listening sockets by process
ss -ltnp | jc --ss | duckdb -c "SELECT local_port, process FROM read_json_auto('/dev/stdin') ORDER BY local_port"
```

## APIs (Steampipe, on your workstation)

Steampipe asks live APIs in SQL with your own credentials, so it runs on workstations (secrets stay
off servers). Each source is a plugin:

```sh
steampipe plugin install github net
steampipe query "SELECT name, stargazer_count FROM github_my_repository ORDER BY stargazer_count DESC"
steampipe query "SELECT * FROM net_certificate WHERE domain = 'alpha.lab.example.net'"
```

The first run downloads Steampipe's own PostgreSQL and the plugins into `~/.steampipe`. The GitHub
plugin uses `GITHUB_TOKEN` (or `gh auth token`).

See also `man archon-sql`, `osqueryi --help`, `duckdb --help`, `jc --help`.
