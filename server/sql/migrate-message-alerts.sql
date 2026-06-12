-- 消息数据提醒：规则配置 + 用户已读记录

IF OBJECT_ID(N'dbo.message_alert_rules', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.message_alert_rules (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    name NVARCHAR(128) NOT NULL,
    sql_template NVARCHAR(MAX) NOT NULL,
    key_column NVARCHAR(128) NOT NULL,
    title_template NVARCHAR(512) NOT NULL,
    roles_json NVARCHAR(MAX) NOT NULL
      CONSTRAINT DF_message_alert_rules_roles DEFAULT (N'[]'),
    refresh_seconds INT NOT NULL
      CONSTRAINT DF_message_alert_rules_refresh DEFAULT (60),
    enabled BIT NOT NULL
      CONSTRAINT DF_message_alert_rules_enabled DEFAULT (1),
    sort_order INT NOT NULL
      CONSTRAINT DF_message_alert_rules_sort DEFAULT (0),
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_message_alert_rules_created DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())
      ),
    updated_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_message_alert_rules_updated DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())
      )
  );
  CREATE INDEX idx_message_alert_rules_sort ON dbo.message_alert_rules (enabled, sort_order, id);
END;

IF OBJECT_ID(N'dbo.message_alert_reads', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.message_alert_reads (
    rule_id INT NOT NULL,
    user_code NVARCHAR(64) NOT NULL,
    item_key NVARCHAR(512) NOT NULL,
    read_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_message_alert_reads_read_at DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())
      ),
    CONSTRAINT PK_message_alert_reads PRIMARY KEY (rule_id, user_code, item_key)
  );
  CREATE INDEX idx_message_alert_reads_user ON dbo.message_alert_reads (user_code, rule_id);
END;
