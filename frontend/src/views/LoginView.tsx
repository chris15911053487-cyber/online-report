import { useState } from 'react'
import { useStore } from '../store'
import { AlertCircle, BarChart3, Bot, Eye, EyeOff, Factory, FileText, Smartphone } from 'lucide-react'
import { BRAND_NAME, BRAND_SUBTITLE } from '../utils/brand'

/** 记住上次登录的用户名（只存用户名，不存密码） */
const LAST_USER_KEY = 'online_report_last_username'

function readLastUser() {
  try {
    return localStorage.getItem(LAST_USER_KEY) || ''
  } catch {
    return ''
  }
}

const FEATURES = [
  { icon: FileText, title: '动态报表与报工', desc: '对接 SAP B1，筛选、查询、批次与合并报工' },
  { icon: Bot, title: 'AI Agent', desc: '用自然语言问数据，自动出图表和结论' },
  { icon: BarChart3, title: 'BI 看板与预警', desc: '经营指标一屏看全，异常即时推送到钉钉、企微' },
]

export default function LoginView() {
  const { login, isLoading } = useStore()
  const [username, setUsername] = useState(readLastUser)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  // 安卓壳内已经是客户端，不再提示下载
  const inApp = typeof window !== 'undefined' && 'ReactNativeWebView' in window

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    try {
      await login(username.trim(), password)
      try {
        localStorage.setItem(LAST_USER_KEY, username.trim())
      } catch {
        /* 不可写时忽略 */
      }
    } catch (err: any) {
      setError(err.message || '登录失败')
    }
  }

  return (
    <div className="login-hero lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:p-0 lg:items-stretch">
      {/* PC 左侧品牌区 */}
      <aside className="hidden lg:flex flex-col justify-between bg-ai text-primary-fg px-12 py-10 xl:px-16">
        <div className="flex items-center gap-2.5">
          <span className="w-9 h-9 rounded-xl bg-primary-fg/15 ring-1 ring-primary-fg/25 flex items-center justify-center">
            <Factory className="w-5 h-5" />
          </span>
          <span className="font-display text-lg font-semibold">{BRAND_NAME}</span>
        </div>

        <div className="max-w-md">
          <h1 className="font-display text-4xl font-bold leading-tight">
            {BRAND_SUBTITLE.split(' · ').map((line) => (
              <span key={line} className="block">{line}</span>
            ))}
          </h1>
          <ul className="mt-10 space-y-6">
            {FEATURES.map(({ icon: Icon, title, desc }) => (
              <li key={title} className="flex gap-4">
                <span className="w-10 h-10 rounded-xl bg-primary-fg/15 flex items-center justify-center flex-shrink-0">
                  <Icon className="w-5 h-5" />
                </span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="block mt-0.5 text-sm text-primary-fg/75">{desc}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-primary-fg/60">支持 PC 浏览器、手机浏览器与钉钉工作台</p>
      </aside>

      {/* 表单区 */}
      <main className="relative z-10 w-full max-w-sm mx-auto lg:max-w-none lg:flex lg:items-center lg:justify-center lg:px-10">
        <div className="w-full lg:max-w-sm">
          {/* 手机：顶部品牌 */}
          <div className="lg:hidden text-center mb-7">
            <span className="mx-auto mb-4 w-14 h-14 rounded-2xl bg-ai text-primary-fg flex items-center justify-center shadow-lg">
              <Factory className="w-7 h-7" />
            </span>
            <h1 className="font-display text-2xl font-bold text-fg">{BRAND_NAME}</h1>
            <p className="mt-1.5 text-sm text-muted">{BRAND_SUBTITLE}</p>
          </div>

          <div className="hidden lg:block mb-7">
            <h2 className="font-display text-2xl font-semibold text-fg">登录</h2>
            <p className="mt-1.5 text-sm text-muted">请输入账号和密码</p>
          </div>

          <form onSubmit={handleSubmit} className="login-card">
            <div className="space-y-5">
              <div>
                <label htmlFor="login-username" className="mb-1.5 block text-sm font-medium text-fg-2">用户名</label>
                <input
                  id="login-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="login-input"
                  placeholder="请输入用户名"
                  autoComplete="username"
                  autoFocus={!username}
                  required
                />
              </div>

              <div>
                <label htmlFor="login-password" className="mb-1.5 block text-sm font-medium text-fg-2">密码</label>
                <div className="relative">
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="login-input pr-11"
                    placeholder="请输入密码"
                    autoComplete="current-password"
                    autoFocus={!!username}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg flex items-center justify-center text-subtle hover:text-fg-2"
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 rounded-xl bg-danger-soft p-3 text-sm text-danger ring-1 ring-danger/25">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {error}
                </div>
              )}

              <button type="submit" disabled={isLoading} className="login-btn disabled:opacity-70">
                {isLoading ? '登录中…' : '登录'}
              </button>
            </div>
          </form>

          {!inApp && (
            <div className="mt-6 text-center">
              <a href="/download/android-app.apk" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-primary">
                <Smartphone className="w-4 h-4" />
                下载安卓客户端
              </a>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
