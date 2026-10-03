-- AI 原生 BI 看板：查询库 bi_queries + 看板 bi_dashboards + agents.dashboard_key
-- 三处分开维护：
--   查询库：SQL + 参数 + 口径 + 可下钻维度 + 缓存 + 可见角色（卡片、下钻、Agent 追问共用，保证口径一致）
--   看板：全局筛选 + 卡片（卡片只引用 query_key，不含 SQL）
--   Agent：dashboard_key 关联一个看板，进入 Agent 即显示

IF OBJECT_ID(N'dbo.bi_queries', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.bi_queries (
    id INT IDENTITY(1,1) PRIMARY KEY,
    -- 唯一标识（小写字母开头，仅小写字母/数字/下划线/连字符）
    query_key NVARCHAR(64) NOT NULL,
    label NVARCHAR(128) NOT NULL,
    -- 给人和 AI 看的说明：这条查询回答什么问题
    description NVARCHAR(1024) NULL,
    -- 只读 SELECT / WITH，参数用 @name 绑定
    sql_text NVARCHAR(MAX) NOT NULL,
    -- 参数定义 [{ "name": "period", "type": "string|number|date|bool", "label": "期间", "required": true, "default": null }]
    params_json NVARCHAR(MAX) NULL,
    -- 结果中可作为维度（下钻/筛选）的列 [{ "column": "CardCode", "label": "客户" }]
    dimensions_json NVARCHAR(MAX) NULL,
    -- 口径说明（如「按过账日期，含未清贷项」），卡片与 AI 回答引用
    caliber_note NVARCHAR(1024) NULL,
    -- 结果缓存秒数；0 = 不缓存
    cache_secs INT NOT NULL DEFAULT 300,
    -- 可见角色 JSON 数组；空 = 仅管理员
    roles_json NVARCHAR(MAX) NULL,
    enabled BIT NOT NULL DEFAULT 1,
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_bi_queries_created DEFAULT (DATEADD(HOUR,8,SYSUTCDATETIME())),
    updated_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_bi_queries_updated DEFAULT (DATEADD(HOUR,8,SYSUTCDATETIME()))
  );
  CREATE UNIQUE INDEX ux_bi_queries_key ON dbo.bi_queries (query_key);
END;

IF OBJECT_ID(N'dbo.bi_dashboards', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.bi_dashboards (
    id INT IDENTITY(1,1) PRIMARY KEY,
    dashboard_key NVARCHAR(64) NOT NULL,
    label NVARCHAR(128) NOT NULL,
    description NVARCHAR(1024) NULL,
    -- 全局筛选 [{ "name": "period", "label": "期间", "type": "month", "default": "$thisMonth" }]
    filters_json NVARCHAR(MAX) NULL,
    -- 卡片 [{ "id", "type": "kpi|bar|line|pie|table", "title", "queryKey", "params", "encoding", "drill", "layout" }]
    cards_json NVARCHAR(MAX) NULL,
    enabled BIT NOT NULL DEFAULT 1,
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_bi_dashboards_created DEFAULT (DATEADD(HOUR,8,SYSUTCDATETIME())),
    updated_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_bi_dashboards_updated DEFAULT (DATEADD(HOUR,8,SYSUTCDATETIME()))
  );
  CREATE UNIQUE INDEX ux_bi_dashboards_key ON dbo.bi_dashboards (dashboard_key);
END;

-- Agent 关联看板（一个 Agent 最多一个看板；NULL = 不关联，保持原有行为）
IF OBJECT_ID(N'dbo.agents', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.agents', N'dashboard_key') IS NULL
BEGIN
  ALTER TABLE dbo.agents ADD dashboard_key NVARCHAR(64) NULL;
END;
