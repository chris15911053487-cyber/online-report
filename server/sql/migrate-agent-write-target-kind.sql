-- agent_write_targets 增加 target_kind 列：
--   'table'  — 白名单表 INSERT（默认，现状行为）
--   'action' — 调用代码注册的业务动作（server/src/agent-actions.js），
--              此时 target_table 列存动作名，fields_json 可为空数组
-- 幂等：可重复执行。
IF OBJECT_ID(N'dbo.agent_write_targets', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.agent_write_targets', N'target_kind') IS NULL
BEGIN
  ALTER TABLE dbo.agent_write_targets
    ADD target_kind NVARCHAR(16) NOT NULL
      CONSTRAINT DF_awt_target_kind DEFAULT (N'table');
END;
