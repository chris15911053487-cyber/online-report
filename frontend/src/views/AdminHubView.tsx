/**
 * 管理后台首页：把原来设置页里的各个管理按钮归并成分组卡片，并可设置公司默认主题。
 */
import { useState } from 'react'
import { ChevronRight, Palette } from 'lucide-react'
import { useStore } from '../store'
import { ADMIN_ENTRIES } from '../components/adminEntries'
import { Card, PageHeader, Select, Field } from '../ui'
import { THEMES, isThemeId, useTheme, type ThemeId } from '../theme'
import { saveCompanyTheme } from '../theme/sync'
import { isAdminUser } from '../utils/helpers'

export default function AdminHubView() {
  const { navigateTo, user, showToast } = useStore()
  const { company } = useTheme()
  const [saving, setSaving] = useState(false)

  if (!isAdminUser(user)) {
    return <div className="p-4 text-sm text-muted">需要管理员权限</div>
  }

  const changeCompanyTheme = async (id: ThemeId) => {
    setSaving(true)
    try {
      await saveCompanyTheme(id)
      showToast('公司默认主题已更新')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4">
      <PageHeader title="管理后台" description="Agent、看板、Skill、菜单权限与推送配置" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ADMIN_ENTRIES.map(({ view, label, description, icon: Icon }) => (
          <button
            key={view}
            type="button"
            onClick={() => navigateTo(view)}
            className="group text-left bg-surface border border-line rounded-xl shadow-sm p-4 flex items-start gap-3 hover:border-primary/40 transition-colors"
          >
            <span className="w-10 h-10 rounded-lg bg-primary-soft text-primary flex items-center justify-center flex-shrink-0">
              <Icon className="w-5 h-5" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block font-display text-[15px] font-semibold text-fg">{label}</span>
              <span className="block text-xs text-muted mt-0.5">{description}</span>
            </span>
            <ChevronRight className="w-4 h-4 text-subtle group-hover:text-primary mt-1" />
          </button>
        ))}
      </div>

      <Card className="p-4 flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex items-start gap-3 flex-1">
          <span className="w-10 h-10 rounded-lg bg-accent-soft text-accent flex items-center justify-center flex-shrink-0">
            <Palette className="w-5 h-5" />
          </span>
          <div>
            <p className="font-display text-[15px] font-semibold text-fg">公司默认主题</p>
            <p className="text-xs text-muted mt-0.5">用户没有自己选择主题时使用；登录页也按此显示。</p>
          </div>
        </div>
        <Field className="sm:w-60">
          <Select value={company} disabled={saving} onChange={(e) => isThemeId(e.target.value) && void changeCompanyTheme(e.target.value)}>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      </Card>
    </div>
  )
}
