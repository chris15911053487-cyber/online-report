-- 可配置 Agent 中心：agents 表
-- 每一行 = 一个可在「Agent」页选择进入的智能体（如销售分析 Agent）。
-- 能力来源 = skills_json 关联的 agent_skills（表白名单/只读 SQL 约束继续由 skill 承担）。

IF OBJECT_ID(N'dbo.agents', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.agents (
    id INT IDENTITY(1,1) PRIMARY KEY,
    -- 唯一标识（小写字母开头，仅小写字母/数字/连字符）
    agent_key NVARCHAR(64) NOT NULL,
    -- 展示信息
    label NVARCHAR(128) NOT NULL,
    subtitle NVARCHAR(256) NULL,
    description NVARCHAR(1024) NULL,
    icon NVARCHAR(64) NULL,
    theme_color NVARCHAR(32) NULL,
    -- 对话配置
    welcome_md NVARCHAR(MAX) NULL,
    -- 布局：canvas = 对话 + 分析画布；chat = 纯聊天
    layout_mode VARCHAR(16) NOT NULL DEFAULT 'canvas',
    -- 关联的 skill 名称数组，如 ["sales-daily-report"]
    skills_json NVARCHAR(MAX) NULL,
    -- 快捷提问 [{ "icon": "📊", "label": "昨日销售日报", "prompt": "..." }]
    quick_prompts_json NVARCHAR(MAX) NULL,
    -- 进入即自动执行的默认分析
    default_prompt NVARCHAR(MAX) NULL,
    default_enabled BIT NOT NULL DEFAULT 0,
    default_cache_secs INT NOT NULL DEFAULT 300,
    -- 该 Agent 专属附加 system prompt（追问分类规则等）
    system_prompt_extra NVARCHAR(MAX) NULL,
    -- 可见角色 JSON 数组；空 = 仅管理员
    roles_json NVARCHAR(MAX) NULL,
    enabled BIT NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 100,
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_agents_created DEFAULT (DATEADD(HOUR,8,SYSUTCDATETIME())),
    updated_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_agents_updated DEFAULT (DATEADD(HOUR,8,SYSUTCDATETIME()))
  );
  CREATE UNIQUE INDEX ux_agents_key ON dbo.agents (agent_key);
  CREATE INDEX idx_agents_enabled ON dbo.agents (enabled, sort_order);
END;

-- 预置「销售分析 Agent」示例配置（仅首次创建；关联 skill 需管理员在后台按实际情况勾选）
IF NOT EXISTS (SELECT 1 FROM dbo.agents WHERE agent_key = N'sales-analysis')
BEGIN
  INSERT INTO dbo.agents
    (agent_key, label, subtitle, description, icon, theme_color,
     welcome_md, layout_mode, skills_json, quick_prompts_json,
     default_prompt, default_enabled, default_cache_secs, roles_json, enabled, sort_order)
  VALUES
    (N'sales-analysis',
     N'销售分析 Agent',
     N'自然语言交互 · 预置报表 · 智能探索',
     N'用一句话查销售情况：日报、区域下滑归因、趋势异常标注。',
     N'TrendingUp',
     N'#4f6ef7',
     N'我是销售分析 Agent。你可以直接问我销售情况，也可以点下方快捷入口。',
     'canvas',
     N'[]',
     N'[{"icon":"📊","label":"昨日销售日报","prompt":"生成昨日销售日报，包含总销售额、订单数、客单价及各区域分布"},{"icon":"🔍","label":"哪个区域在下滑","prompt":"分析最近哪些区域销售额在下滑，按降幅排序并给出可能原因"},{"icon":"📈","label":"近30天销售趋势","prompt":"展示近30天销售额趋势，标注异常波动日期"}]',
     N'生成今日销售日报，包含核心指标与各区域分布',
     0,
     300,
     N'[]',
     1,
     10);
END;
