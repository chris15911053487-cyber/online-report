/**
 * 一篇使用说明书的正文（server/help/*.md，GET /help/docs/:slug）。
 * 侧栏面板 HelpDocPanel 与说明书阅读页 HelpDocView 共用；配图相对路径 images/ 改写到 /api/help/images/。
 */
import { useEffect, useState } from 'react'
import ChatMarkdown from './ChatMarkdown'
import { apiFetch, apiUrl } from '../utils/api'
import { Notice, Skeleton } from '../ui'

export interface HelpDoc {
  slug: string
  title: string
  audience: 'all' | 'admin'
  content: string
}

function resolveHelpImages(md: string): string {
  return md.replace(/(!\[[^\]]*\]\(\s*)images\//g, `$1${apiUrl('/help/images/')}`)
}

/** 同一页面内看过的说明书不重复请求 */
const cache = new Map<string, HelpDoc>()

export default function HelpDocContent({ slug, onLoaded }: { slug: string; onLoaded?: (doc: HelpDoc) => void }) {
  // 只记录请求结果用于触发重渲染；内容一律从 cache 取
  const [, setLoadedSlug] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ slug: string; error: string } | null>(null)
  const doc = cache.get(slug)

  useEffect(() => {
    const hit = cache.get(slug)
    if (hit) {
      onLoaded?.(hit)
      return
    }
    let alive = true
    apiFetch(`/help/docs/${encodeURIComponent(slug)}`)
      .then((d: HelpDoc) => {
        cache.set(slug, d)
        if (!alive) return
        setLoadedSlug(slug)
        onLoaded?.(d)
      })
      .catch((err: unknown) => alive && setFailed({ slug, error: err instanceof Error ? err.message : '加载失败' }))
    return () => {
      alive = false
    }
    // onLoaded 只是通知，不作为重新请求的依据
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  if (doc) return <ChatMarkdown raw content={resolveHelpImages(doc.content)} />
  if (failed?.slug === slug) return <Notice tone="danger">{failed.error}</Notice>
  return <Skeleton className="h-60" />
}
