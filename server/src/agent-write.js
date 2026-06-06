/**
 * agent_write_targets 数据访问 + 受控写入（二期"单保存"）。
 *
 * 安全要点：
 * - LLM 只产出结构化 payload，本模块按"写入目标"配置的字段白名单做参数化 INSERT；
 * - 目标表名只允许标识符（防注入），仅支持 INSERT；
 * - datetime 字段用中国本地墙钟（china-datetime.js）；
 * - 每次写入都落 ai_action_logs 审计。
 */
const { getPool, sql } = require('./db');
const { normalizeRoleKeys } = require('./roles');
const { SQL_CHINA_LOCAL_NOW_EXPR, toChinaLocalDateTimeForSql } = require('./china-datetime');

const TARGET_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALLOWED_SQL_TYPES = new Set(['nvarchar', 'int', 'decimal', 'datetime', 'bit']);

function sqlErrorNumber(err) {
  return err?.number ?? err?.originalError?.info?.number ?? err?.originalError?.number;
}
function isMissingTable(err) {
  return sqlErrorNumber(err) === 208;
}
function safeParseJson(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function normalizeField(f) {
  const name = String(f?.name || '').trim();
  if (!IDENTIFIER_RE.test(name)) return null;
  const sqlType = String(f?.sqlType || 'nvarchar').trim().toLowerCase();
  if (!ALLOWED_SQL_TYPES.has(sqlType)) return null;
  return {
    name,
    label: String(f?.label || name),
    sqlType,
    required: !!f?.required,
    maxLen: Number.isFinite(Number(f?.maxLen)) ? Number(f.maxLen) : 255,
  };
}

function rowToTarget(row) {
  return {
    name: String(row.name),
    label: String(row.label || ''),
    targetTable: String(row.target_table || ''),
    fields: (safeParseJson(row.fields_json, []) || []).map(normalizeField).filter(Boolean),
    roles: normalizeRoleKeys(safeParseJson(row.roles_json, ['admin'])),
    enabled: !!row.enabled,
  };
}

async function listWriteTargets(pool) {
  try {
    const rs = await pool.request().query(
      `SELECT name, label, target_table, fields_json, roles_json, enabled
       FROM dbo.agent_write_targets ORDER BY name ASC`
    );
    return (rs.recordset || []).map(rowToTarget);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

async function getWriteTarget(pool, name) {
  try {
    const rs = await pool
      .request()
      .input('n', sql.NVarChar(64), String(name || '').toLowerCase())
      .query(
        `SELECT name, label, target_table, fields_json, roles_json, enabled
         FROM dbo.agent_write_targets WHERE name = @n`
      );
    const row = rs.recordset && rs.recordset[0];
    return row ? rowToTarget(row) : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

function validateTargetInput(input) {
  const name = String(input?.name || '').trim().toLowerCase();
  if (!TARGET_NAME_RE.test(name)) {
    return { ok: false, error: 'name 须为小写字母开头、仅含小写字母/数字/连字符、≤64 字符' };
  }
  const label = String(input?.label || '').trim();
  if (!label) return { ok: false, error: 'label 不能为空' };
  const targetTable = String(input?.targetTable || '').trim();
  if (!IDENTIFIER_RE.test(targetTable)) {
    return { ok: false, error: 'targetTable 须为合法表名标识符（字母/数字/下划线）' };
  }
  const rawFields = Array.isArray(input?.fields) ? input.fields : [];
  const fields = rawFields.map(normalizeField).filter(Boolean);
  if (fields.length === 0) return { ok: false, error: '至少配置一个合法字段（sqlType 限 nvarchar/int/decimal/datetime/bit）' };
  const roles = normalizeRoleKeys(Array.isArray(input?.roles) ? input.roles : ['admin']);
  const enabled = input?.enabled !== false;
  return { ok: true, value: { name, label, targetTable, fields, roles, enabled } };
}

async function upsertWriteTarget(pool, value) {
  await pool
    .request()
    .input('name', sql.NVarChar(64), value.name)
    .input('label', sql.NVarChar(128), value.label)
    .input('target_table', sql.NVarChar(128), value.targetTable)
    .input('fields_json', sql.NVarChar(sql.MAX), JSON.stringify(value.fields))
    .input('roles_json', sql.NVarChar(sql.MAX), JSON.stringify(value.roles))
    .input('enabled', sql.Bit, value.enabled)
    .query(`
      MERGE dbo.agent_write_targets AS t
      USING (SELECT @name AS name) AS s ON t.name = s.name
      WHEN MATCHED THEN UPDATE SET
        label = @label, target_table = @target_table, fields_json = @fields_json,
        roles_json = @roles_json, enabled = @enabled, updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}
      WHEN NOT MATCHED THEN
        INSERT (name, label, target_table, fields_json, roles_json, enabled)
        VALUES (@name, @label, @target_table, @fields_json, @roles_json, @enabled);
    `);
  return getWriteTarget(pool, value.name);
}

async function deleteWriteTarget(pool, name) {
  const rs = await pool
    .request()
    .input('n', sql.NVarChar(64), String(name || '').toLowerCase())
    .query(`DELETE FROM dbo.agent_write_targets WHERE name = @n`);
  return rs.rowsAffected && rs.rowsAffected[0] > 0;
}

/** 把字段定义 + 取值绑定到 request，返回列名/参数名映射或抛错 */
function bindFieldValue(req, field, rawValue) {
  const pName = `f_${field.name}`;
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    if (field.required) {
      const err = new Error(`字段 ${field.label || field.name} 为必填`);
      err.code = 'WRITE_FIELD_REQUIRED';
      throw err;
    }
    req.input(pName, sql.NVarChar(sql.MAX), null);
    return pName;
  }
  switch (field.sqlType) {
    case 'int': {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) throw fieldErr(field, '应为整数');
      req.input(pName, sql.Int, Math.trunc(n));
      break;
    }
    case 'decimal': {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) throw fieldErr(field, '应为数字');
      req.input(pName, sql.Decimal(18, 4), n);
      break;
    }
    case 'bit': {
      const b = rawValue === true || rawValue === 1 || rawValue === '1' || /^(true|yes|是)$/i.test(String(rawValue));
      req.input(pName, sql.Bit, b);
      break;
    }
    case 'datetime': {
      // 中国本地墙钟
      req.input(pName, sql.DateTime2(3), toChinaLocalDateTimeForSql(rawValue));
      break;
    }
    case 'nvarchar':
    default: {
      const s = String(rawValue).slice(0, field.maxLen || 255);
      req.input(pName, sql.NVarChar(field.maxLen || 255), s);
      break;
    }
  }
  return pName;
}

function fieldErr(field, msg) {
  const err = new Error(`字段 ${field.label || field.name} ${msg}`);
  err.code = 'WRITE_FIELD_INVALID';
  return err;
}

/**
 * 执行受控写入。target 已经过角色门禁校验。
 * @returns {Promise<{ insertedId?: number }>}
 */
async function performWrite(pool, target, payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const req = pool.request();
  const cols = [];
  const params = [];
  for (const field of target.fields) {
    const pName = bindFieldValue(req, field, data[field.name]);
    cols.push(`[${field.name}]`);
    params.push(`@${pName}`);
  }
  if (cols.length === 0) {
    const err = new Error('没有可写入的字段');
    err.code = 'WRITE_NO_FIELDS';
    throw err;
  }
  const insertSql =
    `INSERT INTO [${target.targetTable}] (${cols.join(', ')}) ` +
    `OUTPUT INSERTED.* VALUES (${params.join(', ')})`;
  const result = await req.query(insertSql);
  const row = result.recordset && result.recordset[0];
  return { insertedRow: row || null };
}

async function writeAuditLog(pool, { userCode, conversationId, action, entity, payload, result, detail }) {
  try {
    await pool
      .request()
      .input('uc', sql.NVarChar(64), userCode || '')
      .input('cid', sql.NVarChar(64), conversationId || null)
      .input('action', sql.NVarChar(32), action || 'save_record')
      .input('entity', sql.NVarChar(64), entity || null)
      .input('payload', sql.NVarChar(sql.MAX), payload ? JSON.stringify(payload).slice(0, 100000) : null)
      .input('result', sql.NVarChar(16), result || 'ok')
      .input('detail', sql.NVarChar(1024), detail ? String(detail).slice(0, 1024) : null)
      .query(
        `INSERT INTO dbo.ai_action_logs (user_code, conversation_id, action, entity, payload_json, result, detail)
         VALUES (@uc, @cid, @action, @entity, @payload, @result, @detail)`
      );
  } catch {
    /* 审计失败不阻断主流程 */
  }
}

module.exports = {
  TARGET_NAME_RE,
  listWriteTargets,
  getWriteTarget,
  validateTargetInput,
  upsertWriteTarget,
  deleteWriteTarget,
  performWrite,
  writeAuditLog,
};
