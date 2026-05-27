IF OBJECT_ID(N'dbo.returnpro_pick_logs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.returnpro_pick_logs (
    id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    user_code NVARCHAR(64) NULL,
    doc_entry NVARCHAR(64) NULL,
    request_json NVARCHAR(MAX) NULL,
    b1_request_json NVARCHAR(MAX) NULL,
    response_json NVARCHAR(MAX) NULL,
    success BIT NOT NULL CONSTRAINT DF_returnpro_pick_logs_success DEFAULT (0),
    error_code NVARCHAR(64) NULL,
    error_message NVARCHAR(2000) NULL,
    result_doc_entry NVARCHAR(64) NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_returnpro_pick_logs_created DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX idx_returnpro_pick_logs_created ON dbo.returnpro_pick_logs (created_at);
  CREATE INDEX idx_returnpro_pick_logs_doc ON dbo.returnpro_pick_logs (doc_entry);
END;
