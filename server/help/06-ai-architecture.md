<!-- tags: AI,LLM,大模型,架构,联网,网络,接口,调用,DeepSeek,OpenAI,Grok,Agent,降级,IM,机器人,定时报告,费用,出口,api -->
# AI / LLM 大模型架构说明

本系统在多个环节使用了 LLM（大语言模型），所有 LLM 调用均通过 HTTPS 联网访问外部 API。

## 两个 LLM 出口

系统有 **2 个独立的 LLM 网络出口**，最终连接的都是同一类 API：

| 出口 | 位置 | 技术 | 说明 |
|------|------|------|------|
| 出口①：主后端 | server/src/ai.js | OpenAI SDK (Node.js) | 直接调用 LLM 的 5 个方法 |
| 出口②：AI Agent 容器 | ai-agent/app/agent.py | LangChain ChatOpenAI (Python) | ReAct Agent 工具调用循环 |

两个出口支持相同的 LLM 供应商，由环境变量 `AI_PROVIDER` 决定：
- **OpenAI**：api.openai.com
- **DeepSeek**：api.deepseek.com
- **Grok (xAI)**：api.x.ai

协议均为 HTTPS，端口 443。

## 各场景 LLM 调用说明

### 1. 报表 AI 分析

- **触发方式**：用户在报表页面点击「AI 分析」按钮
- **路由**：`POST /ai/analyze`
- **出口**：出口① 主后端
- **说明**：将报表数据 + Prompt 模板发送给 LLM，返回结构化分析结果

### 2. AI 使用说明助手（底部 AI Tab，降级模式）

- **触发方式**：用户在底部 AI Tab 提问，且 Agent 容器不可达
- **路由**：`POST /ai/chat`
- **出口**：出口① 主后端
- **说明**：基于 help 知识库检索 + LLM 生成回答，仅回答操作说明类问题

### 3. AI Prompt 模板生成器（管理员）

- **触发方式**：管理员在菜单设置中使用「AI 生成 Prompt」
- **路由**：`POST /ai/generate-prompt`
- **出口**：出口① 主后端
- **说明**：根据业务描述自动生成分析 Prompt 模板

### 4. AI Skill 内容生成（管理员）

- **触发方式**：管理员在 Skill 管理中使用「AI 辅助生成」
- **路由**：`POST /ai/generate-skill`
- **出口**：出口① 主后端
- **说明**：根据需求描述自动生成 Skill 的 name、description、工作流正文

### 5. AI 写入目标生成（管理员）

- **触发方式**：管理员配置写入目标时使用「AI 辅助生成」
- **路由**：`POST /ai/generate-write-target`
- **出口**：出口① 主后端
- **说明**：根据需求描述自动生成写入目标的表名和字段配置

### 6. AI Agent 对话（底部 AI Tab，正常模式）

- **触发方式**：用户在底部 AI Tab 正常对话
- **路由**：`POST /ai/agent/chat` → 转发到 ai-agent 容器
- **出口**：出口② AI Agent 容器
- **说明**：LangGraph ReAct Agent 执行工具调用循环（可查数据库、检索知识、生成文档）；**单次请求可能产生 2-5 次 LLM 调用**（推理→工具→再推理→输出）

### 7. 钉钉机器人对话

- **触发方式**：员工在钉钉私聊发消息给机器人
- **路由**：`POST /bot/dingtalk` → agentChatCore → ai-agent
- **出口**：出口② AI Agent 容器
- **说明**：与 Web AI 对话能力完全一致

### 8. 企业微信机器人对话

- **触发方式**：员工在企微私聊发消息给机器人
- **路由**：`POST /bot/wecom` → agentChatCore → ai-agent
- **出口**：出口② AI Agent 容器
- **说明**：与 Web AI 对话能力完全一致

### 9. 飞书机器人对话

- **触发方式**：员工在飞书私聊发消息给机器人
- **路由**：`POST /bot/feishu` → agentChatCore → ai-agent
- **出口**：出口② AI Agent 容器
- **说明**：与 Web AI 对话能力完全一致

### 10. 定时报告推送

- **触发方式**：node-cron 按配置的 cron 表达式自动触发
- **路由**：内部调用 agentChatCore → ai-agent
- **出口**：出口② AI Agent 容器
- **说明**：系统账号执行 Agent 对话生成报告，再通过 IM 推送给目标用户

### 11. 降级知识问答

- **触发方式**：Agent 容器不可达时自动触发
- **出口**：出口① 主后端
- **说明**：仅回答操作说明，不执行 SQL，不编造数据

## 调用频率与费用影响

| 场景 | 频率 | 单次 LLM 调用次数 | 费用影响 |
|------|------|-------------------|----------|
| 报表分析 | 按需（用户点击） | 1 次 | 低 |
| Agent 对话（Web/IM） | 高频 | 2-5 次（ReAct 循环） | **最高** |
| 定时报告 | 按 cron 配置 | 2-5 次 | 中（取决于任务数量） |
| 管理员生成器 | 极低 | 1 次 | 忽略 |
| 降级问答 | 仅故障时 | 1 次 | 低 |

## 网络要求

系统正常运行需要以下出站网络连通：

- 主后端服务器 → LLM API（HTTPS/443）
- AI Agent 容器 → LLM API（HTTPS/443）

如果防火墙限制出站，需放行以下域名（根据 `AI_PROVIDER` 配置选择）：
- `api.openai.com`（OpenAI）
- `api.deepseek.com`（DeepSeek）
- `api.x.ai`（Grok/xAI）

## 降级机制

当 AI Agent 容器不可达（网络故障、容器未启动等）：
1. 系统自动降级为「本地知识问答」模式
2. 使用主后端出口① 调用 LLM
3. 仅能回答系统操作说明，**无法查询数据库、无法生成文档**
4. 会在回复中提示用户当前处于降级模式

## 相关环境变量

| 变量 | 说明 |
|------|------|
| `AI_PROVIDER` | LLM 供应商：openai / deepseek / grok |
| `AI_DEFAULT_MODEL` | 模型名（如 gpt-4o-mini、deepseek-chat） |
| `OPENAI_API_KEY` | OpenAI API Key |
| `DEEPSEEK_API_KEY` | DeepSeek API Key |
| `GROK_API_KEY` | Grok API Key |
| `AI_AGENT_ENABLED` | Agent 容器开关（false 则永久降级） |
| `AI_AGENT_URL` | Agent 容器内网地址（默认 http://ai-agent:8080） |
