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
- 合并报工（Status 三段切换、点选即查询；多选 → 预检 → 接单/完工/暂停/恢复 → 保存；列表行点击订单详情）
- 菜单管理后台（CRUD、AI Prompt 生成器）
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
- 认证：OUSR 表，JWT 签发
- 管理员：`ADMIN_USER_CODES` env var（逗号分隔）
- 核心表：`nav_menu_items` 存储菜单、SQL 模板、filter_schema、column_name_mapping、AI prompt

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

## 合并报工

### 两种报工流程

**1. 批次报工**（`X_report_batch` + `work_reports`）
- 列表选择 → 创建批次 → 接单 → 计时（暂停/继续） → 提交

**2. 合并报工**（`X_ONLINE_SIGN` + `X_ONLINE_SIGN1`）
- 列表勾选 → 预检 → 接单页 → 确认保存

### Status 筛选与吸底按钮

生产报工列表顶部为 **三段切换**（替代 Status 下拉）：点选即 **自动查询**，其它筛选项变更后仍点「查询」。

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
    { "name": "恢复报工", "code": "8" }
  ]
}
```

`options` 与 `optionsSql` **二选一**（不可同时配置）。若用 `optionsSql`，下拉数据仍须能映射到 code `0` / `1` / `8`（或显示名含「待接单」「待完工」「恢复」等，前端会按名称兜底匹配）。

### SignType 判断（固定 code 映射）

| Status code | 分段 / 列表吸底 | 合并页操作 |
|---|---|---|
| `0` | 接单 | 确认接单 |
| `1` | 完工 | 完工 + **暂停报工** |
| `8` | 恢复报工 | 仅「恢复报工」（暂停后继续，勿用待完工重复暂停） |
| 未选 / 其它 | 合并报工 | 常规合并保存 |

实现见 `frontend/src/views/DynamicReportView.tsx`（`ProSignStatusSegment`、`resolveProSignMergeButtonLabel`）。

### 生产报工列表与订单详情

**查询列表**（菜单 `route_key` 一般为 `pro-sign`）：

1. 底部「菜单」→ 点击生产报工类菜单 → `openProSign()` 进入 `DynamicReportView`（`proSignMode=true`）
2. 顶部 **Status 三段**（待接单 / 待完工 / 恢复报工）点选即自动查询；其它筛选项改完后点「查询」
3. 勾选多行 → 吸底按钮（接单 / 完工 / 恢复报工 / 合并报工）→ 预检 → `ProSignReceiveView` 合并页

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
| `ADMIN_USER_CODES` | 管理员用户编码 |

---

**历史备份**：标签 `v1.0-backup` 含已移除的旧版 `server/public` 整站 UI（Vanilla JS）。
