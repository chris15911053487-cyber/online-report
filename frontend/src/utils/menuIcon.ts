/** 菜单图标：按 routeKey / 名称关键词映射到 lucide 线性图标，与侧边栏风格一致；匹配不到时才用菜单配置里的 icon 文本 */
import {
  BarChart3,
  Boxes,
  Calculator,
  ClipboardCheck,
  Factory,
  FileText,
  RotateCcw,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { NavMenuItem } from '../types'

const BY_ROUTE: Record<string, LucideIcon> = {
  'pro-sign': Factory,
  orders: ShoppingCart,
  'menu-settings': Settings,
}

/** 顺序即优先级：先匹配更具体的词 */
const BY_KEYWORD: [RegExp, LucideIcon][] = [
  [/返工|退料|领料/, RotateCcw],
  [/报工|生产|工单|工序|车间/, Factory],
  [/质检|检验|质量|品质/, ClipboardCheck],
  [/成本|核算|价格/, Calculator],
  [/应收|应付|收款|付款|账款|财务|费用|发票/, Wallet],
  [/采购|供应商|送货|发货|物流/, Truck],
  [/销售|订单|客户/, ShoppingCart],
  [/库存|仓库|物料|入库|出库|盘点/, Boxes],
  [/设备|维修|保养|模具/, Wrench],
  [/人员|员工|考勤|工资/, Users],
  [/看板|分析|统计|汇总|趋势/, BarChart3],
  [/设置|配置/, Settings],
]

export function menuLucideIcon(menu: Pick<NavMenuItem, 'routeKey' | 'label'>): LucideIcon | null {
  const byRoute = BY_ROUTE[menu.routeKey]
  if (byRoute) return byRoute
  const label = menu.label || ''
  for (const [re, icon] of BY_KEYWORD) if (re.test(label)) return icon
  return null
}

/** 匹配不到关键词时：有配置的 icon 文本就用文本，否则通用文档图标 */
export function menuIcon(menu: Pick<NavMenuItem, 'routeKey' | 'label' | 'icon'>): { Icon: LucideIcon } | { text: string } {
  const Icon = menuLucideIcon(menu)
  if (Icon) return { Icon }
  const text = menu.icon?.trim()
  return text ? { text } : { Icon: FileText }
}

/** 卡片副标题：菜单没有说明字段，按类型给一个简短提示 */
export function menuKindLabel(menu: Pick<NavMenuItem, 'routeKey' | 'menuKind'>): string {
  if (menu.routeKey === 'pro-sign') return '报工'
  if (menu.menuKind === 'report') return '报表查询'
  return '功能'
}
