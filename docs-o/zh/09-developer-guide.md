# 09 — 开发者指南

## 1. 仓库结构

```
ss-rtdb/
├── src/                              # npm 工作区根目录 —— 所有 npm 命令在此执行
│   ├── package.json                  # 工作区根脚本
│   ├── tsconfig.base.json            # 共享编译选项
│   ├── packages/
│   │   ├── core/                     # @ss/rtdb-core —— 引擎，零运行时依赖
│   │   │   └── src/
│   │   │       ├── engine.ts         #   RtdbEngine 门面（open/close/write/query/manage）
│   │   │       ├── types.ts          #   Point / EngineOptions / 钳制范围
│   │   │       ├── errors.ts         #   ERROR_CODE 总表
│   │   │       ├── format.ts         #   段二进制格式、CRC、文件命名
│   │   │       ├── segment-store.ts  #   日目录 + 容量段生命周期
│   │   │       ├── segment-writer.ts #   缓冲 → 成块 → 追加
│   │   │       ├── segment-reader.ts #   索引查找 → 块解码 → LRU 缓存
│   │   │       ├── wal.ts            #   预写日志
│   │   │       ├── recovery.ts       #   启动恢复
│   │   │       ├── retention.ts      #   保留 / 归档 / 目录拷贝
│   │   │       ├── memory-index.ts   #   指标 → 块位置
│   │   │       ├── lock.ts           #   数据根锁
│   │   │       ├── pool.ts           #   缓冲池
│   │   │       └── encoder/          #   gorilla / int64 / bool / string / timestamp / varint / zlib
│   │   ├── server/                   # @ss/rtdb-server —— HTTP 协议外壳
│   │   │   └── src/{server,config,auth,users,tokens,line-protocol,json-codec,metrics,logger}.ts
│   │   ├── client-node/              # @ss/rtdb-client —— Node SDK（纯 HTTP）
│   │   ├── client-python/            # ss-rtdb-client —— Python SDK（仅标准库）
│   │   ├── cli/                      # @ss/rtdb-cli —— rtdbctl
│   │   │   └── src/{cli,args,commands,local,output}.ts
│   │   └── admin/                    # @ss/rtdb-admin —— Vue 3 控制台（私有包）
│   ├── __tests__/                    # node:test 测试套件 + 基准
│   └── scripts/{check-runtime-dependencies,check-throughput-regression}.ts
└── docs-o/
    ├── en/                           # 英文文档
    └── zh/                           # 本中文文档
```

依赖方向（无环）：

```
admin ──┐
cli ────┼──> server ──> core
        └──> client-node   （仅 HTTP，不含引擎）
```

## 2. npm 脚本（在 `src/` 下执行）

| 命令 | 作用 |
| ---- | ---- |
| `npm install` | 链接各工作区，安装开发工具链 |
| `npm run build` | 构建所有定义了 `build` 的工作区（core、client-node、admin） |
| `npm run typecheck` | 对工作区执行 `tsc --noEmit`，对 admin 执行 `vue-tsc` |
| `npm test` | 用 `node --test` 运行全部 `__tests__/*.test.ts` |
| `npm run test:primitives` / `test:encoder` | 单个测试套件 |
| `npm run bench` | 运行基准套件 |
| `npm run bench:regression` | 与记录的基线比较吞吐 |
| `npm run check:deps` | 断言运行时闭包不含第三方 / 原生依赖 |

直接启动也行（Node ≥ 24 原生剥离类型，无需构建步骤）：

```bash
node packages/server/src/main.ts
node packages/cli/src/main.ts status
```

## 3. 测试

测试套件位于 `src/__tests__/`，使用内置的 `node:test` 运行器：

| 套件 | 覆盖范围 |
| ---- | -------- |
| `primitives`、`encoder` | varint、比特流、各编解码器 |
| `format` | 二进制头部 / 块 / 尾部布局、CRC、文件命名 |
| `segment`、`segment-writer`、`segment-reader` | 段生命周期、滚动、块解码 |
| `wal-recovery`、`write-path` | WAL 追加 / 截断、恢复、回填 |
| `memory-index`、`pool` | 索引与缓冲池 |
| `retention` | 过期、归档、目录拷贝 |
| `engine` | 引擎端到端行为 |
| `server` | HTTP 路由、鉴权 / RBAC、JSON 与行协议、错误映射 |
| `client` | Node SDK 契约 |
| `cli` | `rtdbctl` 子命令与退出码 |

```bash
npm test                                   # 全部
node --test __tests__/engine.test.ts       # 单个文件
```

## 4. 基准测试

```bash
npm run bench
```

| 基准 | 测量内容 |
| ---- | -------- |
| B1 compression | 按值类型与块大小统计压缩比 |
| B2 throughput | 持续点/秒 与 P99 写入延迟 |
| B3 range latency | 冷 / 热区间查询延迟 |
| B4 day rollover | 跨日边界的开销 |
| B5 endpoint diff | 各端点延迟分解 |
| B6 full load | 满负载下的外推行为 |
| POWER-LOSS | 随机掉电注入（子进程）—— 必须零损坏结束 |

规模由 `RTDB_BENCH_SCALE` 控制（例如 `RTDB_BENCH_SCALE=small npm run bench`），以便 CI 跑得更短。

门禁使用的验收阈值：

- 写入吞吐 ≥ 50 000 点/秒，P99 < 500 ms。
- 16 384 点整块压缩比 ≥ 10 倍（小块按原样记录）。
- 单指标 7 天区间查询：冷态 ≤300 ms / 热态 ≤50 ms。
- 1 000 次掉电注入 → 零损坏。

回归门禁：

```bash
npm run bench:regression              # 吞吐下降超过 15% 时失败
npm run bench:regression -- --update-baseline   # 有意变更后重新记录基线
```

跨平台环境噪声只会把失败降级为警告，不会阻塞。

## 5. 依赖策略

`npm run check:deps` 会遍历 `core` / `client-node` / `server` / `cli` 的运行时闭包，
只要发现**任何**第三方包或原生产物（`.node`、`.exe`）就失败。仅开发期使用的工具链
（TypeScript、Vite、Vue）自动豁免。

如果你要新增一个 import，优先选用 Node 内置模块（`node:fs`、`node:crypto`、`node:http`……）。
新增运行时依赖需要充分理由以及有记录的例外说明。

## 6. 编码规范

- **不使用 TS `enum`。** 用 `as const` 对象加字面量联合类型（见 `core/src/types.ts` 中的
  `ValueType`）—— 因为启用了 `erasableSyntaxOnly`。
- **导入 TypeScript 文件时带 `.ts` 扩展名**（`import { X } from './engine.ts'`）；
  已开启 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`。
- 已开启 `verbatimModuleSyntax` —— 纯类型导入请用 `import type { … }`。
- `strict`、`noUnusedLocals`、`noUnusedParameters`、`noImplicitOverride` 全部开启。
- **每个源文件必须以 Apache-2.0 文件头开始：**

```ts
// Copyright (c) 2025 Smart Site Team
// SPDX-License-Identifier: Apache-2.0
// https://smartsite.top/
// Contact: zkxxa@qq.com, zcwebms@gmail.com
```

- 错误处理：抛出带 `ERROR_CODE` 成员的 `RtdbError`；绝不抛裸字符串。服务端通过
  `ERROR_CODE_HTTP_STATUS` 把 `RtdbError` 映射为 HTTP 状态；路由层问题使用 `HttpFailure`。
- 代码中的注释与标识符为英文；文档源文件放在 `docs-o/` 下。

## 7. 新增功能 —— 检查清单

1. 属于引擎行为时在 `packages/core/src/` 实现；属于协议时在 `packages/server/src/` 实现。
   保持引擎不引入任何 HTTP 概念。
2. 在包的 `index.ts` 中导出新的公开符号。
3. 在 `src/__tests__/` 下添加测试。
4. 属于数据面时，在**两个 SDK 中都**镜像该 API（Node 与 Python 必须保持契约一致）。
5. 在 `packages/cli/src/commands.ts` 中新增 `rtdbctl` 子命令（在 `COMMANDS` 与 `USAGE_TEXT`
   中注册），并有意选择在线（HTTP）或离线（本地数据根）传输方式。
6. 更新文档：修改 `docs-o/` 下对应语言的页面。
7. 运行 `npm run typecheck && npm test && npm run check:deps && npm run bench:regression`。

## 8. 发布检查清单

```bash
npm run typecheck
npm test
npm run check:deps
npm run bench:regression
npm run build                       # core、client-node、admin
grep -rl --include='*.ts' -L 'SPDX-License-Identifier: Apache-2.0' packages/*/src   # 必须无输出
```

然后打标签并发布各包（`@ss/rtdb-core`、`@ss/rtdb-client`、`@ss/rtdb-server`、`@ss/rtdb-cli`）
以及 Python 分发包。

## 9. 许可证

Apache License 2.0。贡献按同一许可证接受；请保持文件头完整。
