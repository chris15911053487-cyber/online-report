/**
 * AI 起草「以 SQL 为主」的 Skill：管理员说一句需求，AI 读真实表结构写出 Skill 正文（用到的表 / 口径 / 查询模式 / 输出），
 * 每条查询模式都在库里试跑，报错交回 AI 修正；返回草稿（不保存），表白名单 = 选中的表。
 *
 * 流程与 bi-draft 一致：选表 → 读结构（INFORMATION_SCHEMA + CUFD）→ 生成 → 只读校验 + 白名单 + 试运行 → 修正 ≤ MAX_ATTEMPTS 轮。
 * 安全：仅管理员可调；查询只读校验（validateReadonlySql）+ 禁用表（isDeniedTable）+ 白名单（checkSqlTablesAllowed），试运行只取前几行。
 */
const { validateReadonlySql } = require('./bi-queries');
const { PICK_SYSTEM, describeTables, listCustomTables, parseJsonObject, referencedDeniedTables, DraftError } = require('./bi-draft');
const { checkSqlTablesAllowed, SKILL_NAME_RE } = require('./agent-skills');

const MAX_ATTEMPTS = 3;
const MAX_QUERIES = 5;
const SAMPLE_LIMIT = 5;

const GEN_SYSTEM = `你是 SAP Business One（SQL Server）数据专家，为 AI Agent 编写「Skill」：Agent 照着 Skill 用 run_sql 查数据、写报告。
Skill 要**以 SQL 为主**：写清用到的表和字段含义、取数口径、几条可直接执行的查询模式，再一句话说清输出格式。不要写「目标 / 步骤 / 注意事项」之类的空话。

## SQL 规则（每条查询模式都会在库里试跑）
- 只能是一条 SELECT 或 WITH ... SELECT；禁止 DECLARE / SET / INSERT / UPDATE / DELETE / EXEC / INTO / 临时表 / 多语句 / GO
- 不要用 @参数 或变量，必须能直接执行；Agent 用时自己改日期和 TOP 数量
- 只用给出的表与列；SAP 自定义表以 @ 开头，必须加方括号：FROM [@U_OHEC] T0
- 「今天」按中国时间：CAST(DATEADD(HOUR,8,SYSUTCDATETIME()) AS DATE)，不要用 GETDATE()
- 排除已取消单据（CANCELED = 'N'）；金额按本币（DocTotal / LineTotal 等）
- 输出列别名用中文（如 AS 客户名称、AS 金额），报告直接可用
- 明细类加 TOP，结果行数通常 ≤ 50

## 输出（只返回 JSON，不要其它文字）
{
  "name": "小写字母开头、仅含小写字母/数字/连字符，如 sales-order-daily",
  "description": "一句话：做什么 + 只查哪些表 + 关键口径（决定 Agent 何时用这个 Skill）",
  "title": "中文标题，如 销售订单日报",
  "tables": [{"table": "ORDR", "label": "销售订单表头", "columns": "DocNum 单号、DocDate 单据日期、CANCELED（'Y' 已取消）"}],
  "rules": ["口径，每条一句，如 一律排除已取消：CANCELED = 'N'"],
  "queries": [{"title": "这条查什么，如 昨天下单金额前 5 的客户", "sql": "SELECT ..."}],
  "output": "输出要求 1~2 句，如 先 3 句话结论，再给表格；查不到数据就直说，不要编数字"
}
queries 2~${MAX_QUERIES} 条，覆盖需求里提到的每个统计；tables 只列 SQL 真正用到的表，columns 只写用到的字段及含义。`;

/** 把结构化草稿拼成 Skill 正文（与说明书示例 1 的格式一致） */
function buildSkillBody(d) {
  const lines = [`# ${d.title}`, '', '## 用到的表'];
  for (const t of d.tables) lines.push(`- ${t.table}${t.label ? ` ${t.label}` : ''}：${t.columns}`);
  if (d.rules.length > 0) {
    lines.push('', '## 口径');
    for (const r of d.rules) lines.push(`- ${r}`);
  }
  lines.push('', '## 查询模式（照这几条写，只改日期和 TOP 数量）');
  d.queries.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.title}：`, '```sql', q.sql.trim(), '```');
  });
  if (d.output) lines.push('', '## 输出', d.output);
  return lines.join('\n');
}

function normalizeDraft(out) {
  const str = (v) => String(v ?? '').trim();
  return {
    name: str(out.name).toLowerCase(),
    description: str(out.description),
    title: str(out.title) || str(out.name),
    tables: (Array.isArray(out.tables) ? out.tables : [])
      .map((t) => ({ table: str(t?.table), label: str(t?.label), columns: str(t?.columns) }))
      .filter((t) => t.table),
    rules: (Array.isArray(out.rules) ? out.rules : []).map(str).filter(Boolean),
    queries: (Array.isArray(out.queries) ? out.queries : [])
      .slice(0, MAX_QUERIES)
      .map((q) => ({ title: str(q?.title), sql: str(q?.sql).replace(/;\s*$/, '') }))
      .filter((q) => q.sql),
    output: str(out.output),
  };
}

/** 单条查询模式：只读校验 → 不能有参数 → 禁用表 → 白名单 → 试运行。返回 { ok, rowCount } 或 { ok:false, error } */
async function checkQuery(q, allowedTables, run) {
  const v = validateReadonlySql(q.sql);
  if (!v.ok) return { ok: false, error: v.error };
  if (v.params.length > 0) return { ok: false, error: `不要用参数 / 变量（${v.params.map((p) => '@' + p).join('、')}），写成能直接执行的 SQL` };
  const denied = referencedDeniedTables(q.sql);
  if (denied.length > 0) return { ok: false, error: `不允许使用这些表：${denied.join('、')}` };
  const allow = checkSqlTablesAllowed(q.sql, allowedTables);
  if (!allow.ok) return { ok: false, error: `只能用这些表：${allowedTables.join(', ')}，不能用 ${allow.bad.join(', ')}` };
  try {
    const r = await run(q.sql);
    return { ok: true, rowCount: r.totalRowCount ?? (r.rows || []).length, columns: r.columns || [] };
  } catch (err) {
    return { ok: false, error: `试运行报错：${String(err?.message || err).slice(0, 400)}` };
  }
}

/**
 * @param {object} deps
 *   - pool：mssql 连接池
 *   - llm(messages) → Promise<string>
 *   - run(sql) → Promise<{ columns, rows, totalRowCount }>：只读试运行（取前几行）
 *   - existingNames?：已有 Skill 名（避免重名）
 * @param {string} requirement
 * @returns {Promise<{ skill: { name, description, bodyMd, allowedTables }, checks: Array<{ title, rowCount, columns }>, attempts: number }>}
 */
async function draftSqlSkill(deps, requirement) {
  const { pool, llm, run, existingNames = [] } = deps;
  const need = String(requirement || '').trim();
  if (need.length < 5) throw new DraftError('需求描述太短，请说清要统计什么，比如「每天的销售订单日报：订单数、金额、前 5 客户、逾期未清订单」');
  if (need.length > 1000) throw new DraftError('需求描述不能超过 1000 字');

  // 1. 选表
  const custom = await listCustomTables(pool);
  const pick = parseJsonObject(
    await llm([
      { role: 'system', content: PICK_SYSTEM },
      { role: 'user', content: `需求：${need}\n\n本库自定义表 / 视图：${custom.join('、') || '（无）'}` },
    ]),
  );
  const picked = Array.isArray(pick?.tables) ? pick.tables.map(String) : [];
  if (picked.length === 0) throw new DraftError('AI 没有选出需要的表，请把需求说具体些（查什么数、按什么分）');

  // 2. 读结构
  const schema = await describeTables(pool, picked);
  if (schema.length === 0) throw new DraftError(`AI 选的表在库里都不存在或不允许使用：${picked.join('、')}`);
  const tableNames = schema.map((t) => t.table);
  const schemaText = schema.map((t) => `### ${t.table}\n${t.columns.join(', ')}`).join('\n\n');
  const taken = new Set(existingNames.map((n) => String(n).toLowerCase()));

  // 3~4. 生成 → 校验 → 试运行 → 修正
  const messages = [
    { role: 'system', content: GEN_SYSTEM },
    {
      role: 'user',
      content: `需求：${need}\n\n已有 Skill 名（不要重名）：${[...taken].join('、') || '（无）'}\n\n可用表（只能用这些）结构（列:类型(自定义字段说明)）：\n${schemaText}`,
    },
  ];
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const text = await llm(messages);
    messages.push({ role: 'assistant', content: text });
    const fix = (msg) => {
      lastError = msg;
      messages.push({ role: 'user', content: `${msg}\n请修正后按同样的 JSON 格式完整返回。` });
    };
    const out = parseJsonObject(text);
    if (!out) {
      fix('返回内容不是要求的 JSON。');
      continue;
    }
    const d = normalizeDraft(out);
    if (!SKILL_NAME_RE.test(d.name)) {
      fix('name 须为小写字母开头、仅含小写字母/数字/连字符。');
      continue;
    }
    if (taken.has(d.name)) {
      fix(`name「${d.name}」已存在，换一个。`);
      continue;
    }
    if (!d.description || d.queries.length === 0 || d.tables.length === 0) {
      fix('description、tables、queries 都不能为空。');
      continue;
    }
    const checks = [];
    const errors = [];
    for (const [i, q] of d.queries.entries()) {
      const c = await checkQuery(q, tableNames, run);
      if (c.ok) checks.push({ title: q.title, rowCount: c.rowCount, columns: c.columns });
      else errors.push(`第 ${i + 1} 条「${q.title}」：${c.error}`);
    }
    if (errors.length > 0) {
      fix(`查询模式有误：${errors.join('；')}`);
      continue;
    }
    // 白名单只放 SQL 真正用到的表
    const used = new Set(d.queries.flatMap((q) => checkSqlTablesAllowed(q.sql, []).used));
    const allowedTables = tableNames.filter((t) => used.has(t.toLowerCase()));
    return {
      skill: { name: d.name, description: d.description, bodyMd: buildSkillBody(d), allowedTables },
      checks,
      attempts: attempt,
    };
  }
  throw new DraftError(`AI 修正 ${MAX_ATTEMPTS} 次仍未成功：${lastError}`);
}

module.exports = { draftSqlSkill, buildSkillBody, checkQuery };
