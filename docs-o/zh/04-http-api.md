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
| `GET` | `/healthz` | none | 存活探针 |
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
| `POST` | `/api/v1/backup/:db` | write | 触发整库备份 |
| `GET` `POST` | `/api/v1/admin/users` | admin | 列出 / 创建用户 |
| `PUT` `DELETE` | `/api/v1/admin/users/:username` | admin | 更新 / 删除用户 |
| `GET` `POST` | `/api/v1/admin/tokens` | admin | 列出 / 签发 API 令牌 |
| `DELETE` | `/api/v1/admin/tokens/:tokenId` | admin | 吊销 API 令牌 |
| `POST` | `/api/v1/auth/login` | none（需用户名 + 口令） | 换取 API 令牌 |
| `GET` | `/api/v1/auth/session` | 任意有效凭据 | 当前凭据的身份与权限域 |
| `POST` | `/api/v1/auth/logout` | 任意有效凭据 | 吊销当前 API 令牌 |
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
# {"files":42,"totalBytes":1932735283,"database":"plant_a","targetDirectory":"/mnt/backups/2026-10-17/plant_a"}
```

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
  "query":  { "count": 5000, "p50Ms": 2, "p95Ms": 11, "p99Ms": 28, "maxMs": 96 }
}
```

## 9. CORS

CORS **默认关闭**。若需要让部署在其他来源的浏览器控制台访问本实例，请设置
`cors.allowedOrigins`（例如 `["https://rtdb-admin.example.com"]` 或 `["*"]`）。
预检 `OPTIONS` 的响应为 `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS` 与
`Access-Control-Allow-Headers: Authorization, Content-Type`，缓存 600 秒。

## 10. 下一步

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

