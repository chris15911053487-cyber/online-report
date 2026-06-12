/**
 * ai_conversations / ai_messages 数据访问：会话历史与续聊。
 * 一律按 user_code 隔离；时间列用中国本地墙钟（china-datetime.js）。
 */
const { getPool, sql } = require('./db');
const { SQL_CHINA_LOCAL_NOW_EXPR, toChinaLocalDateTimeForSql } = require('./china-datetime');

const CONV_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function sqlErrorNumber(err) {
  return err?.number ?? err?.originalError?.info?.number ?? err?.originalError?.number;
}
function isMissingTable(err) {
  return sqlErrorNumber(err) === 208;
}

function isValidConversationId(id) {
  return CONV_ID_RE.test(String(id || ''));
}

function deriveTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '新对话';
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}

/** 确保会话存在且归属正确；首条用户消息用于生成标题 */
async function ensureConversation(pool, { conversationId, userCode, firstUserText }) {
  const rs = await pool
    .request()
    .input('id', sql.NVarChar(64), conversationId)
    .query(`SELECT id, user_code FROM dbo.ai_conversations WHERE id = @id`);
  const row = rs.recordset && rs.recordset[0];
  if (row) {
    if (String(row.user_code) !== String(userCode)) {
      const err = new Error('会话不属于当前用户');
      err.code = 'CONV_FORBIDDEN';
      throw err;
    }
    return { created: false };
  }
  await pool
    .request()
    .input('id', sql.NVarChar(64), conversationId)
    .input('uc', sql.NVarChar(64), userCode)
    .input('title', sql.NVarChar(200), deriveTitle(firstUserText))
    .query(
      `INSERT INTO dbo.ai_conversations (id, user_code, title)
       VALUES (@id, @uc, @title)`
    );
  return { created: true };
}

async function touchConversation(pool, conversationId) {
  await pool
    .request()
    .input('id', sql.NVarChar(64), conversationId)
    .query(
      `UPDATE dbo.ai_conversations SET updated_at = ${SQL_CHINA_LOCAL_NOW_EXPR} WHERE id = @id`
    );
}

function parseToolStepsJson(raw) {
  if (!raw) return undefined;
  let v;
  try {
    v = JSON.parse(String(raw));
  } catch {
    return undefined;
  }
  if (!Array.isArray(v) || v.length === 0) return undefined;
  if (typeof v[0] === 'string') {
    return v.map((name) => ({ tool: name, label: String(name) }));
  }
  return v;
}

async function addMessage(pool, { conversationId, role, content, skillUsed, toolCalls, toolSteps }) {
  const toolsPayload = toolSteps || toolCalls || null;
  await pool
    .request()
    .input('cid', sql.NVarChar(64), conversationId)
    .input('role', sql.NVarChar(16), role)
    .input('content', sql.NVarChar(sql.MAX), String(content || ''))
    .input('skill', sql.NVarChar(64), skillUsed ? String(skillUsed).slice(0, 64) : null)
    .input(
      'tools',
      sql.NVarChar(sql.MAX),
      toolsPayload ? JSON.stringify(toolsPayload).slice(0, 100000) : null
    )
    .input('created', sql.DateTime2(3), toChinaLocalDateTimeForSql(new Date()))
    .query(
      `INSERT INTO dbo.ai_messages (conversation_id, role, content, skill_used, tool_calls_json, created_at)
       VALUES (@cid, @role, @content, @skill, @tools, @created)`
    );
}

/** 列出某用户的会话（最近在前） */
async function listConversations(pool, userCode, limit = 50) {
  try {
    const rs = await pool
      .request()
      .input('uc', sql.NVarChar(64), userCode)
      .input('top', sql.Int, Math.max(1, Math.min(200, limit)))
      .query(
        `SELECT TOP (@top) id, title, created_at, updated_at
         FROM dbo.ai_conversations WHERE user_code = @uc
         ORDER BY updated_at DESC`
      );
    return (rs.recordset || []).map((r) => ({
      id: String(r.id),
      title: String(r.title || '新对话'),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/** 读取会话消息（须校验归属） */
async function getConversationMessages(pool, userCode, conversationId) {
  const own = await pool
    .request()
    .input('id', sql.NVarChar(64), conversationId)
    .input('uc', sql.NVarChar(64), userCode)
    .query(`SELECT id FROM dbo.ai_conversations WHERE id = @id AND user_code = @uc`);
  if (!own.recordset || own.recordset.length === 0) return null;

  const rs = await pool
    .request()
    .input('cid', sql.NVarChar(64), conversationId)
    .query(
      `SELECT id, role, content, skill_used, tool_calls_json, created_at
       FROM dbo.ai_messages WHERE conversation_id = @cid ORDER BY id ASC`
    );
  return (rs.recordset || []).map((r) => ({
    id: Number(r.id),
    role: String(r.role),
    content: String(r.content || ''),
    skillUsed: r.skill_used ? String(r.skill_used) : undefined,
    toolSteps: parseToolStepsJson(r.tool_calls_json),
    createdAt: r.created_at,
  }));
}

async function deleteConversation(pool, userCode, conversationId) {
  const del = await pool
    .request()
    .input('id', sql.NVarChar(64), conversationId)
    .input('uc', sql.NVarChar(64), userCode)
    .query(`DELETE FROM dbo.ai_conversations WHERE id = @id AND user_code = @uc`);
  const removed = del.rowsAffected && del.rowsAffected[0] > 0;
  if (removed) {
    await pool
      .request()
      .input('cid', sql.NVarChar(64), conversationId)
      .query(`DELETE FROM dbo.ai_messages WHERE conversation_id = @cid`);
  }
  return removed;
}

module.exports = {
  isValidConversationId,
  ensureConversation,
  touchConversation,
  addMessage,
  listConversations,
  getConversationMessages,
  deleteConversation,
};
