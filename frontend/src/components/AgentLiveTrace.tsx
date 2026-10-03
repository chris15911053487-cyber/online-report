import { useEffect, useState } from 'react'
import { formatDuration, type LiveState, type LiveStep } from '../utils/agentStream'
import { formatStepArgs } from '../utils/agentTraceFormat'

/** 每 200ms 刷新一次「现在」，仅在 active 时运行，用于显示运行中步骤的已用时 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(t)
  }, [active])
  return now
}

function StepIcon({ status }: { status: LiveStep['status'] }) {
  if (status === 'run') {
    return (
      <span
        className="inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-300 border-t-sky-500 animate-spin shrink-0"
        aria-label="执行中"
      />
    )
  }
  const cfg =
    status === 'ok'
      ? { ch: '✓', cls: 'bg-emerald-100 text-emerald-600', label: '完成' }
      : status === 'waiting'
        ? { ch: '⏸', cls: 'bg-amber-100 text-amber-600', label: '等待确认' }
        : { ch: '!', cls: 'bg-rose-100 text-rose-600', label: '失败' }
  return (
    <span
      className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[9px] font-bold shrink-0 ${cfg.cls}`}
      aria-label={cfg.label}
    >
      {cfg.ch}
    </span>
  )
}

/** 一行摘要：工具取首个关键参数（SQL 等），模型调用取 token 用量 */
function stepHint(step: LiveStep): string {
  if (step.kind === 'llm') {
    const parts: string[] = []
    if (step.inputTokens != null) parts.push(`输入 ${step.inputTokens} tokens`)
    if (step.outputTokens != null) parts.push(`输出 ${step.outputTokens}`)
    return parts.join(' · ')
  }
  const lines = formatStepArgs({ tool: step.tool || '', args: step.args })
  const first = lines[0] || ''
  const text = first.replace(/^[^：]*：/, '')
  return text.length > 60 ? `${text.slice(0, 58)}…` : text
}

function StepRow({ step, now }: { step: LiveStep; now: number }) {
  const running = step.status === 'run'
  const elapsed = running ? now - step.startedAt : step.durationMs
  const hint = stepHint(step)
  const argLines = step.kind === 'tool' ? formatStepArgs({ tool: step.tool || '', args: step.args }) : []
  const hasDetail = argLines.length > 0 || !!step.preview
  const isErr = step.status === 'error'
  const tone = step.kind === 'llm' ? 'text-slate-500' : isErr ? 'text-rose-800' : 'text-slate-800'

  const head = (
    <>
      <StepIcon status={step.status} />
      <span className={`text-[11px] font-medium shrink-0 ${tone}`}>{step.label}</span>
      {hint ? (
        <span className="text-[10px] text-slate-400 truncate min-w-0 flex-1">{hint}</span>
      ) : (
        <span className="flex-1" />
      )}
      {step.status === 'waiting' && <span className="text-[10px] text-amber-600 shrink-0">等待确认</span>}
      {elapsed != null && (
        <span className={`text-[10px] tabular-nums shrink-0 ${running ? 'text-sky-600' : 'text-slate-500'}`}>
          {formatDuration(elapsed)}
        </span>
      )}
    </>
  )

  const box = `rounded-lg border ${isErr ? 'bg-rose-50/80 border-rose-200' : 'bg-white border-slate-100'}`
  if (!hasDetail) {
    return <div className={`${box} flex items-center gap-2 px-2.5 py-1.5`}>{head}</div>
  }
  return (
    <details className={box}>
      <summary className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        {head}
      </summary>
      <div className="px-2.5 pb-2 pt-1 border-t border-slate-100 space-y-1">
        {argLines.map((line, i) => (
          <p key={i} className="text-[10px] text-slate-600 break-all">
            {line}
          </p>
        ))}
        {step.preview && (
          <p
            className={`text-[10px] rounded px-2 py-1 break-all ${
              isErr ? 'text-rose-800 bg-rose-100/90 font-medium' : 'text-emerald-700 bg-emerald-50/80'
            }`}
          >
            {isErr ? '✕ ' : '→ '}
            {step.preview}
          </p>
        )}
      </div>
    </details>
  )
}

interface AgentLiveTraceProps {
  live: LiveState
  /** 是否仍在运行（控制计时器与转圈） */
  running?: boolean
}

/**
 * 实时执行过程：每次模型调用、每个工具调用一行，运行中转圈并显示已用时，完成后显示耗时。
 * 并行的工具会同时处于运行状态。
 */
export default function AgentLiveTrace({ live, running = true }: AgentLiveTraceProps) {
  const now = useNow(running)
  const total = now - live.startedAt
  return (
    <div
      className="max-w-full w-full rounded-xl border border-slate-200 bg-slate-50/90 overflow-hidden"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-slate-700">
        <span className="font-medium">
          <span className="text-sky-600 mr-1">⚙</span>
          {running ? '正在执行' : '执行过程'}
        </span>
        <span className="tabular-nums text-slate-500">已用时 {formatDuration(Math.max(0, total))}</span>
      </div>
      <div className="px-3 pb-3 space-y-1.5 border-t border-slate-200/80 pt-2">
        {live.steps.length === 0 && (
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <StepIcon status="run" />
            正在连接并准备…
          </div>
        )}
        {live.steps.map((step) => (
          <StepRow key={step.id} step={step} now={now} />
        ))}
      </div>
    </div>
  )
}

/** 窄栏用的单行进度：当前运行中的步骤（并行时显示数量）+ 已用时 */
export function AgentLiveStatus({ live }: { live: LiveState | null }) {
  const now = useNow(true)
  const start = live?.startedAt ?? now
  const running = live?.steps.filter((x) => x.status === 'run') ?? []
  const current = running[running.length - 1]
  const text = !current
    ? '正在准备…'
    : running.length > 1
      ? `并行执行 ${running.length} 个步骤…`
      : `${current.label}…`
  return (
    <div className="flex items-center gap-1.5 py-2 text-[13px] text-slate-500" role="status" aria-live="polite">
      <StepIcon status="run" />
      <span className="truncate">{text}</span>
      <span className="tabular-nums text-slate-400 shrink-0">{formatDuration(Math.max(0, now - start))}</span>
    </div>
  )
}
