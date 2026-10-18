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
| `dev_data_tags.scanRate`（通常 1000 ms） | `--interval`（默认 1000 ms）；`--points-per-tick` / `--rate` 可在同一窗口内写入更多点 |
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

# 性能测试：每 1 s 写入 20000 点（约 20000 pts/s），跑 30 秒
npm run demo:smart-site -- --rate 20000 --duration 30

# 固定每批 5000 点，写满 10 万点后退出
npm run demo:smart-site -- --points-per-tick 5000 --total-points 100000
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
| `client-smart-site.json` | 模拟客户端默认连接与生成参数：`url`、`database`、`tokenFile`、`intervalMs`、`pointsPerTick`、`rate`、`totalPoints`、`seed`、`devices`、`glitchProbability`、`logEvery`、`timeoutMs` |
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
| `--interval <ms>` | `1000` | **写入频度**：每 N ms 一个批次，最小 100 ms |
| `--points-per-tick <n>` | `0` | **每批点数**，`0` = 每个指标 1 点（最大受窗口容量限制，见 §3.3） |
| `--rate <points/s>` | `0` | 目标写入速率，由 `--interval` 反推每批点数；与 `--points-per-tick` 互斥 |
| `--total-points <n>` | `0` | 写满 n 个点后退出，`0` = 不限 |
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

### 3.3 性能测试模式（写点数量与频度）

默认每个批次写入「每个指标 1 个点」，批大小被 44 个标签的目录固定住，压测写入路径时不够用。
因此提供三个参数把**批次大小**与**写入频度**解耦：

| 参数 | 作用 | 说明 |
| ---- | ---- | ---- |
| `--interval <ms>` | 频度 | 每 N ms 发一个批次（最小 100 ms） |
| `--points-per-tick <n>` | 每批点数 | 一个批次写入 n 个点；`0`（默认）= 每指标 1 点 |
| `--rate <points/s>` | 目标速率 | 由 `--interval` 反推每批点数（`n ≈ rate × interval / 1000`），与 `--points-per-tick` 互斥 |
| `--total-points <n>` | 总量上限 | 写满 n 个点后退出；`0`（默认）= 不限 |

多点批次由 `SmartSiteSimulator.tickBatch()` 生成：

- 点数按指标**轮转分配**，各指标相差至多 1 个点；
- 同一指标的时间戳在 `[t - interval, t]` 窗口内**均匀分布且互不重复**——写入路径把
  `(metric, timestamp)` 当作幂等键，重复时间戳会被静默计入 `duplicates`，所以生成器不会制造重复；
- 计数器（`--points-per-tick` 下的 `rateFrom` 派生量）按同一「采样层」读取速率，避免出现跨层乱序。

容量上限：一个 `interval` 窗口最多容纳 `指标数 × interval` 个点（默认 44 × 1000 = 44 000）。
超过上限时客户端在启动阶段直接报错，而不是静默丢点；需要更高吞吐时提高 `--interval`
（容量与窗口长度成正比），或改用多个客户端进程写不同 `--db`。

启动头会打印实际批大小与目标速率，结束汇总给出真实吞吐、延迟分位（p50/p95/p99/max）与目标对比：

```text
  batch     : 20000 pts/tick (--rate 20000, ~20000 pts/s)
[t=1s] tick 2 · 20000 pts (accepted 40000, dup 0) · 36232 pts/s · p50 82.8 ms · p95 125.0 ms · stale 0
  throughput   25591.8 points/s over 3.1 s (target 20000 points/s)
```

`--dry-run` 同样遵循这些参数，可用较小的点数（如 `--dry-run --points-per-tick 100`）预览多点批次的报文。
三个参数也可以写进 `client-smart-site.json`（`pointsPerTick` / `rate` / `totalPoints`，`0` 表示关闭）；
命令行参数仍然优先。

### 3.4 令牌解析顺序

1. `--token <token>`
2. 环境变量 `RTDB_TOKEN`
3. `--token-file <path>`；未指定时使用配置文件的 `tokenFile`
4. 当前工作目录的 `rtdb.token`
5. 可执行文件所在目录的 `rtdb.token`（SEA 单文件发布时令牌与 exe 同级）

都找不到时以匿名身份运行；若服务端要求鉴权，写入会返回 `401 E_AUTH` 并提示补充令牌。

### 3.5 `bin\` 包装脚本

Windows 下可直接使用 `bin\demo-smart-site.bat`（自动切换到 `src\` 目录并转发参数）：

```bat
bin\start-demo-server.bat
bin\demo-smart-site.bat list
bin\demo-smart-site.bat dry
bin\demo-smart-site.bat once --token-file ..\release\sea\rtdb.token
bin\demo-smart-site.bat stream 60 --glitch-rate 0.002 --token-file ..\release\sea\rtdb.token
bin\demo-smart-site.bat run --devices hvac-chiller --interval 500 --duration 10 --verify
:: 大数据测试：20 000 点/秒跑 60 秒，跑完自动校验写入范围
bin\demo-smart-site.bat run --rate 20000 --duration 60 --verify
:: 固定每批 5 000 点、每 1 s 一批，写满 100 万点后退出
bin\demo-smart-site.bat run --points-per-tick 5000 --interval 1000 --total-points 1000000
:: 只打印一个大批次报文（不写入），用于核对报文体积
bin\demo-smart-site.bat dry --points-per-tick 5000
```

- **大数据测试**用 `run` 加 `--rate`（目标 pts/s）/ `--points-per-tick`（每批点数）/ `--total-points`
  （总量上限），批次大小与 44 个标签的目录规模解耦；单客户端容量仍是 `指标数 × interval`
  （默认 44 × 1000 = 44 000 点/批），需要更高时提高 `--interval` 或开多个客户端。
  本机实测（Ryzen 7 4800H / 本机磁盘）：`--rate 20000 --duration 10` 写入 22 万点、
  **21 823 点/s**、0 重复、0 失败批，`--verify` 的 `count` / `last` / `aggregate` 全部 PASS。

- `bin\start-demo-server.bat` 按 `demo\conf\rtdb-server.json` 启动演示服务器；6180 被占用时可用
  `set RTDB_PORT=6190` 覆盖端口；
- `list` / `dry` / `once` / `stream` 为预设动作：`once` 等价于 `--once --verify`；`stream`
  默认运行 60 秒并带 `--verify`（秒数可省略）；
- `bin\start-demo-server.bat bench <pts/s> <seconds> [客户端参数]` 只跑**压测客户端**，
  **不启动服务端**（服务端需自行在另一个窗口/服务中启动）：

  ```bat
  :: window 1
  bin\start-demo-server.bat
  :: window 2
  bin\start-demo-server.bat bench 20000 30
  bin\start-demo-server.bat bench 20000 30 --db perf_demo --interval 500
  bin\start-demo-server.bat bench 5000 60 --points-per-tick 5000
  ```

  当前窗口运行客户端（`--rate <pts/s> --duration <seconds> --log-every 1`），额外参数原样转发；
  服务端未就绪时会**先等待令牌文件**（客户端只在启动时解析一次令牌，最多等 10 s），
  客户端返回 `3`（连不上服务）时最多重试 3 次、每次间隔 3 s，仍失败则提示先启动服务端；
  设置 `RTDB_PORT` 时客户端会自动改用该端口；`duration` 很大（如 `3000000000`）等价于一直跑，
  Ctrl+C 只停客户端、不影响服务端；
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
| `401 E_AUTH` | 服务端开启鉴权但客户端没有令牌，或令牌与服务端不匹配 | 传 `--token` / `RTDB_TOKEN` / `--token-file` |
| `401 E_AUTH` 且写成了 `--token rtdb.token` | `--token` 收的是令牌**值**，不是文件路径（会原样作为 Bearer 发出，并**压过**配置里的 `tokenFile`） | 改用 `--token-file rtdb.token`，或用 `--token <64 位令牌值>`；同名令牌文件不等于同一个令牌——demo 服务器用 `packages\demo\conf\rtdb.token`，SEA 发布包（`release\sea\rtdb-server.exe`）用 `release\sea\rtdb.token` |
| `--url` 连接失败 | 服务未启动或端口不同 | 先启动 `rtdb-server`，再确认端口 |
| `E_TYPE_MISMATCH` | 目标库中同名指标已用其他类型写入 | 换 `--db`，或清理该库后重跑 |
| `400 E_INVALID_POINT ... quality=…` | 写入了非 0 质量位（v0.1.0 不支持） | 省略 `q`；本 demo 已默认不发送质量位 |
| `--db` 被拒绝 | 数据库名不能包含 `-` 等字符 | 使用字母、数字、下划线，如 `smartfactory_demo` |
| `--list` 报未知设备 | `--devices` 拼写错误 | 先用 `--list` 查看设备编码 |
| 启动即报 `exceed the catalog capacity` | 每批点数超过 `指标数 × interval` 的容量 | 提高 `--interval`、降低 `--points-per-tick`，或减少 `--devices` |
| `--rate` 与 `--points-per-tick` 同时报错 | 两者控制同一个旋钮 | 只传其中一个 |

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
| 2026-10-17 | 新增 §3.3 性能测试模式：`--points-per-tick`（每批点数）、`--rate`（目标 pts/s）、`--total-points`（总量上限）；生成器新增 `tickBatch()`（窗口内均分时间戳、容量校验），进度与汇总补充 pts/s、p99/max 与目标速率对比 | DeepSeek-V4.1-Flash |
| 2026-10-17 | §3.5 新增 `bin\start-demo-server.bat bench <pts/s> <seconds> [客户端参数]`：**只跑压测客户端，不启动服务端**（服务端人工外部启动；等待令牌文件、连不上时重试 3 次后提示先启服务） | DeepSeek-V4.1-Flash |
| 2026-10-17 | §6 补充 `--token rtdb.token` 导致 `401 E_AUTH` 的排障行（`--token` 收令牌值且优先于配置 `tokenFile`；demo 实例与 SEA 发布包令牌文件不同）；客户端对「`--token` 传入路径」新增 `[WARN]` 提示，401 提示语补充优先级说明 | DeepSeek-V4.1-Flash |
| 2026-10-18 | §3.5 与 `bin\demo-smart-site.bat` 新增**大数据测试**示例（`--rate 20000 --duration 60 --verify`、`--points-per-tick 5000 --total-points 1000000`、`dry --points-per-tick 5000`），并补充容量上限与实测吞吐（21 823 点/s） | DeepSeek-V4.1-Flash |
