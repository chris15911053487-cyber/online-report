/**
 * 一句话设预警：说一句「什么情况提醒我」→ AI 从查询库选命名查询、写判断条件 / 频率 / 卡片模板 →
 * 按当前数据试算 → 「采用」后填进规则表单，由人补推送对象再保存。这里不保存任何东西。
 */
import { useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { Button, Code, Field, Modal, Notice, Textarea } from '../../ui'
import BiCheckPreview, { type BiCheckPreviewData } from './BiCheckPreview'

export interface AlertDraft {
  rule: {
    name: string
    description: string
    cron_expr: string
    key_column: string
    cooldown_minutes: number
    card_title_template: string
    card_body_template: string
    bi_check: Record<string, unknown>
  }
  summary: string
  notes: string
  preview: BiCheckPreviewData
  attempts: number
}

const EXAMPLES = [
  '本月有客户销售额比上月下降超过 30% 时，每天早上 9 点提醒',
  '今年任何一个月净销售额低于 50 万，每周一 8 点提醒',
  '本月客户销售额前 10 名里有人低于 1 万时提醒',
]

export default function AlertAiModal({ open, onClose, onAccept }: { open: boolean; onClose: () => void; onAccept: (d: AlertDraft) => void }) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<AlertDraft | null>(null)

  const run = async () => {
    setLoading(true)
    setError('')
    setDraft(null)
    try {
      const r = (await apiFetch('/admin/alert-rules/ai/draft', { method: 'POST', body: JSON.stringify({ instruction: text }) })) as { draft: AlertDraft }
      setDraft(r.draft)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 起草失败')
    } finally {
      setLoading(false)
    }
  }

  const r = draft?.rule
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-primary" />
          一句话设预警
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          {draft ? (
            <>
              <Button variant="secondary" onClick={() => void run()} disabled={loading}>
                重新生成
              </Button>
              <Button onClick={() => onAccept(draft)}>采用，补推送对象</Button>
            </>
          ) : (
            <Button
              onClick={() => void run()}
              disabled={loading || text.trim().length < 4}
              icon={loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            >
              {loading ? '选查询、写条件、试算…' : '生成规则'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="什么情况下提醒？" hint="AI 从「BI 看板管理」的查询库里选查询并写判断条件（阈值 / 较上期变化），不写 SQL；只是草稿，推送对象由你选。">
          <Textarea
            rows={2}
            value={text}
            disabled={loading}
            onChange={(e) => setText(e.target.value)}
            placeholder="例如：本月有客户销售额比上月下降超过 30% 时，每天早上 9 点提醒"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim().length >= 4) void run()
            }}
          />
        </Field>
        {!draft && !loading && (
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((x) => (
              <button
                key={x}
                type="button"
                onClick={() => setText(x)}
                className="px-2.5 py-1 rounded-full border border-line text-[12px] text-fg-2 hover:border-primary hover:text-primary transition-colors"
              >
                {x}
              </button>
            ))}
          </div>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        {draft && r && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-fg">{r.name}</span>
              <Code>{r.cron_expr}</Code>
              {draft.attempts > 1 && <span className="text-[12px] text-subtle">AI 自我修正 {draft.attempts - 1} 次</span>}
            </div>
            <p className="text-[13px] text-fg-2">
              <span className="font-medium text-fg">触发条件：</span>
              {draft.summary}
            </p>
            <p className="text-[12.5px] text-muted">
              去重列 {r.key_column || '（无）'} · 同一行 {r.cooldown_minutes} 分钟内不重复提醒
            </p>
            {draft.notes && (
              <Notice tone="warning">
                <p className="font-medium mb-0.5">需要你确认的假设</p>
                <p className="whitespace-pre-wrap">{draft.notes}</p>
              </Notice>
            )}
            <div className="rounded-lg border border-line bg-surface-2 p-3 text-[12.5px]">
              <p className="font-medium text-fg mb-1">{r.card_title_template}</p>
              <p className="whitespace-pre-wrap text-fg-2">{r.card_body_template}</p>
            </div>
            <BiCheckPreview data={draft.preview} />
          </div>
        )}
      </div>
    </Modal>
  )
}
