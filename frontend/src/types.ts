export interface User {
  username: string
  displayName: string
  role: 'admin' | 'operator'
  roles?: string[]
}

export interface AppRole {
  roleKey: string
  label: string
  sortOrder: number
  isBuiltin: boolean
}

export interface NavMenuItem {
  id: number
  label: string
  routeKey: string
  icon?: string
  sortOrder: number
  enabled: boolean
  roles: string[]
  menuKind: 'builtin' | 'report'
  queryTemplate?: string
  filterSchema?: FilterField[]
  columnLabels?: Record<string, string>
  columnNameMapping?: Record<string, string>
  detailQueryTemplate?: string
  detailKeyColumn?: string
  detailKeyParam?: string
  detailKeyType?: string
  rowDetailEnabled?: boolean
  aiPrompt?: string
  voiceActions?: VoiceAction[]
}

/** 语音动作模板（方案 B）：在菜单上配置的「说什么 → 填什么」规则 */
export interface VoiceAction {
  /** 触发模板，支持占位符 {n} 数字、{t} 文本、{d} 日期 */
  patterns: string[]
  /** 命中后要预填的筛选字段：键为 filter_schema 字段 name，值含占位符 */
  fill: Record<string, string>
  /** 命中后是否自动触发查询，默认 true */
  autoQuery?: boolean
  /** 可选的展示标签 */
  label?: string
}

export interface FilterField {
  name: string
  label: string
  type: 'string' | 'int' | 'decimal' | 'date' | 'datetime' | 'bool'
  required?: boolean
  options?: FilterOption[]
  optionsSql?: string
  optionsFromSql?: string
  scan?: boolean
  noAllOption?: boolean
}

export interface FilterOption {
  name: string
  code: string | number
}

export interface ReportResult {
  columns: string[]
  rows: Record<string, any>[]
  totalRowCount?: number
  truncated?: boolean
  clientSidePaging?: boolean
  page?: number
  pageSize?: number
}

export interface MessageAlertRuleSummary {
  id: number
  name: string
  total: number
  unread: number
  refreshSeconds: number
  fetchedAt: string | null
  error: string | null
}

export interface MessageSummary {
  totalUnread: number
  refreshSeconds: number
  rules: MessageAlertRuleSummary[]
  refreshedAt: string | null
}

export interface MessageAlertItem {
  key: string
  title: string
  unread: boolean
  row: Record<string, unknown>
}

export interface MessageAlertRule {
  id: number
  name: string
  sqlTemplate: string
  keyColumn: string
  titleTemplate: string
  roles: string[]
  refreshSeconds: number
  enabled: boolean
  sortOrder: number
}

export type ViewName =
  | 'login'
  | 'catalog'
  | 'ai'
  | 'agent-hub'
  | 'agent-run'
  | 'agents-admin'
  | 'bi-admin'
  | 'messages'
  | 'settings'
  | 'help'
  | 'help-doc'
  | 'menu-settings'
  | 'ai-skills'
  | 'message-alert-settings'
  | 'dynamic-report'
  | 'report-row-detail'
  | 'pro-sign-receive'
  | 'pro-sign-order-detail'
  | 'work-registration'
  | 'scheduled-reports'
  | 'alert-push'
  | 'admin'

/** Agent 快捷提问 */
export interface AgentQuickPrompt {
  icon?: string
  label: string
  prompt: string
}

/** Agent 展示/交互配置（GET /agents 下发的公开字段） */
export interface Agent {
  agentKey: string
  label: string
  subtitle?: string
  description?: string
  icon?: string
  themeColor?: string
  welcomeMd?: string
  layoutMode: 'canvas' | 'chat'
  quickPrompts: AgentQuickPrompt[]
  defaultPrompt?: string
  defaultEnabled?: boolean
  defaultCacheSecs?: number
  /** 关联的 BI 看板；非空时进入 Agent 显示看板，不再自动执行 defaultPrompt */
  dashboardKey?: string
}

/** Agent 完整配置（管理后台用，含内部字段） */
export interface AgentAdmin extends Agent {
  id?: number
  skills: string[]
  systemPromptExtra?: string
  roles: string[]
  enabled: boolean
  sortOrder: number
}

/** 后台配置界面用的 skill 候选项 */
export interface AgentSkillOption {
  name: string
  description: string
  enabled: boolean
  roles: string[]
}
