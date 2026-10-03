import { useState } from 'react'
import { Check, ChevronRight, KeyRound, LogOut, Monitor, Shield } from 'lucide-react'
import AgentStatusBadge from '../components/AgentStatusBadge'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import { isAdminUser } from '../utils/helpers'
import { Badge, Button, Card, Field, Input, ListRow } from '../ui'
import { cn } from '../ui/classes'
import { THEMES, useTheme, type ThemePref } from '../theme'
import { saveUserTheme } from '../theme/sync'

/** 主题缩略卡：在卡片内局部套用该主题（themes.css 的 [data-ui-theme] 选择器），画一个迷你界面 */
function ThemePreview({ id }: { id: string }) {
  return (
    <div data-ui-theme={id} className="rounded-lg overflow-hidden border border-line bg-bg h-[72px] flex flex-col">
      <div className="h-3.5 bg-chrome border-b border-chrome-line flex items-center px-1.5 gap-1">
        <span className="w-2 h-2 rounded-sm bg-ai" />
        <span className="h-1 w-6 rounded bg-chrome-fg/50" />
      </div>
      <div className="flex-1 p-1.5 flex gap-1">
        <div className="flex-1 rounded bg-surface border border-line p-1 flex flex-col gap-1">
          <span className="h-1 w-8 rounded bg-fg/70" />
          <span className="h-1 w-5 rounded bg-muted/60" />
          <span className="mt-auto h-2.5 w-9 rounded-sm bg-primary" />
        </div>
        <div className="w-5 rounded bg-surface border border-line flex flex-col justify-end p-0.5 gap-0.5">
          <span className="h-2 rounded-sm bg-chart-1" />
        </div>
      </div>
    </div>
  )
}

export default function SettingsView() {
  const { user, logout, navigateTo, showToast } = useStore()
  const isAdmin = isAdminUser(user)
  const { pref, active } = useTheme()
  const [showChangePwd, setShowChangePwd] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const chooseTheme = (next: ThemePref) => {
    saveUserTheme(next).catch(() => showToast('主题已在本机生效，同步到账号失败'))
  }

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
      setError(err instanceof Error ? err.message : '密码修改失败')
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

  const name = user?.displayName || user?.username || '-'
  const roles = user?.roles && user.roles.length > 0 ? user.roles : [user?.role === 'admin' ? 'admin' : 'operator']

  return (
    <div className="p-4 lg:p-6 max-w-3xl mx-auto flex flex-col gap-4">
      <Card className="p-4 flex items-center gap-3">
        <span className="w-12 h-12 rounded-full bg-ai text-primary-fg text-lg font-semibold flex items-center justify-center flex-shrink-0">{name.slice(0, 1)}</span>
        <div className="min-w-0">
          <p className="font-display text-base font-semibold text-fg truncate">
            {name} <span className="num text-xs font-normal text-muted ml-1">{user?.username}</span>
          </p>
          <div className="flex flex-wrap gap-1 mt-1">
            {roles.map((r) => (
              <Badge key={r} tone={r === 'admin' ? 'accent' : 'primary'}>
                {r === 'admin' ? '管理员' : r}
              </Badge>
            ))}
          </div>
        </div>
      </Card>

      <AgentStatusBadge variant="card" showAdminDetails={isAdmin} />

      <section className="flex flex-col gap-2">
        <h3 className="text-xs text-muted tracking-wider px-1">外观</h3>
        <Card className="p-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {THEMES.map((t) => {
              const on = pref === t.id || (pref == null && active === t.id)
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => chooseTheme(t.id)}
                  aria-pressed={on}
                  className={cn('text-left rounded-xl p-1.5 border-2 transition-colors', on ? 'border-primary' : 'border-transparent hover:border-line')}
                >
                  <ThemePreview id={t.id} />
                  <span className="flex items-center gap-1 mt-1.5 px-0.5 text-[13px] font-medium text-fg">
                    {on && <Check className="w-3.5 h-3.5 text-primary" />}
                    {t.name}
                  </span>
                  <span className="block px-0.5 text-[11px] text-muted truncate">{t.description}</span>
                </button>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => chooseTheme('system')}
            aria-pressed={pref === 'system'}
            className={cn('mt-2.5 w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border text-left text-[13px] transition-colors', pref === 'system' ? 'border-primary bg-primary-soft text-primary' : 'border-line text-fg-2 hover:bg-surface-2')}
          >
            <Monitor className="w-4 h-4" />
            <span className="flex-1">跟随系统：系统浅色时用公司默认，深色时用「F 全深色」</span>
            {pref === 'system' && <Check className="w-4 h-4" />}
          </button>
          {pref && pref !== 'system' && (
            <button type="button" className="mt-2 text-xs text-muted hover:text-fg px-1" onClick={() => saveUserTheme(null).catch(() => undefined)}>
              恢复公司默认主题
            </button>
          )}
        </Card>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs text-muted tracking-wider px-1">账号</h3>
        <Card className="overflow-hidden">
          {isAdmin && (
            <ListRow icon={<Shield className="w-4 h-4" />} title="管理后台" description="Agent、看板、Skill、菜单权限与推送配置" trailing={<ChevronRight className="w-4 h-4 text-subtle" />} onClick={() => navigateTo('admin')} />
          )}
          <ListRow icon={<KeyRound className="w-4 h-4" />} title="修改密码" trailing={<ChevronRight className="w-4 h-4 text-subtle" />} onClick={() => setShowChangePwd((v) => !v)} />
          {showChangePwd && (
            <div className="px-4 pb-4 pt-1 border-t border-line flex flex-col gap-3">
              {error && <div className="p-2 bg-danger-soft text-danger text-sm rounded-lg">{error}</div>}
              <Field label="新密码">
                <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="请输入新密码" />
              </Field>
              <Field label="确认新密码">
                <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="请再次输入新密码" />
              </Field>
              <div className="flex gap-2">
                <Button variant="secondary" block onClick={resetForm}>
                  取消
                </Button>
                <Button block onClick={handleChangePassword} disabled={loading}>
                  {loading ? '修改中…' : '确认修改'}
                </Button>
              </div>
            </div>
          )}
          <ListRow id="btn-settings-logout" icon={<LogOut className="w-4 h-4" />} title="退出登录" danger onClick={logout} />
        </Card>
      </section>
    </div>
  )
}
