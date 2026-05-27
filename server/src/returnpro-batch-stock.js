const { sql } = require('./db');

/** SAP B1：OIBT，按物料 + BatchNum + 仓库汇总可用库存 */
const DEFAULT_BATCH_STOCK_SQL = `
SELECT ISNULL(SUM(T0.Quantity), 0) AS OnHand
FROM dbo.OIBT T0 WITH (NOLOCK)
WHERE T0.ItemCode = @ItemCode
  AND T0.BatchNum = @BatchNum
  AND (@WhsCode IS NULL OR LTRIM(RTRIM(@WhsCode)) = '' OR T0.WhsCode = @WhsCode)
`;

function trimEnv(name) {
  const v = process.env[name];
  return v == null ? '' : String(v).trim();
}

function safeProcName(name) {
  const n = String(name || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) return null;
  return n;
}

function pickCol(row, ...candidates) {
  if (!row || typeof row !== 'object') return undefined;
  const keys = Object.keys(row);
  for (const name of candidates) {
    const found = keys.find((k) => k.toLowerCase() === name.toLowerCase());
    if (found != null) return row[found];
  }
  return undefined;
}

function toNumber(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {{ itemCode: string, batchNum: string, whsCode?: string, quantity?: number|null }} opts
 */
async function queryBatchStock(pool, opts) {
  const itemCode = String(opts.itemCode || '').trim();
  const batchNum = String(opts.batchNum || '').trim();
  const whsCode = opts.whsCode == null ? '' : String(opts.whsCode).trim();
  const requestedQty = toNumber(opts.quantity);

  if (!itemCode || !batchNum) {
    const err = new Error('请提供 itemCode、batchNum');
    err.code = 'RETURNPRO_BAD_REQUEST';
    throw err;
  }

  const procName = safeProcName(trimEnv('RETURNPRO_BATCH_STOCK_PROC'));
  let rs;
  if (procName) {
    rs = await pool
      .request()
      .input('ItemCode', sql.NVarChar(50), itemCode.slice(0, 50))
      .input('BatchNum', sql.NVarChar(100), batchNum.slice(0, 100))
      .input('WhsCode', sql.NVarChar(20), whsCode ? whsCode.slice(0, 20) : null)
      .query(`EXEC dbo.[${procName}] @ItemCode, @BatchNum, @WhsCode`);
  } else {
    rs = await pool
      .request()
      .input('ItemCode', sql.NVarChar(50), itemCode.slice(0, 50))
      .input('BatchNum', sql.NVarChar(100), batchNum.slice(0, 100))
      .input('WhsCode', sql.NVarChar(20), whsCode || null)
      .query(DEFAULT_BATCH_STOCK_SQL);
  }

  const row0 = rs.recordset && rs.recordset[0];
  const onHandRaw = pickCol(row0, 'OnHand', 'onHand', 'Quantity', 'Qty', 'Stock', '库存');
  const onHand = toNumber(onHandRaw) ?? 0;

  let sufficient = onHand > 0;
  if (requestedQty != null && requestedQty > 0) {
    sufficient = onHand >= requestedQty;
  }

  return {
    itemCode,
    batchNum,
    whsCode: whsCode || null,
    onHand,
    requestedQty,
    sufficient,
    found: onHand > 0,
  };
}

module.exports = {
  DEFAULT_BATCH_STOCK_SQL,
  queryBatchStock,
};
