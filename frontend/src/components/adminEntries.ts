import { Bell, Bot, CalendarClock, LayoutDashboard, ListTree, Megaphone, Sparkles, type LucideIcon } from 'lucide-react'
import type { ViewName } from '../types'

/** 管理后台的各个入口（管理后台首页、PC 侧栏、面包屑共用） */
export interface AdminEntry {
  view: ViewName
  label: string
  description: string
  icon: LucideIcon
}

export const ADMIN_ENTRIES: AdminEntry[] = [
  { view: 'agents-admin', label: 'Agent 配置', description: '对话入口、可用 Skill、关联看板', icon: Bot },
  { view: 'bi-admin', label: 'BI 看板管理', description: '查询库与看板卡片', icon: LayoutDashboard },
  { view: 'ai-skills', label: 'AI Skill', description: '工作流、表白名单与资源', icon: Sparkles },
  { view: 'menu-settings', label: '菜单与角色', description: '菜单配置、角色定义、用户角色', icon: ListTree },
  { view: 'message-alert-settings', label: '消息提醒', description: '提醒规则与刷新频率', icon: Bell },
  { view: 'alert-push', label: '警报推送', description: '预警规则与钉钉群推送', icon: Megaphone },
  { view: 'scheduled-reports', label: '定时报告', description: '按计划生成并推送报告', icon: CalendarClock },
]

export const ADMIN_VIEWS = new Set<ViewName>(['admin', ...ADMIN_ENTRIES.map((e) => e.view)])
