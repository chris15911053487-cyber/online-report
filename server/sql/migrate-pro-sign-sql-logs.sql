/* 生产报工提交 SQL 日志表：用于审计提交接口所执行的关键 SQL 模板与参数摘要 */
IF OBJECT_ID(N'dbo.pro_sign_sql_logs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.pro_sign_sql_logs (
    id BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_pro_sign_sql_logs PRIMARY KEY,
    batch_id BIGINT NULL,
    user_code NVARCHAR(64) NULL,
    endpoint NVARCHAR(128) NULL,
    sql_text NVARCHAR(4000) NULL,
    params_json NVARCHAR(4000) NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_pro_sign_sql_logs_created DEFAULT (CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'China Standard Time' AS DATETIME2(3)))
  );
  CREATE INDEX idx_pssl_created ON dbo.pro_sign_sql_logs (created_at);
  CREATE INDEX idx_pssl_batch ON dbo.pro_sign_sql_logs (batch_id);
END;
