import { describe, expect, it } from 'vitest'
import { formatCardValue, inferBadgeTone, normalizeCardConfig, resolveCard } from './reportCard'

// 生产报工（Z_ONLINE_TOOWORSIGN）的配置，列名来自各状态的真实返回
const CFG = normalizeCardConfig({
  title: ['DocEntry', '工序'],
  titleNote: ['工序'],
  badge: ['动作', '类型'],
  subtitle: '物料名称',
  subNote: ['物料编码'],
  metric: ['未恢复数量', '数量', '接单数量', '已接单数量', '未接单数量', '计划数量'],
  meta: [['接单人员', '接单人', '报工人'], ['接单时间', '报工时间']],
  progress: { done: ['完工数量', '已完工数量'], total: ['接单数量', '已接单数量'] },
  hidden: ['StepCode', 'BaseOType', 'BaseOEntry', 'BaseOLine', '工序ID'],
})!

const TECH = { StepCode: 'Z101', BaseOType: 'X_ONLINE_SIGN', BaseOEntry: 27859, BaseOLine: 1, 工序ID: 0 }

describe('normalizeCardConfig', () => {
  it('没有任何位置或结构不对时返回 null', () => {
    expect(normalizeCardConfig(null)).toBeNull()
    expect(normalizeCardConfig([])).toBeNull()
    expect(normalizeCardConfig({ hidden: ['a'] })).toBeNull()
  })
  it('单个字符串当作一个候选，丢弃无效配色', () => {
    const c = normalizeCardConfig({ title: 'DocEntry', badgeTones: { 待接单: 'neutral', 坏: 'pink' } })!
    expect(c.title).toEqual(['DocEntry'])
    expect(c.badgeTones).toEqual({ 待接单: 'neutral' })
  })
})

describe('resolveCard', () => {
  it('Z1 没有单号（DocEntry=0）时用工序当标题，小字不重复工序', () => {
    const row = { DocEntry: 0, 工序: 'Z101 复卷', 动作: '未完工', 接单人员: 'manager,A083', 接单时间: '2026-07-08 08:43', 接单数量: '8.00', 完工数量: null, 暂停数量: null, ...TECH }
    const c = resolveCard(row, CFG)
    expect(c.title).toEqual({ col: '工序', value: 'Z101 复卷' })
    expect(c.titleNote).toBeNull()
    expect(c.badge).toMatchObject({ value: '未完工', tone: 'info' })
    expect(c.subtitle).toBeNull()
    expect(c.metric).toEqual({ col: '接单数量', value: '8.00' })
    expect(c.meta.map((m) => m.col)).toEqual(['接单人员', '接单时间'])
    expect(c.progress).toMatchObject({ done: 0, total: 8 })
    // DocEntry / 内部列 / 空值都不进下半部分
    expect(c.rest).toEqual([])
  })

  it('Z0 待接单：单号当标题，未接单数量当大数，其余字段按返回顺序', () => {
    const row = { DocEntry: 900007, 物料名称: '凯芙拉网格输送带', 工序: 'Z001 返工单', 计划数量: '1.000000', 已接单数量: null, 未接单数量: '1.00', 物料编码: 'B501-111', ...TECH }
    const c = resolveCard(row, CFG)
    expect(c.title).toEqual({ col: 'DocEntry', value: 900007 })
    expect(c.titleNote).toEqual({ col: '工序', value: 'Z001 返工单' })
    expect(c.subNote?.value).toBe('B501-111')
    // 已接单数量排在前面但为空 → 取有值的未接单数量
    expect(c.metric?.col).toBe('未接单数量')
    expect(c.meta).toEqual([])
    expect(c.rest.map((f) => f.col)).toEqual(['计划数量'])
  })

  it('候选列都为空时，大数位置仍占位', () => {
    const c = resolveCard({ DocEntry: 1, 接单数量: null }, CFG)
    expect(c.metric).toEqual({ col: '接单数量', value: null })
  })

  it('已完工：取「数量」，类型做标签', () => {
    const row = { DocEntry: 900005, 物料编码: 'B501-108', 物料名称: 'x', 工序: 'Z001 返工单', 类型: '完工', 数量: '2.00', 报工时间: '2026-07-21 16:20', 报工人: 'A086', 报工单号: 'BG1', BaseOType: 'X', BaseOEntry: 1, BaseOLine: 1 }
    const c = resolveCard(row, CFG)
    expect(c.metric?.col).toBe('数量')
    expect(c.badge).toMatchObject({ value: '完工', tone: 'success' })
    expect(c.titleNote?.value).toBe('Z001 返工单')
    expect(c.meta.map((m) => m.col)).toEqual(['报工人', '报工时间'])
    expect(c.rest.map((f) => f.col)).toEqual(['报工单号'])
  })

  it('列名不区分大小写，配置的配色优先', () => {
    const cfg = normalizeCardConfig({ title: ['docentry'], badge: ['status'], badgeTones: { 待接单: 'warning' } })!
    const c = resolveCard({ DocEntry: 5, Status: '待接单' }, cfg)
    expect(c.title?.col).toBe('DocEntry')
    expect(c.badge?.tone).toBe('warning')
  })
})

describe('formatCardValue / inferBadgeTone', () => {
  it('数字去掉多余小数', () => {
    expect(formatCardValue('1.000000')).toBe('1')
    expect(formatCardValue('8.50')).toBe('8.5')
    expect(formatCardValue(900006)).toBe('900006')
    expect(formatCardValue(12345, true)).toBe('12,345')
    expect(formatCardValue('B501-111')).toBe('B501-111')
    expect(formatCardValue(null)).toBe('')
  })
  it('按关键字推断标签颜色', () => {
    expect(inferBadgeTone('待接单')).toBe('neutral')
    expect(inferBadgeTone('未完工')).toBe('info')
    expect(inferBadgeTone('已完工')).toBe('success')
    expect(inferBadgeTone('暂停')).toBe('warning')
  })
})
