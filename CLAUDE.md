# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

面向工厂/制造企业（对接 SAP B1）的在线报表系统：动态报表、报工、AI Agent 对话、BI 看板、IM 机器人与消息推送。模块：

- **server/** — Fastify (Node.js) 后端，连接 SQL Server 数据库
- **frontend/** — React 19 + Vite + TypeScript + TailwindCSS + Zustand 前端（PC 与手机浏览器/钉钉 H5 共用）
- **ai-agent/** — Python LangGraph Agent 独立服务（FastAPI/uvicorn，port 8080）
- **mobile/** — 早期 React Native (Expo) 原生 App（仅订单页，基本不再维护）
- **mobile-webview/** — Expo WebView 壳 + 原生语音按钮

README.md 有各功能的详细说明（配置字段、接口、环境变量），改功能时同步更新。

## 常用命令

```bash
# 同时启动前后端开发
npm run dev
# 仅前端 (Vite, port 5173) / 仅后端 (Node --watch, port 3000)
cd frontend && npm run dev
cd server && npm run dev
# 构建前端到 frontend/dist/
npm run build
# 数据库初始化（建报工表等）
npm run init-db

# 测试
cd server && node --test test/                                # 后端（无 npm test 脚本）
cd frontend && npx vitest run                                 # 前端单测
cd frontend && npx tsc -b                                     # 前端类型检查
cd ai-agent && python3 -m unittest discover -s tests -v       # ai-agent（未装依赖的用例自动跳过）

# 前端 lint
cd frontend && npm run lint
```

- ESLint 有约 159 个历史遗留问题（多为 `no-explicit-any`），标准是**不新增**，不要求清零。
- CI（`.github/workflows`）只做 `node --check src/index.js`，测试须本地跑。

## 架构核心

### 后端 (Fastify)

- 入口 `server/src/index.js`：注册 Fastify 插件（cors, jwt, multipart, static），挂载路由，serve `frontend/dist`；`server/public` 仅 apk/images/voice.js
- `.env` 加载顺序：根目录 `.env` → `server/.env`（后者覆盖）
- 认证：基于 OUSR 表（`USER_CODE` / `MobileIMEI`），JWT 签发，Fastify decorator `fastify.authenticate` 和 `fastify.requireAdmin`；钉钉 H5 免登通过 `OUSR.U_DDUserId` 映射
- 角色：`server/src/roles.js`（`resolveUserRoles`、`canAccessMenu`）；`app_roles` / `user_roles` 表；`ADMIN_USER_CODES` env var 指定管理员；无分配默认 `operator`；内置 `cost-viewer`、`attachment-generator`、`web-access` 等能力型角色
- 路由注册方式：`fastify.register(routeFn)`，但 `owor` 用 `registerOworRoutes(fastify)` 直接调用
- 错误响应格式：`{ error: string, code: string, detail?: string }`
- 启动时 `ensure-nav-menu-schema.js` 自动执行 `server/sql/migrate-*.sql`（新表须写成幂等的 `IF OBJECT_ID(...) IS NULL`）

### 数据库 (SQL Server)

- 使用 `mssql` 包（Tedious/TDS 协议），连接配置见 `server/src/db.js:buildConfig()`
- 所有查询通过 `.input()` 参数绑定，禁止字符串拼接
- `getPool()` 返回单例连接池，含重试逻辑（最多 3 次，可通过 `DB_CONNECT_RETRIES` 调整）
- 核心表 `nav_menu_items`：存储菜单、报表 SQL 模板、filter_schema、column_name_mapping、AI prompt 等配置

### 报表系统 (`server/src/report-query.js`)

- 报表配置存在 `nav_menu_items` 表中，`menu_kind = 'report'`
- 支持两种 SQL 模板：`GO` 分隔的多条 SQL（`multi`）和单一 SELECT（`other`）
- `filter_schema_json`：定义筛选字段、optionsSql（下拉选项）、验证规则
- `column_name_mapping_json`：列名中英文映射
- 分页：支持服务端分页和客户端分页两种模式，由 `executeReportQuery` 自动判断
- 路由：`POST /reports/run`（查询）、`POST /reports/filter-field-options`（下拉选项）、`POST /reports/detail`（行详情）

### 报工

- 批次报工（`X_report_batch` + `work_reports`）与合并报工（`X_ONLINE_SIGN`，`server/src/routes/pro-sign.js`，前端 `DynamicReportView` 的 `proSignMode` + `ProSignReceiveView`）
- 返工领料：`returnpro-*.js`，调 SAP B1 Service Layer

### AI 分析 (`server/src/ai.js`) — 报表页内的单次分析

- 多模型支持：OpenAI、Grok、DeepSeek、Anthropic、Ollama、Azure OpenAI，通过 `AI_PROVIDER` 切换
- Prompt 占位符：`{report_label}`, `{filters}`, `{metrics}`, `{data_sample}`, `{columns}`, `{context}`
- 强制 `response_format: { type: 'json_object' }`，含 fallback JSON 解析
- 路由：`POST /ai/analyze`、`POST /ai/generate-prompt`；`POST /ai/chat` 为 `server/help/*.md` 知识库问答（ai-agent 不可达时的降级）
- 详细规则见 `.cursor/rules/ai-analysis-best-practices.mdc`（`alwaysApply: true`）

### AI Agent（`ai-agent/` + `server/src/routes/ai-agent.js`）

- 链路：前端 → 主后端 `/ai/agent/chat`（及 SSE `/ai/agent/chat/stream`）→ ai-agent（`AI_AGENT_URL`）→ LLM + 工具 → 回调主后端 `/ai/agent/internal/*`（带 scoped token，`AI_SCOPED_SECRET` 两边必须一致）
- ai-agent 关键文件：`agent.py`（LangGraph ReAct）、`tools.py`（白名单工具：`run_sql`、`run_named_query`、`run_report`、`load_skill`、`save_record`、`generate_document`、`generate_chart`、`web_search` 等）、`agent_rules.md`（全局规则，注入 system prompt）、`bi_context.py`
- **前缀缓存约定**：system prompt 顺序为 全局规则 → skill → Agent 指令 → 用户信息（最后）；随时间/用户变化的内容不得放进前面的段落；看板点击上下文注入**用户消息**而非 system prompt
- Skill：`agent-skills.js`，按角色过滤；`run_sql` 只能执行 Skill 中描述的表/模式，仅 SELECT（`agent-sql.js`）
- 可配置 Agent：`agents` 表（`agents.js`），前端 `AgentHubView` / `AgentRunView` / `AgentsAdminView`
- AI 写入：`agent_write_targets` 白名单（`agent-write.js`）；API 动作放 `server/src/actions/*.js`，自动扫描加载
- 定时报告：`scheduled-reports.js`（node-cron → `agentChatCore()` → IM 推送）

### BI 看板（第一期已完成，见 README「BI 看板」）

- 三处分开维护：查询库 `bi_queries`（`bi-queries.js`，只读 SQL + 参数 + 维度 + 口径 + 缓存 + 角色）、看板 `bi_dashboards`（`bi-dashboards.js`，筛选 + 卡片，卡片只引用 `queryKey`）、`agents.dashboard_key`
- 执行与缓存：`bi-exec.js`（缓存 key 含角色集合）；路由 `server/src/routes/bi.js`
- 卡片、下钻、Agent 追问（`run_named_query`）共用同一命名查询，保证口径一致
- 前端：`components/bi/`（`DashboardPanel`、`BiCardView`、`BiChart`、`BiPickPopover`）、`utils/bi*.ts`（结构须与后端校验保持一致）
- 管理页 `views/BiAdminView.tsx` 目前是最简版：参数/维度/筛选/卡片都靠手写 JSON，无可视化编辑与预览

### IM 与消息

- 钉钉（Stream 模式 + 免登）、企微、飞书机器人：`routes/bot-*.js`，用户绑定 `bot_user_bindings`，日志 `bot_message_logs`
- 消息提醒/预警推送：`message-alerts.js`、`alert-*.js`

### 前端 (React + Vite)

- 状态管理：Zustand store (`frontend/src/store.ts`)，含 auth、menus、toast、视图路由、报表/报工上下文
- 视图路由：通过 Zustand `currentView` 状态切换，不使用 React Router；新增视图须同时改 `types.ts` 的 `ViewName`、`components/MainLayout.tsx` 的视图表与标题、`views/index.ts`
- API 层：`frontend/src/utils/api.ts` — 开发时走 Vite proxy `/api → localhost:3000`，生产时同域直接请求；JWT 存 localStorage key `online_report_token`
- Agent 流式：`utils/agentStream.ts`；图表统一用 ECharts（`components/ChartRenderer.tsx`）
- 管理员入口集中在 `SettingsView`（Agent 配置、BI 看板管理、AI Skill、消息提醒、定时报告等）
- 页面需兼顾 PC 与手机宽度（AgentRunView：PC 左对话右看板，移动端顶部页签）

### 生产部署

- `docker-compose.deploy.yml`：服务 `app`（server + 多阶段构建的 `frontend/dist`）与 `ai-agent`；加载 `server/.env` 或指定 `DEPLOY_ENV_FILE`
- 本地仅跑 server 时需先 `npm run build`
- APK 下载：`GET /download/android-app.apk`，按优先级尝试：`APK_PATH` → `server/public/apk/android-app.apk` → `APK_SHARE_ROOT + APK_FILENAME`

## 开发约定

- **中国本地时间**：界面与 SQL `DATETIME2` 墙钟时间须一致（UTC+8）。禁止对用户可见字段用 `toISOString()` / 裸 `Date` 绑库 / `SYSUTCDATETIME()` 默认值。统一用 `server/src/china-datetime.js`（`toChinaLocalDateTimeForSql`、`SQL_CHINA_LOCAL_NOW_EXPR`）；表默认值用 `DATEADD(HOUR,8,SYSUTCDATETIME())`。详见 `.cursor/rules/china-local-datetime.mdc`。
- 路由文件在 `server/src/routes/`，以 Fastify plugin 函数导出：`async function xxxRoutes(fastify) { ... }; module.exports = xxxRoutes;`
- 数据库迁移脚本在 `server/sql/`
- 后端所有路由无 `api` 前缀（Fastify 直接注册），前端开发时 Vite proxy 加 `/api` 再 strip
- 权限必须后端校验（菜单 `roles_json`、Agent `canUseAgent`、BI 查询 `canUseQuery`），不能只靠前端隐藏；SQL 报错详情只给管理员
- 密钥只放 `.env`（已 gitignore `.env` / `.env.*`），只提交 `.env.example`
- 提交信息用 `feat(scope): 中文说明` 风格；较大功能在提交信息里列验证结果
