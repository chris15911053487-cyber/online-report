-- 警报推送到钉钉：规则配置 + Webhook管理 + 推送日志

-- 1. 钉钉群 Webhook 配置表
IF OBJECT_ID(N'dbo.alert_webhooks', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.alert_webhooks (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    name NVARCHAR(128) NOT NULL,               -- Webhook 名称，如「生产报警群」
    webhook_url NVARCHAR(512) NOT NULL,        -- 钉钉群机器人 Webhook 地址
    secret NVARCHAR(128) NULL,                 -- 加签密钥（可选）
    enabled BIT NOT NULL
      CONSTRAINT DF_alert_webhooks_enabled DEFAULT (1),
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_alert_webhooks_created DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME())),
    updated_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_alert_webhooks_updated DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME()))
  );
END;

-- 2. 警报规则表
IF OBJECT_ID(N'dbo.alert_rules', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.alert_rules (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    name NVARCHAR(128) NOT NULL,                -- 规则名称，如「库存低于安全库存」
    description NVARCHAR(512) NULL,             -- 规则描述

    -- 触发方式：'cron' 定时检查 | 'event' 事件触发
    trigger_type VARCHAR(16) NOT NULL
      CONSTRAINT DF_alert_rules_trigger DEFAULT ('cron'),

    -- 定时检查配置
    cron_expr VARCHAR(64) NULL,                 -- cron 表达式（trigger_type=cron 时必填）
    sql_template NVARCHAR(MAX) NULL,            -- 检查 SQL（返回行数>0 即触发警报）
    key_column NVARCHAR(128) NULL,              -- 结果去重键列（避免重复告警）

    -- 事件触发配置
    event_name VARCHAR(64) NULL,                -- 事件名称，如 'pro-sign-complete', 'order-create'

    -- 推送目标
    target_users_json NVARCHAR(512) NULL,       -- 按用户推送 ["U001","U002"]（优先）
    target_roles_json NVARCHAR(512) NULL,       -- 按角色推送 ["production","warehouse"]
    target_webhooks_json NVARCHAR(512) NULL,    -- 群 Webhook IDs [1,2]

    -- 消息卡片模板
    card_title_template NVARCHAR(256) NOT NULL  -- 卡片标题模板，支持 {列名} 占位
      CONSTRAINT DF_alert_rules_card_title DEFAULT (N'⚠️ 警报通知'),
    card_body_template NVARCHAR(MAX) NULL,      -- 卡片正文 markdown 模板，支持 {列名}
    card_btn_title NVARCHAR(64) NULL,           -- 按钮文字，如「查看详情」
    card_btn_url NVARCHAR(512) NULL,            -- 按钮链接（跳回系统）

    -- 去重控制（避免同一条数据重复告警）
    cooldown_minutes INT NOT NULL
      CONSTRAINT DF_alert_rules_cooldown DEFAULT (60),  -- 冷却时间（分钟）

    -- 状态
    enabled BIT NOT NULL
      CONSTRAINT DF_alert_rules_enabled DEFAULT (1),
    sort_order INT NOT NULL
      CONSTRAINT DF_alert_rules_sort DEFAULT (0),
    created_by NVARCHAR(64) NULL,
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_alert_rules_created DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME())),
    updated_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_alert_rules_updated DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME()))
  );
  CREATE INDEX idx_alert_rules_trigger ON dbo.alert_rules (trigger_type, enabled);
  CREATE INDEX idx_alert_rules_event ON dbo.alert_rules (event_name) WHERE event_name IS NOT NULL;
END;

-- 3. 警报推送日志表
IF OBJECT_ID(N'dbo.alert_logs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.alert_logs (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    rule_id INT NOT NULL,
    rule_name NVARCHAR(128) NULL,               -- 冗余存储方便查询
    trigger_type VARCHAR(16) NOT NULL,          -- 'cron' | 'event'
    event_name VARCHAR(64) NULL,                -- 事件名称（event 触发时）
    triggered_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_alert_logs_triggered DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME())),
    status VARCHAR(16) NOT NULL
      CONSTRAINT DF_alert_logs_status DEFAULT ('pending'),  -- pending|sent|failed|skipped
    target_count INT NOT NULL DEFAULT 0,        -- 目标人数
    sent_count INT NOT NULL DEFAULT 0,          -- 实际发送数
    webhook_count INT NOT NULL DEFAULT 0,       -- Webhook 推送数
    card_title NVARCHAR(256) NULL,              -- 实际发送的卡片标题
    card_body NVARCHAR(MAX) NULL,               -- 实际发送的卡片正文
    data_snapshot NVARCHAR(MAX) NULL,           -- 触发时的数据快照 JSON
    error_message NVARCHAR(1000) NULL,
    finished_at DATETIME2(3) NULL
  );
  CREATE INDEX idx_alert_logs_rule ON dbo.alert_logs (rule_id, triggered_at DESC);
  CREATE INDEX idx_alert_logs_time ON dbo.alert_logs (triggered_at DESC);
END;

-- 4. 警报去重记录（按 rule_id + item_key 记录最后告警时间，配合 cooldown_minutes 去重）
IF OBJECT_ID(N'dbo.alert_sent_keys', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.alert_sent_keys (
    rule_id INT NOT NULL,
    item_key NVARCHAR(512) NOT NULL,
    last_sent_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_alert_sent_keys_sent DEFAULT (DATEADD(HOUR, 8, SYSUTCDATETIME())),
    CONSTRAINT PK_alert_sent_keys PRIMARY KEY (rule_id, item_key)
  );
END;
