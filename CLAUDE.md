# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

面向工厂/制造企业（对接 SAP B1）的在线报表系统：动态报表、报工、AI Agent 对话、BI 看板、IM 机器人与消息推送。模块：

- **server/** — Fastify (Node.js) 后端，连接 SQL Server 数据库
- **frontend/** — React 19 + Vite + TypeScript + TailwindCSS + Zustand 前端（PC 与手机浏览器/钉钉 H5 共用）
- **ai-agent/** — Python LangGraph Agent 独立服务（FastAPI/uvicorn，port 8080）
- **mobile-webview/** — Expo WebView 壳 + 原生语音按钮

README.md 有各功能的详细说明（配置字段、接口、环境变量），改功能时同步更新。面向用户的**使用说明书**在 `server/help/*.md`（见下文「使用说明书」），改了用户能看到的功能也要同步更新。

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
cd server && npm test                                         # 后端（node --test test/）
cd frontend && npx vitest run                                 # 前端单测
cd frontend && npx tsc -b                                     # 前端类型检查
cd frontend && npm run lint:colors                            # 检查是否写死颜色（必须通过）
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
- 路由注册方式：`fastify.register(routeFn)`
- 错误响应格式：`{ error: string, code: string, detail?: string }`
- `/api` 前缀：前端统一请求 `/api/...`，`Fastify({ rewriteUrl })` 去掉前缀再匹配（`server/src/spa.js`）；路由本身**不写** `/api`。机器人回调、ai-agent 回调等外部调用方继续用无前缀地址
- SPA 回退：浏览器导航（GET + `Accept: text/html`，非 `/api`、非静态资源）返回 `frontend/dist/index.html`，所以页面地址可以与 GET 接口同名
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
- 定时报告：`scheduled-reports.js`（node-cron → `agentChatCore()` → IM 推送）；设了 `agent_key` 即「看板每日要点」（`bi-digest.js`：按推送对象角色分组取看板数据 → AI 写 3~5 条要点 → 附 `PUBLIC_BASE_URL/agents/:agentKey` 链接）

### BI 看板（第一期已完成，见 README「BI 看板」）

- 三层分开维护：查询库 `bi_queries`（`bi-queries.js`，只读 SQL + 参数 + 列语义 + 口径 + 缓存 + 角色）→ 图表 `bi_charts`（`bi-charts.js`，引用一个 queryKey + 类型 + encoding + 下钻 + 默认尺寸，参数只写固定值，可被多个看板复用）→ 看板 `bi_dashboards`（`bi-dashboards.js`，筛选 + 卡片；卡片只是图表引用 `{ id, chartKey, title?, params?, layout? }`）；Agent 用 `agents.dashboard_key` 关联看板；对话时注入看板查询目录（`agent-context.js`，含列语义 / 示例问法，按用户角色过滤），配置页 `AgentCatalogPreview` 按角色预览
- 展开：`bi-charts.js` 的 `resolveCard` / `expandDashboard` 把看板引用展开成完整卡片（参数优先级：看板覆盖 > 图表固定值 > **同名筛选自动绑定** > 查询默认；下钻 bind 最优先）。运行时接口、前端渲染、AI 查询目录只认展开后的卡片（`loadExpandedDashboard`）；前端 `utils/biAdmin.ts` 的 `resolveCard` 须与之一致
- 执行与缓存：`bi-exec.js`（缓存 key 含角色集合）；路由 `server/src/routes/bi.js`
- 卡片、下钻、Agent 追问（`run_named_query`）共用同一命名查询，保证口径一致
- 前端：`components/bi/`（`DashboardPanel`、`BiCardView`、`BiChart`、`BiPickPopover`）、`utils/bi*.ts`（结构须与后端校验保持一致）
- 查询库是语义层：`bi_queries.columns_json`（输出列语义：role = dimension / measure / time / attr，format / unit / scale）+ `sample_questions_json`；维度 `dimensions` 由 dimension / time 列推导。卡片 encoding 没写的格式/单位/列名在前端经 `withColumnSemantics()` 继承列语义
- 引用完整性：`bi-charts.js` 的 `checkCardRefs()`（参数存在、必填参数有来源、encoding / bind 的列在输出列中）；保存图表时不要求必填参数有来源（由看板同名筛选提供），保存看板时展开后完整检查；保存查询 / 图表时对下游做影响分析（返回 `warnings`）。前端 `utils/biAdmin.ts` 的 `cardProblems()` / `chartProblems()` / `refProblems()` 规则须与之一致
- 管理页 `views/BiAdminView.tsx`（查询 / 图表 / 看板三个页签）+ `components/bi/admin/`（`QueryEditor`：SQL → 自动识别参数 → 试运行识别输出列 → 标注语义；`ChartEditor` + `ChartForm`：选查询、列下拉、固定参数、下钻、实时预览；`DashboardEditor` + `DashboardCanvas`：筛选表格、看板画布（真实排版与数据，拖动换位 / 拖边改宽高，HTML5 DnD + 指针事件）、右侧卡片设置（参数来源展示与覆盖）、JSON 模式）。预览复用 `DashboardPanel.tsx` 导出的 `DashboardView`
- AI 辅助（`bi-draft.js`，都只返回草稿）：起草查询 + 1~3 张图表（`/admin/bi/ai/draft`，选表 → 读 INFORMATION_SCHEMA / CUFD → 生成 → `checkAndRun` 只读校验 + 试运行 → 报错交回 AI 修正 ≤3 轮）；按一句话改查询（`/admin/bi/ai/revise-query`）；补全语义层（`/admin/bi/ai/enrich-query`，前端只填空着的）。前端 `AiDraftModal` → `QueryEditor` → `AiChartsReview`。对话收藏：`run_sql` 的 SQL → `components/bi/PinToDashboard`（Agent 页 / AI 助手，仅管理员）→ `utils/biPin.ts`（localStorage 传给新标签页）→ `AiDraftModal` 的 `fromSql` 模式 → `/admin/bi/ai/draft-from-sql`（参数化 + 语义，同一修正循环）。禁用表清单在 `bi-draft.js` 的 `DENY_*`
- 图表默认尺寸按类型（`utils/bi.ts` 的 `defaultChartSize`，后端 `bi-charts.js` 的 `DEFAULT_WIDTH` 须一致）

### IM 与消息

- 钉钉（Stream 模式 + 免登）、企微、飞书机器人：`routes/bot-*.js`，用户绑定 `bot_user_bindings`，日志 `bot_message_logs`
- 消息提醒/预警推送：`message-alerts.js`、`alert-*.js`；警报规则可引用 BI 命名查询 + 条件（`alert_rules.bi_check_json`，`alert-bi.js`：阈值 / 较上期变化，定时或事件触发（参数 `$event.字段`，事件清单 `KNOWN_EVENTS`），运行时不调 AI；「一句话设预警」AI 只出草稿 + 试算）；动态值 `$thisMonth` 等服务端解析在 `bi-tokens.js`

### 前端 (React + Vite)

- 状态管理：Zustand store (`frontend/src/store.ts`)，含 auth、menus、toast、视图路由、报表/报工上下文
- 视图切换：Zustand `currentView` 是唯一状态源，不使用 React Router；新增视图须同时改 `types.ts` 的 `ViewName`、`components/MainLayout.tsx` 的视图表与标题、`views/index.ts`，并在 `router.ts` 登记地址
- URL 路由：`frontend/src/router.ts` 做「状态 ⇄ 地址」同步（`pathFor` / `parsePath`，有单测）。地址如 `/report/:routeKey`、`/agents/:agentKey`、`/admin/bi`；刷新、收藏、浏览器/安卓返回键都可用。打开菜单统一用 store 的 `openMenuItem(menu)`；侧栏 / 底部 Tab 的一级入口用 `openEntry(view)`（回到切走前的子页面）。`MainLayout` 对 AI 助手和 Agent 对话页做保活（隐藏不卸载），这两个页面里注意隐藏时别对全局产生副作用
- API 层：`frontend/src/utils/api.ts` 的 `apiUrl()` 统一加 `/api` 前缀（开发时 Vite 代理去掉前缀转发，`API_PROXY_TARGET` 可改代理目标）；JWT 存 localStorage key `online_report_token`
- Agent 流式：`utils/agentStream.ts`；图表统一用 ECharts（`components/ChartRenderer.tsx`）
- 外壳：`MainLayout` —— PC（≥1024px，`hooks/useMediaQuery.ts` 的 `useIsPc`）左侧 `Sidebar` + 面包屑顶栏；手机顶栏 + `BottomNav`。管理入口集中在「管理后台」`AdminHubView`（入口清单 `components/adminEntries.ts`）
- 管理后台只在 PC 上用：管理页用 `ui` 的 `AdminPage`（页头/返回）+ `Section` 双栏（`lg:grid-cols-2`）+ `EditorActions`（底部固定取消/保存）+ `RecordRow` 列表；JSON 配置用 `JsonField`，角色多选用 `ChipSelect`；删除等确认用 `ui/confirm.ts` 的 `confirmDelete` / `confirmAsync`，不要用 `window.confirm`
- 页面需兼顾 PC 与手机宽度（AgentRunView：PC 左对话右看板，移动端顶部页签）；PC 布局用 Tailwind `lg:` 断点或 `useIsPc`，不要读 `window.innerWidth`
- 页面里 `position: fixed` 的底栏（输入框、操作按钮条）在 PC 上要加 `lg:left-[var(--sidebar-w)]` 让出侧边栏（展开 14rem、收起 4rem，由 `MainLayout` 写入 CSS 变量；顶栏左侧按钮切换，选择存本机 localStorage），并去掉为手机底部 Tab 预留的高度（`lg:bottom-0`）

### 界面主题（六套，可切换）

- token 定义：`frontend/src/theme/themes.css`（`[data-ui-theme="warm|tech|ent|ind|mono|dark"]`，默认 D `warm`）；视觉参照 `docs/design/ui-style-demo.html`
- Tailwind 只提供语义色（`tailwind.config.js`）：`bg / surface(-2/-3) / line(-strong) / fg(-2) / muted / subtle / primary(-hover/-fg/-soft) / accent / success / warning / danger / info(+ -soft) / inverse / chrome-* / chart-1..8`，以及 `bg-ai`（AI 渐变）、`font-display`、`.num`（数字字体）。`slate-*`、`sky-*` 等原始调色板**不会生成**
- 运行时：`theme/index.ts`（`useTheme`、`setThemePref`、跟随系统、`tv('primary')` 内联样式取色、`readChartPalette`）；`theme/sync.ts` 与服务端同步（`GET /ui/config` 公司默认、`GET/PUT /me/preferences` 用户选择、`PUT /admin/ui-settings`）
- ECharts 统一经 `utils/chartTheme.ts` 的 `themedChartOption()` 套主题色，并用 `useThemeChange` 在切换时重绘
- 通用组件：`frontend/src/ui/`（`Button`、`Card`、`Section`、`PageHeader`、`Badge`、`Segmented`、`Tabs`、`Field/Input/Select/Textarea`、`ListRow`、`Modal`、`EmptyState`、`KpiCard` 等；`ui/classes.ts` 有 `cn` 与表单/表格类名常量）

### 生产部署

- `docker-compose.deploy.yml`：服务 `app`（server + 多阶段构建的 `frontend/dist`）与 `ai-agent`；加载 `server/.env` 或指定 `DEPLOY_ENV_FILE`
- 本地仅跑 server 时需先 `npm run build`
- APK 下载：`GET /download/android-app.apk`，按优先级尝试：`APK_PATH` → `server/public/apk/android-app.apk` → `APK_SHARE_ROOT + APK_FILENAME`

### 使用说明书（`server/help/*.md`）

- 一份 Markdown 两处用：前端整篇阅读（`routes/help.js` 的 `GET /help/docs`、`/help/docs/:slug`，`help-docs.js`；前台入口：说明书列表 `views/HelpView.tsx`（`/help`，PC 左侧菜单「设置」上方，手机「设置」页「帮助」）→ 阅读页 `HelpDocView`（`/help/:slug`，store `openHelpDoc`）；页内侧栏 `components/HelpDocPanel.tsx`（BI 看板管理右上角「使用说明」），正文渲染共用 `HelpDocContent`），AI 按章节检索（`help-knowledge.js`：`/ai/chat` 与 ai-agent 的 `knowledge_search`）
- 文件头注释：`<!-- tags: ... -->`（检索标签，放第一行）、`<!-- audience: admin -->`（仅管理员可读）；slug = 文件名去序号，如 `08-bi-admin.md` → `bi-admin`；按 `## ` 切块，每节要能单独读懂
- 配图放 `server/help/images/<模块>/`，正文写相对路径 `![说明](images/bi/xxx.png)`（公开访问，只放演示数据截图）；AI 片段里配图自动换成文字；`test/help-docs.test.js` 检查引用的图都存在
- **改了用户可见的功能（按钮、流程、字段、入口），同一个提交里更新对应说明书**；界面明显变了就重截相关配图（Playwright 截图方法见 README「使用说明书」）

## 开发约定

- **中国本地时间**：界面与 SQL `DATETIME2` 墙钟时间须一致（UTC+8）。禁止对用户可见字段用 `toISOString()` / 裸 `Date` 绑库 / `SYSUTCDATETIME()` 默认值。统一用 `server/src/china-datetime.js`（`toChinaLocalDateTimeForSql`、`SQL_CHINA_LOCAL_NOW_EXPR`）；表默认值用 `DATEADD(HOUR,8,SYSUTCDATETIME())`。详见 `.cursor/rules/china-local-datetime.mdc`。
- 路由文件在 `server/src/routes/`，以 Fastify plugin 函数导出：`async function xxxRoutes(fastify) { ... }; module.exports = xxxRoutes;`
- 数据库迁移脚本在 `server/sql/`
- 后端路由定义不写 `/api` 前缀（由 `rewriteUrl` 统一去掉），前端请求一律经 `apiUrl()` / `apiFetch()`
- 权限必须后端校验（菜单 `roles_json`、Agent `canUseAgent`、BI 查询 `canUseQuery`），不能只靠前端隐藏；SQL 报错详情只给管理员
- **只用变量，不写死颜色**：组件里禁止十六进制色值、`rgb()` 字面量、原始调色板类名、内联命名色；一律用语义色类名或 `tv()`。`npm run lint:colors` 必须通过。各主题布局一致，只变外观；新增 token 时六套主题都要补齐
- 密钥只放 `.env`（已 gitignore `.env` / `.env.*`），只提交 `.env.example`
- 提交信息用 `feat(scope): 中文说明` 风格；较大功能在提交信息里列验证结果
