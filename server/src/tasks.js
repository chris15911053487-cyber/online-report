/**
 * 待办：规则（alert_rules.output_mode = 'task'）按数据生成，每条归一个负责人，有状态流转。
 *
 * 流程：
 *   1. 生成 / 同步：规则 SQL（或命名查询 + 条件）每行 = 一条待办；「规则 + 单据键」去重，
 *      已有的更新，新出现的新建，全量同步时数据里查不到的自动关闭（事件触发只增改、不关闭）。
 *   2. 认人：负责人列的值按 OUSR.USER_CODE 识别；识别不了 → 未分配，由主管（规则的推送对象）转交。
 *   3. 状态：open 待处理 → done 已处理（以数据为准：第二天还查得到就重新打开）/ snoozed 延后到某天 /
 *      closed 数据里查不到了。转交后负责人锁定，不再随数据变。
 *   4. 推送（runTaskDigest）：早上每人一条汇总（总数、超期数、最紧急 5 条）+ 主管团队汇总（各人待办、未分配、
 *      超期升级，周一附上周完成率）；下午复查，还有今天到期 / 超期没处理的再提醒一次。都走 notify()。
 *
 * 纯函数（planSync / buildOwnerDigest 等）不碰数据库，有单测；SQL 读写在下半部分。
 */
const { getPool, sql } = require('./db');
const { formatInstantChinaLocal, SQL_CHINA_LOCAL_NOW_EXPR } = require('./china-datetime');
const { renderTemplate } = require('./alert-dingtalk');
const { notify, resolveRecipientCodes, normalizeRecipients } = require('./notify');
const { getUserRolesFromRequest } = require('./roles');

const pino = require('pino');
const log = pino({ name: 'tasks' });

/** 一次同步最多处理的行数；超出时只增改、不关闭（避免把没取到的当成已解决） */
const MAX_TASK_ROWS = 2000;
const DIGEST_TOP = 5;
const ACTIVE_STATUSES = ['open', 'snoozed', 'done'];
const STATUS_LABELS = { open: '待处理', snoozed: '已延后', done: '已处理', closed: '已关闭' };

// ==================== 日期（中国墙钟，'YYYY-MM-DD'） ====================

function chinaToday(now = new Date()) {
  return formatInstantChinaLocal(now).slice(0, 10);
}

/**
 * 任意值 → 'YYYY-MM-DD' 或 null。
 * mssql 默认 useUTC：库里的墙钟时间读出来是「同数字的 UTC」Date，取 ISO 前 10 位即墙钟日期。
 */
function dateOnly(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(v).trim());
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** b - a 的天数 */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** 超期天数：没到期或没有到期日为 0 */
function overdueDays(dueDate, today) {
  if (!dueDate) return 0;
  return Math.max(0, daysBetween(dueDate, today));
}

/** 到期提示：超期 3 天 / 今天到期 / 明天到期 / 10-25 到期 */
function dueLabel(dueDate, today) {
  if (!dueDate) return '';
  const diff = daysBetween(today, dueDate);
  if (diff < 0) return `超期 ${-diff} 天`;
  if (diff === 0) return '今天到期';
  if (diff === 1) return '明天到期';
  return `${dueDate.slice(5)} 到期`;
}

// ==================== 规则行 → 待办 ====================

function isTaskRule(rule) {
  return String(rule?.output_mode || '') === 'task';
}

function jsonSafe(v) {
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
  if (typeof v === 'bigint') return Number(v);
  return v;
}

function keyOf(row, col) {
  const v = row?.[col];
  if (v == null) return '';
  return String(jsonSafe(v)).trim().slice(0, 512);
}

/** 没写正文模板时：前 6 列做成列表 */
function autoBody(row) {
  return Object.keys(row)
    .slice(0, 6)
    .map((k) => `- **${k}**：${row[k] == null ? '' : jsonSafe(row[k])}`)
    .join('\n');
}

/**
 * 一行数据 → 待办内容。
 * @returns {{ itemKey, title, body, linkUrl, ownerRaw, dueDate, dueFromColumn, data }}
 */
function taskFromRow(rule, row, today) {
  const itemKey = keyOf(row, rule.key_column);
  const title = (renderTemplate(rule.card_title_template, row) || '').trim() || `${rule.name}：${itemKey}`;
  const body = rule.card_body_template ? renderTemplate(rule.card_body_template, row) : autoBody(row);
  const linkUrl = rule.card_btn_url ? renderTemplate(rule.card_btn_url, row).trim() : '';
  const ownerRaw = rule.owner_column ? keyOf(row, rule.owner_column).slice(0, 64) : '';
  const fromColumn = rule.due_column ? dateOnly(row[rule.due_column]) : null;
  const data = {};
  for (const [k, v] of Object.entries(row)) data[k] = jsonSafe(v);
  return {
    itemKey,
    title: title.slice(0, 256),
    body,
    linkUrl: linkUrl.slice(0, 512) || null,
    ownerRaw,
    dueDate: fromColumn || addDays(today, Math.max(0, Number(rule.due_days) || 0)),
    dueFromColumn: !!fromColumn,
    data: JSON.stringify(data).slice(0, 8000),
  };
}

/**
 * 同步计划（纯函数）：现有待办 + 本次数据 → 操作列表。
 *
 * @param {Array<{ id, itemKey, status, doneDate, ownerCode, ownerLocked }>} existing 该规则已有的待办
 * @param {Array<ReturnType<typeof taskFromRow> & { ownerCode: string|null }>} items 本次数据（ownerCode 已按 OUSR 识别）
 * @param {{ today: string, full: boolean }} opts full = 全量同步（数据里查不到的关闭）
 * @returns {{ creates: object[], updates: object[], closes: number[] }}
 *   updates: { id, item, setOwner, setDue, status?, event? }；event = { action, detail }
 */
function planSync(existing, items, { today, full }) {
  const byKey = new Map(existing.map((t) => [t.itemKey, t]));
  const seen = new Set();
  const creates = [];
  const updates = [];

  for (const item of items) {
    if (!item.itemKey || seen.has(item.itemKey)) continue;
    seen.add(item.itemKey);
    const t = byKey.get(item.itemKey);
    if (!t) {
      creates.push(item);
      continue;
    }
    const u = { id: t.id, item, setOwner: !t.ownerLocked, setDue: item.dueFromColumn, events: [] };
    if (t.status === 'closed') {
      // 关闭后又出现 = 新的一次，到期日重新算（否则一出现就超期、马上升级）
      u.setDue = true;
      u.status = 'open';
      u.events.push({ action: 'reopen', detail: '数据里又出现了' });
    } else if (t.status === 'done' && t.doneDate && t.doneDate < today) {
      u.status = 'open';
      u.events.push({ action: 'reopen', detail: '标记已处理后，数据里仍然存在' });
    }
    if (u.setOwner && (item.ownerCode || null) !== (t.ownerCode || null)) {
      u.events.push({ action: 'transfer', detail: `数据里的负责人变为 ${item.ownerCode || '（未分配）'}` });
    }
    // 内容、负责人、到期日都没变：只记「还在」（批量更新 last_seen_at），不逐条 UPDATE
    u.unchanged =
      !u.status &&
      u.events.length === 0 &&
      t.title === item.title &&
      (t.body ?? null) === (item.body ?? null) &&
      (t.linkUrl ?? null) === (item.linkUrl ?? null) &&
      (t.data ?? null) === (item.data ?? null) &&
      (!u.setDue || t.dueDate === item.dueDate);
    updates.push(u);
  }

  const closes = full
    ? existing.filter((t) => !seen.has(t.itemKey) && ACTIVE_STATUSES.includes(t.status)).map((t) => t.id)
    : [];
  return { creates, updates, closes };
}

/** 状态（含「延后到期即视为待处理」） */
function effectiveStatus(t, today) {
  if (t.status === 'snoozed' && t.snoozeUntil && t.snoozeUntil <= today) return 'open';
  return t.status;
}

/** 紧急程度排序：超期久的在前 → 今天到期 → 到期日早的 → 没有到期日 */
function byUrgency(a, b) {
  const da = a.dueDate || '9999-12-31';
  const db = b.dueDate || '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  return a.id - b.id;
}

// ==================== 推送内容（纯函数） ====================

function taskLine(t, today) {
  const due = dueLabel(t.dueDate, today);
  const tag = overdueDays(t.dueDate, today) > 0 ? `**【${due}】**` : due ? `【${due}】` : '';
  return `- ${tag}${t.title}`;
}

/**
 * 负责人的早上汇总 / 下午提醒；没有要推的返回 null。
 * @param {object[]} tasks 该负责人的待处理待办（{ id, title, dueDate }）
 * @param {'morning'|'afternoon'} kind 下午只提醒今天到期和超期的
 */
function buildOwnerDigest(tasks, today, { kind = 'morning', top = DIGEST_TOP } = {}) {
  const list = kind === 'afternoon' ? tasks.filter((t) => t.dueDate && t.dueDate <= today) : tasks;
  if (list.length === 0) return null;
  const sorted = [...list].sort(byUrgency);
  const overdue = sorted.filter((t) => overdueDays(t.dueDate, today) > 0).length;
  const title =
    kind === 'afternoon'
      ? `下午提醒：还有 ${list.length} 条待办今天要处理${overdue ? `（超期 ${overdue}）` : ''}`
      : `今日待办 ${list.length} 条${overdue ? `（超期 ${overdue}）` : ''}`;
  const lines = sorted.slice(0, top).map((t) => taskLine(t, today));
  if (sorted.length > top) lines.push(`- …还有 ${sorted.length - top} 条`);
  return { title, body: lines.join('\n') };
}

/**
 * 主管的团队汇总；没有内容返回 null。
 * @param {object[]} tasks 主管负责的规则下所有待处理待办（{ id, title, dueDate, ownerCode, ruleName }）
 * @param {object[]} escalations 本次升级的（超期达到规则设定天数）
 * @param {object[]|null} weekStats 周一附上周统计：[{ ownerCode, created, completed, overdue }]
 */
function buildTeamDigest(tasks, today, { escalations = [], weekStats = null, top = DIGEST_TOP } = {}) {
  if (tasks.length === 0 && escalations.length === 0 && !(weekStats && weekStats.length)) return null;
  const overdue = tasks.filter((t) => overdueDays(t.dueDate, today) > 0).length;
  const unassigned = tasks.filter((t) => !t.ownerCode).sort(byUrgency);
  const byOwner = new Map();
  for (const t of tasks) {
    if (!t.ownerCode) continue;
    const s = byOwner.get(t.ownerCode) || { total: 0, overdue: 0 };
    s.total += 1;
    if (overdueDays(t.dueDate, today) > 0) s.overdue += 1;
    byOwner.set(t.ownerCode, s);
  }
  const parts = [];
  if (byOwner.size > 0) {
    const rows = [...byOwner.entries()].sort((a, b) => b[1].overdue - a[1].overdue || b[1].total - a[1].total);
    parts.push(
      '**各人待办**',
      rows.slice(0, 15).map(([u, s]) => `- ${u}：${s.total} 条${s.overdue ? `，超期 ${s.overdue}` : ''}`).join('\n'),
    );
    if (rows.length > 15) parts.push(`- …还有 ${rows.length - 15} 人`);
  }
  if (escalations.length > 0) {
    const list = [...escalations].sort(byUrgency);
    parts.push(
      `**超期升级（${escalations.length}）**`,
      list.slice(0, top).map((t) => `${taskLine(t, today)}（${t.ownerCode || '未分配'}）`).join('\n'),
    );
    if (list.length > top) parts.push(`- …还有 ${list.length - top} 条`);
  }
  if (unassigned.length > 0) {
    parts.push(
      `**未分配负责人（${unassigned.length}）**，请在「消息 → 待办 → 团队」转交`,
      unassigned.slice(0, top).map((t) => taskLine(t, today)).join('\n'),
    );
    if (unassigned.length > top) parts.push(`- …还有 ${unassigned.length - top} 条`);
  }
  if (weekStats && weekStats.length > 0) {
    parts.push(
      '**上周完成情况**',
      weekStats
        .slice(0, 15)
        .map((s) => `- ${s.ownerCode || '未分配'}：新增 ${s.created}，完成 ${s.completed}（${pct(s.completed, s.created)}），超期 ${s.overdue}`)
        .join('\n'),
    );
  }
  const title = `团队待办 ${tasks.length} 条${overdue ? `（超期 ${overdue}）` : ''}${escalations.length ? `，升级 ${escalations.length}` : ''}`;
  return { title, body: parts.join('\n\n') };
}

function pct(a, b) {
  return b > 0 ? `${Math.round((a / b) * 100)}%` : '-';
}

// ==================== 规则的主管 ====================

function parseJsonArray(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 用户是不是这条规则的主管：指定了用户只看用户，否则看角色（与 resolveRecipientCodes 一致） */
function isSupervisorOf(rule, userCode, roles) {
  const users = normalizeRecipients(parseJsonArray(rule.target_users_json));
  if (users.length > 0) return users.some((u) => u.toLowerCase() === String(userCode || '').toLowerCase());
  const ruleRoles = parseJsonArray(rule.target_roles_json).map((r) => String(r || '').trim()).filter(Boolean);
  return ruleRoles.some((r) => roles.includes(r));
}

// ==================== SQL：同步 ====================

/** IN (...) 参数化，每批 500 个 */
async function inChunks(list, size, fn) {
  for (let i = 0; i < list.length; i += size) await fn(list.slice(i, i + size));
}

/** 负责人列的值 → OUSR.USER_CODE（不区分大小写）；识别不了的不在结果里 */
async function resolveOwnerCodes(pool, raws) {
  const map = new Map();
  const list = [...new Set(raws.filter(Boolean).map((r) => r.toLowerCase()))];
  await inChunks(list, 500, async (batch) => {
    const req = pool.request();
    const ph = batch.map((u, i) => {
      req.input(`u${i}`, sql.NVarChar(64), u);
      return `@u${i}`;
    });
    const rs = await req.query(`SELECT [USER_CODE] AS user_code FROM dbo.OUSR WHERE [USER_CODE] IN (${ph.join(', ')})`);
    for (const r of rs.recordset || []) map.set(String(r.user_code).toLowerCase(), String(r.user_code));
  });
  return map;
}

function mapExisting(r) {
  return {
    id: Number(r.id),
    itemKey: String(r.item_key),
    status: r.status,
    doneDate: dateOnly(r.done_at),
    ownerCode: r.owner_code || null,
    ownerLocked: !!r.owner_locked,
    title: r.title,
    body: r.body ?? null,
    linkUrl: r.link_url ?? null,
    data: r.data_json ?? null,
    dueDate: dateOnly(r.due_date),
  };
}

const EXISTING_COLUMNS = 'id, item_key, status, done_at, owner_code, owner_locked, title, body, link_url, data_json, due_date';

/** 该规则的现有待办：未关闭的全部 + 已关闭但本次又出现的 */
async function loadExisting(pool, ruleId, keys) {
  const rs = await pool
    .request()
    .input('rid', sql.Int, ruleId)
    .query(`SELECT ${EXISTING_COLUMNS} FROM dbo.tasks WHERE rule_id = @rid AND status <> 'closed'`);
  const out = (rs.recordset || []).map(mapExisting);
  const have = new Set(out.map((t) => t.itemKey));
  const missing = keys.filter((k) => !have.has(k));
  await inChunks(missing, 500, async (batch) => {
    const req = pool.request().input('rid', sql.Int, ruleId);
    const ph = batch.map((k, i) => {
      req.input(`k${i}`, sql.NVarChar(512), k);
      return `@k${i}`;
    });
    const r2 = await req.query(
      `SELECT ${EXISTING_COLUMNS} FROM dbo.tasks
       WHERE rule_id = @rid AND status = 'closed' AND item_key IN (${ph.join(', ')})`,
    );
    out.push(...(r2.recordset || []).map(mapExisting));
  });
  return out;
}

/**
 * 按规则查到的数据同步待办。
 * @param {object} rule alert_rules 行（output_mode = 'task'）
 * @param {object[]} rows 规则查到的数据行
 * @param {{ full?: boolean, today?: string }} opts
 * @returns {Promise<{ created: number, updated: number, reopened: number, closed: number, unassigned: number, truncated: boolean, newTasks: object[] }>}
 */
/** 同一规则的同步排队执行（定时、事件、汇总前同步可能撞在一起，否则会重复插入同一单据） */
const syncQueues = new Map();

function syncRuleTasks(pool, rule, rows, opts) {
  const id = Number(rule.id);
  const prev = syncQueues.get(id) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => doSyncRuleTasks(pool, rule, rows, opts));
  syncQueues.set(id, run);
  const cleanup = () => {
    if (syncQueues.get(id) === run) syncQueues.delete(id);
  };
  run.then(cleanup, cleanup);
  return run;
}

async function doSyncRuleTasks(pool, rule, rows, { full = true, today = chinaToday() } = {}) {
  const truncated = rows.length > MAX_TASK_ROWS;
  const items = rows.slice(0, MAX_TASK_ROWS).map((r) => taskFromRow(rule, r, today)).filter((t) => t.itemKey);
  const owners = await resolveOwnerCodes(pool, items.map((t) => t.ownerRaw));
  for (const t of items) t.ownerCode = t.ownerRaw ? owners.get(t.ownerRaw.toLowerCase()) || null : null;

  const existing = await loadExisting(pool, rule.id, items.map((t) => t.itemKey));
  const plan = planSync(existing, items, { today, full: full && !truncated });
  const result = { created: 0, updated: 0, reopened: 0, closed: 0, unassigned: 0, truncated, newTasks: [] };

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    for (const item of plan.creates) {
      const rs = await new sql.Request(tx)
        .input('rid', sql.Int, rule.id)
        .input('k', sql.NVarChar(512), item.itemKey)
        .input('t', sql.NVarChar(256), item.title)
        .input('b', sql.NVarChar(sql.MAX), item.body)
        .input('l', sql.NVarChar(512), item.linkUrl)
        .input('d', sql.NVarChar(sql.MAX), item.data)
        .input('o', sql.NVarChar(64), item.ownerCode)
        .input('due', sql.Date, item.dueDate)
        .input('evDetail', sql.NVarChar(500), item.ownerCode ? null : `负责人「${item.ownerRaw || '空'}」不是系统用户，待主管分派`)
        .query(
          `INSERT INTO dbo.tasks (source_type, rule_id, item_key, title, body, link_url, data_json, owner_code, due_date)
           VALUES ('rule', @rid, @k, @t, @b, @l, @d, @o, @due);
           DECLARE @id INT = CAST(SCOPE_IDENTITY() AS INT);
           INSERT INTO dbo.task_events (task_id, action, detail) VALUES (@id, 'create', @evDetail);
           SELECT @id AS id`,
        );
      result.created += 1;
      if (!item.ownerCode) result.unassigned += 1;
      result.newTasks.push({ id: rs.recordset[0].id, title: item.title, dueDate: item.dueDate, ownerCode: item.ownerCode });
    }

    const unchanged = plan.updates.filter((u) => u.unchanged).map((u) => u.id);
    await inChunks(unchanged, 500, async (batch) => {
      const req = new sql.Request(tx);
      await req.query(`UPDATE dbo.tasks SET last_seen_at = ${SQL_CHINA_LOCAL_NOW_EXPR} WHERE id IN (${idList(req, batch, 'i')})`);
    });
    result.updated += unchanged.length;

    for (const u of plan.updates.filter((x) => !x.unchanged)) {
      const req = new sql.Request(tx)
        .input('id', sql.Int, u.id)
        .input('t', sql.NVarChar(256), u.item.title)
        .input('b', sql.NVarChar(sql.MAX), u.item.body)
        .input('l', sql.NVarChar(512), u.item.linkUrl)
        .input('d', sql.NVarChar(sql.MAX), u.item.data);
      const sets = ['title = @t', 'body = @b', 'link_url = @l', 'data_json = @d', `last_seen_at = ${SQL_CHINA_LOCAL_NOW_EXPR}`, `updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}`];
      if (u.setOwner) {
        req.input('o', sql.NVarChar(64), u.item.ownerCode);
        sets.push('owner_code = @o');
      }
      if (u.setDue) {
        req.input('due', sql.Date, u.item.dueDate);
        sets.push('due_date = @due');
      }
      if (u.status === 'open') {
        sets.push("status = 'open'", 'done_at = NULL', 'done_by = NULL', 'closed_at = NULL', 'escalated_at = NULL', 'reopen_count = reopen_count + 1');
        result.reopened += 1;
      }
      const evSql = u.events
        .map((e, i) => {
          req.input(`ea${i}`, sql.VarChar(16), e.action).input(`ed${i}`, sql.NVarChar(500), e.detail);
          return `INSERT INTO dbo.task_events (task_id, action, detail) VALUES (@id, @ea${i}, @ed${i});`;
        })
        .join('\n');
      await req.query(`UPDATE dbo.tasks SET ${sets.join(', ')} WHERE id = @id;\n${evSql}`);
      result.updated += 1;
      if (u.setOwner && !u.item.ownerCode) result.unassigned += 1;
    }

    await inChunks(plan.closes, 500, async (batch) => {
      const req = new sql.Request(tx);
      const ph = batch.map((id, i) => {
        req.input(`i${i}`, sql.Int, id);
        return `@i${i}`;
      });
      const ids = ph.join(', ');
      await req.query(
        `UPDATE dbo.tasks SET status = 'closed', closed_at = ${SQL_CHINA_LOCAL_NOW_EXPR}, updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR} WHERE id IN (${ids});
         INSERT INTO dbo.task_events (task_id, action, detail) SELECT id, 'close', N'数据里已查不到，自动关闭' FROM dbo.tasks WHERE id IN (${ids});`,
      );
      result.closed += batch.length;
    });
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
  return result;
}

/** 同步结果一句话（日志 / 管理页提示） */
function describeSync(r) {
  const parts = [`新增 ${r.created}`, `更新 ${r.updated}`];
  if (r.reopened) parts.push(`重新打开 ${r.reopened}`);
  parts.push(`关闭 ${r.closed}`);
  if (r.unassigned) parts.push(`未分配负责人 ${r.unassigned}`);
  if (r.truncated) parts.push(`超过 ${MAX_TASK_ROWS} 行，只处理前 ${MAX_TASK_ROWS} 行且未关闭`);
  return `待办：${parts.join('，')}`;
}

/**
 * 事件触发的待办规则：同步后立刻告诉新待办的负责人（未分配的告诉主管）。
 */
async function notifyNewTasks(pool, rule, newTasks) {
  if (newTasks.length === 0) return { recipients: 0, imSent: 0, errors: [] };
  const today = chinaToday();
  const byOwner = new Map();
  const unassigned = [];
  for (const t of newTasks) {
    if (!t.ownerCode) unassigned.push(t);
    else byOwner.set(t.ownerCode, [...(byOwner.get(t.ownerCode) || []), t]);
  }
  const out = { recipients: 0, imSent: 0, errors: [] };
  const send = async (recipients, list, prefix) => {
    const r = await notify({
      sourceType: 'task',
      sourceId: rule.id,
      sourceName: rule.name,
      title: `${prefix}${list.length === 1 ? list[0].title : `${rule.name} ${list.length} 条`}`,
      body: list.slice(0, 10).map((t) => taskLine(t, today)).join('\n'),
      linkTitle: '查看待办',
      linkUrl: tasksUrl(list.length === 1 ? list[0].id : null),
      recipients,
      channels: ['dingtalk'],
    });
    out.recipients += r.recipients;
    out.imSent += r.imSent;
    out.errors.push(...r.errors);
  };
  for (const [owner, list] of byOwner) await send([owner], list, '新待办：');
  if (unassigned.length > 0) {
    const sups = await resolveRecipientCodes(pool, parseJsonArray(rule.target_users_json), parseJsonArray(rule.target_roles_json));
    if (sups.length > 0) await send(sups, unassigned, '待分派：');
  }
  return out;
}

function tasksUrl(id) {
  const base = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return id ? `${base}/tasks/${id}` : `${base}/tasks`;
}

// ==================== SQL：每日汇总 / 复查 ====================

/** 延后到期的恢复为待处理 */
async function wakeSnoozed(pool, today) {
  await pool
    .request()
    .input('today', sql.Date, today)
    .query(
      `INSERT INTO dbo.task_events (task_id, action, detail)
       SELECT id, 'wake', N'延后到期，恢复待处理' FROM dbo.tasks WHERE status = 'snoozed' AND snooze_until <= @today;
       UPDATE dbo.tasks SET status = 'open', snooze_until = NULL, updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}
       WHERE status = 'snoozed' AND snooze_until <= @today;`,
    );
}

function mapTaskRow(r) {
  return {
    id: Number(r.id),
    ruleId: r.rule_id == null ? null : Number(r.rule_id),
    ruleName: r.rule_name || '',
    sourceType: r.source_type,
    itemKey: r.item_key || '',
    title: r.title,
    body: r.body || '',
    linkUrl: r.link_url || '',
    ownerCode: r.owner_code || null,
    ownerLocked: !!r.owner_locked,
    status: r.status,
    dueDate: dateOnly(r.due_date),
    snoozeUntil: dateOnly(r.snooze_until),
    note: r.note || '',
    reopenCount: Number(r.reopen_count) || 0,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    doneAt: r.done_at,
    doneBy: r.done_by || null,
    closedAt: r.closed_at,
    escalatedAt: r.escalated_at,
  };
}

const TASK_COLUMNS = `t.id, t.rule_id, r.name AS rule_name, t.source_type, t.item_key, t.title, t.body, t.link_url,
  t.owner_code, t.owner_locked, t.status, t.due_date, t.snooze_until, t.note, t.reopen_count,
  t.first_seen_at, t.last_seen_at, t.done_at, t.done_by, t.closed_at, t.escalated_at`;

/** 上周（上周一 ~ 上周日）新增的待办按负责人统计 */
async function weekStatsByOwner(pool, ruleIds, today) {
  if (ruleIds.length === 0) return [];
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // 周一 = 0
  const from = addDays(today, -dow - 7);
  const to = addDays(today, -dow);
  const rows = await statsQuery(pool, { from, to, ruleIds, groupBy: 'owner' });
  return rows.map((r) => ({ ownerCode: r.key, created: r.created, completed: r.completed, overdue: r.overdue }));
}

/**
 * 每日汇总 / 下午复查。
 * @param {{ kind?: 'morning'|'afternoon', syncRules?: (rule) => Promise<unknown>, now?: Date }} opts
 *   syncRules：推送前先全量同步定时待办规则（由 alert-engine 传入，避免循环依赖）
 */
async function runTaskDigest({ kind = 'morning', syncRules = null, now = new Date() } = {}) {
  const pool = await getPool();
  const today = chinaToday(now);
  const rulesRs = await pool.request().query(
    `SELECT * FROM dbo.alert_rules WHERE output_mode = 'task' AND enabled = 1 ORDER BY sort_order, id`,
  );
  const rules = rulesRs.recordset || [];
  if (syncRules) {
    for (const rule of rules.filter((r) => r.trigger_type === 'cron')) {
      try {
        await syncRules(rule);
      } catch (err) {
        log.warn({ err: err.message, ruleId: rule.id }, '汇总前同步待办失败');
      }
    }
  }
  await wakeSnoozed(pool, today);

  const ruleIds = rules.map((r) => Number(r.id));
  if (ruleIds.length === 0) return { owners: 0, supervisors: 0, escalated: 0 };
  const req = pool.request();
  const ph = ruleIds.map((id, i) => {
    req.input(`r${i}`, sql.Int, id);
    return `@r${i}`;
  });
  const rs = await req.query(
    `SELECT ${TASK_COLUMNS} FROM dbo.tasks t LEFT JOIN dbo.alert_rules r ON r.id = t.rule_id
     WHERE t.status = 'open' AND t.rule_id IN (${ph.join(', ')})`,
  );
  const open = (rs.recordset || []).map(mapTaskRow);

  // 负责人
  const byOwner = new Map();
  for (const t of open) if (t.ownerCode) byOwner.set(t.ownerCode, [...(byOwner.get(t.ownerCode) || []), t]);
  let owners = 0;
  for (const [owner, list] of byOwner) {
    const d = buildOwnerDigest(list, today, { kind });
    if (!d) continue;
    const r = await notify({ sourceType: 'task', sourceName: '每日待办', ...d, linkTitle: '查看全部待办', linkUrl: tasksUrl(null), recipients: [owner], channels: ['dingtalk'] });
    if (r.errors.length) log.warn({ owner, errors: r.errors }, '待办汇总推送有错误');
    owners += 1;
  }
  if (kind !== 'morning') return { owners, supervisors: 0, escalated: 0 };

  // 主管：按人合并其负责的规则
  const supRules = new Map();
  const rulesWithSup = new Set();
  for (const rule of rules) {
    const sups = await resolveRecipientCodes(pool, parseJsonArray(rule.target_users_json), parseJsonArray(rule.target_roles_json));
    if (sups.length > 0) rulesWithSup.add(Number(rule.id));
    for (const sup of sups) supRules.set(sup, [...(supRules.get(sup) || []), Number(rule.id)]);
  }

  // 超期升级：达到规则设定天数、还没升级过、且规则有主管可告知
  const ruleById = new Map(rules.map((r) => [Number(r.id), r]));
  const escalations = open.filter((t) => {
    const days = ruleById.get(t.ruleId)?.escalate_days;
    const od = overdueDays(t.dueDate, today);
    return days != null && days >= 0 && !t.escalatedAt && rulesWithSup.has(t.ruleId) && od > 0 && od >= days;
  });
  await inChunks(escalations.map((t) => t.id), 500, async (batch) => {
    const r2 = pool.request();
    const ids = idList(r2, batch, 'i');
    await r2.query(
      `UPDATE dbo.tasks SET escalated_at = ${SQL_CHINA_LOCAL_NOW_EXPR} WHERE id IN (${ids});
       INSERT INTO dbo.task_events (task_id, action, detail) SELECT id, 'escalate', N'超期，已告知主管' FROM dbo.tasks WHERE id IN (${ids});`,
    );
  });

  const isMonday = new Date(`${today}T00:00:00Z`).getUTCDay() === 1;
  let supervisors = 0;
  for (const [sup, ids] of supRules) {
    const set = new Set(ids);
    const d = buildTeamDigest(
      open.filter((t) => set.has(t.ruleId)),
      today,
      {
        escalations: escalations.filter((t) => set.has(t.ruleId)),
        weekStats: isMonday ? await weekStatsByOwner(pool, ids, today) : null,
      },
    );
    if (!d) continue;
    const r = await notify({ sourceType: 'task', sourceName: '团队待办', ...d, linkTitle: '查看团队待办', linkUrl: tasksUrl(null), recipients: [sup], channels: ['dingtalk'] });
    if (r.errors.length) log.warn({ sup, errors: r.errors }, '团队待办汇总推送有错误');
    supervisors += 1;
  }
  return { owners, supervisors, escalated: escalations.length };
}

/** 规则停用 / 改回推通知 / 删除时，关闭它生成的未处理待办（处理记录保留） */
async function closeRuleTasks(pool, ruleId, reason) {
  const rs = await pool
    .request()
    .input('rid', sql.Int, ruleId)
    .input('reason', sql.NVarChar(500), reason)
    .query(
      `INSERT INTO dbo.task_events (task_id, action, detail)
         SELECT id, 'close', @reason FROM dbo.tasks WHERE rule_id = @rid AND status IN ('open', 'snoozed');
       UPDATE dbo.tasks SET status = 'closed', closed_at = ${SQL_CHINA_LOCAL_NOW_EXPR}, updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}
         WHERE rule_id = @rid AND status IN ('open', 'snoozed');`,
    );
  return rs.rowsAffected?.[1] || 0;
}

/** 能不能搜用户（转交用）：自己有待办，或是某条待办规则的主管 */
async function canSearchUsers(pool, user) {
  if ((await supervisedRuleIds(pool, user)).length > 0) return true;
  const rs = await pool
    .request()
    .input('uc', sql.NVarChar(64), String(user?.username || '').trim())
    .query(`SELECT TOP (1) 1 AS x FROM dbo.tasks WHERE owner_code = @uc AND status IN ('open', 'snoozed')`);
  return (rs.recordset || []).length > 0;
}

// ==================== 用户读写 ====================

class TaskError extends Error {
  constructor(message, status = 400, code = 'TASK_BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 用户能看团队待办的规则 id；管理员 = 全部待办规则 */
async function supervisedRuleIds(pool, user) {
  const userCode = String(user?.username || '').trim();
  const roles = getUserRolesFromRequest(user);
  const rs = await pool.request().query(
    `SELECT id, target_users_json, target_roles_json FROM dbo.alert_rules WHERE output_mode = 'task'`,
  );
  const admin = roles.includes('admin');
  return (rs.recordset || []).filter((r) => admin || isSupervisorOf(r, userCode, roles)).map((r) => Number(r.id));
}

function idList(req, ids, prefix) {
  return ids.map((id, i) => {
    req.input(`${prefix}${i}`, sql.Int, id);
    return `@${prefix}${i}`;
  }).join(', ');
}

/**
 * 待办列表。
 * @param {{ scope: 'mine'|'team', status: 'open'|'snoozed'|'done' }} q
 *   open = 待处理（含延后已到期）；done = 最近 30 天已处理 / 已关闭
 */
async function listTasks(pool, user, { scope = 'mine', status = 'open' } = {}) {
  const userCode = String(user?.username || '').trim();
  const today = chinaToday();
  const supIds = await supervisedRuleIds(pool, user);
  const req = pool.request().input('uc', sql.NVarChar(64), userCode).input('today', sql.Date, today);
  let where;
  if (scope === 'team') {
    if (supIds.length === 0) return { items: [], canTeam: false, counts: {} };
    where = `t.rule_id IN (${idList(req, supIds, 'r')})`;
  } else {
    where = 't.owner_code = @uc';
  }
  const statusWhere = {
    open: `(t.status = 'open' OR (t.status = 'snoozed' AND t.snooze_until <= @today))`,
    snoozed: `(t.status = 'snoozed' AND t.snooze_until > @today)`,
    done: `(t.status IN ('done', 'closed') AND COALESCE(t.done_at, t.closed_at) >= DATEADD(DAY, -30, @today))`,
  }[status];
  if (!statusWhere) throw new TaskError('status 须为 open / snoozed / done');

  const rs = await req.query(
    `SELECT TOP (500) ${TASK_COLUMNS} FROM dbo.tasks t LEFT JOIN dbo.alert_rules r ON r.id = t.rule_id
     WHERE ${where} AND ${statusWhere}
     ORDER BY ${status === 'done' ? 'COALESCE(t.done_at, t.closed_at) DESC' : 'CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.id'};
     SELECT
       SUM(CASE WHEN t.status = 'open' OR (t.status = 'snoozed' AND t.snooze_until <= @today) THEN 1 ELSE 0 END) AS open_count,
       SUM(CASE WHEN t.status = 'snoozed' AND t.snooze_until > @today THEN 1 ELSE 0 END) AS snoozed_count,
       SUM(CASE WHEN (t.status = 'open' OR (t.status = 'snoozed' AND t.snooze_until <= @today)) AND t.due_date < @today THEN 1 ELSE 0 END) AS overdue_count,
       SUM(CASE WHEN (t.status = 'open' OR (t.status = 'snoozed' AND t.snooze_until <= @today)) AND t.owner_code IS NULL THEN 1 ELSE 0 END) AS unassigned_count
     FROM dbo.tasks t WHERE ${where};`,
  );
  const c = rs.recordsets?.[1]?.[0] || {};
  return {
    items: (rs.recordsets?.[0] || []).map((r) => {
      const t = mapTaskRow(r);
      return { ...t, status: effectiveStatus(t, today), body: undefined };
    }),
    canTeam: supIds.length > 0,
    today,
    counts: {
      open: Number(c.open_count) || 0,
      snoozed: Number(c.snoozed_count) || 0,
      overdue: Number(c.overdue_count) || 0,
      unassigned: Number(c.unassigned_count) || 0,
    },
  };
}

/** 我的待处理数（「消息」红点） */
async function countMyOpenTasks(pool, userCode) {
  const rs = await pool
    .request()
    .input('uc', sql.NVarChar(64), userCode)
    .input('today', sql.Date, chinaToday())
    .query(
      `SELECT COUNT(*) AS c FROM dbo.tasks
       WHERE owner_code = @uc AND (status = 'open' OR (status = 'snoozed' AND snooze_until <= @today))`,
    );
  return Number(rs.recordset?.[0]?.c) || 0;
}

/** 读一条待办 + 权限：负责人、规则主管、管理员可看可操作 */
async function loadTaskForUser(pool, user, id) {
  const rs = await pool
    .request()
    .input('id', sql.Int, id)
    .query(`SELECT ${TASK_COLUMNS}, t.data_json FROM dbo.tasks t LEFT JOIN dbo.alert_rules r ON r.id = t.rule_id WHERE t.id = @id`);
  const row = rs.recordset?.[0];
  if (!row) throw new TaskError('待办不存在或无权查看', 404, 'TASK_NOT_FOUND');
  const task = mapTaskRow(row);
  const userCode = String(user?.username || '').trim();
  const isOwner = !!task.ownerCode && task.ownerCode.toLowerCase() === userCode.toLowerCase();
  const supIds = isOwner ? [] : await supervisedRuleIds(pool, user);
  if (!isOwner && !supIds.includes(task.ruleId)) throw new TaskError('待办不存在或无权查看', 404, 'TASK_NOT_FOUND');
  let data = {};
  try {
    data = JSON.parse(row.data_json || '{}');
  } catch {
    data = {};
  }
  return { task: { ...task, status: effectiveStatus(task, chinaToday()), data }, isOwner };
}

async function getTask(pool, user, id) {
  const { task } = await loadTaskForUser(pool, user, id);
  const rs = await pool
    .request()
    .input('id', sql.Int, id)
    .query('SELECT TOP (100) id, action, user_code, detail, created_at FROM dbo.task_events WHERE task_id = @id ORDER BY id DESC');
  return {
    task,
    events: (rs.recordset || []).map((e) => ({
      id: Number(e.id),
      action: e.action,
      userCode: e.user_code || null,
      detail: e.detail || '',
      createdAt: e.created_at,
    })),
  };
}

/**
 * 处理待办：done 已处理 / snooze 延后 / transfer 转交 / note 备注 / reopen 重新打开。
 * @param {{ note?: string, until?: string, to?: string }} payload
 */
async function actOnTask(pool, user, id, action, payload = {}) {
  const { task } = await loadTaskForUser(pool, user, id);
  const userCode = String(user?.username || '').trim();
  const today = chinaToday();
  const note = String(payload.note ?? '').trim().slice(0, 1000);
  const req = pool.request().input('id', sql.Int, id).input('uc', sql.NVarChar(64), userCode);
  let sets = [];
  let detail = note;
  let afterUpdate = null;

  switch (action) {
    case 'done':
      if (task.status === 'done' || task.status === 'closed') throw new TaskError('这条待办已经处理过了');
      sets = ["status = 'done'", `done_at = ${SQL_CHINA_LOCAL_NOW_EXPR}`, 'done_by = @uc', 'snooze_until = NULL'];
      break;
    case 'snooze': {
      const until = dateOnly(payload.until);
      if (!until || until <= today) throw new TaskError('延后日期须晚于今天');
      if (daysBetween(today, until) > 90) throw new TaskError('最多延后 90 天');
      if (task.status === 'done' || task.status === 'closed') throw new TaskError('已处理的待办不能延后');
      req.input('until', sql.Date, until);
      sets = ["status = 'snoozed'", 'snooze_until = @until'];
      detail = `延后到 ${until}${note ? `：${note}` : ''}`;
      break;
    }
    case 'transfer': {
      const to = String(payload.to || '').trim();
      if (!to) throw new TaskError('请选择转交给谁');
      if (task.status === 'done' || task.status === 'closed') throw new TaskError('已处理的待办不能转交');
      const owners = await resolveOwnerCodes(pool, [to]);
      const code = owners.get(to.toLowerCase());
      if (!code) throw new TaskError(`用户不存在：${to}`);
      if (task.ownerCode && code.toLowerCase() === task.ownerCode.toLowerCase()) throw new TaskError('已经是这个负责人');
      req.input('to', sql.NVarChar(64), code);
      sets = ['owner_code = @to', 'owner_locked = 1', 'escalated_at = NULL'];
      detail = `${task.ownerCode || '（未分配）'} → ${code}${note ? `：${note}` : ''}`;
      afterUpdate = () =>
        notify({
          sourceType: 'task',
          sourceId: task.ruleId,
          sourceName: task.ruleName,
          title: `${userCode} 转交给你一条待办：${task.title}`,
          body: [taskLine(task, today), note ? `\n\n> ${note}` : ''].join(''),
          linkTitle: '查看待办',
          linkUrl: tasksUrl(task.id),
          recipients: [code],
          channels: ['dingtalk'],
        }).catch((err) => log.warn({ err: err.message, id }, '转交通知发送失败'));
      break;
    }
    case 'note':
      if (!note) throw new TaskError('请填写备注');
      req.input('note', sql.NVarChar(1000), note);
      sets = ['note = @note'];
      break;
    case 'reopen':
      if (task.status !== 'done') throw new TaskError('只有已处理的待办可以重新打开');
      sets = ["status = 'open'", 'done_at = NULL', 'done_by = NULL'];
      break;
    default:
      throw new TaskError(`未知的操作：${action}`);
  }

  req.input('act', sql.VarChar(16), action).input('detail', sql.NVarChar(500), detail ? detail.slice(0, 500) : null);
  if (action === 'done' && note) {
    req.input('note', sql.NVarChar(1000), note);
    sets.push('note = @note');
  }
  sets.push(`updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR}`);
  await req.query(
    `UPDATE dbo.tasks SET ${sets.join(', ')} WHERE id = @id;
     INSERT INTO dbo.task_events (task_id, action, user_code, detail) VALUES (@id, @act, @uc, @detail);`,
  );
  if (afterUpdate) await afterUpdate();
  return getTask(pool, user, id);
}

// ==================== 统计 ====================

/**
 * 区间 [from, to) 内新增的待办，按负责人或规则统计：新增、完成（已处理或数据已关闭）、超期（完成晚于到期日或至今未完成且已过期）。
 */
async function statsQuery(pool, { from, to, ruleIds = null, groupBy = 'owner' }) {
  const req = pool.request().input('from', sql.Date, from).input('to', sql.Date, to).input('today', sql.Date, chinaToday());
  let where = 't.first_seen_at >= @from AND t.first_seen_at < @to';
  if (ruleIds) {
    if (ruleIds.length === 0) return [];
    where += ` AND t.rule_id IN (${idList(req, ruleIds, 'r')})`;
  }
  const key = groupBy === 'rule' ? 'CAST(t.rule_id AS NVARCHAR(64))' : 't.owner_code';
  const rs = await req.query(
    `SELECT ${key} AS k, MAX(r.name) AS rule_name,
       COUNT(*) AS created,
       SUM(CASE WHEN t.status IN ('done', 'closed') THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN t.due_date IS NOT NULL AND (
             (t.status IN ('done', 'closed') AND CAST(COALESCE(t.done_at, t.closed_at) AS DATE) > t.due_date)
             OR (t.status NOT IN ('done', 'closed') AND t.due_date < @today)) THEN 1 ELSE 0 END) AS overdue,
       SUM(CASE WHEN t.status NOT IN ('done', 'closed') THEN 1 ELSE 0 END) AS still_open
     FROM dbo.tasks t LEFT JOIN dbo.alert_rules r ON r.id = t.rule_id
     WHERE ${where}
     GROUP BY ${key}
     ORDER BY COUNT(*) DESC`,
  );
  return (rs.recordset || []).map((r) => ({
    key: r.k == null ? null : String(r.k),
    ruleName: r.rule_name || '',
    created: Number(r.created) || 0,
    completed: Number(r.completed) || 0,
    overdue: Number(r.overdue) || 0,
    open: Number(r.still_open) || 0,
  }));
}

async function taskStats(pool, { days = 7 } = {}) {
  const n = Math.min(365, Math.max(1, Number(days) || 7));
  const today = chinaToday();
  const range = { from: addDays(today, -(n - 1)), to: addDays(today, 1) };
  const [byOwner, byRule] = await Promise.all([
    statsQuery(pool, { ...range, groupBy: 'owner' }),
    statsQuery(pool, { ...range, groupBy: 'rule' }),
  ]);
  return { from: range.from, to: today, byOwner, byRule };
}

module.exports = {
  // 纯函数
  chinaToday,
  dateOnly,
  addDays,
  daysBetween,
  overdueDays,
  dueLabel,
  isTaskRule,
  taskFromRow,
  planSync,
  effectiveStatus,
  buildOwnerDigest,
  buildTeamDigest,
  isSupervisorOf,
  describeSync,
  STATUS_LABELS,
  MAX_TASK_ROWS,
  // 数据库
  syncRuleTasks,
  notifyNewTasks,
  runTaskDigest,
  listTasks,
  countMyOpenTasks,
  getTask,
  actOnTask,
  taskStats,
  supervisedRuleIds,
  closeRuleTasks,
  canSearchUsers,
  TaskError,
};
