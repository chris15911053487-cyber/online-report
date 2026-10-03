/**
 * agents 数据访问：可配置 Agent 中心的注册表增删改查 + 按角色过滤。
 *
 * 设计要点：
 * - 一个 agent = 一个可进入的智能体（销售分析、使用说明助手…）；
 * - agent 本身不带执行能力，能力全部来自 skills_json 关联的 agent_skills，
 *   因此 run_sql 的表白名单、只读约束继续由 skill 承担，安全模型不变；
 * - 门禁与 canUseSkill 一致：管理员始终可用，roles 为空 = 仅管理员。
 */
const { sql } = require('./db');
const { normalizeRoleKeys } = require('./roles');

const AGENT_KEY_RE = /^[a-z][a-z0-9-]{0,63}$/;
const LAYOUT_MODES = new Set(['canvas', 'chat']);
const MAX_SKILLS = 30;
const MAX_QUICK_PROMPTS = 12;

function sqlErrorNumber(err) {
  return err?.number ?? err?.originalError?.info?.number ?? err?.originalError?.number;
}
function isMissingTable(err) {
  return sqlErrorNumber(err) === 208;
}
function isMissingColumn(err) {
  return sqlErrorNumber(err) === 207;
}

function safeParseJson(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** skill 名称数组规范化：小写、去重、限量（校验交给 validate） */
function normalizeSkillNames(input) {
  const arr = Array.isArray(input)
    ? input
    : String(input || '')
        .split(/[\s,;]+/)
        .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const n = String(raw || '').trim().toLowerCase();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
}

/** 快捷提问规范化：仅保留 icon/label/prompt 三个字段，label 与 prompt 必填 */
function normalizeQuickPrompts(input) {
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const label = String(raw.label || '').trim();
    const prompt = String(raw.prompt || '').trim();
    if (!label || !prompt) continue;
    out.push({
      icon: String(raw.icon || '').trim().slice(0, 8),
      label: label.slice(0, 64),
      prompt: prompt.slice(0, 2000),
    });
    if (out.length >= MAX_QUICK_PROMPTS) break;
  }
  return out;
}

function rowToAgent(row) {
  return {
    id: Number(row.id),
    agentKey: String(row.agent_key),
    label: String(row.label || ''),
    subtitle: String(row.subtitle || ''),
    description: String(row.description || ''),
    icon: String(row.icon || ''),
    themeColor: String(row.theme_color || ''),
    welcomeMd: String(row.welcome_md || ''),
    layoutMode: LAYOUT_MODES.has(String(row.layout_mode)) ? String(row.layout_mode) : 'canvas',
    skills: normalizeSkillNames(safeParseJson(row.skills_json, [])),
    quickPrompts: normalizeQuickPrompts(safeParseJson(row.quick_prompts_json, [])),
    defaultPrompt: String(row.default_prompt || ''),
    defaultEnabled: !!row.default_enabled,
    defaultCacheSecs: Number(row.default_cache_secs) || 0,
    systemPromptExtra: String(row.system_prompt_extra || ''),
    roles: normalizeRoleKeys(safeParseJson(row.roles_json, [])),
    enabled: !!row.enabled,
    sortOrder: Number(row.sort_order) || 100,
    // 关联的 BI 看板（一个 Agent 最多一个）；空 = 不关联
    dashboardKey: String(row.dashboard_key || '').trim().toLowerCase(),
  };
}

const AGENT_COLS_V1 = `id, agent_key, label, subtitle, description, icon, theme_color,
  welcome_md, layout_mode, skills_json, quick_prompts_json,
  default_prompt, default_enabled, default_cache_secs, system_prompt_extra,
  roles_json, enabled, sort_order`;
// V2 含 dashboard_key（migrate-bi.sql）；尚未迁移的库缺列报 207 时回退 V1，避免 Agent 页整体不可用
const AGENT_COLS = `${AGENT_COLS_V1}, dashboard_key`;
let hasDashboardColumn = true;

async function selectAgents(pool, whereSql, bind) {
  const run = (cols) => {
    const req = pool.request();
    if (bind) bind(req);
    return req.query(`SELECT ${cols} FROM dbo.agents ${whereSql}`);
  };
  if (hasDashboardColumn) {
    try {
      return await run(AGENT_COLS);
    } catch (err) {
      if (!isMissingColumn(err)) throw err;
      hasDashboardColumn = false;
    }
  }
  return run(AGENT_COLS_V1);
}

/** 列出全部 agent（管理后台用）。表不存在时返回空数组，避免未跑迁移导致 500。 */
async function listAllAgents(pool) {
  try {
    const rs = await selectAgents(pool, 'ORDER BY sort_order ASC, agent_key ASC');
    return (rs.recordset || []).map(rowToAgent);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/**
 * agent 门禁：管理员始终可用；roles 为空 = 仅管理员。
 * 与 agent-skills.js 的 canUseSkill 保持一致（不同于 canAccessMenu）。
 */
function canUseAgent(userRoles, agentRoles) {
  const u = normalizeRoleKeys(userRoles);
  if (u.includes('admin')) return true;
  const a = normalizeRoleKeys(agentRoles);
  return a.some((r) => u.includes(r));
}

/** 列出某用户可见且启用的 agent（Agent 列表页用） */
async function listAgentsForRoles(pool, userRoles) {
  const all = await listAllAgents(pool);
  return all.filter((a) => a.enabled && canUseAgent(userRoles, a.roles));
}

async function getAgent(pool, agentKey) {
  const k = String(agentKey || '').toLowerCase();
  try {
    const rs = await selectAgents(pool, 'WHERE agent_key = @k', (req) => req.input('k', sql.NVarChar(64), k));
    const row = rs.recordset && rs.recordset[0];
    return row ? rowToAgent(row) : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/** 校验输入。返回 { ok, error?, value? } */
function validateAgentInput(input) {
  const agentKey = String(input?.agentKey || '').trim().toLowerCase();
  if (!AGENT_KEY_RE.test(agentKey)) {
    return { ok: false, error: 'agentKey 须为小写字母开头、仅含小写字母/数字/连字符、≤64 字符' };
  }
  const label = String(input?.label || '').trim();
  if (!label) return { ok: false, error: '显示名称不能为空' };
  if (label.length > 128) return { ok: false, error: '显示名称不能超过 128 字符' };

  const subtitle = String(input?.subtitle || '').trim();
  if (subtitle.length > 256) return { ok: false, error: '副标题不能超过 256 字符' };
  const description = String(input?.description || '').trim();
  if (description.length > 1024) return { ok: false, error: '描述不能超过 1024 字符' };

  const layoutMode = String(input?.layoutMode || 'canvas').trim().toLowerCase();
  if (!LAYOUT_MODES.has(layoutMode)) {
    return { ok: false, error: 'layoutMode 只能是 canvas 或 chat' };
  }

  const skills = normalizeSkillNames(input?.skills);
  for (const n of skills) {
    if (!AGENT_KEY_RE.test(n)) {
      return { ok: false, error: `关联 skill 名称非法：「${n}」` };
    }
  }

  const defaultEnabled = !!input?.defaultEnabled;
  const defaultPrompt = String(input?.defaultPrompt || '').trim();
  if (defaultEnabled && !defaultPrompt) {
    return { ok: false, error: '启用默认内容时，默认分析指令不能为空' };
  }

  const rawCache = Number(input?.defaultCacheSecs);
  const defaultCacheSecs = Number.isFinite(rawCache)
    ? Math.max(0, Math.min(86400, Math.floor(rawCache)))
    : 300;

  const sortOrder = Number.isFinite(Number(input?.sortOrder)) ? Number(input.sortOrder) : 100;

  const dashboardKey = String(input?.dashboardKey || '').trim().toLowerCase();
  if (dashboardKey && !/^[a-z][a-z0-9_-]{0,63}$/.test(dashboardKey)) {
    return { ok: false, error: '关联看板标识非法' };
  }

  return {
    ok: true,
    value: {
      agentKey,
      label,
      subtitle,
      description,
      icon: String(input?.icon || '').trim().slice(0, 64),
      themeColor: String(input?.themeColor || '').trim().slice(0, 32),
      welcomeMd: String(input?.welcomeMd || '').trim(),
      layoutMode,
      skills,
      quickPrompts: normalizeQuickPrompts(input?.quickPrompts),
      defaultPrompt,
      defaultEnabled,
      defaultCacheSecs,
      systemPromptExtra: String(input?.systemPromptExtra || '').trim(),
      roles: normalizeRoleKeys(Array.isArray(input?.roles) ? input.roles : []),
      enabled: input?.enabled !== false,
      sortOrder,
      dashboardKey,
    },
  };
}

const { SQL_CHINA_LOCAL_NOW_EXPR } = require('./china-datetime');

/** 新增或更新（按 agent_key 幂等）；dashboard_key 列缺失（未迁移）时自动回退为不写该列 */
async function upsertAgent(pool, value) {
  try {
    await mergeAgent(pool, value, hasDashboardColumn);
  } catch (err) {
    if (!hasDashboardColumn || !isMissingColumn(err)) throw err;
    hasDashboardColumn = false;
    await mergeAgent(pool, value, false);
  }
  return getAgent(pool, value.agentKey);
}

async function mergeAgent(pool, value, withDashboard) {
  await pool
    .request()
    .input('agent_key', sql.NVarChar(64), value.agentKey)
    .input('label', sql.NVarChar(128), value.label)
    .input('subtitle', sql.NVarChar(256), value.subtitle)
    .input('description', sql.NVarChar(1024), value.description)
    .input('icon', sql.NVarChar(64), value.icon)
    .input('theme_color', sql.NVarChar(32), value.themeColor)
    .input('welcome_md', sql.NVarChar(sql.MAX), value.welcomeMd)
    .input('layout_mode', sql.VarChar(16), value.layoutMode)
    .input('skills_json', sql.NVarChar(sql.MAX), JSON.stringify(value.skills))
    .input('quick_prompts_json', sql.NVarChar(sql.MAX), JSON.stringify(value.quickPrompts))
    .input('default_prompt', sql.NVarChar(sql.MAX), value.defaultPrompt)
    .input('default_enabled', sql.Bit, value.defaultEnabled)
    .input('default_cache_secs', sql.Int, value.defaultCacheSecs)
    .input('system_prompt_extra', sql.NVarChar(sql.MAX), value.systemPromptExtra)
    .input('roles_json', sql.NVarChar(sql.MAX), JSON.stringify(value.roles))
    .input('enabled', sql.Bit, value.enabled)
    .input('sort_order', sql.Int, value.sortOrder)
    .input('dashboard_key', sql.NVarChar(64), value.dashboardKey || null)
    .query(`
      MERGE dbo.agents AS t
      USING (SELECT @agent_key AS agent_key) AS s ON t.agent_key = s.agent_key
      WHEN MATCHED THEN UPDATE SET
        label = @label, subtitle = @subtitle, description = @description,
        icon = @icon, theme_color = @theme_color, welcome_md = @welcome_md,
        layout_mode = @layout_mode, skills_json = @skills_json,
        quick_prompts_json = @quick_prompts_json, default_prompt = @default_prompt,
        default_enabled = @default_enabled, default_cache_secs = @default_cache_secs,
        system_prompt_extra = @system_prompt_extra, roles_json = @roles_json,
        enabled = @enabled, sort_order = @sort_order,${withDashboard ? ' dashboard_key = @dashboard_key,' : ''}
        updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}
      WHEN NOT MATCHED THEN
        INSERT (agent_key, label, subtitle, description, icon, theme_color,
                welcome_md, layout_mode, skills_json, quick_prompts_json,
                default_prompt, default_enabled, default_cache_secs,
                system_prompt_extra, roles_json, enabled, sort_order${withDashboard ? ', dashboard_key' : ''})
        VALUES (@agent_key, @label, @subtitle, @description, @icon, @theme_color,
                @welcome_md, @layout_mode, @skills_json, @quick_prompts_json,
                @default_prompt, @default_enabled, @default_cache_secs,
                @system_prompt_extra, @roles_json, @enabled, @sort_order${withDashboard ? ', @dashboard_key' : ''});
    `);
}

async function deleteAgent(pool, agentKey) {
  const rs = await pool
    .request()
    .input('k', sql.NVarChar(64), String(agentKey || '').toLowerCase())
    .query(`DELETE FROM dbo.agents WHERE agent_key = @k`);
  return rs.rowsAffected && rs.rowsAffected[0] > 0;
}

module.exports = {
  AGENT_KEY_RE,
  LAYOUT_MODES,
  canUseAgent,
  listAllAgents,
  listAgentsForRoles,
  getAgent,
  validateAgentInput,
  upsertAgent,
  deleteAgent,
  normalizeSkillNames,
  normalizeQuickPrompts,
};
