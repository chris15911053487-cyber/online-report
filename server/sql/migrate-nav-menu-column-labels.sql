/* 可配置报表：列表列英文名 -> 中文表头（JSON 对象），数据行仍为英文键 */

IF OBJECT_ID(N'dbo.nav_menu_items', N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.nav_menu_items', N'column_labels_json') IS NULL
BEGIN
  ALTER TABLE dbo.nav_menu_items ADD
    column_labels_json NVARCHAR(MAX) NOT NULL
      CONSTRAINT DF_nav_column_labels DEFAULT (N'{}');
END;
