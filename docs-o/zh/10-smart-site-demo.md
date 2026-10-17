# 10 — Smart Site 数据模拟客户端（`demo/client-smart-site`）

该客户端把**与 Smart Site（`ss-v7/ss-services`）一致的设备 / 标签命名和取值语义**转换成 rtdb 的
指标与点，向 `rtdb-server` 持续写入实时数据。它用于本地联调、写入路径压测、查询与聚合验收，
也可以作为「外部采集系统如何接入 rtdb」的参考实现。

- 目录：`src/packages/demo/client-smart-site/`（每个测试客户端一个目录，与 `client-node`、
  `client-python` 同级）。
- 依赖：**零第三方依赖**，仅使用 Node 内置模块；要求 Node ≥ 24（源码直接运行）。
- 组件：`catalog.ts`（设备 / 标签目录）、`generator.ts`（确定性信号生成器）、`client.ts`
  （极简 HTTP 客户端）、`main.ts`（CLI）。

---

## 1. 数据映射

rtdb 只有 `database → metric → point` 三层，没有标签（tag）维度，因此 Smart Site 的
`projectId / deviceId / tagId` 三元组被折叠成「数据库 + 指标名」：

| Smart Site（`ss-v7/ss-services`） | 本 Demo 中的 rtdb 表达 |
| --------------------------------- | ---------------------- |
| 一个项目（Influx bucket 隔离） | 一个数据库，默认 `smartfactory_demo` |
| `dev_devices.device_code` + `dev_data_tags.path` | 指标名 `<device_code>.<variable>`，如 `hvac-chiller.supply-temp` |
| `dataType` = `float32` / `float` | `f64` |
| `dataType` = `int` / `int32` | `i64`（JSON 写入为十进制字符串 + `"vt": 2`） |
| `dataType` = `bool` | `bool` |
| `dataType` = `string` | `string` |
| 写入 Influx 的 `quality`（0–100） | rtdb v0.1.0 只接受 `q=0`（省略即正常）；非 0 返回 `400 E_INVALID_POINT` |
| `dev_data_tags.scanRate`（通常 1000 ms） | `--interval`（默认 1000 ms） |
| `dev_data_tags.unit` / `name` | 仅用于 `--list` 展示（rtdb 不存单位与显示名） |

要点：

- **指标名就是标签路径**：与 `dev_data_tags.path` 完全一致（小写、连字符分隔），因此同一份
  标签在 Smart Site 与 rtdb 中可以直接对照。
- **值类型首次写入即锁定**：目录中每个标签的类型固定（f64 / i64 / bool / string），模拟器不会
  中途改变类型，避免 `E_TYPE_MISMATCH`。
- **质量位在 v0.1.0 不可用**：Smart Site 用 0–100 的比例式质量，rtdb 用 u8 标志位且 `0` 表示正常；
  当前版本（M0）**拒绝任何非 0 质量位**（`400 E_INVALID_POINT`），以免静默丢失。因此模拟器只在
  通信故障时重复上一采样值（stale），报文始终不带 `q`。

---

## 2. 模拟的站点目录

目录按 `smartfactory-demo` 项目的真实标签构建，共 **9 台设备 / 44 个指标**，覆盖全部四种值类型：

| 分类 | 设备（`deviceCode`） | 主要标签 |
| ---- | ------------------- | -------- |
| 暖通 | `hvac-chiller` / `hvac-chw-pump` / `hvac-tower` | 供回水温度、流量、功率、COP/EER、运行状态（bool） |
| 污水 | `sewage-in` / `sewage-aerobic` / `sewage-pump-lift` | COD、氨氮、pH、浊度、溶解氧、ORP（i64）、液位 |
| 车间能耗 | `ws-a-meter-01` | 电压、电流、功率、累计用电量（计数器） |
| 产线 PLC | `ws-a-plc-01` | 功率、节拍、累计产量（i64）、OEE、运行时间（i64） |
| MES 网关 | `ws-mes-gw-01` | 当前排产工单、MES 回写（string） |

信号模型：

- 模拟量 = 缓慢正弦波 + 有界随机游走，按工程范围钳制并按 `decimalPlaces` 取整；
- 计数器按速率累加（如用电量 = 功率 × 秒 / 3600，累计产量每 25 秒 +1 件）；
- 布尔量按概率翻转，整型状态机（0/1/2）按概率切换，字符串在候选值中切换；
- `--glitch-rate` > 0 时按概率进入短暂「通信故障」：重复上一采样值（stale），不写质量位。

同一 `--seed` + 同一时间戳序列的输出完全可复现，便于回归测试。

查看完整目录：

```bash
cd src
npm run demo:smart-site -- --list
```

---

## 3. 运行

```bash
cd src

# 只打印一个批次的报文（不发送），用于确认格式
npm run demo:smart-site -- --dry-run

# 写一个批次并立即验证（last / count / aggregate / metrics）
npm run demo:smart-site -- --once --verify

# 按 1 秒周期持续写入 60 秒，结束后验证
npm run demo:smart-site -- --duration 60 --verify

# 只模拟暖通设备，500 ms 周期，模拟 0.5% 的通信故障
npm run demo:smart-site -- --devices hvac-chiller,hvac-chw-pump --interval 500 --glitch-rate 0.005
```

`npm run` 需要 `--` 分隔脚本名与参数；也可以直接调用 Node：

```bash
node packages/demo/client-smart-site/src/main.ts --once --verify
```

### 3.1 配置统一管理（`demo/conf/`）

`demo` 下所有服务端与连接配置集中在 `src/packages/demo/conf/`：

| 文件 | 用途 |
| ---- | ---- |
| `rtdb-server.json` | 演示服务器运行配置：端口、监听地址、数据目录、令牌文件、控制台目录、WAL 与日志级别 |
| `client-smart-site.json` | 模拟客户端默认连接与生成参数：`url`、`database`、`tokenFile`、`intervalMs`、`seed`、`devices`、`glitchProbability`、`logEvery`、`timeoutMs` |
| `rtdb.token` | 首次启动时由服务端生成的 Bearer 令牌（`*.token` 已 gitignore） |

- **服务器**：`bin\start-demo-server.bat` 通过 `RTDB_CONFIG` 加载 `rtdb-server.json`；优先级为
  内置默认值 < 配置文件 < 环境变量（`RTDB_PORT`、`RTDB_DATA_DIR` 等）< 显式参数。
- **客户端**：默认自动加载 `client-smart-site.json`；优先级为 内置默认值 < 配置文件 < 命令行参数。
  `--config <path>` 指定其他文件，`--no-config` 跳过配置文件。
- 配置文件中的相对路径按**仓库 `src\` 目录**解析（两个包装脚本都会先切换到该目录）；
  运行期数据位于 `src\packages\demo\data\`（已 gitignore）。
- 客户端配置采用严格校验：未知键或类型错误会直接报错，避免拼写错误被静默忽略。

### 3.2 参数

| 参数 | 默认值 | 说明 |
| ---- | ------ | ---- |
| `--config <path>` | `packages/demo/conf/client-smart-site.json` | 指定客户端配置文件 |
| `--no-config` | 关 | 跳过配置文件，仅使用内置默认值 |
| `--url <url>` | `http://127.0.0.1:6180` | rtdb-server 基地址 |
| `--token <token>` | 空 | Bearer 令牌（优先级最高） |
| `--token-file <path>` | 空 | 显式令牌文件 |
| `--db <name>` | `smartfactory_demo` | 目标数据库，必须匹配 `^[a-zA-Z][a-zA-Z0-9_]{0,62}$` |
| `--interval <ms>` | `1000` | 采样周期，最小 100 ms |
| `--duration <seconds>` | `0` | 运行时长，`0` = 直到 Ctrl+C |
| `--once` | 关 | 只写一个批次后退出 |
| `--seed <int>` | `20261017` | 随机种子，决定信号序列 |
| `--devices <list>` | 全部 | 逗号分隔的设备编码 |
| `--glitch-rate <0..1>` | `0` | 每个采样点进入通信故障的概率 |
| `--verify` | 关 | 结束后查询并校验 |
| `--dry-run` | 关 | 打印一个批次的写入报文，不发送 |
| `--list` | 关 | 打印设备 / 标签目录后退出 |
| `--log-every <n>` | `5` | 每 n 个批次打印一行进度 |
| `--timeout <ms>` | `10000` | 单次 HTTP 超时 |

### 3.3 令牌解析顺序

1. `--token <token>`
2. 环境变量 `RTDB_TOKEN`
3. `--token-file <path>`；未指定时使用配置文件的 `tokenFile`
4. 当前工作目录的 `rtdb.token`
5. 可执行文件所在目录的 `rtdb.token`（SEA 单文件发布时令牌与 exe 同级）

都找不到时以匿名身份运行；若服务端要求鉴权，写入会返回 `401 E_AUTH` 并提示补充令牌。

### 3.4 `bin\` 包装脚本

Windows 下可直接使用 `bin\demo-smart-site.bat`（自动切换到 `src\` 目录并转发参数）：

```bat
bin\start-demo-server.bat
bin\demo-smart-site.bat list
bin\demo-smart-site.bat dry
bin\demo-smart-site.bat once --token-file ..\release\sea\rtdb.token
bin\demo-smart-site.bat stream 60 --glitch-rate 0.002 --token-file ..\release\sea\rtdb.token
bin\demo-smart-site.bat run --devices hvac-chiller --interval 500 --duration 10 --verify
```

- `bin\start-demo-server.bat` 按 `demo\conf\rtdb-server.json` 启动演示服务器；6180 被占用时可用
  `set RTDB_PORT=6190` 覆盖端口；
- `list` / `dry` / `once` / `stream` 为预设动作：`once` 等价于 `--once --verify`；`stream`
  默认运行 60 秒并带 `--verify`（秒数可省略）；
- `run` 原样转发后续参数，`run --help` 可查看客户端完整帮助；
- 未知动作返回退出码 `1`，其余退出码与客户端一致（`0/2/3`）；
- 脚本在 `src\` 中运行，因此相对路径按该目录解析：SEA 发布目录的令牌写作
  `..\release\sea\rtdb.token`。

---

## 4. 写入格式

`--dry-run` 打印的报文就是实际发送的请求体（`POST /api/v1/write?db=smartfactory_demo`）：

```json
[
  { "metricName": "hvac-chiller.supply-temp", "t": 1792224000000, "v": 8.6, "vt": 1 },
  { "metricName": "hvac-chiller.status", "t": 1792224000000, "v": true, "vt": 3 },
  { "metricName": "sewage-aerobic.orp", "t": 1792224000000, "v": "-127", "vt": 2 },
  { "metricName": "ws-mes-gw-01.m-e-s-hui-xie", "t": 1792224000000, "v": "ok", "vt": 4 }
]
```

- `t` 为毫秒 epoch，`vt` 为类型标记（`1`=f64，`2`=i64，`3`=bool，`4`=string）；
- i64 必须以**十进制字符串**传输，避免 JSON number 丢精度；
- 报文不带质量位：v0.1.0 只接受 `q=0`（省略即正常），非 0 会被拒绝。

---

## 5. 验证

`--verify`（或单独用 curl / SDK）会检查每个值类型的一个代表指标：

```text
Verification
  PASS  hvac-chiller.supply-temp  type=f64  count=1  last=7.5  good
  PASS  hvac-chiller.status  type=bool  count=1  last=true  good
  PASS  sewage-aerobic.orp  type=i64  count=1  last=-127  good
  PASS  ws-mes-gw-01.dang-qian-pai-chan-gong-dan  type=string  count=1  last=WO-20261017-001  good
  PASS  aggregate/avg hvac-chiller.supply-temp  windows=1  first=7.5
  PASS  database smartfactory_demo: 44 metrics
```

检查内容：

1. `query/last` 能返回点，且解码后的类型与目录声明一致（i64 还原为整数）；
2. `query/count`（精确）在本次时间窗内计数大于 0；
3. 首个 f64 指标的 `query/aggregate`（`avg`）至少返回一个窗口；
4. `/api/v1/metrics/:db` 能列出全部 44 个指标。

退出码：

| 退出码 | 含义 |
| ------ | ---- |
| `0` | 写入（及验证）成功 |
| `1` | 参数错误或意外异常 |
| `2` | 写入完成但验证失败 |
| `3` | 无法连接服务、鉴权失败，或连续 5 个批次写入失败 |

手工查询示例：

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/last" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"smartfactory_demo","metricName":"hvac-chiller.supply-temp"}'
```

---

## 6. 常见问题

| 现象 | 原因 | 处理 |
| ---- | ---- | ---- |
| `401 E_AUTH` | 服务端开启鉴权但客户端没有令牌 | 传 `--token` / `RTDB_TOKEN` / `--token-file` |
| `--url` 连接失败 | 服务未启动或端口不同 | 先启动 `rtdb-server`，再确认端口 |
| `E_TYPE_MISMATCH` | 目标库中同名指标已用其他类型写入 | 换 `--db`，或清理该库后重跑 |
| `400 E_INVALID_POINT ... quality=…` | 写入了非 0 质量位（v0.1.0 不支持） | 省略 `q`；本 demo 已默认不发送质量位 |
| `--db` 被拒绝 | 数据库名不能包含 `-` 等字符 | 使用字母、数字、下划线，如 `smartfactory_demo` |
| `--list` 报未知设备 | `--devices` 拼写错误 | 先用 `--list` 查看设备编码 |

## 7. 下一步

- [04 — HTTP API](./04-http-api.md)：写入 / 查询端点的完整协议。
- [05 — 客户端 SDK](./05-client-sdks.md)：在自己的应用中接入（Node / Python）。
- [08 — 运维与维护](./08-operations.md)：数据目录、保留策略与备份。

---

## 更新日志

| 日期 | 变更 | 处理模型 |
| ---- | ---- | -------- |
| 2026-10-17 | 新建页面：Smart Site 数据模拟客户端（数据映射、目录、运行参数、写入格式、验证与排障） | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增加 `bin\demo-smart-site.bat` 包装脚本（list / dry / once / stream / run 预设） | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增 §3.1 配置统一管理：`packages/demo/conf/`（`rtdb-server.json`、`client-smart-site.json`）与 `bin\start-demo-server.bat`；客户端支持 `--config` / `--no-config` | DeepSeek-V4.1-Flash |
