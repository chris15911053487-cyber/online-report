#!/usr/bin/env node
/**
 * 生成 docs/design/icon-library.html：lucide 全部图标 + 项目在用标记。
 *
 * 数据来源：
 *   - 图标路径 / 标签：lucide-static（版本须与 frontend 的 lucide-react 一致）
 *   - 组件名与别名：frontend/node_modules/lucide-react/dist/esm/lucide-react.mjs
 *   - 分类：https://lucide.dev/api/categories（下载到本地 JSON 后传入）
 *   - 项目在用：扫描 frontend/src 里的 `from 'lucide-react'` 导入
 *
 * 用法（lucide-react 升级后重新生成）：
 *   npm i --prefix /tmp/lucide lucide-static@<lucide-react 版本>
 *   curl -s https://lucide.dev/api/categories -o /tmp/lucide/categories.json
 *   node docs/design/build-icon-library.mjs /tmp/lucide/node_modules/lucide-static /tmp/lucide/categories.json
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const [staticDir, categoriesPath] = process.argv.slice(2)
if (!staticDir || !categoriesPath) {
  console.error('用法：node docs/design/build-icon-library.mjs <lucide-static 目录> <categories.json>')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const reactPkg = join(root, 'frontend/node_modules/lucide-react')
const version = JSON.parse(readFileSync(join(reactPkg, 'package.json'), 'utf8')).version
const staticVersion = JSON.parse(readFileSync(join(staticDir, 'package.json'), 'utf8')).version
if (version !== staticVersion) {
  console.error(`版本不一致：lucide-react ${version}，lucide-static ${staticVersion}`)
  process.exit(1)
}

const nodes = JSON.parse(readFileSync(join(staticDir, 'icon-nodes.json'), 'utf8'))
const tags = JSON.parse(readFileSync(join(staticDir, 'tags.json'), 'utf8'))
const categories = JSON.parse(readFileSync(categoriesPath, 'utf8'))

// 组件名 ⇄ 图标文件
const pascal = (kebab) => kebab.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
const nameToKebab = {}
const aliasesOf = {}
const index = readFileSync(join(reactPkg, 'dist/esm/lucide-react.mjs'), 'utf8')
for (const m of index.matchAll(/export \{ ([^}]+) \} from '\.\/icons\/([a-z0-9-]+)\.mjs';/g)) {
  const kebab = m[2]
  const names = [...m[1].matchAll(/default as (\w+)/g)].map((x) => x[1])
  for (const n of names) nameToKebab[n] = kebab
  aliasesOf[kebab] = names.filter((n) => !n.endsWith('Icon') && !n.startsWith('Lucide') && n !== pascal(kebab))
}

// 项目在用：组件名 → 用到的文件
const usedIn = {}
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.tsx?$/.test(f) && !/\.test\./.test(f)) {
      const src = readFileSync(p, 'utf8')
      for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'lucide-react'/g)) {
        for (const raw of m[1].split(',')) {
          const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]
          const kebab = nameToKebab[name]
          if (!kebab) continue
          ;(usedIn[kebab] ||= new Set()).add(relative(join(root, 'frontend/src'), p))
        }
      }
    }
  }
}
walk(join(root, 'frontend/src'))

const attrs = (a) => Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')
const icons = Object.keys(nodes)
  .sort()
  .map((kebab) => [
    kebab,
    nodes[kebab].map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join(''),
    aliasesOf[kebab] || [],
    tags[kebab] || [],
    categories[kebab] || [],
    [...(usedIn[kebab] || [])].sort(),
  ])

const data = { version, generatedAt: new Date().toISOString().slice(0, 10), icons }
const tpl = readFileSync(join(here, 'icon-library.template.html'), 'utf8')
const out = tpl.replace('/*__DATA__*/null', JSON.stringify(data))
writeFileSync(join(here, 'icon-library.html'), out)
console.log(`icon-library.html：${icons.length} 个图标，项目在用 ${Object.keys(usedIn).length} 个，lucide ${version}`)
