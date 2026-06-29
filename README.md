# Online Report - 工厂在线报表 & 报工系统

面向工厂/制造企业的在线报表系统，支持动态报表查询、AI 智能分析、合并报工流程。

## 架构

- **前端**：`frontend/` — React 19 + Vite + TypeScript + TailwindCSS + Zustand
- **后端**：`server/` — Fastify + SQL Server（`mssql`）
- **静态资源**：构建产物在 `frontend/dist/`；`server/public/` 仅保留 APK、图片目录、`voice.js` 等运行时文件（旧版 Vanilla JS 已移除）

### 前端结构

```
frontend/src/
├── components/      # BottomNav, MainLayout, ImageLightbox, ReportOverlay, TextOverlay, Toast
├── views/           # LoginView, CatalogView, DynamicReportView, AiChatView, MenuSettingsView,
│                    # OworView, OrdersView, DetailView, ReportRowDetailView,
│                    # ProSignReceiveView, ProSignOrderDetailView, WorkRegistrationView, SettingsView
├── utils/
│   ├── api.ts       # API 客户端（apiFetch / apiFetchReport）
│   ├── helpers.ts   # 通用工具函数
│   └── barcodeScan.ts
├── store.ts         # Zustand 全局状态 + 路由管理
├── types.ts         # TypeScript 类型定义
└── main.tsx
```

### 主要功能

- 登录 / 退出 / 修改密码
- 菜单页 + 业务导航（builtin / report / pro-sign 路由）
- 动态报表（筛选、分页、图片列+灯箱、长文本展开、扫码）
- AI 智能分析（`/ai/analyze`）与 **AI 使用说明助手**（`/ai/chat` + `server/help/` 知识库 RAG）
- 合并报工（Status 四段切换、点选即查询；多选 → 预检 → 接单/完工/暂停/恢复 → 保存；列表行点击订单详情；**同工序多选**、**数量须大于 0** 前端校验）
- 菜单管理后台（CRUD、AI Prompt 生成器、**角色定义与用户角色分配**）
- OITM 物料、报工订单、行详情、批次报工登记
- 底部导航（菜单 / AI / 消息 / 设置）+ 语音控制（`voice.js`）

## 常用命令

```bash
# 同时启动前后端开发（推荐）
npm run dev

# 仅前端 (Vite, port 5173)
cd frontend && npm run dev

# 仅后端 API (port 3000)；页面需另开 Vite 或先构建 dist
cd server && npm run dev

# 构建前端到 frontend/dist/（生产与 Docker 必需）
npm run build

# 数据库初始化
npm run init-db
```

生产或仅启动后端访问页面时，须先执行 `npm run build`，否则 `frontend/dist` 不存在，Web UI 不可用（API 仍可用）。

## 后端 (Fastify)

- 入口：`server/src/index.js`
- `.env` 加载：根目录 `.env` → `server/.env`（后者覆盖）
- 认证：OUSR 表，JWT 签发；**多角色权限**（`roles` 数组 + 菜单 `roles_json`）
- 管理员：`ADMIN_USER_CODES` env var（逗号分隔）；admin 可见全部菜单
- 核心表：`nav_menu_items` 存储菜单、SQL 模板、filter_schema、column_name_mapping、AI prompt；`app_roles` / `user_roles` 存储角色目录与用户分配

### 报表系统 (`server/src/report-query.js`)

- 支持 `GO` 分隔的多条 SQL 和单一 SELECT
- `filter_schema_json` 定义筛选字段和动态下拉
- 服务端分页 / 客户端分页自动判断
- 路由：`POST /reports/run`、`POST /reports/filter-field-options`、`POST /reports/detail`

### AI 分析 (`server/src/ai.js`)

- 多模型支持：OpenAI、Grok、DeepSeek、Anthropic、Ollama、Azure OpenAI
- Prompt 占位符：`{report_label}`, `{filters}`, `{metrics}`, `{data_sample}`, `{columns}`, `{context}`
- 路由：`POST /ai/analyze`、`POST /ai/generate-prompt`、`POST /ai/chat`

### AI 使用说明助手

底部 Tab「AI」面向**系统操作说明**（改密码、生产报工、暂停与恢复等），与报表页的「AI 分析」不同。

| 接口 | 说明 |
|------|------|
| `GET /ai/help/bootstrap` | 快捷问题列表、文档版本 |
| `POST /ai/chat` | 多轮对话；按用户最后一问检索 `server/help/*.md` 片段拼入 system prompt |

**知识库维护**：编辑 `server/help/` 下 Markdown（`<!-- tags: ... -->` 与同义词组用于检索）。改完后重启 Node 服务（或调用 `clearHelpCache()`）生效。

**前端**：`AiChatView` 快捷提问、`sources` 参考章节、绿色按钮跳转（设置 / 菜单 / 生产报工）。

### AI Agent（独立容器）

底部 Tab「AI」的主对话能力由独立 Python 容器 `ai-agent/` 提供（LangGraph + DeepSeek/OpenAI）。

**架构**：前端 → 主后端 `/ai/agent/chat` → 转发 ai-agent 容器 → LLM 决策 + 工具调用 → 回调主后端 internal 接口。

| 组件 | 说明 |
|------|------|
| `ai-agent/app/agent.py` | LangGraph ReAct Agent，system prompt + skill 注入 |
| `ai-agent/app/tools.py` | 白名单工具：`run_sql`、`knowledge_search`、`save_record`、`generate_document` 等 |
| `ai-agent/app/backend_client.py` | 回调主后端 internal 端点取数据 |

**SQL 查询机制**：Agent 通过 `run_sql` 工具执行只读 SELECT 查询，但**必须在 Skill 上下文中使用**——只能执行 Skill `body_md` 中明确描述的 SQL 模式和表，不可自行发挥。主后端 `/ai/agent/internal/run-sql` 接口仅允许 SELECT，禁止写操作。

**Skill 管理**：管理员在前台「AI Skill 管理」中配置 Skill（描述 + 工作流 + 约束），支持 AI 辅助生成。Skill 按角色过滤注入 Agent system prompt。

**写入目标**：AI 写入数据须经白名单控制（`agent_write_targets` 表），支持两种类型：
- `table`：参数化 INSERT（前台配置字段白名单）
- `action`：调用代码注册的 API 动作

**API 动作（模块化）**：

```
server/src/
├── agent-actions.js       ← 自动扫描加载器（不需改动）
└── actions/               ← 每个动作一个文件，新增只需加文件重启
    └── returnpro-pick.js  ← 返工单领料（调 B1 Service Layer）
```

新增动作文件格式：

```javascript
// server/src/actions/my-action.js
module.exports = {
  name: 'my-action',
  label: '动作显示名',
  payloadHint: '{ "field": "说明" }',
  async run({ user, payload, log }) {
    // 业务逻辑：调外部API、写库等
    // 成功 return 结果对象，失败 throw Error
  },
}
```

**AI 对话交互功能**：复制消息、引用回复、重新生成、消息反馈（有用/没用）、清空对话、代码块复制。

**AI Agent 角色权限约束**（定义在 `ai-agent/app/agent_rules.md`，注入 system prompt 全局生效）：

| 内置角色 | 约束说明 |
|----------|----------|
| `cost-viewer` | 仅拥有该角色的用户可在 AI 对话中查看成本、进价、采购价等敏感价格信息；无此角色时 Agent 必须隐去成本字段并提示无权限 |
| `attachment-generator` | 仅拥有该角色的用户可通过 AI 对话生成 Word/Excel/PDF 等文件附件；无此角色时 Agent 拒绝调用 `generate_document` |

**降级**：ai-agent 不可达时自动降级为本地知识问答（仅操作说明，不执行 SQL、不编造数据）。

## 菜单与角色权限

系统采用 **方案 A：扩展角色体系**——按岗位角色批量授权，同一角色多人共享菜单权限；不修改 SAP `OUSR` 表。

### 数据表

| 表 | 说明 |
|---|---|
| `app_roles` | 角色目录（`role_key`、`label`、是否内置） |
| `user_roles` | 用户 → 角色（`user_code` + `role_key`） |
| `nav_menu_items.roles_json` | 菜单可见角色 JSON 数组，如 `["operator","production"]` |

迁移脚本：`server/sql/migrate-user-roles.sql`（服务启动时 `ensure-nav-menu-schema` 自动执行，或 `npm run init-db`）。

**预置角色**：`admin`（管理员）、`operator`（操作员）、`production`（生产）、`warehouse`（仓库）、`quality`（质检）、`finance`（财务）、`cost-viewer`（查看成本）、`attachment-generator`（生成附件）。其中 `admin`、`operator`、`cost-viewer`、`attachment-generator` 为内置角色（不可删除）。可在后台继续添加自定义角色（小写英文标识，如 `packing`）。

### 权限规则

| 情况 | 用户拥有的角色 |
|------|----------------|
| `USER_CODE` 在 `ADMIN_USER_CODES` | 含 `admin`（可见全部菜单） |
| `user_roles` 表有记录 | 仅表中分配的角色（再并上 admin，若适用） |
| `user_roles` 无记录 | 默认 `operator` |

**菜单可见性**：用户任一角色出现在该菜单的 `roles_json` 中即可见；`admin`  bypass 全部菜单。后端在 `/menus`、`/reports/*`、`/ai/analyze`、报工等接口统一校验，不仅靠前端隐藏。

**管理员**：`admin` 由环境变量 `ADMIN_USER_CODES` 控制，**不在**「用户角色」界面分配。

### 管理界面

管理员进入 **菜单设置**（`menu-settings`），页签：

| 页签 | 作用 |
|------|------|
| **菜单项** | 编辑菜单；「可见角色」勾选哪些岗位能看该菜单 |
| **角色定义** | 增删自定义岗位角色（内置 admin/operator/cost-viewer/attachment-generator 不可删） |
| **用户角色** | 搜索 OUSR 用户 → 勾选岗位角色 → 保存 |

### 管理 API

| 接口 | 说明 |
|------|------|
| `GET /admin/roles` | 角色列表 |
| `POST /admin/roles` | 新增角色 `{ roleKey, label }` |
| `PATCH /admin/roles/:roleKey` | 修改名称/排序 |
| `DELETE /admin/roles/:roleKey` | 删除（非内置且未被用户引用） |
| `GET /admin/user-roles?page=&pageSize=&q=` | 从 OUSR 分页列出全部用户及有效角色、已分配角色 |
| `GET /admin/user-roles/:userCode` | 某用户角色 |
| `PUT /admin/user-roles/:userCode` | 设置 `{ roles: ["production", ...] }`（不可含 admin） |
| `GET /admin/users/search?q=` | 搜索 OUSR 用户 |

### 配置示例

1. **角色定义**：添加 `production` / 生产（若使用预置可跳过）
2. **用户角色**：用户 `U001` 勾选 `production`
3. **菜单项**：「生产报工」菜单的可见角色勾选 `production`（及需要的 `operator` 等）
4. `U001` **重新登录** 后仅能看到匹配角色的菜单

清空某用户的角色分配并保存 → 该用户恢复为默认 `operator`。

### 实现要点

- 共享模块：`server/src/roles.js`（`resolveUserRoles`、`canAccessMenu`、`parseMenuRolesJson`）
- 登录与 `GET /auth/me`：JWT / 响应含 `roles: string[]`，兼容旧字段 `role`（`admin` | `operator`）
- 改用户角色后需重新登录（或等 JWT 过期）；刷新页面时 `/auth/me` 会重新读库更新设置页展示

## 合并报工

### 两种报工流程

**1. 批次报工**（`X_report_batch` + `work_reports`）
- 列表选择 → 创建批次 → 接单 → 计时（暂停/继续） → 提交

**2. 合并报工**（`X_ONLINE_SIGN` + `X_ONLINE_SIGN1`）
- 列表勾选 → 预检 → 接单页 → 确认保存

### Status 筛选与吸底按钮

生产报工列表顶部为 **四段切换**（替代 Status 下拉）：点选即 **自动查询**，其它筛选项变更后仍点「查询」。

筛参字段名须为 **`Status`**（大小写不敏感，JSON 里常见 `"name": "Status"`）。`filter_schema` 静态 options 示例：

```json
{
  "name": "Status",
  "label": "状态",
  "type": "string",
  "required": false,
  "options": [
    { "name": "待接单", "code": "0" },
    { "name": "待完工", "code": "1" },
    { "name": "已完工", "code": "2" },
    { "name": "恢复报工", "code": "8" }
  ]
}
```

`options` 与 `optionsSql` **二选一**（不可同时配置）。若用 `optionsSql`，下拉数据仍须能映射到 code `0` / `1` / `2` / `8`（或显示名含「待接单」「待完工」「已完工」「恢复」等，前端会按名称兜底匹配）。

### SignType 判断（固定 code 映射）

| Status code | 分段 / 列表吸底 | 合并页操作 |
|---|---|---|
| `0` | 接单 | 确认接单 |
| `1` | 完工 | 完工 + **暂停报工** |
| `2` | 已完工 | 常规合并保存（查看/补录已完工单据） |
| `8` | 恢复报工 | 仅「恢复报工」（暂停后继续，勿用待完工重复暂停） |
| 未选 / 其它 | 合并报工 | 常规合并保存 |

实现见 `frontend/src/views/DynamicReportView.tsx`（`ProSignStatusSegment`、`resolveProSignMergeButtonLabel`）。

### 生产报工列表与订单详情

**查询列表**（菜单 `route_key` 一般为 `pro-sign`）：

1. 底部「菜单」→ 点击生产报工类菜单 → `openProSign()` 进入 `DynamicReportView`（`proSignMode=true`）
2. 顶部 **Status 四段**（待接单 / 待完工 / 已完工 / 恢复报工）点选即自动查询；其它筛选项改完后点「查询」
3. 勾选多行（**须为同一工序 `StepCode`**）→ 吸底按钮（接单 / 完工 / 恢复报工 / 合并报工）→ 预检 → `ProSignReceiveView` 合并页
4. 合并页填写数量、操作员 → 确认保存（**每条明细数量须大于 0**）

### 合并报工前端校验

| 环节 | 规则 | 提示 |
|------|------|------|
| 列表勾选 / 全选 | 不能同时勾选多个不同 `StepCode` 工序 | `不能同时勾选多个不同工序进行报工，请只选择同一工序的明细` |
| 吸底按钮预检 | 同上（兜底） | 同上 |
| 合并页保存 / 暂停报工 | 任一明细数量 ≤ 0 不可提交 | `存在数量为 0 的明细，不能提交，请修改数量后再保存` |

实现：`DynamicReportView.tsx`（勾选与 `handleMerge`）、`ProSignReceiveView.tsx`（保存前 `validateQuantitiesForSubmit`）。

**订单只读详情**（点击列表某一行）：

- 前端：`ProSignOrderDetailView`（`currentView = pro-sign-order-detail`）
- 接口：`POST /pro-sign/order-detail`
- **存储过程与入参均来自菜单配置**（`nav_menu_items`），**不需要**环境变量 `PRO_SIGN_ORDER_DETAIL_SP`

在 **菜单设置** 中为该生产报工菜单配置：

| 字段 | 数据库列 | 说明 |
|------|----------|------|
| 行详情 SQL | `detail_query_template` | 明细存储过程或 SQL，须以 `EXEC` / `EXECUTE` 开头；支持多 recordset |
| 行主键列名 | `detail_key_column` | 列表结果中用于取值的列（如 `orderNo`、`OrderNo`、`订单号`） |
| 详情 SQL 主键参数名 | `detail_key_param` | 传给明细 SQL 的参数名（如 `OrderNo`），须与模板中 `@参数名` 一致 |

**配置示例**（明细 SP 需要当前用户 + 订单号）：

```sql
EXEC dbo.Z_ONLINE_XXX_ORDER_DETAIL @_loginUser, @OrderNo
```

- `@_loginUser` / `@_loginDisplayName`：后端自动注入当前登录用户（与报表列表 SQL 相同约定）
- `@UserCode` / `@UserId` / `@UserName`（大小写不敏感）：同样注入为当前登录用户名
- 其它 `@参数`：由前端按 `detail_key_param` 传入（点击行时取 `detail_key_column` 对应列的值）

**请求体示例**：

```json
{
  "routeKey": "pro-sign",
  "params": { "OrderNo": "SO-2026-001" }
}
```

**响应**：`{ routeKey, label, tables: [{ index, columns, rows }] }`（多结果集按表分段展示）。

与普通报表「行详情」的区别：

| 能力 | 普通报表 | 生产报工订单详情 |
|------|----------|------------------|
| 入口 | 行详情开启 + 点击行 | 生产报工列表点击行 |
| 接口 | `POST /reports/detail` | `POST /pro-sign/order-detail` |
| 配置来源 | `detail_query_template` + 列表筛选参数 + `@detailKey` | 同上，主键值来自行内订单号列 |
| 展示 | 单表卡片 / 定制页 | 多 recordset 表格 |

## 报表图片列

列名以 `_img` / `_image` / `_pic` / `_photo` 结尾自动识别为图片列，渲染缩略图 + 灯箱。

- 静态目录：`IMAGES_DIR`（默认 `server/public/images/`）
- UNC 路径走代理接口 `GET /files/image`

## 扫码功能

`filter_schema` 中字段配置 `"scan": true` 显示扫码按钮。HTTPS 调摄像头，HTTP 回退相册。

## 语音控制

移动端浏览器提供浮动语音按钮（可拖动、贴边半隐藏）。按住说话 → 百度 ASR 转文字 → 匹配指令 → 模拟点击页面元素执行操作。

**源码位置**（两处需保持内容一致）：

| 文件 | 说明 |
|------|------|
| `frontend/public/js/voice.js` | 主文件，Vite 构建时复制到 `frontend/dist/js/` |
| `server/public/js/voice.js` | 服务端兜底：`GET /js/voice.js`（`server/src/index.js`） |

更完整的接入与排障见 [`docs/voice-recognition-guide.md`](docs/voice-recognition-guide.md)。

### 执行流程

```
按住语音钮 → 录音(WAV) → POST /speech/recognize（百度 ASR）
    → normalizeVoiceText（去标点、去「打开/进入」前缀、误听纠正）
    → match() 在指令表选得分最高的一条
    → handler() 模拟 click（底部 Tab / 菜单按钮）
```

`voice.js` **不直接调业务 API**，只通过 DOM 钩子触发与手动点击相同的行为。

### 指令从哪里来（如何维护）

| 类型 | 维护方式 | 说明 |
|------|----------|------|
| **业务菜单** | 后台 **菜单设置** 里的 **显示名称（label）** | 无需改代码。进入菜单页后，脚本从 `[data-menu-label]` 自动生成指令，可说「菜单名」「打开XXX」「进入XXX」 |
| **语音动作模板（带参数）** | 后台 **菜单设置 → 语音动作模板**（`voice_actions_json`） | 让语音可以「打开 129 号订单」这类**带参数**操作：跳转 + 预填筛选 + 自动查询。占位符 `{n}` 数字 / `{t}` 文本 / `{d}` 日期；详见 [`docs/voice-recognition-guide.md` §9](docs/voice-recognition-guide.md) |
| **底部 Tab / 退出登录等** | 编辑 `voice.js` 中 `addCmd(...)` | 约 334 行起，在关键词数组里增加说法 |
| **ASR 听错字** | 编辑 `ASR_TEXT_REPLACEMENTS` | 如 `['盛产','生产']`，在规范化阶段替换 |
| **固定菜单的误听别名** | `addCmd` + `openCatalogMenu('', '准确菜单名')` | 菜单 label 正确但识别总错时使用 |

**动态菜单同步**：`refreshDynamicCatalogCommands()` 读取 `CatalogView` 上的 `data-voice-catalog-grid`、`data-route-key`、`data-menu-label`（见 `frontend/src/views/CatalogView.tsx`）。底部 Tab 使用 `data-nav-tab`、`data-voice-nav-label`（见 `BottomNav.tsx`）。

**新增固定指令示例**：

```javascript
addCmd(['打开消息', '未读消息'], function () {
  goToNavTab('消息');
}, { label: '消息' });
```

修改 `voice.js` 后：开发环境刷新即可；生产需 `npm run build` 或重建 Docker 镜像，并同步 `server/public/js/voice.js`。

### 匹配规则（精准度）

- 每条指令只取**得分最高的一个关键词**（避免多关键词累加误触）
- 短词（≤2 字）仅整句或极短句命中；长句若只命中短词则拒绝
- 完整等于菜单名得分最高；支持少量模糊匹配（编辑距离）
- 识别结果写入 `voice_logs` 表，便于对照实际说了什么

### 浮动按钮交互

- 需自行拖到贴近屏幕边缘（约 14px 内）松手才会吸附；拖动过程中可滑出屏幕外
- 贴边后露出约 34px，并带更大半透明拖拽条（`voice-dock-pull`）便于拉出
- 轻点拖拽条 → 展开回屏幕内；按住往外拖 → 脱离贴边
- 位置保存在 `localStorage`（`voice_btn_pos_v2`）

### 内置固定指令（节选）

| 说法示例 | 动作 |
|----------|------|
| 菜单 / 返回 / 首页 | 底部「菜单」Tab |
| AI / 智能助手 | 底部「AI」Tab |
| 消息 / 设置 | 对应 Tab |
| 退出登录 / 注销登录 | 设置页 → 退出 |
| （菜单 label） | 打开对应业务菜单 |

### 相关环境变量

| 变量 | 说明 |
|------|------|
| `VOICE_ENABLED` | `false` 关闭语音（默认开启） |
| `BAIDU_*` | 百度 ASR 密钥，见 `server/.env.example` |

## IM 机器人对接（钉钉 / 企业微信 / 飞书）

系统支持将 AI Agent 对话能力对接到多个 IM 平台的企业机器人，员工在 IM 单聊中即可直接与 AI 交互（查数据、操作说明等）。

### 架构

```
IM 平台推送消息 → POST /bot/{dingtalk|wecom|feishu}
    → 验签/解密 → 用户绑定映射 → agentChatCore()（复用 Web 端完整 Agent 能力）
    → 平台消息 API 回复
```

核心模块：`server/src/agent-chat-core.js`（共享对话逻辑）、各平台路由见下表。

| 平台 | 路由文件 | Webhook 地址 |
|------|----------|-------------|
| 钉钉 | `server/src/routes/bot-dingtalk.js` | `/bot/dingtalk` |
| 企业微信 | `server/src/routes/bot-wecom.js` | `/bot/wecom` |
| 飞书 | `server/src/routes/bot-feishu.js` | `/bot/feishu` |

### 使用流程（通用）

| 步骤 | 用户操作 | 说明 |
|------|----------|------|
| 绑定 | 发送 `绑定 U001` | 将 IM 账号与系统工号关联（一次性） |
| 对话 | 直接发消息 | 与 Web 端 AI 对话能力完全一致 |

### 用户绑定表

```sql
-- server/sql/migrate-bot-user-bindings.sql（服务启动自动执行）
bot_user_bindings (platform, platform_uid, user_code)
```

`platform`: `dingtalk` / `wecom` / `feishu`。

### 钉钉配置

1. 登录 [钉钉开放平台](https://open-dev.dingtalk.com) → 创建企业内部应用（机器人）
2. 获取 `AppKey` / `AppSecret`，填入 `server/.env`
3. 消息接收地址：`https://你的域名/bot/dingtalk`
4. 配置出口 IP 白名单并发布

### 企业微信配置

1. 企业微信管理后台 → 应用管理 → 自建应用 → 接收消息设置
2. 填写 URL（`https://你的域名/bot/wecom`）、Token、EncodingAESKey
3. 获取 CorpID、AgentID、Secret，填入 `server/.env`

### 飞书配置

1. 登录 [飞书开放平台](https://open.feishu.cn) → 创建应用 → 添加机器人能力
2. 事件订阅 → Webhook 模式 → 请求地址：`https://你的域名/bot/feishu`
3. 订阅事件 `im.message.receive_v1`
4. 权限：`im:message`、`im:message:send_as_bot`
5. 获取 App ID / App Secret / Verification Token / Encrypt Key，填入 `server/.env`

### 环境变量

| 变量 | 说明 |
|------|------|
| `DINGTALK_APP_KEY` | 钉钉应用 AppKey（即 robotCode） |
| `DINGTALK_APP_SECRET` | 钉钉应用 AppSecret |
| `WECOM_CORP_ID` | 企业微信企业 ID |
| `WECOM_TOKEN` | 企业微信回调 Token |
| `WECOM_ENCODING_AES_KEY` | 企业微信 EncodingAESKey（43 位） |
| `WECOM_AGENT_ID` | 企业微信应用 AgentID |
| `WECOM_SECRET` | 企业微信应用 Secret |
| `FEISHU_APP_ID` | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret |
| `FEISHU_VERIFICATION_TOKEN` | 飞书事件验证 Token |
| `FEISHU_ENCRYPT_KEY` | 飞书事件加密 Key |

## Docker 部署

```bash
cp server/.env.example server/.env
# 编辑 DB、JWT 等
docker compose -f docker-compose.deploy.yml up -d --build
```

镜像多阶段构建 `frontend` 并复制到 `/frontend/dist`，无需单独配置前端模式。

## 环境变量

| 变量 | 说明 |
|---|---|
| `FRONTEND_MODE` | 已废弃 `legacy`；保留 `auto`/`modern` 仅为兼容，均指向 `frontend/dist` |
| `AI_PROVIDER` | AI 提供商 |
| `VOICE_ENABLED` | 语音功能开关（默认开） |
| `IMAGES_DIR` | 图片静态目录 |
| `ADMIN_USER_CODES` | 管理员用户编码（逗号分隔，对应 OUSR `USER_CODE`） |

---

**历史备份**：标签 `v1.0-backup` 含已移除的旧版 `server/public` 整站 UI（Vanilla JS）。
