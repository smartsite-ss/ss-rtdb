# 11 — 存储格式与写入路径（细化设计）

本页把磁盘格式与写入路径的设计细节一次性说清：段文件物理布局、块编码与 codec 选择、
CRC 作用域、写入十步链路、WAL 行格式与安全点、启动恢复，以及全部默认常量与钳制范围。
段文件的**生成与滚动触发规则**（何时新建 `.seg`）见 [08 — 运维与维护](./08-operations.md) §1.1，
本页只描述"文件长什么样、数据怎么流进去"。

> 适用范围：`@ss/rtdb-core`（形态 A）与 `rtdb-server`（形态 B）完全一致 —— 两种形态共享
> 同一个引擎与同一套磁盘格式，无需迁移。

---

## 1. 数据目录与文件命名

```
```text
{dataDir}/
├── lock                        # 单进程独占锁（一个 dataDir 同一时刻只允许一个进程打开）
└── {database}/                 # 一库一目录（目录级隔离）
    ├── retention.json          # 库级保留天数覆盖（可选，优先于全局 retentionDays）
    ├── quality.json            # 库级质量落盘覆盖（可选，如 {"store":"good"}，优先于全局 quality.store）
    └── {yyyyMMdd}/             # 一天一个目录：保留 / 备份 / 损坏隔离的单位
        ├── {yyyyMMdd}-NNN.seg  # 容量段：物理 IO / 恢复单位；NNN 为 3 位零填充序号
        ├── {yyyyMMdd}-NNN.idx  # 段索引镜像（.seg 内索引区的可替换副本）
        └── {yyyyMMdd}.wal      # 该日写前日志（JSONL）
```

- 3 位零填充序号保证**字典序 = 时间序**；格式版本 1 限制每天最多 999 个段
  （`MAX_SEGMENT_SEQUENCE`）。
- `.idx` 是 `.seg` 内索引区的**可替换镜像**（查询预热用）：缺失或与实际块区不一致时，
  恢复流程会从段文件重建（§7）。
- WAL 按**天**分文件；跨日的写批次会在两个日文件里各留一段范围（§6）。

---

## 2. 段文件物理布局（格式版本 1）

除 magic 为 ASCII 外，**所有整数一律小端（LE）**。自上而下：

```
┌────────────────────────────┐ 0x00
│ Header (32B)               │
├────────────────────────────┤
│ Block[0]                   │
│ Block[1]                   │   追加式，块永不跨段
│ ...                        │
├────────────────────────────┤ ← Footer 起点（块区结束处）
│ Footer (16B)               │
├────────────────────────────┤ ← indexOffset = Footer 起点 + 16
│ 段内索引区（变长）          │
└────────────────────────────┘ EOF
```

### 2.1 段头 Header（固定 32B，偏移 0x00–0x1F）

| 偏移 | 大小 | 字段 | 说明 |
| ---- | ---- | ---- | ---- |
| 0x00 | 8B | magic | ASCII `"SSRTDB01"` |
| 0x08 | u16 | version | 格式版本，当前 `1`；不匹配抛 `E_CORRUPT_SEGMENT` |
| 0x0A | u16 | flags | bit0 `zlibBlock`＝段内含整块 zlib 包装的块；bit1 `hasBackfillBlock`＝段内含乱序回填块 |
| 0x0C | u32 | date | `yyyyMMdd` |
| 0x10 | i64 | createdAt | 毫秒 epoch |
| 0x18 | 8B | reserved | 0 |

flags 的时序约束：段头在**建段时**一次性写入（flags=0）；写入侧在追加了一个 zlib 包装块
之后，调用 `setSegmentHeaderFlag` 以"内存 headerBytes 与磁盘 0x0A 处 u16 **同步按位或**"的
方式补写标志——必须同步，因为封口时 Footer CRC 覆盖的是**内存中的 headerBytes**，若与磁盘
头不一致，读侧校验会失败。

### 2.2 块 BlockHeader（固定 41B + metric 字节）

| 字段 | 大小 | 说明 |
| ---- | ---- | ---- |
| metricLen | u16 | metric 名 UTF-8 字节数（1–65535） |
| metric | metricLen B | metric 名 |
| pointCount | u32 | 块内点数 |
| valueType | u8 | 1=`f64` 2=`i64` 3=`bool` 4=`string` |
| tsCodec | u8 | 时间戳 codecId（当前恒为 1） |
| valCodec | u8 | 值 codecId（§3） |
| tsRawLen | u32 | **落盘**时间戳负载字节数（见下） |
| valRawLen | u32 | **落盘**值负载字节数（见下） |
| tsMin / tsMax | i64×2 | 块内毫秒时间戳范围 |
| flags | u16 | bit0 `backfill`＝乱序回填块；bit2 `qualityPresent`＝块尾附带每点 1B 质量数组；bit3 `receivedTime`＝块尾附带 16B 服务器接收时间窗口 |
| reserved | u16 | 0 |
| crc32 | u32 | 覆盖整个 BlockData（含质量数组与接收时间窗口尾，见 §4） |

块数据 `BlockData = tsEncoded(tsRawLen B) ++ valEncoded(valRawLen B) ++ quality(pointCount B, 可选)`；
flags bit3 置位时其后跟 `receivedWindow(16B) = [receivedMin i64][receivedMax i64]`（毫秒 epoch，
`totalLength` 与块 CRC 覆盖范围相应增加）。旧格式块（无该标志）读侧解析为
`receivedMin/receivedMax = null`，行为不变——接收时间窗口是**块/批次粒度**的到达追溯
（补传识别、链路时延观测），不逐点存储。

**质量数组（flags bit2）**：每点一个 u8 位域，顺序与 `tsEncoded` 一致；
`bit7-6 severity`（00 Good / 01 Uncertain / 10 Bad / 11 Reserved，读作 Bad）、
`bit5-4 source`（00 Process / 01 Substituted / 10 Interpolated）、
`bit3-0 reason`（0 None、1 SensorFailure、2 CommFailure、3 OutOfRange、4 Overflow、5 Stale、
6 BadReference、7 ConfigurationError、8 Maintenance、9 Test、10 Blocked、11 CalculationError、
12 Inconsistent、13 Inaccurate、14 Oscillatory）。块内**全部点为 `0x00`** 时不置位、不追加，
现有全 Good 数据的字节布局与体积完全不变；只要有一个非 0 质量，整块追加 `pointCount` 字节
（可被 `valCodec=4` 的整块 zlib 一并压缩）。`.idx` 不含质量，质量仅随块解码。

**关键口径**：`tsRawLen` / `valRawLen` 填的是**落盘（编码后）负载字节数**，不是解压后字节数
——读侧靠这两个数切分 BlockData。块内时间戳按**稳定升序**排序（相同时间戳保持写入顺序），
编码前完成。

### 2.3 尾部 Footer（固定 16B，紧跟最后一个块）

| 字段 | 大小 | 说明 |
| ---- | ---- | ---- |
| indexOffset | u64 | 索引区起点（= Footer 起点 + 16） |
| crc32 | u32 | 覆盖 Header 32B ++ indexOffset 8B（§4） |
| reserved | u32 | 0 |

### 2.4 段内索引区（indexOffset .. EOF，每项 38B + metric）

```
[metricLen u16][metric][offset u64][len u64][pointCount u32][tsMin i64][tsMax i64]*
```

- `offset`＝块起点在**段文件内**的绝对字节偏移；`len`＝**整块字节数**（块头 + 数据）——
  查询一次 seek 即可读入整块，无需重算块头长度。
- 索引区与块区一样按 metric 名内聚：同一 metric 的块相邻排列，`tsMin/tsMax` 供
  区间剪枝。

---

## 3. 编码与 codec 选择

codecId 已固定进格式，**不得复用或重排**：

| codecId | 含义 |
| ------- | ---- |
| 0 | raw（后备，按 valueType 直接二进制排布） |
| 1 | delta-of-delta + varint（时间戳专用） |
| 2 | Gorilla XOR（f64 专用） |
| 3 | 通用 RLE（预留，未使用） |
| 4 | zlib 整块包装：`[innerCodecId u8][deflate 流]` |
| 5 | i64 delta + varint |
| 6 | bool RLE 位打包 |
| 7 | string 字典编码 |

- **时间戳**恒用 codec 1（`tsCodec=1`，块内共享一份时间戳序列）。
- **值**由 `encodeValues` 自动选择：依次生成"专用编码"、"专用编码 + zlib 包装"、"raw"、
  "raw + zlib 包装"（zlib 包装仅在比原负载更短时保留），取**字节数最小**者；字节数并列时
  按优先级 专用(0) < zlib(1) < raw(2) 取前者。选中的 codecId 写入块头 `valCodec`。
- zlib 包装解一层即可还原：读 `innerCodecId` 后按普通 codec 解码。
- 合法值 codecId 集合为 `{0, 2, 4, 5, 6, 7}`，块头解析遇到集合外值按损坏块处理。

---

## 4. CRC 与完整性

| 校验点 | 作用域 | 算法 | 失败表现 |
| ------ | ------ | ---- | -------- |
| 块 CRC | 整个 BlockData | 链式 `crc32(val, crc32(ts))`（node:zlib）；flags bit2 置位时链入质量数组（`crc32(quality, …)`），bit3 置位时再链入 16B 接收时间窗口（`crc32(received, …)`） | 读侧抛 `E_CORRUPT_BLOCK` |
| Footer CRC | Header 32B ++ indexOffset 8B | crc32 | 读侧按 `E_CORRUPT_SEGMENT` 处理 |

- 段头本身无 CRC，靠 magic + version + 字段范围校验（`parseSegmentHeader`）。
- 块头解析（`tryParseBlockHeader`）是"防御式"的：字段越界 / `tsMax < tsMin` / 非法
  valueType 或 codecId / 未知 flags 位 → 返回 null，扫描据此判定**块区结束**（即 Footer
  起点），而不是抛错——这是掉电截断后段文件仍可读的原因。
- `.idx` 镜像与段内索引区内容一致，二者互为冗余；镜像仅是缓存，任何时刻可重建。

---

## 5. 写入路径：从点到达引擎到落盘

一次 `append`（一调用＝一批次）的完整链路：

1. **校验**：库名、metric 名（≤512 字节 UTF-8）、值边界（i64 ∈ ±2^53、string ≤256 字节、
   时间戳为毫秒 epoch）、质量为 u8（`0..255`）。
2. **质量落盘策略**：按库级 `quality.json` → 全局 `quality.store` 的优先级判定；低于阈值时
   `quality.onReject='reject'` 整批抛 `E_QUALITY_REJECTED`（不进 WAL），`'drop'` 丢弃该点并计入
   `write.qualityDropped`。
3. **类型锁定**：metric 首次写入锁定值类型；此后类型不符抛 `E_TYPE_MISMATCH`。
4. **幂等去重**：`(metric, timestamp)` 重复点计入 `duplicates`，不重复落盘（客户端可安全重试）。
5. **WAL 追加**：整批写为一组 JSONL 行（§6），`fsyncPolicy='wal'` 时组内一次 fsync；
   返回 `batchId` + 各日文件的字节范围，批次进入 FIFO 账本。**此刻起该批已可掉电恢复**。
6. **写缓冲**：点进入按 metric 分桶的内存缓冲（受 `maxBufferBytes` / `maxPendingPoints`
   双水位约束，越界触发同步 flush 或背压拒绝）。
7. **成块触发**（任一）：某 metric 缓冲点数 ≥ `blockTargetPoints`；flush 定时器（默认 5s）
   到期且 ≥ `blockMinPoints`；显式 `flush()`；缓冲字节水位触顶。
8. **滚动判定**：追加前测试"当前段字节 + 估计块大小 > `segmentMaxBytes`"——三种触发与三种
   不滚动的例外见 08 §1.1（块永不跨段；空段不滚；序号达 999 继续追加）。
9. **排序 + 编码**：块内时间戳稳定升序，时间戳/值分别编码（§3），质量数组按位追加，填块头与 CRC。
10. **落段**：`appendBlock` 追加整块字节 + 追加段内索引项。
11. **fsync 段文件 → 推进 WAL 安全点**（顺序不可颠倒）：`fsyncPolicy='wal'` 时每次有块
    落段就 fsync 活动段文件，**然后**才允许完成批次、推进安全点（§6）——保证"WAL 释放的
    数据必然已在段文件稳定存储"。最后 FIFO 逐个判定批次完成（每 metric 的"已落段累计数 −
    缓冲中点数 ≥ 批次累计数"），全部完成即截断 WAL。

---

## 6. WAL：行格式、批次账本与安全点

### 6.1 行格式（JSONL，一行一点，`\n` 结尾）

```jsonc
{"m":"station01.powerMeter.kwh","t":1699999999999,"v":1.5}
{"m":"station01.breaker","t":1699999999999,"v":"12345678901","vt":2}
```

- i64 用十进制文本 + `"vt":2` 标记（JSON 无 BigInt）。
- 非零 quality 追加 `"q":n`（u8 位域，缺省即 `0x00 = Good`）；回放时质量位随点回到写路径。
- metric 名禁止换行与 NUL，JSONL 天然安全。

### 6.2 批次账本与安全点

- `append`（一调用＝一批次）返回 `batchId` 与各日文件字节范围
  （`{dateNumber, startOffset, endOffset}`；跨日批次占两个范围）。
- 全部点落段后调用 `completeBatch(batchId)`，再 `commitSafePoint()`。
- **安全点 = 最早未完成批次的起始偏移**；无未完成批次 → 整个文件清零。
- 截断两种方式：无未完成批次时 `truncateSync` 直接清零；有保留区时**原子重写**
  （tmp 文件 + fsync + rename，随后重开追加句柄）——掉电发生在截断中也不会损坏保留区。
  （Windows 上打开中的追加句柄不允许 `ftruncate`，故保留路径必须走原子重写。）
- **已收养批次**（`WAL_ADOPTED_BATCH_ID = 0`）：打开时若当日 WAL 已有内容（上次崩溃遗留），
  整体注册为一个未完成批次，接管实例继续推进安全点，否则遗留行永远不会被释放。

### 6.3 为什么 WAL 会"涨满后清零"（锯齿是正常的）

默认 `flushIntervalMs = 5000`：安全点每 5 秒推进一次。以 20 000 点/秒为例，单个周期约
100 000 点 → WAL 峰值 ≈5.6 MB，成块落段 + fsync 后安全点到达文件头 → `truncate(0)` 清零。
同一周期落盘的段数据只有约 140 KB（6 MB JSONL ↔ 140 KB 段字节，压缩比数十倍），所以
**"WAL 清零且段文件只小幅增长"是数据守恒的表现，不是丢数据**。已封存数据量以 `count` /
`/api/v1/status` 为准。

---

## 7. 启动恢复

进程打开 dataRoot（`recoverDataRoot`）时：

1. 逐库逐日扫描：读段头（magic / version 校验），从块区顺序解析块（防御式，见 §4），
   遇到 Footer / 损坏即停——掉电截断的段文件仍能读出全部完整块。
2. 段内索引区缺失或与实际块区不一致 → 从实际块区重建，并原子重写 `.idx` 镜像。
3. 读 WAL（当日 JSONL），解析出**尚未落段**的点（按批次完成状态判断），按写入顺序重放
   进引擎（走正常写入路径，含去重与类型锁定）；遗留 WAL 注册为收养批次（§6.2）。
4. 全程持 `{dataDir}/lock` 独占锁；离线命令（`size` / `repair` / `restore` / `archive` /
   不带 `days` 的 `retention`）在服务运行时执行会返回 `E_DB_LOCKED`。

---

## 8. 常量与钳制表

引擎默认值（`ENGINE_DEFAULTS`）与钳制范围（`ENGINE_CLAMPS`）：

| 选项 | 默认值 | 钳制范围 | 说明 |
| ---- | ------ | -------- | ---- |
| retentionDays | 0 | 0–3650 | 0 = 不按天过期 |
| segmentMaxBytes | 209715200 (200MB) | 16MiB–4GiB | 段软上限（仅计 `.seg`） |
| segmentMaxPerDay | 1000 | 1–1000 | 受格式上限 999 约束 |
| blockTargetPoints | 16384 | 4096–65536 | 成块目标点数 |
| blockMinPoints | 1024 | 64–65536 | 定时 flush 的成块下限 |
| flushIntervalMs | 5000 | 200–60000 | flush 定时器周期 |
| maxBufferBytes | 268435456 (256MB) | 16MiB–2GiB | 写缓冲字节上限 |
| maxPendingPoints | 2000000 | 100k–10M | 写缓冲点数上限 |
| cacheBlocks | 256 | 16–4096 | 块缓存容量 |
| cacheFdGroups | 32 | 4–256 | 段文件句柄按天分组缓存数 |
| walEnabled | true | — | 关闭后写不可掉电恢复（仅限可重灌场景） |
| fsyncPolicy | `'wal'` | `'wal' \| 'none'` | `'none'` 跳过组提交 fsync 与段 fsync |
| qualityStore | `'all'` | `'all' \| 'good-uncertain' \| 'good'` | 质量落盘阈值；库级 `quality.json` 优先 |
| qualityOnReject | `'reject'` | `'reject' \| 'drop'` | 低于阈值：整批拒绝或丢弃并计入 `write.qualityDropped` |

写入边界（`WRITE_LIMITS`）：metric 名 ≤512 字节 UTF-8；string 值 ≤256 字节 UTF-8；
i64 ∈ ±2^53；时间戳毫秒 epoch；质量位为整数 `0..255`（越界抛 `E_INVALID_POINT`）。

---

## 9. 实现索引

| 内容 | 源码 |
| ---- | ---- |
| 段头 / 块头 / Footer / 索引布局、CRC、常量 | `src/packages/core/src/format.ts` |
| 段生命周期：建段 / 滚动 / 封口 / `.idx` / fsync | `src/packages/core/src/segment-store.ts` |
| 写缓冲、成块触发、块编码 | `src/packages/core/src/segment-writer.ts` |
| codec 注册与自动选择 | `src/packages/core/src/encoder/registry.ts`（及 `encoder/*-codec.ts`） |
| WAL：行格式 / 批次 / 安全点 / 截断 | `src/packages/core/src/wal.ts` |
| 写入编排、批次账本、恢复重放 | `src/packages/core/src/engine.ts` |

---

## 更新日志

| 日期 | 变更 | 处理模型 |
| ---- | ---- | -------- |
| 2026-10-17 | 创建本页：段文件物理布局、编码与 CRC、写入十步链路、WAL 行格式与安全点（含"WAL 涨满清零"的解释）、启动恢复、常量与钳制表 | GLM-5.3-Flash |
| 2026-10-17 | §2.2 块 flags 新增 bit3 `receivedTime`：块尾 16B `[receivedMin][receivedMax]` 服务器接收时间窗口（计入 `totalLength` 与 CRC 链）；§4 CRC 链同步 | GLM-5.3-Flash |
| 2026-10-18 | 质量位落地：§1 目录树补 `retention.json` / `quality.json`；§2.2 flags bit2 `qualityPresent` 由预留改为实装（块尾 `pointCount` B 质量数组，全 Good 零开销）；§4 CRC 链纳入质量数组；§5 写入链路新增质量落盘策略步骤（reject / drop）；§6 WAL `q` 语义更新；§8 常量表补 `qualityStore` / `qualityOnReject` 与质量值域 | DeepSeek-V4.1-Flash |
