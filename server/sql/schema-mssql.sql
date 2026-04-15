/* 报工系统表（SQL Server / T-SQL），与 SAP OUSR 同库；OUSR 为现有表勿动 */

IF OBJECT_ID(N'dbo.production_orders', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.production_orders (
    id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    order_no NVARCHAR(64) NOT NULL,
    product_name NVARCHAR(256) NOT NULL CONSTRAINT DF_po_product DEFAULT (N''),
    planned_qty DECIMAL(18, 4) NOT NULL CONSTRAINT DF_po_planned DEFAULT (0),
    reported_qty DECIMAL(18, 4) NOT NULL CONSTRAINT DF_po_reported DEFAULT (0),
    status NVARCHAR(32) NOT NULL CONSTRAINT DF_po_status DEFAULT (N'open'),
    remark NVARCHAR(512) NOT NULL CONSTRAINT DF_po_remark DEFAULT (N''),
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_po_created DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_po_updated DEFAULT (SYSUTCDATETIME())
  );
  CREATE UNIQUE INDEX uk_production_orders_no ON dbo.production_orders (order_no);
  CREATE INDEX idx_production_orders_status ON dbo.production_orders (status);
END;

IF OBJECT_ID(N'dbo.order_operations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.order_operations (
    id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    order_id BIGINT NOT NULL,
    seq_no INT NOT NULL CONSTRAINT DF_oo_seq DEFAULT (1),
    operation_name NVARCHAR(128) NOT NULL CONSTRAINT DF_oo_name DEFAULT (N''),
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_oo_created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT fk_oo_order FOREIGN KEY (order_id) REFERENCES dbo.production_orders (id) ON DELETE CASCADE,
    CONSTRAINT uk_order_seq UNIQUE (order_id, seq_no)
  );
  CREATE INDEX idx_order_operations_order ON dbo.order_operations (order_id);
END;

IF OBJECT_ID(N'dbo.work_reports', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.work_reports (
    id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    order_id BIGINT NOT NULL,
    operation_id BIGINT NULL,
    user_id BIGINT NOT NULL,
    reporter_user_code NVARCHAR(64) NULL,
    good_qty DECIMAL(18, 4) NOT NULL CONSTRAINT DF_wr_good DEFAULT (0),
    scrap_qty DECIMAL(18, 4) NOT NULL CONSTRAINT DF_wr_scrap DEFAULT (0),
    remark NVARCHAR(512) NOT NULL CONSTRAINT DF_wr_remark DEFAULT (N''),
    reported_at DATETIME2(3) NOT NULL CONSTRAINT DF_wr_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT fk_wr_order FOREIGN KEY (order_id) REFERENCES dbo.production_orders (id) ON DELETE CASCADE,
    CONSTRAINT fk_wr_op FOREIGN KEY (operation_id) REFERENCES dbo.order_operations (id) ON DELETE SET NULL
  );
  CREATE INDEX idx_wr_order ON dbo.work_reports (order_id);
  CREATE INDEX idx_wr_user ON dbo.work_reports (user_id);
  CREATE INDEX idx_wr_at ON dbo.work_reports (reported_at);
END;

IF OBJECT_ID(N'dbo.work_reports', N'U') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'dbo.work_reports') AND name = N'reporter_user_code'
  )
BEGIN
  ALTER TABLE dbo.work_reports ADD reporter_user_code NVARCHAR(64) NULL;
END;

IF EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = N'fk_wr_user' AND parent_object_id = OBJECT_ID(N'dbo.work_reports')
)
BEGIN
  ALTER TABLE dbo.work_reports DROP CONSTRAINT fk_wr_user;
END;

IF OBJECT_ID(N'dbo.nav_menu_items', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.nav_menu_items (
    id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    label NVARCHAR(128) NOT NULL,
    route_key NVARCHAR(64) NOT NULL,
    icon NVARCHAR(32) NULL,
    sort_order INT NOT NULL CONSTRAINT DF_nav_sort DEFAULT (0),
    enabled BIT NOT NULL CONSTRAINT DF_nav_enabled DEFAULT (1),
    roles_json NVARCHAR(512) NOT NULL CONSTRAINT DF_nav_roles DEFAULT (N'["operator"]'),
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_nav_created DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_nav_updated DEFAULT (SYSUTCDATETIME())
  );
  CREATE UNIQUE INDEX uk_nav_menu_route ON dbo.nav_menu_items (route_key);
  CREATE INDEX idx_nav_menu_sort ON dbo.nav_menu_items (sort_order, id);
END;
