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

-- 可选：为现有报表菜单添加默认 Prompt 示例（生产环境建议手动配置）
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
-- WHERE menu_kind = ''report'' AND ai_prompt IS NULL;
