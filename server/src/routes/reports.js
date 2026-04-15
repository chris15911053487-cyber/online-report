const { getPool, sql } = require('../db');
const {
  detectTemplateKind,
  normalizeTemplate,
  parseFilterSchemaJson,
  executeReportQuery,
  executeReportDetailQuery,
} = require('../report-query');

function parseRolesJson(s) {
  try {
    const a = JSON.parse(s);
    if (!Array.isArray(a)) return [];
    return a.map((x) => String(x));
  } catch {
    return [];
  }
}

async function reportsRoutes(fastify) {
  fastify.post(
    '/reports/run',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {};
      const routeKey = String(body.routeKey || '')
        .trim()
        .toLowerCase();
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      const page = body.page;
      const pageSize = body.pageSize;

      if (!routeKey) {
        return reply.code(400).send({ error: '请提供 routeKey', code: 'REPORT_BAD_REQUEST' });
      }

      const userRole = String(request.user.role || 'operator');
      const pool = await getPool();

      let row;
      try {
        const rs = await pool
          .request()
          .input('rk', sql.NVarChar(64), routeKey)
          .query(`SELECT id, label, route_key, enabled, roles_json, menu_kind, query_template, filter_schema_json,
                  detail_query_template, detail_key_column, detail_key_param, COALESCE(detail_key_type, N'string') AS detail_key_type
                  FROM dbo.nav_menu_items
                  WHERE route_key = @rk`);
        row = rs.recordset && rs.recordset[0];
      } catch (err) {
        request.log.error({ err }, 'reports/run load menu');
        return reply.code(503).send({
          error: '无法读取菜单配置，请确认已执行数据库迁移',
          code: 'NAV_CONFIG_ERROR',
        });
      }

      if (!row || !row.enabled) {
        return reply.code(404).send({ error: '菜单不存在或未启用', code: 'REPORT_MENU_NOT_FOUND' });
      }

      const roles = parseRolesJson(row.roles_json);
      if (!roles.includes(userRole)) {
        return reply.code(403).send({ error: '无权访问该报表', code: 'REPORT_FORBIDDEN' });
      }

      const menuKind = String(row.menu_kind || 'builtin').toLowerCase();
      if (menuKind !== 'report') {
        return reply
          .code(400)
          .send({ error: '该菜单不是可配置报表', code: 'REPORT_NOT_REPORT_MENU' });
      }

      const template = normalizeTemplate(row.query_template || '');
      if (!template) {
        return reply.code(503).send({ error: '报表未配置 SQL 模板', code: 'REPORT_TEMPLATE_EMPTY' });
      }

      const fs = parseFilterSchemaJson(row.filter_schema_json || '[]');
      if (!fs.ok) {
        return reply.code(503).send({ error: fs.error, code: 'REPORT_SCHEMA_INVALID' });
      }

      const templateKind = detectTemplateKind(template);
      if (!templateKind) {
        return reply.code(503).send({ error: 'SQL 模板无效', code: 'REPORT_TEMPLATE_INVALID' });
      }

      try {
        const result = await executeReportQuery(pool, {
          templateKind,
          sqlTemplate: template,
          schemaFields: fs.fields,
          params,
          page,
          pageSize,
        });
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
        if (code === 'REPORT_PARAM_REQUIRED' || code === 'REPORT_PARAM_INVALID') {
          return reply.code(400).send({ error: err.message, code });
        }
        if (code === 'REPORT_QUERY_TIMEOUT') {
          return reply.code(504).send({ error: err.message, code });
        }
        request.log.error({ err }, 'reports/run execute');
        // 返回详细错误信息，包括 SQL 错误消息
        const errorDetail = err.message || String(err);
        return reply.code(500).send({
          error: '查询执行失败',
          code: 'REPORT_EXEC_ERROR',
          detail: errorDetail,
        });
      }
    }
  );

  fastify.post(
    '/reports/detail',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {};
      const routeKey = String(body.routeKey || '')
        .trim()
        .toLowerCase();
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      const detailKey = body.detailKey;

      if (!routeKey) {
        return reply.code(400).send({ error: '请提供 routeKey', code: 'REPORT_BAD_REQUEST' });
      }

      const userRole = String(request.user.role || 'operator');
      const pool = await getPool();

      let row;
      try {
        const rs = await pool
          .request()
          .input('rk', sql.NVarChar(64), routeKey)
          .query(`SELECT id, label, route_key, enabled, roles_json, menu_kind, query_template, filter_schema_json,
                  detail_query_template, detail_key_column, detail_key_param, COALESCE(detail_key_type, N'string') AS detail_key_type
                  FROM dbo.nav_menu_items
                  WHERE route_key = @rk`);
        row = rs.recordset && rs.recordset[0];
      } catch (err) {
        request.log.error({ err }, 'reports/detail load menu');
        return reply.code(503).send({
          error: '无法读取菜单配置，请确认已执行数据库迁移',
          code: 'NAV_CONFIG_ERROR',
        });
      }

      if (!row || !row.enabled) {
        return reply.code(404).send({ error: '菜单不存在或未启用', code: 'REPORT_MENU_NOT_FOUND' });
      }

      const roles = parseRolesJson(row.roles_json);
      if (!roles.includes(userRole)) {
        return reply.code(403).send({ error: '无权访问该报表', code: 'REPORT_FORBIDDEN' });
      }

      const menuKind = String(row.menu_kind || 'builtin').toLowerCase();
      if (menuKind !== 'report') {
        return reply
          .code(400)
          .send({ error: '该菜单不是可配置报表', code: 'REPORT_NOT_REPORT_MENU' });
      }

      const detailTpl = normalizeTemplate(row.detail_query_template || '');
      if (!detailTpl) {
        return reply
          .code(503)
          .send({ error: '未配置行详情 SQL', code: 'REPORT_DETAIL_NOT_CONFIGURED' });
      }

      const fs = parseFilterSchemaJson(row.filter_schema_json || '[]');
      if (!fs.ok) {
        return reply.code(503).send({ error: fs.error, code: 'REPORT_SCHEMA_INVALID' });
      }

      const templateKind = detectTemplateKind(detailTpl);
      if (!templateKind) {
        return reply.code(503).send({ error: '行详情 SQL 无效', code: 'REPORT_TEMPLATE_INVALID' });
      }

      const dkp =
        row.detail_key_param != null && String(row.detail_key_param).trim()
          ? String(row.detail_key_param).trim()
          : 'detailKey';
      const dkt = row.detail_key_type != null ? String(row.detail_key_type) : 'string';

      try {
        const result = await executeReportDetailQuery(pool, {
          templateKind,
          sqlTemplate: detailTpl,
          schemaFields: fs.fields,
          params,
          detailKeyParam: dkp,
          detailKeyRaw: detailKey,
          detailKeyType: dkt,
        });
        return {
          routeKey,
          label: row.label,
          columns: result.columns,
          rows: result.rows,
          truncated: result.truncated || false,
          totalRowCount: result.totalRowCount,
        };
      } catch (err) {
        const code = err.code || 'REPORT_EXEC_ERROR';
        if (code === 'REPORT_PARAM_REQUIRED' || code === 'REPORT_PARAM_INVALID') {
          return reply.code(400).send({ error: err.message, code });
        }
        if (code === 'REPORT_DETAIL_KEY_MISSING') {
          return reply.code(400).send({ error: err.message, code });
        }
        if (code === 'REPORT_QUERY_TIMEOUT') {
          return reply.code(504).send({ error: err.message, code });
        }
        request.log.error({ err }, 'reports/detail execute');
        // 返回详细错误信息，包括 SQL 错误消息
        const errorDetail = err.message || String(err);
        return reply.code(500).send({
          error: '查询执行失败',
          code: 'REPORT_EXEC_ERROR',
          detail: errorDetail,
        });
      }
    }
  );
}

module.exports = reportsRoutes;
