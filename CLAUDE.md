# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

面向工厂/制造企业的在线报表系统，支持动态报表查询、AI 智能分析、报工流程。三个模块：

- **server/** — Fastify (Node.js) 后端，连接 SQL Server 数据库
- **frontend/** — React 19 + Vite + TypeScript + TailwindCSS + Zustand 前端
- **mobile/** — React Native (Expo) 移动端

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

# 数据库初始化（建报工表等）
npm run init-db

# 前端 lint
cd frontend && npm run lint
```

## 架构核心

### 后端 (Fastify)

- 入口 `server/src/index.js`：注册 Fastify 插件（cors, jwt, static），挂载路由，serve `frontend/dist`；`server/public` 仅 apk/images/voice.js
- `.env` 加载顺序：根目录 `.env` → `server/.env`（后者覆盖）
- 认证：基于 OUSR 表（`USER_CODE` / `MobileIMEI`），JWT 签发，Fastify decorator `fastify.authenticate` 和 `fastify.requireAdmin`
- 管理员：`ADMIN_USER_CODES` env var 指定（逗号分隔的 OUSR user_code）
- 路由注册方式：`fastify.register(routeFn)`，但 `owor` 用 `registerOworRoutes(fastify)` 直接调用
- 错误响应格式：`{ error: string, code: string, detail?: string }`

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

### AI 分析 (`server/src/ai.js`)

- 多模型支持：OpenAI、Grok、DeepSeek、Anthropic、Ollama、Azure OpenAI
- 通过 `AI_PROVIDER` env var 切换，各 provider 有独立 API Key 和 baseURL
- Prompt 占位符：`{report_label}`, `{filters}`, `{metrics}`, `{data_sample}`, `{columns}`, `{context}`
- 强制 `response_format: { type: 'json_object' }`，含 fallback JSON 解析
- 路由：`POST /ai/analyze`（执行分析）、`POST /ai/generate-prompt`（管理员用 AI 生成 prompt 模板）
- 详细规则见 `.cursor/rules/ai-analysis-best-practices.mdc`（`alwaysApply: true`）

### 前端 (React + Vite) — 已完成全功能迁移

- 状态管理：Zustand store (`frontend/src/store.ts`)，含 auth、menus、toast、视图路由、报表/报工上下文
- API 层：`frontend/src/utils/api.ts` — 开发时走 Vite proxy `/api → localhost:3000`，生产时同域直接请求
- JWT token 存 localStorage key `online_report_token`
- 工具函数：`frontend/src/utils/helpers.ts` — 图片列判断、报表列映射、合并报工数据提取、AI 结果格式化
- 类型定义：`frontend/src/types.ts` — User、NavMenuItem、FilterField、ViewName 等
- 视图路由：通过 Zustand `currentView` 状态切换，不使用 React Router
- 视图列表：LoginView、CatalogView、DynamicReportView、AiChatView、MenuSettingsView、OworView、OrdersView、DetailView、ReportRowDetailView、ProSignReceiveView、WorkRegistrationView、SettingsView
- 通用组件：BottomNav、MainLayout、ImageLightbox、ReportOverlay、TextOverlay、Toast

### 生产部署

- `docker-compose.deploy.yml`：生产 Docker 部署，加载 `server/.env` 或指定 `DEPLOY_ENV_FILE`
- 镜像内多阶段构建 `frontend/dist`；本地仅跑 server 时需先 `npm run build`
- APK 下载：`GET /download/android-app.apk`，按优先级尝试：`APK_PATH` → `server/public/apk/android-app.apk` → `APK_SHARE_ROOT + APK_FILENAME`

## 开发约定

- 路由文件在 `server/src/routes/`，以 Fastify plugin 函数导出：`async function xxxRoutes(fastify) { ... }; module.exports = xxxRoutes;`
- 数据库迁移脚本在 `server/sql/`
- 前端路由不使用 React Router，通过 Zustand `currentView` 状态切换视图
- 后端所有路由无 `api` 前缀（Fastify 直接注册），前端开发时 Vite proxy 加 `/api` 再 strip
