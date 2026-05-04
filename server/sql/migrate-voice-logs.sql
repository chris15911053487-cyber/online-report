IF OBJECT_ID(N'dbo.voice_logs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.voice_logs (
    id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    recognized_text NVARCHAR(512) NOT NULL,
    user_code NVARCHAR(64) NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_voice_logs_created DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX idx_voice_logs_created ON dbo.voice_logs (created_at);
END;
