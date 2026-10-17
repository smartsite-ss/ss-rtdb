# 05 — 客户端 SDK（Node 与 Python）

两个 SDK 都是形态 B 的**纯 HTTP**客户端。它们不包含任何引擎代码，因此可以运行在与数据库不同的
进程、容器或主机上，并且**零运行时依赖**。

| SDK | 包 | 语言 | 说明 |
| --- | -- | ---- | ---- |
| `@ss/rtdb-client` | `packages/demo/client-node` | TypeScript / JavaScript（Node ≥ 24） | 完整能力，含管理面（用户与令牌） |
| `ss-rtdb-client` | `packages/demo/client-python` | Python ≥ 3.9 | 数据面 + `status` + 行协议辅助方法 |

两个 SDK 在六个数据方法上契约完全一致；三处有意保留的运行时差异见 §2.6。

### 值类型映射（两个 SDK 通用）

`vt` 类型标记（`1`=f64，`2`=i64，`3`=bool，`4`=string）由 SDK **自动处理**：
写入时根据语言类型推断，读取时再还原回去。

| 写入 | Node | Python | 存储类型 |
| ---- | ---- | ------ | -------- |
| f64 | `number` | `float` | `1` |
| i64 | `bigint` | `int` | `2`（在传输层以十进制字符串承载） |
| bool | `boolean` | `bool` | `3` |
| string | `string` | `str` | `4` |

| 读取 | Node | Python |
| ---- | ---- | ------ |
| `vt=1` | `number`（`null` → `NaN`） | `float`（`None` → `nan`） |
| `vt=2` | `bigint` | `int` |
| `vt=3` | `boolean` | `bool` |
| `vt=4` | `string` | `str` |

---

## 1. Node SDK

### 1.1 安装

```bash
npm install @ss/rtdb-client
```

在本仓库内也可以直接导入工作区源码：

```ts
import { RtdbClient } from './packages/demo/client-node/src/index.ts';
```

### 1.2 构造

```ts
import { RtdbClient } from '@ss/rtdb-client';

const client = new RtdbClient({
  baseUrl: 'http://127.0.0.1:6180',
  token: process.env.RTDB_TOKEN,     // 以 Authorization: Bearer <token> 发送
  timeoutMs: 10_000,                 // 默认 10 000，钳制到 1 000…60 000
  maxRetries: 3,                     // 默认 3，上限 3
  maxBatchPoints: 100_000,           // 默认 100 000
  retryDelayMs: 200,                 // 默认 200；等待 = base * 2^n
});
```

### 1.3 写入

```ts
const { accepted } = await client.writeBatch('plant_a', [
  { metricName: 'station01.powerMeter.kwh', timestamp: Date.now(), value: 1024.5 },   // f64
  { metricName: 'station01.valve.open',     timestamp: Date.now(), value: true },     // bool
  { metricName: 'station01.pump.state',     timestamp: Date.now(), value: 'running' },// string
  { metricName: 'station01.counter.pulses', timestamp: Date.now(), value: 42n },      // i64（bigint）
]);
```

超过 `maxBatchPoints` 的输入会被切分为有序分片并顺序发送。每个分片是原子的：
一旦失败，剩余分片中止，服务端错误向上抛出，而 `accepted` 反映已成功的分片。

非有限数值（`NaN`、`±Infinity`）会在客户端本地被拒绝并抛出 `E_CLIENT_INVALID_ARGUMENT` ——
它们没有 JSON 表示形式。

### 1.4 查询

解码后的结果使用**长字段名**：点形如 `{ timestamp, value, quality? }`，
聚合窗口形如 `{ start, end, value, count }`。

```ts
// range
const series = await client.queryRange('plant_a', 'station01.powerMeter.kwh', {
  start: startMs, end: endMs, limit: 10_000, order: 'asc',
});
for (const point of series.points) console.log(point.timestamp, point.value);

// last —— `before` 时刻或之前的最新点（省略 = 全局最新）
const last = await client.queryLast('plant_a', 'station01.powerMeter.kwh', { before: endMs });

// count —— 默认索引估算，可请求精确值
const count = await client.queryCount('plant_a', 'station01.powerMeter.kwh',
  { start: startMs, end: endMs, exact: false });

// aggregate —— 六种算子
const windows = await client.queryAggregate('plant_a', 'station01.powerMeter.kwh', {
  start: startMs, end: endMs, type: 'avg', windowMs: 60_000,
});
for (const w of windows) console.log(w.start, w.end, w.value, w.count);
```

### 1.5 状态与元数据

```ts
const status = await client.status();                       // 完整 StatusReport
const databases = await client.listDatabases();              // string[]
const metrics = await client.listMetrics('plant_a');         // [{ metricName, firstTs, lastTs, valueType }]
await client.setRetention('plant_a', 90);                    // 天；0 = 永久
await client.backup('plant_a', '/mnt/backups/2026-10-17');   // 服务端侧拷贝
```

### 1.6 用户与令牌（管理面）

```ts
await client.createUser({ username: 'collector', password: 'S3cret!', role: 'write', enabled: true });
const users = await client.listUsers();
await client.updateUser('collector', { role: 'readonly', enabled: false });
await client.removeUser('collector');

const issued = await client.issueToken({ user: 'collector', label: 'edge-1', ttlMs: 2_592_000_000 });
console.log(issued.token);          // 明文，只显示一次
const tokens = await client.listTokens();
await client.revokeToken(issued.tokenRecord.tokenId);
```

### 1.7 错误与重试

```ts
import { isRtdbClientError } from '@ss/rtdb-client';

try {
  await client.writeBatch('plant_a', points);
} catch (error) {
  if (isRtdbClientError(error)) {
    console.error(error.code, error.status, error.message, error.details);
  }
}
```

- **自动重试**：`429 E_RATE_LIMITED` 与传输失败（网络 / 超时），采用指数退避，
  最多额外重试 `maxRetries` 次。
- **绝不重试**：`400`、`401`、`403`、`404`、`413`、`500` …… 业务错误立即抛出。
- 有意**不**遵循 `Retry-After` 头，以保证延迟有界且可预期。

---

## 2. Python SDK

### 2.1 安装

```bash
pip install ./packages/demo/client-python     # 从检出目录安装
pip install -e ./packages/demo/client-python  # 可编辑 / 开发模式
```

仅依赖标准库（`urllib`），Python ≥ 3.9，零运行时依赖。

### 2.2 构造

```python
from ss_rtdb_client import RtdbClient

client = RtdbClient(
    base_url="http://127.0.0.1:6180",
    token="...",            # 可选
    timeout_ms=10_000,      # 默认 10 000
    max_retries=3,          # 默认 3（0..3）
    max_batch_points=100_000,
    retry_delay_ms=200,
)
```

### 2.3 写入

```python
from ss_rtdb_client import WritePoint

now_ms = 1_760_688_000_000
result = client.write_batch("plant_a", [
    WritePoint("station01.powerMeter.kwh", now_ms, 1024.5),    # float  -> f64
    WritePoint("station01.valve.open",     now_ms, True),      # bool   -> bool
    WritePoint("station01.pump.state",     now_ms, "running"), # str    -> string
    WritePoint("station01.counter.pulses", now_ms, 42),        # int    -> i64
])
print(result.accepted, result.duplicates)
```

`WritePoint` 的字段为 `metric_name`、`timestamp`、`value`，以及可选的 `quality`。
它没有 `vt` 参数 —— 类型标记由 Python 类型推断。

原始行协议（JSON 六方法之外的辅助方法）：

```python
client.write_line_protocol(
    "plant_a",
    'station01.powerMeter.kwh 1024.5\nstation01.powerMeter.kwh value=1030.25\n',
)
```

### 2.4 查询

```python
series = client.query_range("plant_a", "station01.powerMeter.kwh",
                            start=start_ms, end=end_ms, limit=10_000, order="asc")
for point in series.points:
    print(point.timestamp, point.value, point.quality)

last = client.query_last("plant_a", "station01.powerMeter.kwh", before=end_ms)

count = client.query_count("plant_a", "station01.powerMeter.kwh",
                           start=start_ms, end=end_ms, exact=False)

windows = client.query_aggregate("plant_a", "station01.powerMeter.kwh",
                                 start=start_ms, end=end_ms,
                                 aggregate_type="avg", window_ms=60_000)
for window in windows:
    print(window.start, window.end, window.value, window.count)

status = client.status()        # GET /api/v1/status 返回的 dict
```

注意 `query_aggregate` 的签名：算子参数是**位置参数** `aggregate_type`（不能用 `type`，
它是 Python 内置名），窗口宽度是 `window_ms`。

### 2.5 错误

```python
from ss_rtdb_client import RtdbClientError

try:
    client.write_batch("plant_a", points)
except RtdbClientError as error:
    print(error.code, error.status, error.message)
```

重试策略与 Node SDK 相同：只有 `429` 与传输失败会重试。

### 2.6 与 Node SDK 的运行时差异

1. Python 没有 BigInt —— **i64 限制在 ±2^53**（与引擎采用的安全整数规则一致）。
2. Python 没有 `undefined` —— 非有限 / 缺失的 f64 映射为 `float('nan')`。
3. 六十四位时间戳以普通 `int` 传递。

**管理面（用户 / 令牌 / 备份）只存在于 Node SDK 中。**

---

## 3. 如何选择集成方式

| 场景 | 选择 |
| ---- | ---- |
| 应用是 Node，且运行在同一台主机上 | 可考虑嵌入式引擎（[06](./06-embedded-engine.md)）—— 少一跳 HTTP |
| 应用是 Node，访问共享服务 | `@ss/rtdb-client` |
| 应用是 Python | `ss-rtdb-client` |
| 其他语言，或采集器已经在说 InfluxDB 行协议 | 直接用 HTTP（[04](./04-http-api.md)） |

## 4. 下一步

- [06 — 嵌入式引擎（形态 A）](./06-embedded-engine.md)

---

## 更新日志

| 日期 | 变更 | 处理模型 |
| ---- | ---- | -------- |
| 2026-10-17 | 创建中文译本；随英文版更新同步「值类型映射」、长字段名、`aggregate_type` 参数等 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 更正 SDK 目录为 `packages/demo/client-node` / `packages/demo/client-python`（含工作区源码导入路径与 `pip install` 命令） | DeepSeek-V4.1-Flash |
| 2026-10-17 | Node SDK `listMetrics` 返回项增加 `valueType`（与服务端 `GET /api/v1/metrics/:db` 同步） | GLM-5.3-Flash |

