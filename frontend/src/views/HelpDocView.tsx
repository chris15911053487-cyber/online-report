/** 一篇使用说明书（/help/:slug）；顶栏标题用说明书标题 */
import { useEffect } from 'react'
import { useStore } from '../store'
import HelpDocContent from '../components/HelpDocContent'
import { Card, EmptyState } from '../ui'

export default function HelpDocView() {
  const slug = useStore((s) => s.helpDocSlug)
  const setHelpDocTitle = useStore((s) => s.setHelpDocTitle)

  useEffect(() => () => setHelpDocTitle(null), [setHelpDocTitle])

  return (
    <div className="p-4 lg:p-6 max-w-4xl mx-auto">
      <Card className="px-4 py-4 lg:px-8 lg:py-6">
        {slug ? <HelpDocContent slug={slug} onLoaded={(d) => setHelpDocTitle(d.title)} /> : <EmptyState title="没有选中说明书" />}
      </Card>
    </div>
  )
}
