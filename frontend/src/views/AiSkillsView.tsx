import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { apiFetch, apiFetchReport, apiUpload } from '../utils/api'
import type { AppRole } from '../types'
import AiWriteTargetsPanel from './AiWriteTargetsPanel'

interface SkillResource {
  content: string
  size: number
}

interface AgentSkill {
  name: string
  description: string
  bodyMd: string
  resources?: Record<string, SkillResource>
  roles: string[]
  producesDocument: boolean
  enabled: boolean
  sortOrder: number
}

const EMPTY_SKILL: AgentSkill = {
  name: '',
  description: '',
  bodyMd: '',
  resources: {},
  roles: [],
  producesDocument: false,
  enabled: true,
  sortOrder: 100,
}

function resourceCount(s: AgentSkill): number {
  return Object.keys(s.resources || {}).length
}

export default function AiSkillsView() {
  const { showToast, goBack, openAiChatWithSkill } = useStore()
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [roles, setRoles] = useState<AppRole[]>([])
  const [editing, setEditing] = useState<AgentSkill | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<'skills' | 'write'>('skills')
  const [importing, setImporting] = useState(false)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [showAIDialog, setShowAIDialog] = useState(false)
  const [aiGenerating, setAiGenerating] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
    setPreviewPath(null)
  }

  const importZip = async (file: File) => {
    setImporting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const data = (await apiUpload('/ai/agent/skills-admin/import', fd)) as {
        updated?: boolean
        skill?: { name?: string; resourceCount?: number }
      }
      const sk = data?.skill
      showToast(
        `已${data?.updated ? '更新' : '导入'} skill「${sk?.name}」（${sk?.resourceCount ?? 0} 个资源文件）` +
          (data?.updated ? '' : '，默认仅管理员可用，请编辑分配角色'),
      )
      await load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '导入失败')
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }
  const startNew = () => {
    setEditing({ ...EMPTY_SKILL })
    setIsNew(true)
  }

  const handleAIGenerate = async (requirement: string) => {
    setShowAIDialog(false)
    setAiGenerating(true)
    showToast('🤖 AI 正在生成 Skill…（约需数十秒）', 95000)
    try {
      const data = await apiFetchReport(
        '/ai/generate-skill',
        { method: 'POST', body: JSON.stringify({ requirement }) },
        120000,
      ) as { success?: boolean; skill?: { name: string; description: string; bodyMd: string }; error?: string }
      if (data.success && data.skill) {
        setEditing({
          ...EMPTY_SKILL,
          name: data.skill.name,
          description: data.skill.description,
          bodyMd: data.skill.bodyMd,
        })
        setIsNew(true)
        showToast('✅ AI 生成成功！请检查内容后保存。')
      } else {
        showToast('生成失败：' + (data.error || '未知错误'))
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '网络错误'
      showToast('AI 生成失败：' + (/abort|超时|timeout/i.test(msg) ? '请求超时，请重试' : msg))
    } finally {
      setAiGenerating(false)
    }
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
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">{isNew ? '新建 Skill' : `编辑：${editing.name}`}</h2>
          <button
            onClick={() => setShowAIDialog(true)}
            disabled={aiGenerating}
            className="text-xs px-3 py-1.5 border border-purple-400 text-purple-600 rounded-lg hover:bg-purple-50 disabled:opacity-50"
          >
            {aiGenerating ? '生成中…' : '🤖 AI 辅助生成'}
          </button>
        </div>
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
          {resourceCount(editing) > 0 && (
            <div>
              <label className="block text-sm text-slate-600 mb-1">
                包内资源文件（随压缩包导入，只读；重新导入同名包可更新）
              </label>
              <div className="space-y-1">
                {Object.entries(editing.resources || {}).map(([p, r]) => (
                  <div key={p} className="border border-slate-200 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setPreviewPath(previewPath === p ? null : p)}
                      className="w-full flex items-center justify-between px-3 py-2 text-left"
                    >
                      <span className="text-xs font-mono text-slate-700">{p}</span>
                      <span className="text-[10px] text-slate-400">
                        {((r?.size ?? 0) / 1024).toFixed(1)} KB {previewPath === p ? '▲' : '▼'}
                      </span>
                    </button>
                    {previewPath === p && (
                      <pre className="px-3 pb-2 text-[11px] text-slate-600 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                        {r?.content || ''}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
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
        {showAIDialog && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
            onClick={(e) => { if (e.target === e.currentTarget) setShowAIDialog(false) }}
          >
            <div className="bg-white rounded-xl shadow-xl w-[90%] max-w-lg p-5">
              <p className="font-semibold text-slate-800 mb-3">描述你想要的 Skill 功能：</p>
              <div className="text-xs text-slate-500 mb-1">示例：</div>
              <div className="text-xs text-slate-600 bg-slate-50 rounded p-2 mb-3 leading-relaxed">
                帮我创建一个 Skill，用于分析生产报工数据，统计每个工序的效率和异常情况，给出改进建议。
              </div>
              <textarea
                id="ai-skill-requirement"
                className="w-full border border-slate-300 rounded-lg p-2 text-sm min-h-[100px] focus:ring-2 focus:ring-sky-300 focus:border-sky-400 outline-none"
                autoFocus
                placeholder="描述 Skill 的用途、工作流程和期望输出…"
              />
              <div className="flex justify-end gap-2 mt-4">
                <button
                  type="button"
                  className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600"
                  onClick={() => setShowAIDialog(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="px-4 py-2 text-sm rounded-lg bg-purple-500 text-white disabled:opacity-50"
                  onClick={() => {
                    const el = document.getElementById('ai-skill-requirement') as HTMLTextAreaElement | null
                    const v = el?.value.trim()
                    if (v) void handleAIGenerate(v)
                  }}
                >
                  生成
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <button onClick={goBack} className="text-sm text-sky-600">← 返回</button>
        {tab === 'skills' && (
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void importZip(f)
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="text-sm px-3 py-1.5 border border-violet-400 text-violet-600 rounded-lg disabled:opacity-50"
            >
              {importing ? '导入中…' : '导入 Skill 包 (.zip)'}
            </button>
            <button
              onClick={() => { startNew(); setShowAIDialog(true) }}
              disabled={aiGenerating}
              className="text-sm px-3 py-1.5 border border-purple-400 text-purple-600 rounded-lg disabled:opacity-50"
            >
              {aiGenerating ? '生成中…' : '🤖 AI 新建'}
            </button>
            <button onClick={startNew} className="text-sm px-3 py-1.5 bg-sky-500 text-white rounded-lg">
              + 新建 Skill
            </button>
          </div>
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
                {resourceCount(s) > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600">
                    {resourceCount(s)} 资源
                  </span>
                )}
              </div>
              <div className="flex gap-3">
                <button onClick={() => openAiChatWithSkill(s.name)} className="text-xs text-violet-600">对话</button>
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
