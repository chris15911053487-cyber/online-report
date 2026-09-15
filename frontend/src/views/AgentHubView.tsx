import { useEffect, useState } from 'react'
import {
  Bot,
  TrendingUp,
  BarChart3,
  LineChart,
  PieChart,
  Factory,
  Package,
  ClipboardList,
  BookOpen,
  Sparkles,
  ChevronRight,
} from 'lucide-react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { isAdminUser } from '../utils/helpers'
import type { Agent } from '../types'

/** 配置里存的是 lucide 图标名，这里做白名单映射，未匹配回退 Bot */
const ICONS: Record<string, typeof Bot> = {
  Bot,
  TrendingUp,
  BarChart3,
  LineChart,
  PieChart,
  Factory,
  Package,
  ClipboardList,
  BookOpen,
  Sparkles,
}

function AgentIcon({ name, className }: { name?: string; className?: string }) {
  const Icon = (name && ICONS[name]) || Bot
  return <Icon className={className} />
}

/** 供后台配置界面下拉选择用 */
export const AGENT_ICON_NAMES = Object.keys(ICONS)

export default function AgentHubView() {
  const { openAgent, navigateTo, user } = useStore()
  const isAdmin = isAdminUser(user)
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const data = await apiFetch('/agents')
        if (cancelled) return
        setAgents(Array.isArray(data?.items) ? data.items : [])
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : 'Agent 列表加载失败'
        setError(msg)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const handleOpen = (agent: Agent) => {
    openAgent(agent.agentKey)
  }

  return (
    <div className="p-4">
      <div className="mb-4">
        <h2 className="text-xl font-bold text-slate-900">Agent</h2>
        <p className="text-[13px] text-slate-500 mt-0.5">选择一个智能体开始对话分析</p>
      </div>

      {loading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-white rounded-xl border border-slate-200 p-4 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-slate-200" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 bg-slate-200 rounded w-1/3" />
                  <div className="h-3 bg-slate-100 rounded w-2/3" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="bg-red-50 border border-red-100 text-red-600 text-sm rounded-lg p-3">
          {error}
        </div>
      )}

      {!loading && !error && agents.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
          <Bot className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-sm text-slate-500">暂无可用的 Agent</p>
          {isAdmin && (
            <button
              onClick={() => navigateTo('agents-admin')}
              className="mt-4 px-4 py-2 bg-indigo-500 text-white rounded-lg text-sm font-medium hover:bg-indigo-600 transition-colors"
            >
              去配置 Agent
            </button>
          )}
        </div>
      )}

      {!loading && !error && agents.length > 0 && (
        <div className="space-y-3">
          {agents.map((agent) => (
            <button
              key={agent.agentKey}
              onClick={() => handleOpen(agent)}
              className="w-full text-left bg-white rounded-xl border border-slate-200 p-4 hover:border-indigo-300 hover:shadow-sm active:scale-[0.99] transition-all"
            >
              <div className="flex items-start gap-3">
                <div
                  className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 text-white"
                  style={{
                    background: agent.themeColor
                      ? `linear-gradient(135deg, ${agent.themeColor}, ${agent.themeColor}cc)`
                      : 'linear-gradient(135deg, #0ea5e9, #4f46e5)',
                  }}
                >
                  <AgentIcon name={agent.icon} className="w-6 h-6" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[15px] font-semibold text-slate-900 truncate">
                      {agent.label}
                    </span>
                    {agent.defaultEnabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium flex-shrink-0">
                        已配置
                      </span>
                    )}
                  </div>
                  {agent.subtitle && (
                    <p className="text-[12px] text-slate-400 mt-0.5 truncate">{agent.subtitle}</p>
                  )}
                  {agent.description && (
                    <p className="text-[13px] text-slate-600 mt-1.5 leading-relaxed line-clamp-2">
                      {agent.description}
                    </p>
                  )}
                  {agent.quickPrompts.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {agent.quickPrompts.slice(0, 3).map((q, i) => (
                        <span
                          key={i}
                          className="text-[11px] px-2 py-1 rounded-full bg-slate-50 border border-slate-200 text-slate-500"
                        >
                          {q.icon ? `${q.icon} ` : ''}
                          {q.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0 mt-3" />
              </div>
            </button>
          ))}
        </div>
      )}

      {isAdmin && agents.length > 0 && (
        <button
          onClick={() => navigateTo('agents-admin')}
          className="w-full mt-4 py-2.5 border border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors"
        >
          Agent 配置管理
        </button>
      )}
    </div>
  )
}
