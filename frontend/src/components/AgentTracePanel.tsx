import { useState } from 'react'

export interface AgentToolStep {
  tool: string
  label?: string
  args?: Record<string, unknown>
  resultPreview?: string
  resultFull?: string
  status?: 'ok' | 'error'
}

function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
  } else {
    fallbackCopy(text)
  }
}
function fallbackCopy(text: string) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  document.body.removeChild(ta)
}

/** 构建步骤的完整可复制文本 */
function buildStepCopyText(step: AgentToolStep): string {
  const parts: string[] = [`[${step.label || step.tool}]`]
  const args = step.args || {}
  for (const [k, v] of Object.entries(args)) {
    if (v == null || v === '') continue
    const val = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
    parts.push(`${k}：${val}`)
  }
  if (step.resultFull) {
    parts.push(`\n结果：${step.resultFull}`)
  } else if (step.resultPreview) {
    parts.push(`\n结果：${step.resultPreview}`)
  }
  return parts.join('\n')
}

interface AgentTracePanelProps {
  skillUsed?: string
  toolSteps?: AgentToolStep[]
  degraded?: boolean
  /** 是否为当前轮最新助手消息（默认展开） */
  defaultOpen?: boolean
}

function formatArgValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 118)}…` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    const s = JSON.stringify(v)
    return s.length > 160 ? `${s.slice(0, 158)}…` : s
  } catch {
    return String(v)
  }
}

function formatStepArgs(step: AgentToolStep): string[] {
  const args = step.args || {}
  const lines: string[] = []
  const tool = step.tool

  if (tool === 'knowledge_search' && args.query) {
    lines.push(`问题：${formatArgValue(args.query)}`)
  } else if (tool === 'read_skill_resource') {
    if (args.skill_name) lines.push(`Skill：${formatArgValue(args.skill_name)}`)
    if (args.path) lines.push(`资源：${formatArgValue(args.path)}`)
  } else if (tool === 'lookup_options') {
    if (args.route_key) lines.push(`报表：${formatArgValue(args.route_key)}`)
    if (args.field_name) lines.push(`字段：${formatArgValue(args.field_name)}`)
    if (args.keyword) lines.push(`关键词：${formatArgValue(args.keyword)}`)
  } else if (tool === 'run_report') {
    if (args.route_key) lines.push(`报表：${formatArgValue(args.route_key)}`)
    if (args.params) lines.push(`参数：${formatArgValue(args.params)}`)
  } else if (tool === 'run_sql') {
    if (args.skill_name) lines.push(`Skill：${formatArgValue(args.skill_name)}`)
    if (args.sql_query) lines.push(`sql_query：${formatArgValue(args.sql_query)}`)
  } else if (tool === 'ask_user_to_choose') {
    if (args.field) lines.push(`字段：${formatArgValue(args.field)}`)
    if (args.question) lines.push(`问题：${formatArgValue(args.question)}`)
  } else if (tool === 'save_record') {
    if (args.entity) lines.push(`实体：${formatArgValue(args.entity)}`)
    if (args.payload) lines.push(`内容：${formatArgValue(args.payload)}`)
  } else if (tool === 'generate_document') {
    if (args.title) lines.push(`标题：${formatArgValue(args.title)}`)
    if (args.fmt) lines.push(`格式：${formatArgValue(args.fmt)}`)
  } else {
    for (const [k, v] of Object.entries(args)) {
      if (v != null && v !== '') lines.push(`${k}：${formatArgValue(v)}`)
    }
  }
  return lines
}

export function parseAgentTrace(data: Record<string, unknown>): {
  skillUsed?: string
  toolSteps?: AgentToolStep[]
  degraded?: boolean
} {
  const skillUsed = data.skillUsed ? String(data.skillUsed) : undefined
  const degraded = !!data.degraded
  const raw = data.toolSteps ?? data.toolCalls
  if (!Array.isArray(raw) || raw.length === 0) {
    return { skillUsed, degraded }
  }
  if (typeof raw[0] === 'string') {
    return {
      skillUsed,
      degraded,
      toolSteps: raw.map((name) => ({ tool: String(name), label: String(name) })),
    }
  }
  return { skillUsed, degraded, toolSteps: raw as AgentToolStep[] }
}

function CopyStepBtn({ step }: { step: AgentToolStep }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="shrink-0 text-[10px] text-slate-400 hover:text-sky-600 px-1"
      title="复制完整内容"
      onClick={() => {
        copyToClipboard(buildStepCopyText(step))
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? '✓' : '📋'}
    </button>
  )
}

export default function AgentTracePanel({
  skillUsed,
  toolSteps,
  degraded,
  defaultOpen = false,
}: AgentTracePanelProps) {
  const [open, setOpen] = useState(defaultOpen)
  const steps = toolSteps || []
  const hasSteps = steps.length > 0
  const errorCount = steps.filter((s) => s.status === 'error').length

  if (degraded) {
    return (
      <div className="mt-2 max-w-full w-full rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2 text-[11px] text-amber-800">
        本次为<strong className="font-medium">本地知识问答模式</strong>（未连接 AI Agent），无工具调用记录。
      </div>
    )
  }

  if (!hasSteps && !skillUsed) return null

  const summary = [
    skillUsed ? `Skill: ${skillUsed}` : null,
    hasSteps ? `${steps.length} 步工具调用` : null,
    errorCount > 0 ? `${errorCount} 步失败` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="mt-2 max-w-full w-full rounded-xl border border-slate-200 bg-slate-50/90 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-[11px] text-slate-600 hover:bg-slate-100/80"
      >
        <span className="font-medium text-slate-700">
          <span className="text-sky-600 mr-1">⚙</span>
          执行过程
          {summary ? <span className="font-normal text-slate-500 ml-1.5">({summary})</span> : null}
        </span>
        <span className="text-slate-400 shrink-0">{open ? '收起 ▲' : '展开 ▼'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-slate-200/80">
          {skillUsed && (
            <p className="text-[10px] text-violet-700 pt-2">
              使用 Skill：<span className="font-mono font-medium">{skillUsed}</span>
            </p>
          )}
          {errorCount > 0 && (
            <p className="text-[10px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1.5 pt-2">
              以下步骤调用失败（含后端校验/SQL 报错）。展开可查看具体原因，无需查服务器日志。
            </p>
          )}
          {steps.map((step, i) => {
            const argLines = formatStepArgs(step)
            const isErr = step.status === 'error'
            return (
              <div
                key={`${step.tool}-${i}`}
                className={`rounded-lg px-2.5 py-2 border ${
                  isErr ? 'bg-rose-50/80 border-rose-200' : 'bg-white border-slate-100'
                }`}
              >
                <div className="flex items-start justify-between gap-1">
                  <p className={`text-[11px] font-medium ${isErr ? 'text-rose-900' : 'text-slate-800'}`}>
                    {i + 1}. {step.label || step.tool}
                    {isErr && (
                      <span className="ml-1.5 text-[10px] font-normal text-rose-600">失败</span>
                    )}
                    <span className="ml-1.5 font-normal text-slate-400 font-mono text-[10px]">{step.tool}</span>
                  </p>
                  <CopyStepBtn step={step} />
                </div>
                {argLines.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[10px] text-slate-600">
                    {argLines.map((line, j) => (
                      <li key={j} className="break-all">
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
                {step.resultPreview && (
                  <p
                    className={`mt-1.5 text-[10px] rounded px-2 py-1 break-all ${
                      isErr
                        ? 'text-rose-800 bg-rose-100/90 font-medium'
                        : 'text-emerald-700 bg-emerald-50/80'
                    }`}
                  >
                    {isErr ? '✕ ' : '→ '}
                    {step.resultPreview}
                  </p>
                )}
              </div>
            )
          })}
          {!hasSteps && skillUsed && (
            <p className="text-[10px] text-slate-500 pt-1">本轮未记录到工具调用（可能为纯文本回复）。</p>
          )}
        </div>
      )}
    </div>
  )
}
