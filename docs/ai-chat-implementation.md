# AI 对话功能 — 实现说明

## 概述

系统底部 Tab「AI」提供智能对话能力，用户可以通过自然语言与 AI 交互来查询业务数据、获取操作说明、生成文档、保存记录等。

整体分为两层：
- **完整 Agent 模式**：由独立 Python 容器 `ai-agent/` 提供，具备 SQL 查询、写入、文档生成等能力
- **降级知识问答**：Agent 不可用时自动切换为本地知识库问答（仅回答操作说明，不查数据库）

---

## 架构总览

```
┌──────────────┐         ┌─────────────────────┐        ┌───────────────────┐
│   前端       │  JWT    │   主后端 (Fastify)    │ scoped │  ai-agent 容器     │
│ AiChatView   │ ──────→ │ /ai/agent/chat       │ token  │  (Python/FastAPI)  │
│              │         │                     │ ──────→ │  LangGraph Agent   │
│              │ ←────── │                     │ ←────── │                    │
│              │  JSON   │  会话持久化 (SQL)     │        │  LLM + Tools       │
└──────────────┘         └──────────┬──────────┘        └────────┬───────────┘
                                    │                            │
                                    │  internal 回调端点          │
                                    │ ◀──────────────────────────┘
                                    │  (带 scoped token)
                                    ▼
                            ┌───────────────┐
                            │  SQL Server   │
                            │  (业务数据库)   │
                            └───────────────┘
```

**关键设计原则**：
1. 前端只调主后端，不直连 ai-agent 容器（JWT 在主后端统一校验，CORS 复用）
2. ai-agent 容器**无数据库凭据**，需要数据时回调主后端 internal 接口
3. 主后端签发短期 scoped token 给 ai-agent，ai-agent 凭此 token 回调时还原用户角色
4. 权限门禁在主后端执行（角色 + 菜单 + Skill + 表白名单多层校验）

---

## 实现的功能

### 1. 多轮对话 + 会话管理
- 支持创建新对话、切换历史对话、删除对话
- 会话历史持久化到 SQL Server（`ai_conversations` + `ai_messages` 表）
- 每个会话按用户隔离，不可访问他人对话
- 最多回溯 24 条历史消息作为上下文

### 2. Skill 驱动的数据查询
- 管理员配置 Skill（描述 + 工作流 + SQL 模式 + 表白名单）
- Agent 根据用户问题匹配合适的 Skill，在其约束下执行 SQL
- 只允许 SELECT 查询，禁止写操作
- 表白名单强制校验：只能查 Skill 声明的表

### 3. 人机交互（消歧/确认）
- **选择消歧**：当有多个匹配结果时（如"客户A"对应多个编码），Agent 暂停并出示选项，用户选择后继续
- **保存确认**：写入数据前出示预览，用户确认后才真正执行
- 基于 LangGraph 的 `interrupt/resume` 机制实现

### 4. 受控数据写入
- 写入目标须在 `agent_write_targets` 表中白名单配置
- 支持两种类型：`table`（参数化 INSERT）和 `action`（业务动作）
- 所有写入操作记录审计日志

### 5. 文档生成与下载
- 支持导出查询结果为 Excel (.xlsx) 或 CSV 文件
- 生成的文件通过鉴权下载链接交给用户
- 需要 `attachment-generator` 角色权限

### 6. 图表生成
- Agent 可调用 `generate_chart` 工具生成 ECharts 配置
- 前端实时渲染交互式图表

### 7. 知识库问答
- 检索 `server/help/*.md` 知识库回答操作说明类问题
- 支持快捷问题建议、参考来源展示

### 8. 快捷导航建议
- AI 回复末尾可附带操作建议按钮（跳转设置、打开菜单、进入报工等）
- 前端渲染为可点击的绿色按钮

### 9. 角色权限控制
- `cost-viewer`：仅此角色可查看成本/进价等敏感字段
- `attachment-generator`：仅此角色可生成文档附件
- Skill 本身也按角色过滤，非授权角色看不到也用不了

### 10. 对话交互功能
- 复制消息、引用回复、重新生成、停止生成
- 消息反馈（有用/没用）
- 清空对话、新建对话
- 斜杠命令 `/` 快速调用 Skill
- Agent 执行过程面板（展示工具调用步骤和结果）

### 11. 优雅降级
- Agent 容器不可达时自动降级为本地知识问答
- 降级模式不查数据库、不编造数据
- 前端显示降级标识（AgentStatusBadge）

### 12. IM 机器人复用
- 钉钉、企业微信、飞书机器人复用同一核心对话逻辑（`agentChatCore`）
- 员工在 IM 中直接与 AI 对话，能力与 Web 端一致

---

## 代码结构

### 前端

| 文件 | 职责 |
|------|------|
| `frontend/src/views/AiChatView.tsx` | AI 对话主界面：消息列表、输入框、Skill 快捷按钮、历史对话 |
| `frontend/src/components/ChatMarkdown.tsx` | Markdown 消息渲染（含代码块复制） |
| `frontend/src/components/AgentTracePanel.tsx` | Agent 工具调用执行过程面板 |
| `frontend/src/components/AgentStatusBadge.tsx` | Agent 连接状态指示灯 |
| `frontend/src/components/ChartRenderer.tsx` | ECharts 图表渲染器 |
| `frontend/src/utils/helpActions.ts` | 快捷导航按钮执行逻辑 |

### 主后端（Fastify / Node.js）

| 文件 | 职责 |
|------|------|
| `server/src/routes/ai-agent.js` | 网关路由：对话转发、会话 CRUD、Skill 列表、**internal 回调端点** |
| `server/src/agent-chat-core.js` | 可复用对话核心（Web + IM 机器人共用） |
| `server/src/ai-conversations.js` | 会话/消息持久化（SQL Server） |
| `server/src/agent-skills.js` | Skill 管理 + 表白名单校验 |
| `server/src/agent-write.js` | 受控写入 + 审计日志 |
| `server/src/agent-documents.js` | 文档存储与下载 |
| `server/src/agent-actions.js` | 业务动作注册与分发 |
| `server/src/ai-scoped-token.js` | scoped token 签发与校验 |
| `server/src/help-knowledge.js` | 知识库加载与检索 |

### AI Agent 容器（Python / FastAPI）

| 文件 | 职责 |
|------|------|
| `ai-agent/app/main.py` | FastAPI 入口，`/chat` 和 `/health` 端点 |
| `ai-agent/app/agent.py` | LangGraph ReAct Agent：system prompt 构建、graph 实例、`run_turn` 执行 |
| `ai-agent/app/tools.py` | 白名单工具定义（run_sql、save_record、generate_document 等） |
| `ai-agent/app/backend_client.py` | 回调主后端 internal 端点的 HTTP 客户端 |
| `ai-agent/app/config.py` | 环境变量配置（LLM provider、model 等） |
| `ai-agent/app/auth.py` | scoped token 校验 |
| `ai-agent/app/agent_rules.md` | 全局约束规则（注入 system prompt） |

---

## 请求流程详解

### 用户发送一条消息

```
1. 前端 POST /ai/agent/chat { conversationId, message }
   ↓ （JWT 鉴权）
2. 主后端：
   a. 校验 conversationId 格式 + 会话归属
   b. 持久化用户消息到 ai_messages
   c. 加载最近 24 条历史消息
   d. 按用户角色加载可用 Skill 清单
   e. 签发 scoped token（含 userCode, displayName, roles, conversationId）
   f. 转发到 ai-agent 容器 POST /chat
   ↓
3. ai-agent 容器：
   a. 校验 scoped token
   b. 构建 system prompt（基础规则 + Skill 描述 + 用户信息）
   c. LangGraph graph.invoke()：LLM 决策 → 工具调用循环
      - LLM 选择工具（如 run_sql）→ 工具执行 → 结果返回 LLM → 继续或结束
      - 遇到 interrupt（消歧/确认）→ 暂停，返回 need_clarification
   d. 收集最终回复 + 工具调用步骤 + 提取 suggested_actions
   e. 返回 { status, message, skillUsed, toolSteps, actions, ... }
   ↓
4. 主后端：
   a. 持久化 assistant 消息（含 skillUsed、toolSteps）
   b. 若无 actions 则用关键词规则兜底生成
   c. 返回完整响应给前端
   ↓
5. 前端：
   a. 渲染 assistant 消息（Markdown）
   b. 渲染图表（如有）
   c. 展示工具执行过程面板（可展开）
   d. 展示快捷操作按钮（如有）
   e. 若 status=need_clarification，展示选项/确认 UI
```

### 用户做出选择（resume）

```
前端 POST /ai/agent/chat { conversationId, resume: { field, value } }
  → 主后端转发 → ai-agent invoke(Command(resume=value))
  → LangGraph 从 interrupt 点恢复执行 → 返回最终结果
```

### 工具回调主后端（以 run_sql 为例）

```
ai-agent 调 run_sql 工具
  → tools.py: BackendClient.run_sql(sql, skill_name)
  → POST http://app:3000/ai/agent/internal/run-sql
    headers: { X-Scoped-Token: ... }
    body: { sql, skillName }
  → 主后端：
    a. 校验 scoped token → 还原用户角色
    b. 安全校验：只允许 SELECT / WITH / DECLARE / EXEC
    c. 加载 Skill → 角色门禁 → 表白名单校验
    d. 执行 SQL（30s 超时，最多 200 行）
    e. 返回 { columns, rows, totalRowCount }
```

---

## 安全机制

| 层级 | 机制 | 说明 |
|------|------|------|
| 第 1 层 | JWT 鉴权 | 前端所有请求必须带有效 JWT |
| 第 2 层 | Skill 角色过滤 | 只向 Agent 注入用户有权的 Skill |
| 第 3 层 | Scoped Token | 短期令牌，绑定会话+角色，防伪造 |
| 第 4 层 | SQL 类型检查 | 只允许 SELECT/WITH/DECLARE/EXEC，禁止 DML/DDL |
| 第 5 层 | 表白名单 | Skill 配置的 allowedTables 强制校验 |
| 第 6 层 | 写入白名单 | agent_write_targets 表控制可写目标与字段 |
| 第 7 层 | 角色约束 | cost-viewer/attachment-generator 等内置权限 |
| 第 8 层 | 审计日志 | 所有写入操作记录到 ai_action_logs |

---

## 如何使用（面向用户）

### 基本对话

1. 点击底部「AI」Tab 进入对话界面
2. 输入问题（如"查一下本月生产完工数量"）或点击快捷 Skill 按钮
3. AI 会调用数据库查询并返回结果
4. 如果 AI 需要确认（如有多个同名客户），会出示选项让你选择

### 斜杠命令

在输入框输入 `/` 可快速搜索并调用已配置的 Skill。

### 历史对话

- 点击左上角「☰ 历史对话」查看和切换历史会话
- 点击「+ 新对话」开始全新对话
- 点击「清空」清除当前对话内容

### 操作说明

可以直接问操作类问题，如：
- "如何修改密码？"
- "生产报工怎么接单？"
- "怎么暂停报工？"

### 注意事项

- AI 只能查询你有权限访问的数据
- 成本/进价信息需要 `cost-viewer` 角色
- 生成 Excel/文档需要 `attachment-generator` 角色
- Agent 不可用时会降级为知识问答（界面有状态提示）

---

## 如何配置（面向管理员）

### 1. 环境变量

```bash
# ai-agent 容器地址
AI_AGENT_URL=http://ai-agent:8080
AI_AGENT_ENABLED=true
AI_AGENT_TIMEOUT_MS=90000

# LLM 配置
AI_PROVIDER=deepseek          # openai / deepseek / grok
AI_DEFAULT_MODEL=deepseek-chat
OPENAI_API_KEY=sk-xxx
DEEPSEEK_API_KEY=sk-xxx

# Scoped Token 密钥（主后端与 ai-agent 须一致）
AI_SCOPED_SECRET=your-secret  # 或复用 JWT_SECRET
```

### 2. 配置 Skill

在前台「AI Skill 管理」中：
- 名称：skill 标识（英文小写 + 连字符）
- 描述：让 AI 和用户都能理解该 Skill 做什么
- 工作流 (body_md)：详细说明 SQL 模式、示例查询、字段含义
- 表白名单：限定该 Skill 可查询的表
- 可见角色：哪些角色可以使用
- 资源文件：附带的参考文档（Skill 包上传）

### 3. 配置写入目标

在前台「AI 写入目标」中：
- 实体名称：AI 保存时的标识
- 类型：`table`（直接 INSERT）或 `action`（业务动作）
- 字段白名单（table 类型）：限定可写入的列

### 4. 知识库维护

编辑 `server/help/*.md` 文件：
- 用 `<!-- tags: 关键词1, 关键词2 -->` 标记检索关键词
- 修改后重启 Node 服务生效

---

## 技术栈

| 组件 | 技术 |
|------|------|
| Agent 框架 | LangGraph (create_react_agent) |
| LLM | OpenAI / DeepSeek / Grok（通过 langchain_openai.ChatOpenAI） |
| 工具调用 | LangChain @tool 装饰器 |
| 状态持久化 | SqliteSaver（Agent checkpoint）+ SQL Server（会话历史） |
| 中断/恢复 | LangGraph interrupt() + Command(resume=...) |
| 后端框架 | Fastify (Node.js) + FastAPI (Python) |
| 前端 | React 19 + TypeScript |

---

## 部署

ai-agent 作为独立容器部署，通过 Docker Compose 与主服务联网：

```yaml
# docker-compose.deploy.yml 中 ai-agent 服务
ai-agent:
  build: ./ai-agent
  environment:
    - AI_BACKEND_URL=http://app:3000
    - AI_SCOPED_SECRET=${JWT_SECRET}
    - AI_PROVIDER=deepseek
    - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
  volumes:
    - ai-checkpoints:/data
```

主后端通过 `AI_AGENT_URL` 连接 ai-agent 容器。两者共享同一 `AI_SCOPED_SECRET`（或 `JWT_SECRET`）以校验 scoped token。
