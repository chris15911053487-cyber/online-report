const { getPool, sql } = require('./db');
const { SQL_CHINA_LOCAL_NOW_EXPR } = require('./china-datetime');
const {
  detectTemplateKind,
  normalizeTemplate,
  buildReportSessionInject,
  executeReportQuery,
} = require('./report-query');
const {
  parseMenuRolesJson,
  canAccessMenu,
  getUserRolesFromRequest,
  menuRolesToJson,
  normalizeMenuRolesInput,
} = require('./roles');

const MAX_ALERT_ROWS = 500;
const ruleResultCache = new Map();

function jsonSafeValue(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (v == null) return '';
  return v;
}

function itemKeyFromRow(row, keyColumn) {
  const col = String(keyColumn || '').trim();
  if (!col) return '';
  const val = row[col];
  if (val == null) return '';
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'bigint') return String(Number(val));
  return String(val).trim();
}

function renderTitle(row, titleTemplate) {
  const tpl = String(titleTemplate || '').trim();
  if (!tpl) return '';
  return tpl.replace(/\{([^}]+)\}/g, (_, col) => {
    const key = String(col || '').trim();
    const val = row[key];
    return val == null ? '' : String(jsonSafeValue(val));
  });
}

function mapRuleRow(row) {
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    sqlTemplate: String(row.sql_template || ''),
    keyColumn: String(row.key_column || ''),
    titleTemplate: String(row.title_template || ''),
    roles: parseMenuRolesJson(row.roles_json),
    refreshSeconds: Math.max(15, Number(row.refresh_seconds) || 60),
    enabled: !!row.enabled,
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cacheKey(ruleId) {
  return `rule:${ruleId}`;
}

function getCachedRuleResult(ruleId) {
  const entry = ruleResultCache.get(cacheKey(ruleId));
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    ruleResultCache.delete(cacheKey(ruleId));
    return null;
  }
  return entry.result;
}

function setCachedRuleResult(ruleId, refreshSeconds, result) {
  const ttlMs = Math.max(15, Number(refreshSeconds) || 60) * 1000;
  ruleResultCache.set(cacheKey(ruleId), {
    result,
    expiresAt: Date.now() + ttlMs,
  });
}

function invalidateRuleCache(ruleId) {
  if (ruleId != null) ruleResultCache.delete(cacheKey(ruleId));
  else ruleResultCache.clear();
}

async function loadEnabledRules(pool) {
  const rs = await pool.request().query(
    `SELECT id, name, sql_template, key_column, title_template, roles_json,
            refresh_seconds, enabled, sort_order, created_at, updated_at
     FROM dbo.message_alert_rules
     WHERE enabled = 1
     ORDER BY sort_order ASC, id ASC`
  );
  return (rs.recordset || []).map(mapRuleRow);
}

async function loadRuleById(pool, ruleId) {
  const rs = await pool
    .request()
    .input('id', sql.Int, ruleId)
    .query(
      `SELECT id, name, sql_template, key_column, title_template, roles_json,
              refresh_seconds, enabled, sort_order, created_at, updated_at
       FROM dbo.message_alert_rules
       WHERE id = @id`
    );
  const row = rs.recordset && rs.recordset[0];
  return row ? mapRuleRow(row) : null;
}

async function loadAllRules(pool) {
  const rs = await pool.request().query(
    `SELECT id, name, sql_template, key_column, title_template, roles_json,
            refresh_seconds, enabled, sort_order, created_at, updated_at
     FROM dbo.message_alert_rules
     ORDER BY sort_order ASC, id ASC`
  );
  return (rs.recordset || []).map(mapRuleRow);
}

async function executeRuleQuery(pool, rule, sessionInject, { bypassCache = false } = {}) {
  if (!bypassCache) {
    const cached = getCachedRuleResult(rule.id);
    if (cached) return cached;
  }

  const template = normalizeTemplate(rule.sqlTemplate || '');
  const templateKind = detectTemplateKind(template);
  if (!templateKind) {
    const err = new Error('SQL 模板无效，须以 SELECT 或 EXEC 开头');
    err.code = 'ALERT_SQL_INVALID';
    throw err;
  }

  const rawResult = await executeReportQuery(pool, {
    templateKind,
    sqlTemplate: template,
    schemaFields: [],
    params: {},
    sessionInject,
    maxRows: MAX_ALERT_ROWS,
  });

  const result = {
    columns: rawResult.columns || [],
    rows: rawResult.rows || [],
    truncated: !!rawResult.truncated,
    fetchedAt: new Date().toISOString(),
  };

  if (!bypassCache) {
    setCachedRuleResult(rule.id, rule.refreshSeconds, result);
  }

  return result;
}

async function loadReadKeysForRules(pool, userCode, ruleIds) {
  const keysByRule = new Map();
  if (!ruleIds.length) return keysByRule;

  const req = pool.request().input('userCode', sql.NVarChar(64), userCode);
  const placeholders = ruleIds.map((id, i) => {
    req.input(`rid${i}`, sql.Int, id);
    return `@rid${i}`;
  });

  const rs = await req.query(
    `SELECT rule_id, item_key
     FROM dbo.message_alert_reads
     WHERE user_code = @userCode AND rule_id IN (${placeholders.join(', ')})`
  );

  for (const row of rs.recordset || []) {
    const rid = Number(row.rule_id);
    if (!keysByRule.has(rid)) keysByRule.set(rid, new Set());
    keysByRule.get(rid).add(String(row.item_key || ''));
  }
  return keysByRule;
}

function buildItemsFromResult(rule, queryResult, readKeys) {
  const readSet = readKeys || new Set();
  const keyColumn = rule.keyColumn;
  const items = [];
  let unread = 0;

  for (const row of queryResult.rows || []) {
    const key = itemKeyFromRow(row, keyColumn);
    if (!key) continue;
    const isUnread = !readSet.has(key);
    if (isUnread) unread += 1;
    const safeRow = {};
    for (const [k, v] of Object.entries(row)) {
      safeRow[k] = jsonSafeValue(v);
    }
    items.push({
      key,
      title: renderTitle(row, rule.titleTemplate) || key,
      unread: isUnread,
      row: safeRow,
    });
  }

  return {
    total: items.length,
    unread,
    items,
    columns: queryResult.columns || [],
    truncated: !!queryResult.truncated,
    fetchedAt: queryResult.fetchedAt,
  };
}

async function getSummaryForUser(user, pool) {
  const userRoles = getUserRolesFromRequest(user);
  const sessionInject = buildReportSessionInject(user);
  const rules = (await loadEnabledRules(pool)).filter((r) => canAccessMenu(userRoles, r.roles));

  const ruleIds = rules.map((r) => r.id);
  const readKeysByRule = await loadReadKeysForRules(pool, sessionInject.userCode, ruleIds);

  const summaryRules = [];
  let totalUnread = 0;

  for (const rule of rules) {
    try {
      const queryResult = await executeRuleQuery(pool, rule, sessionInject);
      const built = buildItemsFromResult(rule, queryResult, readKeysByRule.get(rule.id));
      totalUnread += built.unread;
      summaryRules.push({
        id: rule.id,
        name: rule.name,
        total: built.total,
        unread: built.unread,
        refreshSeconds: rule.refreshSeconds,
        fetchedAt: built.fetchedAt,
        error: null,
      });
    } catch (err) {
      summaryRules.push({
        id: rule.id,
        name: rule.name,
        total: 0,
        unread: 0,
        refreshSeconds: rule.refreshSeconds,
        fetchedAt: null,
        error: err.message || String(err),
      });
    }
  }

  const minRefresh = summaryRules.reduce(
    (min, r) => Math.min(min, r.refreshSeconds || 60),
    60
  );

  return {
    totalUnread,
    refreshSeconds: minRefresh,
    rules: summaryRules,
    refreshedAt: new Date().toISOString(),
  };
}

async function getRuleItemsForUser(user, pool, ruleId) {
  const userRoles = getUserRolesFromRequest(user);
  const sessionInject = buildReportSessionInject(user);
  const rule = await loadRuleById(pool, ruleId);

  if (!rule || !rule.enabled) {
    const err = new Error('提醒规则不存在或未启用');
    err.code = 'ALERT_RULE_NOT_FOUND';
    throw err;
  }
  if (!canAccessMenu(userRoles, rule.roles)) {
    const err = new Error('无权查看该提醒');
    err.code = 'ALERT_FORBIDDEN';
    throw err;
  }

  const queryResult = await executeRuleQuery(pool, rule, sessionInject);
  const readKeysByRule = await loadReadKeysForRules(pool, sessionInject.userCode, [rule.id]);
  const built = buildItemsFromResult(rule, queryResult, readKeysByRule.get(rule.id));

  return {
    rule: {
      id: rule.id,
      name: rule.name,
      keyColumn: rule.keyColumn,
      titleTemplate: rule.titleTemplate,
      refreshSeconds: rule.refreshSeconds,
    },
    ...built,
  };
}

async function markItemsRead(pool, userCode, ruleId, keys) {
  const list = [...new Set((keys || []).map((k) => String(k || '').trim()).filter(Boolean))];
  if (!list.length) return { marked: 0 };

  let marked = 0;
  for (const key of list) {
    await pool
      .request()
      .input('ruleId', sql.Int, ruleId)
      .input('userCode', sql.NVarChar(64), userCode)
      .input('itemKey', sql.NVarChar(512), key.slice(0, 512))
      .query(
        `MERGE dbo.message_alert_reads AS t
         USING (SELECT @ruleId AS rule_id, @userCode AS user_code, @itemKey AS item_key) AS s
         ON t.rule_id = s.rule_id AND t.user_code = s.user_code AND t.item_key = s.item_key
         WHEN NOT MATCHED THEN
           INSERT (rule_id, user_code, item_key, read_at)
           VALUES (s.rule_id, s.user_code, s.item_key, ${SQL_CHINA_LOCAL_NOW_EXPR});`
      );
    marked += 1;
  }
  return { marked };
}

async function markAllRead(pool, userCode, ruleId, rule) {
  const sessionInject = { userCode, displayName: userCode };
  const queryResult = await executeRuleQuery(pool, rule, sessionInject);
  const keys = [];
  for (const row of queryResult.rows || []) {
    const key = itemKeyFromRow(row, rule.keyColumn);
    if (key) keys.push(key);
  }
  return markItemsRead(pool, userCode, ruleId, keys);
}

async function testRuleSql(pool, user, sqlTemplate) {
  const sessionInject = buildReportSessionInject(user);
  const template = normalizeTemplate(sqlTemplate || '');
  const templateKind = detectTemplateKind(template);
  if (!templateKind) {
    const err = new Error('SQL 模板无效，须以 SELECT 或 EXEC 开头');
    err.code = 'ALERT_SQL_INVALID';
    throw err;
  }

  const rawResult = await executeReportQuery(pool, {
    templateKind,
    sqlTemplate: template,
    schemaFields: [],
    params: {},
    sessionInject,
    maxRows: 20,
  });

  const rows = (rawResult.rows || []).map((row) => {
    const safe = {};
    for (const [k, v] of Object.entries(row)) {
      safe[k] = jsonSafeValue(v);
    }
    return safe;
  });

  return {
    columns: rawResult.columns || [],
    rows,
    truncated: !!rawResult.truncated,
  };
}

async function createRule(pool, body) {
  const roles = await normalizeMenuRolesInput(pool, body.roles || []);
  const rs = await pool
    .request()
    .input('name', sql.NVarChar(128), String(body.name || '').trim())
    .input('sqlTemplate', sql.NVarChar(sql.MAX), String(body.sqlTemplate || '').trim())
    .input('keyColumn', sql.NVarChar(128), String(body.keyColumn || '').trim())
    .input('titleTemplate', sql.NVarChar(512), String(body.titleTemplate || '').trim())
    .input('rolesJson', sql.NVarChar(sql.MAX), menuRolesToJson(roles))
    .input('refreshSeconds', sql.Int, Math.max(15, Number(body.refreshSeconds) || 60))
    .input('enabled', sql.Bit, body.enabled !== false ? 1 : 0)
    .input('sortOrder', sql.Int, Number(body.sortOrder) || 0)
    .query(
      `INSERT INTO dbo.message_alert_rules
         (name, sql_template, key_column, title_template, roles_json, refresh_seconds, enabled, sort_order, created_at, updated_at)
       OUTPUT INSERTED.id
       VALUES (@name, @sqlTemplate, @keyColumn, @titleTemplate, @rolesJson, @refreshSeconds, @enabled, @sortOrder,
               ${SQL_CHINA_LOCAL_NOW_EXPR}, ${SQL_CHINA_LOCAL_NOW_EXPR})`
    );

  const id = rs.recordset?.[0]?.id;
  invalidateRuleCache();
  return loadRuleById(pool, id);
}

async function updateRule(pool, ruleId, body) {
  const existing = await loadRuleById(pool, ruleId);
  if (!existing) {
    const err = new Error('提醒规则不存在');
    err.code = 'ALERT_RULE_NOT_FOUND';
    throw err;
  }

  const roles =
    body.roles !== undefined
      ? await normalizeMenuRolesInput(pool, body.roles || [])
      : existing.roles;

  await pool
    .request()
    .input('id', sql.Int, ruleId)
    .input('name', sql.NVarChar(128), String(body.name ?? existing.name).trim())
    .input('sqlTemplate', sql.NVarChar(sql.MAX), String(body.sqlTemplate ?? existing.sqlTemplate).trim())
    .input('keyColumn', sql.NVarChar(128), String(body.keyColumn ?? existing.keyColumn).trim())
    .input('titleTemplate', sql.NVarChar(512), String(body.titleTemplate ?? existing.titleTemplate).trim())
    .input('rolesJson', sql.NVarChar(sql.MAX), menuRolesToJson(roles))
    .input('refreshSeconds', sql.Int, Math.max(15, Number(body.refreshSeconds ?? existing.refreshSeconds) || 60))
    .input('enabled', sql.Bit, (body.enabled ?? existing.enabled) ? 1 : 0)
    .input('sortOrder', sql.Int, Number(body.sortOrder ?? existing.sortOrder) || 0)
    .query(
      `UPDATE dbo.message_alert_rules
       SET name = @name,
           sql_template = @sqlTemplate,
           key_column = @keyColumn,
           title_template = @titleTemplate,
           roles_json = @rolesJson,
           refresh_seconds = @refreshSeconds,
           enabled = @enabled,
           sort_order = @sortOrder,
           updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}
       WHERE id = @id`
    );

  invalidateRuleCache(ruleId);
  return loadRuleById(pool, ruleId);
}

async function deleteRule(pool, ruleId) {
  await pool.request().input('id', sql.Int, ruleId).query(
    `DELETE FROM dbo.message_alert_reads WHERE rule_id = @id;
     DELETE FROM dbo.message_alert_rules WHERE id = @id;`
  );
  invalidateRuleCache(ruleId);
}

module.exports = {
  mapRuleRow,
  loadAllRules,
  loadRuleById,
  getSummaryForUser,
  getRuleItemsForUser,
  markItemsRead,
  markAllRead,
  testRuleSql,
  createRule,
  updateRule,
  deleteRule,
  invalidateRuleCache,
  buildReportSessionInject,
};
