import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../utils/api'

export interface AgentStatus {
  enabled: boolean
  reachable: boolean
  mode: 'agent' | 'degraded' | 'knowledge_only'
  url?: string
  service?: string | null
  hint?: string
  error?: string
  checkedAt?: string
}

interface AgentStatusBadgeProps {
  /** compact：对话页顶栏细条；card：设置页详情卡片 */
  variant?: 'compact' | 'card'
  /** 管理员可见 Agent URL、错误详情 */
  showAdminDetails?: boolean
}

function statusMeta(status: AgentStatus | null, loading: boolean) {
  if (loading || !status) {
    return {
      dot: 'bg-line-strong animate-pulse',
      label: '检测 Agent 连接…',
      text: 'text-muted',
      bg: 'bg-surface-2',
    }
  }
  if (!status.enabled || status.mode === 'knowledge_only') {
    return {
      dot: 'bg-subtle',
      label: 'Agent 已关闭',
      text: 'text-fg-2',
      bg: 'bg-surface-2',
    }
  }
  if (status.reachable) {
    return {
      dot: 'bg-success',
      label: 'Agent 已连接',
      text: 'text-success',
      bg: 'bg-success-soft/80',
    }
  }
  return {
    dot: 'bg-warning',
    label: 'Agent 未连接',
    text: 'text-warning',
    bg: 'bg-warning-soft/80',
  }
}

export default function AgentStatusBadge({
  variant = 'compact',
  showAdminDetails = false,
}: AgentStatusBadgeProps) {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = (await apiFetch('/ai/agent/status')) as AgentStatus
      setStatus(data)
    } catch {
      setStatus({
        enabled: true,
        reachable: false,
        mode: 'degraded',
        hint: '无法获取 Agent 状态',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const meta = statusMeta(status, loading)

  if (variant === 'card') {
    return (
      <div className="bg-surface rounded-lg shadow p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold text-fg">AI Agent 连接</h2>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="text-xs text-primary disabled:text-subtle"
          >
            {loading ? '检测中…' : '刷新'}
          </button>
        </div>
        <div className={`flex items-start gap-2 rounded-lg px-3 py-2 ${meta.bg}`}>
          <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${meta.dot}`} />
          <div className="min-w-0 flex-1">
            <p className={`text-sm font-medium ${meta.text}`}>{meta.label}</p>
            {status?.hint && <p className="text-xs text-muted mt-0.5">{status.hint}</p>}
            {showAdminDetails && status?.url && (
              <p className="text-[10px] text-subtle mt-1 font-mono break-all">URL: {status.url}</p>
            )}
            {showAdminDetails && status?.error && (
              <p className="text-[10px] text-warning mt-1 break-all">错误: {status.error}</p>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => void refresh()}
      disabled={loading}
      title={status?.hint || meta.label}
      className={`w-full flex items-center justify-center gap-1.5 px-3 py-1 text-[10px] border-b border-line ${meta.bg} ${meta.text} disabled:opacity-70`}
    >
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${meta.dot}`} />
      <span>{meta.label}</span>
      {!loading && status && !status.reachable && status.enabled && (
        <span className="text-warning/80">· 仅知识问答</span>
      )}
    </button>
  )
}
