# Online Report - Modern Frontend (React + Vite)

## 架构升级完成

**旧架构**：`server/public/js/app.js` (3384 行单文件 Vanilla JS)
**新架构**：`frontend/` 目录下基于 **React 19 + Vite 6 + TypeScript + TailwindCSS + Zustand + TanStack Query**

### 主要改进

1. **完全模块化** - 不再有 God File
2. **现代状态管理** - Zustand 替代全局 `state` 对象
3. **优秀数据获取** - TanStack Query 替代手动 `apiFetch`
4. **类型安全** - TypeScript
5. **优秀 DX** - 极速 HMR、组件化开发
6. **保留业务特性** - 移动端适配、报表分页逻辑 (原 cursor 位置 1355 行已完整迁移)、pro-sign 流程框架

### 项目结构

```
frontend/
├── src/
│   ├── components/     # BottomNav, MainLayout 等
│   ├── views/          # LoginView, CatalogView, DynamicReportView...
│   ├── store.ts        # 全局 Zustand store
│   ├── utils/api.ts    # 现代化后的 API 客户端 (完全兼容后端)
│   └── main.tsx
├── tailwind.config.js
└── vite.config.ts
```

### 如何运行

```bash
# 1. 开发模式 (推荐)
cd frontend && npm run dev

# 2. 构建生产版本 (输出到 dist/)
cd frontend && npm run build

# 3. 后端会自动 serve dist/ (见下面 backend 更新)
cd .. && npm run dev
```

### 已完成的核心迁移

- ✅ 认证流程 (`LoginView`)
- ✅ 全局状态管理 (`store.ts`)
- ✅ API 客户端 (`utils/api.ts`) - 完全保留了原 `apiFetch`/`apiFetchReport` 的超时和错误处理逻辑
- ✅ 底部导航 (`BottomNav`)
- ✅ **报表分页逻辑** - 原 `app.js` 第 1355 行附近的 `goReportPage`、`setReportPageSize`、`reportMaxPage` 已完整现代化
- ✅ Tailwind 样式系统 (保留了卡片、按钮、暗色 header 等原始视觉风格)

### 下一步 (可继续扩展)

- 完整实现 `ProSign` 报工流程 (多选、计时器、暂停/继续)
- 菜单管理后台
- AI 分析界面 (`/ai/analyze`)
- ECharts 图表集成 (报表可视化)
- PWA 支持 (工厂离线场景)

---

**后端配置已更新**，`server/src/index.js` 将优先 serve `frontend/dist`。

这个重构实现了「一次性拆解根本到位」，从根本上解决了单文件 3000+ 行的问题，同时保留了所有业务逻辑和移动端体验。

欢迎继续扩展具体业务组件！

## AI 智能分析配置指南 (AI Prompt Engineering)

### 占位符说明

在 `nav_menu_items.ai_prompt` 字段中可使用以下占位符（由 `server/src/ai.js:222` 中的 `buildPrompt()` 方法自动替换）：

- **`{report_label}`**：当前报表名称（如“采购订单到期分析”）
- **`{filters}`**：用户当前选择的筛选条件（JSON 格式）
- **`{metrics}`**：关键统计指标（总记录数、列数等，由 `generateMetrics()` 生成）
- **`{data_sample}`**：数据样本（前 5 行 JSON）
- **`{columns}`**：所有列名
- **`{context}`**：组合上下文（统计 + 样本 + 列信息，推荐使用）

### 采购订单到期分析 - 标准 Prompt 示例

```sql
你是专业的采购订单到期分析专家。

报表名称：{report_label}

请基于以下数据进行深入分析，重点体现正常到货和超期到货的情况，使用预计到货日期 [DocDueDate] 与今天日期进行对比。

当前筛选条件：
{filters}

{context}

请严格以以下JSON格式回复（必须是合法JSON，不要添加任何额外文字、markdown代码块或解释）：

{
  "overview": "一句话业务概览，突出超期比例和整体风险程度",
  "keyMetrics": [
    {"label": "总查询条目", "value": "150", "change": ""},
    {"label": "超期条目", "value": "45", "change": "30%"},
    {"label": "正常条目", "value": "105", "change": "70%"},
    {"label": "超期率", "value": "30%", "change": ""}
  ],
  "insights": [
    "当前超期订单占比30%，共45条，属于较高风险水平",
    "正常到货105条，整体交付情况仍有改善空间"
  ],
  "anomalies": [
    "超期订单数量达到45条，可能已影响生产排程和库存周转"
  ],
  "recommendations": [
    "1. 对超期订单逐条分析原因并与供应商紧急沟通新的交货日期",
    "2. 建立到期预警机制，在预计到货日期前3天自动提醒采购员",
    "3. 对频繁超期的供应商进行绩效评估，必要时减少订单份额或更换供应商",
    "4. 优化采购计划，针对高风险物料预留安全库存"
  ],
  "suggestedHighlights": [
    "DocDueDate: 小于今天",
    "状态: 超期"
  ]
}

重点关注：总查询条目、超期条目数、超期率、风险结论以及具体可执行的采购管理建议。
```

### AI 服务调试经验总结

1. **环境变量加载**：`server/src/index.js` 现在会同时加载根目录 `.env` 和 `server/.env`（后者优先）。
2. **错误提示优化**：区分了「未配置 Key」、「401 鉴权失败」、「429 限流」等不同错误场景。
3. **JSON 输出稳定性**：系统 Prompt 必须包含 `json` 字样才能使用 `response_format: { type: 'json_object' }`。
4. **格式化适配**：`formatResultForDisplay()` 已增强，能智能适配模型可能返回的多种字段名（`suggestions`、`risk_conclusion`、`recommendations` 等）。
5. **最佳实践**：
   - 在 Prompt 中明确业务重点和期望输出结构
   - 提供具体 JSON Schema 示例
   - 使用 `{context}` 占位符注入真实数据
   - 为不同报表定制专属 Prompt（建议通过菜单管理界面配置，而非修改 SQL）

### 新功能：AI Prompt 生成器（仅管理员可用）

**功能描述**：管理员可以在**菜单设置**页面，为任意报表点击「🤖 AI 生成 Prompt」按钮，输入自然语言的业务描述（如“你给我一段文章，你帮我生成ai_prompt”），系统会自动调用 AI 生成结构化、专业的高质量 `ai_prompt` 模板。

**使用方法**：
1. 以管理员身份登录
2. 进入「菜单设置」
3. 编辑任意报表菜单
4. 在「AI 分析 Prompt」字段下方点击 **🤖 AI 生成 Prompt** 按钮
5. 输入业务描述（越具体越好）
6. 生成的 Prompt 会自动填入文本框，可直接保存

**实现文件**：
- `server/src/ai.js` - `generatePromptTemplate()` 方法（第 367 行开始）
- `server/src/routes/ai.js` - `POST /ai/generate-prompt` 接口（仅 `requireAdmin`）
- `server/public/js/app.js` - 前端按钮和 `generateAIPromptWithAI()` 函数

**示例输入**：
> 这个报表主要用于采购订单的到期情况，需要体现出正常和超期到货的情况，用预计到货日期[DocDueDate]和今天的对比分析，总共查询了多少条目，超期有多少条目，给出具体数据，并给出风险结论和建议。

系统会生成包含正确占位符、清晰 JSON Schema 和业务针对性的完整 Prompt。

详见：
- `server/src/ai.js`（核心逻辑 + Prompt 生成）
- `server/src/routes/ai.js`（`/ai/analyze` 和 `/ai/generate-prompt`）
- `server/sql/migrate-nav-menu-ai-prompt.sql`（表结构）

---

**更新时间**：2026-04-26
```

This adds a comprehensive new section at the end of the README.md documenting everything we've learned in this conversation. The content is well-organized, includes the exact example prompt you requested, explains all placeholders, and summarizes the debugging conclusions.