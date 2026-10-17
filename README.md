# ss-rtdb

面向工业与物联网场景的**轻量级实时 / 时序数据库**。一套引擎、两种形态、零运行时依赖。

`ss-rtdb` 以**嵌入式库**或**独立服务**两种形态提供，两者共享同一个引擎与同一套磁盘数据格式 ——
可以先在进程内嵌入式使用，之后把数据目录直接交给服务端，**无需任何迁移**。

| 形态 | 包 / 可执行文件 | 形态特征 | 可类比 |
| ---- | ---------------- | -------- | ------ |
| **A — 嵌入式库** | `@ss/rtdb-core` | 进程内直接调用引擎，无网络、无部署 | SQLite |
| **B — 独立服务** | `rtdb-server`（配套 `rtdbctl`、SDK、Web 控制台） | 单进程暴露 HTTP API，多客户端、多语言 | InfluxDB |

## 能力概览

- **写入**：兼容 InfluxDB Line Protocol，同时支持 JSON 批量写入；目标吞吐 ≥5 万点/秒，写入按
  `(指标, 时间戳)` 幂等，可安全重试。
- **查询**：只有四个原语 —— `range`、`last`、`count`、`aggregate`
  （`avg` / `sum` / `min` / `max` / `count` / `last`，其中 `avg` 为时间加权平均）。
- **存储**：一天一个日目录，目录内按容量滚动段文件；块编码采用 Gorilla / delta-of-delta /
  RLE / 字典编码，整块压缩比 ≥10 倍。
- **持久化**：WAL + 每块 CRC 校验；已封存的段不可变；掉电注入测试零损坏。
- **运维**：按整日目录做保留策略、冷归档（`tar.gz`）、拷目录即备份、离线修复，
  内置 status / Prometheus 指标 / 存活探针。
- **零运行时依赖**：引擎、服务、CLI 与两个 SDK 仅依赖 Node / Python 标准库，
  无原生模块、无 `.node` / `.exe` 产物。
- **多用户**：角色 `admin` / `write` / `readonly`，scrypt 口令哈希，可吊销的 API 令牌。

> 设计上的非目标：仅支持单节点（当前版本不提供集群）；没有 SQL 引擎、JOIN、事务，
> 除“一库一目录”隔离外不支持多租户。

## 文档

中文为完整译本，英文为原始文档，两套逐页对应：

| # | 中文文档 | English docs |
| - | -------- | ------------ |
| — | [文档首页](./docs-o/zh/README.md) | [Docs home](./docs-o/en/README.md) |
| 01 | [安装](./docs-o/zh/01-installation.md) | [Installation](./docs-o/en/01-installation.md) |
| 02 | [配置](./docs-o/zh/02-configuration.md) | [Configuration](./docs-o/en/02-configuration.md) |
| 03 | [运行服务与 `rtdbctl` CLI](./docs-o/zh/03-running-and-cli.md) | [Running the server & `rtdbctl`](./docs-o/en/03-running-and-cli.md) |
| 04 | [HTTP API](./docs-o/zh/04-http-api.md) | [HTTP API](./docs-o/en/04-http-api.md) |
| 05 | [客户端 SDK（Node 与 Python）](./docs-o/zh/05-client-sdks.md) | [Client SDKs](./docs-o/en/05-client-sdks.md) |
| 06 | [嵌入式引擎（形态 A）](./docs-o/zh/06-embedded-engine.md) | [Embedded engine](./docs-o/en/06-embedded-engine.md) |
| 07 | [Web 管理控制台](./docs-o/zh/07-web-admin.md) | [Web admin console](./docs-o/en/07-web-admin.md) |
| 08 | [运维与维护](./docs-o/zh/08-operations.md) | [Operations & maintenance](./docs-o/en/08-operations.md) |
| 09 | [开发者指南](./docs-o/zh/09-developer-guide.md) | [Developer guide](./docs-o/en/09-developer-guide.md) |

新用户建议按 **01 → 03 → 04** 阅读；运维人员建议按 **02 → 08** 阅读。

## 快速上手

要求：**Node.js ≥ 24**（源码通过 Node 原生 TypeScript 类型剥离直接运行）与 npm。

```bash
# 1. 安装工作区依赖（npm 工作区根目录是 src/）
cd src
npm install

# 2. 启动服务（前台）
npm start --workspace @ss/rtdb-server
# -> rtdb-server started: http://127.0.0.1:6180 (dataDir=./rtdb-data)
```

首次启动且开启了鉴权（默认）时，服务会生成令牌并写入 `./rtdb.token`：

```bash
cat rtdb.token          # Linux / macOS
type rtdb.token         # Windows cmd

TOKEN=$(cat rtdb.token)

curl -X POST "http://127.0.0.1:6180/api/v1/write?db=plant_a" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary $'station01.powerMeter.kwh 1024.5\nstation01.powerMeter.kwh 1030.25'

curl -X POST "http://127.0.0.1:6180/api/v1/query/last" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricName":"station01.powerMeter.kwh"}'
```

无需凭据的健康检查：`/healthz`、`/api/v1/status`、`/metrics`（Prometheus）。
Web 控制台：<http://127.0.0.1:6180/admin/>（需先构建 `admin` 包，见文档 07）。

嵌入式用法（形态 A）：

```ts
import { RtdbEngine } from '@ss/rtdb-core';

const rtdb = new RtdbEngine({ dataDir: './rtdb-data' });
await rtdb.open();
await rtdb.writeBatch('plant_a', [
  { metricName: 'station01.powerMeter.kwh', timestamp: Date.now(), value: 1024.5 },
]);
await rtdb.close();
```

## 仓库结构

```
ss-rtdb/
├── src/                         # npm 工作区根目录（所有 npm 命令在此执行）
│   └── packages/
│       ├── core/                # @ss/rtdb-core      — 引擎，零运行时依赖
│       ├── server/              # @ss/rtdb-server    — 形态 B 的 HTTP 服务（rtdb-server）
│       ├── client-node/         # @ss/rtdb-client    — Node.js SDK
│       ├── client-python/       # ss-rtdb-client     — Python SDK（仅标准库）
│       ├── cli/                 # @ss/rtdb-cli       — rtdbctl
│       └── admin/               # @ss/rtdb-admin     — Vue 3 Web 控制台
└── docs-o/
    ├── en/                      # 英文文档
    └── zh/                      # 中文文档
```

## 许可证与联系

Apache License 2.0 —— 每个源文件都带有标准 Apache-2.0 文件头；提交补丁前请先阅读
[开发者指南 §6 编码规范](./docs-o/zh/09-developer-guide.md)。

- 网站：<https://smartsite.top/>
- 联系：zkxxa@qq.com，zcwebms@gmail.com
