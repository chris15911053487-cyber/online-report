require('dotenv').config();

const path = require('path');
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const jwt = require('@fastify/jwt');
const fastifyStatic = require('@fastify/static');
const authRoutes = require('./routes/auth');
const ordersRoutes = require('./routes/orders');
const menusRoutes = require('./routes/menus');
const reportsRoutes = require('./routes/reports');
const registerOworRoutes = require('./routes/owor');
const { getPool } = require('./db');
const ensureNavMenuSchema = require('./ensure-nav-menu-schema');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

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
  registerOworRoutes(fastify);

  fastify.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

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
