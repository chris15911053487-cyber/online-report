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
