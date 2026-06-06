import { useState } from 'react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'

export default function SettingsView() {
  const { user, logout, navigateTo } = useStore()
  const isAdmin = user?.role === 'admin' || (user?.roles || []).includes('admin')
  const [showChangePwd, setShowChangePwd] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleChangePassword = async () => {
    setError('')

    if (!newPassword.trim()) {
      setError('请输入新密码')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }

    setLoading(true)
    try {
      await apiFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ newPassword: newPassword.trim() }),
      })
      logout()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '密码修改失败'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setShowChangePwd(false)
    setNewPassword('')
    setConfirmPassword('')
    setError('')
  }

  return (
    <div className="p-4 max-w-md mx-auto">
      <div className="bg-white rounded-lg shadow p-6 mb-4">
        <h2 className="text-lg font-semibold mb-4">用户信息</h2>
        <div className="text-sm text-slate-600 space-y-2">
          <p>用户名：{user?.username || '-'}</p>
          <p>显示名：{user?.displayName || '-'}</p>
          <p>
            角色：
            {user?.roles && user.roles.length > 0
              ? user.roles.join('、')
              : user?.role === 'admin'
                ? '管理员'
                : '操作员'}
          </p>
        </div>
      </div>

      {isAdmin && !showChangePwd && (
        <button
          onClick={() => navigateTo('ai-skills')}
          className="w-full py-3 bg-violet-500 text-white rounded-lg font-medium hover:bg-violet-600 transition-colors mb-4"
        >
          AI Skill 管理
        </button>
      )}

      {!showChangePwd ? (
        <button
          onClick={() => setShowChangePwd(true)}
          className="w-full py-3 bg-sky-500 text-white rounded-lg font-medium hover:bg-sky-600 transition-colors mb-4"
        >
          修改密码
        </button>
      ) : (
        <div className="bg-white rounded-lg shadow p-6 mb-4">
          <h2 className="text-lg font-semibold mb-4">修改密码</h2>

          {error && (
            <div className="mb-3 p-2 bg-red-50 text-red-600 text-sm rounded">
              {error}
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label className="block text-sm text-slate-600 mb-1">新密码</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-sky-500"
                placeholder="请输入新密码"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">确认新密码</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-sky-500"
                placeholder="请再次输入新密码"
              />
            </div>
          </div>

          <div className="flex gap-3 mt-4">
            <button
              onClick={resetForm}
              className="flex-1 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm hover:bg-slate-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleChangePassword}
              disabled={loading}
              className="flex-1 py-2 bg-sky-500 text-white rounded-lg text-sm font-medium hover:bg-sky-600 disabled:opacity-50 transition-colors"
            >
              {loading ? '修改中...' : '确认修改'}
            </button>
          </div>
        </div>
      )}

      <button
        id="btn-settings-logout"
        onClick={logout}
        className="w-full py-3 bg-red-500 text-white rounded-lg font-medium hover:bg-red-600 transition-colors"
      >
        退出登录
      </button>
    </div>
  )
}
