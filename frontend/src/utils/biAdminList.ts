/**
 * BI 管理页列表（查询 / 图表 / 看板）的筛选与排序：关键字、状态、最后操作人；按最近修改或标识排序。
 */

export interface AdminListItem {
  label: string
  enabled: boolean
  updatedAt?: string | null
  updatedBy?: string | null
}

export type ListStatus = 'all' | 'enabled' | 'disabled'
export type ListSort = 'updated' | 'key'

export interface ListFilter {
  keyword: string
  status: ListStatus
  /** 最后操作人；'' = 不限，NO_OPERATOR = 未记录操作人的旧数据 */
  operator: string
  sort: ListSort
}

export const NO_OPERATOR = '__none__'
export const DEFAULT_LIST_FILTER: ListFilter = { keyword: '', status: 'all', operator: '', sort: 'updated' }

/**
 * 最后修改时间显示为「YYYY-MM-DD HH:mm」。
 * 库里存的是中国墙钟时间（DATETIME2 无时区），接口按 UTC 序列化成 ...Z，所以直接取字面值，不做时区换算。
 */
export function formatUpdatedAt(iso?: string | null): string {
  if (!iso) return ''
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(iso)
  return m ? `${m[1]} ${m[2]}` : ''
}

/** 列表里出现过的操作人（去重、按名称排序） */
export function operatorsOf(items: AdminListItem[]): string[] {
  return [...new Set(items.map((x) => x.updatedBy || '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

/**
 * 按条件过滤并排序。keyOf 取标识（查询 / 图表 / 看板各自的 key），
 * 关键字匹配 名称、标识 以及 extraText 返回的文字（描述、所用查询等），不区分大小写。
 */
export function filterAdminList<T extends AdminListItem>(items: T[], f: ListFilter, keyOf: (x: T) => string, extraText?: (x: T) => string): T[] {
  const kw = f.keyword.trim().toLowerCase()
  const out = items.filter((x) => {
    if (f.status === 'enabled' && !x.enabled) return false
    if (f.status === 'disabled' && x.enabled) return false
    if (f.operator === NO_OPERATOR ? !!x.updatedBy : f.operator && x.updatedBy !== f.operator) return false
    if (kw) {
      const text = `${x.label}\n${keyOf(x)}\n${extraText ? extraText(x) : ''}`.toLowerCase()
      if (!text.includes(kw)) return false
    }
    return true
  })
  // 时间是同一格式的字面值，可直接按字符串比较；没有时间的排最后
  return out.sort((a, b) =>
    f.sort === 'updated' ? (b.updatedAt || '').localeCompare(a.updatedAt || '') || keyOf(a).localeCompare(keyOf(b)) : keyOf(a).localeCompare(keyOf(b)),
  )
}
