import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { apiFetch } from '../utils/api'
import type { AppRole } from '../types'
import AiWriteTargetsPanel from './AiWriteTargetsPanel'

interface AgentSkill {
  name: string
  description: string
  bodyMd: string
  roles: string[]
  producesDocument: boolean
  enabled: boolean
  sortOrder: number
}

const EMPTY_SKILL: AgentSkill = {
  name: '',
  description: '',
  bodyMd: '',
  roles: [],
  producesDocument: false,
  enabled: true,
  sortOrder: 100,
}

export default function AiSkillsView() {
  const { showToast, goBack } = useStore()
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [roles, setRoles] = useState<AppRole[]>([])
  const [editing, setEditing] = useState<AgentSkill | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<'skills' | 'write'>('skills')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [skillData, roleData] = await Promise.all([
        apiFetch('/ai/agent/skills-admin'),
        apiFetch('/admin/roles').catch(() => ({ items: [] })),
      ])
      setSkills(Array.isArray(skillData?.items) ? skillData.items : [])
      setRoles(Array.isArray(roleData?.items) ? roleData.items : [])
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void load()
  }, [load])

  const startEdit = (s: AgentSkill) => {
    setEditing({ ...s, roles: [...s.roles] })
    setIsNew(false)
  }
  const startNew = () => {
    setEditing({ ...EMPTY_SKILL })
    setIsNew(true)
  }

  const toggleRole = (key: string) => {
    if (!editing) return
    const has = editing.roles.includes(key)
    setEditing({ ...editing, roles: has ? editing.roles.filter((r) => r !== key) : [...editing.roles, key] })
  }

  const save = async () => {
    if (!editing) return
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(editing.name)) {
      showToast('name 须为小写字母开头、仅含小写字母/数字/连字符')
      return
    }
    if (!editing.description.trim() || !editing.bodyMd.trim()) {
      showToast('描述与正文不能为空')
      return
    }
    setSaving(true)
    try {
      await apiFetch('/ai/agent/skills-admin', {
        method: 'POST',
        body: JSON.stringify(editing),
      })
      showToast('已保存')
      setEditing(null)
      await load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (name: string) => {
    if (!confirm(`确认删除 skill「${name}」？`)) return
    try {
      await apiFetch(`/ai/agent/skills-admin/${name}`, { method: 'DELETE' })
      showToast('已删除')
      await load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '删除失败')
    }
  }

  if (editing) {
    return (
      <div className="p-4 max-w-2xl mx-auto pb-24">
        <h2 className="text-lg font-semibold mb-3">{isNew ? '新建 Skill' : `编辑：${editing.name}`}</h2>
        <div className="space-y-3 bg-white rounded-lg shadow p-4">
          <div>
            <label className="block text-sm text-slate-600 mb-1">名称（小写连字符，唯一）</label>
            <input
              value={editing.name}
              disabled={!isNew}
              onChange={(e) => setEditing({ ...editing, name: e.target.value.toLowerCase() })}
              placeholder="report-query"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm disabled:bg-slate-100"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1">描述（决定何时触发，注入 AI 提示）</label>
            <textarea
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              rows={2}
              maxLength={1024}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1">
              正文（SKILL.md 工作流/规范，不可含可执行脚本）
            </label>
            <textarea
              value={editing.bodyMd}
              onChange={(e) => setEditing({ ...editing, bodyMd: e.target.value })}
              rows={12}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1">可使用此 Skill 的角色（不选=仅管理员）</label>
            <div className="flex flex-wrap gap-2">
              {roles.map((r) => (
                <button
                  key={r.roleKey}
                  type="button"
                  onClick={() => toggleRole(r.roleKey)}
                  className={`text-xs px-3 py-1.5 rounded-full border ${
                    editing.roles.includes(r.roleKey)
                      ? 'border-sky-500 bg-sky-50 text-sky-700'
                      : 'border-slate-200 text-slate-500'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
              />
              启用
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={editing.producesDocument}
                onChange={(e) => setEditing({ ...editing, producesDocument: e.target.checked })}
              />
              产出文档
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              排序
              <input
                type="number"
                value={editing.sortOrder}
                onChange={(e) => setEditing({ ...editing, sortOrder: Number(e.target.value) || 100 })}
                className="w-20 px-2 py-1 border border-slate-300 rounded text-sm"
              />
            </label>
          </div>
        </div>
        <div className="flex gap-3 mt-4">
          <button
            onClick={() => setEditing(null)}
            className="flex-1 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm"
          >
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="flex-1 py-2 bg-sky-500 text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <button onClick={goBack} className="text-sm text-sky-600">← 返回</button>
        {tab === 'skills' && (
          <button onClick={startNew} className="text-sm px-3 py-1.5 bg-sky-500 text-white rounded-lg">
            + 新建 Skill
          </button>
        )}
      </div>

      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setTab('skills')}
          className={`text-sm px-3 py-1.5 rounded-lg ${tab === 'skills' ? 'bg-sky-100 text-sky-700' : 'text-slate-500'}`}
        >
          Skills
        </button>
        <button
          onClick={() => setTab('write')}
          className={`text-sm px-3 py-1.5 rounded-lg ${tab === 'write' ? 'bg-sky-100 text-sky-700' : 'text-slate-500'}`}
        >
          写入目标
        </button>
      </div>

      {tab === 'write' && <AiWriteTargetsPanel roles={roles} />}

      {tab === 'skills' && (
        <>
      <p className="text-xs text-slate-500 mb-3">
        Skill 为纯指令型（描述工作流，执行落到白名单工具）。出于安全考虑，正文不接受可执行脚本。
      </p>
      {loading && <p className="text-sm text-slate-400 py-6 text-center">加载中…</p>}
      {!loading && skills.length === 0 && (
        <p className="text-sm text-slate-400 py-6 text-center">暂无 Skill，点击右上角新建</p>
      )}
      <div className="space-y-2">
        {skills.map((s) => (
          <div key={s.name} className="bg-white rounded-lg shadow p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-800">{s.name}</span>
                {!s.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">停用</span>}
                {s.producesDocument && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-600">文档</span>
                )}
              </div>
              <div className="flex gap-3">
                <button onClick={() => startEdit(s)} className="text-xs text-sky-600">编辑</button>
                <button onClick={() => void remove(s.name)} className="text-xs text-red-500">删除</button>
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-1 line-clamp-2">{s.description}</p>
            <p className="text-[10px] text-slate-400 mt-1">
              角色：{s.roles.length > 0 ? s.roles.join('、') : '仅管理员'}
            </p>
          </div>
        ))}
      </div>
        </>
      )}
    </div>
  )
}
