import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { apiFetch } from '../utils/api'
import type { AgentQuickPrompt } from '../types'
import { Button, Code, Notice, Select, Skeleton } from '../ui'

interface RoleView {
  role: string
  queryKeys: string[]
  catalog: string
  hidden: { title: string; queryKey: string; reason: string }[]
}
interface Preview {
  enabled: boolean
  views: RoleView[]
  samples: { queryKey: string; queryLabel: string; question: string }[]
}

/**
 * Agent 配置页：预览 AI 按各可见角色会看到的命名查询目录（含语义层），提示哪些角色看不到哪些卡片，
 * 并可把查询的示例问法一键加为快捷提问（只改编辑中的表单，保存时才落库）。
 */
export default function AgentCatalogPreview({
  dashboardKey,
  roles,
  quickPrompts,
  onAddQuickPrompts,
}: {
  dashboardKey: string
  roles: string[]
  quickPrompts: AgentQuickPrompt[]
  onAddQuickPrompts: (items: AgentQuickPrompt[]) => void
}) {
  const [data, setData] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [role, setRole] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const rolesKey = roles.join(',')

  useEffect(() => {
    let alive = true
    apiFetch('/admin/agents/catalog-preview', {
      method: 'POST',
      body: JSON.stringify({ dashboardKey, roles: rolesKey ? rolesKey.split(',') : [] }),
    })
      .then((d: Preview) => {
        if (!alive) return
        setError('')
        setData(d)
        setRole((cur) => (d.views.some((v) => v.role === cur) ? cur : d.views[0]?.role || ''))
      })
      .catch((e) => alive && (setData(null), setError(e instanceof Error ? e.message : '预览失败')))
    return () => {
      alive = false
    }
  }, [dashboardKey, rolesKey])

  if (error) return <Notice tone="danger">{error}</Notice>
  if (!data) return <Skeleton className="h-24" />

  const view = data.views.find((v) => v.role === role) || data.views[0]
  const existing = new Set(quickPrompts.map((q) => q.prompt.trim()))
  const fresh = data.samples.filter((s) => !existing.has(s.question))
  // 看不到的内容相同的角色合并成一行
  const blocked = new Map<string, { roles: string[]; hidden: RoleView['hidden'] }>()
  for (const v of data.views) {
    if (v.hidden.length === 0) continue
    const key = JSON.stringify(v.hidden)
    const g = blocked.get(key)
    if (g) g.roles.push(v.role)
    else blocked.set(key, { roles: [v.role], hidden: v.hidden })
  }

  const addPicked = () => {
    const items = fresh
      .filter((s) => picked.includes(s.question))
      .map((s) => ({ icon: '', label: s.question.slice(0, 64), prompt: s.question }))
    if (items.length === 0) return
    onAddQuickPrompts(items)
    setPicked([])
  }

  return (
    <div className="flex flex-col gap-3">
      {!data.enabled && <Notice tone="warning">看板已停用：Agent 不会带查询目录。</Notice>}
      {blocked.size > 0 && (
        <Notice tone="warning">
          {[...blocked.values()].map((g) => (
            <div key={g.roles.join(',')} className="mb-1">
              角色 <b>{g.roles.join('、')}</b> 看不到 {g.hidden.length} 处：
              {g.hidden.map((h) => `${h.title}（${h.queryKey}，${h.reason}）`).join('；')}
            </div>
          ))}
          <div className="mt-1 text-xs">到「BI 看板管理 → 查询」给这些查询加上角色，或调整 Agent 可见角色。</div>
        </Notice>
      )}

      {data.views.length > 1 && (
        <Select className="w-56" value={view?.role || ''} onChange={(e) => setRole(e.target.value)}>
          {data.views.map((v) => (
            <option key={v.role} value={v.role}>
              以角色 {v.role} 预览（{v.queryKeys.length} 个查询）
            </option>
          ))}
        </Select>
      )}
      {view && (
        <div>
          <div className="text-xs text-muted mb-1.5">
            {view.role === 'admin' ? '仅管理员可见时' : `角色 ${view.role} 的用户`}，AI 会看到 {view.queryKeys.length} 个查询：
          </div>
          {view.catalog ? (
            <pre className="text-xs leading-relaxed whitespace-pre-wrap bg-surface-2 border border-line rounded-lg p-3 max-h-72 overflow-auto">{view.catalog}</pre>
          ) : (
            <p className="text-xs text-subtle">（空：该角色在这块看板上没有可用查询）</p>
          )}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[13px] font-medium text-fg-2">示例问法 → 快捷提问</span>
          <Button size="sm" variant="ghost" icon={<Plus className="w-3.5 h-3.5" />} disabled={picked.length === 0} onClick={addPicked}>
            加入快捷提问{picked.length > 0 ? `（${picked.length}）` : ''}
          </Button>
        </div>
        {data.samples.length === 0 ? (
          <p className="text-xs text-subtle">查询库里还没填示例问法（查询编辑器里可「AI 补全语义」）。</p>
        ) : fresh.length === 0 ? (
          <p className="text-xs text-subtle">示例问法都已在快捷提问里。</p>
        ) : (
          <div className="flex flex-col gap-1">
            {fresh.map((s) => (
              <label key={s.question} className="flex items-center gap-2 text-[13px] cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-[rgb(var(--c-primary))]"
                  checked={picked.includes(s.question)}
                  onChange={() =>
                    setPicked((cur) => (cur.includes(s.question) ? cur.filter((x) => x !== s.question) : [...cur, s.question]))
                  }
                />
                <span className="flex-1 min-w-0 truncate">{s.question}</span>
                <Code>{s.queryKey}</Code>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
