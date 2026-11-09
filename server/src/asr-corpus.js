/**
 * 百度「语音自训练平台」语料：让识别模型更偏向本厂常说的话
 * （「看下上个月的数据」而不是「三个月」、物料名、客户名、菜单名、Agent 名…）。
 *
 * 平台要求：UTF-8 文本，一行一句；同一句重复出现即提高权重。
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
 * @param {object} src
 * @param {string[]} [src.menus]      菜单名
 * @param {string[]} [src.agents]     Agent 名
 * @param {string[]} [src.questions]  Agent 快捷问法、BI 示例问法（整句）
 * @param {string[]} [src.customers]  客户名
 * @param {string[]} [src.items]      物料名
 * @param {string[]} [src.corrected]  用户改过的语音输入（改后的整句）
 * @returns {string[]} 语料行
 */
function buildCorpus(src = {}) {
  const lines = [];
  const push = (line, times = 1) => {
    for (let i = 0; i < times; i++) lines.push(line);
  };

  for (const [t, w] of TIME_PHRASES) {
    push(t, w);
    for (const s of SUBJECTS) {
      for (const tpl of TEMPLATES) push(tpl(t, s), w);
    }
  }

  for (const m of cleanWords(src.menus)) {
    push(m, 2);
    push(`打开${m}`);
  }
  for (const a of cleanWords(src.agents)) {
    push(a, 2);
    push(`问问${a}`);
  }
  for (const q of cleanWords(src.questions, 60)) push(q, 2);

  const customers = cleanWords(src.customers);
  customers.forEach((c, i) => {
    push(c, 2);
    // 常用客户多造几句带时间的
    if (i < 100) push(`看下${c}上个月的销售`);
  });
  for (const it of cleanWords(src.items)) push(it, 2);

  // 真实说法最有价值：改后的整句多给权重
  for (const q of cleanWords(src.corrected, 120)) push(q, 3);

  return lines;
}

module.exports = { buildCorpus, cleanWords, TIME_PHRASES };
