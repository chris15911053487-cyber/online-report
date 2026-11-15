import { describe, expect, it } from 'vitest'
import { buildLineage } from './biLineage'
import ELK from 'elkjs/lib/elk.bundled.js'
import { layoutLineage } from './biLineageLayout'

const elk = new ELK()

const l = buildLineage({
  queries: [
    { queryKey: 'a', label: 'A', enabled: true },
    { queryKey: 'lonely', label: '孤立查询', enabled: true },
  ],
  charts: [{ chartKey: 'x', label: 'X', type: 'bar', enabled: true, queryKey: 'a' }],
  dashboards: [{ dashboardKey: 'd', label: 'D', enabled: true, cards: [{ chartKey: 'x' }], usedByAgents: ['ag'] }],
})

describe('layoutLineage', () => {
  it('四类节点从左到右分列，孤立节点也留在自己的列', async () => {
    const pos = await layoutLineage(l, null, { elk })
    const x = (id: string) => pos.get(id)!.x
    expect(x('q:a')).toBeLessThan(x('c:x'))
    expect(x('c:x')).toBeLessThan(x('d:d'))
    expect(x('d:d')).toBeLessThan(x('a:ag'))
    expect(x('q:lonely')).toBe(x('q:a'))
  })
  it('节点高度可调（缩略图模式）：同列节点不重叠', async () => {
    const pos = await layoutLineage(l, null, { elk, height: 136 })
    expect(Math.abs(pos.get('q:a')!.y - pos.get('q:lonely')!.y)).toBeGreaterThanOrEqual(136)
  })
  it('只排可见节点', async () => {
    const pos = await layoutLineage(l, new Set(['q:a', 'c:x']), { elk })
    expect([...pos.keys()].sort()).toEqual(['c:x', 'q:a'])
  })
})
