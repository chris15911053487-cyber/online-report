/**
 * 系统使用说明知识库：加载 Markdown、分块、关键词检索、生成 AI system prompt。
 */
const fs = require('fs');
const path = require('path');

const HELP_DIR = path.join(__dirname, '..', 'help');
const HELP_DOC_VERSION = '2026-05-16';
const TOP_K_CHUNKS = 5;

/** 同义词组 → 检索用 token */
const SYNONYM_GROUPS = {
  password: ['密码', '改密', '修改密码', '新密码', '忘记密码', '重置密码'],
  settings: ['设置', '个人设置'],
  proSign: [
    '报工',
    '生产报工',
    '合并报工',
    '接单',
    '完工',
    '暂停',
    '暂停报工',
    '恢复',
    '恢复报工',
    '待接单',
    '待完工',
    'status',
    '签核',
    '合并',
  ],
  report: ['报表', '查询', '筛选', '扫码', '分析', '动态报表'],
  voice: ['语音', '说话', '按住', '识别', '麦克风'],
  nav: ['菜单', '底部', 'tab', '返回', '首页', '登录', '退出'],
  admin: ['管理员', '菜单设置', '配置', '权限', '角色'],
};

const TAGS_COMMENT_RE = /^<!--\s*tags:\s*([^>]+)\s*-->\s*\n?/i;

let cachedChunks = null;

/**
 * @typedef {{ id: string, file: string, title: string, tags: string[], body: string }} HelpChunk
 */

function parseTagsFromComment(raw) {
  const m = raw.match(TAGS_COMMENT_RE);
  if (!m) return { tags: [], rest: raw };
  const tags = m[1]
    .split(/[,，、]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return { tags, rest: raw.replace(TAGS_COMMENT_RE, '') };
}

/**
 * @returns {HelpChunk[]}
 */
function loadHelpChunks() {
  if (cachedChunks) return cachedChunks;

  if (!fs.existsSync(HELP_DIR)) {
    cachedChunks = [];
    return cachedChunks;
  }

  const files = fs
    .readdirSync(HELP_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();

  const chunks = [];

  for (const file of files) {
    const fullPath = path.join(HELP_DIR, file);
    let raw = fs.readFileSync(fullPath, 'utf8');
    const fileTags = parseTagsFromComment(raw);
    raw = fileTags.rest;

    const fileBase = file.replace(/\.md$/i, '');
    const sections = raw.split(/^## /m);

    if (sections.length <= 1) {
      const titleMatch = raw.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : fileBase;
      chunks.push({
        id: `${fileBase}:0`,
        file,
        title,
        tags: [...fileTags.tags],
        body: raw.trim(),
      });
      continue;
    }

    const preamble = sections[0].trim();
    for (let i = 1; i < sections.length; i++) {
      const part = sections[i].trim();
      if (!part) continue;
      const nl = part.indexOf('\n');
      const title = nl >= 0 ? part.slice(0, nl).trim() : part;
      const body = nl >= 0 ? part.slice(nl + 1).trim() : '';
      const sectionTags = parseTagsFromComment(body);
      chunks.push({
        id: `${fileBase}:${i}`,
        file,
        title,
        tags: [...fileTags.tags, ...sectionTags.tags],
        body: (preamble ? `（所属：${fileBase}）\n` : '') + title + '\n' + sectionTags.rest.trim(),
      });
    }
  }

  cachedChunks = chunks;
  return cachedChunks;
}

/**
 * 从用户问题提取检索 token（同义词组 + 原文子串）
 * @param {string} query
 * @returns {Set<string>}
 */
function extractQueryTokens(query) {
  const q = String(query || '').toLowerCase();
  const tokens = new Set();

  for (const [group, words] of Object.entries(SYNONYM_GROUPS)) {
    if (words.some((w) => q.includes(w.toLowerCase()))) {
      tokens.add(group);
      for (const w of words) {
        if (q.includes(w.toLowerCase())) tokens.add(w.toLowerCase());
      }
    }
  }

  for (let len = 2; len <= 4; len++) {
    for (let i = 0; i <= q.length - len; i++) {
      const sub = q.slice(i, i + len);
      if (/[\u4e00-\u9fff]/.test(sub)) tokens.add(sub);
    }
  }

  return tokens;
}

/**
 * @param {HelpChunk} chunk
 * @param {Set<string>} tokens
 */
function scoreChunk(chunk, tokens) {
  let score = 0;
  const titleLower = chunk.title.toLowerCase();
  const bodyLower = chunk.body.toLowerCase();
  const tagSet = new Set(chunk.tags.map((t) => t.toLowerCase()));

  for (const t of tokens) {
    const tl = t.toLowerCase();
    if (tagSet.has(tl)) score += 4;
    if (titleLower.includes(tl)) score += 3;
    if (bodyLower.includes(tl)) score += 1;
  }

  return score;
}

/**
 * @param {string} query
 * @param {number} [topK]
 * @returns {HelpChunk[]}
 */
function retrieveRelevantChunks(query, topK = TOP_K_CHUNKS) {
  const chunks = loadHelpChunks();
  if (!chunks.length) return [];

  const tokens = extractQueryTokens(query);
  if (tokens.size === 0) {
    return chunks.slice(0, topK);
  }

  const scored = chunks
    .map((c) => ({ chunk: c, score: scoreChunk(c, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return chunks.slice(0, topK);
  }

  return scored.slice(0, topK).map((x) => x.chunk);
}

/**
 * @param {string} userQuery
 * @param {string} [userRole]
 */
function buildHelpSystemPrompt(userQuery, userRole = 'operator') {
  const relevant = retrieveRelevantChunks(userQuery, TOP_K_CHUNKS);
  const roleHint =
    userRole === 'admin'
      ? '当前用户是管理员，可说明菜单设置等管理功能。'
      : '当前用户是操作员，不要引导其使用「菜单设置」等仅管理员功能，可说明联系管理员。';

  const excerpts =
    relevant.length > 0
      ? relevant
          .map(
            (c, i) =>
              `### 片段 ${i + 1}：${c.title}\n${c.body.slice(0, 2200)}`
          )
          .join('\n\n')
      : '（知识库暂无匹配片段，请谨慎回答并建议联系管理员。）';

  return `你是「在线报工与生产报表」系统中的 **使用说明助手**。${roleHint}

【回答规则 — 必须遵守】
1. 只根据下方【使用说明摘录】回答「如何操作」「流程是什么」类问题；不要编造菜单名、按钮、Status 取值。
2. 操作类回答使用「步骤 1、2、3…」，并写明界面入口（如：底部「设置」、底部「菜单」）。
3. 生产报工必须遵守 Status 固定映射：code **0=接单**，**1=完工**（含暂停报工副按钮），**2=已完工**（列表筛选已完工单据），**8=恢复报工**；暂停后必须用 code 8 恢复，不能只用待完工重复暂停。
4. 摘录中未涉及的问题，明确说「当前说明书中暂无该内容，请联系管理员或查看实际界面」，不要猜测。
5. 用清晰的中文，适度分段；不要用整篇 markdown 代码块包裹回答。
6. 说明版本：${HELP_DOC_VERSION}。

【使用说明摘录】
${excerpts}`;
}

/** 快捷问题（前端展示） */
const QUICK_TOPICS = [
  {
    id: 'password',
    question: '如何修改密码？',
    keywords: ['密码', '改密'],
  },
  {
    id: 'pro-sign-receive',
    question: '生产报工怎么接单？',
    keywords: ['接单', '待接单', '报工'],
  },
  {
    id: 'pro-sign-complete',
    question: '待完工怎么报工、怎么暂停？',
    keywords: ['完工', '暂停'],
  },
  {
    id: 'pro-sign-resume',
    question: '暂停报工之后怎么操作？',
    keywords: ['暂停', '恢复'],
  },
  {
    id: 'status-codes',
    question: 'Status 0、1、8 分别是什么意思？',
    keywords: ['status', '0', '1', '8'],
  },
  {
    id: 'overview',
    question: '系统底部几个 Tab 是做什么的？',
    keywords: ['菜单', '设置', 'AI'],
  },
];

/**
 * 根据用户问题推荐界面跳转（前端执行）
 * @param {string} query
 * @returns {Array<{ type: string, label: string, view?: string, openProSign?: boolean }>}
 */
function suggestNavActions(query) {
  const q = String(query || '').toLowerCase();
  const actions = [];

  if (/密码|改密|设置/.test(q) && !/菜单设置|管理员/.test(q)) {
    actions.push({ type: 'navigate', view: 'settings', label: '打开设置' });
  }

  if (/报工|接单|完工|暂停|恢复|待接单|待完工|pro.?sign|合并报工/.test(q)) {
    actions.push({ type: 'openCatalog', label: '打开菜单' });
    actions.push({ type: 'openProSign', label: '进入生产报工' });
  }

  if (/报表|筛选|查询/.test(q) && !/报工/.test(q)) {
    actions.push({ type: 'openCatalog', label: '打开菜单' });
  }

  if (/语音|说话|按住/.test(q)) {
    actions.push({ type: 'openCatalog', label: '打开菜单（语音可控制导航）' });
  }

  const seen = new Set();
  return actions.filter((a) => {
    const key = a.type + (a.view || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getHelpBootstrap(userRole = 'operator') {
  return {
    version: HELP_DOC_VERSION,
    topics: QUICK_TOPICS,
    chunkCount: loadHelpChunks().length,
    role: userRole,
  };
}

/** 测试/热更新：清空缓存 */
function clearHelpCache() {
  cachedChunks = null;
}

module.exports = {
  loadHelpChunks,
  retrieveRelevantChunks,
  buildHelpSystemPrompt,
  suggestNavActions,
  getHelpBootstrap,
  clearHelpCache,
  HELP_DOC_VERSION,
  QUICK_TOPICS,
};
