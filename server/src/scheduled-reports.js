/**
 * 定时 AI 报告推送调度模块。
 * - node-cron 定时触发
 * - agentChatCore 生成报告：逐个目标用户以本人身份生成（Skill 里的当前用户 = 收件人），只推给本人
 * - 经 notify 推送给目标用户：写入「消息」收件箱 + 按 channels_json 发 IM（钉钉 / 企微 / 飞书）
 */
const cron = require('node-cron');
const { getPool, sql } = require('./db');
const { agentChatCore } = require('./agent-chat-core');
const { resolveUserRolesSync, getAdminUserCodesSet, resolveUserRoles } = require('./roles');
const { getAgent, canUseAgent } = require('./agents');
const { getSkill, canUseSkill } = require('./agent-skills');
const { loadExpandedDashboard } = require('./bi-dashboards');
const { runNamedQuery } = require('./bi-exec');
const { aiService } = require('./ai');
const { collectDashboardData, writeDigest, digestMessage, groupUsersByRoles, dashboardUsesSession } = require('./bi-digest');
const { notify, resolveRecipientCodes } = require('./notify');

const activeTasks = new Map(); // id -> cron.ScheduledTask

// ==================== 核心执行逻辑 ====================

async function executeReport(report, log) {
  const pool = await getPool();

  // 写执行日志
  const logRs = await pool.request()
    .input('rid', sql.Int, report.id)
    .query(`INSERT INTO dbo.scheduled_report_logs (report_id) VALUES (@rid);
            SELECT SCOPE_IDENTITY() AS log_id`);
  const logId = logRs.recordset[0].log_id;

  try {
    // 1. 解析目标用户
    const targetUsers = await resolveTargetUsers(pool, report);
    if (targetUsers.length === 0) {
      await updateLog(pool, logId, 'skipped', 0, 0, '无目标用户');
      return;
    }

    // 关联了看板 Agent：看板每日要点（按推送对象角色分组取数、写要点）
    if (report.agent_key) {
      const r = await executeDigestReport(pool, report, targetUsers, log);
      // target_count 记实际进收件箱的人数（无权 / 无卡片的人未推送，名单在 error_message）
      await updateLog(pool, logId, 'done', r.inboxCount, r.sentCount, r.skipped || null, r.content);
      log?.info?.({ reportId: report.id, name: report.name, targets: targetUsers.length, sent: r.sentCount }, 'dashboard digest done');
      return;
    }

    // 2. 关联了 Skill：只给 AI 这一个 skill，按它的表与口径查数（管理员选的，不受收件人角色限制）
    let skill = null;
    if (report.skill_name) {
      skill = await getSkill(pool, report.skill_name);
      if (!skill || !skill.enabled) {
        await updateLog(pool, logId, 'error', 0, 0, `关联的 Skill「${report.skill_name}」不存在或已停用`);
        return;
      }
    }

    // 3. 逐个目标用户以本人身份生成（当前用户编码 / 姓名 / 角色都是收件人自己的，
    //    Skill 里「按当前用户过滤」、@_loginUser 才对得上），只推给本人
    const r = await executePerUserReport(pool, report, targetUsers, skill, log);
    await updateLog(pool, logId, r.inboxCount ? 'done' : 'error', r.inboxCount, r.sentCount, r.skipped, r.content);
    log?.info?.({ reportId: report.id, name: report.name, targets: targetUsers.length, sent: r.sentCount }, 'scheduled report done');
  } catch (err) {
    await updateLog(pool, logId, 'error', 0, 0, String(err.message).slice(0, 1000));
    log?.error?.({ err, reportId: report.id }, 'scheduled report execution error');
  }
}

async function executePerUserReport(pool, report, targetUsers, skill, log) {
  const channels = safeJsonParse(report.channels_json) || ['dingtalk'];
  const names = await loadDisplayNames(pool, targetUsers.map((u) => u.userCode));
  const message = skill ? `请按 Skill「${skill.name}」的说明查数并写报告。\n\n${report.prompt_template}` : report.prompt_template;
  const contents = [];
  const failed = [];
  const imErrors = [];
  let sentCount = 0;
  let inboxCount = 0;
  for (const { userCode } of targetUsers) {
    // Skill 没设可用角色：只有管理员能用（与对话里一致）
    if (skill && !skill.roles.length && !canUseSkill(await resolveUserRoles(pool, userCode), skill.roles)) {
      failed.push(`${userCode}（Skill「${skill.name}」没有设置可用角色，请在「AI Skill」里至少勾选一个角色）`);
      continue;
    }
    let result;
    try {
      result = await agentChatCore({
        userCode,
        displayName: names.get(userCode) || userCode,
        conversationId: `sched_${report.id}_${Date.now()}_${contents.length + failed.length}`,
        message,
        skill,
        log,
      });
    } catch (err) {
      result = { error: err.message };
    }
    if (!result.message) {
      failed.push(`${userCode}（${String(result.error || '报告生成失败').slice(0, 100)}）`);
      continue;
    }
    contents.push(`【用户 ${userCode}】\n${result.message}`);
    const r = await notify({
      sourceType: 'report',
      sourceId: report.id,
      sourceName: report.name,
      title: report.name,
      body: result.message,
      recipients: [userCode],
      channels,
    });
    sentCount += r.imSent;
    inboxCount += r.recipients;
    imErrors.push(...r.errors);
  }
  return {
    sentCount,
    inboxCount,
    content: contents.join('\n\n'),
    skipped:
      [
        failed.length ? `生成失败，未推送：${failed.join('、')}` : '',
        imErrors.length ? `IM 推送失败：${[...new Set(imErrors)].join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('；')
        .slice(0, 1000) || null,
  };
}

/** 用户编码 → 姓名（OUSR.U_NAME，没有该列或查不到时用编码） */
async function loadDisplayNames(pool, codes) {
  const map = new Map();
  if (!codes.length) return map;
  try {
    const rs = await pool.request()
      .input('codes', sql.NVarChar(sql.MAX), JSON.stringify(codes))
      .query(`SELECT [USER_CODE] AS code, [U_NAME] AS name FROM [OUSR]
              WHERE [USER_CODE] IN (SELECT [value] FROM OPENJSON(@codes))`);
    for (const row of rs.recordset || []) if (row.name) map.set(String(row.code), String(row.name));
  } catch {}
  return map;
}

const digestLlm = async (messages) => {
  const r = await aiService.generateChat(messages, { maxTokens: 4000, temperature: 0.3 });
  if (!r.success) throw new Error(r.fallback || r.error || 'AI 服务不可用');
  return r.content;
};

/**
 * 生成看板要点（不推送）：按角色过滤看板 → 取数（bi-exec 缓存，key 含角色）→ AI 写要点 → 拼消息。
 * 供定时执行与管理页「预览」共用。
 */
async function buildDigest(pool, { agent, roles, title, focus, session, loaded: preloaded }) {
  const loaded = preloaded || (await loadExpandedDashboard(pool, agent.dashboardKey));
  if (!loaded || !loaded.dashboard.enabled) throw new Error(`Agent「${agent.label}」关联的看板不存在或已停用`);
  const run = async (query, params) => runNamedQuery({ pool, query, params, roles, session });
  const data = await collectDashboardData({ loaded, roles, run });
  const points = await writeDigest(digestLlm, data, focus);
  return { text: digestMessage({ title, points, agentKey: agent.agentKey, agentLabel: agent.label }), cardCount: data.cards.length };
}

async function executeDigestReport(pool, report, targetUsers, log) {
  const agent = await getAgent(pool, report.agent_key);
  if (!agent || !agent.enabled || !agent.dashboardKey) throw new Error(`Agent「${report.agent_key}」不存在、未启用或未关联看板`);
  const loaded = await loadExpandedDashboard(pool, agent.dashboardKey);
  if (!loaded || !loaded.dashboard.enabled) throw new Error(`Agent「${agent.label}」关联的看板不存在或已停用`);
  const channels = safeJsonParse(report.channels_json) || ['dingtalk'];
  const users = [];
  for (const u of targetUsers) users.push({ ...u, roles: await resolveUserRoles(pool, u.userCode) });
  // 卡片按登录用户取数（@_loginUser）时每人数据不同：逐人生成，不能按角色共用一份要点
  const perUser = dashboardUsesSession(loaded);
  const groups = perUser
    ? users.map((u) => ({ roles: [...new Set(u.roles || [])].sort(), users: [u] }))
    : [...groupUsersByRoles(users).values()];
  let sentCount = 0;
  const contents = [];
  const noAccess = [];
  const noCards = [];
  const imErrors = [];
  let inboxCount = 0;
  for (const { roles, users: group } of groups) {
    // 看不了这个 Agent 的人不推（看板经 Agent 门禁进入）
    if (!canUseAgent(roles, agent.roles)) {
      noAccess.push(...group.map((u) => u.userCode));
      continue;
    }
    const session = perUser ? { userCode: group[0].userCode } : null;
    const { text, cardCount } = await buildDigest(pool, { agent, roles, title: report.name, focus: report.prompt_template, session, loaded });
    // 这些角色在看板上一张卡片都看不到：不推「没有要点」打扰人
    if (cardCount === 0) {
      noCards.push(...group.map((u) => u.userCode));
      continue;
    }
    contents.push(`【${perUser ? `用户 ${group[0].userCode}` : `角色 ${roles.join(',') || '无'}`}】\n${text}`);
    const r = await notify({
      sourceType: 'report',
      sourceId: report.id,
      sourceName: report.name,
      title: report.name,
      // 要点正文首行是加粗标题，标题已单独显示，去掉免得重复
      body: text.replace(/^\*\*[^\n]*\*\*\n+/, ''),
      recipients: group.map((u) => u.userCode),
      channels,
    });
    sentCount += r.imSent;
    inboxCount += r.recipients;
    imErrors.push(...r.errors);
  }
  return {
    sentCount,
    inboxCount,
    content: contents.join('\n\n'),
    skipped:
      [
        noAccess.length ? `无权使用该 Agent，未推送：${noAccess.join('、')}` : '',
        noCards.length ? `看板上没有可看的卡片，未推送：${noCards.join('、')}` : '',
        imErrors.length ? `IM 推送失败：${[...new Set(imErrors)].join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('；')
        .slice(0, 1000) || null,
  };
}

/** 推送对象：指定用户优先，否则按角色展开 */
async function resolveTargetUsers(pool, report) {
  const codes = await resolveRecipientCodes(pool, safeJsonParse(report.target_users_json), safeJsonParse(report.target_roles_json));
  return codes.map((c) => ({ userCode: c }));
}

async function updateLog(pool, logId, status, targetCount, sentCount, errorMsg, aiResponse) {
  await pool.request()
    .input('id', sql.Int, logId)
    .input('s', sql.VarChar(16), status)
    .input('tc', sql.Int, targetCount)
    .input('sc', sql.Int, sentCount)
    .input('err', sql.NVarChar(1000), errorMsg || null)
    .input('ai', sql.NVarChar(sql.MAX), aiResponse || null)
    .query(`UPDATE dbo.scheduled_report_logs
            SET finished_at = DATEADD(HOUR,8,SYSUTCDATETIME()),
                status = @s, target_count = @tc, sent_count = @sc,
                error_message = @err, ai_response = @ai
            WHERE id = @id`);
}

function safeJsonParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ==================== 调度管理 ====================

async function loadAndSchedule(log) {
  // 停掉旧任务
  for (const [, task] of activeTasks) task.stop();
  activeTasks.clear();

  let rows = [];
  try {
    const pool = await getPool();
    const rs = await pool.request().query(
      `SELECT * FROM dbo.scheduled_reports WHERE enabled = 1`
    );
    rows = rs.recordset || [];
  } catch (err) {
    // 表可能不存在（未迁移），静默跳过
    log?.warn?.({ err: err.message }, 'scheduled_reports load failed (table may not exist)');
    return;
  }

  for (const row of rows) {
    if (!cron.validate(row.cron_expr)) {
      log?.warn?.({ id: row.id, cron: row.cron_expr }, 'invalid cron expression, skipping');
      continue;
    }
    const task = cron.schedule(row.cron_expr, () => {
      executeReport(row, log).catch((e) => log?.error?.(e, 'scheduled report unhandled'));
    }, { timezone: 'Asia/Shanghai' });
    activeTasks.set(row.id, task);
  }

  log?.info?.({ count: activeTasks.size }, 'scheduled reports loaded');
}

function stopAll() {
  for (const [, task] of activeTasks) task.stop();
  activeTasks.clear();
}

module.exports = { loadAndSchedule, stopAll, executeReport, buildDigest };
