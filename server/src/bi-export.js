/**
 * 看板下钻明细导出 Excel（POST /bi/export）。
 *
 * 导出的是用户在明细面板里看到的那批行（已按搜索 / 筛选 / 排序处理，≤ BI_MAX_ROWS），
 * 由前端传入，这里只负责校验大小、按列格式写成 xlsx。权限由路由检查（export-excel 角色 + 查询可见角色）。
 */
const ExcelJS = require('exceljs');

const MAX_COLUMNS = 200;
const MAX_CELL_TEXT = 32767; // Excel 单元格上限

const NUM_FMT = {
  money: '#,##0.00',
  integer: '#,##0',
  percent: '0.0%',
  number: '#,##0.##',
};

function maxRows() {
  const n = Number(process.env.BI_MAX_ROWS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2000;
}

class BiExportError extends Error {
  constructor(message) {
    super(message);
    this.code = 'BI_EXPORT_BAD_REQUEST';
  }
}

/** 校验并规范化请求体：{ title, columns: [{ column, label?, format? }], rows: [{...}] } */
function normalizeExportInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const title = String(b.title || '明细').trim().slice(0, 80) || '明细';
  if (!Array.isArray(b.columns) || b.columns.length === 0) throw new BiExportError('缺少列');
  if (b.columns.length > MAX_COLUMNS) throw new BiExportError(`列数不能超过 ${MAX_COLUMNS}`);
  const columns = b.columns.map((c) => {
    const column = String(c?.column ?? '').slice(0, 128);
    if (!column) throw new BiExportError('列名不能为空');
    const format = NUM_FMT[c?.format] ? c.format : undefined;
    return { column, label: String(c?.label || column).slice(0, 128), format };
  });
  if (!Array.isArray(b.rows)) throw new BiExportError('缺少数据行');
  const limit = maxRows();
  if (b.rows.length > limit) throw new BiExportError(`一次最多导出 ${limit} 行`);
  const rows = b.rows.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : {}));
  return { title, columns, rows };
}

/** 单元格值：数字列（有格式或本身是数字）写数字，其余写文本 */
function cellValue(v, format) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? '是' : '否';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (format && s.trim() !== '' && Number.isFinite(Number(s))) return Number(s);
  return s.length > MAX_CELL_TEXT ? s.slice(0, MAX_CELL_TEXT) : s;
}

/** 文件名里不能有的字符换成 _ */
function safeFileName(title) {
  return `${title.replace(/[\\/:*?"<>|\r\n]+/g, '_')}.xlsx`;
}

async function buildDetailWorkbook({ title, columns, rows }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.replace(/[\\/:*?[\]]/g, '_').slice(0, 31) || '明细');
  sheet.columns = columns.map((c) => ({
    header: c.label,
    key: c.column,
    width: Math.min(40, Math.max(c.label.length * 2, 12)),
    style: c.format ? { numFmt: NUM_FMT[c.format] } : {},
  }));
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) {
    const data = {};
    for (const c of columns) data[c.column] = cellValue(r[c.column], c.format);
    sheet.addRow(data);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { normalizeExportInput, buildDetailWorkbook, safeFileName, cellValue, BiExportError };
