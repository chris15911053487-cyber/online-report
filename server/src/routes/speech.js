const fs = require('fs');
const path = require('path');
const { recognize } = require('../baidu-asr');
const { getPool, sql } = require('../db');

async function speechRoutes(fastify) {
  // 调试端点：前端各步骤状态写入 voice_logs，方便排查流程中断位置
  fastify.post('/api/speech/debug', async (request, reply) => {
    const { text } = request.body || {};
    if (!text) return reply.code(400).send({ error: '缺少 text' });

    let userCode = null;
    try {
      const authHeader = request.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const decoded = fastify.jwt.verify(token);
        userCode = decoded.username || null;
      }
    } catch (_) {}

    try {
      const pool = await getPool();
      await pool.request()
        .input('text', sql.NVarChar(512), text)
        .input('user_code', sql.NVarChar(64), userCode)
        .query(`INSERT INTO dbo.voice_logs (recognized_text, user_code) VALUES (@text, @user_code)`);
    } catch (err) {
      fastify.log.error({ err }, 'Failed to insert voice_log from debug');
    }
    return { ok: true };
  });

  fastify.post('/api/speech/recognize', async (request, reply) => {
    const { audio, format, rate } = request.body || {};

    if (!audio || typeof audio !== 'string') {
      return reply.code(400).send({ error: '缺少音频数据' });
    }

    // 尝试从 JWT 提取用户（不强制要求登录）
    let userCode = null;
    try {
      const authHeader = request.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const decoded = fastify.jwt.verify(token);
        userCode = decoded.username || null;
      }
    } catch (_) {
      // token 无效或过期，userCode 保持 null
    }

    try {
      // 保存最近一次录音到 public/debug-audio.wav 供调试播放
      try {
        const buf = Buffer.from(audio, 'base64');
        const debugPath = path.join(__dirname, '..', '..', 'public', 'debug-audio.wav');
        fs.writeFileSync(debugPath, buf);
      } catch (e) {
        fastify.log.warn({ err: e }, 'Failed to save debug audio');
      }

      // Calculate original byte length from base64
      const padding = (audio.endsWith('==') ? 2 : audio.endsWith('=') ? 1 : 0);
      const audioBytes = (audio.length / 4) * 3 - padding;

      // 对比计算值和实际解码长度（用于排查 len 参数是否正确）
      try {
        const debugBuf = Buffer.from(audio, 'base64');
        fastify.log.info({ calcLen: audioBytes, actualLen: debugBuf.length, match: audioBytes === debugBuf.length }, 'audio len check');
      } catch (_) {}

      const text = await recognize(audio, audioBytes, {
        format: format || 'wav',
        rate: rate || 16000,
      });

      // 写入 voice_logs（fire-and-forget，不阻塞响应）
      const pool = await getPool();
      pool.request()
        .input('text', sql.NVarChar(512), text || '')
        .input('user_code', sql.NVarChar(64), userCode)
        .query(`INSERT INTO dbo.voice_logs (recognized_text, user_code) VALUES (@text, @user_code)`)
        .catch(err => fastify.log.error({ err }, 'Failed to insert voice_log'));

      return { text };
    } catch (err) {
      fastify.log.error({ err }, 'Baidu ASR failed');

      // 失败也写日志，方便排查
      try {
        const pool = await getPool();
        await pool.request()
          .input('text', sql.NVarChar(512), '[ASR_ERROR] ' + (err.message || 'unknown'))
          .input('user_code', sql.NVarChar(64), userCode)
          .query(`INSERT INTO dbo.voice_logs (recognized_text, user_code) VALUES (@text, @user_code)`);
      } catch (logErr) {
        fastify.log.error({ err: logErr }, 'Failed to insert voice_log for error case');
      }

      return reply.code(502).send({ error: err.message || '语音识别失败' });
    }
  });
}

module.exports = speechRoutes;
