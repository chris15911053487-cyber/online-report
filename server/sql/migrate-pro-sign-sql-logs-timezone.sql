/* 将 pro_sign_sql_logs.created_at 默认值从 UTC 改为中国本地时间，与报工界面时间一致 */
IF OBJECT_ID(N'dbo.pro_sign_sql_logs', N'U') IS NOT NULL
BEGIN
  DECLARE @df sysname;
  SELECT @df = dc.name
  FROM sys.default_constraints dc
  INNER JOIN sys.columns c ON c.default_object_id = dc.object_id
  INNER JOIN sys.tables t ON t.object_id = c.object_id
  WHERE t.name = N'pro_sign_sql_logs' AND c.name = N'created_at';

  IF @df IS NOT NULL
    EXEC(N'ALTER TABLE dbo.pro_sign_sql_logs DROP CONSTRAINT [' + @df + N']');

  ALTER TABLE dbo.pro_sign_sql_logs
    ADD CONSTRAINT DF_pro_sign_sql_logs_created
    DEFAULT (CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'China Standard Time' AS DATETIME2(3)))
    FOR created_at;
END;
