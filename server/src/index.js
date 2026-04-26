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
const ordersRoutes = require('./routes/orders');
const menusRoutes = require('./routes/menus');
const reportsRoutes = require('./routes/reports');
const proSignRoutes = require('./routes/pro-sign');
const registerOworRoutes = require('./routes/owor');
const aiRoutes = require('./routes/ai');
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
    if (request.user.role !== 'admin') {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
  });

  await fastify.register(authRoutes);
  await fastify.register(ordersRoutes);
  await fastify.register(menusRoutes);
  await fastify.register(reportsRoutes);
  await fastify.register(proSignRoutes);
  await fastify.register(aiRoutes);
  registerOworRoutes(fastify);

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

  // 静态站点：优先 frontend/dist（Vite 构建）；不存在或未构建时回退到 server/public（旧版 SPA）
  const serverDir = path.join(__dirname, '..');
  const repoRoot = path.join(serverDir, '..');
  const frontendDist = path.join(repoRoot, 'frontend', 'dist');
  const publicDir = path.join(serverDir, 'public');
  const frontendIndex = path.join(frontendDist, 'index.html');

  let staticRoot = publicDir;
  try {
    await fsp.access(frontendIndex);
    staticRoot = frontendDist;
    fastify.log.info({ staticRoot: frontendDist }, 'serving Vite frontend from frontend/dist');
  } catch {
    fastify.log.warn(
      { tried: frontendIndex },
      'frontend/dist not found or not built; serving legacy server/public (run: cd frontend && npm run build)',
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
