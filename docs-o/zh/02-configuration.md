# 02 — 配置

本页说明**形态 B**（`rtdb-server` / `rtdbctl`）的配置。形态 A 把等价选项直接传给
`RtdbEngine`，见 [06 — 嵌入式引擎](./06-embedded-engine.md) §2 引擎选项。

## 1. 优先级

配置由四层合并而成，优先级从低到高：

```
内置默认值  <  配置文件  <  环境变量  <  显式参数
```

- **配置文件**：JSON，路径由 `--config <path>` 或环境变量 `RTDB_CONFIG` 给出。
- **环境变量**：见 §4 的表格。
- **显式参数**：把 `RtdbServer` 嵌入自己进程时传入的 `overrides` 对象；`rtdbctl` 的
  `--data-dir` / `--url` / `--token` / `--timeout` 开关（这些只影响 CLI，不影响服务配置）。

配置文件中的未知键被忽略。超出支持范围的数值会被**钳制**到边界并打印 `WARN` 日志 ——
一个坏数值绝不会阻止启动。只有真正的*语义冲突*才会导致启动失败（§5）。

## 2. 配置文件

`rtdb.config.json` —— 每个键都可省略，省略则保持默认值：

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
    "write": true,
    "query": true,
    "usersFile": "",
    "tokensFile": ""
  },

  "admin": { "enabled": true, "staticDir": "" },
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
| `auth.write` | `true` | 写入接口要求凭据。 |
| `auth.query` | `true` | 查询接口要求凭据。 |
| `auth.usersFile` | `""` | 用户目录 JSON；留空 = `{dataDir}/rtdb-users.json`。 |
| `auth.tokensFile` | `""` | API 令牌目录 JSON；留空 = `{dataDir}/rtdb-tokens.json`。 |
| `admin.enabled` | `true` | 在 `/admin` 提供 Web 控制台。 |
| `admin.staticDir` | `""` | 覆盖控制台静态资源目录；留空 = 内置的 `packages/admin/dist`。 |
| `cors.allowedOrigins` | `[]` | 显式开启的 CORS 来源；`["*"]` 允许任意。留空则完全关闭 CORS。 |
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
| `RTDB_AUTH_USERS_FILE` | `auth.usersFile` |
| `RTDB_AUTH_TOKENS_FILE` | `auth.tokensFile` |
| `RTDB_ADMIN_ENABLED` | `admin.enabled` |
| `RTDB_CORS_ALLOWED_ORIGINS` | `cors.allowedOrigins`（逗号分隔） |
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
