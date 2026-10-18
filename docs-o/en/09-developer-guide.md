# 09 — Developer guide

## 1. Repository layout

```
ss-rtdb/
├── src/                              # npm workspace root — run all npm commands here
│   ├── package.json                  # workspace root scripts
│   ├── tsconfig.base.json            # shared compiler options
│   ├── packages/
│   │   ├── core/                     # @ss/rtdb-core — engine, ZERO runtime dependencies
│   │   │   └── src/
│   │   │       ├── engine.ts         #   RtdbEngine facade (open/close/write/query/manage)
│   │   │       ├── types.ts          #   Point / EngineOptions / clamps
│   │   │       ├── errors.ts         #   ERROR_CODE master table
│   │   │       ├── format.ts         #   segment binary format, CRC, file naming
│   │   │       ├── segment-store.ts  #   day directories + capacity-segment lifecycle
│   │   │       ├── segment-writer.ts #   buffer → block → append
│   │   │       ├── segment-reader.ts #   index lookup → block decode → LRU cache
│   │   │       ├── wal.ts            #   write-ahead log
│   │   │       ├── recovery.ts       #   startup recovery
│   │   │       ├── retention.ts      #   retention / archive / directory copy
│   │   │       ├── memory-index.ts   #   metric → block locations
│   │   │       ├── lock.ts           #   data-root lock
│   │   │       ├── pool.ts           #   buffer pool
│   │   │       └── encoder/          #   gorilla / int64 / bool / string / timestamp / varint / zlib
│   │   ├── server/                   # @ss/rtdb-server — HTTP protocol shell
│   │   │   └── src/{server,config,auth,users,tokens,line-protocol,json-codec,metrics,logger}.ts
│   │   ├── cli/                      # @ss/rtdb-cli — rtdbctl
│   │   │   └── src/{cli,args,commands,local,output}.ts
│   │   ├── admin/                    # @ss/rtdb-admin — Vue 3 console (private package)
│   │   └── demo/                     # demo / test clients (npm workspaces) + shared config
│   │       ├── client-node/          # @ss/rtdb-client — Node SDK (HTTP only)
│   │       ├── client-python/        # ss-rtdb-client — Python SDK (stdlib only)
│   │       ├── client-smart-site/    # Smart Site real-time data simulator
│   │       └── conf/                 # rtdb-server.json / client-smart-site.json
│   ├── __tests__/                    # node:test suites + benchmarks
│   └── scripts/{check-runtime-dependencies,check-throughput-regression}.ts
└── docs-o/en/                        # this documentation
```

Dependency direction (no cycles):

```
admin ──┐
cli ────┼──> server ──> core
        └──> client-node   (HTTP only, no engine)
```

## 2. npm scripts (run from `src/`)

| Command | What it does |
| ------- | ------------ |
| `npm install` | Link workspaces, install the dev toolchain |
| `npm run build` | Build every workspace that defines `build` (core, client-node, admin) |
| `npm run typecheck` | `tsc --noEmit` for the workspace + `vue-tsc` for admin |
| `npm test` | Run all `__tests__/*.test.ts` with `node --test` |
| `npm run test:primitives` / `test:encoder` | Single suites |
| `npm run bench` | Run the benchmark suite |
| `npm run bench:regression` | Compare throughput against the recorded baseline |
| `npm run check:deps` | Assert the runtime closure has no third-party / native dependency |

Start things directly (no build step needed, Node ≥ 24 strips types natively):

```bash
node packages/server/src/main.ts
node packages/cli/src/main.ts status
```

## 3. Tests

Suites live in `src/__tests__/` and use the built-in `node:test` runner:

| Suite | Covers |
| ----- | ------ |
| `primitives`, `encoder` | varint, bit streams, codecs |
| `format` | binary header/block/footer layout, CRC, file naming |
| `segment`, `segment-writer`, `segment-reader` | segment lifecycle, rolling, block decode |
| `wal-recovery`, `write-path` | WAL append/truncate, recovery, backfill |
| `memory-index`, `pool` | index and buffer pool |
| `retention` | expiry, archive, directory copy |
| `engine` | end-to-end engine behaviour |
| `server` | HTTP routing, auth/RBAC, JSON and Line Protocol, error mapping |
| `client` | Node SDK contract |
| `cli` | `rtdbctl` subcommands and exit codes |

```bash
npm test                                   # everything
node --test __tests__/engine.test.ts       # one file
```

## 4. Benchmarks

```bash
npm run bench
```

| Benchmark | Measures |
| --------- | -------- |
| B1 compression | Compression ratio by value type and block size |
| B2 throughput | Sustained points/s and P99 write latency |
| B3 range latency | Cold vs. warm range-query latency |
| B4 day rollover | Cost of crossing a day boundary |
| B5 endpoint diff | Per-endpoint latency breakdown |
| B6 full load | Extrapolated behaviour at full load |
| B7 span scaling | Cross-span query performance: 1/5/10/20/30/50/100-day cold/warm latency and heap growth for range / count-exact / avg / queryAt |
| POWER-LOSS | Random power-loss injection (child process) — must end with zero corruption |

Scale is controlled with `RTDB_BENCH_SCALE` (e.g. `RTDB_BENCH_SCALE=small npm run bench`) to keep CI
runs short.

Acceptance thresholds used by the gate:

- Write throughput ≥ 50 000 points/s and P99 < 500 ms.
- Compression ≥ 10× on full 16 384-point blocks (small blocks are recorded as-is).
- 7-day range query on one metric: ≤300 ms cold / ≤50 ms warm.
- 1 000 power-loss injections → zero corruption.

Regression gate:

```bash
npm run bench:regression              # fails when throughput degrades > 15%
npm run bench:regression -- --update-baseline   # re-record the baseline after a deliberate change
```

Cross-platform environment noise downgrades a failure to a warning rather than blocking.

## 5. Dependency policy

`npm run check:deps` walks the runtime closure of `core` / `client-node` / `server` / `cli` and fails
if it finds **any** third-party package or native artifact (`.node`, `.exe`). Dev-only tooling
(TypeScript, Vite, Vue) is exempt automatically.

If you add an import, prefer a Node built-in (`node:fs`, `node:crypto`, `node:http`, …). A new runtime
dependency needs a strong justification and a documented exception.

## 6. Coding conventions

- **No TS `enum`.** Use `as const` objects plus literal unions (see `ValueType` in `core/src/types.ts`)
  — required because `erasableSyntaxOnly` is enabled.
- **Import TypeScript files with the `.ts` extension** (`import { X } from './engine.ts'`);
  `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` are on.
- `verbatimModuleSyntax` is on — use `import type { … }` for type-only imports.
- `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride` are all on.
- **Every source file must start with the Apache-2.0 header:**

```ts
// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com
```

- Error handling: throw `RtdbError` with an `ERROR_CODE` member; never throw bare strings. The server
  maps `RtdbError` to HTTP via `ERROR_CODE_HTTP_STATUS`; route-level problems use `HttpFailure`.
- Comments and identifiers in the codebase are English; the documentation source lives in `docs-o/`.

## 7. Adding a feature — checklist

1. Implement in `packages/core/src/` when it is engine behaviour; in `packages/server/src/` when it is
   protocol. Keep the engine free of HTTP concepts.
2. Export new public symbols from the package `index.ts`.
3. Add tests under `src/__tests__/`.
4. Mirror the API in **both** SDKs when it is part of the data plane (Node + Python must stay
   contract-identical).
5. Add a `rtdbctl` subcommand in `packages/cli/src/commands.ts` (register it in `COMMANDS` and in
   `USAGE_TEXT`), choosing online (HTTP) or offline (local data root) transport deliberately.
6. Document it: update the relevant page in `docs-o/en/`.
7. Run `npm run typecheck && npm test && npm run check:deps && npm run bench:regression`.

## 8. Release checklist

```bash
npm run typecheck
npm test
npm run check:deps
npm run bench:regression
npm run build                       # core, client-node, admin
grep -rl --include='*.ts' -L 'SPDX-License-Identifier: Apache-2.0' packages/*/src packages/demo/*/src   # must print nothing
```

Then tag and publish the packages (`@ss/rtdb-core`, `@ss/rtdb-client`, `@ss/rtdb-server`,
`@ss/rtdb-cli`) and the Python distribution.

## 9. License

Apache License 2.0. Contributions are accepted under the same license; keep the file header intact.

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | Revision-history section introduced (earlier revisions of this page predate the log) | DeepSeek-V4.1-Flash |
| 2026-10-18 | §4 benchmark table adds B7 (cross-span query performance matrix, 1/5/10/20/30/50/100 days) | GLM-5.3-Flash |
