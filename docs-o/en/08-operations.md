# 08 — Operations & maintenance

## 1. On-disk layout

```
{dataDir}/
├── lock                      # data-root ownership (pid)
├── rtdb-users.json           # user directory (scrypt hashes)
├── rtdb-tokens.json          # API token directory (hashes only)
├── archive/                  # cold archives: {db}/yyyyMMdd.tar.gz
└── {database}/
    ├── retention.json        # per-database retention override (optional)
    └── 20261017/             # day directory — the unit of retention / backup / damage isolation
        ├── 20261017-000.seg  # capacity segment (sealed segments are read-only & immutable)
        ├── 20261017-000.idx  # per-segment index snapshot (rebuildable from the .seg)
        ├── 20261017-001.seg  # rolled over when the previous one hit storage.segment.maxBytes
        ├── 20261017-001.idx
        ├── 20261017.wal      # write-ahead log (current day only; truncated after flush)
        ├── 20261017.bfill.seg   # backfill sidecar (out-of-window / historical writes)
        └── 20261017.bfill.idx
```

Two-level design:

- **Day directory** (`yyyyMMdd/`) = the unit of retention, backup and damage isolation. Retention
  deletes the whole directory; copying it backs up that day completely.
- **Capacity segment** (`yyyyMMdd-NNN.seg`) = the physical I/O and recovery unit. Rolling happens only
  at block boundaries, so a block never spans two segments. Three-digit zero padding keeps
  lexicographic order equal to time order, and the date prefix keeps files identifiable outside their
  directory.

### 1.1 Segment creation and rolling rules

A new `.seg` is created at exactly three moments:

1. **First write**: the database has no active segment for the day (new database / new day / first block
   after a restart). The sequence continues from the largest existing one plus 1 (a restart never
   overwrites existing files); the segment is created exclusively (`wx+`), gets its 32 B header and an
   fsync.
2. **Day rollover**: when a block's timestamp enters a new local day, the next day directory and segment
   are **pre-created synchronously** (mkdir + create, <1 ms) and the old segment is sealed automatically —
   day boundaries stay complete for day-pruned queries.
3. **Capacity rollover**: before appending a block, `bytesWritten + estimated block bytes >
   storage.segment.maxBytes` (default 200 MiB) seals the old segment and creates the next sequence.

Three exceptions where no roll happens:

- **Empty segments never roll**: a segment without any block keeps receiving appends. Otherwise a single
  block larger than 200 MiB would trigger endless rolling;
- **A block never spans segments**: it goes entirely into the current segment, or rolling happens and it
  goes entirely into the next one. `maxBytes` is therefore a **soft limit** — a file may exceed it by at
  most one block (≤ `blockTargetPoints` points);
- **Sequence exhausted**: once the day reaches `maxPerDay` (bounded by the format limit 999), rolling
  stops and appends continue into the current segment — exceeding the soft limit is preferred over
  losing data.

Sealing terminates a segment; it can never be appended afterwards (copying it out = backup). Triggers:
capacity rollover, day rollover, shutdown `close()`. Actions: write the footer (16 B, CRC over header +
index offset) → write the in-segment index region → fsync → close the write handle → atomically rewrite
the `.idx` mirror. A missing or corrupt `.idx` is rebuilt by startup recovery from a block scan; a process
killed before sealing still reads fine, but that segment has no `.idx` mirror and its index is rebuilt in
memory during recovery.

## 2. The data-root lock

One `dataDir` may be opened by **one process at a time**. Implications:

- Do not run `rtdb-server` and an embedded `RtdbEngine` against the same directory — the second one
  fails with `E_DB_LOCKED`.
- **All offline `rtdbctl` commands** (`size`, `repair`, `restore`, `archive`, and `retention` without a
  `days` argument) need exclusive access. Stop the server first:

```bash
systemctl stop ss-rtdb
rtdbctl repair plant_a
systemctl start ss-rtdb
```

- A lock owned by a dead process is detected (pid liveness check) and taken over automatically.
- Multiple databases inside one data root are fine: they are written concurrently by the same process.

## 3. Backup

```bash
rtdbctl backup plant_a /mnt/backups/2026-10-17
# -> /mnt/backups/2026-10-17/plant_a
```

Or through the API / SDK:

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/backup/plant_a" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"targetDir":"/mnt/backups/2026-10-17"}'
```

- The server **does not need to be stopped**: sealed segments are immutable, so the copy is consistent.
- Because a day directory is self-contained, **copying one day directory = a complete backup of that
  day**. `cp -a {dataDir}/{db}/20261017 /backup/` is a valid day-level backup.
- `rsync`/`cp`/snapshot tooling all work; there is no proprietary dump format.

## 4. Restore

```bash
systemctl stop ss-rtdb

# whole database from a backup directory
rtdbctl restore plant_a /mnt/backups/2026-10-17

# or a single archived day
rtdbctl restore plant_a --archive 20261015

systemctl start ss-rtdb
```

Restore is **replace-style**: the target database directory is replaced by the backup content and then
that database's startup recovery and WAL replay are re-run. Verify afterwards:

```bash
rtdbctl size plant_a --by-day
rtdbctl metrics plant_a
```

## 5. Archiving (cold storage)

```bash
rtdbctl archive plant_a            # list existing archives
rtdbctl archive plant_a 20261015   # pack that day to {dataDir}/archive/plant_a/20261015.tar.gz
```

To archive automatically instead of deleting, set in the config file:

```json
{ "retentionDays": 90, "archiveBeforeDelete": true, "archiveDir": "/var/lib/ss-rtdb/archive" }
```

`archiveDir` must be on the **same volume** as `dataDir` (the implementation packs by directory).

## 6. Retention

- Global default: `retentionDays` in the config file (`0` = keep forever).
- Per-database override: `rtdbctl retention plant_a 90` or `PUT /api/v1/retention/plant_a`, persisted
  to `{dataDir}/{db}/retention.json` and surviving restarts.
- The sweep runs on a timer and **deletes whole day directories** that are fully expired. Only sealed,
  non-current day directories are removed, so it never competes with active writes.
- Read the effective value offline with `rtdbctl retention plant_a` (shows
  `(not set; the global default applies)` when no override exists).
- Force a sweep now from Form A: `await rtdb.runRetention()`.

Retention is also why day directories exist: expiry is a directory deletion, not a segment merge, so
there is no compaction pressure.

## 7. Repair

```bash
systemctl stop ss-rtdb
rtdbctl repair plant_a            # whole database
rtdbctl repair plant_a 20261017   # one day
systemctl start ss-rtdb
```

`repair` is **idempotent** and safe to re-run. It:

1. truncates half-written block tails whose CRC fails,
2. rebuilds missing/stale `.idx` mirrors from the `.seg` files,
3. re-applies the WAL and discards an unparseable WAL tail.

Checksums and CRCs mean corruption is confined to the damaged block; sealed segments are immutable, so
already-written data is never rewritten.

## 8. Crash recovery

On every start (or after `restore`):

1. Scan each database's day directories and load / rebuild segment indexes (including `.bfill.idx`).
2. Replay the current day's WAL, de-duplicating against the segment tail by timestamp.
3. Truncate any half block (CRC failure) and log a warning.

**Consistency promise**: at any instant a point is either inside a segment file (blocks are `fsync`ed
before the WAL safe point is advanced) or still inside the WAL (group-`fsync`ed on every append). With
`fsyncPolicy='wal'` (the default) neither a process crash nor a power loss loses points;
`fsyncPolicy='none'` is only for scenarios where data can be reloaded. Sealed segment data is permanently
safe. Clients only need to retry a failed batch — writes are idempotent by
`(metric, timestamp)`.

Out-of-window writes go to a **backfill sidecar** (`yyyyMMdd.bfill.seg`) instead of mutating a sealed
main segment; queries merge main and backfill data by timestamp, preferring the main segment on
collisions.

## 9. Monitoring

| Endpoint | Auth | Use |
| -------- | ---- | --- |
| `GET /healthz` | none | Liveness probe → `{"status":"ok"}` |
| `GET /metrics` | none | Prometheus text exposition |
| `GET /api/v1/status` | none | Full JSON runtime report |
| `GET /api/v1/databases`, `/api/v1/metrics/:db` | query | Inventory |

Suggested alerts on `GET /api/v1/status`:

| Signal | Why |
| ------ | --- |
| `wal.pendingBytes` / `wal.pendingPoints` growing | Sink cannot keep up; expect `429`s soon |
| `write.pointsPerSec` far below the ingest rate | Backpressure or client slowdown |
| `cache.blockHitRate` dropping | Raise `cache.blocks` |
| `query.p99Ms` rising | Consider larger blocks or more `cache.blocks` |
| `segments.bytesToday` | Capacity planning / retention sizing |
| `gc.maxMs` | Long GC pauses → check heap pressure |

Prometheus scrape example:

```yaml
scrape_configs:
  - job_name: ss-rtdb
    static_configs:
      - targets: ['127.0.0.1:6180']
    metrics_path: /metrics
```

systemd liveness:

```ini
[Service]
ExecStart=/usr/bin/node packages/server/src/main.ts
ExecStop=/bin/kill -TERM $MAINPID
Restart=on-failure
WatchdogSec=0
```

## 10. Sizing and tuning

| Goal | Knob |
| ---- | ---- |
| Fewer, larger files (better compression) | ↑ `write.blockTargetPoints` (4 096…65 536) |
| Lower write latency on sparse metrics | ↓ `write.blockTargetPoints`, ↑ `write.flushIntervalMs` |
| Cap file size for backup/rsync friendliness | ↓ `storage.segment.maxBytes` (16 MiB…4 GiB) |
| Hot query performance | ↑ `cache.blocks` (16…4 096) |
| Durability vs. throughput | `write.fsyncPolicy: 'wal'` (safe) vs `'none'` (fast, OS-flushed) |
| Memory ceiling under burst | `write.maxBufferBytes`, `write.maxPendingPoints` (→ `429` instead of OOM) |
| Query memory ceiling | Query primitives scan **block cluster by block cluster**: `count exact` / aggregate / `queryAt` / `range` in either direction; memory grows with hit clusters and aggregate windows, not with the hit point count (effective 2026-10-18) |

Reference budgets: idle footprint well under 100 MB RSS; 10 000 mixed-period metrics stay under ~500 MB.
Query-side memory is decoupled from the hit point count (see the table above); long-range queries no
longer grow linearly with the points hit.
Targets: ≥50 000 points/s sustained write; ≥10× compression on full 16 384-point blocks; a 7-day range
query on one metric ≈ ≤300 ms cold / ≤50 ms warm.

## 11. Migrating between forms

The data directory format is identical for both forms.

- **A → B**: stop the embedding application, then start `rtdb-server` with `dataDir` pointing at the
  same directory. No conversion step.
- **B → A**: stop the server, then open `RtdbEngine` on the same directory.
- Never run both at once against one directory (`E_DB_LOCKED`).

## 12. Routine checklist

```bash
# daily
rtdbctl status
rtdbctl backup plant_a /mnt/backups/$(date +%F)

# weekly (maintenance window)
systemctl stop ss-rtdb
rtdbctl repair plant_a
rtdbctl size plant_a --by-day
systemctl start ss-rtdb

# quarterly
rtdbctl token list                 # revoke stale tokens
rtdbctl user list                  # remove unused accounts
rtdbctl archive plant_a            # review cold archives
```

## 13. Next steps

- [09 — Developer guide](./09-developer-guide.md)

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | Revision-history section introduced (earlier revisions of this page predate the log) | DeepSeek-V4.1-Flash |
| 2026-10-17 | Rewrote the consistency promise: a point is either in a segment (segment fsync precedes the WAL safe point) or in the WAL (group fsync per append); with `fsyncPolicy='wal'` neither a crash nor a power loss loses points | DeepSeek-V4.1-Flash |
| 2026-10-17 | Added §1.1 segment creation and rolling rules: three creation triggers (first write with sequence continuation / day rollover pre-creation / capacity rollover), three no-roll exceptions (empty segment, block never spans segments i.e. soft limit, sequence exhausted keeps appending), sealing actions and `.idx` rebuild wording | DeepSeek-V4.1-Flash |
| 2026-10-18 | §10 capacity tuning adds a "query memory ceiling" row: query primitives scan block cluster by block cluster, decoupling memory from the hit point count (`count exact` / aggregate / `queryAt` / descending `range` no longer materialize every hit point) | GLM-5.3-Flash |
