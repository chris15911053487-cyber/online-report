import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { apiFetch } from '../utils/api'
import { Input } from '../ui'
import { cn } from '../ui/classes'

interface OusrUser {
  userCode: string
  displayName: string
}

/** 按编码 / 姓名搜索 OUSR 用户（管理员接口），返回前 50 条 */
async function searchUsers(q: string): Promise<OusrUser[]> {
  const data = await apiFetch(`/admin/users/search?q=${encodeURIComponent(q)}`)
  return Array.isArray(data?.items) ? data.items : []
}

/**
 * 多选系统用户（OUSR.USER_CODE）：输入编码或姓名搜索 → 点选加入；已选的以标签显示，点 × 移除。
 * 值仍是用户编码数组，和原来逗号分隔的输入框存的内容一致。
 */
export default function UserPicker({ value, onChange, placeholder = '输入编码或姓名搜索' }: { value: string[]; onChange: (next: string[]) => void; placeholder?: string }) {
  const [names, setNames] = useState<Record<string, string>>({})
  const [q, setQ] = useState('')
  const [results, setResults] = useState<OusrUser[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const resolved = useRef(new Set<string>())

  const remember = (users: OusrUser[]) => {
    if (users.length === 0) return
    setNames((m) => ({ ...m, ...Object.fromEntries(users.map((u) => [u.userCode, u.displayName])) }))
  }

  // 已选但不知道姓名的编码（编辑已有任务时），按编码查一次补上姓名
  useEffect(() => {
    const todo = value.filter((c) => !resolved.current.has(c)).slice(0, 20)
    if (todo.length === 0) return
    todo.forEach((c) => resolved.current.add(c))
    void Promise.all(todo.map((c) => searchUsers(c).then((list) => list.filter((u) => u.userCode === c)).catch(() => [])))
      .then((lists) => remember(lists.flat()))
  }, [value])

  // 输入停顿 250ms 再搜
  useEffect(() => {
    const term = q.trim()
    if (!term) return
    let cancelled = false
    const t = setTimeout(() => {
      setLoading(true)
      searchUsers(term)
        .then((list) => {
          if (cancelled) return
          setResults(list)
          setActive(0)
          remember(list)
        })
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setLoading(false))
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [q])

  const add = (code: string) => {
    if (!value.includes(code)) onChange([...value, code])
    setQ('')
    setResults([])
  }
  const remove = (code: string) => onChange(value.filter((c) => c !== code))
  const shown = q.trim() ? results : []

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((code) => (
            <span key={code} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full border border-primary/60 bg-primary-soft text-primary text-[12px]">
              {names[code] && names[code] !== code ? `${names[code]}（${code}）` : code}
              <button type="button" aria-label={`移除 ${code}`} className="p-0.5 rounded-full hover:bg-primary/10" onClick={() => remove(code)}>
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="w-4 h-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <Input
          className="pl-8"
          value={q}
          placeholder={placeholder}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(i + 1, shown.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (shown[active]) add(shown[active].userCode)
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
        {open && q.trim() && (
          <div className="absolute z-20 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-surface shadow-lg py-1">
            {loading && shown.length === 0 && <div className="px-3 py-2 text-xs text-subtle">搜索中…</div>}
            {!loading && shown.length === 0 && <div className="px-3 py-2 text-xs text-subtle">没有匹配的用户</div>}
            {shown.map((u, i) => {
              const picked = value.includes(u.userCode)
              return (
                <button
                  key={u.userCode}
                  type="button"
                  // mousedown 先于输入框 blur，阻止默认行为才能点中
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(u.userCode)}
                  onMouseEnter={() => setActive(i)}
                  className={cn('w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left text-sm', i === active ? 'bg-surface-2' : '')}
                >
                  <span className="text-fg">{u.displayName}</span>
                  <span className="text-xs text-subtle font-mono">{picked ? '已选 · ' : ''}{u.userCode}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
