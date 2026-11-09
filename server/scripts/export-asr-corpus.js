/**
 * 导出百度「语音自训练平台」（EasyDL 语音识别）语料：node scripts/export-asr-corpus.js <输出目录>
 * （npm run export-asr-corpus -- ../asr-out）
 *
 * 取菜单名、Agent 名与快捷问法、BI 示例问法、客户名、物料名、用户改过的语音输入，
 * 加上「看下上个月的数据」等时间句式，写成平台要求的 GBK 文本：
 *   asr-corpus-hotwords.txt   热词（一行一个词）
 *   asr-corpus-sentences.txt  句篇（一行一句）
 * 结果含客户 / 物料名，只上传到百度控制台，不要提交到仓库（已 gitignore asr-corpus*.txt）。
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const fs = require('fs');
const path = require('path');
const { getPool } = require('../src/db');
const { buildCorpus, encodeGbkLines } = require('../src/asr-corpus');

/** 单条查询失败（表不存在等）不影响整体导出 */
async function column(pool, label, sqlText, col) {
  try {
    const r = await pool.request().query(sqlText);
    const out = r.recordset.map((row) => row[col]).filter(Boolean);
    console.log(`${label}: ${out.length}`);
    return out;
  } catch (err) {
    console.warn(`${label}: 跳过（${err.message}）`);
    return [];
  }
}

function parseJsonArray(text) {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('用法：node scripts/export-asr-corpus.js <输出目录>');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const pool = await getPool();

  const menus = await column(pool, '菜单', 'SELECT label FROM dbo.nav_menu_items WHERE enabled = 1', 'label');
  const agents = await column(pool, 'Agent', 'SELECT label FROM dbo.agents WHERE enabled = 1', 'label');
  const quickJson = await column(pool, 'Agent 快捷问法', 'SELECT quick_prompts_json FROM dbo.agents WHERE enabled = 1', 'quick_prompts_json');
  const sampleJson = await column(pool, 'BI 示例问法', 'SELECT sample_questions_json FROM dbo.bi_queries WHERE enabled = 1', 'sample_questions_json');
  const questions = [
    ...quickJson.flatMap((t) => parseJsonArray(t).map((q) => q && q.label)),
    ...sampleJson.flatMap((t) => parseJsonArray(t)),
  ].filter((q) => typeof q === 'string');
  const customers = await column(pool, '客户',
    "SELECT TOP 500 CardName FROM dbo.OCRD WHERE CardType = 'C' AND frozenFor <> 'Y' ORDER BY UpdateDate DESC", 'CardName');
  const items = await column(pool, '物料',
    "SELECT TOP 1000 ItemName FROM dbo.OITM WHERE frozenFor <> 'Y' ORDER BY UpdateDate DESC", 'ItemName');
  const corrected = await column(pool, '用户改过的语音输入',
    `IF COL_LENGTH(N'dbo.voice_logs', N'final_text') IS NOT NULL
       EXEC(N'SELECT TOP 2000 final_text FROM dbo.voice_logs
              WHERE final_text IS NOT NULL AND final_text <> recognized_text ORDER BY id DESC')`, 'final_text');

  const { hotwords, sentences } = buildCorpus({ menus, agents, questions, customers, items, corrected });
  for (const [name, lines] of [['asr-corpus-hotwords.txt', hotwords], ['asr-corpus-sentences.txt', sentences]]) {
    const file = path.join(outDir, name);
    const { buffer, kept, dropped, truncated } = encodeGbkLines(lines);
    fs.writeFileSync(file, buffer);
    let note = `已写入 ${file}（GBK）：${kept} 行`;
    if (dropped) note += `，${dropped} 行含 GBK 表示不了的字符已跳过`;
    if (truncated) note += '，超过 5MB 已截断';
    console.log(note);
  }
  await pool.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
