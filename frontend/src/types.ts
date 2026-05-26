export interface User {
  username: string
  displayName: string
  role: 'admin' | 'operator'
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

export type ViewName =
  | 'login'
  | 'catalog'
  | 'ai'
  | 'messages'
  | 'settings'
  | 'owor'
  | 'orders'
  | 'detail'
  | 'menu-settings'
  | 'dynamic-report'
  | 'report-row-detail'
  | 'pro-sign-receive'
  | 'pro-sign-order-detail'
  | 'work-registration'
