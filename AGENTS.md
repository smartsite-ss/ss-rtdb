# AGENTS.md

本文件面向在该仓库中工作的 AI 编码代理（以及新加入的开发者）。人类读者请先看
[README.md](./README.md) 与 [docs-o/zh](./docs-o/zh/README.md)。

> English summary: `ss-rtdb` is a two-form real-time / time-series database (embedded `@ss/rtdb-core`
> and standalone `rtdb-server` + `rtdbctl` + SDKs + Vue 3 console) living in a single npm workspace at
> `src/`. **All npm commands run in `src/`.** The runtime closure (`core` / `client-node` / `server` /
> `cli`) must keep **zero third-party and zero native dependencies**, and every behavior change must be
> mirrored in **both** `docs-o/en/` and `docs-o/zh/`.

## 1. 项目速览

- **两种形态，一套引擎、一套磁盘格式**（无需迁移）：
  - 形态 A：嵌入式库 `@ss/rtdb-core` —— 进程内调用，无网络、无部署，类比 SQLite。
  - 形态 B：独立服务 `rtdb-server` + `rtdbctl` + Node/Python SDK + Vue 3 控制台，类比 InfluxDB。
- **数据模型**：`database → metric → point`。metric 名为扁平字符串（如
  `station01.powerMeter.kwh`），值类型由**首次写入锁定**；point 为
  `{ timestamp(ms epoch), value(f64|i64|bool|string), quality? }`。
- **写入幂等**：`(metric, timestamp)` 重复点计入 `duplicates`，客户端可安全重试。
- **设计边界**：单节点；无 SQL / JOIN / 事务 / 多租户（隔离以“一库一目录”实现）。
- 版本 `0.1.0`，许可证 Apache-2.0；**Node ≥ 24**（源码经 Node 原生类型剥离直接运行，
  所以 `server` / `cli` 无需构建）；Python SDK 要求 CPython ≥ 3.9。

## 2. 常用命令（工作目录一律为 `src/`）

| 目的 | 命令 |
| ---- | ---- |
| 安装工作区依赖 | `npm install` |
| 类型检查（含 admin 的 vue-tsc） | `npm run typecheck` |
| 全量测试 | `npm test` |
| 单个套件 | `npm run test:primitives` / `npm run test:encoder` / `node --test __tests__/engine.test.ts` |
| 依赖策略校验（运行时闭包无第三方） | `npm run check:deps` |
| 构建可发布产物（仅 core、client-node、admin） | `npm run build` |
| 基准 | `npm run bench` |
| 吞吐回归门禁（退化 >15% 失败） | `npm run bench:regression`（`-- --update-baseline` 重录基线） |
| 启动服务 | `npm start --workspace @ss/rtdb-server`（等价 `node packages/server/src/main.ts`） |
| 使用 CLI | `node packages/cli/src/main.ts status`（或 `npx rtdbctl status`） |
| 控制台开发服务器 | `npm run dev --workspace @ss/rtdb-admin` |
| Python SDK 测试 | `cd packages/client-python` 后 `python -m pytest tests/` |

注意：`server` 与 `cli` 包**没有 `build` 脚本**（直接运行 `.ts`）；`npm run build` 只构建
`core`、`client-node`、`admin`。仓库没有 linter / formatter，类型检查 + 测试即为质量门禁。

## 3. 仓库布局与依赖方向

```
ss-rtdb/
├── src/                      # npm 工作区根目录（package-lock.json 已入库）
│   ├── packages/
│   │   ├── core/             # @ss/rtdb-core     引擎，零依赖（dependencies: {}）
│   │   ├── server/           # @ss/rtdb-server   HTTP 外壳，依赖 core；bin: rtdb-server
│   │   ├── client-node/      # @ss/rtdb-client   纯 HTTP SDK，零依赖
│   │   ├── client-python/    # ss-rtdb-client    Python SDK，仅标准库
│   │   ├── cli/              # @ss/rtdb-cli      bin: rtdbctl，依赖 client-node/core/server
│   │   └── admin/            # @ss/rtdb-admin    Vue 3 + Vite 控制台（private）
│   ├── __tests__/            # node:test 套件（*.test.ts）+ benchmark/
│   └── scripts/              # check-runtime-dependencies.ts、check-throughput-regression.ts
└── docs-o/                   # en/ 原始英文文档，zh/ 中文译本（逐页对应）
```

依赖方向（不得成环，引擎不得引入 HTTP 概念）：

```
admin ──┐
cli ────┼──> server ──> core
        └──> client-node   （纯 HTTP，不含引擎）
```

`docs-e/` 是本地文档草稿目录，已被 `.gitignore` 忽略 —— **不要提交它**。

## 4. 硬约束（违反会破坏构建、发布或数据安全）

1. **运行时零依赖**：`core` / `client-node` / `server` / `cli` 只能使用 Node 内置模块
   （`node:fs`、`node:crypto`、`node:http`…）。新增第三方运行时依赖会被 `npm run check:deps`
   拒绝，需要充分理由与有记录的例外。
2. **不使用 TS `enum`**：`erasableSyntaxOnly` 已开启，请用 `as const` 对象 + 字面量联合类型
   （参见 `packages/core/src/types.ts` 的 `ValueType`）。
3. **相对导入必须带 `.ts` 扩展名**（`import { X } from './engine.ts'`），
   因为启用了 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`。
4. **类型导入用 `import type { … }`**（`verbatimModuleSyntax`）。
5. **所有代码文件必须以 Apache-2.0 文件头开始（强制，无例外）** —— 覆盖 `src/**` 下的
   `.ts` / `.js` / `.mjs` / `.cjs` / `.vue` / `.css` / `.html` / `.py` / `.toml`，
   测试（`__tests__/**`）、基准、脚本（`scripts/**`）与构建配置同样适用。新建文件的第一步
   就是写入这 4 行（注释语法按语言调整）：

   ```ts
   // Copyright (c) 2025 Smart Site Team
   // SPDX-License-Identifier: Apache-2.0
   // https://smartsite.top/
   // Contact: zkxxa@qq.com, zcwebms@gmail.com
   ```

   - 语言差异：Python / TOML / YAML 用 `#`；HTML 与 Vue 的 `<template>` 顶部用
     `<!-- … -->`；CSS 用 `/* … */`。
   - `package.json` 等 JSON 文件不能写注释，但必须在 `license` 字段声明 `Apache-2.0`。
   - 修改既有文件时不得删除或改动该文件头；新增文件必须补上。
   - 提交前自检（应无输出）：

     ```bash
     grep -rl --include='*.ts' --include='*.vue' --include='*.py' \
       -L 'SPDX-License-Identifier: Apache-2.0' packages/*/src __tests__ scripts
     ```

6. **错误处理**：抛 `RtdbError` 并携带 `ERROR_CODE`（`packages/core/src/errors.ts`），
   服务端经 `ERROR_CODE_HTTP_STATUS` 映射为 HTTP 状态；路由层问题用 `HttpFailure`。
   禁止抛裸字符串。
7. **数据面 API 变更必须同时改两个 SDK**（Node 与 Python 保持契约一致）。
8. **一个 `dataDir` 同一时刻只能被一个进程打开**（`{dataDir}/lock`）；`size` / `repair` /
   `restore` / `archive`、以及不带 `days` 的 `retention` 属于离线命令，必须在服务停止后执行，
   否则返回 `E_DB_LOCKED`。
9. **Python SDK 仅使用标准库**（`urllib`、`json`…），不得引入 `requests` / `numpy`。

## 5. 代码约定

- 编译选项（`src/tsconfig.base.json`）：`target/lib` ES2023、`module` NodeNext、`strict`、
  `noImplicitOverride`、`noImplicitReturns`、`noFallthroughCasesInSwitch`、`noUnusedLocals`、
  `noUnusedParameters`、`useDefineForClassFields`。
- 代码中的**注释与标识符为英文**；文档内容放 `docs-o/`。
- 数据类型边界：`i64` 限 ±2^53（安全整数）；`string` 值 ≤256 字节 UTF-8；指标名 ≤512 字节；
  时间戳为毫秒 epoch（行协议纳秒会被截断为毫秒）；数据库名匹配 `^[a-zA-Z][a-zA-Z0-9_]{0,62}$`。
- 查询只有四个原语：`range` / `last` / `count` / `aggregate`；`aggregate` 的 `avg` 是
  **时间加权平均**（等权平均请客户端自算 `sum / count`）。

## 6. 测试与基准

- 测试套件位于 `src/__tests__/`，使用内置 `node:test`：`primitives`、`encoder`、`format`、
  `segment`、`segment-writer`、`segment-reader`、`wal-recovery`、`write-path`、
  `memory-index`、`pool`、`retention`、`engine`、`server`、`client`、`cli`。
- 基准在 `src/__tests__/benchmark/`（B1 压缩、B2 吞吐、B3 区间延迟、B4 跨日、B5 端点分解、
  B6 满负载、POWER-LOSS 掉电注入）。用 `RTDB_BENCH_SCALE=small npm run bench` 可缩短运行。
- 验收阈值：写入 ≥50 000 点/s 且 P99 <500 ms；16 384 点整块压缩 ≥10×；
  单指标 7 天区间查询 ≤300 ms（冷）/ ≤50 ms（热）；1 000 次掉电注入零损坏。
- 跨平台环境噪声会把回归失败降级为警告，不要因此“调松”阈值。

## 7. 文档同步（强制）

- 任何行为、配置项、HTTP 接口、CLI 子命令、SDK 签名变更，都必须**同时**更新
  `docs-o/en/<页>.md` 与 `docs-o/zh/<页>.md`（两套页码一一对应：`README` + `01`…`09`）。
- 新增/删除页面时，同步更新 `docs-o/en/README.md` 与 `docs-o/zh/README.md` 的索引表，
  以及仓库根 `README.md` 的双语文档索引表。
- **每次修改任何文档都必须在被改页面末尾追加一行修订记录（强制，无例外）**：
  - 中文文档（`docs-o/zh/**`、根 `README.md`、`AGENTS.md`）→ 章节标题 `## 更新日志`；
  - 英文文档（`docs-o/en/**`）→ 章节标题 `## Revision history`。
  - 表格固定三列：中文为「日期 | 变更 | 处理模型」，英文为 `Date | Change | Model`；
    「处理模型」填写实际执行本次修改的模型名称（例如 `DeepSeek-V4.1-Flash`）。
  - 新建页面时即在末尾创建该章节并写入首行记录；**只允许追加，不得改写或删除既有历史行**。
  - 提交前自检（中文文档与英文文档的计数应分别等于文档总数）：

    ```bash
    git grep -c '^## 更新日志' -- docs-o/zh README.md AGENTS.md
    git grep -c '^## Revision history' -- docs-o/en
    ```
- 页内交叉引用使用“§N 小节名”文字描述，不要写基于英文标题生成的锚点。
- 不要把 `docs-e/`、运行时数据（`rtdb-data/`、`*.token`）、`dist/`、`node_modules/` 提交入库。

## 8. 变更工作流（检查清单）

1. 引擎行为改 `packages/core/src/`；协议 / HTTP 改 `packages/server/src/`；保持引擎无 HTTP 概念。
2. 新的公开符号从对应包的 `index.ts` 导出。
3. 在 `src/__tests__/` 增加测试（新行为必须有覆盖）。
4. 若属于数据面，同时更新 Node 与 Python SDK。
5. 新增 `rtdbctl` 子命令：在 `packages/cli/src/commands.ts` 的 `COMMANDS` 与 `USAGE_TEXT`
   中注册，并明确选择在线（HTTP）或离线（本地 dataDir）传输方式。
6. 更新 `docs-o/en/` 与 `docs-o/zh/` 对应页面（见 §7）。
7. 提交前运行：`npm run typecheck && npm test && npm run check:deps`；
   涉及写入路径、编码器、段格式或调度时加 `npm run bench:regression`。
8. 发布前：`npm run build`，并确认 Apache-2.0 文件头检查无输出。

## 9. 提交与远端推送

本仓库配置了两个远端，内容需保持一致：

| 远端 | 地址 | 分支 | 说明 |
| ---- | ---- | ---- | ---- |
| `origin` | `https://github.com/smartsite-ss/ss-rtdb.git` | `main` | 本地 `main` 跟踪 `origin/main` |
| `gitee` | `https://gitee.com/stuhu/ss-rtdb.git` | `master` | 需显式指定分支推送 |

```bash
git push                                # GitHub
git push gitee main:master              # Gitee（否则 git 会推 origin）
```

- 提交信息沿用现行风格，使用前缀说明类型，例如
  `feat(core): …`、`fix(server): …`、`docs: …`、`test: …`。
- 若本机网络把 `github.com` 解析到不可达 IP（表现为 `Failed to connect to github.com port 443`
  或 `Recv failure: Connection was reset`），可临时绕过解析，无需改任何 git 配置：

  ```bash
  git -c "http.curloptResolve=github.com:443:140.82.113.4" push origin main
  # 备选 IP：140.82.112.4 / 140.82.114.4
  ```

## 10. 运行时注意事项

- 服务默认监听 `127.0.0.1:6180`，数据根默认 `./rtdb-data`（相对启动目录），
  首次启动会生成令牌文件 `./rtdb.token`（`0600`，所有写入/查询都需要它）。
- `auth.enabled` 默认开启；非回环监听必须保持鉴权开启，否则启动失败（`E_AUTH`）。
- 无需鉴权的观测端点：`GET /healthz`、`GET /api/v1/status`、`GET /metrics`（Prometheus）。
- Web 控制台在 `/admin/`（结尾斜杠必需），需先 `npm run build --workspace @ss/rtdb-admin`，
  否则返回 404。
- 已忽略的本地产物：`node_modules/`、`dist/`、`tsbuildinfo`、`*.log`、`rtdb-data/`、`*.token`、
  `coverage/`、`bench-out/`、Python 缓存目录、`docs-e/`。

---

## 更新日志

| 日期 | 变更 | 处理模型 |
| ---- | ---- | -------- |
| 2026-10-17 | 创建本文件（面向 AI 编码代理的仓库指南）；同日补充 §7「中文文档更新日志」规则 | DeepSeek-V4.1-Flash |
| 2026-10-17 | §4 强化「所有代码文件必须带 Apache-2.0 文件头」；§7 修订记录规则扩展至中英全部文档；补齐 `src/packages/admin/index.html` 文件头 | DeepSeek-V4.1-Flash |
