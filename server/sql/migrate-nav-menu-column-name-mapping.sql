/* 可配置报表：列名映射（SQL 结果列名 -> 前端/逻辑列名，如 order_id -> orderId） */

IF OBJECT_ID(N'dbo.nav_menu_items', N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.nav_menu_items', N'column_name_mapping_json') IS NULL
BEGIN
  ALTER TABLE dbo.nav_menu_items ADD
    column_name_mapping_json NVARCHAR(MAX) NOT NULL
      CONSTRAINT DF_nav_column_name_mapping DEFAULT (N'{}');
END;
