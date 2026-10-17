# 06 — 嵌入式引擎（形态 A）

形态 A 把引擎直接嵌入你的 Node 进程 —— 就像 SQLite 一样，没有服务、没有端口、没有网络跳转。
适用于单个应用、边缘盒子，以及一切“由一个进程独占数据”可被接受的场合。

之后切换到形态 B **无需迁移**：让 `rtdb-server` 指向同一个 `dataDir` 即可。

---

## 1. 安装与打开

```bash
npm install @ss/rtdb-core
```

```ts
import { RtdbEngine } from '@ss/rtdb-core';

const rtdb = new RtdbEngine({ dataDir: './rtdb-data' });
await rtdb.open();

// …… 使用它 ……

await rtdb.close();   // 刷盘、封存活动段、截断 WAL、释放锁
```

关闭时务必调用 `close()`（注册 `SIGINT` / `SIGTERM` / `process.on('exit')` 处理器）。
未调用 `close()` 就崩溃也是安全的 —— 恢复时会重放 WAL。`fsyncPolicy='wal'`（默认）下**不丢点**：
持久化顺序是「块写入段文件 → fsync 段文件 → 推进 WAL 安全点」，因此任意时刻，点要么已在段文件中
（已 fsync），要么仍在 WAL 中（每次追加后成组 fsync）——WAL 被截断前，它承载的点必然已落段并落盘。

### 数据根锁

`open()` 会获取独占的**数据根锁**（`{dataDir}/lock`，内含持有者 pid）。第二个进程打开同一目录
会因 `E_DB_LOCKED` 失败；已死进程遗留的锁会被自动接管。同一个数据根内的*两个数据库*可以在
同一进程内并发写入；*两个进程*则不能共享一个数据根。

如果需要多进程访问，请使用形态 B。

---

## 2. 引擎选项

除 `dataDir` 外所有选项都可省略。

| 选项 | 默认值 | 含义 |
| ---- | ------ | ---- |
| `dataDir` | — | **必填。** 数据根目录。 |
| `retentionDays` | `0` | 全局默认保留天数；`0` = 永久。按库覆盖优先。 |
| `archiveBeforeDelete` | `false` | 删除过期日目录前先打包成 `tar.gz`。 |
| `archiveDir` | `{dataDir}/archive` | 归档目标目录（同一卷）。 |
| `segmentMaxBytes` | `209715200` | 段文件软上限（200 MiB）；钳制到 16 MiB…4 GiB。 |
| `segmentMaxPerDay` | `1000` | 单个日目录内最大段文件数。 |
| `blockTargetPoints` | `16384` | 块封块的主触发条件。 |
| `blockMinPoints` | `1024` | 周期性兜底封块的下限。 |
| `flushIntervalMs` | `5000` | 周期性兜底刷盘。 |
| `maxBufferBytes` | `268435456` | 缓冲点内存水位 → `E_RATE_LIMITED`。 |
| `maxPendingPoints` | `2000000` | 未落盘点数水位 → `E_RATE_LIMITED`。 |
| `cacheBlocks` | `256` | 已解码块的 LRU 条目数。 |
| `cacheFdGroups` | `32` | 打开的段文件句柄的 LRU 条目数。 |
| `walEnabled` | `true` | 仅当数据可重新生成时才关闭。 |
| `fsyncPolicy` | `wal` | `wal` = 每次 WAL 追加后成组 fsync，且块落段后先 fsync 段文件再推进 WAL 安全点；`none` = 依赖操作系统（仅限可重灌数据）。 |

越界值会被钳制（钳制表见 [02 — 配置](./02-configuration.md) §3 配置项参考）。

---

## 3. 写入

```ts
const { accepted } = await rtdb.writeBatch('plant_a', [
  { metricName: 'station01.powerMeter.kwh', timestamp: Date.now(), value: 1024.5 },
  { metricName: 'station01.valve.open',     timestamp: Date.now(), value: true },
  { metricName: 'station01.pump.state',     timestamp: Date.now(), value: 'running', quality: 0 },
  // i64 用 bigint（或 ±2^53 范围内的 number）
  { metricName: 'station01.counter.pulses', timestamp: Date.now(), value: 9007199254740991n },
]);
```

类型映射（指标类型由**首次**写入锁定）：

| JS 值 | 存储类型 |
| ----- | -------- |
| `number` | **f64**（JS 数字即双精度） |
| `bigint` | **i64**（上限 ±2^53） |
| `boolean` | **bool** |
| `string` | **string**（≤256 字节 UTF-8） |

后续以不同类型写入会抛出 `E_TYPE_MISMATCH`。重复的 `(指标, 时间戳)` 组合计为重复点而非错误 ——
重试是幂等的。

---

## 4. 查询（四个原语）

```ts
// range —— 闭区间 [start, end]
const series = await rtdb.queryRange('plant_a', 'station01.powerMeter.kwh', {
  start: startMs, end: endMs, limit: 100_000, order: 'asc',
});
// series: { metricName, points: [{ timestamp, value, quality? }], received?: { min, max } }
// received = 服务器接收时间窗口（毫秒 epoch，块/批次粒度；全部命中块无窗口时缺省）

// last —— `before` 时刻或之前的最新点（省略 = 全局最新）
const last = await rtdb.queryLast('plant_a', 'station01.powerMeter.kwh', { before: endMs });

// at —— 任意时刻批量取值（step=前值保持 / linear=线性插值；state: exact|interpolated|extrapolated|no-data）
const atPoints = await rtdb.queryAt('plant_a', 'station01.powerMeter.kwh', {
  timestamps: [startMs, startMs + 60_000], mode: 'linear',
});

// count —— 默认索引估算，可请求精确值
const count = await rtdb.queryCount('plant_a', 'station01.powerMeter.kwh',
  { start: startMs, end: endMs, exact: false });

// aggregate —— 六种算子，avg 为时间加权
const windows = await rtdb.queryAggregate('plant_a', 'station01.powerMeter.kwh', {
  start: startMs, end: endMs, type: 'avg', windowMs: 60_000,
});
// [{ start, end, value, count }, ...]
```

单次 `queryAggregate` 的窗口数超过 100 000 会抛出 `E_INVALID_RANGE`。

---

## 5. 管理

```ts
await rtdb.listDatabases();                  // string[]
await rtdb.listMetrics('plant_a');           // MetricSummary[] — { metricName, firstTs, lastTs, valueType }
await rtdb.setRetention('plant_a', 90);      // 持久化到 {dataDir}/plant_a/retention.json
await rtdb.runRetention();                   // 立即执行清理（也会按定时器运行）
await rtdb.backup('plant_a', '/mnt/backups/2026-10-17');
await rtdb.restore('/mnt/backups/2026-10-17', 'plant_a');
const stats = await rtdb.stats();            // 运行时指标（见 §7）
```

`setRetention` 写入的按库覆盖值在重启后仍然有效；未设置时沿用全局 `retentionDays`。

---

## 6. 错误

```ts
import { ERROR_CODE, RtdbError, isRtdbError } from '@ss/rtdb-core';

try {
  await rtdb.writeBatch('plant_a', points);
} catch (error) {
  if (isRtdbError(error)) {
    console.error(error.code, error.message, error.details);
    if (error.code === ERROR_CODE.RateLimited) {
      await new Promise((r) => setTimeout(r, 1000));   // 背压 —— 稍后重试
    }
  }
  throw error;
}
```

错误码：`E_INVALID_POINT`、`E_INVALID_RANGE`、`E_BAD_METRIC_NAME`、`E_TYPE_MISMATCH`、`E_AUTH`、
`E_DB_NOT_FOUND`、`E_METRIC_NOT_FOUND`、`E_DB_LOCKED`、`E_BATCH_TOO_LARGE`、`E_RATE_LIMITED`、`E_IO`、
`E_CORRUPT_BLOCK`、`E_CORRUPT_SEGMENT`、`E_INTERNAL`。

---

## 7. 运行时指标（`stats()`）

```ts
const stats = await rtdb.stats();
```

| 分组 | 字段 |
| ---- | ---- |
| `uptimeMs`、`databases`、`metrics` | 实例规模 |
| `write` | `pointsPerSec`、`bufferedPoints`、`duplicatePoints` |
| `wal` | `pendingBytes`、`pendingPoints`、`outstandingBatches`、`lastFsyncMs` |
| `segments` | `openFiles`、`bytesToday` |
| `cache` | `blocks`、`blockHitRate`、`heapUsedMb`、`externalMb` |
| `gc` | `count`、`totalMs`、`maxMs` |
| `query` | `count`、`p50Ms`、`p95Ms`、`p99Ms`、`maxMs` |

关注 `wal.pendingBytes` 与 `write.buffered` —— 持续增长说明下游跟不上；
关注 `cache.blockHitRate` 以便调整 `cacheBlocks`。

---

## 8. 完整示例

```ts
import { RtdbEngine, isRtdbError } from '@ss/rtdb-core';

const METRIC = 'station01.powerMeter.kwh';
const rtdb = new RtdbEngine({
  dataDir: './rtdb-data',
  retentionDays: 90,
  blockTargetPoints: 16_384,
});

async function main(): Promise<void> {
  await rtdb.open();

  // 模拟一小时的每秒采样
  const end = Date.now();
  const start = end - 3_600_000;
  const points = [];
  for (let ts = start; ts <= end; ts += 1_000) {
    points.push({ metricName: METRIC, timestamp: ts, value: 1000 + Math.random() * 50 });
  }
  console.log('accepted', (await rtdb.writeBatch('plant_a', points)).accepted);

  // 最近 10 分钟的每分钟均值
  const windows = await rtdb.queryAggregate('plant_a', METRIC, {
    start: end - 600_000, end, type: 'avg', windowMs: 60_000,
  });
  for (const w of windows) console.log(new Date(w.start).toISOString(), w.value, w.count);

  console.log(await rtdb.stats());
}

main()
  .catch((error: unknown) => {
    if (isRtdbError(error)) console.error(`[${error.code}] ${error.message}`);
    else console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await rtdb.close();
  });
```

## 9. 下一步

- [07 — Web 管理控制台](./07-web-admin.md)
- [08 — 运维与维护](./08-operations.md)

---

## 更新日志

| 日期 | 变更 | 处理模型 |
| ---- | ---- | -------- |
| 2026-10-17 | 创建中文译本 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 修正崩溃丢失口径：`fsyncPolicy='wal'` 下不丢点（块落段 → fsync 段文件 → 才推进 WAL 安全点；原「最多丢失 ≤5 秒」对应修复前的实现） | DeepSeek-V4.1-Flash |
| 2026-10-17 | `listMetrics` 返回的 `MetricSummary` 增加 `valueType` 字段 | GLM-5.3-Flash |
| 2026-10-17 | `queryRange` 返回的 `Series` 新增可选 `received`（服务器接收时间窗口，块/批次粒度） | GLM-5.3-Flash |
| 2026-10-17 | `RtdbEngine` 新增第五查询原语 `queryAt`（任意时刻批量插值取值，`step`/`linear`，`state` 来源标记；详见《插值功能详细设计》） | GLM-5.3-Flash |

