# 03 — Running the server & the `rtdbctl` CLI

## 1. Starting the server

```bash
# From the workspace root (src/)
npm start --workspace @ss/rtdb-server

# Or directly
node packages/server/src/main.ts
node packages/server/src/main.ts   # add --config via RTDB_CONFIG
```

Startup log line:

```
rtdb-server started: http://127.0.0.1:6180 (dataDir=./rtdb-data)
```

Startup sequence: acquire the data-root lock → scan day directories → rebuild missing `.idx` → replay
the current day's WAL → start the flush timer and the retention timer → bind the HTTP listener.

**Stopping.** Send `SIGINT` (Ctrl+C) or `SIGTERM`; the server then flushes buffers, seals the active
segment, truncates the WAL and releases the data-root lock before exiting. Never `SIGKILL` a healthy
server — you lose at most the last ≤5 s of WAL, but you also leave the lock to be recovered.

### First-run token

With `auth.enabled = true` (default) and `auth.token` empty, the server reads `auth.tokenFile`
(default `./rtdb.token`) or generates a 64-hex-character token, writes it there with mode `0600`, and
logs a `WARN` naming the file. Store it immediately — every write/query needs it.

```bash
cat ./rtdb.token
```

To rotate it: delete the file (or set `auth.token` explicitly) and restart.

### Running as a service

**systemd** (`/etc/systemd/system/ss-rtdb.service`):

```ini
[Unit]
Description=ss-rtdb server
After=network.target

[Service]
Type=simple
User=ssrtdb
WorkingDirectory=/opt/ss-rtdb/src
Environment=RTDB_CONFIG=/etc/rtdb/rtdb.config.json
ExecStart=/usr/bin/node packages/server/src/main.ts
ExecStop=/bin/kill -TERM $MAINPID
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ss-rtdb
journalctl -u ss-rtdb -f
```

**Windows**: run under a service wrapper (NSSM or similar) with `node packages/server/src/main.ts`;
the same `SIGINT`/`SIGTERM` contract is honoured. Alternatively use `rtdbctl serve`, which installs
its own `SIGINT` handler and shuts down cleanly.

---

## 2. `rtdbctl` — command-line interface

`rtdbctl` drives both a running server (**online** commands, over HTTP) and a data directory directly
(**offline** commands). Offline commands need exclusive ownership of the data root, so **stop the
server before running them** — otherwise you get `E_DB_LOCKED`.

### 2.1 Usage

```
rtdbctl <command> [arguments] [options]
```

| Option | Meaning |
| ------ | ------- |
| `--config <path>` | Config file path (also `RTDB_CONFIG`) |
| `--data-dir <path>` | Local data root for offline commands (also `RTDB_DATA_DIR`) |
| `--url <baseUrl>` | Server base URL for online commands (also `RTDB_URL`) |
| `--token <token>` | Access token (also `RTDB_TOKEN`) |
| `--timeout <ms>` | Per-request timeout for online commands |
| `--role <role>` | `admin` \| `write` \| `readonly` |
| `--password <pw>` | User password (`user add` / `user passwd`) |
| `--label <text>` | Token label (`token issue`) |
| `--ttl <ms>` | Token lifetime in ms (`token issue`; omitted = never expires) |
| `--disabled` | Create the user disabled (`user add`) |
| `--json` | Machine-readable JSON output |
| `--by-day` | Include per-day detail (`size`) |
| `-h`, `--help` | Help |
| `-v`, `--version` | Version |

**Exit codes**: `0` success · `1` runtime failure · `2` usage failure (bad/missing arguments).

### 2.2 Command summary

| Command | Transport | Description |
| ------- | --------- | ----------- |
| `serve [--config <path>]` | in-process | Start the server in the foreground |
| `status [--json]` | HTTP `GET /api/v1/status` | Print the runtime status report |
| `metrics <db> [--prefix <p>]` | HTTP `GET /api/v1/metrics/:db` | List metrics with first/last timestamps |
| `backup <db> <dir>` | HTTP `POST /api/v1/backup/:db` | Back a database up to `<dir>/<db>` |
| `retention <db> [days]` | HTTP `PUT` / local read | Print (no `days`) or set the retention policy |
| `size <db> [--by-day]` | offline | On-disk size of a database |
| `repair <db> [<yyyyMMdd>]` | offline | Rebuild indexes, truncate corrupt block tails |
| `restore <db> <dir>` | offline | Restore a database from `<dir>/<db>` |
| `restore <db> --archive <yyyyMMdd>` | offline | Restore one archived day |
| `archive <db> [<yyyyMMdd>]` | offline | Archive a day (no date = list archives) |
| `user add\|list\|remove\|passwd` | HTTP `/api/v1/admin/users` | User administration (scope `admin`) |
| `token issue\|list\|revoke` | HTTP `/api/v1/admin/tokens` | API token administration (scope `admin`) |

### 2.3 `serve`

```bash
rtdbctl serve --config ./rtdb.config.json
# rtdbctl serve: listening on http://127.0.0.1:6180 (dataDir=./rtdb-data)
```

Starts `RtdbServer` **inside the CLI process** using the same configuration resolution as every other
subcommand, then waits for `SIGINT` / `SIGTERM` to shut down gracefully.

### 2.4 `status`

```bash
rtdbctl status
rtdbctl status --json
```

```
uptimeMs: 12,345
databases: 2
metrics: 1,204
write.pointsPerSec: 51,230
write.buffered: 0
write.duplicates: 13
write.tagsIgnored: 0
wal.pendingBytes: 0 B
wal.outstandingBatches: 0
segments.openFiles: 3
cache.blocks: 256
```

The `--json` form emits the full report, including `wal.pendingPoints`, `wal.lastFsyncMs`,
`segments.bytesToday`, `cache.blockHitRate`, `cache.heapUsedMb`, `gc.*` and `query.p50/p95/p99/maxMs`.

### 2.5 `metrics`

```bash
rtdbctl metrics plant_a
rtdbctl metrics plant_a --prefix station01 --json
```

```
Metric                        First                 Last
----------------------------  --------------------  --------------------
station01.powerMeter.kwh      2026-10-17 09:00:00   2026-10-17 09:05:00
station01.powerMeter.voltage  2026-10-17 09:00:00   2026-10-17 09:05:00
2 metric(s)
```

### 2.6 `backup`

```bash
rtdbctl backup plant_a /mnt/backups
```

Copies the whole database directory to `/mnt/backups/plant_a` and reports `files` / `totalBytes`.
This copies **sealed** data plus the current day's active segment; because sealed segments are
immutable, the copy is consistent without stopping the server.

### 2.7 `restore`

```bash
# Whole database (server must be stopped)
rtdbctl restore plant_a /mnt/backups

# One archived day
rtdbctl restore plant_a --archive 20261015
```

Restoration is a **replace-style copy**: the target database directory is replaced by the backup
content, then that database's startup recovery and WAL replay are re-run.

### 2.8 `archive`

```bash
rtdbctl archive plant_a            # list existing archives
rtdbctl archive plant_a 20261015   # pack that day into {dataDir}/archive/plant_a/20261015.tar.gz
```

### 2.9 `retention`

```bash
rtdbctl retention plant_a          # read the effective retention
rtdbctl retention plant_a 90       # set 90 days (via the server)
rtdbctl retention plant_a 0        # keep forever
```

Reading is offline (reads `{dataDir}/{db}/retention.json`); **setting** is an online call and requires
a running server. Output when unset: `retentionDays: (not set; the global default applies)`.

### 2.10 `size`

```bash
rtdbctl size plant_a --by-day
rtdbctl size plant_a --json
```

```
database: plant_a
directory: /var/lib/ss-rtdb/plant_a
files: 42
size: 1.8 GiB (1932735283 bytes)
retentionDays: 90

Day         Files  Size
----------  -----  -------
20261015       12  512 MiB
20261016       14  540 MiB
20261017       16  610 MiB
```

### 2.11 `repair`

```bash
rtdbctl repair plant_a             # whole database
rtdbctl repair plant_a 20261017    # one day only
```

Idempotent offline maintenance: truncates half-written block tails (CRC failure), rebuilds `.idx`
mirrors from the `.seg` files, and replays/discards the WAL tail. Safe to re-run. Reports
`truncatedSegments`, `rebuiltIndexes`, `replayedWalEntries`, `discardedWalTailBytes`.

### 2.12 `user`

```bash
rtdbctl user add alice --password 'S3cret!' --role write
rtdbctl user add bob   --password 'S3cret!' --role readonly --disabled
rtdbctl user list
rtdbctl user passwd alice --password 'N3wSecret!'
rtdbctl user remove bob
```

Default role for `user add` is `write`. Passwords are stored only as scrypt hashes; the API never
returns password material. All `user` subcommands require an **admin** credential.

### 2.13 `token`

```bash
rtdbctl token issue alice --label 'collector-01' --ttl 2592000000
rtdbctl token list
rtdbctl token revoke 7f3c9a1e...
```

The plaintext token is **shown exactly once** at issue time (`token: …`); only its hash is stored.
`token issue` defaults the role to the owner's role (or `write` when the user does not exist) and to
no expiry when `--ttl` is omitted. `token list` shows the state column: `active` / `revoked` /
`expired`.

---

## 3. Typical operator session

```bash
# 1. Check health and load (no credential needed)
curl http://127.0.0.1:6180/healthz
rtdbctl status

# 2. Create a least-privilege writer
rtdbctl user add collector --password "$COLLECTOR_PW" --role write
rtdbctl token issue collector --label 'edge-gateway-1'

# 3. Daily backup (server stays up)
rtdbctl backup plant_a /mnt/backups/$(date +%F)

# 4. Weekly maintenance window: stop, repair + size, start
systemctl stop ss-rtdb
rtdbctl repair plant_a
rtdbctl size plant_a --by-day
systemctl start ss-rtdb
```

## 4. Next steps

- [04 — HTTP API](./04-http-api.md) — the contract behind every online command.
- [08 — Operations & maintenance](./08-operations.md) — backup strategy, retention, monitoring.

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | Revision-history section introduced (earlier revisions of this page predate the log) | DeepSeek-V4.1-Flash |
