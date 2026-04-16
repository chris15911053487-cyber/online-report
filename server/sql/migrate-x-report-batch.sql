/* 报工登记批次、明细行、时间日志（X_ 前缀避免与业务库表名冲突） */

IF OBJECT_ID(N'dbo.X_report_batch', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.X_report_batch (
    id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    reporter_user_code NVARCHAR(64) NULL,
    status NVARCHAR(32) NOT NULL CONSTRAINT DF_xrb_status DEFAULT (N'pending'),
    received_at DATETIME2(3) NULL,
    work_started_at DATETIME2(3) NULL,
    last_active_at DATETIME2(3) NULL,
    completed_at DATETIME2(3) NULL,
    pause_reason NVARCHAR(512) NULL,
    total_working_seconds INT NOT NULL CONSTRAINT DF_xrb_secs DEFAULT (0),
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_xrb_created DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_xrb_updated DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX idx_xrb_user ON dbo.X_report_batch (user_id);
  CREATE INDEX idx_xrb_status ON dbo.X_report_batch (status);
END;

IF OBJECT_ID(N'dbo.X_report_batch_line', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.X_report_batch_line (
    id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    batch_id BIGINT NOT NULL,
    order_id BIGINT NOT NULL,
    operation_id BIGINT NOT NULL,
    sort_order INT NOT NULL CONSTRAINT DF_xrbl_sort DEFAULT (0),
    CONSTRAINT fk_xrbl_batch FOREIGN KEY (batch_id) REFERENCES dbo.X_report_batch (id) ON DELETE CASCADE,
    CONSTRAINT fk_xrbl_order FOREIGN KEY (order_id) REFERENCES dbo.production_orders (id),
    CONSTRAINT fk_xrbl_op FOREIGN KEY (operation_id) REFERENCES dbo.order_operations (id)
  );
  CREATE UNIQUE INDEX uk_xrbl_batch_order_op ON dbo.X_report_batch_line (batch_id, order_id, operation_id);
  CREATE INDEX idx_xrbl_batch ON dbo.X_report_batch_line (batch_id);
END;

IF OBJECT_ID(N'dbo.X_task_logs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.X_task_logs (
    id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    batch_id BIGINT NOT NULL,
    action_type NVARCHAR(32) NOT NULL,
    event_at DATETIME2(3) NOT NULL CONSTRAINT DF_xtl_at DEFAULT (SYSUTCDATETIME()),
    reason NVARCHAR(512) NULL,
    user_id BIGINT NOT NULL,
    working_seconds_delta INT NULL,
    CONSTRAINT fk_xtl_batch FOREIGN KEY (batch_id) REFERENCES dbo.X_report_batch (id) ON DELETE CASCADE
  );
  CREATE INDEX idx_xtl_batch ON dbo.X_task_logs (batch_id);
END;

IF OBJECT_ID(N'dbo.work_reports', N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.work_reports', N'batch_line_id') IS NULL
BEGIN
  ALTER TABLE dbo.work_reports ADD batch_line_id BIGINT NULL;
END;

IF OBJECT_ID(N'dbo.work_reports', N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.work_reports', N'batch_line_id') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = N'fk_wr_batch_line' AND parent_object_id = OBJECT_ID(N'dbo.work_reports')
  )
BEGIN
  ALTER TABLE dbo.work_reports
    ADD CONSTRAINT fk_wr_batch_line FOREIGN KEY (batch_line_id) REFERENCES dbo.X_report_batch_line (id) ON DELETE SET NULL;
END;
