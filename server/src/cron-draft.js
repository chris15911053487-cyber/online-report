/**
 * 一句话生成 cron 表达式（预警规则、定时报告共用）。
 *
 * AI 按 node-cron 的语义写 5 段表达式 → cron.validate 校验 → 不通过把错误交回 AI 修正（≤3 轮）。
 * 只返回草稿，不保存；表达式的中文解读与「接下来几次」由前端 utils/cron.ts 计算。
 */
const cron = require('node-cron');

class CronDraftError extends Error {}

const MAX_ROUNDS = 3;

const SYSTEM_PROMPT = `你把用户的一句话（中文）转换成 node-cron 的 cron 表达式，时间一律按中国时间（Asia/Shanghai）。

格式：5 段「分 时 日 月 周」，用空格分隔。
- 分 0-59，时 0-23，日 1-31，月 1-12，周 0-6（0 = 周日，1 = 周一 … 6 = 周六）
- 支持 *、逗号列表（1,15）、范围（1-5）、步长（*/10）
- 不支持 ?、L、W、#，也不支持「每月最后一天」「每月第几个周一」这类写法
- node-cron 的特殊规则：
  1. 「日」和「周」同时写了具体值时，要求两者同时满足（不是任一满足）。一般只写其中一个，另一个用 *。
  2. 步长按「数值能被步长整除」取值：*/15 分 = 0,15,30,45；*/2 时 = 0,2,4…22；不要写 8-18/2 这种范围加步长（结果会偏），改用逗号列表 8,10,12,14,16,18。
- 「工作日」指周一到周五（1-5）；「早上 / 上午」没说具体时间时取 8:00，「下午」取 14:00，「晚上」取 20:00；「每天」没说时间时取 8:00。

只输出 JSON，不要多余文字：
{"cron": "0 8 * * 1-5", "explain": "工作日每天 8:00"}
如果这句话无法用 cron 表达（如每月最后一天），输出：
{"cron": null, "explain": "原因，并给出最接近的写法建议"}`;

function parseJson(text) {
  const s = String(text || '').trim();
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fallthrough */ }
    }
  }
  return null;
}

/** 校验并规范化：去多余空格，只接受 5 段（不让 AI 写秒） */
function checkCron(expr) {
  const e = String(expr || '').trim().replace(/\s+/g, ' ');
  if (!e) return { error: '表达式为空' };
  if (e.split(' ').length !== 5) return { error: `须为 5 段「分 时 日 月 周」，实际 ${e.split(' ').length} 段：${e}` };
  if (!cron.validate(e)) return { error: `node-cron 校验不通过：${e}` };
  return { expr: e };
}

/**
 * @param {(messages: Array<{role: string, content: string}>) => Promise<string>} llm
 * @param {string} instruction 用户的一句话，如「工作日早上 8 点半」
 * @returns {Promise<{ cron_expr: string, explain: string, attempts: number }>}
 */
async function draftCron(llm, instruction) {
  const text = String(instruction || '').trim();
  if (!text) throw new CronDraftError('请描述想要的执行时间，如「工作日早上 8 点半」');
  if (text.length > 200) throw new CronDraftError('描述太长，请控制在 200 字以内');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: text },
  ];
  let lastError = '';
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const reply = await llm(messages);
    const out = parseJson(reply);
    if (!out || typeof out !== 'object') {
      lastError = 'AI 返回的不是 JSON';
    } else if (out.cron == null || out.cron === '') {
      throw new CronDraftError(String(out.explain || '这个时间规则无法用 cron 表达'));
    } else {
      const c = checkCron(out.cron);
      if (c.expr) return { cron_expr: c.expr, explain: String(out.explain || ''), attempts: round };
      lastError = c.error;
    }
    messages.push({ role: 'assistant', content: String(reply || '') });
    messages.push({ role: 'user', content: `${lastError}。请按要求修正，只输出 JSON。` });
  }
  throw new CronDraftError(`AI 未能生成有效的表达式（${lastError}），请换个说法或手动填写`);
}

module.exports = { draftCron, checkCron, CronDraftError };
