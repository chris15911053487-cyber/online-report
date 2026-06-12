/**
 * Skill 压缩包（zip）解析与校验。
 *
 * 包格式（业界标准 Skill 包）：
 *   SKILL.md      — YAML frontmatter（name/description/produces_document/sort_order）+ Markdown 正文
 *   references/   — 文本资源（Agent 按需读取，渐进式披露）
 *   examples/     — 同上
 *
 * 安全红线：
 * - 仅接受文本资源（.md/.txt/.json/.csv），其余扩展名一律拒绝；
 * - 拒绝路径穿越（..）、绝对路径、嵌套 zip；
 * - zip ≤ 5MB、解压总量 ≤ 10MB、≤ 30 个文件、单文件 ≤ 256KB；
 * - .md 资源套用与 SKILL.md 正文相同的"禁可执行脚本围栏"检查。
 */
const AdmZip = require('adm-zip');
const yaml = require('js-yaml');

const LIMITS = {
  zipBytes: 5 * 1024 * 1024,
  totalBytes: 10 * 1024 * 1024,
  maxFiles: 30,
  fileBytes: 256 * 1024,
};

const TEXT_EXT_RE = /\.(md|txt|json|csv)$/i;
const SCRIPT_FENCE_RE = /```\s*(bash|sh|python|py|powershell|ps1)\b/i;
/** 资源路径：相对路径段，仅常规字符 */
const RESOURCE_PATH_RE = /^[\w][\w.-]*(\/[\w][\w.-]*)*$/;

function fail(error) {
  return { ok: false, error };
}

/** 解析 SKILL.md 的 YAML frontmatter。返回 { meta, body } */
function parseFrontmatter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src.trim() };
  let meta = {};
  try {
    const parsed = yaml.load(m[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
  } catch {
    /* frontmatter 解析失败按无 meta 处理，正文仍可用 */
  }
  return { meta, body: m[2].trim() };
}

/** 规范化 entry 路径；非法返回 null */
function normalizeEntryPath(entryName) {
  const p = String(entryName || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.includes('..')) return null;
  return p;
}

function isJunkPath(p) {
  return (
    p.startsWith('__MACOSX/') ||
    p.split('/').some((seg) => seg === '.DS_Store' || seg.startsWith('._') || seg === 'Thumbs.db')
  );
}

/**
 * 解析 skill zip Buffer。
 * 返回 { ok:true, value:{ name, description, bodyMd, resources, producesDocument, sortOrder } }
 * 或   { ok:false, error }
 * resources 形如 { "references/foo.md": { content, size } }
 */
function parseSkillPackage(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) return fail('未收到 zip 文件内容');
  if (zipBuffer.length > LIMITS.zipBytes) {
    return fail(`zip 文件不能超过 ${Math.floor(LIMITS.zipBytes / 1024 / 1024)}MB`);
  }

  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    return fail('不是合法的 zip 文件');
  }

  // 收集文件 entry（忽略目录与系统垃圾文件）
  let entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => ({ entry: e, path: normalizeEntryPath(e.entryName) }));

  for (const it of entries) {
    if (it.path === null) return fail(`非法路径：${it.entry.entryName}（不允许 .. 或绝对路径）`);
  }
  entries = entries.filter((it) => !isJunkPath(it.path));
  if (entries.length === 0) return fail('zip 内没有文件');
  if (entries.length > LIMITS.maxFiles) return fail(`zip 内文件数不能超过 ${LIMITS.maxFiles} 个`);

  // 支持外层多包一层目录（如 my-skill/SKILL.md）：所有文件共享同一根目录时剥掉
  const firstSeg = entries[0].path.split('/')[0];
  const hasCommonRoot =
    entries.length > 0 &&
    entries.every((it) => it.path === firstSeg || it.path.startsWith(`${firstSeg}/`)) &&
    entries.some((it) => it.path.startsWith(`${firstSeg}/`)) &&
    !entries.some((it) => it.path === firstSeg);
  if (hasCommonRoot) {
    entries = entries.map((it) => ({ ...it, path: it.path.slice(firstSeg.length + 1) }));
  }

  // 解压总量预检（防 zip bomb），用 header 声明的未压缩大小
  let declaredTotal = 0;
  for (const it of entries) {
    declaredTotal += Number(it.entry.header.size) || 0;
  }
  if (declaredTotal > LIMITS.totalBytes) {
    return fail(`解压总量不能超过 ${Math.floor(LIMITS.totalBytes / 1024 / 1024)}MB`);
  }

  const skillEntry = entries.find((it) => it.path.toLowerCase() === 'skill.md');
  if (!skillEntry) return fail('包根目录缺少 SKILL.md');

  const resources = {};
  for (const it of entries) {
    if (it === skillEntry) continue;
    if (!TEXT_EXT_RE.test(it.path)) {
      return fail(`仅支持文本资源（.md/.txt/.json/.csv），不允许：${it.path}`);
    }
    if (!RESOURCE_PATH_RE.test(it.path)) {
      return fail(`资源路径含非法字符：${it.path}`);
    }
    const data = it.entry.getData();
    if (data.length > LIMITS.fileBytes) {
      return fail(`单个资源文件不能超过 ${Math.floor(LIMITS.fileBytes / 1024)}KB：${it.path}`);
    }
    const content = data.toString('utf8');
    if (/\.md$/i.test(it.path) && SCRIPT_FENCE_RE.test(content)) {
      return fail(`出于安全考虑，资源不可包含可执行脚本围栏（bash/python 等）：${it.path}`);
    }
    resources[it.path] = { content, size: data.length };
  }

  const skillData = skillEntry.entry.getData();
  if (skillData.length > LIMITS.fileBytes * 2) {
    return fail(`SKILL.md 不能超过 ${Math.floor((LIMITS.fileBytes * 2) / 1024)}KB`);
  }
  const { meta, body } = parseFrontmatter(skillData.toString('utf8'));
  if (!body) return fail('SKILL.md 正文为空');

  const name = String(meta.name || '').trim().toLowerCase();
  if (!name) return fail('SKILL.md frontmatter 缺少 name（如 ---\\nname: my-skill\\n---）');
  const description = String(meta.description || '').trim();
  if (!description) return fail('SKILL.md frontmatter 缺少 description');

  const producesDocument = meta.produces_document === true || meta.producesDocument === true;
  const sortOrderRaw = meta.sort_order ?? meta.sortOrder;
  const sortOrder = Number.isFinite(Number(sortOrderRaw)) ? Number(sortOrderRaw) : 100;

  return {
    ok: true,
    value: { name, description, bodyMd: body, resources, producesDocument, sortOrder },
  };
}

module.exports = { parseSkillPackage, parseFrontmatter, LIMITS };
