# 01 — 安装

## 1. 前置条件

| 要求 | 版本 | 用途 |
| ---- | ---- | ---- |
| **Node.js** | **≥ 24** | 全部组件（引擎、服务、CLI、Node SDK） |
| npm | ≥ 10（随 Node 提供） | 工作区安装 / 构建 |
| Python | ≥ 3.9 | 仅 Python SDK（可选） |
| 磁盘 | 容量 = 保留天数 × 写入速率 | 数据根目录 |

之所以要求 Node ≥ 24，是因为源码用 TypeScript 编写，运行时通过 Node 的**原生类型剥离**
（`node src/main.ts`）直接执行，不涉及任何转译器、打包器或 `ts-node`。

> 运行时闭包（`core` / `client-node` / `server` / `cli`）**零第三方依赖**、**零原生模块**。
> 唯一的依赖树属于开发工具链（TypeScript、`@types/node`）以及可选的 Web 控制台（Vue + Vite）。

## 2. 获取源码

```bash
git clone <你的镜像或上游地址> ss-rtdb
cd ss-rtdb/src        # npm 工作区根目录是 src/，不是仓库根目录
```

仓库根目录只放文档；**所有 npm 命令都在 `ss-rtdb/src` 下执行**。

## 3. 安装依赖

```bash
npm install
```

该命令会链接各工作区（`core`、`server`、`client-node`、`cli`、`admin`）并安装开发工具链。
安装后不会自动执行构建。

## 4. 构建

**从源码运行服务与 CLI 完全不需要构建** —— `server` 与 `cli` 直接导入其依赖的 TypeScript 源码，
Node 在加载时剥离类型。只有以下场景才需要构建：

| 包 | 输出 | 需要它的场景 |
| -- | ---- | ------------ |
| `@ss/rtdb-core` | `packages/core/dist/` | 发布引擎，或被其他包消费 |
| `@ss/rtdb-client` | `packages/client-node/dist/` | 发布 Node SDK，或消费它 |
| `@ss/rtdb-admin` | `packages/admin/dist/` | 在 `/admin` 提供的 Web 控制台 |

```bash
npm run build                                  # 构建所有定义了 build 脚本的工作区
npm run build --workspace @ss/rtdb-admin       # 仅构建 Web 控制台
```

跳过 `admin` 构建时服务仍能正常启动，只是 `/admin` 会返回 404。

## 5. 验证安装

```bash
npm run typecheck     # 全工作区 tsc --noEmit + admin 的 vue-tsc
npm test              # 引擎 / 段 / WAL / 保留策略 / CLI / 客户端 / 服务端测试套件
npm run check:deps    # 断言运行时闭包不含第三方依赖与原生依赖
```

首次运行的常见问题：

| 现象 | 原因 | 处理 |
| ---- | ---- | ---- |
| 启动时报 `SyntaxError: … TypeScript …` | Node 版本低于 24 | 升级 Node |
| `Cannot find module '@ss/rtdb-core'` | 工作区未链接 / 未构建 | `npm install && npm run build` |
| `/admin` 返回 404 | 未构建 admin 产物 | `npm run build --workspace @ss/rtdb-admin` |
| 启动时报 `E_DB_LOCKED` | 数据根已被另一个进程占用 | 停止该进程（见 [08](./08-operations.md) §2 数据根锁） |

## 6. 从源码运行 vs. 从 `dist` 运行

两种方式都受支持，行为完全一致。

**从源码**（常规方式 —— 开发期方便，也是 `server` 与 `cli` 目前唯一的交付方式；
它们没有 `build` 脚本）：

```bash
node packages/server/src/main.ts          # 服务
node packages/cli/src/main.ts status      # CLI
```

两者也都通过 npm scripts 与 `bin` 入口暴露：

```bash
npm start --workspace @ss/rtdb-server     # 等价于 node packages/server/src/main.ts
npx rtdbctl status                        # @ss/rtdb-cli 的 bin 入口
npx rtdb-server                           # @ss/rtdb-server 的 bin 入口
```

可以用 `npm link` 将它们暴露为全局命令，或把已发布的包安装到自己的项目中。
真正发布编译产物的包（`core`、`client-node`、`admin`）会把产物放在 `dist/`。

## 7. 安装到你自己的项目

**嵌入式引擎（形态 A）：**

```bash
npm install @ss/rtdb-core
```

**客户端 SDK（形态 B）：**

```bash
npm install @ss/rtdb-client        # Node
pip install ./packages/client-python   # Python；也可直接拷贝 ss_rtdb_client/ 包目录
```

两个 SDK 都是纯 HTTP 客户端，不接触数据目录，因此可以运行在完全独立的进程、容器或主机上。

## 8. 可选：Python SDK

Python SDK **仅依赖标准库**（不用 `requests`，不用 `numpy`），支持 CPython ≥ 3.9。

```bash
cd packages/client-python
pip install -e .                                  # 可编辑安装
python -c "import ss_rtdb_client; print(ss_rtdb_client.__version__)"   # -> 0.1.0
```

用 `python -m pytest tests/` 运行其测试（pytest 需单独安装；包本身没有运行时依赖）。

## 9. 下一步

- [02 — 配置](./02-configuration.md)：设置端口、数据目录与鉴权。
- [03 — 运行服务与 `rtdbctl`](./03-running-and-cli.md)：启动服务并开始使用。
