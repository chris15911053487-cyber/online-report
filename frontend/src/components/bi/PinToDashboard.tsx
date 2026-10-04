import { Pin } from 'lucide-react'
import { useStore } from '../../store'
import { isAdminUser } from '../../utils/helpers'
import { pinnableSqls, savePendingPin } from '../../utils/biPin'
import type { AgentToolStep } from '../AgentTracePanel'

/**
 * Agent 回答下方的「📌 收藏到看板」（仅管理员）：把本轮 run_sql 的 SQL 交给 BI 管理页，
 * 新标签页打开，AI 参数化成命名查询并推荐图表，人确认后保存；对话页保持不动。
 */
export default function PinToDashboard({ steps, question }: { steps?: AgentToolStep[]; question: string }) {
  const user = useStore((s) => s.user)
  const sqls = pinnableSqls(steps)
  if (!isAdminUser(user) || sqls.length === 0) return null

  const pin = (sql: string) => {
    savePendingPin(sql, question)
    window.open('/admin/bi', '_blank')
  }

  return (
    <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[12px]">
      {sqls.map((sql, i) => (
        <button
          key={i}
          type="button"
          title={sql.slice(0, 500)}
          onClick={() => pin(sql)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-line text-fg-2 hover:border-primary hover:text-primary transition-colors"
        >
          <Pin className="w-3.5 h-3.5" />
          {sqls.length > 1 ? `收藏第 ${i + 1} 条查询到看板` : '收藏到看板'}
        </button>
      ))}
    </div>
  )
}
