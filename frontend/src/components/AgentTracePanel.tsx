import { useState } from 'react'
import { describeTimings, formatDuration, parseTimings, type AgentTimings } from '../utils/agentStream'
import { formatStepArgs } from '../utils/agentTraceFormat'
import { copyText } from '../utils/clipboard'

export type { AgentTimings }

export interface AgentToolStep {
  /** tool_call_id */
  id?: string | null
  tool: string
  label?: string
  args?: Record<string, unknown>
  resultPreview?: string
  resultFull?: string
  status?: 'ok' | 'error'
  /** 工具执行耗时（毫秒） */
  durationMs?: number
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
  timings?: AgentTimings
  degraded?: boolean
  /** 是否为当前轮最新助手消息（默认展开） */
  defaultOpen?: boolean
}

export function parseAgentTrace(data: Record<string, unknown>): {
  skillUsed?: string
  toolSteps?: AgentToolStep[]
  timings?: AgentTimings
  degraded?: boolean
} {
  const skillUsed = data.skillUsed ? String(data.skillUsed) : undefined
  const degraded = !!data.degraded
  const timings = parseTimings(data.timings)
  const raw = data.toolSteps ?? data.toolCalls
  if (!Array.isArray(raw) || raw.length === 0) {
    return { skillUsed, degraded, timings }
  }
  if (typeof raw[0] === 'string') {
    return {
      skillUsed,
      degraded,
      timings,
      toolSteps: raw.map((name) => ({ tool: String(name), label: String(name) })),
    }
  }
  return { skillUsed, degraded, timings, toolSteps: raw as AgentToolStep[] }
}

function CopyStepBtn({ step }: { step: AgentToolStep }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="shrink-0 text-[10px] text-subtle hover:text-primary px-1"
      title="复制完整内容"
      onClick={() => {
        copyText(buildStepCopyText(step))
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
  timings,
  degraded,
  defaultOpen = false,
}: AgentTracePanelProps) {
  const [open, setOpen] = useState(defaultOpen)
  const steps = toolSteps || []
  const hasSteps = steps.length > 0
  const errorCount = steps.filter((s) => s.status === 'error').length

  if (degraded) {
    return (
      <div className="mt-2 max-w-full w-full rounded-xl border border-warning/25 bg-warning-soft/80 px-3 py-2 text-[11px] text-warning">
        本次为<strong className="font-medium">本地知识问答模式</strong>（未连接 AI Agent），无工具调用记录。
      </div>
    )
  }

  if (!hasSteps && !skillUsed && !timings) return null

  const summary = [
    skillUsed ? `Skill: ${skillUsed}` : null,
    hasSteps ? `${steps.length} 步工具调用` : null,
    errorCount > 0 ? `${errorCount} 步失败` : null,
    timings ? `耗时 ${formatDuration(timings.totalMs)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="mt-2 max-w-full w-full rounded-xl border border-line bg-surface-2/90 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-[11px] text-fg-2 hover:bg-surface-2/80"
      >
        <span className="font-medium text-fg-2">
          <span className="text-primary mr-1">⚙</span>
          执行过程
          {summary ? <span className="font-normal text-muted ml-1.5">({summary})</span> : null}
        </span>
        <span className="text-subtle shrink-0">{open ? '收起 ▲' : '展开 ▼'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-line/80">
          {timings && (
            <p className="text-[10px] text-fg-2 pt-2" title="模型耗时为各次调用之和；工具/其它为整轮墙钟减去模型耗时">
              ⏱ {describeTimings(timings)}
            </p>
          )}
          {skillUsed && (
            <p className="text-[10px] text-accent pt-2">
              使用 Skill：<span className="font-mono font-medium">{skillUsed}</span>
            </p>
          )}
          {errorCount > 0 && (
            <p className="text-[10px] text-danger bg-danger-soft border border-danger/25 rounded-lg px-2 py-1.5 pt-2">
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
                  isErr ? 'bg-danger-soft/80 border-danger/25' : 'bg-surface border-line'
                }`}
              >
                <div className="flex items-start justify-between gap-1">
                  <p className={`text-[11px] font-medium ${isErr ? 'text-danger' : 'text-fg'}`}>
                    {i + 1}. {step.label || step.tool}
                    {isErr && (
                      <span className="ml-1.5 text-[10px] font-normal text-danger">失败</span>
                    )}
                    <span className="ml-1.5 font-normal text-subtle font-mono text-[10px]">{step.tool}</span>
                    {step.durationMs != null && (
                      <span className="ml-1.5 font-normal text-muted text-[10px]">⏱ {formatDuration(step.durationMs)}</span>
                    )}
                  </p>
                  <CopyStepBtn step={step} />
                </div>
                {argLines.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[10px] text-fg-2">
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
                        ? 'text-danger bg-danger-soft/90 font-medium'
                        : 'text-success bg-success-soft/80'
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
            <p className="text-[10px] text-muted pt-1">本轮未记录到工具调用（可能为纯文本回复）。</p>
          )}
        </div>
      )}
    </div>
  )
}
