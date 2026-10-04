/**
 * 使用说明书：整篇阅读的元信息解析、权限过滤，以及配图都已提交。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { slugOf, parseDoc, listHelpDocs, readHelpDoc, missingHelpImages } = require('../src/help-docs');
const { loadHelpChunks, clearHelpCache } = require('../src/help-knowledge');

test('slug 去掉序号前缀与扩展名', () => {
  assert.equal(slugOf('07-bi-dashboard.md'), 'bi-dashboard')
  assert.equal(slugOf('readme.md'), 'readme')
})

test('解析头部 tags / audience 注释与标题', () => {
  const d = parseDoc('<!-- tags: a,b -->\n<!-- audience: admin -->\n# 标题\n\n正文')
  assert.equal(d.meta.audience, 'admin')
  assert.equal(d.meta.tags, 'a,b')
  assert.equal(d.title, '标题')
  assert.ok(d.body.startsWith('# 标题'))
  assert.equal(d.summary, '正文')
  assert.equal(parseDoc('# T\n\nversion: 1\n\n![图](images/a.png)\n\n入口：**管理后台** → `x`').summary, '入口：管理后台 → x')
})

test('管理员说明只给管理员', () => {
  const all = listHelpDocs({ isAdmin: true }).map((d) => d.slug)
  const user = listHelpDocs({ isAdmin: false }).map((d) => d.slug)
  assert.ok(all.includes('bi-admin') && all.includes('bi-dashboard'))
  assert.ok(user.includes('bi-dashboard'))
  assert.ok(!user.includes('bi-admin'))
  assert.equal(readHelpDoc('bi-admin', { isAdmin: false }), 'forbidden')
  assert.equal(readHelpDoc('nope', { isAdmin: true }), null)
  assert.match(readHelpDoc('bi-admin', { isAdmin: true }).content, /^# BI 看板配置说明/)
})

test('说明书引用的配图都存在', () => {
  assert.deepEqual(missingHelpImages(), [])
})

test('AI 检索片段里配图换成文字，不带 audience 注释', () => {
  clearHelpCache()
  const chunks = loadHelpChunks().filter((c) => c.file.includes('bi-'))
  assert.ok(chunks.length > 0)
  for (const c of chunks) {
    assert.ok(!/!\[/.test(c.body), c.title)
    assert.ok(!/audience:/.test(c.body), c.title)
  }
})
