# 智能报表 Agent 设计方案（讨论记录）

> 讨论时间：2026-09-15
> 状态：设计阶段，未开始实现。用于跨会话延续。

## 一、目标

在保留现有「AI 对话助手」（操作说明 + 业务动作）的基础上，**新增一个专属的对话式 BI Agent（智能报表）**，核心诉求：

- 用户说一句话 → 展示多维度、多形式、多内容的分析结果
- 加入 AI 判断（异常标注、趋势解读、根因推断）
- 图表数据点可点击 → 下钻看明细
- 经得起互动、查询
- 支持多轮对话（二次追问、解答疑问）——**这是重点**
- 可配置性的 Agent（管理员可配数据域、SQL 模板、权限）

## 二、现状盘点（已读代码确认）

**已具备的能力：**
- `ai-agent/app/tools.py` 已有 `generate_chart` 工具，支持 `bar/line/pie/graph`，输出 ECharts option
- `frontend/src/components/ChartRenderer.tsx` 已用 ECharts 渲染，支持全屏、函数字符串复原
- `server/src/agent-chat-core.js` 已有完整多轮对话核心（历史落库、skill 注入、scoped token、降级）
- `ai-agent` 为独立 Python 容器（LangGraph ReAct Agent），主后端 `/ai/agent/chat` 转发
- 会话历史：`ai-conversations.js`，最近取 24 条

**当前实现的三个硬伤（决定新界面必须重做）：**
1. 图表嵌在 Markdown 文字流里，靠 `![图表标题]` 占位符定位，越聊越难找回
2. `ChartRenderer` 没有绑定任何点击事件，无法下钻
3. 没有"当前分析上下文"概念，追问全靠 LLM 从历史里猜，易丢失/串味

## 三、核心设计矛盾与解法

**矛盾**：多轮对话是线性向下的，数据分析是反复停留/对比/下钻的，手机屏幕又小。图表塞进聊天气泡必然失败。

**解法**：**对话流 + 分析画布 双区**（ChatGPT Canvas / Claude Artifacts 思路）。

## 四、界面布局（移动端主场景）

```
┌─────────────────────────────────────┐
│ ← 智能报表          [历史] [新分析] │
├─────────────────────────────────────┤
│ 📌 9月1-15日 · 完工分析 · 按工序    │  ← 上下文条(可点可删)
│    [9月 ×][工序 ×] [+加条件]        │
├─────────────────────────────────────┤
│   ┌───────┐┌───────┐┌───────┐      │
│   │完工342││良品96%││异常 12│      │  ← 指标卡(横滑)
│   │ ↑8.3% ││ ↓0.4% ││ ⚠️     │      │
│   └───────┘└───────┘└───────┘      │
│   ┌─────────────────────────────┐   │
│   │ 各工序完工量      [柱▾][⛶]  │   │  ← 图表类型可切
│   │  ▄▄  ▄▄▄▄  ▄▄  ▄▄▄▄▄▄       │   │
│   │  工1  工2  工3   工4        │   │  ← 点数据点=下钻
│   └─────────────────────────────┘   │
│   🤖 工序3产量偏低37%,集中在14-15点  │  ← AI 判断贴在图下
│      [查看工序3明细] [对比昨天]      │  ← AI 给的追问建议
│ ⌃ 画布 ────── 拖拽分界 ──────────── │  ← 可上拉/下拉
│  💬 你: 今天完工怎么样?             │
│  🤖 已按工序汇总  [📊 结果1] ←点回看 │
│  💬 你: 工序3明细                   │
│  🤖 12条异常记录  [📊 结果2] ●当前   │
├─────────────────────────────────────┤
│ [🎤] 继续追问...            [发送]  │
└─────────────────────────────────────┘
```

## 五、三个关键设计决策

**决策1：画布只显示"当前焦点"，不堆积**
- 对话流里每轮 AI 回复只留一个缩略卡片 `[📊 结果N]`，点击把那轮结果重新拉回画布
- 聊 20 轮画布也不爆。当前在画布上的那轮标 `●当前`

**决策2：点图表 = 自动发起一轮对话**
- 点数据点不是弹 modal，而是自动往对话流插入一条用户消息「查看 工序3 的明细」（带结构化 drill 参数）→ Agent 正常走一轮 → 画布切换到明细 → 面包屑 +1
- 原因：下钻结果进对话历史，用户可继续追问"这12条里哪个批次最严重"，Agent 有完整上下文。弹窗会断上下文
- 面包屑：`全部工序 › 工序3 › 批次B0912`，可点任意层回退

**决策3：上下文条必须可视化且可编辑**
- 多轮对话最大困惑源：用户以为 AI 记得、AI 其实丢了；或用户想换条件、AI 还用旧的
- 每个 chip 可单独删除 → 删完自动重跑；点 chip 可改值
- Agent 每轮返回时必须回传它实际用的上下文，前端据此刷新此条
- 「新分析」清空上下文栈

## 六、多轮对话状态机（追问分类）

追问不该每次全量重跑。Agent 先判断追问类型：

| 追问类型 | 用户说法 | 画布行为 | 是否重查 |
|---|---|---|---|
| 下钻 | "工序3明细" / 点数据点 | 进下一层,面包屑+1 | 查明细 |
| 换维度 | "按车间看" | 原地换图,指标卡不变 | 重查(换 group by) |
| 换图型 | "画成饼图" | 纯前端切换 | ❌ 不查 |
| 加条件 | "只看A产线" | 上下文条+1 chip,重跑 | 重查 |
| 对比 | "对比上周" | 图上叠加第二序列 | 查对比期 |
| 解释 | "为什么工序3低" | 画布不动,只出AI文字 | ❌ 不查 |
| 导出 | "导出Excel" | 画布不动 | ❌ 用已有数据 |

**"换图型"和"解释"不重查数据库**——占比最高，省大量无效 SQL、响应更快。需在 Agent system prompt 明确分类，前端缓存当轮原始数据集。

## 七、加载态

分步骤反馈（复用现有 `AgentTracePanel` 工具轨迹）：
```
🤖 正在分析...
   ✓ 理解意图:按工序统计完工量
   ✓ 查询数据(1,204 行)
   ⋯ 生成图表
```
图表区用骨架屏，避免布局跳动。

## 八、与现有 AI 对话的分工

| | AI 对话(保留) | 智能报表(新增) |
|---|---|---|
| 定位 | 操作说明 + 业务动作(报工、领料) | 数据探索 |
| 主体 | 文字 | 图表画布 |
| 布局 | 单栏聊天流 | 双区(画布+对话) |
| 图表 | 偶尔配图 | 核心 |
| 下钻 | 无 | 核心 |
| 入口 | 底部 Tab「AI」 | 菜单 route_key = smart-report |

## 九、可配置性设计

新增表 `report_agent_domains`（数据域 = 一个分析主题）：
- 名称 / 描述（告诉 Agent 能回答什么）
- Schema 自然语言说明（不暴露真实表名）
- SQL 模板集（Agent 只能在模式内组合，建议：模板 + 参数注入，不让 Agent 拼 SQL 结构）
- 维度字段（可 group by：工序、产品、日期、车间…）
- 度量字段（可汇总：数量、良品率、工时…）
- 图表偏好（默认推荐图型）
- 明细 SQL（下钻用）
- 角色权限（哪些角色可用该域）

安全边界：与现有 `run_sql` 一致，仅 SELECT；主后端 `/ai/agent/internal/run-sql` 已强制只读。

## 十、需要新增/改动

| 文件 | 改动 |
|---|---|
| `frontend/src/views/SmartReportView.tsx` | 新增，双区布局主视图 |
| `frontend/src/components/AnalysisCanvas.tsx` | 新增，画布(指标卡+图表+表格+面包屑) |
| `frontend/src/components/ContextChips.tsx` | 新增，上下文条 |
| `frontend/src/components/ChartRenderer.tsx` | 改：加 onDataPointClick，ECharts chart.on('click') |
| `ai-agent/app/tools.py` | 改：generate_chart 增加 drillable 维度字段声明 |
| Agent system prompt | 新增智能报表专用 prompt（含追问分类规则） |
| 后端 | 新增 `/ai/smart-report/chat`，返回结构化 canvas 而非纯 Markdown |
| 数据库 | 新增 `report_agent_domains` 表 + 迁移脚本 + 后台配置页 |

**关键接口变化**：智能报表 Agent 响应返回结构化 canvas，非纯文字：

```json
{
  "context": { "chips": [], "breadcrumb": [] },
  "canvas": {
    "metrics": [{ "label": "完工", "value": 342, "delta": "+8.3%" }],
    "charts": [{ "title": "...", "option": {}, "drillDim": "StepCode" }],
    "table": { "columns": [], "rows": [] }
  },
  "narrative": "工序3产量偏低...",
  "suggestions": ["查看工序3明细", "对比昨天"],
  "intent": "drill|dimension|chart_type|filter|compare|explain"
}
```

## 十一、方案精髓（一句话）

1. 画布不堆积（缩略卡回看）
2. 点图 = 发起对话（上下文不断）
3. 上下文可视化可编辑

## 十二、待定 / 下一步

- [ ] Agent 运行位置：建议复用 Python `ai-agent` 容器，新增 smart-report skill
- [ ] 图表库：已确认用 ECharts（项目已集成）
- [ ] SQL 安全边界：建议模板 + 参数注入（Agent 不拼 SQL 结构）
- [ ] 入口：菜单系统新 route_key = smart-report
- [ ] 未决：先做 SmartReportView 静态原型（假数据可点）验证交互？还是先定后端 canvas 协议？

## 十三、相关现有文件（新会话可直接读）

- `server/src/agent-chat-core.js` — 多轮对话核心
- `server/src/ai-conversations.js` — 会话历史落库
- `server/src/agent-skills.js` — skill 注入
- `ai-agent/app/agent.py` — LangGraph Agent
- `ai-agent/app/tools.py` — 白名单工具（含 generate_chart）
- `frontend/src/views/AiChatView.tsx` — 现有对话视图
- `frontend/src/components/ChartRenderer.tsx` — ECharts 渲染
- `frontend/src/components/AgentTracePanel.tsx` — 工具轨迹面板
- `docs/ai-chat-implementation.md` — 现有 AI 对话实现文档
