# 02 — 配置

本页说明**形态 B**（`rtdb-server` / `rtdbctl`）的配置。形态 A 把等价选项直接传给
`RtdbEngine`，见 [06 — 嵌入式引擎](./06-embedded-engine.md) §2 引擎选项。

## 1. 优先级

配置由四层合并而成，优先级从低到高：

```
内置默认值  <  配置文件  <  环境变量  <  显式参数
```

- **配置文件**：JSON。**工作目录**下的 `conf/rtdb-server.json` 存在时会自动加载（仓库与发布包都自带该文件）；
  `--config <path>` 或 `RTDB_CONFIG` 指向别的文件，此时**取代**默认文件，而不是在其之上叠加。
- **环境变量**：见 §4 的表格。
- **显式参数**：把 `RtdbServer` 嵌入自己进程时传入的 `overrides` 对象；`rtdbctl` 的
  `--data-dir` / `--url` / `--token` / `--timeout` 开关（这些只影响 CLI，不影响服务配置）。

配置文件中的未知键被忽略。超出支持范围的数值会被**钳制**到边界并打印 `WARN` 日志 ——
一个坏数值绝不会阻止启动。只有真正的*语义冲突*才会导致启动失败（§5）。

## 2. 配置文件

运行期布局把配置放在 `conf/rtdb-server.json`：

```
ss-rtdb/            （仓库根目录，或发布包的根目录）
├── bin/            启动 / 打包脚本
├── conf/
│   └── rtdb-server.json    <- 改这个文件；由工作目录自动加载
└── src/
```

`bin\start-server.bat` 会把仓库（或发布包）根目录作为工作目录启动服务，因此无需任何环境变量即可加载该文件。
在别的目录启动服务时，若未设置 `RTDB_CONFIG`，则直接使用内置默认值。下面的文件列出了**全部键及其默认值**，
可直接当模板使用 —— 每个键都可省略，省略则保持默认值：

```json
{
  "port": 6180,
  "host": "127.0.0.1",
  "dataDir": "./rtdb-data",
  "retentionDays": 0,
  "archiveDir": "",
  "archiveBeforeDelete": false,

  "auth": {
    "enabled": true,
    "mode": "token",
    "token": "",
    "tokenFile": "./rtdb.token",
    "username": "admin",
    "password": "",
    "passwordHash": "",
    "bootstrapUsername": "admin",
    "bootstrapPassword": "ss-rtdb",
    "write": true,
    "query": true,
    "usersFile": "",
    "tokensFile": ""
  },

  "admin": { "enabled": true, "staticDir": "", "exposePaths": false },
  "cors": { "allowedOrigins": [] },

  "write": {
    "walEnabled": true,
    "fsyncPolicy": "wal",
    "blockTargetPoints": 16384,
    "blockMinPoints": 1024,
    "flushIntervalMs": 5000,
    "maxBufferBytes": 268435456,
    "maxPendingPoints": 2000000,
    "maxBatch": 1000000
  },

  "storage": { "segment": { "maxBytes": 209715200, "maxPerDay": 1000 } },
  "cache": { "blocks": 256, "fdGroups": 32 },
  "query": { "defaultLimit": 100000 },
  "http": { "maxBodyBytes": 67108864 },
  "log": { "level": "info" }
}
```

指定文件启动：

```bash
rtdbctl serve --config /etc/rtdb/rtdb.config.json                       # CLI（会解析 --config）
RTDB_CONFIG=/etc/rtdb/rtdb.config.json npm start --workspace @ss/rtdb-server
```

`rtdb-server` 本身不读取任何命令行参数 —— 请通过 `RTDB_CONFIG` 传入配置路径。

## 3. 配置项参考

| 键 | 默认值 | 含义 |
| -- | ------ | ---- |
| `port` | `6180` | HTTP 端口。`0` = 由操作系统分配空闲端口（测试 / 容器用）。 |
| `host` | `127.0.0.1` | 监听地址。 |
| `dataDir` | `./rtdb-data` | **数据根目录**。同一时刻只能被一个进程占用。 |
| `retentionDays` | `0` | 全局默认保留天数；`0` = 永久保留。按库覆盖优先。 |
| `archiveDir` | `""` | 冷归档目标目录；留空 = `{dataDir}/archive`。必须与数据根在同一卷。 |
| `archiveBeforeDelete` | `false` | 删除过期日目录前先打包成 `tar.gz`。 |
| `auth.enabled` | `true` | 鉴权总开关。 |
| `auth.mode` | `token` | `token` \| `basic` \| `both`。 |
| `auth.token` | `""` | 静态 Bearer 令牌。留空 → 读取/生成 `auth.tokenFile`。 |
| `auth.tokenFile` | `./rtdb.token` | 自动生成的令牌存放位置（权限 `0600`）。 |
| `auth.username` | `admin` | Basic 认证用户名，同时也是静态令牌所归属的身份。 |
| `auth.password` | `""` | Basic 认证口令（配置中明文；建议用 `passwordHash`）。 |
| `auth.passwordHash` | `""` | scrypt 哈希 `scrypt$N$r$p$saltHex$hashHex`，由 `auth.hashPassword()` 生成。 |
| `auth.bootstrapUsername` | `admin` | 首次启动（用户目录为空）时自动创建的默认管理员用户名；置空则关闭引导。 |
| `auth.bootstrapPassword` | `ss-rtdb` | 上述默认管理员的口令（只以 scrypt 哈希落盘）；置空则关闭引导。 |
| `auth.write` | `true` | 写入接口要求凭据。 |
| `auth.query` | `true` | 查询接口要求凭据。 |
| `auth.usersFile` | `""` | 用户目录 JSON；留空 = `{dataDir}/rtdb-users.json`。 |
| `auth.tokensFile` | `""` | API 令牌目录 JSON；留空 = `{dataDir}/rtdb-tokens.json`。 |
| `admin.enabled` | `true` | 在 `/admin` 提供 Web 控制台。 |
| `admin.staticDir` | `""` | 覆盖控制台静态资源目录；留空 = 内置的 `packages/admin/dist`。 |
| `admin.exposePaths` | `false` | `false`：`GET /api/v1/databases/:db` 返回**相对工作目录**的路径（如 `rtdb-data/plant_a`）；`true`：返回解析后的绝对路径（会暴露主机目录结构）。 |
| `cors.allowedOrigins` | `[]` | 显式开启的 CORS 来源；`["*"]` 允许任意。留空则完全关闭 CORS。 |
| `compat.influx.enabled` | `true` | InfluxDB 兼容层总开关（`/write`、`/api/v2/write`、`/api/v3/write_lp`、`/ping`、`/query`）。 |
| `compat.influx.metricPrefix` | `""` | 折叠后指标名前缀；迁移期可设为 `influx.` 与原生指标区分。 |
| `compat.influx.tagFolding` | `metric` | `metric` = tag 折叠进指标名；`ignore` = 丢弃 tag（显式降级，存在丢数风险）。 |
| `compat.influx.fieldFolding` | `metric` | `metric` = 每字段一个指标；`reject` = 多字段行整行拒绝。 |
| `compat.influx.duplicatePolicy` | `last` | 同一请求内同 `(指标, 毫秒)` 的取舍：`last` \| `first`。 |
| `compat.influx.maxBodyBytes` | `26214400` | 兼容写入请求体上限（压缩前与解压后，25 MiB）。 |
| `compat.influx.defaultOrg` | `""` | v2 写入缺少 `org` 时的兜底值；留空 = 必填。 |
| `compat.influx.allowQueryCredentials` | `false` | 允许 `?u=&p=` / `?access_token=` 凭据（会进入访问日志，不推荐）。 |
| `compat.influx.rejectNoSync` | `false` | `no_sync` 是否视为错误；默认接受并回 `X-Rtdb-NoSync: ignored`。 |
| `compat.influx.influxql` | `read-only` | `off` 关闭 `/query` 与 `/api/v3/query_influxql`；`read-only` 开启 InfluxQL 只读子集。 |
| `compat.influx.versionHeader` | `2.7.8` | `/ping` 的 `X-Influxdb-Version` 取值（兼容基线声明，不改变真实产品版本）。 |
| `compat.influx.cardinalityWarnThreshold` | `100000` | 折叠后指标数超过该值打印一次 `WARN`。 |
| `write.walEnabled` | `true` | 预写日志。仅当数据可重新生成时才设为 `false`。 |
| `write.fsyncPolicy` | `wal` | `wal` = 每次 WAL 追加后成组 fsync；`none` = 依赖操作系统。 |
| `write.blockTargetPoints` | `16384` | 块封块的主触发条件（每块点数）。 |
| `write.blockMinPoints` | `1024` | 周期性兜底封块的下限。 |
| `write.flushIntervalMs` | `5000` | 周期性兜底刷盘间隔。 |
| `write.maxBufferBytes` | `268435456` | 尚未成块的点所占内存水位；超限 → `429`。 |
| `write.maxPendingPoints` | `2000000` | 未落盘点数水位；超限 → `429`。 |
| `write.maxBatch` | `1000000` | 单次写入请求的最大点数；超限 → `413`。 |
| `storage.segment.maxBytes` | `209715200` | 段文件软上限（200 MiB）；滚动只在块边界发生。 |
| `storage.segment.maxPerDay` | `1000` | 单个日目录内最大段文件数。 |
| `cache.blocks` | `256` | 已解码块的 LRU 条目数。 |
| `cache.fdGroups` | `32` | 打开的段文件句柄的 LRU 条目数。 |
| `query.defaultLimit` | `100000` | `range` 查询的默认 `limit`。 |
| `http.maxBodyBytes` | `67108864` | HTTP 请求体上限（64 MiB）；超限 → `413`。 |
| `log.level` | `info` | `debug` \| `info` \| `warn` \| `error`。 |

### 钳制范围（越界值静默钳制并打印 `WARN`）

| 配置项 | 最小 | 最大 |
| ------ | ---- | ---- |
| `storage.segment.maxBytes` | 16 MiB | 4 GiB |
| `write.blockTargetPoints` | 4 096 | 65 536 |
| `write.blockMinPoints` | 64 | 65 536 |
| `write.flushIntervalMs` | 200 | 60 000 |
| `write.maxBufferBytes` | 16 MiB | 2 GiB |
| `write.maxPendingPoints` | 100 000 | 10 000 000 |
| `cache.blocks` | 16 | 4 096 |
| `cache.fdGroups` | 4 | 256 |
| `retentionDays` | 0 | 3 650 |
| `storage.segment.maxPerDay` | 1 | 1 000 |

### 兼容层（`compat.influx`）

兼容层是**旁路适配器**，不改变 `/api/v1/*` 原生契约与鉴权语义（写入仍需 `write` 权限域、查询仍需 `query` 权限域）：

- 行协议中的 `measurement + tags + field` 折叠为单一指标名 `measurement|field|key=value...`（tag 按 key 升序，`\` `|` `=` 转义）。`tagFolding=ignore` 会丢弃 tag，可能造成不同序列塌缩，默认关闭。
- 时间精度由请求 `precision` 决定（`ns/us/ms/s/m/h` 及全称），内部统一存毫秒；同一毫秒多个点按 `duplicatePolicy` 合并。
- **跨请求**的同 `(指标, 毫秒)` 点不会覆盖（存储为追加式，先写者胜），这是与 InfluxDB `last-write-wins` 的已知差异。
- 不支持的代际能力（Flux `/api/v2/query`、SQL `/api/v3/query_sql`、桶/库管理 `/api/v2/buckets`、`/api/v3/configure/*`）返回 **501** 并在 `hint` 中给出替代端点，不会伪造成功。

## 4. 环境变量

| 变量 | 对应配置项 |
| ---- | ---------- |
| `RTDB_CONFIG` | 配置文件路径 |
| `RTDB_PORT` | `port` |
| `RTDB_HOST` | `host` |
| `RTDB_DATA_DIR` | `dataDir` |
| `RTDB_RETENTION_DAYS` | `retentionDays` |
| `RTDB_AUTH_ENABLED` | `auth.enabled`（`true`/`1`、`false`/`0`） |
| `RTDB_TOKEN` | `auth.token` |
| `RTDB_AUTH_USERNAME` | `auth.username` |
| `RTDB_AUTH_PASSWORD` | `auth.password` |
| `RTDB_AUTH_BOOTSTRAP_USERNAME` | `auth.bootstrapUsername` |
| `RTDB_AUTH_BOOTSTRAP_PASSWORD` | `auth.bootstrapPassword` |
| `RTDB_AUTH_USERS_FILE` | `auth.usersFile` |
| `RTDB_AUTH_TOKENS_FILE` | `auth.tokensFile` |
| `RTDB_ADMIN_ENABLED` | `admin.enabled` |
| `RTDB_ADMIN_EXPOSE_PATHS` | `admin.exposePaths`（`true`/`1`、`false`/`0`） |
| `RTDB_CORS_ALLOWED_ORIGINS` | `cors.allowedOrigins`（逗号分隔） |
| `RTDB_COMPAT_INFLUX_ENABLED` | `compat.influx.enabled`（`true`/`1`、`false`/`0`） |
| `RTDB_COMPAT_INFLUX_METRIC_PREFIX` | `compat.influx.metricPrefix` |
| `RTDB_COMPAT_INFLUX_TAG_FOLDING` | `compat.influx.tagFolding` |
| `RTDB_COMPAT_INFLUX_FIELD_FOLDING` | `compat.influx.fieldFolding` |
| `RTDB_COMPAT_INFLUX_DUPLICATE_POLICY` | `compat.influx.duplicatePolicy` |
| `RTDB_COMPAT_INFLUX_MAX_BODY_BYTES` | `compat.influx.maxBodyBytes` |
| `RTDB_COMPAT_INFLUX_DEFAULT_ORG` | `compat.influx.defaultOrg` |
| `RTDB_COMPAT_INFLUX_ALLOW_QUERY_CREDENTIALS` | `compat.influx.allowQueryCredentials` |
| `RTDB_COMPAT_INFLUX_REJECT_NO_SYNC` | `compat.influx.rejectNoSync` |
| `RTDB_COMPAT_INFLUX_INFLUXQL` | `compat.influx.influxql` |
| `RTDB_COMPAT_INFLUX_VERSION_HEADER` | `compat.influx.versionHeader` |
| `RTDB_COMPAT_INFLUX_CARDINALITY_WARN_THRESHOLD` | `compat.influx.cardinalityWarnThreshold` |
| `RTDB_LOG_LEVEL` | `log.level` |

仅 CLI 使用的额外变量：

| 变量 | 含义 |
| ---- | ---- |
| `RTDB_URL` | 在线子命令使用的服务基址（默认 `http://127.0.0.1:<port>`） |
| `RTDB_TOKEN` | CLI 发送的 Bearer 令牌 |
| `RTDB_DATA_DIR` | 离线子命令使用的数据根 |

## 5. 启动校验（以下情况**会**导致启动失败）

| 条件 | 错误 |
| ---- | ---- |
| `port` 超出 `0…65535` | `E_INTERNAL` |
| `host` 非回环地址**且** `auth.enabled = false` | `E_AUTH` —— 非回环监听必须开启鉴权 |
| `write.blockMinPoints > write.blockTargetPoints` | `E_INTERNAL` |
| `write.maxBatch < 1` | `E_INTERNAL` |
| 模式为 `basic`/`both` 但既无 `password` 也无 `passwordHash` | `E_AUTH` |
| 配置文件缺失 / JSON 格式错误 / 根节点不是对象 | `E_IO` / `E_INTERNAL` |

回环地址指 `localhost`、`::1` 或 `127.x.x.x`。

## 6. 示例配置

### 6.1 本地开发（回环监听，自动生成令牌）

```json
{
  "dataDir": "./rtdb-data",
  "log": { "level": "debug" }
}
```

### 6.2 生产环境：暴露到局域网、Basic 认证、90 天保留并归档

```json
{
  "host": "0.0.0.0",
  "port": 6180,
  "dataDir": "/var/lib/ss-rtdb",
  "retentionDays": 90,
  "archiveBeforeDelete": true,
  "archiveDir": "/var/lib/ss-rtdb/archive",
  "auth": {
    "enabled": true,
    "mode": "both",
    "username": "admin",
    "passwordHash": "scrypt$16384$8$1$<saltHex>$<hashHex>"
  },
  "log": { "level": "info" }
}
```

不必手写哈希，可直接生成：

```bash
node --input-type=module -e "
import { hashPassword } from './packages/server/src/auth.ts';
console.log(hashPassword('your-strong-password'));
"
```

把生成的 `scrypt$…` 字符串粘贴到 `auth.passwordHash`，并保持 `auth.password` 为空。

### 6.3 独立部署 Web 控制台（CORS）

把 `packages/admin/dist` 部署到自己的 Web 服务器，并指向远端实例。浏览器会跨域调用 REST API，
因此该实例必须允许该来源：

```json
{
  "host": "0.0.0.0",
  "cors": { "allowedOrigins": ["https://rtdb-admin.example.com"] },
  "admin": { "enabled": false }
}
```

### 6.4 首次启动的默认管理员与登录

`auth.enabled = true`（默认）且用户目录（`rtdb-users.json`）**为空**时，服务启动会创建一名默认管理员：

- 用户名 `admin`、口令 `ss-rtdb`（可用 `auth.bootstrapUsername` / `auth.bootstrapPassword` 覆盖，置空即关闭引导）。
- 口令只以 scrypt 哈希落盘，日志会提示“已创建默认管理员”。
- 引导**只在空目录时生效**：已有用户（或已改过口令）的实例重启不会被重置。

拿到账号后可用用户名 + 口令换取 API 令牌（见 [04 — HTTP API](./04-http-api.md) §7.3），
Web 控制台的 **Sign in** 表单走的就是同一条路径：

```bash
curl -X POST http://127.0.0.1:6180/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"ss-rtdb"}'
# {"token":"<64 位十六进制>","expiresAt":null,"user":{"username":"admin","role":"admin"}}
```

> 首次登录后请立即在控制台“访问控制”面板修改口令。生产部署建议把 `auth.bootstrapPassword` 置空，
> 由运维预先写入用户目录（哈希）后再启动。

## 7. 运行时状态文件

| 文件 | 位置 | 用途 |
| ---- | ---- | ---- |
| `lock` | `{dataDir}/lock` | 数据根归属（pid）。已死进程留下的陈旧锁会被接管。 |
| `rtdb.token` | `auth.tokenFile`（默认 `./rtdb.token`） | 自动生成的 Bearer 令牌，`0600`。 |
| `rtdb-users.json` | `{dataDir}/` | 用户目录（仅存 scrypt 哈希）。 |
| `rtdb-tokens.json` | `{dataDir}/` | API 令牌目录（仅存哈希）。 |
| `retention.json` | `{dataDir}/{database}/` | 按库保留策略覆盖值，由 `setRetention` 写入。 |

## 8. 下一步

- [03 — 运行服务与 `rtdbctl`](./03-running-and-cli.md)

---

## 更新日志

| 日期 | 变更 | 处理模型 |
| ---- | ---- | -------- |
| 2026-10-17 | 创建中文译本；随英文版更新同步 §2 启动参数说明、§6.2 口令哈希生成方式 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增 `auth.bootstrapUsername` / `auth.bootstrapPassword`（默认 `admin` / `ss-rtdb`）、对应环境变量与 §6.4「首次启动的默认管理员与登录」 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 补充运行期 `conf/rtdb-server.json`（由工作目录自动加载，仓库与发布包均自带）与 `admin.exposePaths` / `RTDB_ADMIN_EXPOSE_PATHS` | DeepSeek-V4.1-Flash |
| 2026-10-17 | `admin.exposePaths` 默认改为 `false`：数据库目录按工作目录相对路径报告，`true` 才返回绝对路径 | DeepSeek-V4.1-Flash |
| 2026-10-18 | 新增 §3「兼容层（`compat.influx`）」12 个配置项说明与 12 个 `RTDB_COMPAT_INFLUX_*` 环境变量（默认开启写入兼容、InfluxQL `read-only`，并说明 tag/field 折叠、precision、跨请求不覆盖等语义） | DeepSeek-V4.1-Flash |
