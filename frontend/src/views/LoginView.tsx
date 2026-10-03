import { useState } from 'react'
import { useStore } from '../store'
import { AlertCircle, Sparkles } from 'lucide-react'

// 品牌信息：如需改名称/副标题，改这里即可
const BRAND_NAME = 'AI 智能平台'
const BRAND_SUBTITLE = '工厂智能报工 · AI 数据助手'

export default function LoginView() {
  const { login, isLoading } = useStore()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    try {
      await login(username, password)
    } catch (err: any) {
      setError(err.message || '登录失败')
    }
  }

  return (
    <div className="login-hero">
      {/* 背景层：流动极光 + 圆点科技底纹 */}
      <div className="login-aurora" />
      <div className="login-grid" />

      <div className="relative z-10 w-full max-w-md">
        {/* AI 科技动图：核心徽标 + 雷达式扩散脉冲 */}
        <div className="relative mx-auto mb-8 h-32 w-32">
          <div className="absolute inset-2">
            <span className="ai-pulse" />
            <span className="ai-pulse ai-pulse-2" />
            <span className="ai-pulse ai-pulse-3" />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="ai-orb">
              <Sparkles className="ai-orb-icon h-11 w-11" strokeWidth={1.8} />
            </div>
          </div>
        </div>

        <div className="text-center mb-8">
          <h1 className="bg-gradient-to-r from-cyan-500 via-indigo-600 to-purple-600 bg-clip-text text-3xl font-bold tracking-wide text-transparent">
            {BRAND_NAME}
          </h1>
          <p className="mt-2 text-sm text-slate-500">{BRAND_SUBTITLE}</p>
        </div>

        <form onSubmit={handleSubmit} className="login-card">
          <div className="space-y-6">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">用户名</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="login-input"
                placeholder="请输入用户名"
                required
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="login-input"
                placeholder="请输入密码"
                required
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-2xl bg-red-50 p-3 text-sm text-red-600 ring-1 ring-red-200">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}

            <button type="submit" disabled={isLoading} className="login-btn disabled:opacity-70">
              {isLoading ? '登录中...' : '登 录'}
            </button>
          </div>
        </form>

        <div className="mt-8 text-center text-sm text-slate-500">
          <a href="/download/android-app.apk" className="text-indigo-600 hover:text-indigo-700 hover:underline">
            下载安卓客户端
          </a>
        </div>
      </div>
    </div>
  )
}
