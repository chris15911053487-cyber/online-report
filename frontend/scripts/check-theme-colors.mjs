#!/usr/bin/env node
/**
 * 「只用变量、不写死颜色」检查：扫描 src 下的 .ts/.tsx，发现以下写法即报错退出：
 *   - 十六进制色值（#fff、#1677ff）
 *   - rgb()/rgba()/hsl() 字面量（纯黑阴影 rgba(0,0,0,x) 除外；rgb(var(--c-x)) 是变量写法，允许）
 *   - Tailwind 原始调色板类名（bg-slate-100、text-sky-600 …；tailwind.config.js 已不生成，写了也无效）
 *   - 内联命名色（color: 'red' 等）
 * 主题定义目录 src/theme/ 不检查。用法：npm run lint:colors
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')
const SKIP_DIRS = new Set(['theme'])

const PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const RULES = [
  { name: '十六进制色值', re: /(?<![\w&])#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?(?![\w-])/g },
  { name: '颜色函数字面量', re: /\b(?:rgba?|hsla?)\(\s*(?!var\()(?!0\s*,\s*0\s*,\s*0\s*[,)])(?!0 0 0\b)[^)]*\)/g },
  { name: 'Tailwind 原始调色板类名', re: new RegExp(`(?<![\\w-])(?:[a-z-]+:)*(?:bg|text|border(?:-[trblxy])?|ring|divide|from|via|to|fill|stroke|outline|placeholder|shadow|decoration|caret|accent)-(?:${PALETTE})-\\d{2,3}\\b`, 'g') },
  { name: '内联命名色', re: /\b(?:color|background|backgroundColor|borderColor|fill|stroke)\s*:\s*['"](?:red|green|blue|orange|gray|grey|white|black|yellow|purple|pink)['"]/g },
]

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(p)
    } else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      yield p
    }
  }
}

let problems = 0
for (const file of walk(root)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    for (const { name, re } of RULES) {
      for (const m of line.matchAll(re)) {
        problems += 1
        console.log(`${relative(process.cwd(), file)}:${i + 1}  ${name}：${m[0]}`)
      }
    }
  })
}

if (problems > 0) {
  console.error(`\n发现 ${problems} 处写死的颜色。请改用主题语义色（tailwind.config.js / src/theme/themes.css）。`)
  process.exit(1)
}
console.log('颜色检查通过：没有写死的颜色。')
