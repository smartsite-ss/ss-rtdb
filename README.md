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
| 10 | [Smart Site 数据模拟客户端](./docs-o/zh/10-smart-site-demo.md) | [Smart Site demo client](./docs-o/en/10-smart-site-demo.md) |
| 11 | [存储格式与写入路径（细化设计）](./docs-o/zh/11-segment-format.md) | [Storage format & write path](./docs-o/en/11-segment-format.md) |

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

控制台首次打开即为登录页：首启且用户目录为空时会自动创建默认管理员 `admin` / `ss-rtdb`
（见文档 02 §6.4），登录后即用其换取 API 令牌；也可以直接调登录端点：

```bash
curl -X POST http://127.0.0.1:6180/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"ss-rtdb"}'
```

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

## 在线演示

仓库附带一个已部署的公开实例，无需本地安装即可体验 Web 控制台与 HTTP API：

| 项目 | 地址 / 说明 |
| ---- | ----------- |
| 站点入口 | <https://smartsite.top:8081/>（302 跳转控制台） |
| Web 控制台 | <https://smartsite.top:8081/admin/> |
| 登录账号 | `admin` / `ss-rtdb`（首启引导管理员，登录后请立即修改密码） |
| 数据浏览 | 数据库 `smart_site_remote`：44 个模拟指标（f64 / i64 / bool / string 四类值型，1 秒采样） |
| 免鉴权观测端点 | `/healthz`、`/api/v1/status`、`/metrics`（Prometheus） |
| 接口文档 | `/api/docs`（OpenAPI JSON：`/api/docs/openapi.json`） |

```bash
curl https://smartsite.top:8081/healthz
curl https://smartsite.top:8081/api/v1/status
```

> 该端口为 **TLS-only**：`http://…:8081` 会握手失败（`wrong version number`），请使用 `https://`。
> 查询与写入需要令牌（控制台登录即用其换取）；示例数据由本仓库的模拟客户端写入，可随时重跑覆盖：

```bat
cd f:\work\smartdata\202603_trace\trunk\code\ss-rtdb
bin\start-demo-server.bat remote smartsite.top:8081 --duration 60 --interval 1000
```

位置参数目标地址、令牌解析顺序与退出码含义见[文档 10 §3.5](./docs-o/zh/10-smart-site-demo.md)。

## 仓库结构

```
ss-rtdb/
├── bin/                         # 启动 / 打包脚本（start-server / build-release / build-sea ...）
├── conf/                        # rtdb-server.json —— 服务端默认配置（由工作目录自动加载）
├── src/                         # npm 工作区根目录（所有 npm 命令在此执行）
│   └── packages/
│       ├── core/                # @ss/rtdb-core      — 引擎，零运行时依赖
│       ├── server/              # @ss/rtdb-server    — 形态 B 的 HTTP 服务（rtdb-server）
│       ├── cli/                 # @ss/rtdb-cli       — rtdbctl
│       ├── admin/               # @ss/rtdb-admin     — Vue 3 Web 控制台
│       └── demo/                # 演示与测试客户端（npm 工作区）+ 统一配置
│           ├── client-node/     # @ss/rtdb-client    — Node.js SDK
│           ├── client-python/   # ss-rtdb-client     — Python SDK（仅标准库）
│           ├── client-smart-site/ # Smart Site 实时数据模拟客户端
│           └── conf/            # rtdb-server.json / client-smart-site.json
└── docs-o/
    ├── en/                      # 英文文档
    └── zh/                      # 中文文档
```

## 许可证与联系

Apache License 2.0 —— 每个源文件都带有标准 Apache-2.0 文件头；提交补丁前请先阅读
[开发者指南 §6 编码规范](./docs-o/zh/09-developer-guide.md)。

- 网站：<https://smartsite.top/>
- 联系：zkxxa@qq.com，zcwebms@gmail.com

---

## 更新日志

| 日期 | 变更 | 处理模型 |
| ---- | ---- | -------- |
| 2026-10-17 | 由两行占位改写为项目门面：简介与形态对照、能力概览、中英对照文档索引、快速上手、仓库结构、许可与联系 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 文档索引新增 10 — Smart Site 数据模拟客户端（中英对照） | DeepSeek-V4.1-Flash |
| 2026-10-17 | 快速上手补充控制台登录：首启默认管理员 `admin` / `ss-rtdb` 与 `POST /api/v1/auth/login` 示例 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 仓库结构补充 `bin/` 与 `conf/`（服务端默认配置 `conf/rtdb-server.json`，运行时自动加载） | DeepSeek-V4.1-Flash |
| 2026-10-17 | 文档索引新增 11 — 存储格式与写入路径（细化设计，中英对照） | GLM-5.3-Flash |
| 2026-10-18 | 新增「在线演示」章节：公开实例 <https://smartsite.top:8081/> 的控制台入口、默认管理员、示例数据库 `smart_site_remote`、观测端点与接口文档，并说明端口为 TLS-only、模拟数据可由 `bin\start-demo-server.bat remote` 重新生成 | DeepSeek-V4.1-Flash |
