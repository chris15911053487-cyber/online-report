/**
 * SQL Server：创建报工用表、示例数据（登录以 OUSR 为准）
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const sql = require('mssql');

function buildConfig() {
  return {
    server: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 1433),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    pool: { max: 5, min: 0 },
    connectionTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 30000),
    options: {
      encrypt: process.env.DB_ENCRYPT === 'true',
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE !== 'false',
    },
  };
}

async function main() {
  const pool = await new sql.ConnectionPool(buildConfig()).connect();

  const schemaPath = path.join(__dirname, '..', 'sql', 'schema-mssql.sql');
  const seedPath = path.join(__dirname, '..', 'sql', 'seed-mssql.sql');
  const migrateReportCols = path.join(__dirname, '..', 'sql', 'migrate-nav-menu-report-columns.sql');
  const migrateDetailCols = path.join(__dirname, '..', 'sql', 'migrate-nav-menu-detail-columns.sql');
  const migrateXBatch = path.join(__dirname, '..', 'sql', 'migrate-x-report-batch.sql');
  const migrateColumnLabels = path.join(
    __dirname,
    '..',
    'sql',
    'migrate-nav-menu-column-labels.sql'
  );
  const migrateColumnNameMapping = path.join(
    __dirname,
    '..',
    'sql',
    'migrate-nav-menu-column-name-mapping.sql'
  );
  const migrateXOnlineSign = path.join(__dirname, '..', 'sql', 'migrate-x-online-sign.sql');
  const migrateVoiceLogs = path.join(__dirname, '..', 'sql', 'migrate-voice-logs.sql');
  const migrateReturnProPickLogs = path.join(
    __dirname,
    '..',
    'sql',
    'migrate-returnpro-pick-logs.sql'
  );
  const migrateProSignSqlLogs = path.join(
    __dirname,
    '..',
    'sql',
    'migrate-pro-sign-sql-logs.sql'
  );
  const migrateUserRoles = path.join(__dirname, '..', 'sql', 'migrate-user-roles.sql');

  await pool.request().query(fs.readFileSync(schemaPath, 'utf8'));
  await pool.request().query(fs.readFileSync(migrateReportCols, 'utf8'));
  await pool.request().query(fs.readFileSync(migrateDetailCols, 'utf8'));
  await pool.request().query(fs.readFileSync(migrateXBatch, 'utf8'));
  await pool.request().query(fs.readFileSync(migrateColumnLabels, 'utf8'));
  await pool.request().query(fs.readFileSync(migrateColumnNameMapping, 'utf8'));
  await pool.request().query(fs.readFileSync(migrateXOnlineSign, 'utf8'));
  await pool.request().query(fs.readFileSync(migrateVoiceLogs, 'utf8'));
  await pool.request().query(fs.readFileSync(migrateReturnProPickLogs, 'utf8'));
  await pool.request().query(fs.readFileSync(migrateProSignSqlLogs, 'utf8'));
  await pool.request().query(fs.readFileSync(migrateUserRoles, 'utf8'));
  await pool.request().query(fs.readFileSync(seedPath, 'utf8'));

  const ord = await pool.request().query(
    `SELECT TOP 1 id FROM dbo.production_orders
     WHERE order_no IN (N'PO-2026-001', N'PO-2026-002')
     ORDER BY id`
  );
  const id1 = ord.recordset[0]?.id;
  if (id1 != null) {
    const ops = [
      [1, '下料'],
      [2, '加工'],
      [3, '检验'],
    ];
    for (const [seq, nm] of ops) {
      await pool
        .request()
        .input('oid', sql.BigInt, BigInt(id1))
        .input('seq', sql.Int, seq)
        .input('nm', sql.NVarChar(128), nm)
        .query(
          `IF NOT EXISTS (SELECT 1 FROM dbo.order_operations WHERE order_id = @oid AND seq_no = @seq)
           INSERT INTO dbo.order_operations (order_id, seq_no, operation_name) VALUES (@oid, @seq, @nm)`
        );
    }
  }

  await pool.close();
  console.log('[init-db] 完成。报工表已就绪。登录使用 OUSR。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
