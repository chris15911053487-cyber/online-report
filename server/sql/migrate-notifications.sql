-- 消息收件箱：警报、定时报告等主动推送的内容，按接收人各存一份已读状态
-- 「消息」菜单的「通知」页签读这里；钉钉等 IM 推送结果也记在接收人行上

IF OBJECT_ID(N'dbo.notifications', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.notifications (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    source_type VARCHAR(16) NOT NULL,           -- 'alert' 警报 | 'report' 定时报告 / 看板要点
    source_id INT NULL,                         -- alert_rules.id / scheduled_reports.id
    source_name NVARCHAR(128) NULL,             -- 规则 / 报告名称（冗余，规则删了也能看）
    title NVARCHAR(256) NOT NULL,
    body NVARCHAR(MAX) NULL,                    -- Markdown 正文
    link_title NVARCHAR(64) NULL,               -- 正文下方按钮（如警报卡片的「查看详情」）
    link_url NVARCHAR(512) NULL,
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_notifications_created DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME()))
  );
  CREATE INDEX idx_notifications_source ON dbo.notifications (source_type, source_id, created_at);
END;

IF OBJECT_ID(N'dbo.notification_recipients', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.notification_recipients (
    notification_id INT NOT NULL,
    user_code NVARCHAR(64) NOT NULL,
    read_at DATETIME2(3) NULL,
    im_status_json NVARCHAR(400) NULL,          -- 各 IM 渠道结果，如 {"dingtalk":"sent"}；sent / failed / unbound
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_notification_recipients_created DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME())),
    CONSTRAINT PK_notification_recipients PRIMARY KEY (notification_id, user_code)
  );
  CREATE INDEX idx_notification_recipients_user ON dbo.notification_recipients (user_code, read_at, notification_id);
END;
