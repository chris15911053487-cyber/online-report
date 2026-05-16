# Online Report - 工厂在线报表 & 报工系统

面向工厂/制造企业的在线报表系统，支持动态报表查询、AI 智能分析、合并报工流程。

## 架构

项目包含两套前端 UI（共用同一后端 API）：

| | 旧版 (Legacy) | 新版 (Modern) |
|---|---|---|
| **位置** | `server/public/` | `frontend/` |
| **技术** | Vanilla JS + 手写 CSS | React 19 + Vite + TypeScript + TailwindCSS + Zustand |
| **功能** | 100% 完整，生产验证 | 全功能迁移完成 |
| **切换** | `FRONTEND_MODE=legacy` | `FRONTEND_MODE=modern`（需先 build） |

### 前端切换控制

通过环境变量 `FRONTEND_MODE` 控制：

| 值 | 行为 |
|---|---|
| `auto`（默认） | `frontend/dist` 存在则用新版，否则用旧版 |
| `modern` | 强制使用 `frontend/dist`（React） |
| `legacy` | 强制使用 `server/public/`（Vanilla JS） |

### 新版前端结构

```
frontend/src/
├── components/      # BottomNav, MainLayout, ImageLightbox, ReportOverlay, TextOverlay, Toast
├── views/           # LoginView, CatalogView, DynamicReportView, MenuSettingsView,
│                    # OworView, OrdersView, DetailView, ReportRowDetailView,
│                    # ProSignReceiveView, WorkRegistrationView, SettingsView
├── utils/
│   ├── api.ts       # API 客户端（apiFetch / apiFetchReport）
│   └── helpers.ts   # 通用工具函数
├── store.ts         # Zustand 全局状态 + 路由管理
├── types.ts         # TypeScript 类型定义
└── main.tsx
```

### 已完成的功能迁移

- 登录 / 退出 / 修改密码
- 目录页 + 菜单导航（builtin / report / pro-sign 路由）
- 动态报表（筛选表单、分页、图片列+灯箱、长文本展开、扫码按钮）
- AI 智能分析（调用 `/ai/analyze`，格式化结果展示）
- 合并报工（列表多选 → 预检 → 接单页 + 操作员多选 → 保存预览 → 提交）
- 菜单管理后台（CRUD、AI Prompt 生成器）
- OITM 物料查看
- 报工订单列表 / 订单详情 / 提交报工
- 报表行详情（转置视图）
- 批次报工登记（接单/暂停/继续/提交 + 实时计时）
- 底部四页签导航 + 返回导航

## 常用命令

```bash
# 同时启动前后端开发
npm run dev

# 仅前端 (Vite, port 5173)
cd frontend && npm run dev

# 仅后端 (Node --watch, port 3000)
cd server && npm run dev

# 构建前端到 frontend/dist/
npm run build

# 数据库初始化
npm run init-db
```

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
- 路由：`POST /ai/analyze`、`POST /ai/generate-prompt`

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

`voice.js` 独立模块，通过百度 ASR 实现语音指令。详见 `docs/voice-recognition-guide.md`。

## 环境变量

| 变量 | 说明 |
|---|---|
| `FRONTEND_MODE` | 前端模式：`auto`/`modern`/`legacy` |
| `AI_PROVIDER` | AI 提供商 |
| `VOICE_ENABLED` | 语音功能开关 |
| `IMAGES_DIR` | 图片静态目录 |
| `ADMIN_USER_CODES` | 管理员用户编码 |

---

**备份标签**：`v1.0-backup` — 双 UI 重构前的完整版本
