# 08 — 运维与维护

## 1. 磁盘布局

```
{dataDir}/
├── lock                      # 数据根归属（pid）
├── rtdb-users.json           # 用户目录（scrypt 哈希）
├── rtdb-tokens.json          # API 令牌目录（仅哈希）
├── archive/                  # 冷归档：{db}/yyyyMMdd.tar.gz
└── {database}/
    ├── retention.json        # 按库保留策略覆盖值（可选）
    └── 20261017/             # 日目录 —— 保留 / 备份 / 故障隔离的单位
        ├── 20261017-000.seg  # 按容量滚动的段文件（已封存的段只读且不可变）
        ├── 20261017-000.idx  # 段内索引快照（可由 .seg 重建）
        ├── 20261017-001.seg  # 上一个段达到 storage.segment.maxBytes 后滚动生成
        ├── 20261017-001.idx
        ├── 20261017.wal      # 预写日志（仅当日；刷盘后截断）
        ├── 20261017.bfill.seg   # 回填旁路文件（窗口外 / 历史写入）
        └── 20261017.bfill.idx
```

两级设计：

- **日目录**（`yyyyMMdd/`）= 保留、备份与故障隔离的单位。保留策略直接删除整个目录；
  拷走该目录就等于完整备份了那一天。
- **容量段**（`yyyyMMdd-NNN.seg`）= 物理 I/O 与恢复的单位。滚动只在块边界发生，
  因此一个块永不跨段。三位零填充保证字典序等于时间序，日期前缀则保证文件离开目录后仍可辨认。

### 1.1 段文件的生成与滚动规则

一个新 `.seg` 只在三种时刻被创建：

1. **首次写入**：数据库当天没有活动段（新库 / 新的一天 / 服务重启后的第一个块）时创建，
   序号 = 当天已存在的最大序号 + 1（重启后自动续号，不覆盖既有文件）；建段用独占创建
   （`wx+`）并写入 32 B 段头后 fsync。
2. **跨天滚动**：块的时间戳进入新的本地日时，**同步预创建**新日目录与新段（mkdir + create，
   <1 ms），旧段自动封口 —— 保证按天裁剪查询时日边界总是完整的。
3. **容量滚动**：追加块之前判断 `已写字节 + 预估块字节 > storage.segment.maxBytes`（默认 200 MiB），
   满足则封旧段、建下一序号。

三条不滚动的例外：

- **空段不滚动**：还没有写入任何块的段直接继续追加。否则"单个块本身超过 200 MiB"会触发无限滚动；
- **块不跨段**：一个块要么整个进入当前段，要么触发滚动后整体进入新段。因此 `maxBytes` 是**软上限**，
  实际文件最多超出一个块的大小（≤ `blockTargetPoints` 个点）；
- **序号到顶不滚动**：当天段数达到 `maxPerDay`（且受格式上限 999 约束）后停止滚动、继续往当前段
  追加 —— 宁可超出软限制也不丢数据。

封口（seal）= 段文件终结，之后不可再追加（拷走即备份）。触发：容量滚动、跨天、停机 `close()`。
动作：写 Footer（16 B，CRC 覆盖段头 + 索引偏移）→ 写段内索引区 → fsync → 关写句柄 → 原子重写
`.idx` 镜像。`.idx` 丢失或损坏时由启动恢复按扫块结果重建；进程被强制终止（未封口）不影响读取，
但该段没有 `.idx` 镜像，恢复时索引在内存中重建。

## 2. 数据根锁

一个 `dataDir` 同一时刻只能被**一个进程**打开。由此带来的约束：

- 不要让 `rtdb-server` 与嵌入式 `RtdbEngine` 同时指向同一目录 —— 后者会报 `E_DB_LOCKED`。
- **所有离线 `rtdbctl` 命令**（`size`、`repair`、`restore`、`archive`，以及不带 `days` 参数的
  `retention`）都需要独占访问。请先停服：

```bash
systemctl stop ss-rtdb
rtdbctl repair plant_a
systemctl start ss-rtdb
```

- 已死进程持有的锁会被检测（pid 存活检查）并自动接管。
- 同一数据根内的多个数据库没有问题：它们由同一进程并发写入。

## 3. 备份

```bash
# 整库
rtdbctl backup plant_a /mnt/backups/2026-10-17
# -> /mnt/backups/2026-10-17/plant_a

# 按天时间段（含首末；--from/--to 均可用 yyyyMMdd，缺省一侧取最早/最新日目录）
rtdbctl backup plant_a /mnt/backups/2026-09 --from 20260901 --to 20260930
# -> /mnt/backups/2026-09/plant_a（含 manifest.json，还原时按天合并）
```

或通过 API / SDK：

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/backup/plant_a" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"targetDir":"/mnt/backups/2026-10-17"}'

curl -X POST "http://127.0.0.1:6180/api/v1/backup/plant_a" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"targetDir":"/mnt/backups/2026-09","startDay":"2026-09-01","endDay":"2026-09-30"}'
```

- **无需停服**：已封存的段不可变，因此拷贝结果是一致的。
- 由于日目录自包含，**拷走一个日目录 = 该天的完整备份**。
  `cp -a {dataDir}/{db}/20261017 /backup/` 就是一次合法的日级备份。
- **时间段备份**只复制范围内的日目录（外加库级 `retention.json`），并在备份目录写入 `manifest.json`。
  还原时按清单**合并**：同日整体替换、范围外的日目录保持不动 —— 用于"只回补某几天"而不会冲掉其余历史。
  整库备份不带清单，还原仍是整目录替换。
- 范围内没有日目录、起止倒置或日期非法 → `400 E_INVALID_RANGE`；备份目录已存在同名库目录时会被整体替换
  （同一目标重复备份是幂等的）。
- `rsync` / `cp` / 快照工具都可用；没有专有的 dump 格式。

## 4. 恢复

```bash
systemctl stop ss-rtdb

# 从备份目录恢复整库
rtdbctl restore plant_a /mnt/backups/2026-10-17

# 或恢复单个归档日
rtdbctl restore plant_a --archive 20261015

systemctl start ss-rtdb
```

恢复的语义取决于备份类型：

- **整库备份**（无 `manifest.json`）→ **替换式**：目标数据库目录被备份内容整体替换，然后重新执行该库的
  启动恢复与 WAL 重放。
- **时间段备份**（含 `manifest.json`）→ **合并式**：只写入清单里的日目录（同日整体替换），范围外的日目录
  与库级保留策略保持不变，随后同样重跑启动恢复与 WAL 重放。`rtdbctl restore` 会打印 `mode: merge` 与
  实际写入的日期；清单损坏会直接报错而不会退化为整库替换。

恢复后请校验：

```bash
rtdbctl size plant_a --by-day
rtdbctl metrics plant_a
```

## 5. 归档（冷存储）

```bash
rtdbctl archive plant_a            # 列出现有归档
rtdbctl archive plant_a 20261015   # 把该日打包到 {dataDir}/archive/plant_a/20261015.tar.gz
```

若希望过期时自动归档而不是删除，在配置文件中设置：

```json
{ "retentionDays": 90, "archiveBeforeDelete": true, "archiveDir": "/var/lib/ss-rtdb/archive" }
```

`archiveDir` 必须与 `dataDir` 位于**同一卷**（实现上是按目录打包的）。

## 6. 保留策略

- 全局默认值：配置文件中的 `retentionDays`（`0` = 永久保留）。
- 按库覆盖：`rtdbctl retention plant_a 90` 或 `PUT /api/v1/retention/plant_a`，
  持久化到 `{dataDir}/{db}/retention.json`，重启后仍然有效。
- 清理按定时器运行，只**删除完全过期的整个日目录**。只有已封存、非当日的日目录会被删除，
  因此不会与活跃写入竞争。
- 用 `rtdbctl retention plant_a` 离线读取生效值（无覆盖时显示
  `(not set; the global default applies)`，即未设置、沿用全局默认）。
- 形态 A 可立即强制执行一次清理：`await rtdb.runRetention()`。

保留策略也正是日目录存在的原因：过期即删除目录，而不是做段合并，因此没有压实压力。

## 7. 修复

```bash
systemctl stop ss-rtdb
rtdbctl repair plant_a            # 整库
rtdbctl repair plant_a 20261017   # 仅某日
systemctl start ss-rtdb
```

`repair` **幂等**，可安全重复执行。它会：

1. 截断 CRC 校验失败的半写块尾；
2. 从 `.seg` 文件重建缺失 / 过期的 `.idx` 镜像；
3. 重放 WAL，并丢弃无法解析的 WAL 尾部。

校验和与 CRC 保证损坏被限制在受损块内；已封存的段不可变，因此已写入的数据永不被重写。

## 8. 崩溃恢复

每次启动时（或 `restore` 之后）：

1. 扫描每个数据库的日目录，加载 / 重建段索引（含 `.bfill.idx`）。
2. 重放当日 WAL，按时间戳对段尾去重。
3. 截断任何半块（CRC 失败）并打印警告。

**一致性承诺**：任意时刻，点要么已在段文件中（块落段后先 `fsync` 段文件，然后才推进 WAL 安全点），
要么仍在 WAL 中（每次追加后成组 `fsync`）。`fsyncPolicy='wal'`（默认）下进程崩溃与断电都不丢点；
`fsyncPolicy='none'` 仅适用于数据可重灌的场景。已封存的段数据永久安全。
客户端只需重试失败的批次 —— 写入按 `(指标, 时间戳)` 幂等。

窗口外的写入会进入**回填旁路文件**（`yyyyMMdd.bfill.seg`），而不会修改已封存的主段；
查询按时间戳合并主段与回填数据，冲突时以主段为准。

## 9. 监控

| 端点 | 鉴权 | 用途 |
| ---- | ---- | ---- |
| `GET /healthz` | 无 | 存活探针 → `{"status":"ok"}` |
| `GET /metrics` | 无 | Prometheus 文本暴露格式 |
| `GET /api/v1/status` | 无 | 完整 JSON 运行时报告 |
| `GET /api/v1/databases`、`/api/v1/metrics/:db` | query | 资源清单 |

建议基于 `GET /api/v1/status` 配置的告警：

| 信号 | 原因 |
| ---- | ---- |
| `wal.pendingBytes` / `wal.pendingPoints` 持续增长 | 下游跟不上；很快会出现 `429` |
| `write.pointsPerSec` 远低于写入速率 | 背压或客户端变慢 |
| `cache.blockHitRate` 下降 | 提高 `cache.blocks` |
| `query.p99Ms` 上升 | 考虑更大的块或更多的 `cache.blocks` |
| `segments.bytesToday` | 容量规划 / 保留策略容量估算 |
| `gc.maxMs` | GC 长停顿 → 检查堆压力 |

Prometheus 抓取示例：

```yaml
scrape_configs:
  - job_name: ss-rtdb
    static_configs:
      - targets: ['127.0.0.1:6180']
    metrics_path: /metrics
```

systemd 存活配置：

```ini
[Service]
ExecStart=/usr/bin/node packages/server/src/main.ts
ExecStop=/bin/kill -TERM $MAINPID
Restart=on-failure
WatchdogSec=0
```

## 10. 容量估算与调优

| 目标 | 调节项 |
| ---- | ------ |
| 更少更大的文件（压缩更好） | ↑ `write.blockTargetPoints`（4 096…65 536） |
| 稀疏指标下降低写入延迟 | ↓ `write.blockTargetPoints`，↑ `write.flushIntervalMs` |
| 限制文件大小以便备份 / rsync | ↓ `storage.segment.maxBytes`（16 MiB…4 GiB） |
| 热点查询性能 | ↑ `cache.blocks`（16…4 096） |
| 持久性与吞吐的取舍 | `write.fsyncPolicy: 'wal'`（安全）vs `'none'`（快，交给操作系统刷盘） |
| 突发时的内存上限 | `write.maxBufferBytes`、`write.maxPendingPoints`（返回 `429` 而不是 OOM） |
| 查询的内存上界 | 查询原语按**块簇**流式扫描：`count exact` / 聚合 / `queryAt` / 任意方向的 `range`，内存随命中块簇与聚合窗口数增长，与命中点数无关（2026-10-18 起生效） |

参考预算：空闲时内存占用远低于 100 MB RSS；1 万个混合周期指标保持在约 500 MB 以内。
查询侧内存与命中点数解耦（见上表），长区间查询不再随命中点数线性增长。
目标：持续写入 ≥5 万点/秒；16 384 点整块压缩比 ≥10 倍；
单指标 7 天区间查询冷态 ≈ ≤300 ms / 热态 ≤50 ms。

## 11. 两种形态之间迁移

两种形态的数据目录格式完全一致。

- **A → B**：停止嵌入方应用，然后用指向同一目录的 `dataDir` 启动 `rtdb-server`。无转换步骤。
- **B → A**：停止服务，然后在同一目录上打开 `RtdbEngine`。
- 切勿让两者同时指向同一目录（`E_DB_LOCKED`）。

## 12. 例行检查清单

```bash
# 每日
rtdbctl status
rtdbctl backup plant_a /mnt/backups/$(date +%F)

# 每周（维护窗口）
systemctl stop ss-rtdb
rtdbctl repair plant_a
rtdbctl size plant_a --by-day
systemctl start ss-rtdb

# 每季度
rtdbctl token list                 # 吊销过期令牌
rtdbctl user list                  # 清理无用账号
rtdbctl archive plant_a            # 复查冷归档
```

## 13. 下一步

- [09 — 开发者指南](./09-developer-guide.md)

---

## 更新日志

| 日期 | 变更 | 处理模型 |
| ---- | ---- | -------- |
| 2026-10-17 | 创建中文译本；§13 下一步补 09 开发者指南链接 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 重写一致性承诺：点要么在段文件（落段后先 fsync 段文件再推进 WAL 安全点）要么在 WAL（追加即成组 fsync）；`fsyncPolicy='wal'` 下崩溃与断电均不丢点 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增 §1.1 段文件的生成与滚动规则：三种创建触发（首次写入续号 / 跨天预创建 / 容量滚动）、三条不滚动例外（空段、块不跨段即软上限、序号到顶继续追加）、封口动作与 `.idx` 重建口径 | DeepSeek-V4.1-Flash |
| 2026-10-18 | §10 容量估算补「查询的内存上界」行：查询原语按块簇流式扫描，内存与命中点数解耦（`count exact` / 聚合 / `queryAt` / 降序 `range` 不再物化全部命中点） | GLM-5.3-Flash |
| 2026-10-18 | §3 备份新增按天时间段（`rtdbctl backup --from/--to`、API `startDay`/`endDay`、`manifest.json`）；§4 恢复区分替换式（整库）与合并式（时间段，范围外数据不删） | DeepSeek-V4.1-Flash |
