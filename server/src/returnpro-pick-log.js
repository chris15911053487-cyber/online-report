const fs = require('fs');
const path = require('path');
const { getPool, sql } = require('./db');

const MIGRATE_SQL_PATH = path.join(__dirname, '..', 'sql', 'migrate-returnpro-pick-logs.sql');

function toJsonText(val) {
  if (val == null) return null;
  try {
    return JSON.stringify(val);
  } catch {
    return JSON.stringify({ _serializeError: String(val) });
  }
}

function trimText(val, maxLen) {
  if (val == null) return null;
  const s = String(val);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

let tableEnsured = false;

async function ensureReturnProPickLogTable(log) {
  if (tableEnsured) return;
  if (process.env.AUTO_CREATE_RETURNPRO_PICK_LOG_TABLE === 'false') {
    tableEnsured = true;
    return;
  }
  try {
    const pool = await getPool();
    const sqlText = fs.readFileSync(MIGRATE_SQL_PATH, 'utf8');
    await pool.request().query(sqlText);
    tableEnsured = true;
    log?.info?.('[returnpro_pick_logs] 已检查/创建表结构');
  } catch (err) {
    log?.warn?.({ err }, '[returnpro_pick_logs] 自动建表失败，请手动执行 migrate-returnpro-pick-logs.sql');
  }
}

/**
 * @param {{
 *   userCode?: string|null,
 *   docEntry?: string|null,
 *   requestJson?: unknown,
 *   b1RequestJson?: unknown,
 *   responseJson?: unknown,
 *   success?: boolean,
 *   errorCode?: string|null,
 *   errorMessage?: string|null,
 *   resultDocEntry?: string|null,
 * }} entry
 */
async function insertReturnProPickLog(entry, log) {
  await ensureReturnProPickLogTable(log);
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('user_code', sql.NVarChar(64), trimText(entry.userCode, 64))
      .input('doc_entry', sql.NVarChar(64), trimText(entry.docEntry, 64))
      .input('request_json', sql.NVarChar(sql.MAX), toJsonText(entry.requestJson))
      .input('b1_request_json', sql.NVarChar(sql.MAX), toJsonText(entry.b1RequestJson))
      .input('response_json', sql.NVarChar(sql.MAX), toJsonText(entry.responseJson))
      .input('success', sql.Bit, entry.success ? 1 : 0)
      .input('error_code', sql.NVarChar(64), trimText(entry.errorCode, 64))
      .input('error_message', sql.NVarChar(2000), trimText(entry.errorMessage, 2000))
      .input('result_doc_entry', sql.NVarChar(64), trimText(entry.resultDocEntry, 64))
      .query(`
        INSERT INTO dbo.returnpro_pick_logs (
          user_code, doc_entry, request_json, b1_request_json, response_json,
          success, error_code, error_message, result_doc_entry
        ) VALUES (
          @user_code, @doc_entry, @request_json, @b1_request_json, @response_json,
          @success, @error_code, @error_message, @result_doc_entry
        )
      `);
  } catch (err) {
    log?.error?.({ err }, 'returnpro pick log insert failed');
  }
}

module.exports = {
  ensureReturnProPickLogTable,
  insertReturnProPickLog,
};
