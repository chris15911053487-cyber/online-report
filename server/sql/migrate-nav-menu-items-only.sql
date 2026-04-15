/* 若仅缺少 nav_menu_items，可在 SSMS 中对当前库单独执行本文件 */

IF OBJECT_ID(N'dbo.nav_menu_items', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.nav_menu_items (
    id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    label NVARCHAR(128) NOT NULL,
    route_key NVARCHAR(64) NOT NULL,
    icon NVARCHAR(32) NULL,
    sort_order INT NOT NULL CONSTRAINT DF_nav_sort DEFAULT (0),
    enabled BIT NOT NULL CONSTRAINT DF_nav_enabled DEFAULT (1),
    roles_json NVARCHAR(512) NOT NULL CONSTRAINT DF_nav_roles DEFAULT (N'["operator"]'),
    menu_kind NVARCHAR(32) NOT NULL CONSTRAINT DF_nav_menu_kind DEFAULT (N'builtin'),
    query_template NVARCHAR(MAX) NULL,
    filter_schema_json NVARCHAR(MAX) NOT NULL CONSTRAINT DF_nav_filter_schema DEFAULT (N'[]'),
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_nav_created DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_nav_updated DEFAULT (SYSUTCDATETIME())
  );
  CREATE UNIQUE INDEX uk_nav_menu_route ON dbo.nav_menu_items (route_key);
  CREATE INDEX idx_nav_menu_sort ON dbo.nav_menu_items (sort_order, id);
END;

IF OBJECT_ID(N'dbo.nav_menu_items', N'U') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dbo.nav_menu_items)
BEGIN
  INSERT INTO dbo.nav_menu_items (label, route_key, icon, sort_order, enabled, roles_json)
  VALUES
    (N'生产订单', N'orders', N'📋', 10, 1, N'["admin","operator"]'),
    (N'菜单设置', N'menu-settings', N'⚙', 20, 1, N'["admin"]');
END;
