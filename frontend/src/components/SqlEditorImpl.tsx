/**
 * SQL 代码编辑器（CodeMirror 6，SQL Server 方言）：语法高亮、行号、括号匹配、自动缩进、撤销、
 * 关键字补全与 @参数补全。颜色全部取主题变量，切换主题自动跟随。
 * 体积较大，经 SqlEditor.tsx 懒加载，不进首屏包。
 */
import { useEffect, useRef } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder as cmPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from '@codemirror/autocomplete'
import { sql, MSSQL } from '@codemirror/lang-sql'
import { tags as t } from '@lezer/highlight'

export interface SqlEditorProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** 编辑区高度（CSS 值），如 '20rem'、'100%' */
  height?: string
  /** 补全用的 @参数名（不带 @） */
  paramNames?: string[]
}

const v = (name: string, alpha?: number) => (alpha == null ? `rgb(var(--c-${name}))` : `rgb(var(--c-${name}) / ${alpha})`)

const theme = EditorView.theme({
  '&': { color: v('fg'), backgroundColor: v('surface'), fontSize: '12px', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.6' },
  '.cm-content': { caretColor: v('primary'), padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: v('primary') },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: v('primary', 0.18) },
  '.cm-gutters': { backgroundColor: v('surface-2'), color: v('subtle'), border: 'none', borderRight: `1px solid ${v('line')}` },
  '.cm-activeLine': { backgroundColor: v('primary', 0.05) },
  '.cm-activeLineGutter': { backgroundColor: v('primary', 0.1), color: v('fg-2') },
  '.cm-matchingBracket': { backgroundColor: v('primary', 0.2), outline: `1px solid ${v('primary', 0.4)}` },
  '.cm-placeholder': { color: v('subtle') },
  '.cm-tooltip': { backgroundColor: v('surface'), border: `1px solid ${v('line-strong')}`, borderRadius: '8px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul > li': { color: v('fg-2'), padding: '2px 8px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: v('primary-soft'), color: v('fg') },
  '.cm-completionDetail': { color: v('subtle'), fontStyle: 'normal', marginLeft: '8px' },
})

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: v('primary-text'), fontWeight: '600' },
  { tag: [t.typeName, t.standard(t.name)], color: v('accent') },
  { tag: [t.string, t.special(t.string)], color: v('success') },
  { tag: [t.number, t.bool, t.null], color: v('warning') },
  { tag: [t.lineComment, t.blockComment, t.comment], color: v('subtle'), fontStyle: 'italic' },
  { tag: [t.special(t.name), t.variableName], color: v('info') },
  { tag: [t.punctuation, t.operator, t.bracket], color: v('muted') },
])

export default function SqlEditorImpl({ value, onChange, placeholder, height = '20rem', paramNames = [] }: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const paramsRef = useRef(paramNames)
  const placeholderConf = useRef(new Compartment())

  useEffect(() => {
    onChangeRef.current = onChange
    paramsRef.current = paramNames
  })

  // @参数补全：当前查询已有的参数 + 系统代入的登录人
  const paramCompletion = (ctx: CompletionContext) => {
    const word = ctx.matchBefore(/@\w*/)
    if (!word || (word.from === word.to && !ctx.explicit)) return null
    const names = [...new Set([...paramsRef.current, '_loginUser', '_loginDisplayName'])]
    return {
      from: word.from,
      options: names.map((n) => ({ label: `@${n}`, type: 'variable', detail: n.startsWith('_login') ? '系统代入' : '参数' })),
      validFor: /^@\w*$/,
    }
  }

  useEffect(() => {
    if (!host.current) return
    const lang = sql({ dialect: MSSQL, upperCaseKeywords: true })
    const ed = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          lang,
          lang.language.data.of({ autocomplete: paramCompletion }),
          autocompletion(),
          syntaxHighlighting(highlight),
          theme,
          EditorView.lineWrapping,
          placeholderConf.current.of(placeholder ? cmPlaceholder(placeholder) : []),
          keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = ed
    return () => {
      ed.destroy()
      view.current = null
    }
    // 只在挂载时建一次编辑器；后续 value 变化走下面的同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部改了值（AI 修改、撤销、切换查询）：同步进编辑器，用户自己输入时两边相同不会重复写
  useEffect(() => {
    const ed = view.current
    if (!ed) return
    const cur = ed.state.doc.toString()
    if (cur !== value) ed.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: placeholderConf.current.reconfigure(placeholder ? cmPlaceholder(placeholder) : []) })
  }, [placeholder])

  return <div ref={host} style={{ height }} className="overflow-hidden" />
}
