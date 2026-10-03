import { useEffect, useState } from 'react'
import { describeTimings, formatDuration, type AgentTimings, type LiveState, type LiveStep } from '../utils/agentStream'
import { copyText } from '../utils/clipboard'
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

/** 参数的完整文本：字符串原样，其它序列化为缩进 JSON（点开后看完整 SQL，不做截断） */
function argEntries(step: LiveStep): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [k, v] of Object.entries(step.args || {})) {
    if (v == null || v === '') continue
    out.push([k, typeof v === 'string' ? v : JSON.stringify(v, null, 2)])
  }
  // SQL 放最前面，最常看
  out.sort((x, y) => Number(y[0] === 'sql_query') - Number(x[0] === 'sql_query'))
  return out
}

/** 结果文本：是 JSON 就缩进展示，便于阅读；复制时仍复制原文 */
function prettyResult(raw: string): string {
  if (raw.length > 20000) return raw
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="shrink-0 text-[10px] text-slate-400 hover:text-sky-600 px-1"
      title="复制"
      onClick={(e) => {
        e.preventDefault()
        copyText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? '✓ 已复制' : '📋 复制'}
    </button>
  )
}

/** 带标题与复制按钮的只读文本块（长内容在块内滚动） */
function TextBlock({ title, text, copyRaw, tone = 'normal' }: {
  title: string
  text: string
  copyRaw?: string
  tone?: 'normal' | 'error' | 'ok'
}) {
  const color =
    tone === 'error'
      ? 'text-rose-800 bg-rose-50 border-rose-200'
      : tone === 'ok'
        ? 'text-emerald-800 bg-emerald-50/70 border-emerald-100'
        : 'text-slate-700 bg-white border-slate-200'
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-slate-500">{title}</span>
        <CopyBtn text={copyRaw ?? text} />
      </div>
      <pre className={`mt-0.5 max-h-56 overflow-auto rounded border px-2 py-1.5 text-[10px] leading-relaxed whitespace-pre-wrap break-all font-mono ${color}`}>
        {text}
      </pre>
    </div>
  )
}

/** 工具调用的详情：完整参数（SQL 等）+ 完整结果 */
function ToolDetail({ step }: { step: LiveStep }) {
  const isErr = step.status === 'error'
  const result = step.resultFull ?? step.preview
  return (
    <div className="space-y-1.5">
      {argEntries(step).map(([k, v]) => (
        <TextBlock key={k} title={k} text={v} />
      ))}
      {result && (
        <TextBlock
          title={step.resultFull ? '结果' : '结果（预览，完成后可看完整内容）'}
          text={step.resultFull ? prettyResult(result) : result}
          copyRaw={result}
          tone={isErr ? 'error' : 'ok'}
        />
      )}
    </div>
  )
}

function StepRow({ step, childSteps, now }: { step: LiveStep; childSteps: LiveStep[]; now: number }) {
  const running = step.status === 'run'
  const elapsed = running ? now - step.startedAt : step.durationMs
  const hint = stepHint(step)
  const isErr = step.status === 'error'
  const tone = step.kind === 'llm' ? 'text-slate-500' : isErr ? 'text-rose-800' : 'text-slate-800'
  const isLlm = step.kind === 'llm'
  const hasDetail = isLlm
    ? !!step.output?.trim() || childSteps.length > 0 || step.inputTokens != null || !!step.preview
    : argEntries(step).length > 0 || !!step.preview || !!step.resultFull

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
      <div className="px-2.5 pb-2 pt-1.5 border-t border-slate-100 space-y-2">
        {isLlm ? (
          <>
            {step.output?.trim() && (
              <TextBlock title={childSteps.length > 0 ? '模型输出（工具调用前的说明）' : '模型输出'} text={step.output} />
            )}
            {childSteps.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] font-medium text-slate-500">决定调用的工具（{childSteps.length}）</div>
                {childSteps.map((c) => (
                  <div key={c.id} className="rounded border border-slate-100 bg-slate-50/70 p-1.5 space-y-1.5">
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-700">
                      <StepIcon status={c.status} />
                      <span className="font-medium">{c.label}</span>
                      {c.durationMs != null && (
                        <span className="ml-auto tabular-nums text-slate-500">{formatDuration(c.durationMs)}</span>
                      )}
                    </div>
                    {argEntries(c).map(([k, v]) => (
                      <TextBlock key={k} title={k} text={v} />
                    ))}
                  </div>
                ))}
              </div>
            )}
            {(step.inputTokens != null || step.outputTokens != null) && (
              <p className="text-[10px] text-slate-500">
                token：输入 {step.inputTokens ?? '?'} · 输出 {step.outputTokens ?? '?'}
              </p>
            )}
            {step.preview && <p className="text-[10px] text-rose-700 break-all">✕ {step.preview}</p>}
          </>
        ) : (
          <ToolDetail step={step} />
        )}
      </div>
    </details>
  )
}

interface AgentLiveTraceProps {
  live: LiveState
  /** 是否仍在运行（控制计时器与转圈）；false = 已结束，保留为可回看的执行记录 */
  running?: boolean
  /** 已结束时显示的总耗时（毫秒）；缺省则按各步骤估算 */
  totalMs?: number
  /** 已结束时在底部显示的耗时拆解 */
  timings?: AgentTimings
  /** 本轮用到的 Skill（显示在标题摘要里） */
  skillUsed?: string
}

/** 没有服务端汇总时的总耗时估算：取各步骤「开始+耗时」的最晚时刻 */
function estimateTotal(live: LiveState): number {
  let end = live.startedAt
  for (const s of live.steps) end = Math.max(end, s.startedAt + (s.durationMs ?? 0))
  return end - live.startedAt
}

/**
 * 执行过程：每次模型调用、每个工具调用一行，运行中转圈并显示已用时，完成后显示耗时。
 * 并行的工具会同时处于运行状态。运行结束后仍保留（running=false），点标题可折叠。
 */
export default function AgentLiveTrace({ live, running = true, totalMs, timings, skillUsed }: AgentLiveTraceProps) {
  const now = useNow(running)
  const [open, setOpen] = useState(true)
  const total = running ? now - live.startedAt : (totalMs ?? estimateTotal(live))
  // 已结束的记录里不应再有「运行中」：被中止/中断的步骤标为已中断，避免转圈不停
  const steps = running
    ? live.steps
    : live.steps.map((s) => (s.status === 'run' ? { ...s, status: 'error' as const, preview: s.preview ?? '已中断' } : s))
  const failed = steps.filter((s) => s.status === 'error').length
  return (
    <div
      className="max-w-full w-full rounded-xl border border-slate-200 bg-slate-50/90 overflow-hidden"
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-[11px] text-slate-700 hover:bg-slate-100/80"
        aria-expanded={open}
      >
        <span className="font-medium">
          <span className="text-sky-600 mr-1">⚙</span>
          {running ? '正在执行' : '执行过程'}
          {!running && (
            <span className="font-normal text-slate-500 ml-1.5">
              ({skillUsed ? `Skill: ${skillUsed} · ` : ''}
              {steps.filter((s) => s.kind === 'tool').length} 步工具调用
              {failed > 0 ? ` · ${failed} 步失败` : ''})
            </span>
          )}
        </span>
        <span className="flex items-center gap-2 shrink-0 tabular-nums text-slate-500">
          {running ? '已用时' : '共'} {formatDuration(Math.max(0, total))}
          <span className="text-slate-400">{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-1.5 border-t border-slate-200/80 pt-2">
          {steps.length === 0 && (
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <StepIcon status="run" />
              正在连接并准备…
            </div>
          )}
          {steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              childSteps={step.kind === 'llm' ? steps.filter((c) => c.parentId === step.id) : []}
              now={now}
            />
          ))}
          {!running && timings && (
            <p
              className="text-[10px] text-slate-600 pt-1"
              title="模型耗时为各次调用之和；工具/其它为整轮墙钟减去模型耗时"
            >
              ⏱ {describeTimings(timings)}
            </p>
          )}
        </div>
      )}
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
