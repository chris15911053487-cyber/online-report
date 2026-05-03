const fs = require('fs');
const path = require('path');

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif',
]);

const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
};

function extnameLower(p) {
  return path.extname(p).toLowerCase();
}

/**
 * 图片代理：读取内网 UNC 路径或本地文件，返回图片流。
 * GET /files/image?path=<urlEncodedPath>
 */
async function filesRoutes(fastify) {
  fastify.get('/files/image', async (request, reply) => {
    const raw = (request.query.path || '').trim();
    if (!raw) {
      return reply.code(400).send({ error: '缺少 path 参数' });
    }

    const decoded = decodeURIComponent(raw).trim();
    if (!decoded) {
      return reply.code(400).send({ error: 'path 为空' });
    }

    // 安全检查：禁止目录穿越
    if (decoded.includes('..')) {
      return reply.code(400).send({ error: '路径不合法' });
    }

    // 检查扩展名白名单
    const ext = extnameLower(decoded);
    if (!ext || !IMAGE_EXTS.has(ext)) {
      return reply.code(400).send({ error: '不支持的文件类型，仅允许图片格式' });
    }

    try {
      const st = await fs.promises.stat(decoded);
      if (!st.isFile()) {
        return reply.code(404).send({ error: '文件不存在' });
      }
    } catch {
      return reply.code(404).send({ error: '文件不可访问' });
    }

    const mime = MIME_MAP[ext] || 'application/octet-stream';
    const stream = fs.createReadStream(decoded);

    // 上游出错时优雅处理
    stream.on('error', (err) => {
      if (!reply.sent) {
        request.log.warn({ path: decoded, err: err.message }, '图片读取流错误');
      }
    });

    return reply
      .header('Content-Type', mime)
      .header('Cache-Control', 'public, max-age=300')
      .send(stream);
  });
}

module.exports = filesRoutes;
