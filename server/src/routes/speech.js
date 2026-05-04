const { recognize } = require('../baidu-asr');
const { getPool, sql } = require('../db');

async function speechRoutes(fastify) {
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
        userCode = decoded.user_code || null;
      }
    } catch (_) {
      // token 无效或过期，userCode 保持 null
    }

    try {
      // Calculate original byte length from base64
      const padding = (audio.endsWith('==') ? 2 : audio.endsWith('=') ? 1 : 0);
      const audioBytes = (audio.length / 4) * 3 - padding;

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
      return reply.code(502).send({ error: err.message || '语音识别失败' });
    }
  });
}

module.exports = speechRoutes;
