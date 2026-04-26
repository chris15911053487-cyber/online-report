-- 为 nav_menu_items 表添加 AI Prompt 配置字段
-- 允许管理员为每个报表菜单配置专属的自然语言分析指令
-- 支持占位符如 {report_label}、{filters}、{metrics}、{data_summary}

IF NOT EXISTS (
  SELECT 1 FROM sys.columns 
  WHERE object_id = OBJECT_ID(N'dbo.nav_menu_items') 
    AND name = 'ai_prompt'
)
BEGIN
  ALTER TABLE dbo.nav_menu_items 
  ADD ai_prompt NVARCHAR(MAX) NULL;
  
  PRINT 'Added column ai_prompt to nav_menu_items table';
END
ELSE
BEGIN
  PRINT 'Column ai_prompt already exists in nav_menu_items table';
END

-- 为生产报工菜单添加专用默认 Prompt（生产报工列表分析）
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
WHERE route_key = 'pro-sign' AND (ai_prompt IS NULL OR ai_prompt = '');

-- 为其他报表菜单添加通用默认 Prompt（如果需要）
-- UPDATE dbo.nav_menu_items 
-- SET ai_prompt = N'你是生产制造领域的智能分析师。请基于以下报表数据（{report_label}）和当前筛选条件（{filters}）进行分析。

-- 关键统计：
-- {metrics}

-- 数据样本：
-- {data_sample}

-- 请提供：
-- 1. 一句话业务概览
-- 2. 3-5个关键洞察（包含数据支持）
-- 3. 具体可执行的操作建议（优先级排序）
-- 4. 潜在风险或异常点
-- 输出格式为清晰的 Markdown，并标注重要数字。'
-- WHERE menu_kind = 'report' AND route_key != 'pro-sign' AND (ai_prompt IS NULL OR ai_prompt = '');
