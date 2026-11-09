-- voice_logs：记录语音识别后用户实际发出的文字（与识别结果不同 = 用户改过 = 识别错误样本）
-- final_text：实际发出的文字；source：chat（对话框按住说话）/ float（悬浮语音钮）
IF OBJECT_ID(N'dbo.voice_logs', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.voice_logs', N'final_text') IS NULL
BEGIN
  ALTER TABLE dbo.voice_logs ADD final_text NVARCHAR(512) NULL;
END;

IF OBJECT_ID(N'dbo.voice_logs', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.voice_logs', N'source') IS NULL
BEGIN
  ALTER TABLE dbo.voice_logs ADD source NVARCHAR(16) NULL;
END;
