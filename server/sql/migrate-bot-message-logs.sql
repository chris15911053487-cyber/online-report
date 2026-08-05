/* 钉钉机器人消息日志表：记录消息收发全流程，便于排查和监控 */
IF OBJECT_ID(N'dbo.bot_message_logs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.bot_message_logs (
    id BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_bot_message_logs PRIMARY KEY,
    platform NVARCHAR(20) NOT NULL CONSTRAINT DF_bml_platform DEFAULT ('dingtalk'),
    message_id NVARCHAR(128) NULL,
    sender_staff_id NVARCHAR(128) NULL,
    user_code NVARCHAR(64) NULL,
    content NVARCHAR(2000) NULL,
    reply_method NVARCHAR(20) NULL,       -- webhook / direct
    reply_status NVARCHAR(20) NULL,       -- success / failed / fallback
    reply_len INT NULL,
    elapsed_ms INT NULL,
    error_msg NVARCHAR(1000) NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_bml_created DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME()))
  );
  CREATE INDEX idx_bml_created ON dbo.bot_message_logs (created_at);
  CREATE INDEX idx_bml_user ON dbo.bot_message_logs (user_code);
  CREATE INDEX idx_bml_sender ON dbo.bot_message_logs (sender_staff_id);
END;
