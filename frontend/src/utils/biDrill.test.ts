import { describe, expect, it } from 'vitest'
import type { BiCard } from './bi'
import {
  decodeDrillLink,
  drillOpenMode,
  drillPagePath,
  encodeDrillLink,
  nextOpensInPanel,
  openPanel,
  panelFromLink,
  pushDrill,
  rootStack,
  toDrillLink,
} from './biDrill'

const card: BiCard = {
  id: 'ar',
  type: 'bar',
  title: '应收账款',
  queryKey: 'fin_ar',
  params: {},
  encoding: { dimension: 'CardName', value: 'Balance' },
  drill: [
    { queryKey: 'fin_ar_month', label: '按月', bind: { cardCode: 'CardCode' }, params: {}, type: 'line', encoding: { dimension: 'Month', value: 'Balance' } },
    { queryKey: 'fin_ar_docs', label: '单据', bind: { month: 'Month' }, params: {}, type: 'table', encoding: {} },
  ],
  layout: { w: 6, h: 2 },
}

describe('下钻打开方式', () => {
  it('不写时：表格在明细面板，图表在卡片里；写了以配置为准', () => {
    expect(drillOpenMode({ type: 'table' })).toBe('panel')
    expect(drillOpenMode({ type: 'bar' })).toBe('inline')
    expect(drillOpenMode({ type: 'table', open: 'inline' })).toBe('inline')
    expect(drillOpenMode({ type: 'line', open: 'panel' })).toBe('panel')
  })
  it('nextOpensInPanel 看的是下一级', () => {
    const s0 = rootStack(card)
    expect(nextOpensInPanel(card, s0)).toBe(false)
    const s1 = pushDrill(card, s0, { CardCode: 'C1', CardName: '客户甲', Balance: 10 }, card.encoding)
    expect(nextOpensInPanel(card, s1)).toBe(true)
    const s2 = pushDrill(card, s1, { Month: '2026-09', Balance: 3 }, card.drill[0].encoding)
    expect(nextOpensInPanel(card, s2)).toBe(false) // 已到最深
  })
})

describe('下钻链接', () => {
  const s1 = pushDrill(card, rootStack(card), { CardCode: 'C1', CardName: '客户甲', Balance: 10 }, card.encoding)
  const s2 = pushDrill(card, s1, { Month: '2026-09', Balance: 3 }, card.drill[0].encoding)
  const panel = openPanel(card, s2)

  it('编码后可还原（含中文），不带点中的行', () => {
    const link = toDrillLink('finance', panel, { period: '2026-09', dept: ['A', 'B'] })
    const back = decodeDrillLink(encodeDrillLink(link))
    expect(back).toEqual(link)
    expect(back?.stack[2]).toEqual({ level: 2, bound: { cardCode: 'C1', month: '2026-09' }, crumb: '2026-09 · 单据' })
    expect(encodeDrillLink(link)).toMatch(/^[A-Za-z0-9_-]+$/) // 地址安全
    expect(drillPagePath(link)).toMatch(/^\/bi\/drill\?drill=/)
  })

  it('损坏 / 结构不对的链接返回 null', () => {
    expect(decodeDrillLink(null)).toBeNull()
    expect(decodeDrillLink('%%%')).toBeNull()
    expect(decodeDrillLink(btoa(JSON.stringify({ v: 1, a: 'x', c: 'y', s: [], b: 0 })))).toBeNull()
    expect(decodeDrillLink(btoa(JSON.stringify({ v: 2, a: 'x', c: 'y', s: [[0, {}, 't']], b: 0 })))).toBeNull()
  })

  it('panelFromLink：卡片对得上才还原；下钻层级被改少了则放弃', () => {
    const link = decodeDrillLink(encodeDrillLink(toDrillLink('finance', panel, {})))!
    const p = panelFromLink(card, link)
    expect(p?.base).toBe(2)
    expect(p?.stack.map((f) => f.level)).toEqual([0, 1, 2])
    expect(panelFromLink({ ...card, id: 'other' }, link)).toBeNull()
    expect(panelFromLink({ ...card, drill: card.drill.slice(0, 1) }, link)).toBeNull()
  })
})
