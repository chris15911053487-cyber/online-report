import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from './store'
import type { NavMenuItem } from './types'

const menu = { routeKey: 'purchase', label: '采购报表', menuKind: 'report' } as unknown as NavMenuItem
const other = { routeKey: 'stock', label: '库存报表', menuKind: 'report' } as unknown as NavMenuItem

describe('工作台回到上次打开的报表', () => {
  beforeEach(() => {
    useStore.setState({ currentView: 'catalog', activeMenu: null, proSignMode: false, workbenchResume: null })
  })

  it('从报表切到设置后点工作台，回到该报表', () => {
    const s = useStore.getState()
    s.openMenu(menu)
    s.setView('settings')
    expect(useStore.getState().workbenchResume?.menu.routeKey).toBe('purchase')
    useStore.getState().openWorkbench()
    expect(useStore.getState().currentView).toBe('dynamic-report')
    expect(useStore.getState().activeMenu?.routeKey).toBe('purchase')
    expect(useStore.getState().workbenchResume).toBeNull()
  })

  it('回到报表后再点工作台，进入工作台列表', () => {
    const s = useStore.getState()
    s.openMenu(menu)
    s.setView('agent-hub')
    useStore.getState().openWorkbench()
    useStore.getState().openWorkbench()
    expect(useStore.getState().currentView).toBe('catalog')
  })

  it('打开别的报表后不再记住旧报表', () => {
    const s = useStore.getState()
    s.openMenu(menu)
    s.setView('settings')
    useStore.getState().openMenu(other)
    useStore.getState().setView('messages')
    useStore.getState().openWorkbench()
    expect(useStore.getState().activeMenu?.routeKey).toBe('stock')
  })

  it('没有打开过报表时，点工作台就是列表', () => {
    useStore.getState().setView('settings')
    useStore.getState().openWorkbench()
    expect(useStore.getState().currentView).toBe('catalog')
  })

  it('合并报工模式回到时保持模式', () => {
    const s = useStore.getState()
    s.openProSign(menu)
    s.setView('settings')
    useStore.getState().openWorkbench()
    expect(useStore.getState().proSignMode).toBe(true)
  })
})
