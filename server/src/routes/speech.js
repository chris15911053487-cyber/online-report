const { recognize } = require('../baidu-asr');

async function speechRoutes(fastify) {
  fastify.post('/api/speech/recognize', async (request, reply) => {
    const { audio, format, rate } = request.body || {};

    if (!audio || typeof audio !== 'string') {
      return reply.code(400).send({ error: '缺少音频数据' });
    }

    try {
      // Calculate original byte length from base64
      const padding = (audio.endsWith('==') ? 2 : audio.endsWith('=') ? 1 : 0);
      const audioBytes = (audio.length / 4) * 3 - padding;

      const text = await recognize(audio, audioBytes, {
        format: format || 'wav',
        rate: rate || 16000,
      });

      return { text };
    } catch (err) {
      fastify.log.error({ err }, 'Baidu ASR failed');
      return reply.code(502).send({ error: err.message || '语音识别失败' });
    }
  });
}

module.exports = speechRoutes;
