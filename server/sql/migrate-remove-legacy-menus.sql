/* 移除早期内置菜单：orders（OITM 前 30 条的测试页，库里可能已改名为「系统保留路由」）、
   menu-settings（与「管理后台 → 菜单与角色」重复）。对应页面与接口已删除。可重复执行。 */
IF OBJECT_ID(N'dbo.nav_menu_items', N'U') IS NOT NULL
  DELETE FROM dbo.nav_menu_items
  WHERE route_key IN (N'orders', N'menu-settings')
    AND menu_kind = N'builtin';
