# 11 — Storage format & write path (detailed design)

This page consolidates the design details of the on-disk format and the write path: the physical
segment layout, block encoding and codec selection, CRC scopes, the ten-step write pipeline, the WAL
line format and safe point, startup recovery, and every default constant with its clamp range.
The **generation and rolling rules** of segment files (when a new `.seg` is created) are covered in
[08 — Operations & maintenance](./08-operations.md) §1.1; this page only describes "what the files
look like and how data flows into them".

> Applicability: `@ss/rtdb-core` (Form A) and `rtdb-server` (Form B) are identical — both forms share
> the same engine and the same on-disk format, with no migration.

---

## 1. Data directory and file naming

```text
{dataDir}/
├── lock                        # single-process exclusive lock (one dataDir = one process at a time)
└── {database}/                 # one directory per database (directory-level isolation)
    ├── retention.json          # per-database retention override (optional; beats the global retentionDays)
    ├── quality.json            # per-database quality store override (optional, e.g. {"store":"good"}; beats quality.store)
    └── {yyyyMMdd}/             # one directory per day: retention / backup / quarantine unit
        ├── {yyyyMMdd}-NNN.seg  # capacity segment: physical IO / recovery unit; NNN is a 3-digit zero-padded sequence
        ├── {yyyyMMdd}-NNN.idx  # segment index mirror (a replaceable copy of the index region inside the .seg)
        └── {yyyyMMdd}.wal      # that day's write-ahead log (JSONL)
```

- The 3-digit zero-padded sequence guarantees **lexicographic order = time order**; format version 1
  caps a day at 999 segments (`MAX_SEGMENT_SEQUENCE`).
- `.idx` is a **replaceable mirror** of the index region inside the `.seg` (used to warm queries):
  if missing or inconsistent with the actual block region, recovery rebuilds it from the segment
  file (§7).
- The WAL is split **per day**; a batch crossing midnight leaves a byte range in each day's file (§6).

---

## 2. Segment file physical layout (format version 1)

Except for the ASCII magic, **every integer is little-endian (LE)**. Top to bottom:

```
┌────────────────────────────┐ 0x00
│ Header (32B)               │
├────────────────────────────┤
│ Block[0]                   │
│ Block[1]                   │   append-only, blocks never split across segments
│ ...                        │
├────────────────────────────┤ ← footer start (end of the block region)
│ Footer (16B)               │
├────────────────────────────┤ ← indexOffset = footer start + 16
│ intra-segment index region │
└────────────────────────────┘ EOF
```

### 2.1 Segment header (fixed 32B, offsets 0x00–0x1F)

| Offset | Size | Field | Meaning |
| ------ | ---- | ----- | ------- |
| 0x00 | 8B | magic | ASCII `"SSRTDB01"` |
| 0x08 | u16 | version | format version, currently `1`; mismatch throws `E_CORRUPT_SEGMENT` |
| 0x0A | u16 | flags | bit0 `zlibBlock` = the segment contains a zlib-wrapped whole block; bit1 `hasBackfillBlock` = contains an out-of-order backfill block |
| 0x0C | u32 | date | `yyyyMMdd` |
| 0x10 | i64 | createdAt | ms epoch |
| 0x18 | 8B | reserved | 0 |

Timing constraint for flags: the header is written once at **segment creation** (flags=0); after the
write side appends a zlib-wrapped block it calls `setSegmentHeaderFlag`, which bitwise-ORs the flag
into the **in-memory headerBytes and the on-disk u16 at 0x0A in sync** — the sync is mandatory
because the Footer CRC computed at seal time covers the **in-memory headerBytes**; an inconsistency
with the on-disk header would fail read-side verification.

### 2.2 Block header (fixed 41B + metric bytes)

| Field | Size | Meaning |
| ----- | ---- | ------- |
| metricLen | u16 | UTF-8 byte length of the metric name (1–65535) |
| metric | metricLen B | metric name |
| pointCount | u32 | points in the block |
| valueType | u8 | 1=`f64` 2=`i64` 3=`bool` 4=`string` |
| tsCodec | u8 | timestamp codecId (currently always 1) |
| valCodec | u8 | value codecId (§3) |
| tsRawLen | u32 | **on-disk** timestamp payload byte count (see below) |
| valRawLen | u32 | **on-disk** value payload byte count (see below) |
| tsMin / tsMax | i64×2 | ms timestamp range within the block |
| flags | u16 | bit0 `backfill` = out-of-order backfill block; bit2 `qualityPresent` = a 1B-per-point quality array is appended at the block tail; bit3 `receivedTime` = a 16B server receive-time window is appended at the block tail |
| reserved | u16 | 0 |
| crc32 | u32 | covers the whole BlockData (including the quality array and the receive-time window tail, §4) |

Block data: `BlockData = tsEncoded(tsRawLen B) ++ valEncoded(valRawLen B) ++ quality(pointCount B, optional)`;
when flags bit3 is set it is followed by `receivedWindow(16B) = [receivedMin i64][receivedMax i64]`
(ms epoch; `totalLength` and the block CRC scope grow accordingly). Legacy blocks without the flag
parse as `receivedMin/receivedMax = null` with unchanged behavior — the receive-time window is arrival
traceability at **block/batch granularity** (backfill identification, link-latency observation),
not stored per point.

**Quality array (flags bit2)**: one u8 bit field per point, in the same order as `tsEncoded`:
`bit7-6 severity` (00 Good / 01 Uncertain / 10 Bad / 11 Reserved, read as Bad),
`bit5-4 source` (00 Process / 01 Substituted / 10 Interpolated),
`bit3-0 reason` (0 None, 1 SensorFailure, 2 CommFailure, 3 OutOfRange, 4 Overflow, 5 Stale,
6 BadReference, 7 ConfigurationError, 8 Maintenance, 9 Test, 10 Blocked, 11 CalculationError,
12 Inconsistent, 13 Inaccurate, 14 Oscillatory). A block whose points are **all `0x00`** neither sets
the flag nor appends the array, so existing all-Good data keeps its exact byte layout and size; a single
non-zero quality makes the whole block append `pointCount` bytes (compressed together with the payload
under `valCodec=4`). The `.idx` mirror carries no quality — quality is decoded only with the block.

**Key convention**: `tsRawLen` / `valRawLen` carry the **on-disk (encoded) payload byte counts**,
not the decompressed counts — the read side uses them to split BlockData. Timestamps inside a block
are **stably sorted ascending** before encoding (equal timestamps keep write order).

### 2.3 Footer (fixed 16B, immediately after the last block)

| Field | Size | Meaning |
| ----- | ---- | ------- |
| indexOffset | u64 | start of the index region (= footer start + 16) |
| crc32 | u32 | covers Header 32B ++ indexOffset 8B (§4) |
| reserved | u32 | 0 |

### 2.4 Intra-segment index region (indexOffset .. EOF, 38B + metric per entry)

```
[metricLen u16][metric][offset u64][len u64][pointCount u32][tsMin i64][tsMax i64]*
```

- `offset` = absolute byte offset of the block start **within the segment file**; `len` = the
  **whole-block byte count** (block header + data) — a query reads the entire block with a single
  seek, no need to recompute the header length.
- Like the block region, the index region clusters by metric name: blocks of one metric are
  adjacent, and `tsMin/tsMax` serve range pruning.

---

## 3. Encoding and codec selection

codecIds are fixed into the format and **must not be reused or reordered**:

| codecId | Meaning |
| ------- | ------- |
| 0 | raw (fallback, straight binary layout per valueType) |
| 1 | delta-of-delta + varint (timestamps only) |
| 2 | Gorilla XOR (f64 only) |
| 3 | generic RLE (reserved, unused) |
| 4 | zlib whole-block wrapper: `[innerCodecId u8][deflate stream]` |
| 5 | i64 delta + varint |
| 6 | bool RLE bit packing |
| 7 | string dictionary encoding |

- **Timestamps** always use codec 1 (`tsCodec=1`; one shared timestamp sequence per block).
- **Values** are chosen automatically by `encodeValues`: it produces "specialized encoding",
  "specialized + zlib wrap", "raw", and "raw + zlib wrap" (a zlib wrap is kept only when shorter than
  its input) and takes the **byte-smallest**; on ties the priority specialized(0) < zlib(1) < raw(2)
  wins. The chosen codecId is written into the block header `valCodec`.
- Unwrapping zlib is a single step: read `innerCodecId`, then decode as a plain codec.
- The valid value-codecId set is `{0, 2, 4, 5, 6, 7}`; an out-of-set value in a block header is
  treated as a corrupt block.

---

## 4. CRC and integrity

| Check | Scope | Algorithm | On failure |
| ----- | ----- | --------- | ---------- |
| Block CRC | the whole BlockData | chained `crc32(val, crc32(ts))` (node:zlib); when flags bit2 is set the quality array is chained in (`crc32(quality, …)`), and when bit3 is set the 16B receive-time window follows (`crc32(received, …)`) | read side throws `E_CORRUPT_BLOCK` |
| Footer CRC | Header 32B ++ indexOffset 8B | crc32 | read side treats it as `E_CORRUPT_SEGMENT` |

- The segment header itself carries no CRC; it is validated via magic + version + field-range checks
  (`parseSegmentHeader`).
- Block-header parsing (`tryParseBlockHeader`) is defensive: out-of-range fields / `tsMax < tsMin` /
  invalid valueType or codecId / unknown flag bits → returns null, and the scanner uses that to
  detect the **end of the block region** (i.e. the footer start) instead of throwing — this is why a
  power-loss-truncated segment file remains readable up to the last complete block.
- The `.idx` mirror and the in-segment index region hold identical content; the mirror is just a
  cache and can be rebuilt at any time.

---

## 5. Write path: from a point's arrival to stable storage

One `append` call = one batch; the full pipeline:

1. **Validation**: database name, metric name (≤512 UTF-8 bytes), value bounds (i64 ∈ ±2^53,
   string ≤256 bytes, ms-epoch timestamp), quality as a u8 (`0..255`).
2. **Quality store policy**: resolved per database (`quality.json` first, then the global
   `quality.store`). Below the threshold, `quality.onReject='reject'` fails the whole batch with
   `E_QUALITY_REJECTED` (nothing reaches the WAL); `'drop'` discards the point and counts it in
   `write.qualityDropped`.
3. **Type lock**: a metric's value type is locked on first write; a later mismatch throws
   `E_TYPE_MISMATCH`.
4. **Idempotent dedupe**: duplicate `(metric, timestamp)` points are counted as `duplicates` and not
   written again (clients may retry safely).
5. **WAL append**: the batch is written as a group of JSONL lines (§6); with `fsyncPolicy='wal'` one
   fsync per group; returns a `batchId` plus byte ranges in the day files, and the batch enters the
   FIFO ledger. **From this moment the batch survives power loss.**
6. **Write buffer**: points enter per-metric in-memory buffers (bounded by the `maxBufferBytes` /
   `maxPendingPoints` dual watermark; overflow triggers a synchronous flush or backpressure
   rejection).
7. **Block trigger** (any of): a metric's buffered points ≥ `blockTargetPoints`; the flush timer
   (default 5s) fires with ≥ `blockMinPoints`; an explicit `flush()`; the buffer byte watermark hits
   its ceiling.
8. **Rolling check**: before appending, test "current segment bytes + estimated block size >
   `segmentMaxBytes`" — the three triggers and three no-roll exceptions are in 08 §1.1 (blocks never
   split across segments; empty segments do not roll; at sequence 999 keep appending).
9. **Sort + encode**: timestamps are stably sorted ascending within the block; timestamps and values
   are encoded separately (§3), the quality array is appended bit-wise, and the block header and CRC
   are filled in.
10. **Append to segment**: `appendBlock` writes the whole block bytes plus an index entry.
11. **fsync the segment → advance the WAL safe point** (order must not be swapped): with
    `fsyncPolicy='wal'` every committed block triggers an fsync of the active segment file, and only
    **then** may batches complete and the safe point advance (§6) — guaranteeing that "data released
    from the WAL is already stable in the segment file". Finally the FIFO completes batches one by
    one (per metric: "cumulative appended − still buffered ≥ batch cumulative"), and once all are
    complete the WAL is truncated.

---

## 6. WAL: line format, batch ledger, and safe point

### 6.1 Line format (JSONL, one point per line, `\n`-terminated)

```jsonc
{"m":"station01.powerMeter.kwh","t":1699999999999,"v":1.5}
{"m":"station01.breaker","t":1699999999999,"v":"12345678901","vt":2}
```

- i64 is written as decimal text with `"vt":2` (JSON has no BigInt).
- A non-zero quality adds `"q":n` (u8 bit field, omitted when `0x00 = Good`); replay carries the flag back into the write path.
- Metric names forbid newlines and NUL, which makes JSONL naturally safe.

### 6.2 Batch ledger and safe point

- `append` (one call = one batch) returns a `batchId` and per-day byte ranges
  (`{dateNumber, startOffset, endOffset}`; a cross-day batch occupies two ranges).
- After all points are flushed into segments, call `completeBatch(batchId)`, then `commitSafePoint()`.
- **Safe point = the start offset of the earliest incomplete batch**; with no incomplete batch, the
  whole file is cleared.
- Two truncation modes: with nothing to retain, `truncateSync` zeroes the file directly; with a
  retained region, an **atomic rewrite** (tmp file + fsync + rename, then reopen the append handle) —
  a power loss mid-truncation cannot corrupt the retained region. (Windows disallows `ftruncate` on
  an open append handle, hence the atomic rewrite.)
- **Adopted batch** (`WAL_ADOPTED_BATCH_ID = 0`): if the day's WAL already has content on open
  (leftover from a crash), it is registered wholesale as one incomplete batch so the taking-over
  instance keeps advancing the safe point; otherwise the leftover lines would never be released.

### 6.3 Why the WAL "fills up and resets" (the sawtooth is normal)

The default `flushIntervalMs = 5000` advances the safe point every 5 seconds. At 20,000 points/s one
cycle is ~100,000 points → WAL peaks at ≈5.6 MB; once blocks are committed, fsynced, and batches
complete, the safe point reaches the file head → `truncate(0)`. The segment data written in the same
cycle is only ~140 KB (6 MB of JSONL ↔ 140 KB of segment bytes, tens-fold compression), so **"WAL
reset to zero with only a small segment growth" is data conservation, not data loss**. Judge stored
volume by `count` / `/api/v1/status`.

---

## 7. Startup recovery

When a process opens the data root (`recoverDataRoot`):

1. Scan database-by-database, day-by-day: read the segment header (magic / version check), parse
   blocks sequentially (defensively, see §4), and stop at the footer or the first damage — a
   power-loss-truncated segment still yields every complete block.
2. If the in-segment index region is missing or inconsistent with the actual block region, rebuild it
   from the actual blocks and atomically rewrite the `.idx` mirror.
3. Read the WAL (the day's JSONL) and replay points **not yet in segments** (judged by batch
   completion state) into the engine in write order (through the normal write path, including dedupe
   and the type lock); leftover WAL content is registered as the adopted batch (§6.2).
4. The whole process holds the `{dataDir}/lock` exclusive lock; offline commands (`size` / `repair` /
   `restore` / `archive` / `retention` without `days`) return `E_DB_LOCKED` while the server runs.

---

## 8. Constants and clamps

Engine defaults (`ENGINE_DEFAULTS`) and clamp ranges (`ENGINE_CLAMPS`):

| Option | Default | Clamp | Meaning |
| ------ | ------- | ----- | ------- |
| retentionDays | 0 | 0–3650 | 0 = no day-based expiry |
| segmentMaxBytes | 209715200 (200MB) | 16MiB–4GiB | soft segment limit (counts `.seg` only) |
| segmentMaxPerDay | 1000 | 1–1000 | bounded by the format limit 999 |
| blockTargetPoints | 16384 | 4096–65536 | target points per block |
| blockMinPoints | 1024 | 64–65536 | minimum points for a timer-flushed block |
| flushIntervalMs | 5000 | 200–60000 | flush timer period |
| maxBufferBytes | 268435456 (256MB) | 16MiB–2GiB | write-buffer byte ceiling |
| maxPendingPoints | 2000000 | 100k–10M | write-buffer point ceiling |
| cacheBlocks | 256 | 16–4096 | block cache capacity |
| cacheFdGroups | 32 | 4–256 | per-day file-handle group cache count |
| walEnabled | true | — | disabling it makes writes unrecoverable after power loss (reloadable scenarios only) |
| fsyncPolicy | `'wal'` | `'wal' \| 'none'` | `'none'` skips both the group-commit fsync and the segment fsync |
| qualityStore | `'all'` | `'all' \| 'good-uncertain' \| 'good'` | quality store threshold; per-database `quality.json` wins |
| qualityOnReject | `'reject'` | `'reject' \| 'drop'` | below the threshold: fail the batch or drop and count in `write.qualityDropped` |

Write limits (`WRITE_LIMITS`): metric names ≤512 UTF-8 bytes; string values ≤256 UTF-8 bytes;
i64 ∈ ±2^53; ms-epoch timestamps; quality is an integer `0..255` (out of range throws `E_INVALID_POINT`).

---

## 9. Implementation index

| Topic | Source |
| ----- | ------ |
| Segment/block/footer/index layouts, CRCs, constants | `src/packages/core/src/format.ts` |
| Segment lifecycle: create / roll / seal / `.idx` / fsync | `src/packages/core/src/segment-store.ts` |
| Write buffering, block triggering, block encoding | `src/packages/core/src/segment-writer.ts` |
| Codec registry and automatic selection | `src/packages/core/src/encoder/registry.ts` (plus `encoder/*-codec.ts`) |
| WAL: line format / batches / safe point / truncation | `src/packages/core/src/wal.ts` |
| Write orchestration, batch ledger, recovery replay | `src/packages/core/src/engine.ts` |

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | Page created: segment physical layout, encoding & CRCs, ten-step write path, WAL line format & safe point (including the "WAL fills then resets" explanation), startup recovery, constants & clamp table | GLM-5.3-Flash |
| 2026-10-17 | §2.2 block flags add bit3 `receivedTime`: 16B `[receivedMin][receivedMax]` server receive-time window at the block tail (included in `totalLength` and the CRC chain); §4 CRC chain updated | GLM-5.3-Flash |
| 2026-10-18 | Quality flags implemented: §1 directory tree gains `retention.json` / `quality.json`; §2.2 flag bit2 `qualityPresent` turns from reserved into real (a `pointCount`-byte quality array at the block tail, zero cost for all-Good blocks); §4 CRC chain includes the quality array; §5 write path gains the quality store policy step (reject / drop); §6 WAL `q` semantics updated; §8 constants add `qualityStore` / `qualityOnReject` and the quality value range | DeepSeek-V4.1-Flash |
