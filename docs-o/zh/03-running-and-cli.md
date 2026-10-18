# 03 — 运行服务与 `rtdbctl` CLI

## 1. 启动服务

```bash
# 在工作区根目录（src/）下
npm start --workspace @ss/rtdb-server

# 或直接运行
node packages/server/src/main.ts
node packages/server/src/main.ts   # 通过 RTDB_CONFIG 附加 --config
```

> **运行期配置文件。** 服务会从**工作目录**下的 `conf/rtdb-server.json` 加载配置（存在时，见
> [02 — 配置](./02-configuration.md) §2）。`bin\start-server.bat` 以仓库 / 发布包根目录作为工作目录启动，
> 因此该文件会自动生效；`npm start --workspace @ss/rtdb-server` 的工作目录是 `src/packages/server`，
> 那里没有 `conf/`，请显式设置 `RTDB_CONFIG`，或在根目录用 `node src/packages/server/src/main.ts` 启动。

启动日志：

```
rtdb-server started: http://127.0.0.1:6180 (dataDir=./rtdb-data)
```

启动顺序：获取数据根锁 → 扫描日目录 → 重建缺失的 `.idx` → 重放当日 WAL →
启动刷盘定时器与保留策略定时器 → 绑定 HTTP 监听。

**停止。** 发送 `SIGINT`（Ctrl+C）或 `SIGTERM`；服务会先刷缓冲区、封存活动段、截断 WAL、
释放数据根锁再退出。不要对健康的服务使用 `SIGKILL` —— 那样最多丢失最后 ≤5 秒的 WAL，
同时还会留下一个待回收的锁。

### 交互式控制台按键

当 stdin 是终端时（`rtdb-server.exe` 窗口、`bin\start-server.bat`、或在 shell 里 `npm start`），服务会监听单键：

| 按键 | 动作 |
| ---- | ---- |
| `q`（或 `Ctrl+C`） | 安全退出 —— 与 `SIGINT` 同一条路径：停止接收请求、等待在途请求结束、刷盘并关闭引擎、释放数据根锁、以 `0` 退出 |
| `r` | 安全重启 / 重载 —— 停止监听与引擎，重新读取配置文件（`conf/rtdb-server.json` 或 `RTDB_CONFIG` 指定的文件），然后**在同一进程内**重新启动 |

- 想在不关窗口的情况下应用配置变更（端口、默认保留天数、日志级别等），按 `r` 即可。
- 重载失败（JSON 非法、端口已被占用）会打印错误并**保持进程存活**：改好文件再按 `r`，或按 `q` 退出。
- 仅在 stdin 为 TTY 时挂载按键；systemd / 重定向 stdin 场景不接管输入，仍由信号控制。
- `q` / `r` 不区分大小写；其它按键一律忽略（Ctrl+字母组合键有意忽略）。

### 首次运行令牌

当 `auth.enabled = true`（默认）且 `auth.token` 为空时，服务会读取 `auth.tokenFile`
（默认 `./rtdb.token`）；若不存在则生成一个 64 位十六进制令牌，以 `0600` 权限写入该文件，
并打印 `WARN` 日志指明文件路径。请立即妥善保存 —— 所有写入和查询都需要它。

```bash
cat ./rtdb.token
```

轮换令牌：删除该文件（或显式设置 `auth.token`）后重启。

### 以服务方式运行

**systemd**（`/etc/systemd/system/ss-rtdb.service`）：

```ini
[Unit]
Description=ss-rtdb server
After=network.target

[Service]
Type=simple
User=ssrtdb
WorkingDirectory=/opt/ss-rtdb/src
Environment=RTDB_CONFIG=/etc/rtdb/rtdb.config.json
ExecStart=/usr/bin/node packages/server/src/main.ts
ExecStop=/bin/kill -TERM $MAINPID
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ss-rtdb
journalctl -u ss-rtdb -f
```

**Windows**：可用服务包装器（NSSM 之类）运行 `node packages/server/src/main.ts`，
同样遵守 `SIGINT` / `SIGTERM` 约定。也可以使用 `rtdbctl serve`，它会自行安装 `SIGINT`
处理器并干净关闭。

---

## 2. `rtdbctl` — 命令行工具

`rtdbctl` 既能驱动一个正在运行的服务（**在线**命令，走 HTTP），也能直接操作数据目录
（**离线**命令）。离线命令需要对数据根的独占所有权，因此**请先停止服务**再运行，
否则会得到 `E_DB_LOCKED`。

### 2.1 用法

```
rtdbctl <命令> [参数] [选项]
```

| 选项 | 含义 |
| ---- | ---- |
| `--config <path>` | 配置文件路径（也可用 `RTDB_CONFIG`） |
| `--data-dir <path>` | 离线命令使用的本地数据根（也可用 `RTDB_DATA_DIR`） |
| `--url <baseUrl>` | 在线命令使用的服务基址（也可用 `RTDB_URL`） |
| `--token <token>` | 访问令牌（也可用 `RTDB_TOKEN`） |
| `--timeout <ms>` | 在线命令的单请求超时 |
| `--role <role>` | `admin` \| `write` \| `readonly` |
| `--password <pw>` | 用户口令（`user add` / `user passwd`） |
| `--label <text>` | 令牌备注（`token issue`） |
| `--ttl <ms>` | 令牌有效期（毫秒，`token issue`；省略 = 永不过期） |
| `--disabled` | 创建为禁用状态（`user add`） |
| `--json` | 输出机器可读的 JSON |
| `--by-day` | 包含按日明细（`size`） |
| `-h`，`--help` | 帮助 |
| `-v`，`--version` | 版本 |

**退出码**：`0` 成功 · `1` 运行期失败 · `2` 用法错误（参数缺失或非法）。

### 2.2 命令一览

| 命令 | 传输方式 | 说明 |
| ---- | -------- | ---- |
| `serve [--config <path>]` | 进程内 | 前台启动服务 |
| `status [--json]` | HTTP `GET /api/v1/status` | 打印运行时状态报告 |
| `metrics <db> [--prefix <p>]` | HTTP `GET /api/v1/metrics/:db` | 列出指标及其首/末时间戳 |
| `backup <db> <dir> [--from <day>] [--to <day>]` | HTTP `POST /api/v1/backup/:db` | 把某库备份到 `<dir>/<db>`；`--from`/`--to` 限定日期范围（`yyyyMMdd`，含首末） |
| `retention <db> [days]` | HTTP `PUT` / 本地读取 | 打印（不传 `days`）或设置保留策略 |
| `size <db> [--by-day]` | 离线 | 某库的磁盘占用 |
| `repair <db> [<yyyyMMdd>]` | 离线 | 重建索引、截断损坏的块尾 |
| `restore <db> <dir>` | 离线 | 从 `<dir>/<db>` 恢复某库 |
| `restore <db> --archive <yyyyMMdd>` | 离线 | 恢复某个已归档日 |
| `archive <db> [<yyyyMMdd>]` | 离线 | 归档某日（不传日期 = 列出归档） |
| `user add\|list\|remove\|passwd` | HTTP `/api/v1/admin/users` | 用户管理（需 `admin` 权限域） |
| `token issue\|list\|revoke` | HTTP `/api/v1/admin/tokens` | API 令牌管理（需 `admin` 权限域） |

### 2.3 `serve`

```bash
rtdbctl serve --config ./rtdb.config.json
# rtdbctl serve: listening on http://127.0.0.1:6180 (dataDir=./rtdb-data)
```

使用与其他子命令完全一致的配置解析，在 **CLI 进程内部**启动 `RtdbServer`，
然后等待 `SIGINT` / `SIGTERM` 以优雅关闭。

### 2.4 `status`

```bash
rtdbctl status
rtdbctl status --json
```

```
uptimeMs: 12,345
databases: 2
metrics: 1,204
cpu.percent: 12.50 %
cpu.systemPercent: 1.56 %
memory.rssMb: 96.40 MiB
memory.systemPercent: 1.18 %
memory.heapPercent: 45.39 %
write.pointsPerSec: 51,230
write.buffered: 0
write.duplicates: 13
write.tagsIgnored: 0
wal.pendingBytes: 0 B
wal.outstandingBatches: 0
segments.openFiles: 3
cache.blocks: 256
```

`cpu.percent` 是**单核**百分比（多核满载可超过 100），`cpu.systemPercent` 是占整机 CPU 的比例；
`memory.rssMb` 为常驻内存，`memory.systemPercent` = RSS / 主机总内存，`memory.heapPercent` = 堆已用 / 堆总量。

`--json` 形式输出完整报告，还包括 `wal.pendingPoints`、`wal.lastFsyncMs`、
`segments.bytesToday`、`cpu.userMs`/`cpu.systemMs`、`memory.heapTotalMb`/`systemTotalMb`、
`cache.blockHitRate`、`cache.heapUsedMb`、`gc.*` 以及 `query.p50/p95/p99/maxMs`。

### 2.5 `metrics`

```bash
rtdbctl metrics plant_a
rtdbctl metrics plant_a --prefix station01 --json
```

```
Metric                        First                 Last
----------------------------  --------------------  --------------------
station01.powerMeter.kwh      2026-10-17 09:00:00   2026-10-17 09:05:00
station01.powerMeter.voltage  2026-10-17 09:00:00   2026-10-17 09:05:00
2 metric(s)
```

### 2.6 `backup`

```bash
# 整库
rtdbctl backup plant_a /mnt/backups

# 只备份 2026-09 全月（含首末两天）
rtdbctl backup plant_a /mnt/backups/2026-09 --from 20260901 --to 20260930
```

把整个数据库目录复制到 `/mnt/backups/plant_a`，并报告 `mode` / `files` / `totalBytes`。
该操作复制的是**已封存**数据加上当日活动段；由于已封存的段不可变，
因此无需停服即可得到一致的副本。

带 `--from` / `--to` 时只复制范围内的日目录（外加库级 `retention.json`），并在备份目录写入
`manifest.json`；输出中的 `mode` 为 `range`，`days` 给出实际范围。此类备份在 `restore` 时**按天合并**，
范围外的日目录不会被删除（详见 [08 — 运维](./08-operations.md) §3、§4）。

### 2.7 `restore`

```bash
# 整库恢复（必须停服）
rtdbctl restore plant_a /mnt/backups

# 恢复单个归档日
rtdbctl restore plant_a --archive 20261015
```

恢复是**替换式拷贝**：目标数据库目录会被备份内容替换，然后重新执行该库的启动恢复与 WAL 重放。

### 2.8 `archive`

```bash
rtdbctl archive plant_a            # 列出现有归档
rtdbctl archive plant_a 20261015   # 把该日打包为 {dataDir}/archive/plant_a/20261015.tar.gz
```

### 2.9 `retention`

```bash
rtdbctl retention plant_a          # 读取生效的保留天数
rtdbctl retention plant_a 90       # 设为 90 天（通过服务在线设置）
rtdbctl retention plant_a 0        # 永久保留
```

读取是离线操作（读 `{dataDir}/{db}/retention.json`）；**设置**是在线调用，需要服务处于运行状态。
未设置时输出：`retentionDays: (not set; the global default applies)`（未设置，沿用全局默认）。

### 2.10 `size`

```bash
rtdbctl size plant_a --by-day
rtdbctl size plant_a --json
```

```
database: plant_a
directory: /var/lib/ss-rtdb/plant_a
files: 42
size: 1.8 GiB (1932735283 bytes)
retentionDays: 90

Day         Files  Size
----------  -----  -------
20261015       12  512 MiB
20261016       14  540 MiB
20261017       16  610 MiB
```

### 2.11 `repair`

```bash
rtdbctl repair plant_a             # 整库
rtdbctl repair plant_a 20261017    # 仅某日
```

幂等的离线维护：截断半写的块尾（CRC 校验失败）、从 `.seg` 文件重建 `.idx` 镜像、
重放或丢弃 WAL 尾部。可安全重复执行。报告项包括 `truncatedSegments`、`rebuiltIndexes`、
`replayedWalEntries`、`discardedWalTailBytes`。

### 2.12 `user`

```bash
rtdbctl user add alice --password 'S3cret!' --role write
rtdbctl user add bob   --password 'S3cret!' --role readonly --disabled
rtdbctl user list
rtdbctl user passwd alice --password 'N3wSecret!'
rtdbctl user remove bob
```

`user add` 的默认角色是 `write`。口令只以 scrypt 哈希保存；API 永不返回口令相关内容。
所有 `user` 子命令都需要 **admin** 凭据。

### 2.13 `token`

```bash
rtdbctl token issue alice --label 'collector-01' --ttl 2592000000
rtdbctl token list
rtdbctl token revoke 7f3c9a1e...
```

明文令牌**只在签发时显示一次**（`token: …`），服务端只保存其哈希。`token issue` 的角色默认取
所属用户的角色（用户不存在时为 `write`），省略 `--ttl` 表示永不过期。`token list` 会显示状态列：
`active` / `revoked` / `expired`。

---

## 3. 典型运维流程

```bash
# 1. 检查健康与负载（无需凭据）
curl http://127.0.0.1:6180/healthz
rtdbctl status

# 2. 创建最小权限的写入账号
rtdbctl user add collector --password "$COLLECTOR_PW" --role write
rtdbctl token issue collector --label 'edge-gateway-1'

# 3. 每日备份（服务保持运行）
rtdbctl backup plant_a /mnt/backups/$(date +%F)

# 4. 每周维护窗口：停服 → 修复 + 统计 → 启动
systemctl stop ss-rtdb
rtdbctl repair plant_a
rtdbctl size plant_a --by-day
systemctl start ss-rtdb
```

## 4. 下一步

- [04 — HTTP API](./04-http-api.md) —— 所有在线命令背后的接口契约。
- [08 — 运维与维护](./08-operations.md) —— 备份策略、保留策略、监控。

---

## 更新日志

| 日期 | 变更 | 处理模型 |
| ---- | ---- | -------- |
| 2026-10-17 | 创建中文译本 | DeepSeek-V4.1-Flash |
| 2026-10-17 | §1 补充运行期配置文件 `conf/rtdb-server.json`（相对工作目录）及两种启动方式的差异 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增「交互式控制台按键」：`q` 安全退出、`r` 安全重启（就地重读配置），仅 TTY 生效 | DeepSeek-V4.1-Flash |
| 2026-10-18 | §2.2 命令表与 §2.6 `backup` 新增 `--from` / `--to` 时间段参数（只复制范围内日目录、写 `manifest.json`、还原时按天合并） | DeepSeek-V4.1-Flash |
| 2026-10-18 | §2.4 `status` 输出新增 `cpu.percent`、`cpu.systemPercent`、`memory.rssMb`、`memory.systemPercent`、`memory.heapPercent`，并补充单核百分比与整机占比的口径说明 | DeepSeek-V4.1-Flash |
