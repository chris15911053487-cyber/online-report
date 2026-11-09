/**
 * 语音识别日志 voice_logs：识别结果 + 用户实际发出的文字（final_text）。
 * 两者不同 = 用户手动改过 = 识别错误样本，用于补百度自训练语料（scripts/export-asr-corpus.js）。
 */
const { sql } = require('./db');

const SOURCES = new Set(['chat', 'float']);

/** 写一条识别记录，返回 id（失败返回 null，不影响识别结果） */
async function insertVoiceLog(pool, { text, userCode, source }) {
  const r = await pool.request()
    .input('text', sql.NVarChar(512), String(text || '').slice(0, 512))
    .input('user_code', sql.NVarChar(64), userCode || null)
    .input('source', sql.NVarChar(16), SOURCES.has(source) ? source : null)
    .query(`INSERT INTO dbo.voice_logs (recognized_text, user_code, source)
            OUTPUT INSERTED.id AS id VALUES (@text, @user_code, @source)`);
  const id = r.recordset && r.recordset[0] ? Number(r.recordset[0].id) : null;
  return Number.isFinite(id) ? id : null;
}

/** 规范化前端带来的 voiceLogId：正整数才认 */
function normalizeVoiceLogId(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 用户发送时记下实际发出的文字；只改本人、尚未记录的那条 */
async function recordVoiceFinal(pool, { logId, userCode, finalText }) {
  const id = normalizeVoiceLogId(logId);
  if (!id || !userCode) return false;
  const r = await pool.request()
    .input('id', sql.BigInt, id)
    .input('user_code', sql.NVarChar(64), userCode)
    .input('final_text', sql.NVarChar(512), String(finalText || '').slice(0, 512))
    .query(`UPDATE dbo.voice_logs SET final_text = @final_text
            WHERE id = @id AND user_code = @user_code AND final_text IS NULL`);
  return (r.rowsAffected && r.rowsAffected[0]) > 0;
}

module.exports = { insertVoiceLog, recordVoiceFinal, normalizeVoiceLogId };
