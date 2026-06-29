-- 方案 A：扩展角色体系（app_roles 角色目录 + user_roles 用户分配）
-- 与 OUSR 同库；不修改 OUSR 表

IF OBJECT_ID(N'dbo.app_roles', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.app_roles (
    role_key NVARCHAR(32) NOT NULL PRIMARY KEY,
    label NVARCHAR(64) NOT NULL,
    sort_order INT NOT NULL CONSTRAINT DF_app_roles_sort DEFAULT (0),
    is_builtin BIT NOT NULL CONSTRAINT DF_app_roles_builtin DEFAULT (0),
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_app_roles_created DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())  -- 中国本地(UTC+8)；SQL2012 不支持 AT TIME ZONE
      )
  );
  CREATE INDEX idx_app_roles_sort ON dbo.app_roles (sort_order, role_key);
END;

IF OBJECT_ID(N'dbo.user_roles', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.user_roles (
    user_code NVARCHAR(64) NOT NULL,
    role_key NVARCHAR(32) NOT NULL,
    created_at DATETIME2(3) NOT NULL
      CONSTRAINT DF_user_roles_created DEFAULT (
        DATEADD(HOUR, 8, SYSUTCDATETIME())  -- 中国本地(UTC+8)；SQL2012 不支持 AT TIME ZONE
      ),
    CONSTRAINT PK_user_roles PRIMARY KEY (user_code, role_key)
  );
  CREATE INDEX idx_user_roles_role ON dbo.user_roles (role_key, user_code);
END;

-- 内置 + 常用岗位角色（幂等）
MERGE dbo.app_roles AS t
USING (
  SELECT N'admin' AS role_key, N'管理员' AS label, 10 AS sort_order, CAST(1 AS BIT) AS is_builtin
  UNION ALL SELECT N'operator', N'操作员', 20, CAST(1 AS BIT)
  UNION ALL SELECT N'production', N'生产', 30, CAST(0 AS BIT)
  UNION ALL SELECT N'warehouse', N'仓库', 40, CAST(0 AS BIT)
  UNION ALL SELECT N'quality', N'质检', 50, CAST(0 AS BIT)
  UNION ALL SELECT N'finance', N'财务', 60, CAST(0 AS BIT)
  UNION ALL SELECT N'cost-viewer', N'查看成本', 70, CAST(1 AS BIT)
  UNION ALL SELECT N'attachment-generator', N'生成附件', 80, CAST(1 AS BIT)
) AS s ON t.role_key = s.role_key
WHEN NOT MATCHED BY TARGET THEN
  INSERT (role_key, label, sort_order, is_builtin)
  VALUES (s.role_key, s.label, s.sort_order, s.is_builtin);
