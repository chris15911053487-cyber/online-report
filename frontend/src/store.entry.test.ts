import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from './store'
import type { NavMenuItem } from './types'

const menu = { routeKey: 'purchase', label: '采购报表', menuKind: 'report' } as unknown as NavMenuItem
const other = { routeKey: 'stock', label: '库存报表', menuKind: 'report' } as unknown as NavMenuItem

describe('工作台回到上次打开的报表', () => {
  beforeEach(() => {
    useStore.setState({
      currentView: 'catalog', activeMenu: null, proSignMode: false, workbenchResume: null,
      currentAgentKey: null, currentAgentLabel: null, helpDocSlug: null, viewHistory: [],
    })
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

describe('Agent 入口回到上次打开的 Agent', () => {
  beforeEach(() => {
    useStore.setState({ currentView: 'agent-hub', currentAgentKey: null, currentAgentLabel: null, viewHistory: [] })
  })

  it('从 Agent 切到设置后点 Agent，回到该 Agent', () => {
    useStore.getState().openAgent('sales-analysis')
    useStore.setState({ currentAgentLabel: '销售分析 Agent' })
    useStore.getState().setView('settings')
    useStore.getState().openEntry('agent-hub')
    const s = useStore.getState()
    expect(s.currentView).toBe('agent-run')
    expect(s.currentAgentKey).toBe('sales-analysis')
    expect(s.currentAgentLabel).toBe('销售分析 Agent')
  })

  it('在 Agent 页上再点 Agent 入口，关掉回到列表', () => {
    useStore.getState().openAgent('sales-analysis')
    useStore.getState().openEntry('agent-hub')
    expect(useStore.getState().currentView).toBe('agent-hub')
    expect(useStore.getState().currentAgentKey).toBeNull()
    useStore.getState().setView('settings')
    useStore.getState().openEntry('agent-hub')
    expect(useStore.getState().currentView).toBe('agent-hub')
  })

  it('返回键关掉 Agent 后不再回到它', () => {
    useStore.getState().openAgent('sales-analysis')
    useStore.getState().goBack()
    useStore.getState().setView('settings')
    useStore.getState().openEntry('agent-hub')
    expect(useStore.getState().currentView).toBe('agent-hub')
  })

  it('再次打开同一个 Agent 保留标题，换 Agent 清空标题', () => {
    useStore.getState().openAgent('sales-analysis')
    useStore.setState({ currentAgentLabel: '销售分析 Agent' })
    useStore.getState().openAgent('sales-analysis')
    expect(useStore.getState().currentAgentLabel).toBe('销售分析 Agent')
    useStore.getState().openAgent('finance')
    expect(useStore.getState().currentAgentLabel).toBeNull()
  })
})

describe('使用说明入口回到上次那篇', () => {
  beforeEach(() => {
    useStore.setState({ currentView: 'help', helpDocSlug: null, viewHistory: [] })
  })

  it('从说明书切到设置后点使用说明，回到那篇；再点回到列表', () => {
    useStore.getState().openHelpDoc('bi-dashboard')
    useStore.getState().setView('settings')
    useStore.getState().openEntry('help')
    expect(useStore.getState().currentView).toBe('help-doc')
    expect(useStore.getState().helpDocSlug).toBe('bi-dashboard')
    useStore.getState().openEntry('help')
    expect(useStore.getState().currentView).toBe('help')
    expect(useStore.getState().helpDocSlug).toBeNull()
  })
})
