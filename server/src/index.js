require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
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
const { getPool } = require('./db');
const ensureNavMenuSchema = require('./ensure-nav-menu-schema');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

/** 登录页「安卓下载」指向的 APK；可用 APK_PATH 覆盖完整路径 */
const ANDROID_APK_PATH =
  process.env.APK_PATH ||
  path.join(process.env.APK_SHARE_ROOT || '/root/apk-share', process.env.APK_FILENAME || '手机报工1.0.apk');

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
      reply.send(err);
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
  registerOworRoutes(fastify);

  fastify.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  fastify.get('/download/android-app.apk', async (request, reply) => {
    try {
      await fsp.access(ANDROID_APK_PATH, fs.constants.R_OK);
    } catch {
      return reply.code(404).type('application/json').send({ error: '安装包暂不可用' });
    }
    const basename = path.basename(ANDROID_APK_PATH);
    const utf8Name = encodeURIComponent(basename);
    return reply
      .header('Content-Type', 'application/vnd.android.package-archive')
      .header(
        'Content-Disposition',
        `attachment; filename="android-app.apk"; filename*=UTF-8''${utf8Name}`,
      )
      .send(fs.createReadStream(ANDROID_APK_PATH));
  });

  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
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
