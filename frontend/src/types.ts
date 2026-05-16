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
  | 'work-registration'
