# 01 — Installation

## 1. Prerequisites

| Requirement | Version | Needed for |
| ----------- | ------- | ---------- |
| **Node.js** | **≥ 24** | Everything (engine, server, CLI, Node SDK) |
| npm | ≥ 10 (ships with Node) | Workspace install / build |
| Python | ≥ 3.9 | Python SDK only (optional) |
| Disk | Data volume sized by retention × ingest rate | Data root |

Node ≥ 24 is required because the sources are written in TypeScript and executed through Node's
**native type stripping** (`node src/main.ts`). No transpiler, bundler or `ts-node` is involved at
runtime.

> The runtime closure (`core` / `client-node` / `server` / `cli`) has **zero third-party dependencies**
> and **zero native modules**. The only dependency tree you install belongs to the dev toolchain
> (TypeScript, `@types/node`) and to the optional Web console (Vue + Vite).

## 2. Get the source

```bash
git clone <your-mirror-or-upstream-url> ss-rtdb
cd ss-rtdb/src        # the npm workspace root is src/, not the repository root
```

The repository root contains documentation; **all npm commands run in `ss-rtdb/src`**.

## 3. Install dependencies

```bash
npm install
```

This links the workspaces (`core`, `server`, `client-node`, `cli`, `admin`) and installs the dev
toolchain. No post-install build step runs automatically.

## 4. Build

**Running the server and CLI from source needs no build at all** — `server` and `cli` import their
dependencies' TypeScript sources directly, and Node strips the types at load time. A build is only
required for:

| Package | Output | Needed for |
| ------- | ------ | ---------- |
| `@ss/rtdb-core` | `packages/core/dist/` | publishing / consuming the engine from another package |
| `@ss/rtdb-client` | `packages/client-node/dist/` | publishing / consuming the Node SDK |
| `@ss/rtdb-admin` | `packages/admin/dist/` | the Web console served at `/admin` |

```bash
npm run build                                  # every workspace that defines a build script
npm run build --workspace @ss/rtdb-admin       # just the Web console
```

If you skip the `admin` build, the server still starts normally — `/admin` simply returns 404.

## 5. Verify the installation

```bash
npm run typecheck     # tsc --noEmit for the whole workspace + vue-tsc for admin
npm test              # engine / segment / WAL / retention / CLI / client / server test suites
npm run check:deps    # asserts the runtime closure has no third-party or native dependency
```

Typical first-run problems:

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `SyntaxError: … TypeScript …` on start | Node < 24 | Upgrade Node |
| `Cannot find module '@ss/rtdb-core'` | Workspaces not linked / not built | `npm install && npm run build` |
| `/admin` returns 404 | Admin bundle not built | `npm run build --workspace @ss/rtdb-admin` |
| `E_DB_LOCKED` on start | Another process already owns the data root | Stop that process (see [08](./08-operations.md#2-the-data-root-lock)) |

## 6. Running from source vs. from `dist`

Both are supported and behave identically.

**From source** (the normal way — convenient during development, and the only mode the `server` and
`cli` packages ship today; they have no `build` script):

```bash
node packages/server/src/main.ts          # server
node packages/cli/src/main.ts status      # CLI
```

Both are also exposed through npm scripts and `bin` entries:

```bash
npm start --workspace @ss/rtdb-server     # == node packages/server/src/main.ts
npx rtdbctl status                        # bin entry of @ss/rtdb-cli
npx rtdb-server                           # bin entry of @ss/rtdb-server
```

You can expose them globally with `npm link`, or install the published packages into your own project.
The packages that do publish compiled output (`core`, `client-node`, `admin`) put it in `dist/`.

## 7. Installing into your own project

**Embedded engine (Form A):**

```bash
npm install @ss/rtdb-core
```

**Client SDK (Form B):**

```bash
npm install @ss/rtdb-client        # Node
pip install ./packages/client-python   # Python, or copy the ss_rtdb_client/ package
```

Both SDKs are pure HTTP and never touch the data directory, so they can live in a completely separate
process, container or host.

## 8. Optional: Python SDK

The Python SDK is **stdlib-only** (no `requests`, no `numpy`) and works on CPython ≥ 3.9.

```bash
cd packages/client-python
pip install -e .                                  # editable install
python -c "import ss_rtdb_client; print(ss_rtdb_client.__version__)"   # -> 0.1.0
```

Run its tests with `python -m pytest tests/` (pytest must be installed separately; the package itself
has no runtime dependencies).

## 9. Next steps

- [02 — Configuration](./02-configuration.md): set the port, data directory and authentication.
- [03 — Running the server & `rtdbctl`](./03-running-and-cli.md): start the service and drive it.

---

## Revision history

| Date | Change | Model |
| ---- | ------ | ----- |
| 2026-10-17 | Revision-history section introduced (earlier revisions of this page predate the log) | DeepSeek-V4.1-Flash |
