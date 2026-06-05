const { getPool, sql } = require('../db');
const { userCodeToStableBigInt } = require('../ousr-auth');
const {
  toChinaLocalDateTimeForSql,
  SQL_CHINA_LOCAL_NOW_EXPR,
} = require('../china-datetime');
const {
  detectTemplateKind,
  normalizeTemplate,
  parseFilterSchemaJson,
  parseColumnNameMappingJson,
  applyColumnNameMapping,
  buildReportSessionInject,
  executeReportQuery,
} = require('../report-query');

const PRO_SIGN_ROUTE = 'pro-sign';
const MAX_BATCH_LINES = 100;

const DEFAULT_PRO_SIGN_SQL = `SELECT
  po.id AS orderId,
  po.order_no AS orderNo,
  po.product_name AS productName,
  po.planned_qty AS plannedQty,
  po.reported_qty AS reportedQty,
  po.status AS orderStatus,
  oo.id AS operationId,
  oo.seq_no AS seqNo,
  oo.operation_name AS operationName
FROM dbo.production_orders po
INNER JOIN dbo.order_operations oo ON oo.order_id = po.id
WHERE (@orderNo IS NULL OR LTRIM(RTRIM(ISNULL(@orderNo, N''))) = N'' OR po.order_no LIKE N'%' + @orderNo + N'%')
ORDER BY po.id DESC, oo.seq_no`;

const DEFAULT_FILTER_SCHEMA = [
  {
    name: 'orderNo',
    label: '订单号',
    type: 'string',
    required: false,
    maxLength: 64,
    scan: true,
  },
];

function parseRolesJson(s) {
  try {
    const a = JSON.parse(s);
    if (!Array.isArray(a)) return [];
    return a.map((x) => String(x));
  } catch {
    return [];
  }
}

function toBigIntId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  if (!Number.isFinite(n)) return null;
  return BigInt(Math.trunc(n));
}

/** 将 mssql 行序列化为可 JSON 返回的纯对象 */
function jsonSafeMssqlRow(row) {
  if (row == null || typeof row !== 'object') return row;
  const o = {};
  for (const k of Object.keys(row)) {
    let v = row[k];
    if (v != null && typeof v === 'object' && v instanceof Date) {
      o[k] = v.toISOString();
    } else if (typeof v === 'bigint') {
      o[k] = v.toString();
    } else {
      o[k] = v;
    }
  }
  return o;
}

/** 多结果集 -> 可 JSON 的二维数组 */
function serializeMssqlRecordsets(rs) {
  const sets = Array.isArray(rs.recordsets) && rs.recordsets.length
    ? rs.recordsets
    : rs.recordset
      ? [rs.recordset]
      : [[]];
  return sets.map((set) => (set || []).map((row) => jsonSafeMssqlRow(row)));
}

/**
 * 从 Z_ONLINE_TOOWORSIGN_DETAIL 首行取接单页展示字段；列名不区分大小写，可含中文别名列。
 * 业务工单用 BaseEntry（或工单号 等），不含表主键列 DocEntry。数量见 TOOWOR_QUANTITY_NAMES。缺省用 null 由前端回退。
 */
function valueToDisplayString(v) {
  if (v == null) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object' && v instanceof Date) {
    return v.toISOString();
  }
  const s = String(v).trim();
  return s.length ? s : null;
}

function valueToNumberOrNull(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object' && v instanceof Date) return null;
  if (typeof v === 'number' && !Number.isNaN(v) && Number.isFinite(v)) return v;
  const t = String(v).replace(/,/g, '').trim();
  if (!t.length) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/* BaseEntry/工单名：用 BaseEntry 或业务别名列，不含 DocEntry（X_ONLINE_SIGN 单头主键，由 IDENTITY 生成，勿与业务工单混用） */
const TOOWOR_DISPLAY_PICKS = {
  baseEntry: ['baseentry', '工单号', 'workorderid', 'woid'],
  setupCode: ['setupcode', '工序编码', 'opid', 'stepcode'],
  setupName: ['setupname', '工序名称', 'opname', 'processname', 'stepname'],
  itemName: ['itemname', '物料名称', '产品名称', '产品名', 'productname', 'materialname', 'matname'],
};

const TOOWOR_LAST_STEP = {
  lastStepCode: ['laststepcode', '上道工序编码', 'lastopcode', 'prevstepcode'],
  lastStepName: ['laststepname', '上道工序名称', 'lastopname', 'prevstepname'],
  lastStepTime: ['laststeptime', '上道工序时间', 'lastoptime', 'prevsteptime'],
};

/** 上道工序/上一环节操作员（Z_ONLINE_TOOWORSIGN_DETAIL 首行；可与 OperatorCodes 逗号分隔） */
const TOOWOR_LAST_STEP_OPERATOR = [
  'laststepoperator',
  'laststepoperatorcode',
  'laststepoperatorcodes',
  'laststephemcode',
  'laststepempcode',
  'lastoperator',
  'lastoperatorcode',
  'lastoperatorcodes',
  'prevstepoperator',
  'prevoperator',
  'prevoperatorcode',
  '上道工序操作员',
  '上道工序操作员编码',
  '上道工序工人',
  '上一环节操作员',
  '上一环节操作员编码',
  'lasthemcode',
  'lastempcode',
];

/** 预检首行：PC / 批次（列名不区分大小写） */
const TOOWOR_PC = ['pc', '批次', 'batchno', 'batch', 'batchcode', 'lot', 'lotno', 'charg', 'chargenr'];

/** 预检首行数量列：Quantity 及常见别名（列名不区分大小写） */
const TOOWOR_QUANTITY_NAMES = [
  'quantity',
  'qty',
  '数量',
  'planqty',
  'plannedqty',
  'planned_qty',
  'goodqty',
  'good_qty',
  'reportqty',
  'reportedqty',
];

function pickTooworQuantityFromRow(row, lowerKeyMap) {
  if (!row || !lowerKeyMap) return null;
  for (const name of TOOWOR_QUANTITY_NAMES) {
    const lk = name.toLowerCase().trim();
    if (Object.prototype.hasOwnProperty.call(lowerKeyMap, lk)) {
      const n = valueToNumberOrNull(row[lowerKeyMap[lk]]);
      if (n != null) return n;
    }
  }
  return null;
}

function buildLowerKeyMap(row) {
  const o = {};
  for (const k of Object.keys(row)) {
    o[k.toLowerCase().trim()] = k;
  }
  return o;
}

function pickTooworFieldFromRow(row, lowerKeyMap, candidates) {
  if (!row) return null;
  for (const name of candidates) {
    const lk = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(lowerKeyMap, lk)) {
      const v = valueToDisplayString(row[lowerKeyMap[lk]]);
      if (v != null) return v;
    }
  }
  for (const name of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, name)) {
      const v = valueToDisplayString(row[name]);
      if (v != null) return v;
    }
  }
  return null;
}

function parseTooworDisplayFromRow(row) {
  if (!row || typeof row !== 'object') {
    return {
      baseEntry: null,
      setupCode: null,
      setupName: null,
      itemName: null,
      quantity: null,
      lastStepCode: null,
      lastStepName: null,
      lastStepTime: null,
      lastStepOperator: null,
      pc: null,
    };
  }
  const lower = buildLowerKeyMap(row);
  return {
    baseEntry: pickTooworFieldFromRow(row, lower, TOOWOR_DISPLAY_PICKS.baseEntry),
    setupCode: pickTooworFieldFromRow(row, lower, TOOWOR_DISPLAY_PICKS.setupCode),
    setupName: pickTooworFieldFromRow(row, lower, TOOWOR_DISPLAY_PICKS.setupName),
    itemName: pickTooworFieldFromRow(row, lower, TOOWOR_DISPLAY_PICKS.itemName),
    quantity: pickTooworQuantityFromRow(row, lower),
    lastStepCode: pickTooworFieldFromRow(row, lower, TOOWOR_LAST_STEP.lastStepCode),
    lastStepName: pickTooworFieldFromRow(row, lower, TOOWOR_LAST_STEP.lastStepName),
    lastStepTime: pickTooworFieldFromRow(row, lower, TOOWOR_LAST_STEP.lastStepTime),
    lastStepOperator: pickTooworFieldFromRow(row, lower, TOOWOR_LAST_STEP_OPERATOR),
    pc: pickTooworFieldFromRow(row, lower, TOOWOR_PC),
  };
}

function parseSignAtFromBody(body) {
  const raw = body && body.signAt;
  return toChinaLocalDateTimeForSql(raw == null || raw === '' ? new Date() : raw);
}

const PRO_SIGN_BATCH_SUBMIT_SQL_TEMPLATE = `INSERT INTO dbo.work_reports (order_id, operation_id, user_id, reporter_user_code, good_qty, scrap_qty, remark, batch_line_id)
VALUES (@orderId, @operationId, @userId, @userCode, @goodQty, @scrapQty, @remark, @lineId)`;

async function writeProSignSqlLog(pool, payload) {
  const batchIdNum = Number(payload && payload.batchId);
  const batchId = Number.isFinite(batchIdNum) ? Math.trunc(batchIdNum) : null;
  const userCode =
    payload && payload.userCode != null && String(payload.userCode).trim() !== ''
      ? String(payload.userCode).trim().slice(0, 64)
      : null;
  const endpoint =
    payload && payload.endpoint != null && String(payload.endpoint).trim() !== ''
      ? String(payload.endpoint).trim().slice(0, 128)
      : null;
  const sqlText =
    payload && payload.sqlText != null && String(payload.sqlText).trim() !== ''
      ? String(payload.sqlText).trim().slice(0, 4000)
      : null;

  let paramsJson = null;
  if (payload && payload.params !== undefined) {
    try {
      paramsJson = JSON.stringify(payload.params);
    } catch (_) {
      paramsJson = null;
    }
  }
  if (paramsJson && paramsJson.length > 4000) {
    paramsJson = paramsJson.slice(0, 4000);
  }

  await pool
    .request()
    .input('batchId', sql.BigInt, batchId != null ? BigInt(batchId) : null)
    .input('userCode', sql.NVarChar(64), userCode)
    .input('endpoint', sql.NVarChar(128), endpoint)
    .input('sqlText', sql.NVarChar(4000), sqlText)
    .input('paramsJson', sql.NVarChar(4000), paramsJson)
    .query(
      `INSERT INTO dbo.pro_sign_sql_logs (batch_id, user_code, endpoint, sql_text, params_json, created_at)
       VALUES (@batchId, @userCode, @endpoint, @sqlText, @paramsJson, ${SQL_CHINA_LOCAL_NOW_EXPR})`
    );
}

function normalizeOperatorCodesForDb(body, userCode) {
  let arr = body && body.operatorCodes;
  if (!Array.isArray(arr)) arr = [];
  arr = arr.map((x) => String(x).trim()).filter((s) => s.length);
  const uc = String(userCode || '').trim();
  if (!arr.length && uc) arr = [uc];
  const joined = [...new Set(arr)].join(',');
  return joined.length ? joined.slice(0, 500) : null;
}

function parseOptionalLineDateTime(v) {
  if (v == null || v === '') return null;
  return toChinaLocalDateTimeForSql(v);
}

function parseOnlineSignBaseOFields(line) {
  const baseOType = String(
    line.baseOType != null ? line.baseOType : line.BaseOType != null ? line.BaseOType : ''
  )
    .trim()
    .slice(0, 20);
  const baseOEntryRaw = line.baseOEntry != null ? line.baseOEntry : line.BaseOEntry;
  const baseOLineRaw = line.baseOLine != null ? line.baseOLine : line.BaseOLine;
  const baseOEntry =
    baseOEntryRaw != null && baseOEntryRaw !== '' ? Math.trunc(Number(baseOEntryRaw)) : NaN;
  const baseOLine =
    baseOLineRaw != null && baseOLineRaw !== '' ? Math.trunc(Number(baseOLineRaw)) : NaN;
  return { baseOType, baseOEntry, baseOLine };
}

/**
 * 从 mssql 查询结果中解析 DocEntry（多结果集时取含行的集合；列名不区分大小写）
 */
function pickDocEntryFromMssqlResult(result) {
  if (!result) return null;
  const sets = result.recordsets && result.recordsets.length
    ? result.recordsets
    : result.recordset && result.recordset.length
      ? [result.recordset]
      : [];
  for (let s = sets.length - 1; s >= 0; s -= 1) {
    const arr = sets[s];
    if (!arr || !arr.length) continue;
    for (const row of arr) {
      if (!row || typeof row !== 'object') continue;
      for (const k of Object.keys(row)) {
        if (k && k.toLowerCase() === 'docentry' && row[k] != null) {
          const n = Math.trunc(Number(row[k]));
          if (Number.isInteger(n) && n >= 1) return n;
        }
      }
    }
  }
  return null;
}

/** 是否存在 X_ONLINE_SIGN，及 DocEntry 是否为 IDENTITY */
async function getXOnlineSignHeaderMode(pool) {
  const r = await pool.request().query(`
    SELECT
      CASE WHEN OBJECT_ID(N'dbo.X_ONLINE_SIGN', N'U') IS NULL THEN 0 ELSE 1 END AS hasTable,
      CASE
        WHEN OBJECT_ID(N'dbo.X_ONLINE_SIGN', N'U') IS NULL THEN NULL
        ELSE CAST(COLUMNPROPERTY(OBJECT_ID(N'dbo.X_ONLINE_SIGN', N'U'), N'DocEntry', N'IsIdentity') AS INT)
      END AS IsIdentity
  `);
  const row = r.recordset[0] || {};
  if (!row.hasTable) {
    return { hasTable: false, isIdentity: false };
  }
  return { hasTable: true, isIdentity: Number(row.IsIdentity) === 1 };
}

/**
 * 插入 X_ONLINE_SIGN 一行并返回 DocEntry：IDENTITY 用 SCOPE_IDENTITY()；非 IDENTITY 用并发安全 MAX+1（表锁）
 * @param {{ hasTable: boolean, isIdentity: boolean }} mode 由 getXOnlineSignHeaderMode 预先查询
 */
async function insertXOnlineSignHeaderAndGetDocEntry(transaction, header, mode) {
  const rem =
    header && header.remarks != null && String(header.remarks).trim() !== ''
      ? String(header.remarks).trim().slice(0, 500)
      : null;
  const stepCode =
    header && header.stepCode != null && String(header.stepCode).trim() !== ''
      ? String(header.stepCode).trim().slice(0, 100)
      : null;
  const stepName =
    header && header.stepName != null && String(header.stepName).trim() !== ''
      ? String(header.stepName).trim().slice(0, 200)
      : null;
  const signAt = toChinaLocalDateTimeForSql(
    header && header.signAt != null && header.signAt !== '' ? header.signAt : new Date()
  );
  const operatorCodes =
    header && header.operatorCodes != null && String(header.operatorCodes).trim() !== ''
      ? String(header.operatorCodes).trim().slice(0, 500)
      : null;
  const signType =
    header && header.signType != null && String(header.signType).trim() !== ''
      ? String(header.signType).trim().slice(0, 20)
      : null;
  if (!mode || !mode.hasTable) {
    const e = new Error('X_ONLINE_SIGN missing');
    e.code = 'ONLINE_SIGN_NO_TABLE';
    throw e;
  }
  if (mode.isIdentity) {
    const out = await new sql.Request(transaction)
      .input('remarks', sql.NVarChar(500), rem)
      .input('stepCode', sql.NVarChar(100), stepCode)
      .input('stepName', sql.NVarChar(200), stepName)
      .input('signAt', sql.DateTime2, signAt)
      .input('operatorCodes', sql.NVarChar(500), operatorCodes)
      .input('signType', sql.NVarChar(20), signType)
      .query(
        `INSERT INTO dbo.X_ONLINE_SIGN (Remarks, StepCode, StepName, SignAt, OperatorCodes, SignType)
         VALUES (@remarks, @stepCode, @stepName, @signAt, @operatorCodes, @signType);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS DocEntry;`
      );
    let de = pickDocEntryFromMssqlResult(out);
    if (de == null) {
      const sc = await new sql.Request(transaction).query(
        `SELECT CAST(SCOPE_IDENTITY() AS INT) AS DocEntry;`
      );
      de = pickDocEntryFromMssqlResult(sc);
    }
    if (de == null) {
      const idc = await new sql.Request(transaction).query(
        `SELECT CAST(IDENT_CURRENT('dbo.X_ONLINE_SIGN') AS INT) AS DocEntry;`
      );
      de = pickDocEntryFromMssqlResult(idc);
    }
    if (de == null) {
      const last = await new sql.Request(transaction).query(
        `SELECT TOP 1 DocEntry FROM dbo.X_ONLINE_SIGN WITH (UPDLOCK, HOLDLOCK) ORDER BY DocEntry DESC;`
      );
      de = pickDocEntryFromMssqlResult(last);
    }
    if (de == null || de < 1) {
      const e = new Error('Scope identity null');
      e.code = 'ONLINE_SIGN_NO_ID';
      throw e;
    }
    return de;
  }
  const nextR = await new sql.Request(transaction).query(
    `SELECT ISNULL(MAX(DocEntry), 0) + 1 AS NextD FROM dbo.X_ONLINE_SIGN WITH (TABLOCKX, HOLDLOCK);`
  );
  const raw = nextR.recordset[0] && nextR.recordset[0].NextD;
  const de = raw != null ? Math.trunc(Number(raw)) : NaN;
  if (!Number.isInteger(de) || de < 1) {
    const e = new Error('max DocEntry null');
    e.code = 'ONLINE_SIGN_NO_ID';
    throw e;
  }
  await new sql.Request(transaction)
    .input('d', sql.Int, de)
    .input('remarks', sql.NVarChar(500), rem)
    .input('stepCode', sql.NVarChar(100), stepCode)
    .input('stepName', sql.NVarChar(200), stepName)
    .input('signAt', sql.DateTime2, signAt)
    .input('operatorCodes', sql.NVarChar(500), operatorCodes)
    .input('signType', sql.NVarChar(20), signType)
    .query(
      `INSERT INTO dbo.X_ONLINE_SIGN (DocEntry, Remarks, StepCode, StepName, SignAt, OperatorCodes, SignType)
       VALUES (@d, @remarks, @stepCode, @stepName, @signAt, @operatorCodes, @signType);`
    );
  return de;
}

function displayWorkingSeconds(row) {
  const base = Number(row.total_working_seconds) || 0;
  const st = String(row.status || '');
  if (st === 'in_progress' && row.last_active_at) {
    const t = new Date(row.last_active_at).getTime();
    if (!Number.isNaN(t)) {
      return base + Math.max(0, Math.floor((Date.now() - t) / 1000));
    }
  }
  return base;
}

async function loadMenuRow(pool, routeKey) {
  const rs = await pool
    .request()
    .input('rk', sql.NVarChar(64), routeKey)
    .query(`SELECT id, label, route_key, enabled, roles_json, menu_kind, query_template, filter_schema_json, 
                   ai_prompt,
                   COALESCE(column_name_mapping_json, N'{}') AS column_name_mapping_json
            FROM dbo.nav_menu_items WHERE route_key = @rk`);
  return rs.recordset && rs.recordset[0];
}

async function proSignRoutes(fastify) {
  fastify.post(
    '/pro-sign/run-list',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {};
      const routeKey = String(body.routeKey || '')
        .trim()
        .toLowerCase();
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      const page = body.page;
      const pageSize = body.pageSize;

      if (routeKey !== PRO_SIGN_ROUTE) {
        return reply.code(400).send({ error: 'routeKey 须为 pro-sign', code: 'PRO_SIGN_BAD_REQUEST' });
      }

      const userRole = String(request.user.role || 'operator');
      const pool = await getPool();

      let row;
      try {
        row = await loadMenuRow(pool, routeKey);
      } catch (err) {
        request.log.error({ err }, 'pro-sign/run-list load menu');
        return reply.code(503).send({
          error: '无法读取菜单配置',
          code: 'NAV_CONFIG_ERROR',
        });
      }

      if (!row || !row.enabled) {
        return reply.code(404).send({ error: '菜单不存在或未启用', code: 'REPORT_MENU_NOT_FOUND' });
      }

      const roles = parseRolesJson(row.roles_json);
      if (!roles.includes(userRole)) {
        return reply.code(403).send({ error: '无权访问', code: 'PRO_SIGN_FORBIDDEN' });
      }

      const menuKind = String(row.menu_kind || 'builtin').toLowerCase();
      let template;
      let templateKind;
      let schemaFields;

      if (menuKind === 'report') {
        template = normalizeTemplate(row.query_template || '');
        if (!template) {
          return reply.code(503).send({ error: '报表未配置 SQL 模板', code: 'REPORT_TEMPLATE_EMPTY' });
        }
        const fs = parseFilterSchemaJson(row.filter_schema_json || '[]');
        if (!fs.ok) {
          return reply.code(503).send({ error: fs.error, code: 'REPORT_SCHEMA_INVALID' });
        }
        schemaFields = fs.fields;
        templateKind = detectTemplateKind(template);
        if (!templateKind) {
          return reply.code(503).send({ error: 'SQL 模板无效', code: 'REPORT_TEMPLATE_INVALID' });
        }
      } else {
        template = DEFAULT_PRO_SIGN_SQL;
        templateKind = 'select';
        schemaFields = DEFAULT_FILTER_SCHEMA;
      }

      const mapParse = parseColumnNameMappingJson(
        row.column_name_mapping_json != null && String(row.column_name_mapping_json).trim() !== ''
          ? row.column_name_mapping_json
          : '{}'
      );
      const colMap = mapParse.ok ? mapParse.mapping : {};

      try {
        const rawResult = await executeReportQuery(pool, {
          templateKind,
          sqlTemplate: template,
          schemaFields,
          params,
          sessionInject: buildReportSessionInject(request.user),
          page,
          pageSize,
        });
        const result = applyColumnNameMapping(rawResult, colMap);
        return {
          routeKey,
          label: row.label,
          columns: result.columns,
          rows: result.rows,
          truncated: result.truncated || false,
          page: result.page,
          pageSize: result.pageSize,
          totalRowCount: result.totalRowCount,
          clientSidePaging: result.clientSidePaging || false,
        };
      } catch (err) {
        const code = err.code || 'REPORT_EXEC_ERROR';
        if (code === 'REPORT_BAD_PAGING') {
          return reply.code(400).send({ error: err.message, code });
        }
        if (
          code === 'REPORT_PARAM_REQUIRED' ||
          code === 'REPORT_PARAM_INVALID' ||
          code === 'REPORT_OPTIONS_SQL_BAD_RESULT'
        ) {
          return reply.code(400).send({ error: err.message, code });
        }
        if (code === 'REPORT_QUERY_TIMEOUT') {
          return reply.code(504).send({ error: err.message, code });
        }
        request.log.error({ err }, 'pro-sign/run-list execute');
        return reply.code(500).send({
          error: '查询执行失败',
          code: 'REPORT_EXEC_ERROR',
          detail: err.message || String(err),
        });
      }
    }
  );

  /**
   * 生产报工列表：订单只读详情
   * - 从 nav_menu_items.detail_query_template 读取明细 EXEC/SQL（按 routeKey）
   * - 按模板中的 @参数名 绑定：@_loginUser 等会话注入；其余来自 body.params / detailKey
   * - 支持多 recordset
   *
   * 返回：{ routeKey, label, tables: [{ index, columns, rows }] }
   */
  fastify.post(
    '/pro-sign/order-detail',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {}
      const routeKey = String(body.routeKey || 'pro-sign')
        .trim()
        .toLowerCase()
      const params = body.params && typeof body.params === 'object' ? body.params : {}
      const detailKey = body.detailKey

      const loginUser = String(request.user?.username || '').trim()
      const loginDisplayName = String(request.user?.displayName || '').trim() || loginUser

      if (!loginUser) {
        return reply.code(401).send({ error: '无效登录', code: 'UNAUTHORIZED' })
      }
      if (!routeKey) {
        return reply.code(400).send({ error: '缺少 routeKey', code: 'PRO_SIGN_ROUTEKEY_REQUIRED' })
      }

      const pool = await getPool()

      // Load detail procedure/template from menu config (nav_menu_items)
      let menuRow
      try {
        const rs0 = await pool
          .request()
          .input('rk', sql.NVarChar(64), routeKey)
          .query(`SELECT id, label, route_key, enabled, roles_json, menu_kind,
                  detail_query_template, detail_key_param
                  FROM dbo.nav_menu_items
                  WHERE route_key = @rk`)
        menuRow = rs0.recordset && rs0.recordset[0]
      } catch (err) {
        request.log.error({ err }, 'pro-sign/order-detail load menu')
        return reply.code(503).send({
          error: '无法读取菜单配置，请确认已执行数据库迁移',
          code: 'NAV_CONFIG_ERROR',
        })
      }

      if (!menuRow || !menuRow.enabled) {
        return reply.code(404).send({ error: '菜单不存在或未启用', code: 'PRO_SIGN_MENU_NOT_FOUND' })
      }

      const detailTpl = String(menuRow.detail_query_template || '').trim()
      if (!detailTpl) {
        return reply.code(503).send({
          error: '未配置明细存储过程/SQL',
          code: 'PRO_SIGN_DETAIL_NOT_CONFIGURED',
        })
      }

      // If caller provided detailKey, map it to configured detail_key_param
      const dkpRaw = String(menuRow.detail_key_param || '').trim()
      const dkp = dkpRaw || 'detailKey'
      const normalizedParams = { ...(params || {}) }
      if (detailKey !== undefined && detailKey !== null && detailKey !== '') {
        normalizedParams[dkp] = detailKey
      }

      const getParamCI = (obj, key) => {
        if (!obj || typeof obj !== 'object') return undefined
        if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key]
        const lower = String(key).toLowerCase()
        for (const k of Object.keys(obj)) {
          if (String(k).toLowerCase() === lower) return obj[k]
        }
        return undefined
      }

      // Extract @param names from template in appearance order (dedup)
      const paramNames = []
      const seen = new Set()
      const re = /@([a-zA-Z_][a-zA-Z0-9_]*)/g
      let match
      while ((match = re.exec(detailTpl))) {
        const name = match[1]
        if (!name || seen.has(name)) continue
        seen.add(name)
        paramNames.push(name)
      }

      const req = pool.request()
      // Bind parameters expected by the menu-configured template
      for (const name of paramNames) {
        let v
        if (name === '_loginUser') v = loginUser
        else if (name === '_loginDisplayName') v = loginDisplayName
        else if (name.toLowerCase() === 'usercode') v = loginUser
        else if (name.toLowerCase() === 'username') v = loginUser
        else if (name.toLowerCase() === 'userid') v = loginUser
        else v = getParamCI(normalizedParams, name)

        const empty = v === undefined || v === null || v === ''
        if (empty) {
          return reply.code(400).send({
            error: `缺少明细参数: ${name}`,
            code: 'PRO_SIGN_DETAIL_PARAM_MISSING',
            param: name,
          })
        }

        // Use NVarchar as a safe default (SQL Server will coerce where possible)
        const s = typeof v === 'string' ? v : String(v)
        req.input(name, sql.NVarChar(4000), s.slice(0, 4000))
      }

      let rs
      try {
        rs = await req.query(detailTpl)
      } catch (e) {
        request.log.error({ e }, 'pro-sign/order-detail exec template failed')
        return reply.code(500).send({
          error: '加载订单详情失败',
          code: 'PRO_SIGN_ORDER_DETAIL_EXEC_ERROR',
          detail: e.message || String(e),
        })
      }

      const sets = Array.isArray(rs.recordsets) && rs.recordsets.length ? rs.recordsets : (rs.recordset ? [rs.recordset] : [])
      const tables = (sets || []).map((set, idx) => {
        const rowsRaw = Array.isArray(set) ? set : []
        const rows = rowsRaw.map((r) => jsonSafeMssqlRow(r))

        // 列名：按首次出现顺序取并集（用于表头）
        const cols = []
        const seen = new Set()
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue
          for (const k of Object.keys(row)) {
            if (seen.has(k)) continue
            seen.add(k)
            cols.push(k)
          }
        }

        return {
          index: idx + 1,
          columns: cols,
          rows,
        }
      })

      return { routeKey, label: menuRow.label, tables }
    }
  )

  /**
   * 合并报工前：按行调用 SAP/业务库存储过程 Z_ONLINE_TOOWORSIGN_DETAIL
   * 参数：@UserCode、@DocEntry、@SetupCode、@Status、@BaseOType、@BaseOEntry、@BaseOLine
   * 首列值为 0 时视为失败，并返回 msg；否则通过预检。
   * 成功时从首行解析 display：BaseEntry/工单名（非 DocEntry 主键）与 Setup*、ItemName、数量；数量仅列名
   * Quantity 匹配。中文别名列如工单号、工序编码 等。完整 recordsets 随 lineResults 一并返回。
   */
  fastify.post(
    '/pro-sign/toowor-sign-detail',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userCode = String(request.user.username || '').trim();
      if (!userCode) {
        return reply.code(401).send({ error: '无效登录', code: 'UNAUTHORIZED' });
      }
      const body = request.body || {};
      const { lines } = body;
      if (!Array.isArray(lines) || lines.length === 0) {
        return reply.code(400).send({ error: '请至少选择一行明细', code: 'PRO_SIGN_LINES_EMPTY' });
      }
      if (lines.length > MAX_BATCH_LINES) {
        return reply.code(400).send({ error: `明细行不能超过 ${MAX_BATCH_LINES} 条`, code: 'PRO_SIGN_TOO_MANY' });
      }
      const statusRaw = body.status != null ? body.status : body.Status;
      const status = String(statusRaw != null ? statusRaw : '').trim().slice(0, 20);
      if (!status) {
        return reply.code(400).send({
          error: '缺少查询状态 Status',
          code: 'TOOWOR_STATUS_MISSING',
        });
      }

      const pool = await getPool();
      const lineResults = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] || {};
        const docEntry = String(line.docEntry != null ? line.docEntry : line.DocEntry != null ? line.DocEntry : '').trim();
        const stepCode = String(
          line.stepCode != null ? line.stepCode : line.StepCode != null ? line.StepCode : line.setupCode != null
            ? line.setupCode
            : line.SetupCode != null
              ? line.SetupCode
              : ''
        ).trim();
        const baseOType = String(
          line.baseOType != null
            ? line.baseOType
            : line.BaseOType != null
              ? line.BaseOType
              : ''
        ).trim();
        const baseOEntry = String(
          line.baseOEntry != null
            ? line.baseOEntry
            : line.BaseOEntry != null
              ? line.BaseOEntry
              : ''
        ).trim();
        const baseOLine = String(
          line.baseOLine != null
            ? line.baseOLine
            : line.BaseOLine != null
              ? line.BaseOLine
              : ''
        ).trim();
        if (!docEntry || !stepCode || !baseOType || !baseOEntry || !baseOLine) {
          return reply.code(400).send({
            error: '每行须包含 docEntry、stepCode、baseOType、baseOEntry、baseOLine',
            code: 'TOOWOR_BAD_LINE',
          });
        }
        let rs;
        try {
          rs = await pool
            .request()
            .input('UserCode', sql.NVarChar(50), userCode.slice(0, 50))
            .input('DocEntry', sql.NVarChar(50), docEntry.slice(0, 50))
            .input('SetupCode', sql.NVarChar(50), stepCode.slice(0, 50))
            .input('Status', sql.NVarChar(20), status)
            .input('BaseOType', sql.NVarChar(20), baseOType.slice(0, 20))
            .input('BaseOEntry', sql.NVarChar(50), baseOEntry.slice(0, 50))
            .input('BaseOLine', sql.NVarChar(20), baseOLine.slice(0, 20))
            .query(
              'EXEC dbo.Z_ONLINE_TOOWORSIGN_DETAIL @UserCode, @DocEntry, @SetupCode, @Status, @BaseOType, @BaseOEntry, @BaseOLine'
            );
        } catch (e) {
          request.log.error({ e }, 'Z_ONLINE_TOOWORSIGN_DETAIL');
          return reply.code(500).send({
            error: '合并报工预检执行失败，请确认已部署存储过程 Z_ONLINE_TOOWORSIGN_DETAIL',
            code: 'TOOWOR_EXEC_ERROR',
            detail: e.message || String(e),
          });
        }
        const row0 = rs.recordset && rs.recordset[0];
        if (!row0) {
          return reply.code(400).send({
            error: '存储过程未返回数据',
            code: 'TOOWOR_NO_RESULT',
            docEntry,
            stepCode,
          });
        }
        const firstVal = Object.values(row0)[0];
        const isProcFailure =
          firstVal === 0 ||
          firstVal === 0n ||
          (typeof firstVal === 'string' && firstVal.trim() === '0') ||
          (typeof firstVal === 'number' && !Number.isNaN(firstVal) && firstVal === 0);
        if (isProcFailure) {
          let userMsg;
          for (const k of Object.keys(row0)) {
            if (k.toLowerCase() === 'msg' && row0[k] != null) {
              userMsg = String(row0[k]);
              break;
            }
          }
          return reply.code(400).send({
            error: userMsg && userMsg.length ? userMsg : '该明细不可合并报工',
            code: 'TOOWOR_SIGN_REJECTED',
            docEntry,
            stepCode,
          });
        }
        const display = parseTooworDisplayFromRow(row0);
        const recordsets = serializeMssqlRecordsets(rs);
        lineResults.push({ docEntry, stepCode, display, recordsets });
      }
      return { ok: true, lineResults };
    }
  );

  /**
   * 合并报工接单页：操作员多选数据源（业务库视图 X_ONLINE_VIEW_OHEM）
   */
  fastify.get(
    '/pro-sign/online-sign-operators',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      try {
        const pool = await getPool();
        const rs = await pool.request().query(
          `SELECT LTRIM(RTRIM(CAST(code AS NVARCHAR(100)))) AS code,
                  LTRIM(RTRIM(CAST(name AS NVARCHAR(200)))) AS name
           FROM dbo.X_ONLINE_VIEW_OHEM
           WHERE code IS NOT NULL AND LTRIM(RTRIM(CAST(code AS NVARCHAR(100)))) <> N''
           ORDER BY code`
        );
        const operators = (rs.recordset || []).map((row) => ({
          code: row.code != null ? String(row.code) : '',
          name: row.name != null ? String(row.name) : '',
        }));
        return { operators };
      } catch (e) {
        request.log.warn(e, '[pro-sign] X_ONLINE_VIEW_OHEM 不可用，返回空操作员列表');
        return { operators: [] };
      }
    }
  );

  /**
   * 合并报工「接单」保存：X_ONLINE_SIGN 抬头 + X_ONLINE_SIGN1 明细
   * DocEntry 为 IDENTITY，并发安全。
   */
  fastify.post(
    '/pro-sign/online-sign-save',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userCode = String(request.user.username || '').trim();
      if (!userCode) {
        return reply.code(401).send({ error: '无效登录', code: 'UNAUTHORIZED' });
      }
      const body = request.body || {};
      const { remarks, lines } = body;
      if (!Array.isArray(lines) || lines.length === 0) {
        return reply.code(400).send({ error: '请至少选择一行明细', code: 'ONLINE_SIGN_EMPTY' });
      }
      if (lines.length > MAX_BATCH_LINES) {
        return reply.code(400).send({ error: `明细行不能超过 ${MAX_BATCH_LINES} 条`, code: 'ONLINE_SIGN_TOO_MANY' });
      }

      const rem = remarks != null ? String(remarks).trim().slice(0, 500) : '';
      const stepCode =
        body.stepCode != null && String(body.stepCode).trim() !== ''
          ? String(body.stepCode).trim().slice(0, 100)
          : null;
      const stepName =
        body.stepName != null && String(body.stepName).trim() !== ''
          ? String(body.stepName).trim().slice(0, 200)
          : null;
      const signAt = parseSignAtFromBody(body);
      const operatorCodesJoined = normalizeOperatorCodesForDb(body, userCode);
      const signType =
        body.signType != null && String(body.signType).trim() !== ''
          ? String(body.signType).trim().slice(0, 20)
          : null;

      const pool = await getPool();
      const signMode = await getXOnlineSignHeaderMode(pool);
      if (!signMode.hasTable) {
        return reply.code(503).send({
          error: '表 X_ONLINE_SIGN 未创建。请执行 sql/migrate-x-online-sign.sql 或启动服务以自动建表',
          code: 'ONLINE_SIGN_NO_TABLE',
        });
      }
      const transaction = new sql.Transaction(pool);

      try {
        await transaction.begin();
        let de;
        try {
          de = await insertXOnlineSignHeaderAndGetDocEntry(
            transaction,
            {
              remarks: rem,
              stepCode,
              stepName,
              signAt,
              operatorCodes: operatorCodesJoined,
              signType,
            },
            signMode
          );
        } catch (insErr) {
          await transaction.rollback();
          if (insErr.code === 'ONLINE_SIGN_NO_ID') {
            return reply.code(500).send({ error: '未生成 DocEntry', code: 'ONLINE_SIGN_NO_ID' });
          }
          if (insErr.code === 'ONLINE_SIGN_NO_TABLE') {
            return reply.code(503).send({
              error: '表 X_ONLINE_SIGN 不可用',
              code: 'ONLINE_SIGN_NO_TABLE',
            });
          }
          throw insErr;
        }
        if (!Number.isInteger(de) || de < 1) {
          await transaction.rollback();
          return reply.code(500).send({ error: 'DocEntry 无效', code: 'ONLINE_SIGN_BAD_ID' });
        }
        let lineId = 0;
        for (const line of lines) {
          lineId += 1;
          const baseEntry =
            line.baseEntry != null
              ? Number(line.baseEntry)
              : line.BaseEntry != null
                ? Number(line.BaseEntry)
                : NaN;
          if (!Number.isInteger(baseEntry)) {
            await transaction.rollback();
            return reply.code(400).send({ error: '每行须为有效整数 BaseEntry', code: 'ONLINE_SIGN_BAD_BASE' });
          }
          const rawQ = line.quantity != null ? line.quantity : line.Quantity;
          const qty = rawQ == null || rawQ === '' ? null : Number(rawQ);
          if (rawQ != null && rawQ !== '' && (typeof qty !== 'number' || !Number.isFinite(qty))) {
            await transaction.rollback();
            return reply.code(400).send({ error: '数量无效', code: 'ONLINE_SIGN_BAD_QTY' });
          }
          const lastStepCode = String(
            line.lastStepCode != null ? line.lastStepCode : line.LastStepCode != null ? line.LastStepCode : ''
          )
            .trim()
            .slice(0, 100);
          const lastStepName = String(
            line.lastStepName != null ? line.lastStepName : line.LastStepName != null ? line.LastStepName : ''
          )
            .trim()
            .slice(0, 200);
          const lstRaw =
            line.lastStepTime != null ? line.lastStepTime : line.LastStepTime != null ? line.LastStepTime : null;
          const lastStepTime = parseOptionalLineDateTime(lstRaw);
          const pcRaw = line.pc != null ? line.pc : line.PC != null ? line.PC : '';
          const pc = String(pcRaw)
            .trim()
            .slice(0, 200);
          const itemNameRaw =
            line.itemName != null ? line.itemName : line.ItemName != null ? line.ItemName : '';
          const itemName = String(itemNameRaw)
            .trim()
            .slice(0, 500);
          const { baseOType, baseOEntry, baseOLine } = parseOnlineSignBaseOFields(line);
          if (!baseOType || !Number.isInteger(baseOEntry) || !Number.isInteger(baseOLine)) {
            await transaction.rollback();
            return reply.code(400).send({
              error: '每行须包含有效的 baseOType、baseOEntry、baseOLine',
              code: 'ONLINE_SIGN_BAD_BASE_O',
            });
          }
          await new sql.Request(transaction)
            .input('de', sql.Int, de)
            .input('lineId', sql.Int, lineId)
            .input('be', sql.Int, baseEntry)
            .input('qty', sql.Decimal(19, 2), qty)
            .input('lsc', sql.NVarChar(100), lastStepCode || null)
            .input('lsn', sql.NVarChar(200), lastStepName || null)
            .input('lst', sql.DateTime2, lastStepTime)
            .input('pc', sql.NVarChar(200), pc || null)
            .input('itemName', sql.NVarChar(500), itemName || null)
            .input('bot', sql.NVarChar(20), baseOType)
            .input('boe', sql.Int, baseOEntry)
            .input('bol', sql.Int, baseOLine)
            .query(
              `INSERT INTO dbo.X_ONLINE_SIGN1 (DocEntry, LineId, BaseEntry, Quantity, LastStepCode, LastStepName, LastStepTime, PC, ItemName, BaseOType, BaseOEntry, BaseOLine)
               VALUES (@de, @lineId, @be, @qty, @lsc, @lsn, @lst, @pc, @itemName, @bot, @boe, @bol)`
            );
        }
        await transaction.commit();
        return { ok: true, docEntry: de, reporterUserCode: userCode };
      } catch (e) {
        try {
          await transaction.rollback();
        } catch (_) {}
        request.log.error(e);
        const msg = e.message || String(e);
        if (msg.includes('X_ONLINE_SIGN') && (msg.includes('Invalid object name') || msg.includes('对象名'))) {
          return reply.code(503).send({
            error: '表 X_ONLINE_SIGN 未创建。请执行 sql/migrate-x-online-sign.sql 或启动服务以自动建表',
            code: 'ONLINE_SIGN_NO_TABLE',
          });
        }
        return reply.code(500).send({ error: '保存失败', code: 'ONLINE_SIGN_ERR', detail: msg });
      }
    }
  );

  fastify.post(
    '/pro-sign/batches',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userCode = String(request.user.username || '').trim();
      if (!userCode) {
        return reply.code(401).send({ error: '无效登录' });
      }
      const userIdBig = userCodeToStableBigInt(userCode);
      const { lines } = request.body || {};
      if (!Array.isArray(lines) || lines.length === 0) {
        return reply.code(400).send({ error: '请至少选择一行明细', code: 'PRO_SIGN_LINES_EMPTY' });
      }
      if (lines.length > MAX_BATCH_LINES) {
        return reply.code(400).send({ error: `明细行不能超过 ${MAX_BATCH_LINES} 条`, code: 'PRO_SIGN_TOO_MANY' });
      }

      const pool = await getPool();
      const transaction = new sql.Transaction(pool);

      try {
        await transaction.begin();

        const insBatch = new sql.Request(transaction)
          .input('userId', sql.BigInt, userIdBig)
          .input('userCode', sql.NVarChar(64), userCode);

        const batchRs = await insBatch.query(
          `INSERT INTO dbo.X_report_batch (user_id, reporter_user_code, status)
           OUTPUT INSERTED.id AS id
           VALUES (@userId, @userCode, N'pending')`
        );
        const batchId = batchRs.recordset[0].id;
        if (batchId == null) {
          await transaction.rollback();
          return reply.code(500).send({ error: '创建批次失败' });
        }

        let sort = 0;
        for (const line of lines) {
          const orderId = toBigIntId(line.orderId);
          const operationId = toBigIntId(line.operationId);
          if (orderId == null || operationId == null) {
            await transaction.rollback();
            return reply.code(400).send({ error: '每行须包含有效的 orderId 与 operationId', code: 'PRO_SIGN_BAD_LINE' });
          }

          const chk = await new sql.Request(transaction)
            .input('oid', sql.BigInt, orderId)
            .input('opid', sql.BigInt, operationId)
            .query(
              `SELECT oo.id FROM dbo.order_operations oo
               WHERE oo.id = @opid AND oo.order_id = @oid`
            );
          if (!chk.recordset[0]) {
            await transaction.rollback();
            return reply.code(400).send({ error: '工序与订单不匹配', code: 'PRO_SIGN_OP_MISMATCH' });
          }

          sort += 1;
          await new sql.Request(transaction)
            .input('bid', sql.BigInt, BigInt(batchId))
            .input('oid', sql.BigInt, orderId)
            .input('opid', sql.BigInt, operationId)
            .input('sort', sql.Int, sort)
            .query(
              `INSERT INTO dbo.X_report_batch_line (batch_id, order_id, operation_id, sort_order)
               VALUES (@bid, @oid, @opid, @sort)`
            );
        }

        await new sql.Request(transaction)
          .input('bid', sql.BigInt, BigInt(batchId))
          .input('uid', sql.BigInt, userIdBig)
          .query(
            `INSERT INTO dbo.X_task_logs (batch_id, action_type, user_id)
             VALUES (@bid, N'create', @uid)`
          );

        await transaction.commit();
        return { batchId: Number(batchId), ok: true };
      } catch (e) {
        try {
          await transaction.rollback();
        } catch (_) {}
        request.log.error(e);
        return reply.code(500).send({ error: '创建批次失败', detail: e.message });
      }
    }
  );

  fastify.get(
    '/pro-sign/batches/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) {
        return reply.code(400).send({ error: '无效的批次 ID' });
      }
      const userCode = String(request.user.username || '').trim();
      const userIdBig = userCodeToStableBigInt(userCode);

      const pool = await getPool();
      const batchRs = await pool
        .request()
        .input('id', sql.BigInt, BigInt(id))
        .query(
          `SELECT id, user_id, reporter_user_code, status, received_at, work_started_at, last_active_at,
                  completed_at, pause_reason, total_working_seconds, created_at, updated_at
           FROM dbo.X_report_batch WHERE id = @id`
        );
      const batch = batchRs.recordset[0];
      if (!batch) {
        return reply.code(404).send({ error: '批次不存在' });
      }
      if (String(batch.user_id) !== String(userIdBig)) {
        return reply.code(403).send({ error: '无权查看该批次' });
      }

      const linesRs = await pool
        .request()
        .input('bid', sql.BigInt, BigInt(id))
        .query(
          `SELECT l.id AS lineId, l.order_id AS orderId, l.operation_id AS operationId, l.sort_order AS sortOrder,
                  po.order_no AS orderNo, po.product_name AS productName,
                  oo.seq_no AS seqNo, oo.operation_name AS operationName
           FROM dbo.X_report_batch_line l
           INNER JOIN dbo.production_orders po ON po.id = l.order_id
           INNER JOIN dbo.order_operations oo ON oo.id = l.operation_id
           WHERE l.batch_id = @bid
           ORDER BY l.sort_order, l.id`
        );

      return {
        batch: {
          id: Number(batch.id),
          status: batch.status,
          reporterUserCode: batch.reporter_user_code,
          receivedAt: batch.received_at,
          workStartedAt: batch.work_started_at,
          lastActiveAt: batch.last_active_at,
          completedAt: batch.completed_at,
          pauseReason: batch.pause_reason,
          totalWorkingSeconds: Number(batch.total_working_seconds) || 0,
          displayWorkingSeconds: displayWorkingSeconds(batch),
          createdAt: batch.created_at,
        },
        lines: linesRs.recordset || [],
      };
    }
  );

  fastify.post(
    '/pro-sign/batches/:id/accept',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      return handleBatchAction(request, reply, 'accept');
    }
  );

  fastify.post(
    '/pro-sign/batches/:id/pause',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const reason = String((request.body || {}).reason || '').trim().slice(0, 512);
      if (!reason) {
        return reply.code(400).send({ error: '请填写暂停原因' });
      }
      return handleBatchAction(request, reply, 'pause', { reason });
    }
  );

  fastify.post(
    '/pro-sign/batches/:id/resume',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      return handleBatchAction(request, reply, 'resume');
    }
  );

  fastify.post(
    '/pro-sign/batches/:id/submit',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userCode = String(request.user.username || '').trim();
      if (!userCode) {
        return reply.code(401).send({ error: '无效登录' });
      }
      const userIdBig = userCodeToStableBigInt(userCode);
      const batchId = Number(request.params.id);
      if (!Number.isFinite(batchId)) {
        return reply.code(400).send({ error: '无效的批次 ID' });
      }
      const { lines } = request.body || {};
      if (!Array.isArray(lines) || lines.length === 0) {
        return reply.code(400).send({ error: '请填写报工明细' });
      }

      const pool = await getPool();
      try {
        await writeProSignSqlLog(pool, {
          batchId,
          userCode,
          endpoint: '/pro-sign/batches/:id/submit',
          sqlText: PRO_SIGN_BATCH_SUBMIT_SQL_TEMPLATE,
          params: {
            lineCount: Array.isArray(lines) ? lines.length : 0,
            sample: Array.isArray(lines)
              ? lines.slice(0, 5).map((item) => ({
                  lineId: Number(item && item.lineId),
                  goodQty: Number(item && item.goodQty),
                  scrapQty: Number((item && item.scrapQty) ?? 0),
                }))
              : [],
          },
        });
      } catch (logErr) {
        request.log.warn({ err: logErr }, '[pro-sign] 写 SQL 日志失败，已忽略');
      }
      const transaction = new sql.Transaction(pool);

      try {
        await transaction.begin();

        const lockReq = new sql.Request(transaction);
        lockReq.input('id', sql.BigInt, BigInt(batchId));
        const batchRs = await lockReq.query(
          `SELECT id, user_id, status, last_active_at, total_working_seconds
           FROM dbo.X_report_batch WITH (UPDLOCK, ROWLOCK) WHERE id = @id`
        );
        const batch = batchRs.recordset[0];
        if (!batch) {
          await transaction.rollback();
          return reply.code(404).send({ error: '批次不存在' });
        }
        if (String(batch.user_id) !== String(userIdBig)) {
          await transaction.rollback();
          return reply.code(403).send({ error: '无权操作' });
        }
        const st = String(batch.status || '');
        if (st === 'completed') {
          await transaction.rollback();
          return reply.code(400).send({ error: '该批次已完工' });
        }
        if (st === 'pending') {
          await transaction.rollback();
          return reply.code(400).send({ error: '请先接单开工' });
        }

        let totalSecs = Number(batch.total_working_seconds) || 0;
        if (st === 'in_progress' && batch.last_active_at) {
          const t = new Date(batch.last_active_at).getTime();
          if (!Number.isNaN(t)) {
            totalSecs += Math.max(0, Math.floor((Date.now() - t) / 1000));
          }
        }

        const lineIdsRs = await new sql.Request(transaction)
          .input('bid', sql.BigInt, BigInt(batchId))
          .query(`SELECT id, order_id, operation_id FROM dbo.X_report_batch_line WHERE batch_id = @bid`);
        const validLines = new Map();
        for (const r of lineIdsRs.recordset || []) {
          validLines.set(Number(r.id), {
            orderId: Number(r.order_id),
            operationId: r.operation_id != null ? Number(r.operation_id) : null,
          });
        }

        for (const item of lines) {
          const lineId = Number(item.lineId);
          if (!validLines.has(lineId)) {
            await transaction.rollback();
            return reply.code(400).send({ error: '无效的行 ID: ' + lineId });
          }
          const good = Number(item.goodQty);
          const scrap = Number(item.scrapQty ?? 0);
          if (!Number.isFinite(good) || good < 0) {
            await transaction.rollback();
            return reply.code(400).send({ error: '良品数量无效' });
          }
          if (!Number.isFinite(scrap) || scrap < 0) {
            await transaction.rollback();
            return reply.code(400).send({ error: '不良数量无效' });
          }
        }

        for (const item of lines) {
          const lineId = Number(item.lineId);
          const meta = validLines.get(lineId);
          const good = Number(item.goodQty);
          const scrap = Number(item.scrapQty ?? 0);
          const remark = String(item.remark || '').slice(0, 512);

          const orderLock = await new sql.Request(transaction)
            .input('orderId', sql.BigInt, BigInt(meta.orderId))
            .query(
              `SELECT id, status, planned_qty, reported_qty
               FROM dbo.production_orders WITH (UPDLOCK, ROWLOCK) WHERE id = @orderId`
            );
          const ord = orderLock.recordset[0];
          if (!ord) {
            await transaction.rollback();
            return reply.code(404).send({ error: '订单不存在' });
          }
          if (ord.status === 'cancelled' || ord.status === 'completed') {
            await transaction.rollback();
            return reply.code(400).send({ error: '订单 ' + meta.orderId + ' 不可再报工' });
          }

          const ins = new sql.Request(transaction)
            .input('orderId', sql.BigInt, BigInt(meta.orderId))
            .input('userId', sql.BigInt, userIdBig)
            .input('userCode', sql.NVarChar(64), userCode)
            .input('goodQty', sql.Decimal(18, 4), good)
            .input('scrapQty', sql.Decimal(18, 4), scrap)
            .input('remark', sql.NVarChar(512), remark)
            .input('lineId', sql.BigInt, BigInt(lineId));

          if (meta.operationId != null) {
            ins.input('operationId', sql.BigInt, BigInt(meta.operationId));
            await ins.query(
              `INSERT INTO dbo.work_reports (order_id, operation_id, user_id, reporter_user_code, good_qty, scrap_qty, remark, batch_line_id)
               VALUES (@orderId, @operationId, @userId, @userCode, @goodQty, @scrapQty, @remark, @lineId)`
            );
          } else {
            await ins.query(
              `INSERT INTO dbo.work_reports (order_id, operation_id, user_id, reporter_user_code, good_qty, scrap_qty, remark, batch_line_id)
               VALUES (@orderId, NULL, @userId, @userCode, @goodQty, @scrapQty, @remark, @lineId)`
            );
          }

          const delta = good + scrap;
          await new sql.Request(transaction)
            .input('delta', sql.Decimal(18, 4), delta)
            .input('orderId', sql.BigInt, BigInt(meta.orderId))
            .query(
              `UPDATE dbo.production_orders
               SET reported_qty = reported_qty + @delta,
                   status = CASE
                     WHEN reported_qty + @delta >= planned_qty THEN N'completed'
                     ELSE N'in_progress'
                   END,
                   updated_at = SYSUTCDATETIME()
               WHERE id = @orderId`
            );
        }

        await new sql.Request(transaction)
          .input('bid', sql.BigInt, BigInt(batchId))
          .input('secs', sql.Int, totalSecs)
          .input('uid', sql.BigInt, userIdBig)
          .query(
            `UPDATE dbo.X_report_batch
             SET status = N'completed',
                 completed_at = SYSUTCDATETIME(),
                 last_active_at = NULL,
                 total_working_seconds = @secs,
                 updated_at = SYSUTCDATETIME()
             WHERE id = @bid`
          );

        await new sql.Request(transaction)
          .input('bid', sql.BigInt, BigInt(batchId))
          .input('uid', sql.BigInt, userIdBig)
          .input('secs', sql.Int, totalSecs)
          .query(
            `INSERT INTO dbo.X_task_logs (batch_id, action_type, user_id, working_seconds_delta)
             VALUES (@bid, N'submit', @uid, @secs)`
          );

        await transaction.commit();
        return { ok: true, totalWorkingSeconds: totalSecs };
      } catch (e) {
        try {
          await transaction.rollback();
        } catch (_) {}
        request.log.error(e);
        return reply.code(500).send({ error: '提交失败', detail: e.message });
      }
    }
  );
}

async function handleBatchAction(request, reply, action, extra) {
  const userCode = String(request.user.username || '').trim();
  if (!userCode) {
    return reply.code(401).send({ error: '无效登录' });
  }
  const userIdBig = userCodeToStableBigInt(userCode);
  const batchId = Number(request.params.id);
  if (!Number.isFinite(batchId)) {
    return reply.code(400).send({ error: '无效的批次 ID' });
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const batchRs = await new sql.Request(transaction)
      .input('id', sql.BigInt, BigInt(batchId))
      .query(
        `SELECT id, user_id, status, last_active_at, total_working_seconds, work_started_at
         FROM dbo.X_report_batch WITH (UPDLOCK, ROWLOCK) WHERE id = @id`
      );
    const batch = batchRs.recordset[0];
    if (!batch) {
      await transaction.rollback();
      return reply.code(404).send({ error: '批次不存在' });
    }
    if (String(batch.user_id) !== String(userIdBig)) {
      await transaction.rollback();
      return reply.code(403).send({ error: '无权操作' });
    }

    const st = String(batch.status || '');
    const now = new Date();

    if (action === 'accept') {
      if (st !== 'pending') {
        await transaction.rollback();
        return reply.code(400).send({ error: '当前状态不可接单' });
      }
      await new sql.Request(transaction)
        .input('id', sql.BigInt, BigInt(batchId))
        .query(
          `UPDATE dbo.X_report_batch
           SET status = N'in_progress',
               received_at = SYSUTCDATETIME(),
               work_started_at = SYSUTCDATETIME(),
               last_active_at = SYSUTCDATETIME(),
               updated_at = SYSUTCDATETIME()
           WHERE id = @id`
        );
      await new sql.Request(transaction)
        .input('bid', sql.BigInt, BigInt(batchId))
        .input('uid', sql.BigInt, userIdBig)
        .query(
          `INSERT INTO dbo.X_task_logs (batch_id, action_type, user_id)
           VALUES (@bid, N'accept', @uid)`
        );
    } else if (action === 'pause') {
      if (st !== 'in_progress') {
        await transaction.rollback();
        return reply.code(400).send({ error: '当前状态不可暂停' });
      }
      let addSecs = 0;
      if (batch.last_active_at) {
        const t = new Date(batch.last_active_at).getTime();
        if (!Number.isNaN(t)) {
          addSecs = Math.max(0, Math.floor((now.getTime() - t) / 1000));
        }
      }
      const prev = Number(batch.total_working_seconds) || 0;
      await new sql.Request(transaction)
        .input('id', sql.BigInt, BigInt(batchId))
        .input('secs', sql.Int, prev + addSecs)
        .input('reason', sql.NVarChar(512), extra && extra.reason ? String(extra.reason).slice(0, 512) : '')
        .query(
          `UPDATE dbo.X_report_batch
           SET status = N'paused',
               total_working_seconds = @secs,
               last_active_at = NULL,
               pause_reason = @reason,
               updated_at = SYSUTCDATETIME()
           WHERE id = @id`
        );
      await new sql.Request(transaction)
        .input('bid', sql.BigInt, BigInt(batchId))
        .input('uid', sql.BigInt, userIdBig)
        .input('delta', sql.Int, addSecs)
        .input('reason', sql.NVarChar(512), extra && extra.reason ? String(extra.reason).slice(0, 512) : '')
        .query(
          `INSERT INTO dbo.X_task_logs (batch_id, action_type, user_id, working_seconds_delta, reason)
           VALUES (@bid, N'pause', @uid, @delta, @reason)`
        );
    } else if (action === 'resume') {
      if (st !== 'paused') {
        await transaction.rollback();
        return reply.code(400).send({ error: '当前状态不可继续' });
      }
      await new sql.Request(transaction)
        .input('id', sql.BigInt, BigInt(batchId))
        .query(
          `UPDATE dbo.X_report_batch
           SET status = N'in_progress',
               last_active_at = SYSUTCDATETIME(),
               pause_reason = NULL,
               updated_at = SYSUTCDATETIME()
           WHERE id = @id`
        );
      await new sql.Request(transaction)
        .input('bid', sql.BigInt, BigInt(batchId))
        .input('uid', sql.BigInt, userIdBig)
        .query(
          `INSERT INTO dbo.X_task_logs (batch_id, action_type, user_id)
           VALUES (@bid, N'resume', @uid)`
        );
    }

    await transaction.commit();

    const pool2 = await getPool();
    const refreshed = await pool2
      .request()
      .input('id', sql.BigInt, BigInt(batchId))
      .query(
        `SELECT id, status, received_at, work_started_at, last_active_at, completed_at,
                pause_reason, total_working_seconds
         FROM dbo.X_report_batch WHERE id = @id`
      );
    const b = refreshed.recordset[0];
    return {
      ok: true,
      batch: {
        status: b.status,
        displayWorkingSeconds: displayWorkingSeconds(b),
        totalWorkingSeconds: Number(b.total_working_seconds) || 0,
        pauseReason: b.pause_reason,
        workStartedAt: b.work_started_at,
        lastActiveAt: b.last_active_at,
      },
    };
  } catch (e) {
    try {
      await transaction.rollback();
    } catch (_) {}
    request.log.error(e);
    return reply.code(500).send({ error: '操作失败', detail: e.message });
  }
}

module.exports = proSignRoutes;
