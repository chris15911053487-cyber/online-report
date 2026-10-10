/**
 * 统一推送出口：警报、定时报告（含看板每日要点）等主动推送都走 notify()。
 *
 * 一次推送 = 一条 notifications + 每个接收人一行 notification_recipients：
 *   1. 先写收件箱（「消息」菜单 →「通知」页签），没绑定 IM 的人也能在系统里看到；
 *   2. 再按渠道发 IM：钉钉个人消息（OUSR.U_DDUserId / bot_user_bindings）、企业微信、飞书；
 *   3. 各渠道结果记在接收人行的 im_status_json（sent / failed / unbound）。
 * 群 Webhook 不是「人」，不进收件箱，由警报引擎自己发。
 *
 * 钉钉卡片按钮：调用方给了按钮（警报卡片的「查看详情」）就用它；否则配置了 PUBLIC_BASE_URL 时
 * 链接到系统里这条消息（/messages/:id），点开即已读。
 *
 * 收件箱读写（列表 / 详情 / 已读 / 未读数）也在这里，路由见 routes/messages.js。
 */
const { getPool, sql } = require('./db');
const { sendCardToUsers } = require('./alert-dingtalk');
const { sendWecom, sendFeishu } = require('./im-push');

const pino = require('pino');
const log = pino({ name: 'notify' });

const SOURCE_TYPES = new Set(['alert', 'report']);
const IM_CHANNELS = ['dingtalk', 'wecom', 'feishu'];
const MAX_TITLE = 256;
const MAX_USER_CODE = 64;

function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
}

/** 接收人去重、去空、截断 */
function normalizeRecipients(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const code = String(raw ?? '').trim().slice(0, MAX_USER_CODE);
    const k = code.toLowerCase();
    if (!code || seen.has(k)) continue;
    seen.add(k);
    out.push(code);
  }
  return out;
}

/** 钉钉卡片：调用方按钮优先，否则「在系统中查看」→ 消息详情 */
function buildDingCard({ title, body, linkTitle, linkUrl }, detailUrl) {
  const card = { title, markdown: body || '' };
  if (linkTitle && linkUrl) return { ...card, btnTitle: linkTitle, btnUrl: linkUrl };
  if (detailUrl) return { ...card, btnTitle: '在系统中查看', btnUrl: detailUrl };
  return card;
}

/** 企微 / 飞书只发文本：标题 + 正文 + 链接 */
function buildPlainText({ title, body, linkTitle, linkUrl }, detailUrl) {
  const url = linkTitle && linkUrl ? linkUrl : detailUrl;
  const label = linkTitle && linkUrl ? linkTitle : '在系统中查看';
  return [`**${title}**`, body || '', url ? `[${label}](${url})` : ''].filter(Boolean).join('\n\n');
}

/**
 * 创建推送器（测试注入 store / senders）。
 * store：insertNotification / insertRecipients / lookupImIds / saveImStatus
 * senders：dingtalk(uids, card) → { failedUserIds, error }；wecom / feishu(uid, text) → { success, error }
 */
function createNotifier({ store, senders, baseUrl = publicBaseUrl, logger = log } = {}) {
  /**
   * @param {{ sourceType: 'alert'|'report', sourceId?: number, sourceName?: string, title: string, body?: string,
   *           linkTitle?: string, linkUrl?: string, recipients: string[], channels?: string[] }} msg
   * @returns {Promise<{ notificationId: number|null, recipients: number, imSent: number, unbound: number, errors: string[] }>}
   *   recipients：进了收件箱的人数（收件箱写入失败时为 0，IM 照发）
   */
  async function notify(msg) {
    const recipients = normalizeRecipients(msg.recipients);
    const empty = { notificationId: null, recipients: 0, imSent: 0, unbound: 0, errors: [] };
    if (recipients.length === 0) return empty;
    if (!SOURCE_TYPES.has(msg.sourceType)) throw new Error(`未知的推送来源：${msg.sourceType}`);
    const content = {
      title: String(msg.title || '通知').slice(0, MAX_TITLE),
      body: String(msg.body || ''),
      linkTitle: msg.linkTitle ? String(msg.linkTitle).slice(0, 64) : null,
      linkUrl: msg.linkUrl ? String(msg.linkUrl).slice(0, 512) : null,
    };

    const errors = [];
    // 收件箱写不进去（如表未建好）不能连 IM 都不发：记错误，IM 照发（不带「在系统中查看」）
    let id = null;
    try {
      id = await store.insertNotification({ sourceType: msg.sourceType, sourceId: msg.sourceId ?? null, sourceName: msg.sourceName || null, ...content });
      await store.insertRecipients(id, recipients);
    } catch (err) {
      logger.error?.({ err: err.message }, '写入消息收件箱失败');
      errors.push(`收件箱写入失败: ${err.message}`);
      id = null;
    }

    const base = baseUrl();
    const detailUrl = base && id ? `${base}/messages/${id}` : null;
    const status = new Map(recipients.map((u) => [u, {}]));
    const channels = [...new Set(msg.channels || [])].filter((c) => IM_CHANNELS.includes(c));

    for (const ch of channels) {
      let ids;
      try {
        ids = await store.lookupImIds(ch, recipients);
      } catch (err) {
        errors.push(`${ch} 绑定查询失败: ${err.message}`);
        continue;
      }
      const bound = recipients.filter((u) => ids.has(u));
      for (const u of recipients) if (!ids.has(u)) status.get(u)[ch] = 'unbound';
      if (bound.length === 0) continue;

      if (ch === 'dingtalk') {
        const uids = [...new Set(bound.map((u) => ids.get(u)))];
        let failed;
        try {
          const r = await senders.dingtalk(uids, buildDingCard(content, detailUrl));
          failed = new Set(r.failedUserIds || []);
          if (r.error) errors.push(`钉钉: ${r.error}`);
        } catch (err) {
          failed = new Set(uids);
          errors.push(`钉钉: ${err.message}`);
        }
        for (const u of bound) status.get(u)[ch] = failed.has(ids.get(u)) ? 'failed' : 'sent';
      } else {
        const text = buildPlainText(content, detailUrl);
        for (const u of bound) {
          try {
            const r = await senders[ch](ids.get(u), text);
            status.get(u)[ch] = r.success ? 'sent' : 'failed';
            if (!r.success && r.error) errors.push(`${ch}[${u}]: ${r.error}`);
          } catch (err) {
            status.get(u)[ch] = 'failed';
            errors.push(`${ch}[${u}]: ${err.message}`);
          }
        }
      }
    }

    if (id && channels.length > 0) {
      try {
        await store.saveImStatus(id, status);
      } catch (err) {
        logger.warn?.({ err: err.message, id }, '记录 IM 推送结果失败');
      }
    }
    const states = [...status.values()];
    return {
      notificationId: id,
      recipients: id ? recipients.length : 0,
      imSent: states.filter((s) => Object.values(s).includes('sent')).length,
      unbound: channels.length ? states.filter((s) => channels.every((c) => s[c] === 'unbound')).length : 0,
      errors: [...new Set(errors)],
    };
  }

  return { notify };
}

// ==================== SQL 存储 ====================

/** IN (...) 参数化：每批最多 500 个，远低于 SQL Server 2100 参数上限 */
async function inChunks(list, size, fn) {
  for (let i = 0; i < list.length; i += size) await fn(list.slice(i, i + size));
}

const sqlStore = {
  async insertNotification(n) {
    const pool = await getPool();
    const rs = await pool
      .request()
      .input('st', sql.VarChar(16), n.sourceType)
      .input('sid', sql.Int, n.sourceId)
      .input('sn', sql.NVarChar(128), n.sourceName ? String(n.sourceName).slice(0, 128) : null)
      .input('t', sql.NVarChar(MAX_TITLE), n.title)
      .input('b', sql.NVarChar(sql.MAX), n.body)
      .input('lt', sql.NVarChar(64), n.linkTitle)
      .input('lu', sql.NVarChar(512), n.linkUrl)
      .query(
        `INSERT INTO dbo.notifications (source_type, source_id, source_name, title, body, link_title, link_url)
         VALUES (@st, @sid, @sn, @t, @b, @lt, @lu);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id`,
      );
    return rs.recordset[0].id;
  },

  async insertRecipients(id, users) {
    const pool = await getPool();
    await inChunks(users, 500, async (batch) => {
      const req = pool.request().input('nid', sql.Int, id);
      const values = batch.map((u, i) => {
        req.input(`u${i}`, sql.NVarChar(MAX_USER_CODE), u);
        return `(@nid, @u${i})`;
      });
      await req.query(`INSERT INTO dbo.notification_recipients (notification_id, user_code) VALUES ${values.join(', ')}`);
    });
  },

  /** 用户编码 → IM 账号；钉钉先看机器人绑定，再回退 OUSR.U_DDUserId */
  async lookupImIds(channel, users) {
    const pool = await getPool();
    const map = new Map();
    const byLower = new Map(users.map((u) => [u.toLowerCase(), u]));
    const put = (code, uid) => {
      const u = byLower.get(String(code || '').trim().toLowerCase());
      if (u && uid && !map.has(u)) map.set(u, String(uid));
    };
    await inChunks(users, 500, async (batch) => {
      const req = pool.request().input('p', sql.NVarChar(20), channel);
      const ph = batch.map((u, i) => {
        req.input(`u${i}`, sql.NVarChar(MAX_USER_CODE), u);
        return `@u${i}`;
      });
      const rs = await req.query(
        `SELECT user_code, platform_uid FROM dbo.bot_user_bindings WHERE platform = @p AND user_code IN (${ph.join(', ')})`,
      );
      for (const r of rs.recordset || []) put(r.user_code, r.platform_uid);
    });
    if (channel === 'dingtalk') {
      const rest = users.filter((u) => !map.has(u));
      await inChunks(rest, 500, async (batch) => {
        const req = pool.request();
        const ph = batch.map((u, i) => {
          req.input(`u${i}`, sql.NVarChar(MAX_USER_CODE), u);
          return `@u${i}`;
        });
        const rs = await req.query(
          `SELECT [USER_CODE] AS user_code, [U_DDUserId] AS uid FROM dbo.OUSR
           WHERE [USER_CODE] IN (${ph.join(', ')}) AND [U_DDUserId] IS NOT NULL AND [U_DDUserId] <> ''`,
        );
        for (const r of rs.recordset || []) put(r.user_code, r.uid);
      });
    }
    return map;
  },

  /** 结果相同的接收人一起更新 */
  async saveImStatus(id, status) {
    const pool = await getPool();
    const groups = new Map();
    for (const [u, s] of status) {
      const json = JSON.stringify(s);
      if (json === '{}') continue;
      if (!groups.has(json)) groups.set(json, []);
      groups.get(json).push(u);
    }
    for (const [json, users] of groups) {
      await inChunks(users, 500, async (batch) => {
        const req = pool.request().input('nid', sql.Int, id).input('s', sql.NVarChar(400), json.slice(0, 400));
        const ph = batch.map((u, i) => {
          req.input(`u${i}`, sql.NVarChar(MAX_USER_CODE), u);
          return `@u${i}`;
        });
        await req.query(
          `UPDATE dbo.notification_recipients SET im_status_json = @s WHERE notification_id = @nid AND user_code IN (${ph.join(', ')})`,
        );
      });
    }
  },
};

const defaultNotifier = createNotifier({
  store: sqlStore,
  senders: { dingtalk: sendCardToUsers, wecom: sendWecom, feishu: sendFeishu },
});

// ==================== 接收人解析 ====================

/**
 * 推送对象 → 用户编码：指定了用户就只用用户，否则按角色（user_roles）展开。
 * 与警报 / 定时报告原有规则一致。
 */
async function resolveRecipientCodes(pool, users, roles) {
  const userList = normalizeRecipients(Array.isArray(users) ? users : []);
  if (userList.length > 0) return userList;
  const roleList = [...new Set((Array.isArray(roles) ? roles : []).map((r) => String(r || '').trim()).filter(Boolean))];
  if (roleList.length === 0) return [];
  const req = pool.request();
  const ph = roleList.map((r, i) => {
    req.input(`r${i}`, sql.NVarChar(32), r);
    return `@r${i}`;
  });
  const rs = await req.query(`SELECT DISTINCT user_code FROM dbo.user_roles WHERE role_key IN (${ph.join(', ')})`);
  return normalizeRecipients((rs.recordset || []).map((r) => r.user_code));
}

// ==================== 收件箱读写 ====================

const PREVIEW_LEN = 80;

/** 列表摘要：去掉 Markdown 记号，压成一行 */
function previewText(body) {
  return String(body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PREVIEW_LEN);
}

function mapListRow(r) {
  return {
    id: Number(r.id),
    sourceType: r.source_type,
    sourceName: r.source_name || '',
    title: r.title,
    preview: previewText(r.body_head),
    createdAt: r.created_at,
    read: r.read_at != null,
  };
}

/**
 * 我的通知，按时间倒序；before = 上一页最后一条的 id（游标翻页）。
 * @returns {Promise<{ items: object[], hasMore: boolean }>}
 */
async function listInbox(pool, userCode, { before, limit = 30, unreadOnly = false } = {}) {
  const n = Math.min(100, Math.max(1, Number(limit) || 30));
  const req = pool.request().input('uc', sql.NVarChar(MAX_USER_CODE), userCode).input('n', sql.Int, n + 1);
  let where = 'r.user_code = @uc';
  if (Number.isSafeInteger(Number(before)) && Number(before) > 0) {
    req.input('before', sql.Int, Number(before));
    where += ' AND n.id < @before';
  }
  if (unreadOnly) where += ' AND r.read_at IS NULL';
  const rs = await req.query(
    `SELECT TOP (@n) n.id, n.source_type, n.source_name, n.title, LEFT(n.body, 400) AS body_head, n.created_at, r.read_at
     FROM dbo.notification_recipients r
     JOIN dbo.notifications n ON n.id = r.notification_id
     WHERE ${where}
     ORDER BY n.id DESC`,
  );
  const rows = rs.recordset || [];
  return { items: rows.slice(0, n).map(mapListRow), hasMore: rows.length > n };
}

/** 单条详情：只有接收人能看；打开即标为已读。不存在或不是接收人返回 null */
async function openInboxItem(pool, userCode, id) {
  const rs = await pool
    .request()
    .input('uc', sql.NVarChar(MAX_USER_CODE), userCode)
    .input('id', sql.Int, id)
    .query(
      `SELECT n.id, n.source_type, n.source_name, n.title, n.body, n.link_title, n.link_url, n.created_at, r.read_at
       FROM dbo.notification_recipients r
       JOIN dbo.notifications n ON n.id = r.notification_id
       WHERE r.user_code = @uc AND n.id = @id;
       UPDATE dbo.notification_recipients SET read_at = DATEADD(HOUR, 8, SYSUTCDATETIME())
       WHERE user_code = @uc AND notification_id = @id AND read_at IS NULL;`,
    );
  const r = rs.recordset?.[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    sourceType: r.source_type,
    sourceName: r.source_name || '',
    title: r.title,
    body: r.body || '',
    linkTitle: r.link_title || '',
    linkUrl: r.link_url || '',
    createdAt: r.created_at,
    read: true,
  };
}

/** 标为已读：ids 指定几条，或 all 全部 */
async function markInboxRead(pool, userCode, { ids, all } = {}) {
  const req = pool.request().input('uc', sql.NVarChar(MAX_USER_CODE), userCode);
  let filter = '';
  if (!all) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, 500);
    if (list.length === 0) return { updated: 0 };
    const ph = list.map((x, i) => {
      req.input(`i${i}`, sql.Int, x);
      return `@i${i}`;
    });
    filter = ` AND notification_id IN (${ph.join(', ')})`;
  }
  const rs = await req.query(
    `UPDATE dbo.notification_recipients SET read_at = DATEADD(HOUR, 8, SYSUTCDATETIME())
     WHERE user_code = @uc AND read_at IS NULL${filter}`,
  );
  return { updated: rs.rowsAffected?.[0] || 0 };
}

async function countInboxUnread(pool, userCode) {
  const rs = await pool
    .request()
    .input('uc', sql.NVarChar(MAX_USER_CODE), userCode)
    .query('SELECT COUNT(*) AS c FROM dbo.notification_recipients WHERE user_code = @uc AND read_at IS NULL');
  return Number(rs.recordset?.[0]?.c) || 0;
}

module.exports = {
  createNotifier,
  notify: (msg) => defaultNotifier.notify(msg),
  resolveRecipientCodes,
  normalizeRecipients,
  buildDingCard,
  buildPlainText,
  previewText,
  listInbox,
  openInboxItem,
  markInboxRead,
  countInboxUnread,
  IM_CHANNELS,
};
