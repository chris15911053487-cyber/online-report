-- 为 nav_menu_items 添加 mobile_card_json 字段：报表在手机上按卡片显示的布局（不配则照旧显示表格）
--
-- 字段格式（JSON 对象，每个位置是一组候选列名，按顺序取本次结果里第一个存在的列）：
-- {
--   "title":    ["DocEntry", "工序"],
--   "titleNote": ["工序"],
--   "badge":    ["动作", "类型"],
--   "subtitle": ["物料名称"],
--   "subNote":  ["物料编码"],
--   "metric":   ["接单数量", "计划数量"],
--   "meta":     [["接单人员", "接单人"], ["接单时间"]],
--   "progress": { "done": ["完工数量"], "total": ["接单数量"] },
--   "hidden":   ["StepCode", "BaseOType"]
-- }

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'dbo.nav_menu_items')
    AND name = 'mobile_card_json'
)
BEGIN
  ALTER TABLE dbo.nav_menu_items
  ADD mobile_card_json NVARCHAR(MAX) NULL;
END
