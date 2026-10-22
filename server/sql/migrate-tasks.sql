-- 待办：规则按数据生成、每条归一个负责人、有状态流转（取代原「消息提醒」message_alert_rules）
-- 规则仍在 alert_rules：output_mode = 'notify' 推通知（原警报），'task' 生成待办

IF COL_LENGTH('dbo.alert_rules', 'output_mode') IS NULL
  ALTER TABLE dbo.alert_rules ADD output_mode VARCHAR(16) NOT NULL
    CONSTRAINT DF_alert_rules_output_mode DEFAULT ('notify');  -- notify | task
IF COL_LENGTH('dbo.alert_rules', 'owner_column') IS NULL
  ALTER TABLE dbo.alert_rules ADD owner_column NVARCHAR(128) NULL;   -- 负责人列（值为 OUSR.USER_CODE）
IF COL_LENGTH('dbo.alert_rules', 'due_column') IS NULL
  ALTER TABLE dbo.alert_rules ADD due_column NVARCHAR(128) NULL;     -- 到期日列（可选）
IF COL_LENGTH('dbo.alert_rules', 'due_days') IS NULL
  ALTER TABLE dbo.alert_rules ADD due_days INT NULL;                 -- 没有到期日列时：出现后 N 天内处理（默认 0 = 当天）
IF COL_LENGTH('dbo.alert_rules', 'escalate_days') IS NULL
  ALTER TABLE dbo.alert_rules ADD escalate_days INT NULL;            -- 超期 N 天升级给主管（空 = 不升级）

IF OBJECT_ID(N'dbo.tasks', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.tasks (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    source_type VARCHAR(16) NOT NULL
      CONSTRAINT DF_tasks_source DEFAULT ('rule'),   -- rule 规则生成 | manual 人工派发 | ai AI 建议（后两种为后续预留）
    rule_id INT NULL,
    item_key NVARCHAR(512) NULL,                     -- 规则的单据键（规则 + 单据号去重）
    title NVARCHAR(256) NOT NULL,
    body NVARCHAR(MAX) NULL,                         -- Markdown 说明
    link_url NVARCHAR(512) NULL,                     -- 跳到对应报表 / 单据
    data_json NVARCHAR(MAX) NULL,                    -- 最近一次查到的数据行
    owner_code NVARCHAR(64) NULL,                    -- 负责人；NULL = 数据里没有可识别的负责人，由主管分派
    owner_locked BIT NOT NULL
      CONSTRAINT DF_tasks_owner_locked DEFAULT (0),  -- 转交过：同步时不再按数据改负责人
    status VARCHAR(16) NOT NULL
      CONSTRAINT DF_tasks_status DEFAULT ('open'),   -- open 待处理 | snoozed 已延后 | done 已处理 | closed 已关闭（数据里查不到了）
    due_date DATE NULL,
    snooze_until DATE NULL,
    note NVARCHAR(1000) NULL,
    reopen_count INT NOT NULL
      CONSTRAINT DF_tasks_reopen DEFAULT (0),
    first_seen_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_tasks_first_seen DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME())),
    last_seen_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_tasks_last_seen DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME())),
    done_at DATETIME2(3) NULL,
    done_by NVARCHAR(64) NULL,
    closed_at DATETIME2(3) NULL,
    escalated_at DATETIME2(3) NULL,
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_tasks_created DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME())),
    updated_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_tasks_updated DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME()))
  );
  CREATE UNIQUE INDEX ux_tasks_rule_item ON dbo.tasks (rule_id, item_key) WHERE rule_id IS NOT NULL AND item_key IS NOT NULL;
  CREATE INDEX idx_tasks_owner ON dbo.tasks (owner_code, status, due_date);
  CREATE INDEX idx_tasks_rule ON dbo.tasks (rule_id, status);
END;

-- 处理记录：谁在什么时候做了什么（系统动作 user_code 为 NULL）
IF OBJECT_ID(N'dbo.task_events', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.task_events (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    task_id INT NOT NULL,
    action VARCHAR(16) NOT NULL,   -- create | done | reopen | snooze | wake | transfer | note | close | escalate
    user_code NVARCHAR(64) NULL,
    detail NVARCHAR(500) NULL,
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_task_events_created DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME()))
  );
  CREATE INDEX idx_task_events_task ON dbo.task_events (task_id, id);
  CREATE INDEX idx_task_events_time ON dbo.task_events (created_at, action);
END;
