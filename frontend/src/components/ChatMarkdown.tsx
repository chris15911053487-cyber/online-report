import { useMemo, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { prepareAssistantContent } from '../utils/assistantContent'
import ChartRendererComp from './ChartRenderer'

const lazyChart = ChartRendererComp

const DOC_URL_RE = /\/ai\/agent\/documents\/doc-[0-9a-f]+/

function extractDocPath(href: string): string | null {
  const m = href.match(DOC_URL_RE)
  return m ? m[0] : null
}

function codeLanguage(className?: string): string {
  const m = /language-([\w-]+)/.exec(className || '')
  return m?.[1] || ''
}

function CodeCopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const doCopy = () => {
    const write = () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(write).catch(() => {
        const ta = document.createElement('textarea')
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.select(); document.execCommand('copy')
        document.body.removeChild(ta); write()
      })
    } else {
      const ta = document.createElement('textarea')
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.select(); document.execCommand('copy')
      document.body.removeChild(ta); write()
    }
  }
  return (
    <button
      type="button"
      onClick={doCopy}
      className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-200 hover:bg-slate-600 opacity-0 group-hover:opacity-100 transition-opacity"
    >
      {copied ? '已复制' : '复制'}
    </button>
  )
}

interface ChatMarkdownProps {
  content: string
  onDocDownload?: (url: string) => void
  charts?: Record<string, unknown>[]
}

export default function ChatMarkdown({ content, onDocDownload, charts }: ChatMarkdownProps) {
  const prepared = useMemo(() => {
    let text = prepareAssistantContent(content)
    // 将 ![图表标题] 或 ![图表标题]() 转为 ![图表标题](chart:N) 以触发 img 组件
    if (charts && charts.length > 0) {
      let idx = 0
      text = text.replace(/!\[([^\]]*)\](?:\(\s*\))?/g, (match, alt) => {
        if (idx < charts.length) return `![${alt}](chart:${idx++})`
        return match
      })
    }
    return text
  }, [content, charts])

  const components: Components = {
    img: ({ src, alt }) => {
      // chart:N 占位符 → 渲染对应图表
      if (src && src.startsWith('chart:') && charts) {
        const ci = parseInt(src.slice(6), 10)
        if (ci >= 0 && ci < charts.length) {
          const ChartRenderer = lazyChart
          return <ChartRenderer option={charts[ci]} />
        }
      }
      return src ? <img src={src} alt={alt || ''} className="max-w-full rounded" /> : <span>{alt ? `[${alt}]` : ''}</span>
    },
    table: ({ children }) => (
      <div className="chat-md-table-wrap">
        <table className="chat-md-table">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="chat-md-thead">{children}</thead>,
    tbody: ({ children }) => <tbody className="chat-md-tbody">{children}</tbody>,
    tr: ({ children }) => <tr className="chat-md-tr">{children}</tr>,
    th: ({ children }) => <th className="chat-md-th">{children}</th>,
    td: ({ children }) => <td className="chat-md-td">{children}</td>,
    p: ({ children }) => <p className="chat-md-p">{children}</p>,
    ul: ({ children }) => <ul className="chat-md-ul">{children}</ul>,
    ol: ({ children }) => <ol className="chat-md-ol">{children}</ol>,
    li: ({ children }) => <li className="chat-md-li">{children}</li>,
    strong: ({ children }) => <strong className="chat-md-strong">{children}</strong>,
    em: ({ children }) => <em className="chat-md-em">{children}</em>,
    del: ({ children }) => <del className="chat-md-del">{children}</del>,
    h1: ({ children }) => <h1 className="chat-md-h1">{children}</h1>,
    h2: ({ children }) => <h2 className="chat-md-h2">{children}</h2>,
    h3: ({ children }) => <h3 className="chat-md-h3">{children}</h3>,
    h4: ({ children }) => <h4 className="chat-md-h4">{children}</h4>,
    hr: () => <hr className="chat-md-hr" />,
    blockquote: ({ children }) => <blockquote className="chat-md-blockquote">{children}</blockquote>,
    input: ({ type, checked, disabled }) => {
      if (type === 'checkbox') {
        return (
          <input
            type="checkbox"
            checked={!!checked}
            disabled={!!disabled}
            readOnly
            className="chat-md-checkbox mr-1.5 align-middle"
          />
        )
      }
      return <input type={type} checked={checked} disabled={disabled} readOnly />
    },
    code: ({ className, children }) => {
      const inline = !className
      const text = String(children).replace(/\n$/, '')
      if (inline) {
        return <code className="chat-md-code-inline">{text}</code>
      }
      const lang = codeLanguage(className)
      return (
        <div className="chat-md-pre-wrap group relative">
          {lang && <div className="chat-md-pre-lang">{lang}</div>}
          <CodeCopyBtn text={text} />
          <pre className="chat-md-pre">
            <code>{text}</code>
          </pre>
        </div>
      )
    },
    a: ({ href, children }) => {
      const docPath = href ? extractDocPath(href) : null
      if (docPath && onDocDownload) {
        return (
          <button
            type="button"
            onClick={() => onDocDownload(docPath)}
            className="chat-md-doc-btn"
          >
            ⬇ {children}
          </button>
        )
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="chat-md-link">
          {children}
        </a>
      )
    },
  }

  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components} urlTransform={(url) => url.startsWith('chart:') ? url : defaultUrlTransform(url)}>
        {prepared}
      </ReactMarkdown>
    </div>
  )
}

/** 正文里没有 markdown 链接、但有裸文档 URL 时，仍显示下载按钮 */
export function bareDocUrls(text: string): string[] {
  const found = text.match(new RegExp(DOC_URL_RE.source, 'g'))
  if (!found) return []
  const hasMarkdownLink = /\]\(\s*\/ai\/agent\/documents\//.test(text)
  if (hasMarkdownLink) return []
  return Array.from(new Set(found))
}
