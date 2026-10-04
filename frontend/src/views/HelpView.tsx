/**
 * 使用说明书列表（/help）：server/help/*.md 中当前用户可读的说明书。
 * PC 在左侧菜单「设置」上方进入；手机在「设置」页进入。
 */
import { useEffect, useState } from 'react'
import { BookOpen, ChevronRight, ShieldCheck } from 'lucide-react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { Card, EmptyState, ListRow, Notice, Skeleton } from '../ui'

interface HelpDocMeta {
  slug: string
  title: string
  summary: string
  audience: 'all' | 'admin'
}

export default function HelpView() {
  const openHelpDoc = useStore((s) => s.openHelpDoc)
  const [docs, setDocs] = useState<HelpDocMeta[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    apiFetch('/help/docs')
      .then((r: { docs: HelpDocMeta[] }) => alive && setDocs(r.docs))
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : '加载失败'))
    return () => {
      alive = false
    }
  }, [])

  const groups = docs
    ? [
        { title: '功能说明', items: docs.filter((d) => d.audience !== 'admin') },
        { title: '管理员', items: docs.filter((d) => d.audience === 'admin') },
      ].filter((g) => g.items.length > 0)
    : []

  return (
    <div className="p-4 lg:p-6 max-w-3xl mx-auto flex flex-col gap-4">
      <p className="text-[13px] text-muted px-1">各功能的操作说明。也可以直接在「AI 助手」里提问，AI 会按这些说明回答。</p>
      {error && <Notice tone="danger">{error}</Notice>}
      {!docs && !error && <Skeleton className="h-60" />}
      {docs && docs.length === 0 && <EmptyState icon={<BookOpen className="w-5 h-5" />} title="暂无说明书" />}
      {groups.map((g) => (
        <section key={g.title} className="flex flex-col gap-2">
          <h3 className="text-xs text-muted tracking-wider px-1">{g.title}</h3>
          <Card className="overflow-hidden">
            {g.items.map((d) => (
              <ListRow
                key={d.slug}
                icon={d.audience === 'admin' ? <ShieldCheck className="w-4 h-4" /> : <BookOpen className="w-4 h-4" />}
                title={d.title}
                description={d.summary || undefined}
                trailing={<ChevronRight className="w-4 h-4 text-subtle" />}
                onClick={() => openHelpDoc(d.slug)}
              />
            ))}
          </Card>
        </section>
      ))}
    </div>
  )
}
