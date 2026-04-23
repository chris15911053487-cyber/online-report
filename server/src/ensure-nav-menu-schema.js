const fs = require('fs');
const path = require('path');

const SQL_PATH = path.join(__dirname, '..', 'sql', 'migrate-nav-menu-items-only.sql');
const SQL_REPORT_COLS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-nav-menu-report-columns.sql'
);
const SQL_DETAIL_COLS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-nav-menu-detail-columns.sql'
);
const SQL_X_BATCH_PATH = path.join(__dirname, '..', 'sql', 'migrate-x-report-batch.sql');
const SQL_COLUMN_LABELS_PATH = path.join(
  __dirname,
  '..',
  'sql',
  'migrate-nav-menu-column-labels.sql'
);

/**
 * 启动时自动执行 migrate-nav-menu-items-only.sql（需账号有建表权限）。
 * 设置 AUTO_CREATE_NAV_MENU_TABLE=false 可关闭。
 */
async function ensureNavMenuSchema(getPool, log) {
  if (process.env.AUTO_CREATE_NAV_MENU_TABLE === 'false') {
    log?.info?.('[nav_menu_items] 跳过自动建表（AUTO_CREATE_NAV_MENU_TABLE=false）');
    return;
  }

  const warn = (msg, err) => {
    if (log && typeof log.warn === 'function') {
      log.warn(err, msg);
    } else {
      console.warn(msg, err || '');
    }
  };

  try {
    const pool = await getPool();
    const sqlText = fs.readFileSync(SQL_PATH, 'utf8');
    await pool.request().query(sqlText);
    const sqlReportCols = fs.readFileSync(SQL_REPORT_COLS_PATH, 'utf8');
    await pool.request().query(sqlReportCols);
    const sqlDetailCols = fs.readFileSync(SQL_DETAIL_COLS_PATH, 'utf8');
    await pool.request().query(sqlDetailCols);
    const sqlXBatch = fs.readFileSync(SQL_X_BATCH_PATH, 'utf8');
    await pool.request().query(sqlXBatch);
    const sqlColumnLabels = fs.readFileSync(SQL_COLUMN_LABELS_PATH, 'utf8');
    await pool.request().query(sqlColumnLabels);
    log?.info?.('[nav_menu_items] 已检查/创建表结构与默认数据（含报表扩展列与 X_ 报工批次表）');
  } catch (err) {
    warn(
      '[nav_menu_items] 自动建表失败：请用有 DDL 权限的账号连接，或手动在目标库执行 sql/migrate-nav-menu-items-only.sql',
      err
    );
  }
}

module.exports = ensureNavMenuSchema;
