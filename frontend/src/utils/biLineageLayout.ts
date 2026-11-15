/**
 * BI 关系图排版：elkjs 分层布局（从左到右），四类节点强制分在四列（partitioning），
 * 列内顺序由 elk 做交叉最小化，初始顺序沿用 biLineage 的重心排序。
 * 浏览器里 elk 跑在 Web Worker（elk-worker.min.js 单独一个文件，打开关系图才下载），不卡界面；
 * 单测传入 elk.bundled 实例。
 */
import type { ELK as ElkInstance } from 'elkjs/lib/elk-api'
import type { Lineage, LineageKind } from './biLineage'

export const NODE_W = 216
export const NODE_H = 58

const PARTITION: Record<LineageKind, number> = { query: 0, chart: 1, dashboard: 2, consumer: 3 }

let workerElk: Promise<ElkInstance> | null = null
function defaultElk(): Promise<ElkInstance> {
  workerElk ??= Promise.all([import('elkjs/lib/elk-api'), import('elkjs/lib/elk-worker.min.js?url')]).then(([api, url]) => new api.default({ workerUrl: url.default }))
  return workerElk
}

export async function layoutLineage(lineage: Lineage, visible: Set<string> | null, elkInstance?: ElkInstance): Promise<Map<string, { x: number; y: number }>> {
  const elk = elkInstance ?? (await defaultElk())
  const show = (id: string) => !visible || visible.has(id)
  const children = (['query', 'chart', 'dashboard', 'consumer'] as LineageKind[]).flatMap((k) =>
    lineage.columns[k]
      .filter((n) => show(n.id))
      .map((n) => ({ id: n.id, width: NODE_W, height: NODE_H, layoutOptions: { 'elk.partitioning.partition': String(PARTITION[k]) } })),
  )
  const edges = lineage.edges.filter((e) => show(e.from) && show(e.to)).map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] }))
  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.partitioning.activate': 'true',
      'elk.layered.spacing.nodeNodeBetweenLayers': '150',
      'elk.spacing.nodeNode': '16',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.separateConnectedComponents': 'false',
    },
    children,
    edges,
  })
  return new Map((res.children || []).map((c) => [c.id, { x: c.x || 0, y: c.y || 0 }]))
}
