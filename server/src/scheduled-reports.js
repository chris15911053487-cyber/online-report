/**
 * 定时 AI 报告推送调度模块。
 * - node-cron 定时触发
 * - agentChatCore 生成报告
 * - 通过 IM 平台推送给目标用户
 */
const cron = require('node-cron');
const { getPool, sql } = require('./db');
const { agentChatCore } = require('./agent-chat-core');
const { resolveUserRolesSync, getAdminUserCodesSet } = require('./roles');
const crypto = require('crypto');

const activeTasks = new Map(); // id -> cron.ScheduledTask

// ==================== IM 发送函数 ====================

// --- 钉钉 ---
let _dingToken = { token: '', expiresAt: 0 };
async function getDingAccessToken() {
  if (_dingToken.token && Date.now() < _dingToken.expiresAt) return _dingToken.token;
  const appKey = process.env.DINGTALK_APP_KEY || '';
  const appSecret = process.env.DINGTALK_APP_SECRET || '';
  if (!appKey || !appSecret) return null;
  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey, appSecret }),
  });
  const data = await res.json();
  if (!data.accessToken) return null;
  _dingToken = { token: data.accessToken, expiresAt: Date.now() + (data.expireIn || 7200) * 1000 - 60000 };
  return _dingToken.token;
}

async function sendDingtalk(platformUid, text, log) {
  const token = await getDingAccessToken();
  if (!token) return;
  const res = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify({
      robotCode: process.env.DINGTALK_APP_KEY,
      userIds: [platformUid],
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: '📊 定时报告', text: truncate(text, 18000) }),
    }),
  });
  if (!res.ok) log?.warn?.('dingtalk scheduled send failed: ' + (await res.text()));
}

// --- 企业微信 ---
let _wecomToken = { token: '', expiresAt: 0 };
async function getWecomAccessToken() {
  if (_wecomToken.token && Date.now() < _wecomToken.expiresAt) return _wecomToken.token;
  const corpId = process.env.WECOM_CORP_ID || '';
  const secret = process.env.WECOM_SECRET || '';
  if (!corpId || !secret) return null;
  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`);
  const data = await res.json();
  if (!data.access_token) return null;
  _wecomToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 7200) * 1000 - 60000 };
  return _wecomToken.token;
}

async function sendWecom(platformUid, text, log) {
  const token = await getWecomAccessToken();
  if (!token) return;
  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser: platformUid,
      msgtype: 'markdown',
      agentid: Number(process.env.WECOM_AGENT_ID || 0),
      markdown: { content: truncate(text, 4000) },
    }),
  });
  const data = await res.json();
  if (data.errcode) log?.warn?.('wecom scheduled send failed: ' + JSON.stringify(data));
}

// --- 飞书 ---
let _feishuToken = { token: '', expiresAt: 0 };
async function getFeishuAccessToken() {
  if (_feishuToken.token && Date.now() < _feishuToken.expiresAt) return _feishuToken.token;
  const appId = process.env.FEISHU_APP_ID || '';
  const appSecret = process.env.FEISHU_APP_SECRET || '';
  if (!appId || !appSecret) return null;
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) return null;
  _feishuToken = { token: data.tenant_access_token, expiresAt: Date.now() + (data.expire || 7200) * 1000 - 60000 };
  return _feishuToken.token;
}

async function sendFeishu(platformUid, text, log) {
  const token = await getFeishuAccessToken();
  if (!token) return;
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: platformUid, msg_type: 'text', content: JSON.stringify({ text: truncate(text, 4000) }) }),
  });
  const data = await res.json();
  if (data.code !== 0) log?.warn?.('feishu scheduled send failed: ' + JSON.stringify(data));
}

function truncate(text, max) {
  if (!text) return '（无内容）';
  return text.length > max ? text.slice(0, max) + '\n\n…（内容过长已截断）' : text;
}

const SENDERS = { dingtalk: sendDingtalk, wecom: sendWecom, feishu: sendFeishu };

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

    // 2. 调用 Agent 生成报告（用系统账号身份）
    const systemUser = process.env.SCHEDULED_REPORT_USER || 'SYSTEM';
    const convId = `sched_${report.id}_${Date.now()}`;
    const result = await agentChatCore({
      userCode: systemUser,
      displayName: '定时报告',
      conversationId: convId,
      message: report.prompt_template,
      log,
    });

    const content = result.message || result.error || '报告生成失败';

    // 3. 推送给各用户
    const channels = safeJsonParse(report.channels_json) || ['dingtalk'];
    let sentCount = 0;

    for (const user of targetUsers) {
      const bindings = await getUserBindings(pool, user.userCode);
      let sent = false;
      for (const ch of channels) {
        const sender = SENDERS[ch];
        const binding = bindings.find((b) => b.platform === ch);
        if (!sender || !binding) continue;
        try {
          await sender(binding.platform_uid, `**${report.name}**\n\n${content}`, log);
          sent = true;
        } catch (err) {
          log?.warn?.({ err: err.message, ch, user: user.userCode }, 'scheduled push failed');
        }
      }
      if (sent) sentCount++;
    }

    await updateLog(pool, logId, 'done', targetUsers.length, sentCount, null, content);
    log?.info?.({ reportId: report.id, name: report.name, targets: targetUsers.length, sent: sentCount }, 'scheduled report done');
  } catch (err) {
    await updateLog(pool, logId, 'error', 0, 0, String(err.message).slice(0, 1000));
    log?.error?.({ err, reportId: report.id }, 'scheduled report execution error');
  }
}

async function resolveTargetUsers(pool, report) {
  const targetUserCodes = safeJsonParse(report.target_users_json) || [];
  const targetRoles = safeJsonParse(report.target_roles_json) || [];

  if (targetUserCodes.length > 0) {
    return targetUserCodes.map((c) => ({ userCode: c }));
  }

  if (targetRoles.length === 0) return [];

  // 从 user_roles 表查出拥有目标角色的用户
  const placeholders = targetRoles.map((_, i) => `@r${i}`).join(', ');
  const req = pool.request();
  targetRoles.forEach((r, i) => req.input(`r${i}`, sql.NVarChar(32), r));
  const rs = await req.query(
    `SELECT DISTINCT user_code FROM dbo.user_roles WHERE role_key IN (${placeholders})`
  );
  return (rs.recordset || []).map((r) => ({ userCode: r.user_code }));
}

async function getUserBindings(pool, userCode) {
  const rs = await pool.request()
    .input('uc', sql.NVarChar(64), userCode)
    .query('SELECT platform, platform_uid FROM dbo.bot_user_bindings WHERE user_code = @uc');
  return rs.recordset || [];
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

module.exports = { loadAndSchedule, stopAll, executeReport };
