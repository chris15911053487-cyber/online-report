const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { normalizeExportInput, buildDetailWorkbook, safeFileName, cellValue } = require('../src/bi-export');

test('导出：校验列与行数', () => {
  assert.throws(() => normalizeExportInput({ columns: [], rows: [] }), /缺少列/);
  assert.throws(() => normalizeExportInput({ columns: [{ column: 'a' }] }), /缺少数据行/);
  const old = process.env.BI_MAX_ROWS;
  process.env.BI_MAX_ROWS = '2';
  try {
    assert.throws(() => normalizeExportInput({ columns: [{ column: 'a' }], rows: [{}, {}, {}] }), /最多导出 2 行/);
  } finally {
    if (old == null) delete process.env.BI_MAX_ROWS;
    else process.env.BI_MAX_ROWS = old;
  }
  const v = normalizeExportInput({ title: '', columns: [{ column: 'Amt', format: 'money' }, { column: 'X', format: 'bad' }], rows: [{ Amt: 1 }, null] });
  assert.equal(v.title, '明细');
  assert.deepEqual(v.columns, [{ column: 'Amt', label: 'Amt', format: 'money' }, { column: 'X', label: 'X', format: undefined }]);
  assert.deepEqual(v.rows[1], {});
});

test('导出：单元格值——有格式的数字文本转数字，编码类文本保持原样', () => {
  assert.equal(cellValue('1234.5', 'money'), 1234.5);
  assert.equal(cellValue('00123', undefined), '00123');
  assert.equal(cellValue(true), '是');
  assert.equal(cellValue(null), null);
  assert.equal(safeFileName('客户/单据:明细'), '客户_单据_明细.xlsx');
});

test('导出：生成的 xlsx 表头为显示名、数值列带格式', async () => {
  const buf = await buildDetailWorkbook({
    title: '单据明细',
    columns: [{ column: 'DocNum', label: '单号' }, { column: 'Amt', label: '金额', format: 'money' }],
    rows: [{ DocNum: '001', Amt: '12.5' }],
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, '单据明细');
  assert.equal(ws.getCell('A1').value, '单号');
  assert.equal(ws.getCell('A2').value, '001');
  assert.equal(ws.getCell('B2').value, 12.5);
  assert.equal(ws.getCell('B2').numFmt, '#,##0.00');
});
