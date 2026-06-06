-- AI Agent 模块所需表：
--   agent_skills      — Skill 注册（纯指令型，按角色门禁，可标记产出文档）
--   ai_conversations  — 用户会话（用于历史列表 / 续聊）
--   ai_messages       — 会话消息 + 工具调用审计
-- 与 OUSR / nav_menu_items 同库；时间列统一用中国本地墙钟（见 china-datetime.js）。

-------------------------------------------------------------------------------
-- 1) agent_skills：Skill 注册表
-------------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.agent_skills', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.agent_skills (
    name NVARCHAR(64) NOT NULL PRIMARY KEY,        -- 小写连字符，唯一标识
    description NVARCHAR(1024) NOT NULL,           -- 注入 system prompt，决定何时触发
    body_md NVARCHAR(MAX) NOT NULL,                -- SKILL.md 正文（工作流/规范/模板，不含可执行脚本）
    resources_json NVARCHAR(MAX) NOT NULL          -- 引用资源（reference/examples）键值
      CONSTRAINT DF_agent_skills_res DEFAULT (N'{}'),
    roles_json NVARCHAR(MAX) NOT NULL              -- 允许使用此 skill 的角色（与 nav_menu_items 一致）
      CONSTRAINT DF_agent_skills_roles DEFAULT (N'[]'),
    produces_document BIT NOT NULL                 -- 是否会产出文档
      CONSTRAINT DF_agent_skills_doc DEFAULT (0),
    enabled BIT NOT NULL
      CONSTRAINT DF_agent_skills_enabled DEFAULT (1),
    sort_order INT NOT NULL
      CONSTRAINT DF_agent_skills_sort DEFAULT (100),
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_agent_skills_created DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())  -- 中国本地(UTC+8)；SQL2012 不支持 AT TIME ZONE
      ),
    updated_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_agent_skills_updated DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())  -- 中国本地(UTC+8)；SQL2012 不支持 AT TIME ZONE
      )
  );
  CREATE INDEX idx_agent_skills_enabled ON dbo.agent_skills (enabled, sort_order, name);
END;

-------------------------------------------------------------------------------
-- 2) ai_conversations：会话
-------------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.ai_conversations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ai_conversations (
    id NVARCHAR(64) NOT NULL PRIMARY KEY,          -- 前端生成的 conversationId（uuid）
    user_code NVARCHAR(64) NOT NULL,               -- 归属用户（OUSR.USER_CODE）
    title NVARCHAR(200) NOT NULL
      CONSTRAINT DF_ai_conv_title DEFAULT (N'新对话'),
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_ai_conv_created DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())  -- 中国本地(UTC+8)；SQL2012 不支持 AT TIME ZONE
      ),
    updated_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_ai_conv_updated DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())  -- 中国本地(UTC+8)；SQL2012 不支持 AT TIME ZONE
      )
  );
  CREATE INDEX idx_ai_conv_user ON dbo.ai_conversations (user_code, updated_at DESC);
END;

-------------------------------------------------------------------------------
-- 3) ai_messages：消息 + 工具调用审计
-------------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.ai_messages', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ai_messages (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    conversation_id NVARCHAR(64) NOT NULL,
    role NVARCHAR(16) NOT NULL,                    -- 'user' | 'assistant'
    content NVARCHAR(MAX) NOT NULL,
    skill_used NVARCHAR(64) NULL,                  -- 本轮命中的 skill（如有）
    tool_calls_json NVARCHAR(MAX) NULL,            -- 本轮工具调用审计（名称/参数摘要）
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_ai_msg_created DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())  -- 中国本地(UTC+8)；SQL2012 不支持 AT TIME ZONE
      )
  );
  CREATE INDEX idx_ai_msg_conv ON dbo.ai_messages (conversation_id, id);
END;

-------------------------------------------------------------------------------
-- 4) agent_write_targets：白名单写入目标（二期"单保存"）
--    LLM 不拼 SQL，只产出结构化 payload；后端按本表的字段白名单参数化 INSERT。
-------------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.agent_write_targets', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.agent_write_targets (
    name NVARCHAR(64) NOT NULL PRIMARY KEY,        -- 实体名（小写连字符）
    label NVARCHAR(128) NOT NULL,
    target_table NVARCHAR(128) NOT NULL,           -- 目标表名（仅允许标识符，自动加 [] 包裹）
    fields_json NVARCHAR(MAX) NOT NULL             -- 字段白名单：[{name,label,sqlType,required,maxLen}]
      CONSTRAINT DF_awt_fields DEFAULT (N'[]'),
    roles_json NVARCHAR(MAX) NOT NULL              -- 允许写入的角色
      CONSTRAINT DF_awt_roles DEFAULT (N'["admin"]'),
    enabled BIT NOT NULL
      CONSTRAINT DF_awt_enabled DEFAULT (1),
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_awt_created DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())  -- 中国本地(UTC+8)；SQL2012 不支持 AT TIME ZONE
      ),
    updated_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_awt_updated DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())  -- 中国本地(UTC+8)；SQL2012 不支持 AT TIME ZONE
      )
  );
END;

-------------------------------------------------------------------------------
-- 5) ai_action_logs：写入审计（谁、什么实体、payload、时间）
-------------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.ai_action_logs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ai_action_logs (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    user_code NVARCHAR(64) NOT NULL,
    conversation_id NVARCHAR(64) NULL,
    action NVARCHAR(32) NOT NULL,                  -- 'save_record' 等
    entity NVARCHAR(64) NULL,
    payload_json NVARCHAR(MAX) NULL,
    result NVARCHAR(16) NOT NULL,                  -- 'ok' | 'error'
    detail NVARCHAR(1024) NULL,
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_ai_act_created DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())  -- 中国本地(UTC+8)；SQL2012 不支持 AT TIME ZONE
      )
  );
  CREATE INDEX idx_ai_act_user ON dbo.ai_action_logs (user_code, id DESC);
END;

-------------------------------------------------------------------------------
-- 6) ai_documents：Agent 产出文档的元数据（文件落盘，鉴权下载）
-------------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.ai_documents', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ai_documents (
    id NVARCHAR(64) NOT NULL PRIMARY KEY,
    user_code NVARCHAR(64) NOT NULL,
    conversation_id NVARCHAR(64) NULL,
    filename NVARCHAR(255) NOT NULL,
    mime NVARCHAR(128) NOT NULL,
    ext NVARCHAR(16) NOT NULL,
    byte_size INT NOT NULL CONSTRAINT DF_ai_doc_size DEFAULT (0),
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_ai_doc_created DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())  -- 中国本地(UTC+8)；SQL2012 不支持 AT TIME ZONE
      )
  );
  CREATE INDEX idx_ai_doc_user ON dbo.ai_documents (user_code, created_at DESC);
END;

-------------------------------------------------------------------------------
-- 7) 种子：内置 skill（纯指令型，可后台编辑）
-------------------------------------------------------------------------------
MERGE dbo.agent_skills AS t
USING (
  SELECT
    N'knowledge-qa' AS name,
    N'回答系统使用、报工流程、操作说明等知识类问题。当用户询问"怎么用""如何操作""是什么意思"等使用说明时启用。' AS description,
    N'# 知识问答

## 工作流
1. 调用 knowledge_search(用户问题) 检索系统使用说明。
2. 基于检索到的片段用中文作答，并在末尾注明参考来源标题。
3. 若检索不到相关内容，如实告知，不要编造。' AS body_md,
    N'[]' AS roles_json,
    CAST(0 AS BIT) AS produces_document,
    10 AS sort_order
  UNION ALL SELECT
    N'report-query',
    N'按客户/时间等条件查询销售订单额、产量等报表数据并回答。当用户询问某客户、某时间段的金额、数量、订单等数据时启用。',
    N'# 报表数据查询（销售订单额）

## 工作流
1. 从问题中提取「客户名」和「年度」（未说年度则默认今年）。
2. 涉及客户名时，先调用 lookup_options(route_key="sales-amount", field_name="customer", keyword=客户名) 解析客户编码：
   - 0 条：告知"未找到该客户"，请用户核对名称。
   - 1 条：仍调用 ask_user_to_choose 让用户确认一次（防重名误查）。
   - 多条：调用 ask_user_to_choose 让用户从候选中选择，不要自行猜测。
3. 客户编码确定后，调用 run_report(route_key="sales-amount", params_json="{\"customer\":\"<编码>\",\"year\":<年度>}") 取数。
4. 用中文回答金额，并注明客户编码与年度。

## 注意
- 不要自行拼写 SQL；只能通过 run_report / lookup_options 工具取数。
- 只回答用户有权访问的数据；无权时如实告知。',
    N'["admin"]',
    CAST(0 AS BIT),
    20
  UNION ALL SELECT
    N'save-record',
    N'按用户要求向系统写入一条记录（如新增备注、登记单据）。当用户明确要求"保存""新增""登记""录入"某条数据时启用。',
    N'# 单条记录保存（AI 备注）

## 工作流
1. 与用户确认要写入的内容；当前可写实体 entity="ai-note"，字段：NoteText（备注内容，必填）、DocEntry（关联单据号，可选）。
2. 调用 save_record(entity="ai-note", payload_json="{\"NoteText\":\"...\",\"DocEntry\":123}") 提交。
   该工具会先向用户出示预览并要求确认，用户确认后才真正写库。
3. 写入成功后用中文回复结果；用户取消则不写。

## 注意
- 不要自行拼写 SQL；只能通过 save_record 工具写入后台配置的白名单实体与字段。
- 写入前务必让用户确认（工具已内置确认步骤，不要跳过）。',
    N'["admin"]',
    CAST(0 AS BIT),
    30
  UNION ALL SELECT
    N'doc-export',
    N'把查询到的数据导出为可下载文档（Excel/CSV）。当用户要求"导出""下载""生成报表文件"时启用。',
    N'# 数据导出文档

## 工作流
1. 先用 run_report（如 route_key="sales-amount"）取到用户有权访问的数据，得到 columns 与 rows。
2. 调用 generate_document(title, fmt="xlsx", columns_json, rows_json) 生成文档（fmt 可选 xlsx 或 csv）。
   columns_json 传列名数组，rows_json 传行对象数组（直接用 run_report 返回的 columns / rows）。
3. 把工具返回的下载链接（downloadUrl）以 markdown 链接形式转达给用户。

## 注意
- 只导出用户有权查看的数据；不要包含无权字段。',
    N'["admin"]',
    CAST(1 AS BIT),
    40
) AS s ON t.name = s.name
WHEN NOT MATCHED BY TARGET THEN
  INSERT (name, description, body_md, roles_json, produces_document, sort_order)
  VALUES (s.name, s.description, s.body_md, s.roles_json, s.produces_document, s.sort_order);
