const { recognize } = require('../baidu-asr');
const { getPool, sql } = require('../db');
const { insertVoiceLog } = require('../voice-logs');

async function speechRoutes(fastify) {
  // 调试端点：前端各步骤状态写入 voice_logs，方便排查流程中断位置
  fastify.post('/speech/debug', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { text } = request.body || {};
    if (!text) return reply.code(400).send({ error: '缺少 text' });

    const userCode = request.user?.username || null;

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

  // 百度短语音上限 60 秒：16k 16bit 单声道约 1.9MB，base64 后约 2.6MB，超过 Fastify 默认的 1MB
  fastify.post('/speech/recognize', { preHandler: [fastify.authenticate], bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const { audio, format, rate, source } = request.body || {};

    if (!audio || typeof audio !== 'string') {
      return reply.code(400).send({ error: '缺少音频数据' });
    }

    const userCode = request.user?.username || null;

    try {
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
        userCode,
      });

      // 写入 voice_logs；返回 logId，对话框发送时据此记下用户实际发出的文字（失败不影响识别结果）
      let logId = null;
      try {
        const pool = await getPool();
        logId = await insertVoiceLog(pool, { text, userCode, source: source || 'float' });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to insert voice_log');
      }

      return { text, logId };
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
