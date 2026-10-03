/**
 * BI 命名查询执行器：参数化执行 + 结果缓存。
 *
 * - 参数：按查询定义的类型转换并 .input() 绑定，未声明的入参忽略，缺必填报错；
 * - 限行：流式读取，最多 BI_MAX_ROWS 行（默认 2000），超过只标记 truncated；
 * - 缓存 key = 查询 + 规范化参数 + 排序后的角色集合：不同角色组合绝不共享结果
 *   （同一条查询将来可能按角色返回不同列/行，例如成本字段，宁可多查也不串数据）；
 * - 同 key 并发只查一次；过期后在 stale 窗口内先返回旧数据并后台刷新；
 * - 查询定义变更时（bi-queries onQueryChanged）立即清掉该查询的缓存。
 *
 * 返回对象被多个请求共享，调用方不要修改。
 */
const { sql } = require('./db');
const { runSqlLimited } = require('./agent-sql');
const { onQueryChanged } = require('./bi-queries');

class BiParamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BiParamError';
    this.code = 'BI_BAD_PARAM';
  }
}

function envInt(name, fallback, min = 0) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const MAX_STRING_PARAM = 400;

/** 单个参数值转换；返回 { value, type }，value 为 null 表示绑定 NULL */
function coerceParam(def, raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  switch (def.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw new BiParamError(`参数「${def.label || def.name}」须为数字`);
      return { value: n };
    }
    case 'bool': {
      if (raw === true || raw === 1 || raw === '1' || raw === 'true') return { value: true };
      if (raw === false || raw === 0 || raw === '0' || raw === 'false') return { value: false };
      throw new BiParamError(`参数「${def.label || def.name}」须为 true / false`);
    }
    case 'date': {
      const s = String(raw).trim();
      const m = s.match(DATE_RE);
      if (!m) throw new BiParamError(`参数「${def.label || def.name}」须为日期（YYYY-MM-DD）`);
      // 校验真实存在的日期（2026-02-30 之类直接拒绝），统一成 YYYY-MM-DD[ HH:mm:ss]
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
        throw new BiParamError(`参数「${def.label || def.name}」不是有效日期`);
      }
      const time = m[4] ? ` ${m[4]}:${m[5]}:${m[6] || '00'}` : '';
      return { value: `${m[1]}-${m[2]}-${m[3]}${time}` };
    }
    default: {
      if (typeof raw === 'object') throw new BiParamError(`参数「${def.label || def.name}」须为文本`);
      const s = String(raw);
      if (s.length > MAX_STRING_PARAM) {
        throw new BiParamError(`参数「${def.label || def.name}」不能超过 ${MAX_STRING_PARAM} 字符`);
      }
      return { value: s };
    }
  }
}

/**
 * 按定义解析全部参数：入参按名字大小写不敏感匹配，缺省用 default，缺必填报错。
 * 返回 { name: value } ——只含定义里声明的参数，顺序与定义一致（用于缓存 key 稳定）。
 */
function resolveParams(defs, input) {
  const src = {};
  for (const [k, v] of Object.entries(input && typeof input === 'object' ? input : {})) {
    src[String(k).replace(/^@/, '').toLowerCase()] = v;
  }
  const out = {};
  for (const def of defs || []) {
    const key = def.name.toLowerCase();
    let raw = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
    if (raw === undefined || raw === null || raw === '') raw = def.default;
    const { value } = coerceParam(def, raw);
    if (value === null && def.required) {
      throw new BiParamError(`缺少必填参数「${def.label || def.name}」`);
    }
    out[def.name] = value;
  }
  return out;
}

function sqlTypeFor(def) {
  switch (def.type) {
    case 'number':
      return sql.Decimal(38, 10);
    case 'bool':
      return sql.Bit;
    case 'date':
      return sql.DateTime2(0);
    default:
      return sql.NVarChar(MAX_STRING_PARAM);
  }
}

/** 真正执行：绑定参数 + 流式限行 */
async function executeQuery(pool, query, params, opts = {}) {
  const maxRows = opts.maxRows > 0 ? opts.maxRows : envInt('BI_MAX_ROWS', 2000, 1);
  const request = pool.request();
  request.timeout = envInt('BI_QUERY_TIMEOUT_MS', 30000, 1000);
  for (const def of query.params || []) {
    const v = params[def.name];
    request.input(def.name, sqlTypeFor(def), def.type === 'number' && v != null ? String(v) : v);
  }
  // hardCap = maxRows + 1：只需知道「是否超出」，不为统计总数扫完大结果集
  const r = await runSqlLimited(request, query.sqlText, { limit: maxRows, hardCap: maxRows + 1 });
  return {
    columns: r.columns,
    columnTypes: r.columnTypes || {},
    rows: r.rows,
    rowCount: r.rows.length,
    truncated: r.truncated,
  };
}

function cacheKey(query, params, roles) {
  const r = [...new Set((roles || []).map((x) => String(x).toLowerCase()))].sort().join(',');
  return `${query.queryKey}|${query.updatedAt || ''}|${JSON.stringify(params)}|${r}`;
}

/**
 * 创建执行器（测试可注入 execute / now）。
 * @param {{ execute?: Function, now?: () => number, maxEntries?: number, staleSecs?: number, log?: object }} [deps]
 */
function createBiExecutor(deps = {}) {
  const execute = deps.execute || executeQuery;
  const now = deps.now || (() => Date.now());
  const maxEntries = deps.maxEntries ?? envInt('BI_CACHE_MAX_ENTRIES', 500, 1);
  // 过期后仍可「先返回旧数据」的时长；超过则必须等新数据
  const staleSecs = deps.staleSecs ?? envInt('BI_CACHE_STALE_SECS', 3600, 0);
  const log = deps.log || console;

  const cache = new Map(); // key -> { result, at, queryKey }
  const inflight = new Map(); // key -> Promise<result>

  function store(key, queryKey, result) {
    cache.delete(key);
    cache.set(key, { result, at: now(), queryKey });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  function fetchFresh(key, pool, query, params, ttlSecs) {
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = Promise.resolve()
      .then(() => execute(pool, query, params))
      .then((data) => {
        const result = { ...data, asOf: new Date(now()).toISOString() };
        if (ttlSecs > 0) store(key, query.queryKey, result);
        return result;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /**
   * @param {{ pool, query, params?, roles?, refresh?: boolean }} args
   * @returns {Promise<{columns, rows, rowCount, truncated, asOf, cached, stale, params}>}
   */
  async function run({ pool, query, params, roles, refresh = false }) {
    const resolved = resolveParams(query.params, params);
    const ttlSecs = Math.max(0, Number(query.cacheSecs) || 0);
    const key = cacheKey(query, resolved, roles);
    const decorate = (result, cached, stale) => ({ ...result, cached, stale, params: resolved });

    if (ttlSecs > 0 && !refresh) {
      const hit = cache.get(key);
      if (hit) {
        const age = (now() - hit.at) / 1000;
        if (age < ttlSecs) return decorate(hit.result, true, false);
        if (age < ttlSecs + staleSecs) {
          // 先返回旧数据，后台刷新（失败保留旧数据，下次再试）
          fetchFresh(key, pool, query, resolved, ttlSecs).catch((err) => {
            log.warn?.(`[bi] 后台刷新失败 ${query.queryKey}: ${err.message}`);
          });
          return decorate(hit.result, true, true);
        }
      }
    }
    const result = await fetchFresh(key, pool, query, resolved, ttlSecs);
    return decorate(result, false, false);
  }

  function invalidate(queryKey) {
    if (!queryKey) {
      cache.clear();
      return;
    }
    const k = String(queryKey).toLowerCase();
    for (const [key, entry] of cache) if (entry.queryKey === k) cache.delete(key);
  }

  return { run, invalidate, stats: () => ({ entries: cache.size, inflight: inflight.size }) };
}

// 默认实例：定义变更即清缓存
const defaultExecutor = createBiExecutor();
onQueryChanged((queryKey) => defaultExecutor.invalidate(queryKey));

/** 不走缓存的试运行（管理侧） */
async function testRunQuery(pool, query, params, maxRows = 50) {
  const resolved = resolveParams(query.params, params);
  const started = Date.now();
  const data = await executeQuery(pool, query, resolved, { maxRows });
  return { ...data, params: resolved, durationMs: Date.now() - started };
}

module.exports = {
  BiParamError,
  coerceParam,
  resolveParams,
  executeQuery,
  createBiExecutor,
  runNamedQuery: (args) => defaultExecutor.run(args),
  invalidateBiCache: (queryKey) => defaultExecutor.invalidate(queryKey),
  testRunQuery,
};
