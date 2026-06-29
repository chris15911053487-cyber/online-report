-- 定时 AI 报告推送（scheduled_reports + 执行日志）

IF OBJECT_ID(N'dbo.scheduled_reports', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.scheduled_reports (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(128) NOT NULL,
    cron_expr VARCHAR(64) NOT NULL,
    skill_name NVARCHAR(64) NULL,
    prompt_template NVARCHAR(MAX) NOT NULL,
    target_roles_json NVARCHAR(512) NULL,
    target_users_json NVARCHAR(512) NULL,
    channels_json NVARCHAR(128) NOT NULL DEFAULT '["dingtalk"]',
    enabled BIT NOT NULL DEFAULT 1,
    created_by NVARCHAR(64) NULL,
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_scheduled_reports_created DEFAULT (DATEADD(HOUR,8,SYSUTCDATETIME())),
    updated_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_scheduled_reports_updated DEFAULT (DATEADD(HOUR,8,SYSUTCDATETIME()))
  );
END;

IF OBJECT_ID(N'dbo.scheduled_report_logs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.scheduled_report_logs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    report_id INT NOT NULL,
    started_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_srl_started DEFAULT (DATEADD(HOUR,8,SYSUTCDATETIME())),
    finished_at DATETIME2(3) NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'running',
    target_count INT NOT NULL DEFAULT 0,
    sent_count INT NOT NULL DEFAULT 0,
    error_message NVARCHAR(1000) NULL,
    ai_response NVARCHAR(MAX) NULL
  );
  CREATE INDEX idx_srl_report ON dbo.scheduled_report_logs (report_id, started_at DESC);
END;
