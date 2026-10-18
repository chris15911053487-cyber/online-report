/**
 * BI 命名查询的参数：类型、取值约束与取值转换（保存时校验默认值、执行时校验入参共用这一份规则）。
 *
 * 参数定义 { name, type, label, required, default?, options?, optionsQuery?, min?, max? }：
 * - type：string / number / date / bool / month（'YYYY-MM' 文本）/ list（多个值，绑定为 JSON 数组文本，
 *   SQL 里写 IN (SELECT value FROM OPENJSON(@x))）
 * - options：固定可选值 [{ value, label }]（string / number / list）；传入不在其中的值直接报错并列出可选值，
 *   不会悄悄落进 SQL 的 ELSE 分支算出错的数
 * - optionsQuery：可选值来自另一条命名查询 { queryKey, valueColumn, labelColumn? }（下拉用；执行时不逐值核对）
 * - min / max：number 的取值范围
 * - 动态值记号（$thisMonth 等，见 bi-tokens.js）可用于 date / month / number 参数（默认值或入参都行）
 */
const { TOKENS, resolveToken } = require('./bi-tokens');

const PARAM_TYPES = new Set(['string', 'number', 'date', 'bool', 'month', 'list']);
const MAX_STRING_PARAM = 400;
const MAX_LIST_ITEMS = 200;
const MAX_LIST_JSON = 8000;
const MAX_OPTIONS = 100;
const QUERY_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const COLUMN_RE = /^[^\s[\]"'`;]{1,128}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
// 月份：2026-09 / 2026-9 / 2026/09 / 2026.09 / 202609，也接受带日的日期（取年月）
const MONTH_RE = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.]\d{1,2})?|(\d{2}))$/;
// 多选的文本写法：逗号、顿号、分号、换行分隔
const LIST_SPLIT_RE = /[,，、;；\n]+/;

/** 每种类型可用的动态值记号 */
const TOKENS_FOR = {
  date: ['$today', '$yesterday', '$monthStart', '$yearStart'],
  month: ['$thisMonth', '$lastMonth'],
  number: ['$thisYear', '$lastYear'],
};

class BiParamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BiParamError';
    this.code = 'BI_BAD_PARAM';
  }
}

const nameOf = (def) => def.label || def.name;
const isScalar = (v) => ['string', 'number', 'boolean'].includes(typeof v);

/** 可选值说明：yoy（同比）、mom（环比）；太多时只列前 10 个 */
function describeOptions(options) {
  const shown = options.slice(0, 10).map((o) => (String(o.value) === String(o.label) ? String(o.value) : `${o.value}（${o.label}）`));
  return shown.join('、') + (options.length > 10 ? ` 等 ${options.length} 个` : '');
}

/** 在固定可选值里找（按文本比较，数字 1 与 '1' 视为同一个）；找不到报错 */
function pickOption(def, v) {
  const hit = def.options.find((o) => String(o.value) === String(v));
  if (!hit) throw new BiParamError(`参数「${nameOf(def)}」的值「${v}」不在可选值中，可选：${describeOptions(def.options)}`);
  return hit.value;
}

function coerceNumber(def, raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) throw new BiParamError(`参数「${nameOf(def)}」须为数字`);
  if (def.min != null && n < def.min) throw new BiParamError(`参数「${nameOf(def)}」不能小于 ${def.min}`);
  if (def.max != null && n > def.max) throw new BiParamError(`参数「${nameOf(def)}」不能大于 ${def.max}`);
  return n;
}

function coerceMonth(def, raw) {
  const m = String(raw).trim().match(MONTH_RE);
  const y = m ? Number(m[1]) : NaN;
  const mo = m ? Number(m[2] ?? m[3]) : NaN;
  if (!m || mo < 1 || mo > 12 || y < 1900) throw new BiParamError(`参数「${nameOf(def)}」须为月份（YYYY-MM，如 2026-09）`);
  return `${m[1]}-${String(mo).padStart(2, '0')}`;
}

function coerceDate(def, raw) {
  const m = String(raw).trim().match(DATE_RE);
  if (!m) throw new BiParamError(`参数「${nameOf(def)}」须为日期（YYYY-MM-DD）`);
  // 校验真实存在的日期（2026-02-30 之类直接拒绝），统一成 YYYY-MM-DD[ HH:mm:ss]
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new BiParamError(`参数「${nameOf(def)}」不是有效日期`);
  }
  const time = m[4] ? ` ${m[4]}:${m[5]}:${m[6] || '00'}` : '';
  return `${m[1]}-${m[2]}-${m[3]}${time}`;
}

function coerceString(def, raw) {
  if (typeof raw === 'object') throw new BiParamError(`参数「${nameOf(def)}」须为文本（单个值，多个值请把参数类型设为多选）`);
  const s = String(raw);
  if (s.length > MAX_STRING_PARAM) throw new BiParamError(`参数「${nameOf(def)}」不能超过 ${MAX_STRING_PARAM} 字符`);
  return s;
}

/** 多选：数组、JSON 数组文本或「A,B,C」都接受；去空、去重；空列表 = 不限（NULL） */
function coerceList(def, raw) {
  let items;
  if (Array.isArray(raw)) items = raw;
  else if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      items = JSON.parse(raw);
    } catch {
      throw new BiParamError(`参数「${nameOf(def)}」不是合法的列表`);
    }
    if (!Array.isArray(items)) throw new BiParamError(`参数「${nameOf(def)}」不是合法的列表`);
  } else if (isScalar(raw)) items = String(raw).split(LIST_SPLIT_RE);
  else throw new BiParamError(`参数「${nameOf(def)}」须为列表`);
  const out = [];
  for (const it of items) {
    if (it == null || it === '') continue;
    if (!isScalar(it)) throw new BiParamError(`参数「${nameOf(def)}」的每一项须为简单值`);
    const s = String(def.options ? pickOption(def, String(it).trim()) : it).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  if (out.length > MAX_LIST_ITEMS) throw new BiParamError(`参数「${nameOf(def)}」最多选 ${MAX_LIST_ITEMS} 项`);
  if (JSON.stringify(out).length > MAX_LIST_JSON) throw new BiParamError(`参数「${nameOf(def)}」内容过长`);
  return out.length > 0 ? out : null;
}

/**
 * 单个参数值转换；返回 { value }，value 为 null 表示绑定 NULL。
 * list 的 value 是字符串数组（绑定时转 JSON 文本）。
 */
function coerceParam(def, raw, now = Date.now()) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  if (typeof raw === 'string' && TOKENS_FOR[def.type]?.includes(raw.trim())) raw = resolveToken(raw.trim(), now);
  switch (def.type) {
    case 'number': {
      const n = coerceNumber(def, raw);
      return { value: def.options ? Number(pickOption(def, n)) : n };
    }
    case 'bool': {
      if (raw === true || raw === 1 || raw === '1' || raw === 'true') return { value: true };
      if (raw === false || raw === 0 || raw === '0' || raw === 'false') return { value: false };
      throw new BiParamError(`参数「${nameOf(def)}」须为 true / false`);
    }
    case 'date':
      return { value: coerceDate(def, raw) };
    case 'month':
      return { value: coerceMonth(def, raw) };
    case 'list':
      return { value: coerceList(def, raw) };
    default: {
      const s = coerceString(def, raw);
      return { value: def.options ? String(pickOption(def, s)) : s };
    }
  }
}

/**
 * 按定义解析全部参数：入参按名字大小写不敏感匹配，缺省用 default，缺必填报错。
 * 返回 { name: value } ——只含定义里声明的参数，顺序与定义一致（用于缓存 key 稳定）。
 */
function resolveParams(defs, input, now = Date.now()) {
  const src = {};
  for (const [k, v] of Object.entries(input && typeof input === 'object' ? input : {})) {
    src[String(k).replace(/^@/, '').toLowerCase()] = v;
  }
  const out = {};
  for (const def of defs || []) {
    const key = def.name.toLowerCase();
    let raw = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
    if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) raw = def.default;
    const { value } = coerceParam(def, raw, now);
    if (value === null && def.required) {
      throw new BiParamError(`缺少必填参数「${nameOf(def)}」`);
    }
    out[def.name] = value;
  }
  return out;
}

// ─── 定义校验（保存查询时） ────────────────────────────────────────────────

/** 规范化取值约束；返回 { ok, error?, value }（value 为要合并进参数定义的字段） */
function normalizeConstraints(raw, def) {
  const where = `参数「${def.name}」`;
  const out = {};
  const hasOptions = Array.isArray(raw.options) && raw.options.length > 0;
  const hasQuery = raw.optionsQuery && typeof raw.optionsQuery === 'object' && raw.optionsQuery.queryKey;
  if ((hasOptions || hasQuery) && !['string', 'number', 'list'].includes(def.type)) {
    return { ok: false, error: `${where}：只有文本 / 数字 / 多选参数能设置可选值` };
  }
  if (hasOptions && hasQuery) return { ok: false, error: `${where}：固定可选值与「来自查询」只能选一种` };
  if (hasOptions) {
    if (raw.options.length > MAX_OPTIONS) return { ok: false, error: `${where}：可选值不能超过 ${MAX_OPTIONS} 个` };
    const options = [];
    const seen = new Set();
    for (const o of raw.options) {
      const isObj = o && typeof o === 'object' && !Array.isArray(o);
      let value = isObj ? o.value : o;
      if (!isScalar(value) || String(value).trim() === '') return { ok: false, error: `${where}：可选值须为简单值` };
      if (def.type === 'number') {
        value = Number(value);
        if (!Number.isFinite(value)) return { ok: false, error: `${where}：数字参数的可选值须为数字` };
      } else value = String(value).trim().slice(0, MAX_STRING_PARAM);
      if (seen.has(String(value))) return { ok: false, error: `${where}：可选值「${value}」重复` };
      seen.add(String(value));
      const label = String((isObj ? o.label : null) ?? value).trim().slice(0, 64) || String(value);
      options.push({ value, label });
    }
    out.options = options;
  }
  if (hasQuery) {
    const q = raw.optionsQuery;
    const queryKey = String(q.queryKey || '').trim().toLowerCase();
    const valueColumn = String(q.valueColumn || '').trim();
    const labelColumn = String(q.labelColumn || '').trim();
    if (!QUERY_KEY_RE.test(queryKey)) return { ok: false, error: `${where}：选项来源查询标识非法` };
    if (!COLUMN_RE.test(valueColumn)) return { ok: false, error: `${where}：请选择选项来源的取值列` };
    if (labelColumn && !COLUMN_RE.test(labelColumn)) return { ok: false, error: `${where}：选项来源的显示列非法` };
    out.optionsQuery = { queryKey, valueColumn, ...(labelColumn && labelColumn !== valueColumn ? { labelColumn } : {}) };
  }
  for (const k of ['min', 'max']) {
    if (raw[k] == null || raw[k] === '') continue;
    if (def.type !== 'number') return { ok: false, error: `${where}：只有数字参数能设置范围` };
    const n = Number(raw[k]);
    if (!Number.isFinite(n)) return { ok: false, error: `${where}：${k === 'min' ? '最小值' : '最大值'}须为数字` };
    out[k] = n;
  }
  if (out.min != null && out.max != null && out.min > out.max) return { ok: false, error: `${where}：最小值不能大于最大值` };
  return { ok: true, value: out };
}

/** 默认值：list 可写数组；date / month / number 可写对应的动态值记号；须能通过取值校验 */
function normalizeDefault(raw, def) {
  const v = raw.default;
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) return { ok: true, value: undefined };
  const where = `参数「${def.name}」`;
  if (Array.isArray(v) ? def.type !== 'list' : typeof v === 'object') return { ok: false, error: `${where}默认值须为简单值` };
  if (typeof v === 'string' && v.startsWith('$') && TOKENS.includes(v) && !TOKENS_FOR[def.type]?.includes(v)) {
    return { ok: false, error: `${where}：动态值 ${v} 不适用于该类型${TOKENS_FOR[def.type] ? `（可用 ${TOKENS_FOR[def.type].join(' ')}）` : ''}` };
  }
  try {
    coerceParam(def, v);
  } catch (err) {
    return { ok: false, error: `${where}默认值：${err.message}` };
  }
  // 记号原样保存（运行时按当天解析）；其余按原样保存（list 规范成数组）
  if (def.type === 'list') return { ok: true, value: coerceParam(def, v).value ?? undefined };
  return { ok: true, value: v };
}

const MAX_QUERY_OPTIONS = 500;

/** 来自查询的选项：按取值列去重（保持查询的顺序），显示列为空时用取值；最多 MAX_QUERY_OPTIONS 个 */
function optionsFromRows(rows, valueColumn, labelColumn) {
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    const v = r?.[valueColumn];
    if (v == null || v === '' || !isScalar(v)) continue;
    const key = String(v);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = labelColumn && r[labelColumn] != null && r[labelColumn] !== '' ? String(r[labelColumn]) : key;
    out.push({ value: typeof v === 'number' ? v : key, label });
    if (out.length >= MAX_QUERY_OPTIONS) return { options: out, truncated: true };
  }
  return { options: out, truncated: false };
}

/**
 * 「来自查询」的来源检查（保存查询时）：来源存在、不需要必填参数（选项查询按自身默认值执行）、
 * 登记了输出列时取值 / 显示列在其中。queriesByKey：Map<queryKey, 查询定义>。返回问题列表。
 */
function optionsQueryProblems(params, queriesByKey) {
  const problems = [];
  for (const p of params || []) {
    const oq = p.optionsQuery;
    if (!oq) continue;
    const where = `参数「${p.label || p.name}」的选项来源`;
    const src = queriesByKey.get(oq.queryKey);
    if (!src) {
      problems.push(`${where}：查询「${oq.queryKey}」不存在`);
      continue;
    }
    const need = (src.params || []).filter((x) => x.required && x.default == null);
    if (need.length > 0) problems.push(`${where}：查询「${src.label}」有必填参数（${need.map((x) => x.name).join('、')}），不能用作选项来源`);
    const cols = (src.columns || []).length > 0 ? new Set(src.columns.map((c) => c.column)) : null;
    for (const c of [oq.valueColumn, oq.labelColumn].filter(Boolean)) {
      if (cols && !cols.has(c)) problems.push(`${where}：列「${c}」不在查询「${src.label}」的输出列中`);
    }
  }
  return problems;
}

module.exports = {
  optionsFromRows,
  optionsQueryProblems,
  MAX_QUERY_OPTIONS,
  PARAM_TYPES,
  TOKENS_FOR,
  MAX_STRING_PARAM,
  MAX_LIST_ITEMS,
  BiParamError,
  coerceParam,
  resolveParams,
  normalizeConstraints,
  normalizeDefault,
  describeOptions,
};
