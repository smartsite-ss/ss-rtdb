# ss-rtdb — 文档（中文）

**ss-rtdb** 是一个面向工业与物联网场景的通用轻量级实时 / 时序数据库。它以**两种形态**发布，
两种形态共享**同一个引擎**和**同一套磁盘数据格式**：

| 形态 | 包 / 可执行文件 | 形态特征 | 可类比 |
| ---- | ---------------- | -------- | ------ |
| **A — 嵌入式库** | `@ss/rtdb-core` | 进程内直接调用引擎，无网络、无部署 | SQLite |
| **B — 独立服务** | `rtdb-server`（配套 `rtdbctl`、SDK、Web 控制台） | 单进程暴露 HTTP API，支持多客户端、多语言 | InfluxDB |

由于两种形态使用相同的数据目录格式，你可以先以嵌入式方式起步，之后把整个目录交给
`rtdb-server`，**无需任何迁移**。

---

## 1. 能力概览

- **写入**：兼容 InfluxDB Line Protocol *以及* JSON 批量写入；目标吞吐 ≥5 万点/秒。
- **查询**：只有四个原语 —— `range`、`last`、`count`、`aggregate`
  （`avg` / `sum` / `min` / `max` / `count` / `last`）。
- **存储**：一天一个目录，目录内是按容量滚动的段文件；块编码采用
  Gorilla / delta-of-delta / RLE / 字典编码（整块压缩比 ≥10 倍）。
- **持久化**：WAL + 每块 CRC；已封存（sealed）的段不可变；注入掉电测试显示零损坏。
- **运维**：按整日目录做保留策略、冷归档（`tar.gz`）、拷目录即备份、离线修复，
  内置 status / Prometheus 指标 / 存活探针。
- **零运行时依赖**：引擎、服务、CLI 和两个 SDK 除 Node / Python 标准库外不依赖任何东西；
  无原生模块，无 `.node` / `.exe` 产物。
- **多用户**：角色 `admin` / `write` / `readonly`，scrypt 口令哈希，可吊销的 API 令牌。

### 非目标（设计使然）

仅支持单节点（当前版本不提供集群）；没有 SQL 引擎、没有 JOIN、没有事务，
除“一库一目录”的隔离外不支持多租户。

---

## 2. 文档索引

| # | 文档 | 当你想……时阅读 |
| - | ---- | -------------- |
| 01 | [安装](./01-installation.md) | 安装前置依赖、从源码构建、验证构建结果 |
| 02 | [配置](./02-configuration.md) | 配置端口、数据目录、鉴权、保留策略、存储、日志 |
| 03 | [运行服务与 `rtdbctl` CLI](./03-running-and-cli.md) | 启停服务；使用全部 CLI 子命令 |
| 04 | [HTTP API](./04-http-api.md) | 直接调用 REST 接口（curl / 任意语言） |
| 05 | [客户端 SDK（Node 与 Python）](./05-client-sdks.md) | 从应用代码集成 |
| 06 | [嵌入式引擎（形态 A）](./06-embedded-engine.md) | 把引擎嵌入自己的 Node 进程 |
| 07 | [Web 管理控制台](./07-web-admin.md) | 使用 / 部署浏览器管理控制台 |
| 08 | [运维与维护](./08-operations.md) | 备份、恢复、归档、保留策略、修复、监控 |
| 09 | [开发者指南](./09-developer-guide.md) | 仓库结构、测试、基准、贡献方式 |

新用户建议按 **01 → 03 → 04** 阅读；运维人员建议按 **02 → 08** 阅读。

---

## 3. 五分钟快速上手

前置条件：**Node.js ≥ 24**（源码通过 Node 原生 TypeScript 类型剥离直接运行）与 npm。

```bash
# 1. 获取源码并安装工作区依赖
cd ss-rtdb/src
npm install

# 2. 构建引擎与 Node SDK（服务和 CLI 依赖它们）
npm run build --workspace @ss/rtdb-core
npm run build --workspace @ss/rtdb-client

# 3. 前台启动服务
npm start --workspace @ss/rtdb-server
# -> rtdb-server started: http://127.0.0.1:6180 (dataDir=./rtdb-data)
```

首次启动且开启了鉴权（默认开启）、又未配置令牌时，服务会**自动生成令牌并写入 `./rtdb.token`**
（权限 `0600`）。读取它：

```bash
cat rtdb.token          # Linux / macOS
type rtdb.token         # Windows cmd
```

写入两个点（行协议），再读回来：

```bash
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

无需凭据的健康检查：

```bash
curl http://127.0.0.1:6180/healthz     # {"status":"ok"}
curl http://127.0.0.1:6180/api/v1/status
curl http://127.0.0.1:6180/metrics     # Prometheus 暴露格式
```

Web 控制台地址：<http://127.0.0.1:6180/admin/>（需要先构建 `admin` 包，见
[07](./07-web-admin.md)）。

---

## 4. 仓库结构

```
ss-rtdb/
├── src/                         # npm 工作区根目录（package.json 在此）
│   ├── packages/
│   │   ├── core/                # @ss/rtdb-core      — 引擎，零依赖
│   │   ├── server/              # @ss/rtdb-server    — 形态 B 的 HTTP 服务（rtdb-server）
│   │   ├── client-node/         # @ss/rtdb-client    — Node.js SDK
│   │   ├── client-python/       # ss-rtdb-client     — Python SDK（仅标准库）
│   │   ├── cli/                 # @ss/rtdb-cli       — rtdbctl
│   │   └── admin/               # @ss/rtdb-admin     — Vue 3 Web 控制台（私有包）
│   ├── __tests__/               # 单元 / 集成测试
│   ├── scripts/                 # 依赖审计、吞吐回归门禁
│   └── package.json             # 工作区根脚本
└── docs-o/
    ├── en/                      # 英文文档
    └── zh/                      # 本中文文档
```

---

## 5. 数据模型速览

```
数据根目录（dataDir）
 └── database            # 首次写入时自动创建；目录级隔离
      └── metric         # 扁平名称，如 "station01.powerMeter.kwh"；值类型由首次写入锁定
           └── point { timestamp: 毫秒 epoch, value: f64 | i64 | bool | string, quality?: u8 }
```

- **值类型**：`f64`、`i64`、`bool`、`string`。指标首次写入即锁定类型，后续类型不符返回
  `E_TYPE_MISMATCH`。
- **i64** 限制在 ±2^53，以保证 SDK 侧数值精确；**string** 值上限 256 字节 UTF-8；
  **指标名**上限 512 字节 UTF-8。
- **时间戳**为毫秒 epoch。行协议时间戳是纳秒，会被截断为毫秒。
- **数据库名**：首字符为字母，其后为字母 / 数字 / `_`，最长 63 个字符。

---

## 6. 许可证与联系方式

Apache License 2.0。每个源文件都带有标准 Apache-2.0 文件头；提交补丁前请先阅读
[09 — 开发者指南](./09-developer-guide.md) 的 §6 编码规范。

- 网站：<https://smartsite.top/>
- 联系：zkxxa@qq.com，zcwebms@gmail.com
