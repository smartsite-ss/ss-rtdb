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
rtdbctl backup plant_a /mnt/backups/2026-10-17
# -> /mnt/backups/2026-10-17/plant_a
```

或通过 API / SDK：

```bash
curl -X POST "http://127.0.0.1:6180/api/v1/backup/plant_a" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"targetDir":"/mnt/backups/2026-10-17"}'
```

- **无需停服**：已封存的段不可变，因此拷贝结果是一致的。
- 由于日目录自包含，**拷走一个日目录 = 该天的完整备份**。
  `cp -a {dataDir}/{db}/20261017 /backup/` 就是一次合法的日级备份。
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

恢复是**替换式**的：目标数据库目录被备份内容替换，然后重新执行该库的启动恢复与 WAL 重放。
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

**一致性承诺**：已封存的段数据永久安全；最多丢失最后 ≤5 秒的 WAL 中的点。
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

参考预算：空闲时内存占用远低于 100 MB RSS；1 万个混合周期指标保持在约 500 MB 以内。
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
