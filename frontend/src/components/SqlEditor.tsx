/**
 * SQL 编辑框：带边框和工具条（行数、全屏），编辑器本体懒加载；加载完成前先用等宽文本框，照样能输入。
 * 全屏只是把同一个容器铺满窗口（不重新挂载），光标、撤销记录都保留；Esc 退出。
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { IconButton, Textarea } from '../ui'
import { cn } from '../ui/classes'
import type { SqlEditorProps } from './SqlEditorImpl'

const SqlEditorImpl = lazy(() => import('./SqlEditorImpl'))

export default function SqlEditor({ height = '20rem', title = 'SQL', ...props }: SqlEditorProps & { title?: string }) {
  const [full, setFull] = useState(false)

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  const lines = props.value ? props.value.split('\n').length : 0
  const editorHeight = full ? '100%' : height

  return (
    <div className={cn('flex flex-col border border-line rounded-lg overflow-hidden bg-surface focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15', full && 'fixed inset-0 z-[650] rounded-none border-0 ring-0 focus-within:ring-0')}>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line bg-surface-2 text-xs text-muted shrink-0">
        <span className="font-medium text-fg-2">{title}</span>
        <span className="num">{lines} 行</span>
        <span className="hidden sm:inline text-subtle">Ctrl+Space 补全 · Tab 缩进 · Ctrl+Z 撤销</span>
        <span className="flex-1" />
        {full && <span className="text-subtle">Esc 退出全屏</span>}
        <IconButton label={full ? '退出全屏' : '全屏编辑'} className="w-7 h-7" onClick={() => setFull((f) => !f)}>
          {full ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </IconButton>
      </div>
      <div className={cn('min-h-0', full && 'flex-1')}>
        <Suspense
          fallback={
            <Textarea
              mono
              value={props.value}
              onChange={(e) => props.onChange(e.target.value)}
              placeholder={props.placeholder}
              spellCheck={false}
              style={{ height: editorHeight }}
              className="border-0 rounded-none resize-none focus:ring-0"
            />
          }
        >
          <SqlEditorImpl {...props} height={editorHeight} />
        </Suspense>
      </div>
    </div>
  )
}
