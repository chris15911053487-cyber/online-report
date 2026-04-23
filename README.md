# Online Report（在线报工）

Web 与移动端共用的报工系统：Node.js（Fastify）提供 API 与静态前端，数据存储在 **SQL Server**；可选 **Expo** 移动客户端。

## 功能概览

- **认证与角色**：登录使用表 `OUSR`：用户名为 `USER_CODE`，密码与列 **`MobileIMEI`** 做常量时间比对（与 `POST /auth/login` 的 `password` 字段对应）；校验通过后签发 JWT。角色分为 `admin`（菜单管理、全部导航）与 `operator`（按菜单权限过滤）。
- **Web 前端**（`server/public/`，单页应用 + `app.js`）：登录后底部导航为 **目录 / 收藏 / 消息 / 设置**；**生产订单**列表与详情、工序与历史报工、提交报工（`POST /orders/:id/report`）；**可配置报表**支持条件表单、分页、行级详情（`POST /reports/run`、`POST /reports/detail`）、以及 **列表列英文名与中文表头映射**（数据行仍为英文列名，便于对接外部系统）。管理员可进入 **菜单设置**，维护 `nav_menu_items`（SQL 模板、筛选 JSON、列标题映射等）。另有 **OWOR** 等按导航配置的视图。
- **生产报工登记（`pro-sign`）**：目录中 `route_key` 为 `pro-sign` 的菜单进入专用流程——列表数据来自可配置报表 SQL（或内置默认订单+工序列表）；支持多选明细 **合并报工**，进入 **报工登记** 界面：接单开工、暂停（必填原因）、继续、按行提交良品/不良并写入 `work_reports`（可关联 `batch_line_id`）。批次与计时时长落在 **`X_` 前缀表**（与业务库其他表区分），详见下文「生产报工登记」。
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
| POST | `/auth/login` | 登录（Body：`username` = `OUSR.USER_CODE`，`password` = 与 `OUSR.MobileIMEI` 比对），返回 JWT |
| GET | `/auth/me` | 当前用户（需 JWT） |
| GET | `/menus` | 当前角色可见的导航菜单（报表类含 `filterSchema`、`columnLabels` 等） |
| GET | `/orders` | 生产订单列表（可选 `?status=`） |
| GET | `/orders/:id` | 订单详情、工序、最近报工 |
| POST | `/orders/:id/report` | 提交报工 |
| GET | `/owor` | OWOR 相关数据（需 JWT） |
| POST | `/reports/run` | 执行可配置报表主查询 |
| POST | `/reports/detail` | 可配置报表行详情 |
| POST | `/pro-sign/run-list` | 生产报工登记列表（与报表类似；`routeKey` 固定为 `pro-sign`，见下文） |
| POST | `/pro-sign/batches` | 创建报工批次（Body：`lines: [{ orderId, operationId }]`） |
| GET | `/pro-sign/batches/:id` | 批次详情、明细行、累计工时等 |
| POST | `/pro-sign/batches/:id/accept` | 接单开工 |
| POST | `/pro-sign/batches/:id/pause` | 暂停（Body：`{ "reason": "..." }`） |
| POST | `/pro-sign/batches/:id/resume` | 继续开工 |
| POST | `/pro-sign/batches/:id/submit` | 提交报工（Body：`lines: [{ lineId, goodQty, scrapQty, remark }]`） |
| GET / POST / PATCH / DELETE | `/admin/menus`、`/admin/menus/:id` | 菜单增删改（仅 `admin`）；报表菜单可提交 `columnLabels`（列标题映射） |

## 环境要求

- **Node.js** 18+（建议 20，与 Docker 镜像一致）
- **SQL Server**（生产/开发库；登录依赖表 `OUSR`，需含 `USER_CODE`、`MobileIMEI` 等列）
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

- **OUSR 登录**：库表 `OUSR` 须存在 **`MobileIMEI`** 列（与登录密码比对）；若列名与 SAP/定制库不一致，需改服务端 `server/src/routes/auth.js` 中的查询列名。
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

导航菜单表 `nav_menu_items` 可在启动时自动创建；若无建表权限，可关闭对应选项并手动执行 `server/sql/migrate-nav-menu-items-only.sql`（见 `.env.example` 注释）。若库中表已存在但缺少报表相关列，请依次执行 `server/sql/migrate-nav-menu-report-columns.sql`、`migrate-nav-menu-detail-columns.sql`、`migrate-x-report-batch.sql`、`migrate-nav-menu-column-labels.sql`（启动时 `ensure-nav-menu-schema` 与 `npm run init-db` 也会按顺序尝试执行这些脚本）。

**报工批次表（`X_` 前缀）**：`server/sql/migrate-x-report-batch.sql` 会创建 `X_report_batch`、`X_report_batch_line`、`X_task_logs`，并为 `work_reports` 增加可空列 `batch_line_id`（外键指向 `X_report_batch_line`，删除明细行时置空）。应用启动时 `ensure-nav-menu-schema` 会尝试执行该脚本；`npm run init-db` 也会在种子数据之前执行报表列迁移与本脚本，以便 `seed-mssql.sql` 能写入 `pro-sign` 菜单等与报表相关的列。

#### 菜单设置与 `nav_menu_items` 字段对照

Web **菜单设置** 中「添加菜单」表单的 `name` 与 `POST/PATCH /admin/menus` 的 JSON 字段一致；`GET /menus`、`GET /admin/menus` 返回的字段名亦同（camelCase）。下表为界面用语、API 字段与数据库列的一一对应（仅 SQL Server；`builtin` 菜单中报表相关项应为空或默认值）。

| 菜单设置中的表单项 | API 字段（JSON） | 数据库列 `nav_menu_items` |
| --- | --- | --- |
| 名称 | `label` | `label` |
| 路由标识 | `routeKey` | `route_key` |
| 图标（可选） | `icon` | `icon` |
| 排序 | `sortOrder` | `sort_order` |
| 启用 | `enabled` | `enabled` |
| 可见角色（管理员 / 普通用户） | `roles`（`["admin","operator"]`） | `roles_json` |
| 菜单类型 | `menuKind`（`builtin` / `report`） | `menu_kind` |
| SQL 模板（仅报表） | `queryTemplate` | `query_template` |
| 查询条件 JSON（仅报表） | `filterSchema` | `filter_schema_json` |
| 列表列标题映射 JSON（可选，仅报表） | `columnLabels` | `column_labels_json` |
| 行详情 SQL（可选，仅报表） | `detailQueryTemplate` | `detail_query_template` |
| 行主键列名（仅报表） | `detailKeyColumn` | `detail_key_column` |
| 详情 SQL 主键参数名（仅报表） | `detailKeyParam` | `detail_key_param` |
| 行主键类型（仅报表） | `detailKeyType` | `detail_key_type` |

**主键与时间戳**：`id` 由数据库自增生成；`created_at`、`updated_at` 仅存在于表中，**菜单设置界面不维护**（更新菜单时由服务端写 `updated_at`）。

**编辑已有菜单**：与上表相同，保存时向 `PATCH /admin/menus/:id` 提交同一套 JSON 字段。

### 生产报工登记（菜单 `route_key`: `pro-sign`）

- **菜单配置**：在 **菜单设置** 中新增或维护一条菜单，`路由标识` 必须为 **`pro-sign`**（小写）。  
  - 将 **菜单类型** 设为 **可配置报表（SQL）** 时：列表 SQL 与筛选 JSON 的约定与普通报表相同（`POST /pro-sign/run-list` 内部会按 `nav_menu_items` 中该路由的配置执行查询，参数绑定方式与 `/reports/run` 一致）。  
  - 列表结果集中 **必须包含列名 `orderId` 与 `operationId`**（与 `production_orders.id`、`order_operations.id` 对应），供前端多选合并与创建批次使用。  
  - 若暂时使用 **内置页面** 类型：列表走服务端内置默认 SQL（可选 `orderNo` 模糊条件），无需在菜单中填写 SQL。
- **Web 流程**：目录进入该菜单 → 查询条件 + 表格 → 勾选一行或多行 → **合并报工** → **报工登记** 页：接单开工 → 可暂停（填写原因）→ 继续 → 按行填写数量与备注后 **提交报工**（写入 `work_reports` 并更新订单已报数量；批次标记完工）。
- **列表接口**：`POST /pro-sign/run-list` 的请求体与 `POST /reports/run` 相同（`params`、`page`、`pageSize`），其中 **`routeKey` 必须为 `pro-sign`**；权限与菜单可见性与可配置报表一致（按 `nav_menu_items` 中该路由的 `roles_json` 等）。
- **移动端**：当前 Web 已接入；`mobile/` 客户端若需同等能力，需自行调用上述 `/pro-sign/*` 接口并实现页面。
- **种子数据**：`seed-mssql.sql` 在已存在报表相关列、且库中尚无 `pro-sign` 菜单时，会尝试插入一条示例「生产报工登记」菜单（可随后在菜单设置中修改 SQL）。

示例列表 SQL（节选，须与 filterSchema 中 `@参数名` 一致）：

```sql
SELECT po.id AS orderId, oo.id AS operationId, po.order_no AS orderNo, ...
FROM dbo.production_orders po
INNER JOIN dbo.order_operations oo ON oo.order_id = po.id
WHERE (@orderNo IS NULL OR po.order_no LIKE N'%' + @orderNo + N'%')
```

示例 `filterSchema`：`[{"name":"orderNo","label":"订单号","type":"string","required":false,"maxLength":64}]`。

**列表列标题（中文）与数据列名（英文）**：`SELECT` 结果请继续使用 **英文别名**（如 `orderNo`、`plannedQty`），便于接口与外部系统用同一套字段名。在菜单中配置 **列表列标题映射 JSON**（存于 `column_labels_json`，接口字段 `columnLabels`），格式为 **英文列名 → 中文表头**，例如：

```json
{"orderNo":"订单号","plannedQty":"计划数量","operationName":"工序名称"}
```

键必须与结果集中的列名一致（大小写不敏感时也会尝试匹配）。未出现在映射中的列仍显示英文列名。行详情弹层中的列名同样使用该映射。**与查询条件 JSON 的区别**：`filterSchema` 里每条用 `name`（绑定 `@name`）与 `label`（条件表单上的文字）；`columnLabels` 只作用于 **列表与详情展示**，不参与 SQL 参数。

### 可配置报表（菜单里配 SQL）

管理员在 **菜单设置** 中可将菜单类型设为「可配置报表」，填写 **SQL 模板**（仅允许单条 `SELECT` / `WITH…SELECT`，或 `EXEC` / `EXECUTE` 存储过程）、**查询条件 JSON**，以及可选的 **列表列标题映射 JSON**（见上文）。条件参数在 SQL 中必须使用 `@参数名` 占位，且与 JSON 里每条 `name` 一一对应；执行时由服务端 **参数绑定**，不会把用户输入拼进 SQL 字符串。

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

## CI（GitHub Actions）

推送或向 `main` / `master` 提 PR 时，工作流 `.github/workflows/ci.yml` 会在 `server/` 下执行 `npm ci` 并对 `src/index.js` 做 `node --check` 语法检查。

## 许可证

私有项目（`package.json` 中 `private: true`）。