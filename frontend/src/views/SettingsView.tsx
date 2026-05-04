import { useStore } from '../store'

export default function SettingsView() {
  const { user, logout } = useStore()

  return (
    <div className="p-4 max-w-md mx-auto">
      <div className="bg-white rounded-lg shadow p-6 mb-4">
        <h2 className="text-lg font-semibold mb-4">用户信息</h2>
        <div className="text-sm text-slate-600 space-y-2">
          <p>用户名：{user?.username || '-'}</p>
          <p>显示名：{user?.displayName || '-'}</p>
          <p>角色：{user?.role === 'admin' ? '管理员' : '操作员'}</p>
        </div>
      </div>

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
