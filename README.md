# Online Report（在线报工）

Web 与移动端共用的报工系统：Node.js（Fastify）提供 API 与静态前端，数据存储在 **SQL Server**；可选 **Expo** 移动客户端。

## 功能概览

- **认证与角色**：登录使用表 `OUSR` 校验密码，签发 JWT；角色分为 `admin`（菜单管理、全部导航）与 `operator`（按菜单权限过滤）。
- **Web 前端**（`server/public/`，单页应用 + `app.js`）：登录后底部导航为 **目录 / 收藏 / 消息 / 设置**；**生产订单**列表与详情、工序与历史报工、提交报工（`POST /orders/:id/report`）；**可配置报表**支持条件表单、分页、行级详情（`POST /reports/run`、`POST /reports/detail`）；管理员可进入 **菜单设置**，维护 `nav_menu_items`（含可配置报表的 SQL 模板与筛选 JSON）。另有 **OWOR** 等按导航配置的视图。
- **交互细节**：报表请求使用较长客户端超时（与 `REPORT_QUERY_TIMEOUT_MS` 配合）；主要按钮使用 Pointer/touch 兼容的点击绑定，便于移动端与桌面调试。
- **移动端**：`mobile/` 通过 `EXPO_PUBLIC_API_URL` 指向同一套 API，与 Web 共用后端。

## 仓库结构


| 目录        | 说明                                           |
| --------- | -------------------------------------------- |
| `server/` | 服务端：Fastify、JWT、静态资源 `public/`、SQL 脚本 `sql/` |
| `mobile/` | React Native（Expo）客户端                        |

## 根目录快捷命令

在项目根目录可执行（内部转发到 `server/`）：

```bash
# 依赖：请在 server/ 与 mobile/ 分别执行 npm install（根目录 package.json 无依赖）
npm start     # 等同 cd server && npm start
npm run dev   # 热重载
npm run init-db
```

## 主要 HTTP API（需登录的接口带 `Authorization: Bearer <token>`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/auth/login` | 登录，返回 JWT |
| GET | `/auth/me` | 当前用户（需 JWT） |
| GET | `/menus` | 当前角色可见的导航菜单 |
| GET | `/orders` | 生产订单列表（可选 `?status=`） |
| GET | `/orders/:id` | 订单详情、工序、最近报工 |
| POST | `/orders/:id/report` | 提交报工 |
| GET | `/owor` | OWOR 相关数据（需 JWT） |
| POST | `/reports/run` | 执行可配置报表主查询 |
| POST | `/reports/detail` | 可配置报表行详情 |
| GET / POST / PATCH / DELETE | `/admin/menus`、`/admin/menus/:id` | 菜单增删改（仅 `admin`） |

## 环境要求

- **Node.js** 18+（建议 20，与 Docker 镜像一致）
- **SQL Server**（生产/开发库；登录依赖表 `OUSR`）
- 可选：Docker（用于部署或本地起 MySQL，见下文）

## 服务端：本地运行

```bash
cd server
cp .env.example .env
# 编辑 .env：JWT_SECRET、DB_* 等
npm install
npm start
```

默认监听 `http://0.0.0.0:3000`。健康检查：`GET /health`。

开发热重载：

```bash
npm run dev
```

### 环境变量

详见 `server/.env.example`。要点：

- **DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME**：SQL Server 连接；密码含 `#` 等字符时请用双引号包裹。
- **JWT_SECRET**：生产环境务必改为足够长的随机串。
- **ADMIN_USER_CODES**：管理员 OUSR 用户代码（逗号分隔），用于菜单管理等接口。
- **DB_ENCRYPT / DB_TRUST_SERVER_CERTIFICATE**：连接 Azure 或强制 TLS 时再按需开启。
- **REPORT_MAX_ROWS / REPORT_QUERY_TIMEOUT_MS**：可配置报表的行数上限与单请求超时（见上文「可配置报表」）。

### 数据库初始化

- 报工表结构：`server/sql/schema-mssql.sql`（SQL Server）。
- 在配置好 `.env` 后，可执行建表与示例数据：

```bash
cd server
npm run init-db
```

导航菜单表 `nav_menu_items` 可在启动时自动创建；若无建表权限，可关闭对应选项并手动执行 `server/sql/migrate-nav-menu-items-only.sql`（见 `.env.example` 注释）。若库中表已存在但缺少报表相关列，请执行 `server/sql/migrate-nav-menu-report-columns.sql`（启动时 `ensure-nav-menu-schema` 也会尝试执行）。

### 可配置报表（菜单里配 SQL）

管理员在 **菜单设置** 中可将菜单类型设为「可配置报表」，填写 **SQL 模板**（仅允许单条 `SELECT` / `WITH…SELECT`，或 `EXEC` / `EXECUTE` 存储过程）与 **查询条件 JSON**。条件参数在 SQL 中必须使用 `@参数名` 占位，且与 JSON 里每条 `name` 一一对应；执行时由服务端 **参数绑定**，不会把用户输入拼进 SQL 字符串。

- **POST `/reports/run`**：
  - **Body**：`{ "routeKey": "...", "params": { ... }, "page": 1, "pageSize": 50 }`。`page` / `pageSize` 可选；省略时视为 `page=1` 且 `pageSize=REPORT_MAX_ROWS`（兼容旧客户端一次拉满上限）。`pageSize` 最大为 `min(500, REPORT_MAX_ROWS)`。
  - **返回**：`columns`、`rows`、`truncated`；以及 `page`、`pageSize`、`totalRowCount`；`clientSidePaging`（`true` 表示存储过程路径：服务端一次返回、最多截断至 `REPORT_MAX_ROWS`，由前端按页切片；`false` 表示 `SELECT` 模板路径：服务端按页查询）。
- **分页说明**：`SELECT` / `WITH…SELECT` 模板在服务端用 `COUNT` + `OFFSET/FETCH` 分页；子查询内若写 `ORDER BY` 而无 `TOP`/`OFFSET` 等，SQL Server 可能报错（与将模板放在 `FROM (...)` 子查询中的限制相同）。`EXEC` 报表由前端对已返回结果分页，超大数据量仍受 `REPORT_MAX_ROWS` 截断影响。
- **环境变量**：`REPORT_MAX_ROWS`（默认 2000，兼作未传 `pageSize` 时的默认每页条数上限、以及存储过程首结果集截断上限）、`REPORT_QUERY_TIMEOUT_MS`（默认 60000 毫秒，仅作用于该次报表请求，与全库 `DB_REQUEST_TIMEOUT_MS` 不同）。
- 存储过程是否只读由库权限与业务约定保证；生产环境建议最小权限账号。

示例：`SELECT TOP 100 * FROM dbo.OITM WHERE ItemCode = @code` 搭配 filterSchema `[{"name":"code","label":"物料编码","type":"string","required":true,"maxLength":50}]`。

## Docker 部署（云服务器）

在项目**根目录**：

```bash
cp server/.env.example server/.env
# 编辑 server/.env
docker compose -f docker-compose.deploy.yml up -d --build
```

- 容器内应用端口固定为 **3000**；宿主机端口默认映射为 `3000`，可通过环境变量 **APP_PUBLISH_PORT** 修改，例如：`APP_PUBLISH_PORT=80 docker compose -f docker-compose.deploy.yml up -d`。
- SQL Server 在**容器外**时，`server/.env` 里的 **DB_HOST** 不要填 `127.0.0.1`，应填云数据库可访问的内网/公网地址或主机名。

仅构建镜像：

```bash
docker build -t online-report ./server
```

镜像定义见 `server/Dockerfile`。

## 可选：本地 MySQL（与生产 SQL Server 无关）

根目录 `docker-compose.yml` 仅用于本机没有 MySQL 时快速起库；**本项目的业务库为 SQL Server**，与 MySQL 无直接关系。

```bash
docker compose up -d
```

## 移动端（Expo）

```bash
cd mobile
npm install
npm start
```

真机或局域网调试时需指向可访问的后端地址。在项目根目录创建 `mobile/.env`（或按 `mobile/app.config.js` 说明）设置：

```env
EXPO_PUBLIC_API_URL=http://你的电脑或服务器IP:3000
```

详见 `mobile/app.config.js` 内注释。

## 许可证

私有项目（`package.json` 中 `private: true`）。