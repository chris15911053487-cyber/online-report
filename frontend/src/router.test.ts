import { describe, expect, it } from 'vitest'
import { isPlainClick, menuPath, parsePath, pathFor, type RouteState } from './router'
import { resolveTheme } from './theme'

const base: RouteState = {
  currentView: 'catalog',
  activeMenu: null,
  currentAgentKey: null,
  proSignOrderDetailOrderNo: null,
  currentOrderId: null,
  workRegBatchId: null,
}
const at = (p: Partial<RouteState>): RouteState => ({ ...base, ...p })

describe('pathFor', () => {
  it('普通页面与管理页', () => {
    expect(pathFor(at({}))).toBe('/')
    expect(pathFor(at({ currentView: 'ai' }))).toBe('/ai')
    expect(pathFor(at({ currentView: 'agent-hub' }))).toBe('/agents')
    expect(pathFor(at({ currentView: 'settings' }))).toBe('/settings')
    expect(pathFor(at({ currentView: 'admin' }))).toBe('/admin')
    expect(pathFor(at({ currentView: 'bi-admin' }))).toBe('/admin/bi')
    expect(pathFor(at({ currentView: 'menu-settings' }))).toBe('/admin/menus')
  })

  it('带参数的页面，参数做 URL 编码', () => {
    const rk = { routeKey: 'pro-sign' }
    expect(pathFor(at({ currentView: 'agent-run', currentAgentKey: 'finance' }))).toBe('/agents/finance')
    expect(pathFor(at({ currentView: 'dynamic-report', activeMenu: rk }))).toBe('/report/pro-sign')
    expect(pathFor(at({ currentView: 'pro-sign-receive', activeMenu: rk }))).toBe('/report/pro-sign/merge')
    expect(pathFor(at({ currentView: 'report-row-detail', activeMenu: rk }))).toBe('/report/pro-sign/row')
    expect(pathFor(at({ currentView: 'pro-sign-order-detail', activeMenu: rk, proSignOrderDetailOrderNo: 'SO 1/2' }))).toBe('/report/pro-sign/order/SO%201%2F2')
    expect(pathFor(at({ currentView: 'work-registration', activeMenu: rk, workRegBatchId: 12 }))).toBe('/report/pro-sign/batch/12')
    expect(pathFor(at({ currentView: 'work-registration', workRegBatchId: 12 }))).toBe('/work-registration/12')
    expect(pathFor(at({ currentView: 'detail', currentOrderId: 7 }))).toBe('/orders/7')
  })
})

describe('menuPath', () => {
  it('与 openMenuItem 分支一致，且能被 parsePath 解析回去', () => {
    expect(menuPath({ routeKey: 'orders', menuKind: 'builtin' })).toBe('/owor')
    expect(menuPath({ routeKey: 'menu-settings', menuKind: 'builtin' })).toBe('/admin/menus')
    expect(menuPath({ routeKey: 'pro-sign', menuKind: 'builtin' })).toBe('/report/pro-sign')
    expect(menuPath({ routeKey: '库存 查询', menuKind: 'report' })).toBe('/report/%E5%BA%93%E5%AD%98%20%E6%9F%A5%E8%AF%A2')
    expect(parsePath(menuPath({ routeKey: '库存 查询', menuKind: 'report' })!)).toEqual({ kind: 'report', routeKey: '库存 查询' })
    expect(menuPath({ routeKey: 'unknown', menuKind: 'builtin' })).toBeNull()
  })
})

describe('isPlainClick', () => {
  const base = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }
  it('只有无修饰键的左键算页内点击', () => {
    expect(isPlainClick(base)).toBe(true)
    expect(isPlainClick({ ...base, ctrlKey: true })).toBe(false)
    expect(isPlainClick({ ...base, metaKey: true })).toBe(false)
    expect(isPlainClick({ ...base, button: 1 })).toBe(false)
  })
})

describe('parsePath', () => {
  it('与 pathFor 互逆', () => {
    expect(parsePath('/')).toEqual({ kind: 'view', view: 'catalog' })
    expect(parsePath('/messages/')).toEqual({ kind: 'view', view: 'messages' })
    expect(parsePath('/admin')).toEqual({ kind: 'view', view: 'admin' })
    expect(parsePath('/admin/skills')).toEqual({ kind: 'view', view: 'ai-skills' })
    expect(parsePath('/agents/finance')).toEqual({ kind: 'agent', agentKey: 'finance' })
    expect(parsePath('/report/pro-sign')).toEqual({ kind: 'report', routeKey: 'pro-sign' })
    expect(parsePath('/report/pro-sign/merge')).toEqual({ kind: 'report', routeKey: 'pro-sign', sub: 'merge' })
    expect(parsePath('/report/pro-sign/order/SO%201%2F2')).toEqual({ kind: 'proSignOrder', routeKey: 'pro-sign', orderNo: 'SO 1/2' })
    expect(parsePath('/report/pro-sign/batch/12')).toEqual({ kind: 'workReg', routeKey: 'pro-sign', batchId: 12 })
    expect(parsePath('/work-registration/12')).toEqual({ kind: 'workReg', routeKey: null, batchId: 12 })
    expect(parsePath('/orders/7')).toEqual({ kind: 'order', orderId: 7 })
  })

  it('无法识别的地址回首页', () => {
    expect(parsePath('/nope')).toEqual({ kind: 'view', view: 'catalog' })
    expect(parsePath('/admin/unknown')).toEqual({ kind: 'view', view: 'catalog' })
    expect(parsePath('/orders/abc')).toEqual({ kind: 'view', view: 'catalog' })
  })
})

describe('resolveTheme', () => {
  it('用户选择优先，未选用公司默认，跟随系统时深色用 F', () => {
    expect(resolveTheme('ent', 'warm', false)).toBe('ent')
    expect(resolveTheme(null, 'mono', false)).toBe('mono')
    expect(resolveTheme(null, null, false)).toBe('warm')
    expect(resolveTheme('system', 'tech', false)).toBe('tech')
    expect(resolveTheme('system', 'tech', true)).toBe('dark')
    expect(resolveTheme('bogus' as never, 'ind', false)).toBe('ind')
  })
})
