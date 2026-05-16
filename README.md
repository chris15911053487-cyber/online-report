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
│                    # ProSignReceiveView, WorkRegistrationView, SettingsView
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
- AI 智能分析（`/ai/analyze`）与 AI 助手对话（`/ai/chat`）
- 合并报工（多选 → 预检 → 接单/完工/暂停 → 保存）
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

## 合并报工

### 两种报工流程

**1. 批次报工**（`X_report_batch` + `work_reports`）
- 列表选择 → 创建批次 → 接单 → 计时（暂停/继续） → 提交

**2. 合并报工**（`X_ONLINE_SIGN` + `X_ONLINE_SIGN1`）
- 列表勾选 → 预检 → 接单页 → 确认保存

### SignType 判断

| Status 筛选值 | SignType 写入值 | 含义 |
|---|---|---|
| `0` | `接单` | 接单开工 |
| `1` | `完工` | 完工汇报 |
| 未筛选/其他 | `合并报工` | 常规合并报工 |

## 报表图片列

列名以 `_img` / `_image` / `_pic` / `_photo` 结尾自动识别为图片列，渲染缩略图 + 灯箱。

- 静态目录：`IMAGES_DIR`（默认 `server/public/images/`）
- UNC 路径走代理接口 `GET /files/image`

## 扫码功能

`filter_schema` 中字段配置 `"scan": true` 显示扫码按钮。HTTPS 调摄像头，HTTP 回退相册。

## 语音控制

- 源码：`frontend/public/js/voice.js`（构建进 `dist`）；服务端兜底路由仍从 `server/public/js/voice.js` 提供（两处请保持同步）
- 详见 `docs/voice-recognition-guide.md`

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
