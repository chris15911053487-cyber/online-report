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
  /** 手机卡片布局（mobile_card_json）；不配则手机上照旧显示表格。结构见 utils/reportCard.ts */
  mobileCard?: Record<string, unknown> | null
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
  /** 「全部」项的显示名，如「生产工序」（值仍为空） */
  allLabel?: string
  /** 手机上固定显示，不折叠进「更多筛选」（scan 字段默认固定） */
  pin?: boolean
  /** 分段按钮：选项平铺、点选即查询；手机上固定显示，其余条件折叠到「更多筛选」 */
  segment?: boolean
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

export interface MessageSummary {
  /** 通知未读 + 我的待处理待办 */
  totalUnread: number
  /** 通知（收件箱）未读 */
  inboxUnread: number
  /** 我的待处理待办（含延后已到期） */
  todoOpen: number
  refreshSeconds: number
}

/** 通知（警报 / 定时报告 / 待办汇总推送到收件箱的一条） */
export interface InboxItem {
  id: number
  sourceType: 'alert' | 'report' | 'task'
  sourceName: string
  title: string
  preview: string
  /** 中国墙钟时间（库里 DATETIME2 原样返回） */
  createdAt: string
  read: boolean
}

export interface InboxDetail extends Omit<InboxItem, 'preview'> {
  body: string
  linkTitle: string
  linkUrl: string
}

export type TaskStatus = 'open' | 'snoozed' | 'done' | 'closed'

/** 待办（规则按数据生成，每条一个负责人；GET /tasks） */
export interface TaskItem {
  id: number
  ruleId: number | null
  ruleName: string
  itemKey: string
  title: string
  linkUrl: string
  /** null = 数据里没有可识别的负责人，待主管转交 */
  ownerCode: string | null
  ownerLocked: boolean
  status: TaskStatus
  /** 'YYYY-MM-DD'（中国日期） */
  dueDate: string | null
  snoozeUntil: string | null
  note: string
  reopenCount: number
  firstSeenAt: string
  doneAt: string | null
  doneBy: string | null
  closedAt: string | null
}

export interface TaskDetail extends TaskItem {
  body: string
  data: Record<string, unknown>
}

export interface TaskEvent {
  id: number
  action: string
  userCode: string | null
  detail: string
  createdAt: string
}

export interface TaskListResult {
  items: TaskItem[]
  canTeam: boolean
  today: string
  counts: { open: number; snoozed: number; overdue: number; unassigned: number }
}

export type ViewName =
  | 'login'
  | 'catalog'
  | 'ai'
  | 'agent-hub'
  | 'agent-run'
  | 'agents-admin'
  | 'bi-admin'
  | 'bi-drill'
  | 'messages'
  | 'message-detail'
  | 'settings'
  | 'help'
  | 'help-doc'
  | 'menu-settings'
  | 'ai-skills'
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
