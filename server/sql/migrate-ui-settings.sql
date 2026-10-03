/* 界面设置：公司级设置（如默认主题）+ 用户个人偏好（如所选主题），不修改 SAP OUSR 表 */
IF OBJECT_ID(N'dbo.app_settings', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.app_settings (
    setting_key NVARCHAR(64) NOT NULL CONSTRAINT PK_app_settings PRIMARY KEY,
    setting_value NVARCHAR(1024) NULL,
    updated_by NVARCHAR(64) NULL,
    updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_app_settings_updated DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME()))
  );
END;

IF OBJECT_ID(N'dbo.user_preferences', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.user_preferences (
    user_code NVARCHAR(64) NOT NULL,
    pref_key NVARCHAR(64) NOT NULL,
    pref_value NVARCHAR(1024) NULL,
    updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_user_preferences_updated DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME())),
    CONSTRAINT PK_user_preferences PRIMARY KEY (user_code, pref_key)
  );
END;
