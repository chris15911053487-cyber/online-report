IF NOT EXISTS (SELECT 1 FROM dbo.production_orders WHERE order_no = N'PO-2026-001')
  INSERT INTO dbo.production_orders (order_no, product_name, planned_qty, status, remark)
  VALUES (N'PO-2026-001', N'零件A总成', 1000, N'in_progress', N'试产');

IF NOT EXISTS (SELECT 1 FROM dbo.production_orders WHERE order_no = N'PO-2026-002')
  INSERT INTO dbo.production_orders (order_no, product_name, planned_qty, status, remark)
  VALUES (N'PO-2026-002', N'零件B外壳', 500, N'open', N'');

IF OBJECT_ID(N'dbo.nav_menu_items', N'U') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dbo.nav_menu_items)
BEGIN
  INSERT INTO dbo.nav_menu_items (label, route_key, icon, sort_order, enabled, roles_json)
  VALUES
    (N'生产订单', N'orders', N'📋', 10, 1, N'["admin","operator"]'),
    (N'菜单设置', N'menu-settings', N'⚙', 20, 1, N'["admin"]');
END;

/* 生产报工登记：可配置报表列表 + 多选合并报工（若已存在同 route_key 则跳过） */
IF OBJECT_ID(N'dbo.nav_menu_items', N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.nav_menu_items', N'menu_kind') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dbo.nav_menu_items WHERE route_key = N'pro-sign')
BEGIN
  DECLARE @proSignSql NVARCHAR(MAX) = N'SELECT po.id AS orderId, po.order_no AS orderNo, po.product_name AS productName, po.planned_qty AS plannedQty, po.reported_qty AS reportedQty, po.status AS orderStatus, oo.id AS operationId, oo.seq_no AS seqNo, oo.operation_name AS operationName FROM dbo.production_orders po INNER JOIN dbo.order_operations oo ON oo.order_id = po.id WHERE (@orderNo IS NULL OR LTRIM(RTRIM(ISNULL(@orderNo, N''''))) = N'''' OR po.order_no LIKE N''%'' + @orderNo + N''%'') ORDER BY po.id DESC, oo.seq_no';
  INSERT INTO dbo.nav_menu_items (
    label, route_key, icon, sort_order, enabled, roles_json,
    menu_kind, query_template, filter_schema_json,
    detail_query_template, detail_key_column, detail_key_param, detail_key_type,
    ai_prompt
  )
  VALUES (
    N'生产报工登记', N'pro-sign', N'✍', 12, 1, N'["admin","operator"]',
    N'report',
    @proSignSql,
    N'[{"name":"orderNo","label":"订单号","type":"string","required":false,"maxLength":64,"scan":true}]',
    NULL, NULL, NULL, N'string',
    N'你是专业的生产制造报工系统分析师。

请基于「生产报工」列表数据（包含订单号、工序、计划数量、已报数量、状态等）进行深入业务分析。

重点关注：
- 整体完工进度与计划偏差
- 各工序瓶颈与效率（哪些工序积压最多？哪些工人/工序最快？）
- 良品率、不良率趋势
- 关键订单风险（超期、未开工）
- 工人/工序产能分布

请提供：
1. 一句话业务概览
2. 3-5个带具体数据的关键洞察
3. 可执行的行动建议（优先级排序，如「优先处理工序X的积压」）
4. 潜在风险点

使用 {report_label}、{filters}、{metrics}、{context} 占位符。输出必须是合法JSON。'
  );
END;

-- 如果记录已存在但 ai_prompt 为空，则更新默认 Prompt（支持升级场景）
IF EXISTS (SELECT 1 FROM dbo.nav_menu_items WHERE route_key = N'pro-sign' AND (ai_prompt IS NULL OR ai_prompt = ''))
BEGIN
  UPDATE dbo.nav_menu_items
  SET ai_prompt = N'你是专业的生产制造报工系统分析师。

请基于「生产报工」列表数据（包含订单号、工序、计划数量、已报数量、状态等）进行深入业务分析。

重点关注：
- 整体完工进度与计划偏差
- 各工序瓶颈与效率（哪些工序积压最多？哪些工人/工序最快？）
- 良品率、不良率趋势
- 关键订单风险（超期、未开工）
- 工人/工序产能分布

请提供：
1. 一句话业务概览
2. 3-5个带具体数据的关键洞察
3. 可执行的行动建议（优先级排序，如「优先处理工序X的积压」）
4. 潜在风险点

使用 {report_label}、{filters}、{metrics}、{context} 占位符。输出必须是合法JSON。'
  WHERE route_key = N'pro-sign';
  PRINT 'Updated default AI prompt for pro-sign menu';
END;
