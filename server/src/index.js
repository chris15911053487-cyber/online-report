const path = require('path');
const serverEnvPath = path.join(__dirname, '..', '.env');
const repoRootEnvPath = path.join(__dirname, '..', '..', '.env');
// 先读仓库根目录 .env，再读 server/.env 并覆盖，避免 Key 只写在根目录时读不到
require('dotenv').config({ path: repoRootEnvPath });
require('dotenv').config({ path: serverEnvPath, override: true });

const fs = require('fs');
const fsp = require('fs').promises;
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const jwt = require('@fastify/jwt');
const fastifyStatic = require('@fastify/static');
const authRoutes = require('./routes/auth');
const rolesAdminRoutes = require('./routes/roles-admin');
const ordersRoutes = require('./routes/orders');
const menusRoutes = require('./routes/menus');
const { isAdminUser } = require('./roles');
const reportsRoutes = require('./routes/reports');
const proSignRoutes = require('./routes/pro-sign');
const returnproRoutes = require('./routes/returnpro');
const registerOworRoutes = require('./routes/owor');
const aiRoutes = require('./routes/ai');
const filesRoutes = require('./routes/files');
const speechRoutes = require('./routes/speech');
const { getPool } = require('./db');
const ensureNavMenuSchema = require('./ensure-nav-menu-schema');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

const PUBLIC_ROOT = path.join(__dirname, '..', 'public');
/** 随代码部署：把 APK 命名为 android-app.apk 放到 public/apk/ 即可 */
const PUBLIC_APK_BUNDLE = path.join(PUBLIC_ROOT, 'apk', 'android-app.apk');

function getAndroidApkCandidates() {
  const fromShare = path.join(
    process.env.APK_SHARE_ROOT || '/root/apk-share',
    process.env.APK_FILENAME || '手机报工1.0.apk',
  );
  const raw = process.env.APK_PATH && String(process.env.APK_PATH).trim();
  const list = [];
  if (raw) list.push(path.resolve(raw));
  list.push(PUBLIC_APK_BUNDLE);
  list.push(fromShare);
  return [...new Set(list)];
}

async function resolveReadableApkFile(candidatePaths) {
  for (const p of candidatePaths) {
    try {
      const st = await fsp.stat(p);
      if (st.isFile() && st.size > 0) return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function build() {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, {
    origin: true,
  });

  await fastify.register(jwt, {
    secret: JWT_SECRET,
    sign: { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
  });

  fastify.decorate('authenticate', async function authenticate(request, reply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      return reply.send(err);
    }
  });

  fastify.decorate('requireAdmin', async function requireAdmin(request, reply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      return reply.send(err);
    }
    if (!isAdminUser(request.user)) {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
  });

  await fastify.register(authRoutes);
  await fastify.register(rolesAdminRoutes);
  await fastify.register(ordersRoutes);
  await fastify.register(menusRoutes);
  await fastify.register(reportsRoutes);
  await fastify.register(proSignRoutes);
  await fastify.register(returnproRoutes);
  await fastify.register(aiRoutes);
  await fastify.register(filesRoutes);

  // 语音功能开关（默认启用，设 VOICE_ENABLED=false 关闭）
  const voiceEnabled = process.env.VOICE_ENABLED !== 'false';
  if (voiceEnabled) {
    await fastify.register(speechRoutes);
    fastify.log.info('voice feature enabled');
  } else {
    fastify.log.info('voice feature disabled via VOICE_ENABLED=false');
  }

  registerOworRoutes(fastify);

  // 向 HTML 页面注入 voice-enabled meta 标签和 voice.js 脚本（仅在尚未包含时）
  fastify.addHook('onSend', async (_request, _reply, payload) => {
    const str = typeof payload === 'string' ? payload : payload.toString('utf-8');
    if (str.includes('</head>') && str.includes('</body>')) {
      let result = str;
      if (!result.includes('name="voice-enabled"')) {
        result = result.replace('</head>', '<meta name="voice-enabled" content="' + (voiceEnabled ? 'true' : 'false') + '">\n</head>');
      }
      if (voiceEnabled && !result.includes('/js/voice.js')) {
        result = result.replace('</body>', '<script src="/js/voice.js"></script>\n</body>');
      }
      return result;
    }
    return payload;
  });

  fastify.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  fastify.get('/download/android-app.apk', async (request, reply) => {
    const candidates = getAndroidApkCandidates();
    const apkPath = await resolveReadableApkFile(candidates);
    if (!apkPath) {
      request.log.warn({ candidates }, 'android apk: no readable file (set APK_PATH or place public/apk/android-app.apk)');
      return reply.code(404).type('application/json').send({
        error: '安装包暂不可用',
        hint:
          '常见原因：Docker 内以非 root（node）运行，无法读取宿主机 /root/ 下文件。请把 APK 放到 /srv/apk 等目录并 chmod a+rX，或设 APK_PATH 指向容器可读路径；也可把文件复制为镜像内 /app/public/apk/android-app.apk。',
      });
    }
    const basename = path.basename(apkPath);
    const utf8Name = encodeURIComponent(basename);
    return reply
      .header('Content-Type', 'application/vnd.android.package-archive')
      .header(
        'Content-Disposition',
        `attachment; filename="android-app.apk"; filename*=UTF-8''${utf8Name}`,
      )
      .send(fs.createReadStream(apkPath));
  });

  // 确保 voice.js 始终可访问：即使静态根目录是 frontend/dist（未重新构建时可能缺少此文件）
  // 必须注册在 @fastify/static 之前，否则静态插件会先拦截返回 404
  if (voiceEnabled) {
    const voiceJsPath = path.join(__dirname, '..', 'public', 'js', 'voice.js');
    fastify.get('/js/voice.js', async (_, reply) => {
      try {
        await fsp.access(voiceJsPath);
        return reply.type('application/javascript').send(fs.createReadStream(voiceJsPath));
      } catch {
        return reply.code(404).send('Not Found');
      }
    });
  }

  // 静态站点：React SPA（frontend/dist）。server/public 仅保留 apk、images、voice.js 等非 SPA 资源。
  const serverDir = path.join(__dirname, '..');
  const repoRoot = path.join(serverDir, '..');
  const frontendDist = path.join(repoRoot, 'frontend', 'dist');
  const frontendIndex = path.join(frontendDist, 'index.html');

  const frontendMode = (process.env.FRONTEND_MODE || 'auto').trim().toLowerCase();
  if (frontendMode === 'legacy') {
    fastify.log.warn(
      'FRONTEND_MODE=legacy is removed; serving frontend/dist. Run: npm run build (from repo root)',
    );
  }

  const staticRoot = frontendDist;
  try {
    await fsp.access(frontendIndex);
    fastify.log.info({ staticRoot: frontendDist }, 'serving React frontend from frontend/dist');
  } catch {
    fastify.log.error(
      { tried: frontendIndex },
      'frontend/dist not found — web UI unavailable until build (repo root: npm run build, or cd frontend && npm run dev for Vite on :5173)',
    );
  }

  await fastify.register(fastifyStatic, {
    root: staticRoot,
    prefix: '/',
    decorateReply: false,
    setHeaders: (res, filePath) => {
      if (filePath.includes('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });

  // 图片静态目录：内网共享图片，独立于前端构建，生产可挂载网络驱动器
  const imagesDir = process.env.IMAGES_DIR || path.join(__dirname, '..', 'public', 'images');
  try {
    await fsp.mkdir(imagesDir, { recursive: true });
  } catch {}
  await fastify.register(fastifyStatic, {
    root: imagesDir,
    prefix: '/images/',
    decorateReply: false,
    setHeaders: () => {
      // 图片可浏览器缓存 1 小时
      return { 'Cache-Control': 'public, max-age=3600' };
    },
  });
  fastify.log.info({ imagesDir }, 'serving images static directory at /images/');

  return fastify;
}

build()
  .then(async (app) => {
    await ensureNavMenuSchema(getPool, app.log);
    await app.listen({ port: PORT, host: '0.0.0.0' });
    app.log.info(`listening on ${PORT}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
