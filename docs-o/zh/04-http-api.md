# 04 — HTTP API

基础路径：`/api/v1`。默认监听：`http://127.0.0.1:6180`。

## 1. 约定

### 鉴权

| 模式 | 请求头 |
| ---- | ------ |
| `token`（默认） | `Authorization: Bearer <token>` |
| `basic` | `Authorization: Basic base64(username:password)` |
| `both` | 以上两者皆可 |

令牌可以是静态 `auth.token` / 自动生成的 `rtdb.token`（角色恒为 `admin`），
也可以是通过 `/api/v1/admin/tokens` 签发的 API 令牌（角色 = 该令牌的角色）。

没有令牌时，可用**用户名 + 口令**换取一个（`POST /api/v1/auth/login`，见 §7.3）。
首次启动的服务会自动创建默认管理员 `admin` / `ss-rtdb`（可用 `auth.bootstrapUsername` /
`auth.bootstrapPassword` 覆盖，见 [02 — 配置](./02-configuration.md) §6.4）。

### 权限域与角色

| 权限域 | 端点 | `admin` | `write` | `readonly` |
| ------ | ---- | :-----: | :-----: | :--------: |
| `none` | `/api/v1/status`、`/metrics`、`/healthz` | ✅ | ✅ | ✅ |
| `query` | `/api/v1/databases`、`/api/v1/databases/:db`、`/api/v1/metrics/:db`、`/api/v1/query/*` | ✅ | ✅ | ✅ |
| `write` | `/api/v1/write`、`/api/v1/retention/:db`、`/api/v1/backup/:db` | ✅ | ✅ | ❌ |
| `admin` | `/api/v1/admin/users*`、`/api/v1/admin/tokens*` | ✅ | ❌ | ❌ |

配置项 `auth.query` / `auth.write` 可以整体关闭查询/写入的凭据要求；
但只要 `auth.enabled = true`，`admin` 权限域**始终**受保护。

### 内容类型

- 查询类与管理类端点：`application/json`。
- `POST /api/v1/write`：JSON 点数组用 `application/json`；其他任意类型（如 `text/plain`）表示行协议。

### 错误响应体

所有非 2xx 响应都是 JSON：

```json
{ "error": "E_METRIC_NOT_FOUND", "message": "Metric not found: foo", "details": [] }
```

`429` 还会附带 `Retry-After: 1`。

| 错误码 | HTTP | 含义 |
| ------ | ---- | ---- |
| `E_INVALID_POINT` | 400 | 点格式错误 / 数据库名非法 / 行协议行非法 |
| `E_INVALID_RANGE` | 400 | 时间区间非法、`order` 非法、聚合窗口过多 |
| `E_BAD_METRIC_NAME` | 400 | 指标名缺失或非法 |
| `E_TYPE_MISMATCH` | 400 | 值类型与该指标首次写入锁定的类型不一致 |
| `E_AUTH` | 401 | 凭据缺失或无效 |
| `E_FORBIDDEN` | 403 | 已认证，但角色不具备该权限域 |
| `E_NOT_FOUND` | 404 | 未知路由 |
| `E_METHOD_NOT_ALLOWED` | 405 | 已知路由但 HTTP 方法不对 |
| `E_DB_NOT_FOUND` | 404 | 未知数据库 |
| `E_METRIC_NOT_FOUND` | 404 | 未知指标 |
| `E_USER_NOT_FOUND` | 404 | 未知用户 |
| `E_TOKEN_NOT_FOUND` | 404 | 未知令牌 ID |
| `E_DB_LOCKED` | 409 | 数据根已被其他进程占用 |
| `E_USER_EXISTS` | 409 | 用户名已存在 |
| `E_BATCH_TOO_LARGE` | 413 | 批次点数或请求体字节数超过上限 |
| `E_RATE_LIMITED` | 429 | 背压（缓冲区 / 未落盘水位）—— 至少 1 秒后重试 |
| `E_IO` | 500 | 文件系统故障 |
| `E_CORRUPT_BLOCK` / `E_CORRUPT_SEGMENT` | 500 | 块或段的 CRC / 结构校验失败 |
| `E_INTERNAL` | 500 | 未归类的内部错误 |

---

## 2. 端点索引

| 方法 | 路径 | 权限域 | 用途 |
| ---- | ---- | ------ | ---- |
| `GET` | `/api/v1/status` | none | 运行时指标 |
| `GET` | `/metrics` | none | Prometheus 暴露格式 |
| `GET` | `/healthz` | none | 存活探针（`{"status":"ok"}`） |
| `GET` | `/health` | none | InfluxDB 形状健康探针（`{"status":"pass",...}`） |
| `GET` | `/api/docs` | none | 内置 HTML 接口参考（按运行配置生成） |
| `GET` | `/api/docs/openapi.json` | none | 当前实服务路由的 OpenAPI 3.1 文档 |
| `GET` | `/api/v1/databases` | query | 列出数据库 |
| `GET` | `/api/v1/databases/:db` | query | 某库的磁盘占用、按天明细与保留策略覆盖值 |
| `GET` | `/api/v1/metrics/:db` | query | 列出某库的指标 |
| `POST` | `/api/v1/write?db=<db>` | write | 写入数据点（JSON 或行协议） |
| `POST` | `/api/v1/query/range` | query | 时间区间内的原始点 |
| `POST` | `/api/v1/query/last` | query | 某时刻或之前的最新点 |
| `POST` | `/api/v1/query/count` | query | 点数（估算或精确） |
| `POST` | `/api/v1/query/aggregate` | query | 窗口聚合 |
| `POST` | `/api/v1/query/at` | query | 任意时刻插值取值 |
| `PUT` | `/api/v1/retention/:db` | write | 设置按库保留策略 |
| `POST` | `/api/v1/backup/:db` | write | 触发备份（整库，或按 `startDay`/`endDay` 的时间段） |
| `GET` `POST` | `/api/v1/admin/users` | admin | 列出 / 创建用户 |
| `PUT` `DELETE` | `/api/v1/admin/users/:username` | admin | 更新 / 删除用户 |
| `GET` `POST` | `/api/v1/admin/tokens` | admin | 列出 / 签发 API 令牌 |
| `DELETE` | `/api/v1/admin/tokens/:tokenId` | admin | 吊销 API 令牌 |
| `POST` | `/api/v1/auth/login` | none（需用户名 + 口令） | 换取 API 令牌 |
| `GET` | `/api/v1/auth/session` | 任意有效凭据 | 当前凭据的身份与权限域 |
| `POST` | `/api/v1/auth/logout` | 任意有效凭据 | 吊销当前 API 令牌 |
| `GET` | `/ping` | none | InfluxDB 兼容存活探针（204 + `X-Influxdb-Version`） |
| `POST` | `/write`、`/api/v2/write`、`/api/v3/write_lp` | write | InfluxDB 行协议兼容写入（tag/field 折叠，见 §10） |
| `GET` `POST` | `/query`、`/api/v3/query_influxql` | query | InfluxQL 只读子集（见 §10） |
| `*` | `/api/v2/query`、`/api/v3/query_sql`、`/api/v2/buckets*`、`/api/v3/configure/*` | — | 明确 `501` + `hint`（不支持 Flux / SQL / 桶管理） |
| `GET` | `/admin/` | none | Web 控制台（静态资源） |
| `GET` | `/` | none | 302 跳转到 `/admin/`；`admin.enabled=false` 时仍为 404 |

---

## 3. 写入

```
POST /api/v1/write?db=<database>
```

`db` 必填，且必须匹配 `^[a-zA-Z][a-zA-Z0-9_]{0,62}$`。数据库在**首次写入时自动创建**。

### 3.1 行协议

`Content-Type: text/plain`（任何非 `application/json` 的类型均可）。

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/write?db=plant_a" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary $'station01.powerMeter.kwh 1024.5 1760688000000000000\nstation01.powerMeter.kwh value=1030.25\nstation01.valve.open true\nstation01.pump.state "running"'
```

语法与规则：

```
metric[,tag=value...] <value> [timestamp]
```

- **标签会被解析但随后忽略**（计入 `status.write.tagsIgnored`）。ss-rtdb 是单维度的：
  标识只有指标名。
- **时间戳单位为纳秒**，会被截断为毫秒。省略时取服务端接收时间。
  只接受数字（可带符号）。
- **值类型判定**：`true`/`false`/`t`/`f` → bool；`"…"` → string（转义 `\"` 与 `\\`）；
  不含小数点的整数，或带 `i` 后缀的整数 → **i64**；其余 → f64。
- 也接受行首为 `key=` 的字段集写法，实际取等号右侧的值。
- 空行与以 `#` 开头的行会被跳过。
- **任何一行非法都会拒绝整个批次**（`E_INVALID_POINT`，`details` 中带行号）。

### 3.2 JSON 数组

`Content-Type: application/json`；请求体是点的 JSON **数组**：

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/write?db=plant_a" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
        {"metricName":"station01.powerMeter.kwh","timestamp":1760688000000,"value":1024.5},
        {"metricName":"station01.powerMeter.kwh","t":1760688001000,"v":1030.25},
        {"metricName":"station01.valve.open","t":1760688000000,"v":true},
        {"metricName":"station01.pump.state","t":1760688000000,"v":"running"},
        {"metricName":"station01.counter.pulses","t":1760688000000,"v":"9007199254740991","vt":2}
      ]'
```

点的字段：

| 字段 | 别名 | 说明 |
| ---- | ---- | ---- |
| `metricName` | — | 必填，非空，≤512 字节 UTF-8 |
| `timestamp` | `t` | 必填，整数毫秒 epoch |
| `value` | `v` | 必填 |
| `vt` | — | 可选类型标记：`1`=f64，`2`=i64，`3`=bool，`4`=string |
| `quality` | `q` | 可选 u8；`0` = 正常（默认值，不存储） |

> v0.1.0（M0）只接受 `quality` 为 `0`（等同省略）：任何非 0 质量位都会返回
> `400 E_INVALID_POINT`（避免静默丢失），等质量位枚举确定后再开放。

**何时需要 `vt`**：JSON 数字只能表达 f64，所以要写 i64 值请使用**十进制字符串配合 `"vt": 2`**。
不写 `vt` 时，类型由 JSON 类型推断（number → f64，boolean → bool，string → string）。

### 3.3 响应

```json
{ "accepted": 5, "duplicates": 0 }
```

`(指标, 时间戳)` 已存在的点被计为 `duplicates` —— 写入是**幂等**的，
客户端可以安全重试失败的批次。

`duplicates` 只统计**同一批次内**的重复点。跨请求重复（典型场景：超时后重试同一批）在块合并阶段
被静默去重，响应仍为 `accepted=N, duplicates=0`，不会体现在任何计数字段里。因此判断重试是否生效
应看 `count` 精确计数是否保持不变，而不是 `duplicates`。

### 3.4 限制

| 条件 | 结果 |
| ---- | ---- |
| `points.length > write.maxBatch`（默认 1 000 000） | `413 E_BATCH_TOO_LARGE` |
| 请求体字节数 > `http.maxBodyBytes`（默认 64 MiB） | `413 E_BATCH_TOO_LARGE` |
| 超过缓冲区 / 未落盘水位 | `429 E_RATE_LIMITED`（附 `Retry-After: 1`） |

---

## 4. 查询原语

四个原语都是 `POST` + JSON 请求体。每个都必须带 `db` 和 `metricName`；
数据库和指标必须已存在（否则 `404`）。

### 4.1 `range`

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/range" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricName":"station01.powerMeter.kwh",
       "start":1760688000000,"end":1760691600000,"limit":1000,"order":"asc"}'
```

```json
{
  "series": {
    "metricName": "station01.powerMeter.kwh",
    "points": [
      { "t": 1760688000000, "v": 1024.5, "vt": 1 },
      { "t": 1760688001000, "v": 1030.25, "vt": 1 }
    ],
    "received": { "min": 1760691600050, "max": 1760691600062 }
  }
}
```

`start` / `end` 为**闭区间**毫秒 epoch。`limit` 默认取 `query.defaultLimit`（100 000）；
`order` 为 `asc`（默认）或 `desc`。

`series.received` 为**服务器接收时间窗口**（毫秒 epoch）：本次区间命中的数据块及未成块缓冲点
的服务器接收时刻的 `[min, max]`，块/批次粒度（非逐点），与返回的 `limit` 截断无关。用途：
① 区分补传数据（数据时间戳远早于接收时间）；② 观测客户端→服务端链路时延与服务器阻塞
（同步时钟后，接收时刻应紧随发送时刻）。旧格式块（无 `receivedTime` 标志，见文档 11 §2.2）
不携带该窗口；若整个区间无任何点携带则为该键缺省。

### 4.2 `last`

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/last" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricName":"station01.powerMeter.kwh","before":1760691600000}'
```

```json
{ "point": { "t": 1760688001000, "v": 1030.25, "vt": 1 } }
```

`before` 可选（默认取全局最新点）。这是“报表边界时刻或之前的值”这一需求所用的原语。

### 4.3 `count`

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/count" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricName":"station01.powerMeter.kwh",
       "start":1760688000000,"end":1760691600000,"exact":false}'
```

```json
{ "count": 3600 }
```

`exact: false`（默认）累加索引中的 `pointCount` —— 快，但以块为粒度可能包含区间外的点。
`exact: true` 会解码并精确计数。

### 4.4 `aggregate`

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/aggregate" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricName":"station01.powerMeter.kwh",
       "start":1760688000000,"end":1760691600000,"type":"avg","windowMs":60000}'
```

```json
{
  "windows": [
    { "start": 1760688000000, "end": 1760688060000, "v": 1027.375, "vt": 1, "count": 60 },
    { "start": 1760688060000, "end": 1760688120000, "v": 1044.5,   "vt": 1, "count": 60 }
  ]
}
```

- `type`：`avg` | `sum` | `min` | `max` | `count` | `last`。
- 窗口为 `[start + k*windowMs, start + (k+1)*windowMs)`；最后一个窗口会补齐到窗口宽度。
- `avg` 是**时间加权平均**（工业惯例）：取窗口内的点，加上窗口前后紧邻点的线性插值，
  按时间积分。若需要等权平均，请在客户端自行计算 `sum / count`。
- 无数据覆盖的窗口返回 `v` 为 `null`、`count: 0`。
- 单次调用窗口数超过 100 000 → `400 E_INVALID_RANGE`。

### 4.5 `at`（插值取值）

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/query/at" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"db":"plant_a","metricName":"station01.powerMeter.kwh",
       "timestamps":[1760688000000,1760688900000],"mode":"linear"}'
```

```json
{
  "points": [
    { "t": 1760688000000, "v": 1024.5, "vt": 1, "state": "exact" },
    { "t": 1760688900000, "v": 1037.1, "vt": 1, "state": "interpolated" }
  ]
}
```

批量取任意时刻的值（第五查询原语；插值语义详见《插值功能详细设计》）：

- `timestamps`：毫秒 epoch 数组，无需有序，单次 ≤ 10 000 个（超出 `400 E_INVALID_POINT`）。
- `mode`：`step`（默认，前值保持——取 ≤t 最近实测点）| `linear`（相邻两实测点之间线性插值；
  仅 f64/i64 指标支持，其余值类型整批 `400 E_TYPE_MISMATCH`；i64 结果四舍五入后仍以 i64 返回）。
- `state`：`exact`＝存储中真实存在的点（含前值保持）；`interpolated`＝两实测点之间推算；
  `extrapolated`＝数据范围之外按最近点平推；`no-data`＝无任何数据（`v: null`）。
- 结果按请求顺序回显；未成块缓冲点参与（写后立查即可见）；metric 不存在返回 `404 E_METRIC_NOT_FOUND`。

### 4.6 读取值

| `vt` | JSON 中的 `v` |
| ---- | ------------- |
| `1` f64 | 数字（非有限值 → `null`） |
| `2` i64 | **十进制字符串** |
| `3` bool | 布尔 |
| `4` string | 字符串 |

只有在写入时带过质量位的点才会出现 `q`。

---

## 5. 数据库与指标

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6180/api/v1/databases
# {"databases":["plant_a","plant_b"]}

curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6180/api/v1/metrics/plant_a
# {"metrics":[{"metricName":"station01.powerMeter.kwh","firstTs":1760688000000,"lastTs":1760691600000,"valueType":1}]}
```

`valueType` 是指标首次写入锁定的值类型标记（与写入/查询的 `vt` 一致：`1=f64 2=i64 3=bool 4=string`），
取自该指标第一个块的块头；库里尚无已落段块且本会话未写过该指标时为 `null`。

### 5.1 数据库详情

`GET /api/v1/databases/:db` 返回单个数据库的磁盘占用，以及 `PUT /api/v1/retention/:db` 写入的库级保留策略
（`null` 表示未设置、沿用全局默认）。该接口是纯文件系统统计：**不获取数据根锁**，服务写入期间也可安全调用，
数值为某一时刻的快照。

`directory` 默认**相对于服务进程的工作目录**（如 `rtdb-data/plant_a`）；设置
`admin.exposePaths = true` 可改为返回解析后的绝对路径。

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6180/api/v1/databases/plant_a
# {
#   "database": "plant_a",
#   "directory": "rtdb-data/plant_a",
#   "fileCount": 42,
#   "totalBytes": 1932735283,
#   "breakdown": { "segmentBytes": 1800000000, "indexBytes": 120000000, "walBytes": 13273583, "otherBytes": 0 },
#   "retentionDays": 90,
#   "days": [{ "dateNumber": 20261017, "dayLabel": "20261017", "fileCount": 42, "totalBytes": 1932735283 }]
# }
```

数据库不存在返回 `404 E_DB_NOT_FOUND`；库名非法返回 `400 E_INVALID_POINT`。

---

## 6. 保留策略与备份

```bash
# 设置保留策略（天；0 = 永久保留）—— 需要 write 权限域
curl -X PUT "http://127.0.0.1:6180/api/v1/retention/plant_a" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"days":90}'
# {"ok":true}

# 读回已保存的保留策略覆盖值（null = 沿用全局默认）
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6180/api/v1/databases/plant_a
# {"database":"plant_a","directory":"...","fileCount":42,"totalBytes":1932735283,"retentionDays":90,...}

# 在服务所在主机上触发整库备份
curl -X POST "http://127.0.0.1:6180/api/v1/backup/plant_a" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"targetDir":"/mnt/backups/2026-10-17"}'
# {"files":42,"totalBytes":1932735283,"database":"plant_a","targetDirectory":"/mnt/backups/2026-10-17/plant_a",
#  "partial":false,"range":null,"days":null}

# 按天时间段备份（含首末，服务端本地时区；yyyy-MM-dd 或 yyyyMMdd）
curl -X POST "http://127.0.0.1:6180/api/v1/backup/plant_a" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"targetDir":"/mnt/backups/2026-09","startDay":"2026-09-01","endDay":"2026-09-30"}'
# {"files":840,"totalBytes":1932735283,"database":"plant_a","targetDirectory":"/mnt/backups/2026-09/plant_a",
#  "partial":true,
#  "range":{"startDay":20260901,"endDay":20260930,"dayCount":30,
#           "startTimestamp":1756656000000,"endTimestamp":1759247999999},
#  "days":[20260901,"…"]}
```

时间段备份口径：

- **粒度是天目录**（存储与保留的最小单元），`startDay` / `endDay` 可只给一边（缺省侧取最早 / 最新日目录）；
  两者都不给即整库备份。日期为服务端本地时区，含首末两天。
- 范围备份只复制范围内的 `yyyyMMdd/` 目录与库级 `retention.json`，并在备份目录写入 `manifest.json`。
  还原（`rtdbctl restore` 或 `RtdbEngine.restore`）读到该清单时按天**合并**：同日目录整体替换、范围外的日目录
  保持不动 —— 因此范围备份永远不会删掉范围外的现场数据；整库备份（无清单）仍是整目录替换。
- 范围内没有任何日目录、`startDay` 晚于 `endDay`、或日期非法（如 `2026-02-30`）→ `400 E_INVALID_RANGE`。
- 备份是**服务端路径复制**，需要 `write` 权限域，且目标目录必须在服务端主机上可写；备份期间无需停写
  （同步执行，单线程 run-to-completion 即一致性快照）。

---

## 7. 用户与 API 令牌（admin 权限域）

### 7.1 用户

```bash
# 创建（201）
curl -X POST "http://127.0.0.1:6180/api/v1/admin/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"collector","password":"S3cret!","role":"write","enabled":true}'
# {"user":{"username":"collector","role":"write","enabled":true,"createdAt":...,"updatedAt":...}}

# 列出
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:6180/api/v1/admin/users

# 更新角色 / 口令 / 启用状态
curl -X PUT "http://127.0.0.1:6180/api/v1/admin/users/collector" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"role":"readonly","enabled":false}'

# 删除
curl -X DELETE "http://127.0.0.1:6180/api/v1/admin/users/collector" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# {"ok":true}
```

用户名匹配 `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`。口令只以 scrypt 哈希保存，且永不返回。

### 7.2 API 令牌

```bash
# 签发（201）—— 明文只返回这一次
curl -X POST "http://127.0.0.1:6180/api/v1/admin/tokens" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"user":"collector","role":"write","label":"edge-gateway-1","ttlMs":2592000000}'
# {"token":"<64 位十六进制>","tokenRecord":{"tokenId":"...","user":"collector","role":"write",
#  "label":"edge-gateway-1","createdAt":...,"expiresAt":...,"revokedAt":null}}

curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:6180/api/v1/admin/tokens
# {"tokens":[{"tokenId":"...","user":"collector","role":"write","label":"edge-gateway-1",
#  "createdAt":...,"expiresAt":...,"revokedAt":null,
#  "lastUsedAt":1760691600000,"lastDatabase":"plant_a","pointsPerSec":1200,"bytesPerSec":98304}],
#  "configToken":{"user":"admin","lastUsedAt":1760691601000,"lastDatabase":"smartfactory_demo",
#  "pointsPerSec":205,"bytesPerSec":30720}}

curl -X DELETE "http://127.0.0.1:6180/api/v1/admin/tokens/<tokenId>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# {"ok":true}
```

省略 `role` 时默认取所属用户的角色（或 `write`）；省略 `ttlMs` 表示永不过期。

列表中的每个令牌还带有**运行期使用统计**。这些数据只存在于进程内存（重启即清零），不会写入令牌文件：

| 字段 | 含义 |
| ---- | ---- |
| `lastUsedAt` | 最后一次通过认证的请求时间（ms）；`null` = 从未使用 |
| `lastDatabase` | 最后一次带库请求所访问的数据库；`null` = 只访问过管理接口 |
| `pointsPerSec` | 最近 10 秒滚动窗口内的写入点数/秒 |
| `bytesPerSec` | 同一窗口内的请求负载字节数/秒 |

静态 `auth.token`（`rtdb.token`；Smart Site 演示客户端就用它写入）在令牌存储中**没有记录**，因此不会出现在
`tokens` 里，其用量也不会记到任何 API 令牌上。它由单独的 `configToken` 对象报告，字段与上面四项相同并带
`user`（配置中的 `auth.username`）。该字段始终返回 —— 未使用静态令牌时 `lastUsedAt` / `lastDatabase` 为
`null`、两个速率均为 `0`。

令牌是**服务端凭据，不是会话**：关闭客户端不会通知服务端，因此令牌会一直有效，直到被吊销（`DELETE`）
或到达 `expiresAt`（签发时用 `ttlMs` 设置）。

### 7.3 登录与会话

登录端点本身不需要凭据：用用户目录中的用户名 + 口令换一个 API 令牌（明文只返回一次，之后按 Bearer 使用）。

```bash
curl -X POST http://127.0.0.1:6180/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"ss-rtdb"}'
# {"token":"<64 位十六进制>","expiresAt":null,"user":{"username":"admin","role":"admin"}}
```

- `ttlMs` 可选；省略表示永不过期，与服务端 `POST /api/v1/admin/tokens` 一致。
- **单会话语义**：登录签发新令牌前，会先吊销**同一用户**此前的 `console login` 令牌——反复登录不会积累孤儿凭据
  （管理面签发的其它 label 令牌与静态 `auth.token` 不受影响）。
- 未知用户与错误口令返回同一个 `401 E_AUTH`（不泄露用户是否存在）；字段缺失返回 `400 E_INVALID_POINT`。

```bash
# 当前凭据是谁、具备哪些权限域
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:6180/api/v1/auth/session
# {"user":{"username":"admin","role":"admin"},"source":"token","scopes":["query","write","admin"]}

# 登出：吊销当前 API 令牌（静态 auth.token / Basic 凭据不可吊销，返回 revoked=false）
curl -X POST http://127.0.0.1:6180/api/v1/auth/logout -H "Authorization: Bearer $TOKEN"
# {"ok":true,"revoked":true}
```

---

## 8. 可观测性端点（无需鉴权）

```bash
curl http://127.0.0.1:6180/healthz
# {"status":"ok"}

curl http://127.0.0.1:6180/api/v1/status

curl http://127.0.0.1:6180/metrics      # Prometheus 文本暴露格式
```

`/api/v1/status` 的结构：

```json
{
  "uptimeMs": 12345,
  "databases": 2,
  "metrics": 1204,
  "write":  { "pointsPerSec": 51230, "buffered": 0, "duplicates": 13, "tagsIgnored": 0 },
  "wal":    { "pendingBytes": 0, "outstandingBatches": 0, "pendingPoints": 0, "lastFsyncMs": 1760691600000 },
  "segments": { "openFiles": 3, "bytesToday": 610000000 },
  "cache":  { "blocks": 256, "blockHitRate": 0.93, "heapUsedMb": 180, "externalMb": 64 },
  "gc":     { "count": 12, "totalMs": 340, "maxMs": 41 },
  "query":  { "count": 5000, "p50Ms": 2, "p95Ms": 11, "p99Ms": 28, "maxMs": 96 },
  "compat": { "influx": { "enabled": true, "tagFolding": "metric", "fieldFolding": "metric",
                          "influxql": "read-only", "requests": 42, "writePoints": 8640000,
                          "duplicates": 17, "truncatedPoints": 0, "rejectedLines": 0,
                          "tagsFolded": 8640000, "tagsDropped": 0, "influxqlQueries": 3,
                          "unmappedMetrics": 0, "cardinalityWarn": false } }
}
```

`/metrics` 同步暴露 `rtdb_compat_influx_*` 计数族（仅在兼容层启用时出现）。

### 8.1 内置接口参考（`/api/docs`）

服务端用同一张「路由元数据表」同时生成参考页面与 OpenAPI 文档，因此对外公布的契约不会与实际注册的
路由脱节。

| 方法 | 路径 | 权限域 | 用途 |
| ---- | ---- | ------ | ---- |
| `GET` | `/api/docs` | none | 自包含 HTML 参考：按两大 API 族分类、分组端点、权限域、参数、请求字段、响应形状、`501` 表 |
| `GET` | `/api/docs/openapi.json` | none | OpenAPI 3.1 文档（`paths`、`components.securitySchemes`、错误 schema） |

- **两大 API 族分开展示**：页面分为 **ss-rtdb 原生 API**（`/api/v1/*`、`/metrics`、`/healthz`、`/health`、
  `/api/docs`）与 **InfluxDB 兼容 API**（`/write`、`/api/v2/*`、`/api/v3/*`、`/query`、`/ping`）两段。
  每段有独立的彩色标题、独立侧栏分组与端点计数（原生：探针与指标、库与指标、写入、查询原语、保留与备份、
  登录与会话、用户与令牌、控制台与文档；InfluxDB：行协议写入、InfluxQL 查询、连通性探针），
  首页各有一张族概览卡片；两族的分组不会交错。
- **公开**：与 `/status`、`/metrics` 一样无需凭据。页面只描述契约形状，不列出任何库、指标或令牌数据。
- **随配置变化**：`compat.influx.enabled=false` 时 InfluxDB 整族（区块、侧栏分组与 `501` 表）消失；
  `admin.enabled=false` 时控制台相关行（`/admin/`、`/`）与顶栏 Console 链接消失；
  `compat.influx.influxql=off` 时 `/query` 仍列出，但注明「否则返回 501」。
- **离线友好**：CSS 与筛选脚本全部内联，不引用 CDN，适配隔离的工业内网；按 `/` 聚焦端点筛选框。
  筛选匹配路径、摘要、族名与组名，并同步隐藏空分组 / 空族，`501` 表同样可筛选。
- OpenAPI 文档跳过 `/` 跳转与 `/admin/` 静态托管（不属于机器契约），公开操作标记为 `security: []`；
  每个 operation 同时带族与组的标签（`tags: ["native","write"]`、`tags: ["influx","influx-write"]`）
  并附 `x-family`，便于生成端区分两套接口。
- 控制台导航栏的 **接口文档** 入口会在新标签页打开 `/api/docs`；其地址跟随已保存的 API 基址，
  独立部署的控制台因此指向远端实例（见 [07 — Web 管理端](./07-web-admin.md) §4）。

## 9. CORS

CORS **默认关闭**。若需要让部署在其他来源的浏览器控制台访问本实例，请设置
`cors.allowedOrigins`（例如 `["https://rtdb-admin.example.com"]` 或 `["*"]`）。
预检 `OPTIONS` 的响应为 `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS` 与
`Access-Control-Allow-Headers: Authorization, Content-Type`，缓存 600 秒。

## 10. InfluxDB 兼容层

兼容层由 `compat.influx.enabled` 控制（默认开启），是**旁路适配器**：不改 `/api/v1/*` 契约，写入仍走
`engine.writeBatch`、查询仍走四原语，鉴权仍使用同一套用户/令牌账本。完整决策、差异矩阵与不可保真清单见
`docs-e/03-详细设计/HTTP接口详细设计.md`。

### 10.1 端点

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| `POST` | `/write?db=<db>&precision=ns\|us\|ms\|s\|m\|h` | v1 行协议写入 |
| `POST` | `/api/v2/write?org=<org>&bucket=<bucket>&precision=ns\|us\|ms\|s` | v2 行协议写入（`Authorization: Token <t>` 或 `Bearer`） |
| `POST` | `/api/v3/write_lp?db=<db>&precision=<单位>&no_sync=&accept_partial=` | v3 行协议写入（`precision` 支持 `nanosecond` 等全称） |
| `GET` `POST` | `/query?db=<db>&q=<InfluxQL>&epoch=ms` | v1 InfluxQL 只读子集；`POST` 支持表单或 JSON `{db,q}` |
| `GET` `POST` | `/api/v3/query_influxql?db=<db>&q=<InfluxQL>&format=json` | v3 路径，响应与 v1 相同 |
| `GET` | `/ping` | `204` + `X-Influxdb-Version` / `X-Rtdb-Version` / `X-Rtdb-Compat` |
| `*` | `/api/v2/query`、`/api/v3/query_sql`、`/api/v2/buckets*`、`/api/v3/configure/*`、`/api/v2/setup`、`/api/v2/signin`、`/api/v2/tasks*` | `501 {"code":"not implemented","message":…,"hint":…}` |

写入成功统一 `204 No Content`（与 InfluxDB 一致），并返回计数头：
`X-Rtdb-Accepted`、`X-Rtdb-Duplicates`、`X-Rtdb-Truncated-Points`、`X-Rtdb-Database`（v2 桶名规范化结果）；
`no_sync` 被接受但不改变服务端持久化策略，回 `X-Rtdb-NoSync: ignored`。
`accept_partial=true` 且存在被拒行时返回 `200` + `{"accepted":N,"duplicates":N,"truncated":N,"rejected":[{line_number,error_message}]}`（最多 100 条）。
默认是**整批原子**：任一行非法则整批 `400`，不写入任何点。

### 10.2 数据模型映射

```
cpu,host=srv01,region=us usage_idle=97.2,usage_user=2i 1700000000000000000
→ cpu|usage_idle|host=srv01|region=us = 97.2 (f64)
→ cpu|usage_user|host=srv01|region=us = 2 (i64)
```

- `measurement|field|key=value...`，tag key 升序；`\`、`|`、`=` 转义为 `\\`、`\|`、`\=`。
- `tagFolding=metric`（默认）保证不同 tag 组合不会塌缩；`ignore` 为显式降级并计入 `tagsDropped`。
- `fieldFolding=metric`（默认）每字段一个指标；`reject` 拒绝多字段行。
- 值类型遵循 InfluxDB：`42` 是浮点、`42i` 是 64 位整数、`42u` 返回 `400`（不支持无符号）。
- 折叠后指标名 ≤512 字节、字符串值 ≤256 字节，超限 `400` 并给出行号。

### 10.3 认证

`Token` / `Bearer` / `Basic` 三种方案均可；`?u=&p=` 与 `?access_token=` 仅在
`compat.influx.allowQueryCredentials=true` 时接受（凭据会进入访问日志，不推荐）。权限域映射：
写入 → `write`，InfluxQL → `query`。缺失/非法凭据返回 `401`，角色不足返回 `403`。

### 10.4 错误体

| 族 | 形状 |
| -- | ---- |
| v2（`/api/v2/*`） | `{"code":"invalid\|not found\|unauthorized\|forbidden\|request too large\|too many requests\|not implemented","message":"…","hint"?,"data"?}` |
| v1 / v3（`/api/v1`、`/write`、`/query`、`/api/v3/*`） | `{"error":"…","hint"?,"data"?}` |

行级失败（原子模式）附带 `data: [{ "line_number": 2, "error_message": "…" }]`；HTTP 头
`X-Rtdb-Error-Code` 携带原生 ss-rtdb 错误码，便于排障。`429` 带 `Retry-After: 1`。

### 10.5 InfluxQL 只读子集

```sql
SELECT <field | * | mean|sum|count|min|max|first|last(field)> [, …]
FROM <measurement>
[WHERE time <op> <RFC3339 | 整数(ns) | now() [- duration]> [AND tag =|!= 'value']…]
[GROUP BY time(<duration>) [, tag…] [fill(none|null|0|previous)]]
[ORDER BY time ASC|DESC] [LIMIT n] [OFFSET n]

SHOW DATABASES | MEASUREMENTS [ON db] | TAG KEYS [FROM m] | TAG VALUES [FROM m] WITH KEY = "k"
     | FIELD KEYS [FROM m] | RETENTION POLICIES [ON db]
```

语义约定：

- `mean()` 是**等权平均**（用 `sum/count` 计算，与 InfluxQL 一致）；原生 `avg` 是时间加权，二者不要混用。
- `GROUP BY time()` 的窗口按 epoch 对齐（起点向上取整到窗口边界），与 InfluxDB 一致；`fill` 默认 `null`。
- `count()` 无 `GROUP BY time` 时走精确计数；`last()` 走索引回溯；`first()` 按窗口做有界扫描（≤2000 个窗口）。
- **可见性边界**：InfluxQL 只可见**折叠形态**的指标（`measurement|field[|tag=value…]`，即经兼容层写入的数据）。
  通过原生 `/api/v1/write` 写入的指标名（不含 `|`）不会出现在 `SHOW MEASUREMENTS` 与 `SELECT` 结果中，
  而是计入 `status.compat.influx.unmappedMetrics`。需要在一个库内同时使用两族 API 时请注意这一隔离。
- 多语句（`;`）、多 measurement、`OR`、正则、子查询、`INTO`、`DELETE`/`DROP`/`CREATE` 一律 `501` 并给出原因。

`epoch` 默认返回 RFC3339（毫秒精度），`epoch=ms|s|m|h|u|us|ns` 返回整数。

### 10.6 与 InfluxDB 的已知差异

| 差异 | 说明 |
| ---- | ---- |
| 跨请求重复点不覆盖 | 存储为追加式，先写者胜；InfluxDB 为 last-write-wins。同请求内按 `duplicatePolicy`（默认 last）合并。 |
| ns → ms 截断 | 同一毫秒多点合并，`X-Rtdb-Truncated-Points` 计数。 |
| 字段类型永久锁定 | InfluxDB 可按 shard 变更；ss-rtdb 一律 `400 E_TYPE_MISMATCH`。 |
| 无桶/组织/控制面 | `/api/v2/buckets`、`/api/v3/configure/*`、`setup`、`tasks`、Flux、SQL 返回 `501`。 |
| `X-Influxdb-Version` | 仅声明兼容基线（默认 `2.7.8`，可配），真实版本见 `X-Rtdb-Version`。 |

### 10.7 示例

```bash
# v2 客户端（Telegraf / Vector 的 influxdb_v2 输出）
curl -XPOST "http://127.0.0.1:6180/api/v2/write?org=smart-site&bucket=plant-a&precision=ns" \
  -H "Authorization: Token $TOKEN" -H "Content-Type: text/plain" \
  --data-binary 'cpu,host=srv01 usage_idle=97.2,usage_user=2i 1700000000000000000'

# v3 客户端（gzip + accept_partial）
gzip -c points.lp | curl -XPOST "http://127.0.0.1:6180/api/v3/write_lp?db=plant_a&precision=nanosecond&accept_partial=true" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Encoding: gzip" --data-binary @-

# InfluxQL（Grafana InfluxQL 数据源）
curl -G "http://127.0.0.1:6180/query" --data-urlencode "db=plant_a" --data-urlencode "epoch=ms" \
  --data-urlencode "q=SELECT mean(usage_idle) FROM cpu WHERE host = 'srv01' GROUP BY time(5m) fill(none)" \
  -H "Authorization: Token $TOKEN"
```

## 11. 下一步

- [05 — 客户端 SDK](./05-client-sdks.md) —— 从 Node 或 Python 使用这些端点。

---

## 更新日志

| 日期 | 变更 | 处理模型 |
| ---- | ---- | -------- |
| 2026-10-17 | 创建中文译本 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 端点索引补充根路径 `GET /` → 302 `/admin/`（`admin.enabled=false` 时仍为 404） | DeepSeek-V4.1-Flash |
| 2026-10-17 | 写入字段说明明确 v0.1.0 仅接受 `quality = 0`，非 0 返回 `400 E_INVALID_POINT` | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增 §7.3「登录与会话」与端点索引三行：`POST /api/v1/auth/login`、`GET /api/v1/auth/session`、`POST /api/v1/auth/logout` | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增 `GET /api/v1/databases/:db`（磁盘占用、按天明细、保留策略读回）与 §5.1、端点索引行及 `query` 权限域条目 | DeepSeek-V4.1-Flash |
| 2026-10-17 | §5.1 明确 `directory` 默认为相对服务工作目录的路径（`admin.exposePaths=true` 时为绝对路径） | DeepSeek-V4.1-Flash |
| 2026-10-17 | `GET /api/v1/admin/tokens` 增加逐令牌运行期统计（`lastUsedAt`、`lastDatabase`、`pointsPerSec`、`bytesPerSec`）；§7.2 补充字段说明与「凭据而非会话」规则 | DeepSeek-V4.1-Flash |
| 2026-10-17 | §7.2 新增 `configToken`：静态 `auth.token`（`rtdb.token`）不在令牌存储中，其用量单独返回，演示客户端等静态令牌写入不再被丢弃 | DeepSeek-V4.1-Flash |
| 2026-10-17 | `GET /api/v1/metrics/:db` 响应增加 `valueType`（指标首次写入锁定的值类型标记，取自第一个块头，未知为 `null`）；§5 示例同步 | GLM-5.3-Flash |
| 2026-10-17 | §7.3 登录改为**单会话语义**：签发新令牌前自动吊销同用户旧的 `console login` 令牌（其它 label 与静态令牌不受影响） | GLM-5.3-Flash |
| 2026-10-17 | §4.1 `query/range` 响应新增 `series.received`（服务器接收时间窗口，块/批次粒度；用于补传识别与链路时延观测），示例同步 | GLM-5.3-Flash |
| 2026-10-17 | 新增 §4.5 `POST /api/v1/query/at`（任意时刻插值取值：`step`/`linear` 模式、`state` 来源标记、批量 ≤10 000）与端点索引行，原「读取值」顺延为 §4.6 | GLM-5.3-Flash |
| 2026-10-18 | 新增 §10「InfluxDB 兼容层」：三族行协议写入（tag/field 折叠、precision、gzip、204、`accept_partial`）、`/ping`、InfluxQL 只读子集（`/query`、`/api/v3/query_influxql`）、错误族、已知差异与示例；端点索引补 `/health`、`/ping`、写入/查询/501 行；§8 status 补 `compat.influx` 计数并说明 `rtdb_compat_influx_*` 指标；原「下一步」顺延为 §11 | DeepSeek-V4.1-Flash |
| 2026-10-18 | 新增 §8.1「内置接口参考」：`GET /api/docs`（自包含 HTML、公开、随配置过滤）与 `GET /api/docs/openapi.json`（OpenAPI 3.1，同源于路由元数据表）；端点索引补两行；说明控制台「接口文档」导航入口 | DeepSeek-V4.1-Flash |
| 2026-10-18 | §8.1 改为按**两大 API 族**（ss-rtdb 原生 / InfluxDB 兼容）分类展示：独立区块、独立侧栏分组与计数；筛选同时匹配族名/组名并覆盖 `501` 表；OpenAPI 操作打上 `[族, 组]` 标签并附 `x-family` | DeepSeek-V4.1-Flash |
| 2026-10-18 | §3.3 明确 `duplicates` 只统计**批内**重复（跨请求重试在块合并阶段静默去重，判断幂等需看精确 `count`）；§10.5 补充 InfluxQL **可见性边界**（仅可见折叠形态指标，原生指标计入 `unmappedMetrics`） | DeepSeek-V4.1-Flash |
| 2026-10-18 | §6 备份新增**按天时间段**（`startDay`/`endDay`）：响应增加 `partial`/`range`/`days`，范围备份写 `manifest.json`、还原时按天合并（范围外数据不删）；端点索引行同步 | DeepSeek-V4.1-Flash |

