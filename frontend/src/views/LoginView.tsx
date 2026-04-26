import { useState } from 'react'
import { useStore } from '../store'
import { AlertCircle } from 'lucide-react'

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
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-sky-100 text-sky-600 rounded-3xl text-4xl mb-6">
            📋
          </div>
          <h1 className="text-3xl font-bold text-slate-900">生产报工</h1>
          <p className="text-slate-500 mt-2">工厂智能报工系统</p>
        </div>

        <form onSubmit={handleSubmit} className="card">
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                用户名
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-3 border border-slate-300 rounded-2xl focus:outline-none focus:border-sky-500"
                placeholder="请输入用户名"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                密码
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 border border-slate-300 rounded-2xl focus:outline-none focus:border-sky-500"
                placeholder="请输入密码"
                required
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-2xl text-sm">
                <AlertCircle className="w-4 h-4" />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="btn-primary w-full text-lg py-4 disabled:opacity-70"
            >
              {isLoading ? '登录中...' : '登录'}
            </button>
          </div>
        </form>

        <div className="text-center mt-8 text-sm text-slate-500">
          <a 
            href="/download/android-app.apk" 
            className="text-sky-600 hover:underline"
          >
            下载安卓客户端
          </a>
        </div>
      </div>
    </div>
  )
}
