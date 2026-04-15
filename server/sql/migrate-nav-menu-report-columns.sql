/* 为已有 nav_menu_items 增加可配置报表列（新装若已含列则跳过） */

IF OBJECT_ID(N'dbo.nav_menu_items', N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.nav_menu_items', N'menu_kind') IS NULL
BEGIN
  ALTER TABLE dbo.nav_menu_items ADD
    menu_kind NVARCHAR(32) NOT NULL
      CONSTRAINT DF_nav_menu_kind DEFAULT (N'builtin'),
    query_template NVARCHAR(MAX) NULL,
    filter_schema_json NVARCHAR(MAX) NOT NULL
      CONSTRAINT DF_nav_filter_schema DEFAULT (N'[]');
END;
