/**
 * 使用说明书（server/help/*.md）的整篇阅读：列表、读取、图片目录。
 * 与 help-knowledge.js 同一批文件——那边按章节切块给 AI 检索，这里整篇给前端展示。
 *
 * 文件头部可写元信息注释（顺序不限）：
 *   <!-- tags: 看板,BI -->        检索标签（help-knowledge.js 用）
 *   <!-- audience: admin -->      仅管理员可读（不写 = 所有登录用户）
 * slug = 文件名去掉序号前缀与 .md，如 07-bi-dashboard.md → bi-dashboard。
 * 图片放 server/help/images/，Markdown 里写相对路径 ![说明](images/bi/xxx.png)。
 */
const fs = require('fs');
const path = require('path');

const HELP_DIR = path.join(__dirname, '..', 'help');
const HELP_IMAGES_DIR = path.join(HELP_DIR, 'images');

const META_RE = /^<!--\s*(tags|audience)\s*:\s*([^>]*?)\s*-->\s*\n?/i;
const IMAGE_RE = /!\[[^\]]*\]\(\s*(images\/[^)\s]+)\s*\)/g;

function slugOf(file) {
  return file.replace(/\.md$/i, '').replace(/^\d+-/, '');
}

/** 列表里的一句话简介：标题后第一段正文（跳过标题、表格、图片、列表、version 行），去掉 Markdown 标记 */
function summaryOf(body) {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || /^(#|\||!\[|[-*>]|\d+\.|<!--|```|version:)/i.test(line)) continue;
    const text = line.replace(/\*\*|`/g, '').replace(/[：:]$/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    return text.length > 80 ? text.slice(0, 78) + '…' : text;
  }
  return '';
}

/** 去掉头部元信息注释，返回 { meta, body } */
function parseDoc(raw) {
  const meta = {};
  let body = raw;
  let m;
  while ((m = body.match(META_RE))) {
    meta[m[1].toLowerCase()] = m[2].trim();
    body = body.slice(m[0].length);
  }
  const title = (body.match(/^#\s+(.+)$/m) || [])[1]?.trim() || '';
  return { meta, title, summary: summaryOf(body), body: body.trim() + '\n' };
}

function loadDocs() {
  if (!fs.existsSync(HELP_DIR)) return [];
  return fs
    .readdirSync(HELP_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const full = path.join(HELP_DIR, file);
      const { meta, title, summary, body } = parseDoc(fs.readFileSync(full, 'utf8'));
      return {
        slug: slugOf(file),
        file,
        title: title || slugOf(file),
        summary,
        audience: meta.audience === 'admin' ? 'admin' : 'all',
        updatedAt: fs.statSync(full).mtime.toISOString(),
        body,
      };
    });
}

function canRead(doc, isAdmin) {
  return doc.audience !== 'admin' || isAdmin;
}

function listHelpDocs({ isAdmin }) {
  return loadDocs()
    .filter((d) => canRead(d, isAdmin))
    .map(({ slug, title, summary, audience }) => ({ slug, title, summary, audience }));
}

/** @returns {null | 'forbidden' | { slug, title, audience, content }} */
function readHelpDoc(slug, { isAdmin }) {
  const doc = loadDocs().find((d) => d.slug === slug);
  if (!doc) return null;
  if (!canRead(doc, isAdmin)) return 'forbidden';
  return { slug: doc.slug, title: doc.title, audience: doc.audience, content: doc.body };
}

/** 说明书里引用了但不存在的图片（单测用，防止改图后漏提交） */
function missingHelpImages() {
  const missing = [];
  for (const d of loadDocs()) {
    for (const m of d.body.matchAll(IMAGE_RE)) {
      if (!fs.existsSync(path.join(HELP_DIR, m[1]))) missing.push(`${d.file}: ${m[1]}`);
    }
  }
  return missing;
}

module.exports = { HELP_DIR, HELP_IMAGES_DIR, slugOf, parseDoc, listHelpDocs, readHelpDoc, missingHelpImages };
