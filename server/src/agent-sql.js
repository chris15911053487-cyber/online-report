/**
 * Agent run-sql 的流式读取：只保留前 N 行，其余只计数，避免大表结果整体进内存。
 *
 * 行为约定（与旧实现 `rows.slice(0, 200)` 对齐）：
 * - 只取第一个结果集（多结果集的后续结果集忽略）；
 * - totalRowCount = 第一个结果集的总行数（精确），truncated = 总行数 > limit；
 * - 为防止扫全表耗时过久，总行数超过 hardCap 时取消查询，此时 totalRowCount = hardCap 且 totalCapped = true。
 *
 * request 为 mssql 的 Request（已设置好 timeout）；本函数会把它切到 stream 模式。
 */

const DEFAULT_LIMIT = 200;
const DEFAULT_HARD_CAP = 50000;

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function runSqlLimited(request, sqlText, opts = {}) {
  const limit = opts.limit > 0 ? opts.limit : envInt('AI_SQL_MAX_ROWS', DEFAULT_LIMIT);
  const hardCap = Math.max(
    limit,
    opts.hardCap > 0 ? opts.hardCap : envInt('AI_SQL_COUNT_CAP', DEFAULT_HARD_CAP)
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let recordsetCount = 0;
    let columns = [];
    let columnTypes = {};
    const rows = [];
    let total = 0;
    let capped = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) return reject(err);
      resolve({
        columns,
        columnTypes,
        rows,
        totalRowCount: total,
        truncated: total > limit,
        totalCapped: capped,
      });
    };

    request.stream = true;
    request.on('recordset', (cols) => {
      recordsetCount += 1;
      if (recordsetCount === 1) {
        columns = Object.keys(cols || {});
        // 列的数据库类型（int / decimal / nvarchar / date …），供 BI 管理侧识别维度 / 度量
        columnTypes = {};
        for (const c of columns) {
          const t = cols[c] && cols[c].type;
          columnTypes[c] = String((t && (t.declaration || t.name)) || '').toLowerCase();
        }
      }
    });
    request.on('row', (row) => {
      if (settled || recordsetCount !== 1) return;
      total += 1;
      if (rows.length < limit) rows.push(row);
      if (total >= hardCap) {
        capped = true;
        try {
          request.cancel();
        } catch {
          /* 取消失败不影响已收集的结果 */
        }
        finish();
      }
    });
    request.on('error', (err) => finish(err));
    request.on('done', () => finish());

    try {
      request.query(sqlText);
    } catch (err) {
      finish(err);
    }
  });
}

module.exports = { runSqlLimited, DEFAULT_LIMIT, DEFAULT_HARD_CAP };
