-- bot_user_bindings：IM 平台用户 → 系统用户映射
IF OBJECT_ID(N'dbo.bot_user_bindings', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.bot_user_bindings (
    platform      VARCHAR(20)    NOT NULL,   -- 'dingtalk' | 'feishu' | 'wechat'
    platform_uid  NVARCHAR(128)  NOT NULL,   -- 平台用户ID（钉钉 staffId / 飞书 open_id）
    user_code     NVARCHAR(64)   NOT NULL,   -- 对应 OUSR.USER_CODE
    created_at    DATETIME2(3)   NOT NULL
      CONSTRAINT DF_bot_bind_created DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME())),
    CONSTRAINT PK_bot_user_bindings PRIMARY KEY (platform, platform_uid)
  );
  CREATE INDEX idx_bot_bind_user ON dbo.bot_user_bindings (user_code);
END;
