# 07 — Web 管理控制台（`rtdb-admin`）

`rtdb-admin` 是一个 Vue 3 单页应用。它**只消费公开的 REST API**，因此有两种部署方式：

| 形态 | 方式 | 适用场景 |
| ---- | ---- | -------- |
| **内置**（默认） | 由 `rtdb-server` 在 `http://<host>:<port>/admin/` 提供 | 单实例，最简配置 |
| **独立部署** | 把 `packages/admin/dist` 部署到任意静态 Web 服务器；在界面中配置实例地址与令牌 | 一个控制台管理多个实例 |

---

## 1. 构建

```bash
cd ss-rtdb/src
npm install                          # 若尚未执行
npm run build --workspace @ss/rtdb-admin
```

产物：`packages/admin/dist/`。构建使用 `base: './'`，因此产物可放在任意路径下工作。

不构建也不影响服务运行，只是 `/admin` 会返回 404。

## 2. 内置形态

默认配置已开启：

```json
{ "admin": { "enabled": true, "staticDir": "" } }
```

- `staticDir: ""` → 使用内置的 `packages/admin/dist` 目录。
- 打开 <http://127.0.0.1:6180/admin/> —— **结尾的斜杠很重要**；`/admin` 会 301 跳转到 `/admin/`，
  这样相对路径的静态资源才能正确解析。直接访问站点根路径 `/` 会 **302 跳转到 `/admin/`**
  （`admin.enabled=false` 时根路径仍返回 404）。
- 打开控制台后先**登录**：`auth.enabled = true`（默认）时页面顶部显示 **Sign in** 表单，
  输入用户名 + 口令即可（`POST /api/v1/auth/login` 换取 API 令牌）。首次启动的服务会自动创建
  默认管理员 `admin` / `ss-rtdb`（见 [02 — 配置](./02-configuration.md) §6.4），表单已预填这两个值，
  点一次 **Sign in** 即可登录。
- 右上角恒有入口：未登录显示 **Sign in**（跳到登录表单），登录后显示账号（如 `admin · admin`）与 **Sign out**。
- 浏览器只保存令牌（`localStorage`），**口令不会被存储**；已有令牌时也可以点
  **Use an existing token** 直接粘贴，或点右上角 **Sign out** 吊销令牌。
- 控制台没有独立鉴权：它调用的是同一套 REST API，每次请求都带同一个令牌，权限域完全一致。

如需关闭（例如改用独立部署形态）：

```json
{ "admin": { "enabled": false } }
```

如需从其他位置提供自己的构建产物：

```json
{ "admin": { "enabled": true, "staticDir": "/opt/rtdb-admin/dist" } }
```

## 3. 独立部署形态

1. 构建（`npm run build --workspace @ss/rtdb-admin`），并把 `packages/admin/dist/` 上传到你的
   静态主机（nginx、带静态网站托管的对象存储等）。
2. 打开站点，填写 **API 基址** —— 例如 `https://rtdb.example.com`。**留空**表示与页面同源
   （即内置模式的行为）。
3. 用 **Sign in** 登录（用户名 + 口令 → 令牌），或点 **Use an existing token** 粘贴在别处签发的
   令牌（使用“访问控制”面板需要 `admin` 权限域）。
4. 点击 **Test connection** 确认连通；基址与令牌会自动保存在浏览器本地存储中 —— 从不上传服务端 ——
   因此每位运维人员各自保管自己的凭据。
5. 在服务实例上允许控制台所在来源：

```json
{
  "host": "0.0.0.0",
  "cors": { "allowedOrigins": ["https://rtdb-admin.example.com"] },
  "auth": { "enabled": true, "mode": "token" }
}
```

> CORS **需显式开启且默认关闭**。非回环监听还必须保持 `auth.enabled = true`，否则启动会失败。

由于控制台是纯静态站点、没有服务端状态，你可以把一份副本提供给多位运维人员，
各自指向自己所管理的实例。

---

## 4. 面板

| 面板 | 显示 / 功能 |
| ---- | ----------- |
| **状态** | 连接状态、写入与查询速率、WAL 积压、缓存命中率、延迟分位 |
| **数据库** | 数据库列表，含保留策略、磁盘占用与指标数量 |
| **指标** | 指标浏览器，含首/末时间戳与时序折线图预览 |
| **备份** | 触发整库备份并显示结果 |
| **访问控制** | 用户（创建 / 改密 / 改角色 / 启停 / 删除）与 API 令牌（签发 / 吊销；明文只显示一次） |

状态数据来自 `GET /api/v1/status`；其余均对应 [04 — HTTP API](./04-http-api.md) 中记录的端点。

---

## 5. 界面语言

控制台内置两种语言，默认 **英文**：

| 语言 | 覆盖范围 | 说明 |
| ---- | -------- | ---- |
| `en`（默认） | 全部界面文案 | 词条基准（`packages/admin/src/locales/en.ts`） |
| `zh` | 全部界面文案 | 按 `Record<MessageKey, string>` 约束（`packages/admin/src/locales/zh.ts`），漏译会导致构建失败 |

- 页头按钮在英文界面显示 `中文`、在中文界面显示 `EN`，点击即切换。
- 选择保存在 `localStorage` 的 `rtdbAdminLocale` 键中，刷新后保持；`<html lang>` 与页面标题同步切换。
- 切换语言完全在本地完成：不会向服务端发送任何请求，已经显示在界面上的提示会按新语言重新渲染。
- 新增界面文案必须同时补齐两份词典（AGENTS.md §4 第 12 条）：只有英文键、没有中文键时，
  `npm run typecheck --workspace @ss/rtdb-admin`（`npm run build` 也会执行）会直接报错，两份词典不会漂移。
- 词条中可包含 `{placeholder}` 占位段（如 `{database}`、`{days}`、`{time}`），由 `t()` 用面板传入的值填充。

## 6. 故障排查

| 现象 | 原因 | 处理 |
| ---- | ---- | ---- |
| `/admin` 返回 404 | 未构建 admin 产物，或 `admin.enabled: false` | 构建 admin 工作区；启用 `admin` |
| 页面能打开但静态资源 404 | 通过自定义代理访问时用了不带斜杠的 `/admin` | 使用 `/admin/`；保留 301 跳转 |
| 访问根路径 `/` 返回 `E_NOT_FOUND: Unregistered route: /` | 旧版本服务端没有根路径跳转，或 `admin.enabled=false` | 升级到带根路径跳转的版本；关闭内建控制台时访问 `/admin/` 并自行提供静态站点 |
| 控制台显示 `E_AUTH` / `401` | 未登录、令牌失效，或匿名访问需要凭据的端点 | 用 **Sign in** 登录；或粘贴有效令牌；检查 `rtdb.token` |
| 登录返回 `401 E_AUTH` | 用户名 / 口令错误，或该实例的用户目录非空且无此用户 | 首启实例用 `admin` / `ss-rtdb`；其余用运维提供的账号 |
| 忘记默认管理员口令 | 口令只存 scrypt 哈希，无法找回 | 用管理员令牌 `PUT /api/v1/admin/users/admin` 改密；或停服后删除 `rtdb-users.json` 再启动（空目录会重建默认管理员） |
| 独立部署的控制台连不上 API | CORS 未开启，或来源未加入白名单 | 设置 `cors.allowedOrigins` 并重启 |
| 访问控制面板返回 403 | 令牌角色不是 `admin` | 签发 `admin` 角色的令牌 |

## 7. 下一步

- [08 — 运维与维护](./08-operations.md)

---

## 更新日志

| 日期 | 变更 | 处理模型 |
| ---- | ---- | -------- |
| 2026-10-17 | 创建中文译本 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 补充根路径 `/` 302 跳转到 `/admin/` 的行为，并新增 `E_NOT_FOUND: Unregistered route: /` 排障条目 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 新增控制台登录说明（默认管理员 `admin` / `ss-rtdb`、Sign in / Sign out、令牌仍可手工粘贴）与两条登录排障条目 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 登录表单改为置顶并预填 `admin` / `ss-rtdb`；右上角恒显示 Sign in / Sign out 入口 | DeepSeek-V4.1-Flash |
| 2026-10-17 | 控制台支持中英双语（默认英文，页头按钮切换，选择存 `localStorage`）；新增 §5「界面语言」并顺延后续小节编号 | DeepSeek-V4.1-Flash |
