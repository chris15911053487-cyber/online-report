/** BI 管理界面共用的数据结构（与 /admin/bi/* 接口一致） */
import type { BiCard, BiColumnSemantic, BiFilter, BiParamDef } from '../../../utils/bi'

export interface BiQueryAdmin {
  queryKey: string
  label: string
  description: string
  sqlText: string
  params: BiParamDef[]
  columns: BiColumnSemantic[]
  dimensions: { column: string; label?: string }[]
  sampleQuestions: string[]
  caliberNote: string
  cacheSecs: number
  roles: string[]
  enabled: boolean
  updatedAt?: string | null
}

export interface BiDashboardAdmin {
  dashboardKey: string
  label: string
  description: string
  filters: BiFilter[]
  cards: BiCard[]
  enabled: boolean
  usedByAgents?: string[]
}

/** 看板编辑器可引用的查询（公开元数据，不含 SQL） */
export interface QueryOption {
  queryKey: string
  label: string
  description?: string
  enabled: boolean
  params: BiParamDef[]
  columns: BiColumnSemantic[]
  dimensions: { column: string; label?: string }[]
  caliberNote?: string
  cacheSecs?: number
}

export interface TestResult {
  columns: string[]
  columnTypes?: Record<string, string>
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  durationMs: number
}

export const errMsg = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

export const EMPTY_QUERY: BiQueryAdmin = {
  queryKey: '',
  label: '',
  description: '',
  sqlText: '',
  params: [],
  columns: [],
  dimensions: [],
  sampleQuestions: [],
  caliberNote: '',
  cacheSecs: 300,
  roles: [],
  enabled: true,
}

export const EMPTY_DASHBOARD: BiDashboardAdmin = {
  dashboardKey: '',
  label: '',
  description: '',
  filters: [],
  cards: [],
  enabled: true,
}
