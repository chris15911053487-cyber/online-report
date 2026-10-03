import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageSquare, Pencil, Plus, Sparkles, Trash2, Upload } from 'lucide-react'
import { useStore } from '../store'
import { apiFetch, apiFetchReport, apiUpload } from '../utils/api'
import type { AppRole } from '../types'
import AiWriteTargetsPanel from './AiWriteTargetsPanel'
import AiGenerateDialog from '../components/AiGenerateDialog'
import { AdminPage, Badge, Button, Card, Checkbox, ChipSelect, EditorActions, EmptyState, Field, IconButton, Input, RecordRow, Section, Skeleton, Tabs, Textarea } from '../ui'
import { confirmDelete } from '../ui/confirm'

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
  allowedTables: string[]
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
  allowedTables: [],
  producesDocument: false,
  enabled: true,
  sortOrder: 100,
}

function resourceCount(s: AgentSkill): number {
  return Object.keys(s.resources || {}).length
}

/** Skill 包文件结构（树形文本） */
function SkillFileTree({ skill }: { skill: AgentSkill }) {
  const paths = Object.keys(skill.resources || {}).sort()
  const dirs = new Map<string, string[]>()
  const rootFiles: string[] = []
  for (const p of paths) {
    const slash = p.indexOf('/')
    if (slash > 0) {
      const dir = p.slice(0, slash)
      if (!dirs.has(dir)) dirs.set(dir, [])
      dirs.get(dir)!.push(p.slice(slash + 1))
    } else {
      rootFiles.push(p)
    }
  }
  const allTop = [
    { type: 'file' as const, name: 'SKILL.md' },
    ...rootFiles.map((f) => ({ type: 'file' as const, name: f })),
    ...[...dirs.keys()].map((d) => ({ type: 'dir' as const, name: d })),
  ]
  const lines: React.ReactElement[] = []
  allTop.forEach((entry, i) => {
    const isLast = i === allTop.length - 1
    if (entry.type === 'file') {
      lines.push(<div key={`f-${entry.name}`} className="pl-4">{isLast ? '└── ' : '├── '}{entry.name}</div>)
      return
    }
    const files = dirs.get(entry.name) || []
    lines.push(<div key={`d-${entry.name}`} className="pl-4">{isLast ? '└── ' : '├── '}{entry.name}/</div>)
    files.forEach((f, fi) => {
      const prefix = isLast ? '    ' : '│   '
      lines.push(<div key={`d-${entry.name}-${f}`} className="pl-4 whitespace-pre">{prefix}{fi === files.length - 1 ? '└── ' : '├── '}{f}</div>)
    })
  })
  return (
    <div className="bg-surface-2 border border-line rounded-lg px-3 py-2 text-xs font-mono text-fg-2 leading-relaxed">
      <div>{skill.name || 'skill-name'}/</div>
      {lines}
      {paths.length === 0 && <div className="pl-4 text-subtle">（无资源文件）</div>}
    </div>
  )
}

export default function AiSkillsView() {
  const { showToast, openAiChatWithSkill } = useStore()
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [roles, setRoles] = useState<AppRole[]>([])
  const [editing, setEditing] = useState<AgentSkill | null>(null)
  const [allowedTablesInput, setAllowedTablesInput] = useState('')
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
    setAllowedTablesInput((s.allowedTables || []).join(', '))
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
    setAllowedTablesInput('')
    setIsNew(true)
  }

  const handleAIGenerate = async (requirement: string) => {
    setShowAIDialog(false)
    setAiGenerating(true)
    showToast('AI 正在生成 Skill…（约需数十秒）', 95000)
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
        setAllowedTablesInput('')
        setIsNew(true)
        showToast('AI 生成成功，请检查内容后保存')
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
      const allowedTables = allowedTablesInput
        .split(/[\s,;]+/)
        .map((t) => t.trim())
        .filter(Boolean)
      await apiFetch('/ai/agent/skills-admin', {
        method: 'POST',
        body: JSON.stringify({ ...editing, allowedTables }),
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
    if (!(await confirmDelete(`Skill「${name}」`))) return
    try {
      await apiFetch(`/ai/agent/skills-admin/${name}`, { method: 'DELETE' })
      showToast('已删除')
      await load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '删除失败')
    }
  }

  const aiDialog = (
    <AiGenerateDialog
      open={showAIDialog}
      title="AI 辅助生成 Skill"
      label="描述你想要的 Skill 功能"
      example="帮我创建一个 Skill，用于分析生产报工数据，统计每个工序的效率和异常情况，给出改进建议。"
      placeholder="描述 Skill 的用途、工作流程和期望输出…"
      onConfirm={(v) => void handleAIGenerate(v)}
      onClose={() => setShowAIDialog(false)}
    />
  )

  if (editing) {
    return (
      <AdminPage
        title={isNew ? '新建 Skill' : `编辑：${editing.name}`}
        onBack={() => setEditing(null)}
        withActionBar
        actions={
          <Button variant="soft" icon={<Sparkles className="w-4 h-4" />} onClick={() => setShowAIDialog(true)} disabled={aiGenerating}>
            {aiGenerating ? '生成中…' : 'AI 辅助生成'}
          </Button>
        }
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start">
          <Section title="内容">
            <div className="flex flex-col gap-3">
              <Field label="名称（小写连字符，唯一）">
                <Input
                  value={editing.name}
                  disabled={!isNew}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value.toLowerCase() })}
                  placeholder="report-query"
                />
              </Field>
              <Field label="描述（决定何时触发，注入 AI 提示）">
                <Textarea
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  rows={2}
                  maxLength={1024}
                />
              </Field>
              <Field label="正文（SKILL.md 工作流/规范，不可含可执行脚本）">
                <Textarea mono rows={24} value={editing.bodyMd} onChange={(e) => setEditing({ ...editing, bodyMd: e.target.value })} />
              </Field>
            </div>
          </Section>

          <div className="flex flex-col gap-4">
            <Section title="权限与约束">
              <div className="flex flex-col gap-3">
                <Field
                  label="允许的表（run_sql 表白名单，硬约束）"
                  hint={
                    <>
                      用逗号或空格分隔多个表名。<b>留空 = 不限制表</b>（仅限 SELECT）；填写后，本 Skill 通过 run_sql
                      执行的 SQL 只能引用这些表，引用白名单外的表会被后端拒绝。
                    </>
                  }
                >
                  <Input className="font-mono" value={allowedTablesInput} onChange={(e) => setAllowedTablesInput(e.target.value)} placeholder="OJDT, JDT1, OACT" />
                </Field>
                <Field label="可使用此 Skill 的角色（不选 = 仅管理员）">
                  <ChipSelect
                    options={roles.map((r) => ({ value: r.roleKey, label: r.label }))}
                    selected={editing.roles}
                    onChange={(next) => setEditing({ ...editing, roles: next })}
                    empty="暂无角色定义"
                  />
                </Field>
                <div className="flex items-center gap-4 flex-wrap">
                  <Checkbox label="启用" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
                  <Checkbox
                    label="产出文档"
                    checked={editing.producesDocument}
                    onChange={(e) => setEditing({ ...editing, producesDocument: e.target.checked })}
                  />
                  <label className="flex items-center gap-2 text-sm text-fg-2">
                    排序
                    <Input
                      type="number"
                      className="w-24"
                      value={editing.sortOrder}
                      onChange={(e) => setEditing({ ...editing, sortOrder: Number(e.target.value) || 100 })}
                    />
                  </label>
                </div>
              </div>
            </Section>

            <Section title="Skill 包文件" hint="资源文件通过「导入 Skill 包 (.zip)」添加或更新，编辑页只读。">
              <div className="flex flex-col gap-2">
                <SkillFileTree skill={editing} />
                {Object.entries(editing.resources || {}).map(([p, r]) => (
                  <div key={p} className="border border-line rounded-lg">
                    <button
                      type="button"
                      onClick={() => setPreviewPath(previewPath === p ? null : p)}
                      className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-surface-2 rounded-lg"
                    >
                      <span className="text-xs font-mono text-fg-2">{p}</span>
                      <span className="text-[11px] text-subtle">
                        {((r?.size ?? 0) / 1024).toFixed(1)} KB · {previewPath === p ? '收起' : '预览'}
                      </span>
                    </button>
                    {previewPath === p && (
                      <pre className="px-3 pb-2 text-[11px] text-fg-2 whitespace-pre-wrap break-all max-h-72 overflow-y-auto">
                        {r?.content || ''}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          </div>
        </div>

        <EditorActions onCancel={() => setEditing(null)} onSave={() => void save()} saving={saving} />
        {aiDialog}
      </AdminPage>
    )
  }

  return (
    <AdminPage
      title="AI Skill"
      description="Skill 为纯指令型（描述工作流，执行落到白名单工具）。出于安全考虑，正文不接受可执行脚本。"
      actions={
        tab === 'skills' && (
          <>
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
            <Button variant="secondary" icon={<Upload className="w-4 h-4" />} onClick={() => fileInputRef.current?.click()} disabled={importing}>
              {importing ? '导入中…' : '导入 Skill 包 (.zip)'}
            </Button>
            <Button
              variant="soft"
              icon={<Sparkles className="w-4 h-4" />}
              onClick={() => {
                startNew()
                setShowAIDialog(true)
              }}
              disabled={aiGenerating}
            >
              {aiGenerating ? '生成中…' : 'AI 新建'}
            </Button>
            <Button icon={<Plus className="w-4 h-4" />} onClick={startNew}>
              新建 Skill
            </Button>
          </>
        )
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'skills', label: `Skills（${skills.length}）` },
          { value: 'write', label: '写入目标' },
        ]}
      />

      {tab === 'write' && <AiWriteTargetsPanel roles={roles} />}

      {tab === 'skills' && (
        <>
          {loading && <Skeleton className="h-40" />}
          {!loading && (
            <Card className="overflow-hidden">
              {skills.length === 0 && <EmptyState title="暂无 Skill" description="点击右上角新建或导入" />}
              {skills.map((s) => (
                <RecordRow
                  key={s.name}
                  onClick={() => startEdit(s)}
                  title={s.name}
                  badges={
                    <>
                      {!s.enabled && <Badge>已停用</Badge>}
                      {s.producesDocument && <Badge tone="accent">文档</Badge>}
                      {resourceCount(s) > 0 && <Badge tone="success">{resourceCount(s)} 资源</Badge>}
                      {(s.allowedTables?.length ?? 0) > 0 && <Badge tone="warning">{s.allowedTables.length} 表白名单</Badge>}
                    </>
                  }
                  meta={
                    <>
                      <span className="line-clamp-2">{s.description}</span>
                      <span className="text-subtle">角色：{s.roles.length > 0 ? s.roles.join('、') : '仅管理员'}</span>
                    </>
                  }
                  actions={
                    <>
                      <IconButton label="用此 Skill 对话" onClick={() => openAiChatWithSkill(s.name)}>
                        <MessageSquare className="w-4 h-4" />
                      </IconButton>
                      <IconButton label="编辑" onClick={() => startEdit(s)}>
                        <Pencil className="w-4 h-4" />
                      </IconButton>
                      <IconButton label="删除" className="hover:text-danger" onClick={() => void remove(s.name)}>
                        <Trash2 className="w-4 h-4" />
                      </IconButton>
                    </>
                  }
                />
              ))}
            </Card>
          )}
        </>
      )}
      {aiDialog}
    </AdminPage>
  )
}
