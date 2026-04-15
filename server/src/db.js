/**
 * SQL Server 连接：使用官方生态常用的 npm 包 `mssql`（底层 Tedious 驱动 TDS 协议）。
 * 查询均通过 .input() 参数绑定，避免字符串拼接 SQL。
 * @see https://github.com/tediousjs/node-mssql
 */
const sql = require('mssql');

let pool;

function buildConfig() {
  return {
    server: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 1433),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    pool: {
      max: Number(process.env.DB_POOL || 10),
      min: 0,
      idleTimeoutMillis: 30000,
    },
    connectionTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 15000),
    requestTimeout: Number(process.env.DB_REQUEST_TIMEOUT_MS || 30000),
    options: {
      // 默认不加密：许多内网 SQL Server / 旧版仅 TDS，开 encrypt 会触发 OpenSSL「unsupported protocol」
      // 需要加密（如 Azure）时在 .env 设置 DB_ENCRYPT=true
      encrypt: process.env.DB_ENCRYPT === 'true',
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE !== 'false',
      // 在 SQL Server 会话中显示为「应用程序名称」，便于 DMV 排查连接来源
      appName: process.env.DB_APP_NAME || 'online-report',
      enableArithAbort: true,
    },
  };
}

async function connectWithRetry() {
  const maxAttempts = Math.max(1, Math.min(10, Number(process.env.DB_CONNECT_RETRIES || 3)));
  const delayMs = Math.max(100, Number(process.env.DB_CONNECT_RETRY_DELAY_MS || 1000));
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const p = await new sql.ConnectionPool(buildConfig()).connect();
      return p;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

async function getPool() {
  if (!pool) {
    pool = await connectWithRetry();
    pool.on('error', (err) => {
      console.error('[db] ConnectionPool error:', err.message);
      pool = undefined;
    });
  }
  return pool;
}

module.exports = { getPool, sql };
