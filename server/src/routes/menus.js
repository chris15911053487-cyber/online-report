const { getPool, sql } = require('../db');
const {
  validateReportMenuConfig,
  parseFilterSchemaJson,
  parseColumnLabelsJson,
  parseColumnNameMappingJson,
} = require('../report-query');

const ROUTE_KEY_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** SQL Server：无效对象名（表不存在） */
function sqlErrorNumber(err) {
  return (
    err?.number ??
    err?.originalError?.info?.number ??
    err?.originalError?.number
  );
}

function isInvalidObjectNameError(err) {
  return sqlErrorNumber(err) === 208;
}

const NAV_TABLE_MISSING_MSG =
  '数据库尚未创建表 nav_menu_items。请在当前库执行 server/sql/migrate-nav-menu-items-only.sql（或完整 schema-mssql.sql），或运行 npm run init-db。';

/** 表未建好时 /menus 使用的内置菜单（与种子数据一致） */
function defaultMenusForRole(userRole) {
  const all = [
    {
      id: 1,
      label: '生产订单',
      routeKey: 'orders',
      icon: '📋',
      sortOrder: 10,
      enabled: true,
      roles: ['admin', 'operator'],
      menuKind: 'builtin',
      filterSchema: [],
      columnLabels: {},
      columnNameMapping: {},
    },
    {
      id: 2,
      label: '菜单设置',
      routeKey: 'menu-settings',
      icon: '⚙',
      sortOrder: 20,
      enabled: true,
      roles: ['admin'],
      menuKind: 'builtin',
      filterSchema: [],
      columnLabels: {},
      columnNameMapping: {},
    },
  ];
  return all.filter((m) => m.roles.includes(userRole));
}
const ALLOWED_ROLES = new Set(['admin', 'operator']);

function parseRolesJson(s) {
  try {
    const a = JSON.parse(s);
    if (!Array.isArray(a)) return [];
    return a.map((x) => String(x)).filter((r) => ALLOWED_ROLES.has(r));
  } catch {
    return [];
  }
}

function rolesToJson(roles) {
  const list = Array.isArray(roles)
    ? roles.map((r) => String(r)).filter((r) => ALLOWED_ROLES.has(r))
    : [];
  const uniq = [...new Set(list)].sort();
  return JSON.stringify(uniq);
}

function filterSchemaFromRow(filterSchemaJson) {
  const p = parseFilterSchemaJson(filterSchemaJson || '[]');
  return p.ok ? p.fields : [];
}

/** 非管理员菜单接口：不返回 optionsSql 文本，仅标记需走接口拉取下拉项 */
function sanitizeFilterSchemaForPublic(fields) {
  if (!Array.isArray(fields)) return fields;
  return fields.map((f) => {
    if (!f || typeof f !== 'object' || !f.optionsSql) return f;
    const next = { ...f };
    delete next.optionsSql;
    next.optionsFromSql = true;
    return next;
  });
}

function columnLabelsFromRow(columnLabelsJson) {
  const p = parseColumnLabelsJson(columnLabelsJson != null ? columnLabelsJson : '{}');
  return p.ok ? p.labels : {};
}

function columnNameMappingFromRow(columnNameMappingJson) {
  const p = parseColumnNameMappingJson(
    columnNameMappingJson != null && String(columnNameMappingJson).trim() !== ''
      ? columnNameMappingJson
      : '{}'
  );
  return p.ok ? p.mapping : {};
}

/** 解析 voice_actions_json：仅返回结构合法的动作；其余忽略，避免坏配置阻断菜单加载 */
function voiceActionsFromRow(voiceActionsJson) {
  if (voiceActionsJson == null) return [];
  const text = String(voiceActionsJson).trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const cleaned = [];
  for (const it of parsed) {
    if (!it || typeof it !== 'object') continue;
    const patterns = Array.isArray(it.patterns)
      ? it.patterns
          .map((p) => (p == null ? '' : String(p).trim()))
          .filter((p) => p.length > 0 && p.length <= 200)
      : [];
    if (patterns.length === 0) continue;
    const fill = {};
    if (it.fill && typeof it.fill === 'object' && !Array.isArray(it.fill)) {
      for (const k of Object.keys(it.fill)) {
        const fk = String(k).trim();
        if (!fk || fk.length > 128) continue;
        const fv = it.fill[k];
        if (fv == null) continue;
        const fvs = String(fv);
        if (fvs.length > 200) continue;
        fill[fk] = fvs;
      }
    }
    cleaned.push({
      patterns,
      fill,
      autoQuery: it.autoQuery !== false,
      label: it.label ? String(it.label).slice(0, 64) : '',
    });
    if (cleaned.length >= 50) break;
  }
  return cleaned;
}

/** 序列化 voice_actions：客户端传入的对象 → 校验后的 JSON 文本（或 null） */
function serializeVoiceActions(input) {
  if (input == null || input === '') return null;
  let arr = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return null;
    try {
      arr = JSON.parse(text);
    } catch {
      const err = new Error('语音动作 JSON 格式错误');
      err.code = 'VOICE_ACTIONS_BAD_JSON';
      throw err;
    }
  }
  if (!Array.isArray(arr)) {
    const err = new Error('语音动作必须是数组');
    err.code = 'VOICE_ACTIONS_BAD_JSON';
    throw err;
  }
  // 复用 voiceActionsFromRow 的清洗逻辑
  const cleaned = voiceActionsFromRow(JSON.stringify(arr));
  if (cleaned.length === 0) return null;
  return JSON.stringify(cleaned);
}

function rowToPublicItem(row) {
  const mk = row.menu_kind ? String(row.menu_kind) : 'builtin';
  const dq =
    row.detail_query_template != null ? String(row.detail_query_template).trim() : '';
  const dkc =
    row.detail_key_column != null ? String(row.detail_key_column).trim() : '';
  const rowDetailEnabled = mk === 'report' && !!dq && !!dkc;
  const dp = row.detail_key_param != null ? String(row.detail_key_param).trim() : '';
  const hasDetailTpl = mk === 'report' && !!dq;
  return {
    id: Number(row.id),
    label: row.label,
    routeKey: row.route_key,
    icon: row.icon || '',
    sortOrder: row.sort_order,
    enabled: !!row.enabled,
    roles: parseRolesJson(row.roles_json),
    menuKind: mk,
    filterSchema:
      mk === 'report'
        ? sanitizeFilterSchemaForPublic(filterSchemaFromRow(row.filter_schema_json))
        : [],
    columnLabels: mk === 'report' ? columnLabelsFromRow(row.column_labels_json) : {},
    rowDetailEnabled,
    detailKeyColumn: rowDetailEnabled ? dkc : hasDetailTpl ? dkc : '',
    detailKeyParam: hasDetailTpl ? dp || 'detailKey' : undefined,
    aiPrompt: row.ai_prompt ? String(row.ai_prompt).trim() : '',
    voiceActions: voiceActionsFromRow(row.voice_actions_json),
  };
}

function rowToAdminItem(row) {
  const base = rowToPublicItem(row);
  base.queryTemplate = row.query_template != null ? String(row.query_template) : '';
  const mk = base.menuKind || 'builtin';
  if (mk === 'report') {
    base.filterSchema = filterSchemaFromRow(row.filter_schema_json);
    base.detailQueryTemplate =
      row.detail_query_template != null ? String(row.detail_query_template) : '';
    base.detailKeyColumn =
      row.detail_key_column != null ? String(row.detail_key_column) : '';
    const dp = row.detail_key_param != null ? String(row.detail_key_param).trim() : '';
    base.detailKeyParam = dp || 'detailKey';
    base.detailKeyType =
      row.detail_key_type != null ? String(row.detail_key_type) : 'string';
    base.columnLabels = columnLabelsFromRow(row.column_labels_json);
    base.columnNameMapping = columnNameMappingFromRow(
      row.column_name_mapping_json != null ? row.column_name_mapping_json : '{}'
    );
    base.aiPrompt = row.ai_prompt ? String(row.ai_prompt).trim() : '';
  } else {
    base.detailQueryTemplate = '';
    base.detailKeyColumn = '';
    base.detailKeyParam = 'detailKey';
    base.detailKeyType = 'string';
    base.columnLabels = {};
    base.columnNameMapping = {};
    base.aiPrompt = '';
  }
  return base;
}

function normalizeRolesInput(roles) {
  const list = Array.isArray(roles)
    ? roles.map((r) => String(r)).filter((r) => ALLOWED_ROLES.has(r))
    : [];
  return [...new Set(list)];
}

/** @param {{ menuKind: string, detailNormalizedTemplate?: string|null, detailKeyColumn?: string, detailKeyParam?: string, detailKeyType?: string }} validated */
function detailColumnsFromValidated(validated) {
  if (
    validated.menuKind !== 'report' ||
    !validated.detailNormalizedTemplate
  ) {
    return {
      detailQueryTemplate: null,
      detailKeyColumn: null,
      detailKeyParam: null,
      detailKeyType: 'string',
    };
  }
  return {
    detailQueryTemplate: validated.detailNormalizedTemplate,
    detailKeyColumn: validated.detailKeyColumn || null,
    detailKeyParam: validated.detailKeyParam || 'detailKey',
    detailKeyType: validated.detailKeyType || 'string',
  };
}

const MENU_SELECT_FIELDS = `id, label, route_key, icon, sort_order, enabled, roles_json,
  COALESCE(menu_kind, N'builtin') AS menu_kind, query_template, filter_schema_json,
  COALESCE(column_labels_json, N'{}') AS column_labels_json,
  COALESCE(column_name_mapping_json, N'{}') AS column_name_mapping_json,
  detail_query_template, detail_key_column, detail_key_param, COALESCE(detail_key_type, N'string') AS detail_key_type,
  ai_prompt, voice_actions_json`;

async function menusRoutes(fastify) {
  fastify.get(
    '/menus',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const userRole = String(request.user.role || 'operator');
      const pool = await getPool();
      try {
        const result = await pool.request().query(
          `SELECT ${MENU_SELECT_FIELDS}
           FROM dbo.nav_menu_items
           WHERE enabled = 1
           ORDER BY sort_order ASC, id ASC`
        );
        const items = result.recordset
          .filter((row) => parseRolesJson(row.roles_json).includes(userRole))
          .map(rowToPublicItem);
        return { items };
      } catch (err) {
        if (isInvalidObjectNameError(err)) {
          request.log.warn(
            { err },
            'nav_menu_items 不存在，使用内置默认菜单；请执行 migrate-nav-menu-items-only.sql'
          );
          return { items: defaultMenusForRole(userRole) };
        }
        throw err;
      }
    }
  );

  fastify.get(
    '/admin/menus',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const pool = await getPool();
      try {
        const result = await pool.request().query(
          `SELECT ${MENU_SELECT_FIELDS}
           FROM dbo.nav_menu_items
           ORDER BY sort_order ASC, id ASC`
        );
        return { items: result.recordset.map(rowToAdminItem) };
      } catch (err) {
        if (isInvalidObjectNameError(err)) {
          request.log.warn({ err }, NAV_TABLE_MISSING_MSG);
          return reply.code(503).send({
            error: NAV_TABLE_MISSING_MSG,
            code: 'NAV_TABLE_MISSING',
          });
        }
        throw err;
      }
    }
  );

  fastify.post(
    '/admin/menus',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const body = request.body || {};
      const label = String(body.label || '').trim().slice(0, 128);
      const routeKey = String(body.routeKey || '')
        .trim()
        .toLowerCase()
        .slice(0, 64);
      const icon = body.icon != null ? String(body.icon).slice(0, 32) : '';
      const sortOrder = Number(body.sortOrder);
      const enabled = body.enabled !== false;
      const roles = normalizeRolesInput(body.roles);
      const menuKind = String(body.menuKind || 'builtin').toLowerCase();
      const queryTemplate =
        body.queryTemplate != null ? String(body.queryTemplate) : '';
      const filterSchema = body.filterSchema;
      const detailQueryTemplate =
        body.detailQueryTemplate != null ? String(body.detailQueryTemplate) : '';
      const detailKeyColumn =
        body.detailKeyColumn != null ? String(body.detailKeyColumn) : '';
      const detailKeyParam =
        body.detailKeyParam != null ? String(body.detailKeyParam) : '';
      const detailKeyType =
        body.detailKeyType != null ? String(body.detailKeyType) : '';
      const columnLabels = body.columnLabels;
      const columnNameMapping = body.columnNameMapping;
      let voiceActionsJson;
      try {
        voiceActionsJson = serializeVoiceActions(body.voiceActions);
      } catch (e) {
        return reply.code(400).send({ error: e.message || '语音动作 JSON 错误' });
      }

      if (!label) {
        return reply.code(400).send({ error: '请填写菜单名称' });
      }
      if (!ROUTE_KEY_RE.test(routeKey)) {
        return reply
          .code(400)
          .send({ error: '路由标识须为小写字母、数字、短横线，且以小写字母开头' });
      }
      if (roles.length === 0) {
        return reply.code(400).send({ error: '请至少选择一个角色权限' });
      }
      if (!Number.isFinite(sortOrder)) {
        return reply.code(400).send({ error: '排序号无效' });
      }

      const validated = validateReportMenuConfig({
        menuKind,
        routeKey,
        queryTemplate,
        filterSchema:
          filterSchema != null
            ? filterSchema
            : menuKind === 'report'
              ? '[]'
              : '[]',
        columnLabels,
        columnNameMapping,
        detailQueryTemplate,
        detailKeyColumn,
        detailKeyParam,
        detailKeyType,
      });
      if (!validated.ok) {
        return reply.code(400).send({ error: validated.error });
      }

      const filterSchemaJson =
        validated.menuKind === 'report'
          ? JSON.stringify(validated.filterFields)
          : '[]';
      const columnLabelsJson =
        validated.menuKind === 'report'
          ? JSON.stringify(validated.columnLabels || {})
          : '{}';
      const columnNameMappingJson =
        validated.menuKind === 'report'
          ? JSON.stringify(validated.columnNameMapping || {})
          : '{}';
      const qt =
        validated.menuKind === 'report' && validated.normalizedTemplate
          ? validated.normalizedTemplate
          : null;
      const detailCols = detailColumnsFromValidated(validated);

      const pool = await getPool();
      const rolesJson = rolesToJson(roles);
      try {
        const ins = await pool
          .request()
          .input('label', sql.NVarChar(128), label)
          .input('routeKey', sql.NVarChar(64), routeKey)
          .input('icon', sql.NVarChar(32), icon || null)
          .input('sortOrder', sql.Int, Math.trunc(sortOrder))
          .input('enabled', sql.Bit, enabled ? 1 : 0)
          .input('rolesJson', sql.NVarChar(512), rolesJson)
          .input('menuKind', sql.NVarChar(32), validated.menuKind)
          .input('queryTemplate', sql.NVarChar(1073741823), qt)
          .input('filterSchemaJson', sql.NVarChar(1073741823), filterSchemaJson)
          .input('columnLabelsJson', sql.NVarChar(1073741823), columnLabelsJson)
          .input('columnNameMappingJson', sql.NVarChar(1073741823), columnNameMappingJson)
          .input('detailQueryTemplate', sql.NVarChar(1073741823), detailCols.detailQueryTemplate)
          .input('detailKeyColumn', sql.NVarChar(256), detailCols.detailKeyColumn)
          .input('detailKeyParam', sql.NVarChar(128), detailCols.detailKeyParam)
          .input('detailKeyType', sql.NVarChar(32), detailCols.detailKeyType)
          .input('aiPrompt', sql.NVarChar(1073741823), body.aiPrompt || null)
          .input('voiceActionsJson', sql.NVarChar(1073741823), voiceActionsJson)
          .query(
            `INSERT INTO dbo.nav_menu_items (label, route_key, icon, sort_order, enabled, roles_json, menu_kind, query_template, filter_schema_json, column_labels_json, column_name_mapping_json, detail_query_template, detail_key_column, detail_key_param, detail_key_type, ai_prompt, voice_actions_json)
             OUTPUT INSERTED.id AS id
             VALUES (@label, @routeKey, @icon, @sortOrder, @enabled, @rolesJson, @menuKind, @queryTemplate, @filterSchemaJson, @columnLabelsJson, @columnNameMappingJson, @detailQueryTemplate, @detailKeyColumn, @detailKeyParam, @detailKeyType, @aiPrompt, @voiceActionsJson)`
          );
        const newId = Number(ins.recordset[0].id);
        return reply.code(201).send({
          item: {
            id: newId,
            label,
            routeKey,
            icon,
            sortOrder: Math.trunc(sortOrder),
            enabled,
            roles,
            menuKind: validated.menuKind,
            queryTemplate: qt || '',
            filterSchema:
              validated.menuKind === 'report' ? validated.filterFields : [],
            columnLabels:
              validated.menuKind === 'report' ? validated.columnLabels || {} : {},
            columnNameMapping:
              validated.menuKind === 'report' ? validated.columnNameMapping || {} : {},
            detailQueryTemplate: detailCols.detailQueryTemplate || '',
            detailKeyColumn: detailCols.detailKeyColumn || '',
            detailKeyParam: detailCols.detailKeyParam || 'detailKey',
            detailKeyType: detailCols.detailKeyType || 'string',
            aiPrompt: body.aiPrompt || '',
            voiceActions: voiceActionsJson ? JSON.parse(voiceActionsJson) : [],
          },
        });
      } catch (e) {
        if (isInvalidObjectNameError(e)) {
          return reply.code(503).send({
            error: NAV_TABLE_MISSING_MSG,
            code: 'NAV_TABLE_MISSING',
          });
        }
        if (e.number === 2627 || e.number === 2601) {
          return reply.code(409).send({ error: '路由标识已存在' });
        }
        throw e;
      }
    }
  );

  fastify.patch(
    '/admin/menus/:id',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) {
        return reply.code(400).send({ error: '无效的菜单 ID' });
      }
      const body = request.body || {};
      const label = String(body.label || '').trim().slice(0, 128);
      const routeKey = String(body.routeKey || '')
        .trim()
        .toLowerCase()
        .slice(0, 64);
      const icon = body.icon != null ? String(body.icon).slice(0, 32) : '';
      const sortOrder = Number(body.sortOrder);
      const enabled = body.enabled !== false;
      const roles = normalizeRolesInput(body.roles);
      const menuKind = String(body.menuKind || 'builtin').toLowerCase();
      const queryTemplate =
        body.queryTemplate != null ? String(body.queryTemplate) : '';
      const filterSchema = body.filterSchema;
      const detailQueryTemplate =
        body.detailQueryTemplate != null ? String(body.detailQueryTemplate) : '';
      const detailKeyColumn =
        body.detailKeyColumn != null ? String(body.detailKeyColumn) : '';
      const detailKeyParam =
        body.detailKeyParam != null ? String(body.detailKeyParam) : '';
      const detailKeyType =
        body.detailKeyType != null ? String(body.detailKeyType) : '';
      const columnLabels = body.columnLabels;
      const columnNameMapping = body.columnNameMapping;
      let voiceActionsJson;
      try {
        voiceActionsJson = serializeVoiceActions(body.voiceActions);
      } catch (e) {
        return reply.code(400).send({ error: e.message || '语音动作 JSON 错误' });
      }

      if (!label) {
        return reply.code(400).send({ error: '请填写菜单名称' });
      }
      if (!ROUTE_KEY_RE.test(routeKey)) {
        return reply
          .code(400)
          .send({ error: '路由标识须为小写字母、数字、短横线，且以小写字母开头' });
      }
      if (roles.length === 0) {
        return reply.code(400).send({ error: '请至少选择一个角色权限' });
      }
      if (!Number.isFinite(sortOrder)) {
        return reply.code(400).send({ error: '排序号无效' });
      }

      const validated = validateReportMenuConfig({
        menuKind,
        routeKey,
        queryTemplate,
        filterSchema:
          filterSchema != null
            ? filterSchema
            : menuKind === 'report'
              ? '[]'
              : '[]',
        columnLabels,
        columnNameMapping,
        detailQueryTemplate,
        detailKeyColumn,
        detailKeyParam,
        detailKeyType,
      });
      if (!validated.ok) {
        return reply.code(400).send({ error: validated.error });
      }

      const filterSchemaJson =
        validated.menuKind === 'report'
          ? JSON.stringify(validated.filterFields)
          : '[]';
      const columnLabelsJson =
        validated.menuKind === 'report'
          ? JSON.stringify(validated.columnLabels || {})
          : '{}';
      const columnNameMappingJson =
        validated.menuKind === 'report'
          ? JSON.stringify(validated.columnNameMapping || {})
          : '{}';
      const qt =
        validated.menuKind === 'report' && validated.normalizedTemplate
          ? validated.normalizedTemplate
          : null;
      const detailCols = detailColumnsFromValidated(validated);

      const pool = await getPool();
      const rolesJson = rolesToJson(roles);
      try {
        const upd = await pool
          .request()
          .input('id', sql.BigInt, BigInt(id))
          .input('label', sql.NVarChar(128), label)
          .input('routeKey', sql.NVarChar(64), routeKey)
          .input('icon', sql.NVarChar(32), icon || null)
          .input('sortOrder', sql.Int, Math.trunc(sortOrder))
          .input('enabled', sql.Bit, enabled ? 1 : 0)
          .input('rolesJson', sql.NVarChar(512), rolesJson)
          .input('menuKind', sql.NVarChar(32), validated.menuKind)
          .input('queryTemplate', sql.NVarChar(1073741823), qt)
          .input('filterSchemaJson', sql.NVarChar(1073741823), filterSchemaJson)
          .input('columnLabelsJson', sql.NVarChar(1073741823), columnLabelsJson)
          .input('columnNameMappingJson', sql.NVarChar(1073741823), columnNameMappingJson)
          .input('detailQueryTemplate', sql.NVarChar(1073741823), detailCols.detailQueryTemplate)
          .input('detailKeyColumn', sql.NVarChar(256), detailCols.detailKeyColumn)
          .input('detailKeyParam', sql.NVarChar(128), detailCols.detailKeyParam)
          .input('detailKeyType', sql.NVarChar(32), detailCols.detailKeyType)
          .input('aiPrompt', sql.NVarChar(1073741823), body.aiPrompt || null)
          .input('voiceActionsJson', sql.NVarChar(1073741823), voiceActionsJson)
          .query(
            `UPDATE dbo.nav_menu_items
             SET label = @label, route_key = @routeKey, icon = @icon, sort_order = @sortOrder,
                 enabled = @enabled, roles_json = @rolesJson,
                 menu_kind = @menuKind, query_template = @queryTemplate, filter_schema_json = @filterSchemaJson,
                 column_labels_json = @columnLabelsJson,
                 column_name_mapping_json = @columnNameMappingJson,
                 detail_query_template = @detailQueryTemplate, detail_key_column = @detailKeyColumn,
                 detail_key_param = @detailKeyParam, detail_key_type = @detailKeyType,
                 ai_prompt = @aiPrompt,
                 voice_actions_json = @voiceActionsJson,
                 updated_at = SYSUTCDATETIME()
             WHERE id = @id`
          );
        if (upd.rowsAffected[0] === 0) {
          return reply.code(404).send({ error: '菜单不存在' });
        }
        return {
          item: {
            id,
            label,
            routeKey,
            icon,
            sortOrder: Math.trunc(sortOrder),
            enabled,
            roles,
            menuKind: validated.menuKind,
            queryTemplate: qt || '',
            filterSchema:
              validated.menuKind === 'report' ? validated.filterFields : [],
            columnLabels:
              validated.menuKind === 'report' ? validated.columnLabels || {} : {},
            columnNameMapping:
              validated.menuKind === 'report' ? validated.columnNameMapping || {} : {},
            detailQueryTemplate: detailCols.detailQueryTemplate || '',
            detailKeyColumn: detailCols.detailKeyColumn || '',
            detailKeyParam: detailCols.detailKeyParam || 'detailKey',
            detailKeyType: detailCols.detailKeyType || 'string',
            aiPrompt: body.aiPrompt || '',
            voiceActions: voiceActionsJson ? JSON.parse(voiceActionsJson) : [],
          },
        };
      } catch (e) {
        if (isInvalidObjectNameError(e)) {
          return reply.code(503).send({
            error: NAV_TABLE_MISSING_MSG,
            code: 'NAV_TABLE_MISSING',
          });
        }
        if (e.number === 2627 || e.number === 2601) {
          return reply.code(409).send({ error: '路由标识已存在' });
        }
        throw e;
      }
    }
  );

  fastify.delete(
    '/admin/menus/:id',
    { preHandler: [fastify.requireAdmin] },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) {
        return reply.code(400).send({ error: '无效的菜单 ID' });
      }
      const pool = await getPool();
      try {
        const del = await pool
          .request()
          .input('id', sql.BigInt, BigInt(id))
          .query(`DELETE FROM dbo.nav_menu_items WHERE id = @id`);
        if (del.rowsAffected[0] === 0) {
          return reply.code(404).send({ error: '菜单不存在' });
        }
        return { ok: true };
      } catch (e) {
        if (isInvalidObjectNameError(e)) {
          return reply.code(503).send({
            error: NAV_TABLE_MISSING_MSG,
            code: 'NAV_TABLE_MISSING',
          });
        }
        throw e;
      }
    }
  );
}

module.exports = menusRoutes;
