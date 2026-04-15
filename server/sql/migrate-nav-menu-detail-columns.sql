/* 报表行详情：详情 SQL、结果集中主键列名、SQL 参数名与类型 */

IF OBJECT_ID(N'dbo.nav_menu_items', N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.nav_menu_items', N'detail_query_template') IS NULL
BEGIN
  ALTER TABLE dbo.nav_menu_items ADD
    detail_query_template NVARCHAR(MAX) NULL,
    detail_key_column NVARCHAR(256) NULL,
    detail_key_param NVARCHAR(128) NULL,
    detail_key_type NVARCHAR(32) NOT NULL
      CONSTRAINT DF_nav_detail_key_type DEFAULT (N'string');
END;
