/**
 * 前端 URL 路由的服务端配合：
 *
 * 1. `/api` 前缀：前端统一请求 /api/...，由 Fastify 的 rewriteUrl 去掉前缀后再匹配路由。
 *    机器人回调、ai-agent 回调、App 壳、APK 下载等外部调用方仍用无前缀的旧地址，不受影响。
 * 2. SPA 回退：浏览器直接打开或刷新 /report/xxx、/agents/xxx 这类页面地址时返回 index.html。
 *    页面地址与部分 GET 接口同名（如 /agents、/admin/...），所以只对「浏览器导航」回退：
 *    GET/HEAD、Accept 含 text/html、不以 /api 开头、不是静态资源或文件下载。
 */
const fs = require('fs');

const API_PREFIX = '/api';

/** 不做 SPA 回退的路径前缀：静态资源、文件下载、图片、机器人回调等 */
const NON_SPA_PREFIXES = ['/api/', '/assets/', '/js/', '/images/', '/files/', '/download/', '/bot/', '/health'];

function stripApiPrefix(url) {
  if (url === API_PREFIX) return '/';
  if (url.startsWith(`${API_PREFIX}/`) || url.startsWith(`${API_PREFIX}?`)) {
    const rest = url.slice(API_PREFIX.length);
    return rest.startsWith('?') ? `/${rest}` : rest;
  }
  return url;
}

function isSpaNavigation({ method, url, accept }) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (!accept || !String(accept).includes('text/html')) return false;
  const pathname = String(url || '/').split('?')[0];
  if (pathname === '/' || pathname === API_PREFIX) return false;
  if (NON_SPA_PREFIXES.some((p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p))) return false;
  // 带扩展名的视为文件（favicon.svg、manifest.json 等），交给静态插件
  if (/\.[A-Za-z0-9]{1,8}$/.test(pathname)) return false;
  return true;
}

/** 注册 SPA 回退钩子；indexPath 不存在时（未构建）不回退，保持 404 */
function registerSpaFallback(fastify, { indexPath }) {
  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.originalUrl || request.raw.url;
    if (!isSpaNavigation({ method: request.method, url, accept: request.headers.accept })) return;
    let html;
    try {
      html = await fs.promises.readFile(indexPath, 'utf8');
    } catch {
      return;
    }
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html);
  });
}

module.exports = { stripApiPrefix, isSpaNavigation, registerSpaFallback, API_PREFIX };
