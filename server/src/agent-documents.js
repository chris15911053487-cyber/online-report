/**
 * Agent 产出文档的落盘与鉴权下载（二期）。
 * 文件存 AI_DOCS_DIR；元数据存 ai_documents；下载按 user_code 校验归属。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sql } = require('./db');

const ALLOWED_EXT = new Set(['xlsx', 'csv', 'docx', 'pdf', 'txt']);
const MIME_MAP = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
};

function docsDir() {
  return process.env.AI_DOCS_DIR || path.join(__dirname, '..', 'public', 'ai-docs');
}

function newId() {
  return 'doc-' + crypto.randomBytes(16).toString('hex');
}

function isAllowedExt(ext) {
  return ALLOWED_EXT.has(String(ext || '').toLowerCase());
}

function mimeForExt(ext) {
  return MIME_MAP[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

/** 落盘 + 写元数据。bytes 为 Buffer。 */
async function storeDocument(pool, { userCode, conversationId, filename, ext, bytes }) {
  const cleanExt = String(ext || '').toLowerCase();
  if (!isAllowedExt(cleanExt)) {
    const err = new Error('不支持的文档类型');
    err.code = 'DOC_BAD_EXT';
    throw err;
  }
  const dir = docsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const id = newId();
  const diskPath = path.join(dir, `${id}.${cleanExt}`);
  await fs.promises.writeFile(diskPath, bytes);
  const mime = mimeForExt(cleanExt);
  const safeName = String(filename || `document.${cleanExt}`).replace(/[\\/]/g, '_').slice(0, 255);

  await pool
    .request()
    .input('id', sql.NVarChar(64), id)
    .input('uc', sql.NVarChar(64), userCode || '')
    .input('cid', sql.NVarChar(64), conversationId || null)
    .input('fn', sql.NVarChar(255), safeName)
    .input('mime', sql.NVarChar(128), mime)
    .input('ext', sql.NVarChar(16), cleanExt)
    .input('size', sql.Int, bytes.length)
    .query(
      `INSERT INTO dbo.ai_documents (id, user_code, conversation_id, filename, mime, ext, byte_size)
       VALUES (@id, @uc, @cid, @fn, @mime, @ext, @size)`
    );
  return { id, filename: safeName, mime, ext: cleanExt, byteSize: bytes.length };
}

/** 取元数据（校验归属）。返回 { filename, mime, ext, diskPath } 或 null */
async function getOwnedDocument(pool, userCode, id) {
  const rs = await pool
    .request()
    .input('id', sql.NVarChar(64), String(id || ''))
    .input('uc', sql.NVarChar(64), userCode || '')
    .query(
      `SELECT id, filename, mime, ext FROM dbo.ai_documents WHERE id = @id AND user_code = @uc`
    );
  const row = rs.recordset && rs.recordset[0];
  if (!row) return null;
  const ext = String(row.ext || '').toLowerCase();
  if (!isAllowedExt(ext)) return null;
  const diskPath = path.join(docsDir(), `${row.id}.${ext}`);
  return { filename: String(row.filename), mime: String(row.mime), ext, diskPath };
}

module.exports = {
  ALLOWED_EXT,
  isAllowedExt,
  mimeForExt,
  storeDocument,
  getOwnedDocument,
};
