/**
 * 钉钉警报消息发送核心模块
 *
 * 支持两种推送方式：
 * 1. 个人消息（通过企业内部应用 oToMessages/batchSend API，卡片消息）
 * 2. 群 Webhook（自定义机器人 Webhook，actionCard 卡片消息）
 *
 * 消息格式统一为 actionCard 卡片（带标题、正文、按钮链接）。
 */
const crypto = require('crypto');
const { getPool, sql } = require('./db');

const pino = require('pino');
const log = pino({ name: 'alert-dingtalk' });

// ==================== 钉钉 Access Token（复用 scheduled-reports 的逻辑） ====================

let _tokenCache = { token: '', expiresAt: 0 };

async function getDingAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const appKey = process.env.DINGTALK_APP_KEY || '';
  const appSecret = process.env.DINGTALK_APP_SECRET || '';
  if (!appKey || !appSecret) {
    log.warn('DINGTALK_APP_KEY/SECRET 未配置，无法获取 token');
    return null;
  }
  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey, appSecret }),
  });
  const data = await res.json();
  if (!data.accessToken) {
    log.error({ data }, '获取钉钉 access_token 失败');
    return null;
  }
  _tokenCache = { token: data.accessToken, expiresAt: Date.now() + (data.expireIn || 7200) * 1000 - 60000 };
  return _tokenCache.token;
}

// ==================== 个人消息推送（ActionCard 卡片） ====================

/**
 * 发送 ActionCard 卡片消息给单个或多个用户
 * @param {string[]} userIds - 钉钉 userId 列表（即 senderStaffId / U_DDUserId）
 * @param {object} card - 卡片内容
 * @param {string} card.title - 卡片标题
 * @param {string} card.markdown - 卡片正文（markdown 格式）
 * @param {string} [card.btnTitle] - 按钮文字
 * @param {string} [card.btnUrl] - 按钮链接
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendCardToUsers(userIds, card) {
  if (!userIds || userIds.length === 0) return { success: true };
  const token = await getDingAccessToken();
  if (!token) return { success: false, error: 'token 获取失败' };

  const robotCode = process.env.DINGTALK_APP_KEY;
  if (!robotCode) return { success: false, error: 'DINGTALK_APP_KEY 未配置' };

  // 构建 actionCard 消息参数
  // 钉钉 oToMessages/batchSend 支持的 msgKey：
  // - sampleActionCard6: 整体跳转 ActionCard（单按钮）
  // - sampleMarkdown: 普通 Markdown
  let msgKey, msgParam;

  if (card.btnTitle && card.btnUrl) {
    // 带按钮的 ActionCard
    msgKey = 'sampleActionCard6';
    msgParam = JSON.stringify({
      title: card.title || '⚠️ 警报通知',
      text: truncate(card.markdown || '', 18000),
      buttonTitle: card.btnTitle,
      buttonUrl: card.btnUrl,
    });
  } else {
    // 无按钮时降级为 Markdown
    msgKey = 'sampleMarkdown';
    msgParam = JSON.stringify({
      title: card.title || '⚠️ 警报通知',
      text: truncate(`### ${card.title}\n\n${card.markdown || ''}`, 18000),
    });
  }

  // 钉钉限制每次最多 20 个用户
  const batchSize = 20;
  const errors = [];

  for (let i = 0; i < userIds.length; i += batchSize) {
    const batch = userIds.slice(i, i + batchSize);
    try {
      const res = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({ robotCode, userIds: batch, msgKey, msgParam }),
      });
      if (!res.ok) {
        const errText = await res.text();
        log.warn({ status: res.status, err: errText, batch }, '钉钉个人消息发送失败');
        errors.push(errText);
      }
    } catch (err) {
      log.error({ err: err.message, batch }, '钉钉个人消息发送异常');
      errors.push(err.message);
    }
  }

  return errors.length > 0
    ? { success: false, error: errors.join('; ') }
    : { success: true };
}

// ==================== 群 Webhook 推送（ActionCard 卡片） ====================

/**
 * 通过群自定义机器人 Webhook 发送 ActionCard 卡片
 * @param {string} webhookUrl - Webhook 地址
 * @param {string|null} secret - 加签密钥（可选）
 * @param {object} card - 卡片内容
 * @param {string} card.title - 卡片标题
 * @param {string} card.markdown - 卡片正文（markdown 格式）
 * @param {string} [card.btnTitle] - 按钮文字
 * @param {string} [card.btnUrl] - 按钮链接
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendCardToWebhook(webhookUrl, secret, card) {
  if (!webhookUrl) return { success: false, error: 'Webhook URL 为空' };

  // 处理加签
  let url = webhookUrl;
  if (secret) {
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = crypto
      .createHmac('sha256', secret)
      .update(stringToSign)
      .digest('base64');
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }

  // 构建消息体
  let body;
  if (card.btnTitle && card.btnUrl) {
    body = {
      msgtype: 'actionCard',
      actionCard: {
        title: card.title || '⚠️ 警报通知',
        text: truncate(card.markdown || '', 18000),
        singleTitle: card.btnTitle,
        singleURL: card.btnUrl,
        btnOrientation: '0',
      },
    };
  } else {
    // 无按钮降级为 markdown
    body = {
      msgtype: 'markdown',
      markdown: {
        title: card.title || '⚠️ 警报通知',
        text: truncate(`### ${card.title}\n\n${card.markdown || ''}`, 18000),
      },
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.errcode && data.errcode !== 0) {
      log.warn({ data, webhookUrl: webhookUrl.slice(0, 60) }, '群 Webhook 发送失败');
      return { success: false, error: data.errmsg || JSON.stringify(data) };
    }
    return { success: true };
  } catch (err) {
    log.error({ err: err.message }, '群 Webhook 发送异常');
    return { success: false, error: err.message };
  }
}

// ==================== 解析推送目标（用户 + Webhook） ====================

/**
 * 根据规则配置解析所有钉钉 userId
 * @param {object} rule - 警报规则
 * @returns {Promise<string[]>} 钉钉 userId 列表
 */
async function resolveTargetDingUserIds(rule) {
  const pool = await getPool();
  const userIds = new Set();

  // 1. 按指定用户
  const targetUsers = safeJsonParse(rule.target_users_json) || [];
  if (targetUsers.length > 0) {
    // 通过 OUSR.U_DDUserId 获取钉钉 userId
    const placeholders = targetUsers.map((_, i) => `@u${i}`).join(', ');
    const req = pool.request();
    targetUsers.forEach((u, i) => req.input(`u${i}`, sql.NVarChar(64), u));
    const rs = await req.query(
      `SELECT [U_DDUserId] FROM dbo.OUSR WHERE [USER_CODE] IN (${placeholders}) AND [U_DDUserId] IS NOT NULL AND [U_DDUserId] <> ''`
    );
    for (const row of rs.recordset || []) {
      if (row.U_DDUserId) userIds.add(row.U_DDUserId);
    }
  }

  // 2. 按角色（仅当未指定用户时使用）
  if (targetUsers.length === 0) {
    const targetRoles = safeJsonParse(rule.target_roles_json) || [];
    if (targetRoles.length > 0) {
      const placeholders = targetRoles.map((_, i) => `@r${i}`).join(', ');
      const req = pool.request();
      targetRoles.forEach((r, i) => req.input(`r${i}`, sql.NVarChar(32), r));
      const rs = await req.query(
        `SELECT DISTINCT u.[U_DDUserId]
         FROM dbo.user_roles ur
         JOIN dbo.OUSR u ON u.[USER_CODE] = ur.user_code
         WHERE ur.role_key IN (${placeholders})
           AND u.[U_DDUserId] IS NOT NULL AND u.[U_DDUserId] <> ''`
      );
      for (const row of rs.recordset || []) {
        if (row.U_DDUserId) userIds.add(row.U_DDUserId);
      }
    }
  }

  return [...userIds];
}

/**
 * 获取规则配置的 Webhook 列表
 * @param {object} rule - 警报规则
 * @returns {Promise<Array<{id: number, name: string, webhook_url: string, secret: string|null}>>}
 */
async function resolveTargetWebhooks(rule) {
  const webhookIds = safeJsonParse(rule.target_webhooks_json) || [];
  if (webhookIds.length === 0) return [];

  const pool = await getPool();
  const placeholders = webhookIds.map((_, i) => `@w${i}`).join(', ');
  const req = pool.request();
  webhookIds.forEach((id, i) => req.input(`w${i}`, sql.Int, Number(id)));
  const rs = await req.query(
    `SELECT id, name, webhook_url, secret
     FROM dbo.alert_webhooks
     WHERE id IN (${placeholders}) AND enabled = 1`
  );
  return rs.recordset || [];
}

// ==================== 统一发送入口 ====================

/**
 * 发送警报卡片消息
 * @param {object} rule - 警报规则配置
 * @param {object} card - 渲染好的卡片内容 { title, markdown, btnTitle, btnUrl }
 * @returns {Promise<{usersSent: number, webhooksSent: number, errors: string[]}>}
 */
async function sendAlertCard(rule, card) {
  const errors = [];
  let usersSent = 0;
  let webhooksSent = 0;

  // 1. 推送个人
  const dingUserIds = await resolveTargetDingUserIds(rule);
  if (dingUserIds.length > 0) {
    const result = await sendCardToUsers(dingUserIds, card);
    if (result.success) {
      usersSent = dingUserIds.length;
    } else {
      errors.push(`个人推送失败: ${result.error}`);
    }
  }

  // 2. 推送群 Webhook
  const webhooks = await resolveTargetWebhooks(rule);
  for (const wh of webhooks) {
    const result = await sendCardToWebhook(wh.webhook_url, wh.secret, card);
    if (result.success) {
      webhooksSent++;
    } else {
      errors.push(`Webhook[${wh.name}]失败: ${result.error}`);
    }
  }

  return { usersSent, webhooksSent, errors };
}

// ==================== 模板渲染 ====================

/**
 * 渲染卡片模板，将 {列名} 替换为实际值
 * @param {string} template - 模板字符串
 * @param {object} data - 数据行
 * @returns {string}
 */
function renderTemplate(template, data) {
  if (!template) return '';
  return template.replace(/\{([^}]+)\}/g, (_, key) => {
    const col = key.trim();
    const val = data[col];
    if (val == null) return '';
    if (val instanceof Date) return val.toISOString().replace('T', ' ').slice(0, 19);
    return String(val);
  });
}

/**
 * 根据规则和数据行构建卡片内容
 * @param {object} rule - 警报规则
 * @param {object|object[]} dataRows - 触发数据（单行或多行）
 * @returns {object} { title, markdown, btnTitle, btnUrl }
 */
function buildCardFromRule(rule, dataRows) {
  const rows = Array.isArray(dataRows) ? dataRows : [dataRows];
  const firstRow = rows[0] || {};

  const title = renderTemplate(rule.card_title_template, firstRow) || '⚠️ 警报通知';

  let markdown = '';
  if (rule.card_body_template) {
    if (rows.length === 1) {
      // 单行直接渲染
      markdown = renderTemplate(rule.card_body_template, firstRow);
    } else {
      // 多行：逐行渲染，用分隔线分开（最多显示10条）
      const displayRows = rows.slice(0, 10);
      markdown = displayRows.map((r) => renderTemplate(rule.card_body_template, r)).join('\n\n---\n\n');
      if (rows.length > 10) {
        markdown += `\n\n---\n\n> 共 ${rows.length} 条，仅显示前 10 条`;
      }
    }
  } else {
    // 无模板时，自动用第一行数据生成简要摘要
    const keys = Object.keys(firstRow).slice(0, 6);
    markdown = keys.map((k) => `- **${k}**: ${firstRow[k] ?? ''}`).join('\n');
    if (rows.length > 1) {
      markdown += `\n\n> 共 ${rows.length} 条数据触发此警报`;
    }
  }

  const btnTitle = rule.card_btn_title || null;
  const btnUrl = rule.card_btn_url ? renderTemplate(rule.card_btn_url, firstRow) : null;

  return { title, markdown, btnTitle, btnUrl };
}

// ==================== 工具函数 ====================

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\n\n…（内容过长已截断）' : text;
}

function safeJsonParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = {
  getDingAccessToken,
  sendCardToUsers,
  sendCardToWebhook,
  resolveTargetDingUserIds,
  resolveTargetWebhooks,
  sendAlertCard,
  renderTemplate,
  buildCardFromRule,
};
