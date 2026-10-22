/**
 * Cron 表达式输入框（预警规则、定时报告共用）：
 * 输入框下方实时显示中文解读 + 接下来 3 次执行时间；「AI 生成」用一句话描述 → 后端 /admin/cron/ai 出表达式。
 */
import { useMemo, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { apiFetch } from '../utils/api'
import { describeCron, nextCronRuns } from '../utils/cron'
import { Button, Input } from '../ui'

const EXAMPLES = ['工作日早上 8 点半', '每 2 小时一次', '每月 1 号上午 9 点', '周一到周六 8 点到 18 点每 10 分钟']

export default function CronField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [aiOpen, setAiOpen] = useState(false)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [aiError, setAiError] = useState('')

  const info = useMemo(() => {
    if (!value.trim()) return null
    const d = describeCron(value)
    return d.ok ? { ok: true as const, text: d.text, next: nextCronRuns(value, 3) } : d
  }, [value])

  const generate = async (instruction = text) => {
    if (!instruction.trim()) return
    setText(instruction)
    setLoading(true)
    setAiError('')
    try {
      const r = (await apiFetch('/admin/cron/ai', { method: 'POST', body: JSON.stringify({ instruction }) })) as { cron_expr: string }
      onChange(r.cron_expr)
      setAiOpen(false)
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'AI 生成失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className="flex gap-2">
        <Input className="font-mono flex-1 min-w-0" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        <Button variant="soft" icon={<Sparkles className="w-4 h-4" />} onClick={() => setAiOpen((v) => !v)}>
          AI 生成
        </Button>
      </div>

      {info && (
        info.ok ? (
          <p className="text-[12px] text-fg-2 mt-1">
            <span className="font-medium">{info.text}</span>
            <span className="text-subtle">
              {info.next.length ? ` · 接下来：${info.next.join('、')}` : ' · 这个时间不会出现，规则永远不会执行'}
            </span>
          </p>
        ) : (
          <p className="text-[12px] text-danger mt-1">表达式有误：{info.error}</p>
        )
      )}

      {aiOpen && (
        <div className="mt-2 rounded-lg border border-line bg-surface-2 p-2 space-y-2">
          <div className="flex gap-2">
            <Input
              autoFocus
              className="flex-1 min-w-0"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void generate() } }}
              placeholder="用一句话说什么时候执行，如：工作日早上 8 点半"
            />
            <Button disabled={loading || !text.trim()} onClick={() => void generate()} icon={loading ? <Loader2 className="w-4 h-4 animate-spin" /> : undefined}>
              生成
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" disabled={loading} onClick={() => void generate(ex)} className="text-[11px] px-2 py-0.5 rounded-full bg-surface text-muted hover:text-fg border border-line">
                {ex}
              </button>
            ))}
          </div>
          {aiError && <p className="text-[12px] text-danger">{aiError}</p>}
        </div>
      )}
    </div>
  )
}
