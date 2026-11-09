/**
 * 百度「语音自训练平台」语料：让识别模型更偏向本厂常说的话
 * （「看下上个月的数据」而不是「三个月」、物料名、客户名、菜单名、Agent 名…）。
 *
 * 平台（现名「EasyDL 语音识别」）要求：txt、GBK 编码、单文件 ≤5MB；热词一行一个词，句篇一行一句。
 * 由 scripts/export-asr-corpus.js 取库里的词后调用 buildCorpus 生成。
 */

/** 时间说法与权重：「上个月」最常被听成「三个月」，给最高权重 */
const TIME_PHRASES = [
  ['上个月', 6], ['上月', 3], ['本月', 3], ['这个月', 3], ['上上个月', 2],
  ['上周', 3], ['本周', 2], ['这周', 2], ['今天', 2], ['昨天', 2],
  ['今年', 2], ['去年', 2], ['去年同期', 2], ['上季度', 2], ['本季度', 1],
  ['近三个月', 1], ['最近三个月', 1], ['上半年', 1],
];

const SUBJECTS = ['数据', '销售', '销售额', '产量', '回款', '应收', '报工', '订单', '出货', '采购', '库存', '不良率', '毛利', '费用'];

const TEMPLATES = [
  (t, s) => `看下${t}的${s}`,
  (t, s) => `看一下${t}的${s}`,
  (t, s) => `查一下${t}的${s}`,
  (t, s) => `${t}${s}是多少`,
  (t, s) => `${t}的${s}怎么样`,
];

/** 去重、去空、去掉过长和含换行的词 */
function cleanWords(list, maxLen = 30) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const w = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!w || w.length > maxLen || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/**
 * 拆成平台的两种语料：热词（一行一个词）、句篇（一行一句）。
 * 平台说明「少量关键文本即可有训练效果」，权重只做轻度重复（最多 3 次）。
 *
 * @param {object} src
 * @param {string[]} [src.menus]      菜单名
 * @param {string[]} [src.agents]     Agent 名
 * @param {string[]} [src.questions]  Agent 快捷问法、BI 示例问法（整句）
 * @param {string[]} [src.customers]  客户名
 * @param {string[]} [src.items]      物料名
 * @param {string[]} [src.corrected]  用户改过的语音输入（改后的整句）
 * @returns {{ hotwords: string[], sentences: string[] }}
 */
function buildCorpus(src = {}) {
  const sentences = [];
  const push = (line, times = 1) => {
    for (let i = 0; i < Math.min(3, times); i++) sentences.push(line);
  };

  for (const [t, w] of TIME_PHRASES) {
    const times = w >= 6 ? 3 : w >= 3 ? 2 : 1;
    for (const s of SUBJECTS) {
      for (const tpl of TEMPLATES) push(tpl(t, s), times);
    }
  }

  const menus = cleanWords(src.menus);
  const agents = cleanWords(src.agents);
  const customers = cleanWords(src.customers);
  const items = cleanWords(src.items);
  for (const m of menus) push(`打开${m}`);
  for (const a of agents) push(`问问${a}`);
  for (const q of cleanWords(src.questions, 60)) push(q);
  // 常用客户造几句带时间的
  customers.slice(0, 100).forEach((c) => push(`看下${c}上个月的销售`));
  // 真实说法最有价值
  for (const q of cleanWords(src.corrected, 120)) push(q, 3);

  const hotwords = cleanWords([
    ...TIME_PHRASES.map(([t]) => t),
    ...menus,
    ...agents,
    ...customers,
    ...items,
  ]);

  return { hotwords, sentences };
}

/** 平台要求 GBK 编码、单个文件不超过 5MB */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * 编码成 GBK 文本：GBK 表示不了的行（emoji、生僻字）丢掉，超过 5MB 截断。
 * @returns {{ buffer: Buffer, kept: number, dropped: number, truncated: boolean }}
 */
function encodeGbkLines(lines, maxBytes = MAX_FILE_BYTES) {
  const iconv = require('iconv-lite');
  const parts = [];
  let size = 0;
  let kept = 0;
  let dropped = 0;
  let truncated = false;
  for (const line of lines) {
    const buf = iconv.encode(line + '\r\n', 'gbk');
    if (iconv.decode(buf, 'gbk') !== line + '\r\n') {
      dropped += 1;
      continue;
    }
    if (size + buf.length > maxBytes) {
      truncated = true;
      break;
    }
    parts.push(buf);
    size += buf.length;
    kept += 1;
  }
  return { buffer: Buffer.concat(parts), kept, dropped, truncated };
}

module.exports = { buildCorpus, cleanWords, encodeGbkLines, TIME_PHRASES };
