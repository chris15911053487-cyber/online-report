/** 工具步骤的参数展示：把 args 整理成「字段：值」行，供执行过程面板使用 */

function formatArgValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 118)}…` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    const s = JSON.stringify(v)
    return s.length > 160 ? `${s.slice(0, 158)}…` : s
  } catch {
    return String(v)
  }
}

export function formatStepArgs(step: { tool: string; args?: Record<string, unknown> }): string[] {
  const args = step.args || {}
  const lines: string[] = []
  const tool = step.tool

  if (tool === 'knowledge_search' && args.query) {
    lines.push(`问题：${formatArgValue(args.query)}`)
  } else if (tool === 'read_skill_resource') {
    if (args.skill_name) lines.push(`Skill：${formatArgValue(args.skill_name)}`)
    if (args.path) lines.push(`资源：${formatArgValue(args.path)}`)
  } else if (tool === 'lookup_options') {
    if (args.route_key) lines.push(`报表：${formatArgValue(args.route_key)}`)
    if (args.field_name) lines.push(`字段：${formatArgValue(args.field_name)}`)
    if (args.keyword) lines.push(`关键词：${formatArgValue(args.keyword)}`)
  } else if (tool === 'run_report') {
    if (args.route_key) lines.push(`报表：${formatArgValue(args.route_key)}`)
    if (args.params) lines.push(`参数：${formatArgValue(args.params)}`)
  } else if (tool === 'run_named_query') {
    if (args.query_key) lines.push(`查询：${formatArgValue(args.query_key)}`)
    if (args.params) lines.push(`参数：${formatArgValue(args.params)}`)
  } else if (tool === 'run_sql') {
    if (args.skill_name) lines.push(`Skill：${formatArgValue(args.skill_name)}`)
    if (args.sql_query) lines.push(`sql_query：${formatArgValue(args.sql_query)}`)
  } else if (tool === 'ask_user_to_choose') {
    if (args.field) lines.push(`字段：${formatArgValue(args.field)}`)
    if (args.question) lines.push(`问题：${formatArgValue(args.question)}`)
  } else if (tool === 'save_record') {
    if (args.entity) lines.push(`实体：${formatArgValue(args.entity)}`)
    if (args.payload) lines.push(`内容：${formatArgValue(args.payload)}`)
  } else if (tool === 'generate_document') {
    if (args.title) lines.push(`标题：${formatArgValue(args.title)}`)
    if (args.fmt) lines.push(`格式：${formatArgValue(args.fmt)}`)
  } else if (tool === 'generate_chart') {
    if (args.title) lines.push(`标题：${formatArgValue(args.title)}`)
    if (args.chart_type) lines.push(`类型：${formatArgValue(args.chart_type)}`)
  } else {
    for (const [k, v] of Object.entries(args)) {
      if (v != null && v !== '') lines.push(`${k}：${formatArgValue(v)}`)
    }
  }
  return lines
}
