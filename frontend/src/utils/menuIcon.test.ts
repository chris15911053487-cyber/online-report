import { describe, expect, it } from 'vitest'
import { Boxes, Factory, FileText, RotateCcw, Wallet } from 'lucide-react'
import { menuIcon, menuKindLabel, menuLucideIcon } from './menuIcon'

describe('menuLucideIcon', () => {
  it('routeKey 优先', () => {
    expect(menuLucideIcon({ routeKey: 'pro-sign', label: '随便' })).toBe(Factory)
  })
  it('按名称关键词匹配，具体词优先', () => {
    expect(menuLucideIcon({ routeKey: 'r1', label: '原材料库存查询' })).toBe(Boxes)
    expect(menuLucideIcon({ routeKey: 'r2', label: '应收账款明细' })).toBe(Wallet)
    expect(menuLucideIcon({ routeKey: 'r3', label: '生产返工领料' })).toBe(RotateCcw)
  })
  it('匹配不到返回 null', () => {
    expect(menuLucideIcon({ routeKey: 'x', label: '其它' })).toBeNull()
  })
})

describe('menuIcon', () => {
  it('匹配不到时用配置的 icon 文本，再兜底文档图标', () => {
    expect(menuIcon({ routeKey: 'x', label: '其它', icon: ' 📋 ' })).toEqual({ text: '📋' })
    expect(menuIcon({ routeKey: 'x', label: '其它', icon: '' })).toEqual({ Icon: FileText })
  })
})

describe('menuKindLabel', () => {
  it('区分报工、报表与内置功能', () => {
    expect(menuKindLabel({ routeKey: 'pro-sign', menuKind: 'builtin' })).toBe('报工')
    expect(menuKindLabel({ routeKey: 'r', menuKind: 'report' })).toBe('报表查询')
    expect(menuKindLabel({ routeKey: 'x', menuKind: 'builtin' })).toBe('功能')
  })
})
