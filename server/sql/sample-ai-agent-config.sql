-- ============================================================================
-- AI Agent 示例业务配置（按本库真实 SAP B1 表：OCRD 客户、ORDR 销售订单）。
-- 幂等：可重复执行。非自动运行，按需在 SSMS 或 sqlcmd 手动执行。
--   1) sales-amount  报表（客户销售订单额 + 客户消歧 optionsSql）
--   2) X_ONLINE_AI_NOTE  AI 备注表（安全写入目标，不碰 SAP 基础表）
--   3) ai-note  写入目标登记
-- 注意：需先执行过 migrate-nav-menu-items-only.sql / migrate-ai-agent.sql。
-- ============================================================================

-------------------------------------------------------------------------------
-- 1) sales-amount 报表菜单（只读；客户字段带 optionsSql 供消歧）
-------------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.nav_menu_items WHERE route_key = N'sales-amount')
BEGIN
  INSERT INTO dbo.nav_menu_items
    (label, route_key, icon, sort_order, enabled, roles_json, menu_kind, query_template, filter_schema_json)
  VALUES (
    N'客户销售订单额', N'sales-amount', N'💰', 60, 1,
    N'["admin"]',                      -- 仅管理员/可加 finance；生产角色看不到 → "生产不看销售额"
    N'report',
    N'SELECT T1.CardCode AS 客户编码, T1.CardName AS 客户名称, YEAR(T0.DocDate) AS 年度,
             SUM(T0.DocTotal) AS 销售订单额, COUNT(1) AS 订单数
      FROM ORDR T0
      JOIN OCRD T1 ON T0.CardCode = T1.CardCode
      WHERE T1.CardCode = @customer AND YEAR(T0.DocDate) = @year
      GROUP BY T1.CardCode, T1.CardName, YEAR(T0.DocDate)',
    N'[
        {"name":"customer","label":"客户","type":"string","required":true,
         "optionsSql":"SELECT TOP 200 CardName, CardCode FROM OCRD WHERE CardType=''C'' ORDER BY CardName"},
        {"name":"year","label":"年度","type":"int","required":true}
      ]'
  );
END;

-------------------------------------------------------------------------------
-- 2) X_ONLINE_AI_NOTE：AI 写入专用备注表（中国本地时间）
-------------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.X_ONLINE_AI_NOTE', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.X_ONLINE_AI_NOTE (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    DocEntry INT NULL,                          -- 可选：关联单据号
    NoteText NVARCHAR(500) NOT NULL,            -- 备注内容
    CreatedBy NVARCHAR(64) NULL,                -- 可选：填写人
    CreatedAt DATETIME2(3) NOT NULL
      CONSTRAINT DF_x_ai_note_created DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())  -- 中国本地(UTC+8)；SQL2012 不支持 AT TIME ZONE
      )
  );
END;

-------------------------------------------------------------------------------
-- 3) ai-note 写入目标登记（字段白名单；仅 admin 可写）
-------------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.agent_write_targets', N'U') IS NOT NULL
BEGIN
  MERGE dbo.agent_write_targets AS t
  USING (SELECT N'ai-note' AS name) AS s ON t.name = s.name
  WHEN NOT MATCHED THEN
    INSERT (name, label, target_table, fields_json, roles_json, enabled)
    VALUES (
      N'ai-note', N'AI 备注', N'X_ONLINE_AI_NOTE',
      N'[
          {"name":"NoteText","label":"备注内容","sqlType":"nvarchar","required":true,"maxLen":500},
          {"name":"DocEntry","label":"关联单据号","sqlType":"int","required":false},
          {"name":"CreatedBy","label":"填写人","sqlType":"nvarchar","required":false,"maxLen":64}
        ]',
      N'["admin"]', 1
    );
END;
