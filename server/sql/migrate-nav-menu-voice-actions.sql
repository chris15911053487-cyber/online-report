-- 为 nav_menu_items 添加 voice_actions_json 字段
-- 用于语音功能方案 B：每个菜单可配置语音动作规则模板，
-- 让语音可以带参数操作菜单页面（如「打开129号订单」自动跳转 + 预填 DocEntry=129 + 自动查询）。
--
-- 字段格式（JSON 数组）：
-- [
--   {
--     "patterns": ["{n}号订单", "订单{n}", "单号{n}"],
--     "fill":     { "DocEntry": "{n}" },
--     "autoQuery": true
--   }
-- ]
--
-- 占位符：
--   {n} - 数字
--   {t} - 任意非空文本
--   {d} - 日期（今天/昨天/yyyy-MM-dd 等，由前端解析）

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'dbo.nav_menu_items')
    AND name = 'voice_actions_json'
)
BEGIN
  ALTER TABLE dbo.nav_menu_items
  ADD voice_actions_json NVARCHAR(MAX) NULL;

  PRINT 'Added column voice_actions_json to nav_menu_items table';
END
ELSE
BEGIN
  PRINT 'Column voice_actions_json already exists in nav_menu_items table';
END
