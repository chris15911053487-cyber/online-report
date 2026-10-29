import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Clock, ExternalLink, MessageSquareText, RotateCcw, UserRoundPlus } from 'lucide-react'
import { useStore } from '../../store'
import { apiFetch } from '../../utils/api'
import { fmtWallClock } from '../../utils/messages'
import { dueLabel, dueTone, snoozeChoices, TASK_EVENT_LABELS, TASK_STATUS_LABELS } from '../../utils/tasks'
import { Badge, Button, EmptyState, Field, Input, Modal, Segmented, Skeleton, Textarea } from '../../ui'
import { cn, inputClass } from '../../ui/classes'
import { DatePicker } from '../../ui/pickers'
import ChatMarkdown from '../ChatMarkdown'
import type { TaskDetail, TaskEvent, TaskItem, TaskListResult } from '../../types'

type Scope = 'mine' | 'team'
type StatusFilter = 'open' | 'snoozed' | 'done'

/** 按钮链接只放行 http(s) 与站内地址 */
const SAFE_LINK = /^(https?:\/\/|\/(?!\/))/i

/** 「消息 → 待办」：我的 / 团队（我是主管的规则），待处理 / 已延后 / 已完成 */
export default function TaskList({ reloadKey }: { reloadKey: number }) {
  const { fetchMessageSummary, showToast, focusTaskId, clearFocusTask } = useStore()
  const [scope, setScope] = useState<Scope>('mine')
  const [status, setStatus] = useState<StatusFilter>('open')
  // 结果带上查询条件：换了页签即显示加载中，不用在 effect 里先清空
  const [loaded, setLoaded] = useState<{ key: string; data: TaskListResult | null; error: string } | null>(null)
  const [tick, setTick] = useState(0)
  const [expanded, setExpanded] = useState<number | null>(focusTaskId)
  // 从钉钉「查看待办」进来：展开那一条（不在当前列表里也能看详情）
  const [prevFocus, setPrevFocus] = useState(focusTaskId)
  if (focusTaskId !== prevFocus) {
    setPrevFocus(focusTaskId)
    if (focusTaskId) setExpanded(focusTaskId)
  }

  const queryKey = `${scope}|${status}`
  useEffect(() => {
    let cancelled = false
    const key = `${scope}|${status}`
    apiFetch(`/tasks?scope=${scope}&status=${status}`)
      .then((r: TaskListResult) => {
        if (!cancelled) setLoaded({ key, data: r, error: '' })
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoaded((prev) => ({ key, data: prev?.key === key ? prev.data : null, error: e instanceof Error ? e.message : '加载失败' }))
      })
    return () => {
      cancelled = true
    }
  }, [scope, status, reloadKey, tick])

  const current = loaded && loaded.key === queryKey ? loaded : null
  const data = current?.data ?? null
  const error = current?.error ?? ''
  const loading = !current
  const load = useCallback(() => setTick((t) => t + 1), [])

  const toggle = (id: number) => {
    setExpanded((cur) => (cur === id ? null : id))
    if (focusTaskId) clearFocusTask()
  }

  const afterAction = async (msg: string) => {
    showToast(msg)
    load()
    await fetchMessageSummary()
  }

  const today = data?.today || ''
  const items = data?.items || []
  const counts = data?.counts
  const focusMissing = expanded != null && !loading && !items.some((t) => t.id === expanded)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {data?.canTeam && (
          <Segmented
            size="sm"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'mine', label: '我的' },
              { value: 'team', label: '团队' },
            ]}
          />
        )}
        <Segmented
          size="sm"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: <>待处理{counts?.open ? <span className="ml-1 num">{counts.open}</span> : null}</> },
            { value: 'snoozed', label: <>已延后{counts?.snoozed ? <span className="ml-1 num">{counts.snoozed}</span> : null}</> },
            { value: 'done', label: '最近完成' },
          ]}
        />
      </div>

      {counts && status === 'open' && (counts.overdue > 0 || (scope === 'team' && counts.unassigned > 0)) && (
        <div className="text-sm text-muted">
          {counts.overdue > 0 && <span className="text-danger font-medium">超期 {counts.overdue} 条</span>}
          {scope === 'team' && counts.unassigned > 0 && <span className="ml-3 text-warning font-medium">未分配负责人 {counts.unassigned} 条</span>}
        </div>
      )}

      {error && <div className="rounded-xl bg-danger-soft text-danger text-sm px-4 py-3">{error}</div>}

      {focusMissing && expanded != null && (
        <div className="rounded-xl bg-surface border border-primary overflow-hidden">
          <TaskDetailPanel id={expanded} today={today} onDone={afterAction} onClose={() => toggle(expanded)} />
        </div>
      )}

      {loading && !data ? (
        <Skeleton className="h-40" />
      ) : items.length === 0 ? (
        <div className="rounded-xl bg-surface border border-line">
          <EmptyState
            title={status === 'open' ? '没有待处理的待办' : status === 'snoozed' ? '没有延后的待办' : '最近 30 天没有完成的待办'}
            description={status === 'open' && scope === 'mine' ? '规则按数据生成待办，每天早上汇总推送给负责人' : undefined}
          />
        </div>
      ) : (
        <div className="rounded-xl bg-surface border border-line overflow-hidden">
          {items.map((t) => (
            <div key={t.id} className="border-t border-line first:border-t-0">
              <TaskRow task={t} today={today} team={scope === 'team'} open={expanded === t.id} onClick={() => toggle(t.id)} />
              {expanded === t.id && <TaskDetailPanel id={t.id} today={today} onDone={afterAction} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TaskRow({ task, today, team, open, onClick }: { task: TaskItem; today: string; team: boolean; open: boolean; onClick: () => void }) {
  const finished = task.status === 'done' || task.status === 'closed'
  const due = finished ? '' : dueLabel(task.dueDate, today)
  return (
    <button
      type="button"
      onClick={onClick}
      data-task-id={task.id}
      className={cn('w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2', open && 'bg-surface-2')}
    >
      {open ? <ChevronDown className="w-4 h-4 mt-0.5 text-subtle shrink-0" /> : <ChevronRight className="w-4 h-4 mt-0.5 text-subtle shrink-0" />}
      <span className="flex-1 min-w-0">
        <span className={cn('block text-sm', finished ? 'text-muted' : 'text-fg font-medium')}>{task.title}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-[11px] text-subtle">
          {due && <Badge tone={dueTone(task.dueDate, today)}>{due}</Badge>}
          {task.status === 'snoozed' && task.snoozeUntil && <Badge tone="info">延后到 {task.snoozeUntil.slice(5)}</Badge>}
          {finished && <Badge tone={task.status === 'done' ? 'success' : 'neutral'}>{TASK_STATUS_LABELS[task.status]}</Badge>}
          {task.reopenCount > 0 && !finished && <Badge tone="warning">重开 {task.reopenCount} 次</Badge>}
          {team && (task.ownerCode ? <span>负责人 {task.ownerCode}</span> : <Badge tone="warning">未分配</Badge>)}
          {task.ruleName && <span className="truncate">{task.ruleName}</span>}
        </span>
      </span>
    </button>
  )
}

type Dialog = 'snooze' | 'transfer' | 'note' | null

/** 展开后的详情：正文、数据、处理记录 + 操作 */
function TaskDetailPanel({ id, today, onDone, onClose }: { id: number; today: string; onDone: (msg: string) => Promise<void>; onClose?: () => void }) {
  const { showToast } = useStore()
  const [detail, setDetail] = useState<{ task: TaskDetail; events: TaskEvent[] } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [showData, setShowData] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch(`/tasks/${id}`)
      .then((r) => {
        if (!cancelled) setDetail(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    if (detail) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [detail])

  const act = async (action: string, body: Record<string, unknown>, msg: string) => {
    setBusy(true)
    try {
      const r = await apiFetch(`/tasks/${id}/${action}`, { method: 'POST', body: JSON.stringify(body) })
      setDetail(r)
      setDialog(null)
      await onDone(msg)
    } catch (e) {
      showToast(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  if (error) return <div className="px-4 py-3 text-sm text-danger">{error}</div>
  if (!detail) return <div className="px-4 py-3"><Skeleton className="h-20" /></div>

  const { task, events } = detail
  const finished = task.status === 'done' || task.status === 'closed'
  const dataKeys = Object.keys(task.data || {})

  return (
    <div ref={ref} className="px-4 pb-4 pt-1 space-y-3 bg-surface-2/50">
      {onClose && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-sm font-medium text-fg">{task.title}</span>
          <Button size="sm" variant="ghost" onClick={onClose}>收起</Button>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>状态：{TASK_STATUS_LABELS[task.status] || task.status}</span>
        <span>负责人：{task.ownerCode || '未分配'}{task.ownerLocked ? '（已转交）' : ''}</span>
        {task.dueDate && <span>到期：{task.dueDate}</span>}
        {task.ruleName && <span>来源：{task.ruleName}</span>}
      </div>
      {task.body && (
        <div className="text-sm text-fg-2">
          <ChatMarkdown content={task.body} raw />
        </div>
      )}
      {task.note && (
        <div className="text-sm rounded-lg bg-surface border border-line px-3 py-2">
          <span className="text-subtle">备注：</span>
          {task.note}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!finished && (
          <Button size="sm" icon={<Check className="w-3.5 h-3.5" />} disabled={busy} onClick={() => void act('done', {}, '已标为已处理')}>
            已处理
          </Button>
        )}
        {!finished && (
          <Button size="sm" variant="secondary" icon={<Clock className="w-3.5 h-3.5" />} disabled={busy} onClick={() => setDialog('snooze')}>
            延后
          </Button>
        )}
        {!finished && (
          <Button size="sm" variant="secondary" icon={<UserRoundPlus className="w-3.5 h-3.5" />} disabled={busy} onClick={() => setDialog('transfer')}>
            转交
          </Button>
        )}
        <Button size="sm" variant="secondary" icon={<MessageSquareText className="w-3.5 h-3.5" />} disabled={busy} onClick={() => setDialog('note')}>
          备注
        </Button>
        {task.status === 'done' && (
          <Button size="sm" variant="secondary" icon={<RotateCcw className="w-3.5 h-3.5" />} disabled={busy} onClick={() => void act('reopen', {}, '已重新打开')}>
            重新打开
          </Button>
        )}
        {task.linkUrl && SAFE_LINK.test(task.linkUrl) && (
          <a
            href={task.linkUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 h-8 px-3 rounded-lg text-sm text-primary hover:bg-primary-soft"
          >
            打开单据
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
      {task.status === 'done' && (
        <p className="text-xs text-subtle">以数据为准：明天同步时数据里还查得到，会自动重新打开；查不到了就关闭。</p>
      )}

      {dataKeys.length > 0 && (
        <div>
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowData((v) => !v)}>
            {showData ? '收起数据明细' : '查看数据明细'}
          </button>
          {showData && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {dataKeys.map((k) => (
                <div key={k} className="contents">
                  <dt className="text-subtle">{k}</dt>
                  <dd className="text-fg-2 break-all">{task.data[k] == null ? '-' : String(task.data[k])}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      {events.length > 0 && (
        <div>
          <div className="text-xs text-subtle mb-1">处理记录</div>
          <ul className="space-y-1 text-xs text-muted">
            {events.map((e) => (
              <li key={e.id} className="flex gap-2">
                <span className="num shrink-0 text-subtle">{fmtWallClock(e.createdAt)}</span>
                <span>
                  {e.userCode || '系统'} {TASK_EVENT_LABELS[e.action] || e.action}
                  {e.detail ? `：${e.detail}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 打开时才挂载：每次打开都是新的输入状态 */}
      {dialog === 'snooze' && <SnoozeDialog today={today} busy={busy} onClose={() => setDialog(null)} onSubmit={(until, note) => void act('snooze', { until, note }, `已延后到 ${until}`)} />}
      {dialog === 'transfer' && <TransferDialog busy={busy} onClose={() => setDialog(null)} onSubmit={(to, note) => void act('transfer', { to, note }, `已转交给 ${to}`)} />}
      {dialog === 'note' && <NoteDialog initial={task.note} busy={busy} onClose={() => setDialog(null)} onSubmit={(note) => void act('note', { note }, '备注已保存')} />}
    </div>
  )
}

function SnoozeDialog({ today, busy, onClose, onSubmit }: { today: string; busy: boolean; onClose: () => void; onSubmit: (until: string, note: string) => void }) {
  const choices = today ? snoozeChoices(today) : []
  const [until, setUntil] = useState(choices[0]?.value || '')
  const [note, setNote] = useState('')
  return (
    <Modal
      open
      onClose={onClose}
      title="延后处理"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button disabled={busy || !until} onClick={() => onSubmit(until, note.trim())}>延后</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {choices.map((c) => (
            <Button key={c.value} size="sm" variant={until === c.value ? 'soft' : 'secondary'} onClick={() => setUntil(c.value)}>
              {c.label}
            </Button>
          ))}
        </div>
        <Field label="延后到" hint="到这一天恢复为待处理，最多 90 天">
          <DatePicker className={inputClass} value={until} min={today ? choices[0]?.value : undefined} clearable={false} title="延后到" onChange={setUntil} />
        </Field>
        <Field label="原因（可选）">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：等物料到货" />
        </Field>
      </div>
    </Modal>
  )
}

function TransferDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (to: string, note: string) => void }) {
  const [q, setQ] = useState('')
  // 结果带上搜索词：输入变了旧结果不再显示
  const [found, setFound] = useState<{ term: string; items: { userCode: string; displayName: string }[] }>({ term: '', items: [] })
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const term = q.trim()
  useEffect(() => {
    if (!term) return
    const timer = setTimeout(() => {
      apiFetch(`/tasks/users?q=${encodeURIComponent(term)}`)
        .then((r) => setFound({ term, items: Array.isArray(r?.items) ? r.items : [] }))
        .catch(() => setFound({ term, items: [] }))
    }, 250)
    return () => clearTimeout(timer)
  }, [term])
  const users = term && found.term === term ? found.items : []
  return (
    <Modal
      open
      onClose={onClose}
      title="转交给"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button disabled={busy || !to} onClick={() => onSubmit(to, note.trim())}>转交{to ? ` ${to}` : ''}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="搜索用户" hint="转交后负责人不再随数据变化，对方会收到通知">
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="用户编码或姓名" />
        </Field>
        {users.length > 0 && (
          <div className="rounded-lg border border-line max-h-48 overflow-y-auto">
            {users.map((u) => (
              <button
                key={u.userCode}
                type="button"
                onClick={() => setTo(u.userCode)}
                className={cn('w-full flex justify-between gap-2 px-3 py-2 text-left text-sm border-t border-line first:border-t-0 hover:bg-surface-2', to === u.userCode && 'bg-primary-soft text-primary')}
              >
                <span>{u.displayName}</span>
                <span className="num text-subtle">{u.userCode}</span>
              </button>
            ))}
          </div>
        )}
        <Field label="说明（可选）">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：这单归二车间" />
        </Field>
      </div>
    </Modal>
  )
}

function NoteDialog({ initial, busy, onClose, onSubmit }: { initial: string; busy: boolean; onClose: () => void; onSubmit: (note: string) => void }) {
  const [note, setNote] = useState(initial || '')
  return (
    <Modal
      open
      onClose={onClose}
      title="备注"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button disabled={busy || !note.trim()} onClick={() => onSubmit(note.trim())}>保存</Button>
        </>
      }
    >
      <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="处理进展、原因等" />
    </Modal>
  )
}
