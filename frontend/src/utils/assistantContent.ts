/**
 * 将 AI 助手原始文本规范为适合 Markdown 渲染的通用格式。
 * 覆盖：纯文本、列表、表格、JSON、键值行等常见输出，而非针对单一业务场景。
 */

function countTableColumns(row: string): number {
  return row.split('|').filter((c) => c.trim().length > 0).length
}

function isTableRow(line: string): boolean {
  return /^\s*\|.+\|\s*$/.test(line)
}

function isTableSeparator(line: string): boolean {
  const cells = line
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-{2,}:?$/.test(c))
}

/** 补全 GFM 表格缺失的分隔行，避免整段以纯文本显示 */
function repairMarkdownTables(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!isTableRow(lines[i])) {
      out.push(lines[i])
      i += 1
      continue
    }
    const block: string[] = []
    while (i < lines.length && isTableRow(lines[i])) {
      block.push(lines[i])
      i += 1
    }
    if (block.length >= 1) {
      if (block.length === 1 || !isTableSeparator(block[1])) {
        const cols = countTableColumns(block[0])
        if (cols > 0) {
          const sep = `| ${Array(cols).fill('---').join(' | ')} |`
          block.splice(1, 0, sep)
        }
      }
    }
    out.push(...block)
  }
  return out.join('\n')
}

/** 连续「标签：值」行转为 Markdown 列表，便于扫读 */
function keyValueLinesToList(text: string): string {
  const lines = text.split('\n')
  const kvRe = /^([^\n：:]{1,32})[：:]\s*(.+)$/
  const result: string[] = []
  let buf: string[] = []

  const flush = () => {
    if (buf.length >= 2) {
      result.push(...buf.map((l) => {
        const m = l.match(kvRe)
        return m ? `- **${m[1].trim()}**：${m[2].trim()}` : l
      }))
    } else {
      result.push(...buf)
    }
    buf = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && kvRe.test(trimmed)) {
      buf.push(trimmed)
    } else {
      flush()
      result.push(line)
    }
  }
  flush()
  return result.join('\n')
}

function tryFormatBareJson(text: string): string | null {
  const t = text.trim()
  if (!/^[\[{]/.test(t) || !/[\]}]$/.test(t)) return null
  try {
    const parsed = JSON.parse(t)
    return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```'
  } catch {
    return null
  }
}

/**
 * 规范化助手消息正文，供 ChatMarkdown 渲染。
 */
export function prepareAssistantContent(raw: string): string {
  let text = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim()

  if (!text) return '（无内容）'

  const asJson = tryFormatBareJson(text)
  if (asJson) return asJson

  // 常见非标准列表符号 → GFM 列表
  text = text.replace(/^[\u2022\u00b7\u30fb●]\s+/gm, '- ')
  // 1) 2) → 1. 2.
  text = text.replace(/^(\d+)\)\s+/gm, '$1. ')

  text = repairMarkdownTables(text)
  text = keyValueLinesToList(text)

  return text
}
