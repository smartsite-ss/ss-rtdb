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
| 启动服务（源码树） | `npm start --workspace @ss/rtdb-server`（等价 `node packages/server/src/main.ts`） |
| 启动服务（仓库或发布包，推荐） | `bin\start-server.bat` |
| 生成发布包（输出到 `release\ss-rtdb-<version>\`） | `bin\build-release.bat`（可指定版本：`bin\build-release.bat 0.2.0`） |
| 生成单文件 exe（Node SEA，输出 `release\sea\rtdb-server.exe`） | `bin\build-sea.bat` |
| 使用 CLI / rtdbctl 包装脚本 | `node packages/cli/src/main.ts status`、`npx rtdbctl status`、`bin\rtdbctl.bat status` |
| 运行 Smart Site 模拟客户端（写入实时数据） | `npm run demo:smart-site -- --once --verify`；Windows 包装：`bin\demo-smart-site.bat list` / `bin\demo-smart-site.bat stream 60`（见文档 10） |
| 启动演示服务器（读取 `demo/conf` 统一配置） | `bin\start-demo-server.bat`（端口被占用时 `set RTDB_PORT=6190`） |
| 控制台开发服务器 | `npm run dev --workspace @ss/rtdb-admin` |
| Python SDK 测试 | `cd packages/demo/client-python` 后 `python -m pytest tests/` |

注意：`server` 与 `cli` 包**没有 `build` 脚本**（直接运行 `.ts`）；`npm run build` 只构建
`core`、`client-node`、`admin`。仓库没有 linter / formatter，类型检查 + 测试即为质量门禁。

**SEA 单文件 exe（`bin\build-sea.bat`）要点**

- 单文件只包含代码：`admin\dist`（Web 控制台）与 `rtdb-data\`（数据根）**按设计外置**在 exe 同目录。
- `server.ts` 用 `import.meta.url` 定位控制台，而 SEA 快照内没有模块 URL：打包时该引用被重写，
  使默认控制台路径解析为 `<exe 目录>\admin\dist`（因此不要移动 `admin\` 目录）。
- 首次构建需要联网（`postject` 安装到 `bin\.sea-tools`，已 gitignore）；产物约 89 MB，
  中间产物保留在 `release\sea\.build\` 便于排查。
- 已验证：`PATH` 中不含 Node 时 exe 可独立运行，写入 / 查询 / `/admin/` 均正常。
- **重新构建前必须先停掉运行中的 `rtdb-server.exe`**：Windows 不允许覆盖正在执行的镜像，
  否则注入阶段报 `EBUSY: resource busy or locked`（脚本已给出「先停止实例再重试」的明确提示）。

## 3. 仓库布局与依赖方向

```
ss-rtdb/
├── src/                      # npm 工作区根目录（package-lock.json 已入库）
│   ├── packages/
│   │   ├── core/             # @ss/rtdb-core     引擎，零依赖（dependencies: {}）
│   │   ├── server/           # @ss/rtdb-server   HTTP 外壳，依赖 core；bin: rtdb-server
│   │   ├── cli/              # @ss/rtdb-cli      bin: rtdbctl，依赖 client-node/core/server
│   │   ├── admin/            # @ss/rtdb-admin    Vue 3 + Vite 控制台（private）
│   │   └── demo/             # 演示与测试客户端（npm 工作区）+ conf/ 统一配置
│   │       ├── client-node/  # @ss/rtdb-client   纯 HTTP SDK，零依赖
│   │       ├── client-python/# ss-rtdb-client    Python SDK，仅标准库
│   │       ├── client-smart-site/ # Smart Site 实时数据模拟客户端
│   │       └── conf/         # rtdb-server.json / client-smart-site.json
│   ├── __tests__/            # node:test 套件（*.test.ts）+ benchmark/
│   └── scripts/              # check-runtime-dependencies.ts、check-throughput-regression.ts
├── conf/                     # rtdb-server.json —— 服务端默认配置（工作目录存在时自动加载）
├── bin/                      # 发布 / 启动批处理脚本（.bat 规则见 §4 第 10 条）
│   ├── build-release.bat     #   构建并打包到 release\ss-rtdb-<version>\
│   ├── build-sea.bat         #   生成单文件 release\sea\rtdb-server.exe（Node SEA）
│   ├── start-server.bat      #   前台启动服务（仓库与发布包通用）
│   ├── rtdbctl.bat           #   rtdbctl 包装脚本
│   ├── demo-smart-site.bat   #   Smart Site 模拟客户端包装（list/dry/once/stream/run）
│   ├── start-demo-server.bat #   按 packages/demo/conf/rtdb-server.json 启动演示服务器
│   └── sea\build-sea.mjs     #   SEA 实现：esbuild bundle + --experimental-sea-config + postject
├── release/                  # 发布产物（build-release.bat 生成，**不入库**）
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
     `<!-- … -->`；CSS 用 `/* … */`；Windows 批处理（`.bat` / `.cmd`）用 `REM`。
   - `package.json` 等 JSON 文件不能写注释，但必须在 `license` 字段声明 `Apache-2.0`。
   - 修改既有文件时不得删除或改动该文件头；新增文件必须补上。
   - 提交前自检（应无输出）：

     ```bash
     grep -rl --include='*.ts' --include='*.vue' --include='*.py' \
       -L 'SPDX-License-Identifier: Apache-2.0' packages/*/src packages/demo/*/src __tests__ scripts
     ```

6. **错误处理**：抛 `RtdbError` 并携带 `ERROR_CODE`（`packages/core/src/errors.ts`），
   服务端经 `ERROR_CODE_HTTP_STATUS` 映射为 HTTP 状态；路由层问题用 `HttpFailure`。
   禁止抛裸字符串。
7. **数据面 API 变更必须同时改两个 SDK**（Node 与 Python 保持契约一致）。
8. **一个 `dataDir` 同一时刻只能被一个进程打开**（`{dataDir}/lock`）；`size` / `repair` /
   `restore` / `archive`、以及不带 `days` 的 `retention` 属于离线命令，必须在服务停止后执行，
   否则返回 `E_DB_LOCKED`。
9. **Python SDK 仅使用标准库**（`urllib`、`json`…），不得引入 `requests` / `numpy`。
10. **`bin/` 下的批处理脚本（`.bat` / `.cmd`）必须内容全英文 + UTF-8 编码（强制）**：
    - 注释、`echo`、错误提示、变量名等一律使用英文，**不得出现中文**（cmd 代码页差异会导致
      输出与解析乱码）。
    - 文件编码必须为 **UTF-8**（推荐 `UTF-8 with BOM`）；**禁止** GBK / ANSI、
      UTF-16 / UTF-16LE / UTF-16BE。
    - 行尾必须为 **CRLF**（不得写为 LF）。
    - 文件头同样使用 Apache-2.0 注释，关键字为 `REM`：

      ```bat
      REM Copyright (c) 2025 Smart Site Team
      REM SPDX-License-Identifier: Apache-2.0
      REM https://smartsite.top/
      REM Contact: zkxxa@qq.com, zcwebms@gmail.com
      ```

    - 提交前自检（`nonASCII` 必须为 0；`BOM` 应为 True 或 False 但编码必须是 UTF-8）：

      ```powershell
      Get-ChildItem bin/*.bat | ForEach-Object {
        $b = [IO.File]::ReadAllBytes($_.FullName)
        $bom = ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
        "{0}: BOM={1} nonASCII={2}" -f $_.Name, $bom, ($b | Where-Object { $_ -gt 0x7F }).Count
      }
      ```

11. **后台代码注释一律英文（强制，无例外）**：
    - 适用范围：所有非前端代码——`src/packages/{core,server,cli,client-node}/src/**`、
      `src/packages/demo/**`、`src/__tests__/**`、`src/scripts/**`、`bin/**`、构建配置与 README 之外的
      代码文件；含注释、JSDoc、日志文案、错误信息、变量/函数/类型命名。
    - 中文只允许出现在 `docs-o/`、`docs-e/`、根 `README.md`、`AGENTS.md` 与前端语言包
      `src/packages/admin/src/locales/zh.ts`（以及未来的其它 `locales/zh*.ts`）中。
    - 提交前自检（应为空；命中即需改写为英文）：

      ```bash
      grep -rnP '[\x{4e00}-\x{9fff}]' --include='*.ts' src/packages/*/src \
        | grep -v '/locales/zh' | grep -v '^src/packages/admin/'
      ```

12. **前端必须支持多语言（强制，无例外）**：
    - 所有前端界面（当前为 `src/packages/admin`）的**用户可见文案**必须取自 i18n 语言资源，
      禁止在 `.vue` / `.ts` 中硬编码整句中文或英文（`console` 调试日志、`code`/`mono` 展示的
      协议字段名、HTTP 路径与错误码除外）。
    - **默认语言为英文（`en`）**，必须同时提供**中文（`zh`）**；语言选择持久化在浏览器本地
      （`localStorage`），刷新后保持。
    - 新增/修改文案时**必须同时补齐 `en` 与 `zh` 两个键**；缺失键回退到英文并保留键名占位，
      不允许运行时抛错。语言资源按界面域分文件（`locales/en.ts` / `locales/zh.ts`）。
    - 提交前自检（`.vue` 模板与脚本中不应出现成句中文）：

      ```bash
      grep -rnP '[\x{4e00}-\x{9fff}]' --include='*.vue' src/packages/admin/src
      grep -rnP '[\x{4e00}-\x{9fff}]' --include='*.ts' src/packages/admin/src \
        | grep -v '/locales/zh'
      ```

## 5. 代码约定

- 编译选项（`src/tsconfig.base.json`）：`target/lib` ES2023、`module` NodeNext、`strict`、
  `noImplicitOverride`、`noImplicitReturns`、`noFallthroughCasesInSwitch`、`noUnusedLocals`、
  `noUnusedParameters`、`useDefineForClassFields`。
- 代码中的**注释与标识符为英文**（强制口径见 §4 第 11 条）；文档内容放 `docs-o/`；
  前端文案的多语言要求见 §4 第 12 条。
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
- 运行期配置文件：工作目录下的 `conf/rtdb-server.json` 存在时**自动加载**（仓库与发布包都自带，
  内容即内置默认值，可直接改）；`RTDB_CONFIG` / `--config` 指定其他文件时**取代**它而非叠加。
- `auth.enabled` 默认开启；非回环监听必须保持鉴权开启，否则启动失败（`E_AUTH`）。
- 无需鉴权的观测端点：`GET /healthz`、`GET /api/v1/status`、`GET /metrics`（Prometheus）。
- Web 控制台在 `/admin/`（结尾斜杠必需；根路径 `/` 会 302 跳转过去），需先
  `npm run build --workspace @ss/rtdb-admin`，否则返回 404。
- 已忽略的本地产物：`node_modules/`、`dist/`、`tsbuildinfo`、`*.log`、`rtdb-data/`、`*.token`、
  `coverage/`、`bench-out/`、Python 缓存目录、`docs-e/`、`release/`、`bin/.sea-tools/`。

---

## 更新日志

| 日期 | 变更 | 处理模型 |
| ---- | ---- | -------- |
| 2026-10-17 | 创建本文件（面向 AI 编码代理的仓库指南）；同日补充 §7「中文文档更新日志」规则 | DeepSeek-V4.1-Flash |
| 2026-10-17 | §4 强化「所有代码文件必须带 Apache-2.0 文件头」；§7 修订记录规则扩展至中英全部文档；补齐 `src/packages/admin/index.html` 文件头 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增 §4 第 10 条：`bin/` 下 `.bat` / `.cmd` 必须全英文内容、UTF-8 编码、CRLF 行尾、`REM` 形式的 Apache-2.0 文件头；§3 布局补 `bin/`；§4 第 5 条注释语法补 `REM` | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增发布/启动脚本 `bin\build-release.bat`、`bin\start-server.bat`、`bin\rtdbctl.bat`；§2 命令表与 §3 布局同步；§10 忽略清单补 `release/`；`.gitignore` 忽略 `release/` | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增 SEA 单文件打包 `bin\build-sea.bat` + `bin\sea\build-sea.mjs`（esbuild bundle、`import.meta.url` 重写、`postject` 注入、控制台外置）；§2 补命令与 SEA 要点、§3 布局、§10 忽略 `bin/.sea-tools/` | DeepSeek-V4.1-Flash |
| 2026-10-17 | §10 补充根路径 `/` 302 跳转到 `/admin/`（修复 SEA 发布后访问站点根路径返回 `E_NOT_FOUND: Unregistered route: /`） | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增 `packages/demo/client-smart-site` Smart Site 实时数据模拟客户端：§2 命令表、§3 布局补充；文档 10 同步 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增 `bin\demo-smart-site.bat` 包装脚本（list / dry / once / stream / run）；§2 命令表与 §3 布局同步 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增 `packages/demo/conf/` 统一配置（`rtdb-server.json`、`client-smart-site.json`）与 `bin\start-demo-server.bat`；客户端支持 `--config` / `--no-config` | DeepSeek-V4.1-Flash |
| 2026-10-17 | `workspaces` 增加 `packages/demo/*`，`check:deps` 支持嵌套工作区；§2 Python SDK 路径、§3 布局、§4 文件头自检路径同步到 `packages/demo/client-*` | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增运行期配置目录 `conf/`（`rtdb-server.json` 默认配置，工作目录存在时自动加载）；§3 布局与 §10 运行时注意事项同步 | DeepSeek-V4.1-Flash |
| 2026-10-17 | §2 SEA 要点补充：重建 exe 前必须停止运行中的实例，`bin/sea/build-sea.mjs` 对 `EBUSY` 覆盖失败给出明确提示 | DeepSeek-V4.1-Flash |
