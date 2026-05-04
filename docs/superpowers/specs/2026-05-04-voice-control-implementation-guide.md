# 语音控制功能 — 实现指南

## 技术方案

浏览器 Web Speech API + 前端指令注册表 + 关键词模糊匹配。纯前端，无后端依赖。仅 Chrome/Edge 支持（Firefox/Safari 按钮自动隐藏）。

交互：右下角浮动麦克风按钮，**按住说话、松手执行**。

## 涉及文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `frontend/src/voice/voiceCommandRegistry.ts` | 新建 | 指令注册表核心 |
| `frontend/src/voice/voiceCommands.ts` | 新建 | 全局指令（返回/后退/退出） |
| `frontend/src/voice/VoiceFloatingButton.tsx` | 新建 | 浮动麦克风按钮组件 |
| `frontend/src/store.ts` | 修改 | 新增 voice/导航相关状态 |
| `frontend/src/components/MainLayout.tsx` | 修改 | 挂载 VoiceFloatingButton |

---

## 1. `frontend/src/voice/voiceCommandRegistry.ts` — 指令注册表

```typescript
export interface VoiceCommand {
  id: string
  keywords: string[]
  description: string
  handler: (params: Record<string, string>) => void
}

// 按视图分组存储指令
const viewCommands = new Map<string, VoiceCommand[]>()
// 全局指令（所有视图生效）
const globalCommands: VoiceCommand[] = []

export function registerCommands(viewId: string, commands: VoiceCommand[]) {
  viewCommands.set(viewId, commands)
}

export function unregisterCommands(viewId: string) {
  viewCommands.delete(viewId)
}

export function registerGlobalCommands(commands: VoiceCommand[]) {
  globalCommands.length = 0
  globalCommands.push(...commands)
}

/**
 * 匹配用户语音文本
 * - 对每个指令的关键词做 substring 匹配
 * - 命中关键词数量 = 分数
 * - view 级指令优先级高于全局指令
 * - 至少命中 1 个关键词才返回
 */
export function match(
  text: string,
  currentView: string
): { command: VoiceCommand; params: Record<string, string> } | null {
  let bestScore = 0
  let best: VoiceCommand | null = null

  const tryMatch = (commands: VoiceCommand[], priority: number) => {
    for (const cmd of commands) {
      let score = 0
      for (const kw of cmd.keywords) {
        if (text.includes(kw)) score++
      }
      const effectiveScore = score + priority
      if (effectiveScore > bestScore) {
        bestScore = effectiveScore
        best = cmd
      }
    }
  }

  // 先匹配 view 级指令（priority=10，高于全局）
  const cmds = viewCommands.get(currentView)
  if (cmds) tryMatch(cmds, 10)

  // 再匹配全局指令（priority=0）
  tryMatch(globalCommands, 0)

  if (best && bestScore >= 1) {
    return {
      command: best,
      params: { _rest: text }, // 后续可从 _rest 中提取参数
    }
  }
  return null
}
```

## 2. `frontend/src/voice/voiceCommands.ts` — 全局指令

```typescript
import { registerGlobalCommands } from './voiceCommandRegistry'
import { useStore } from '../store'

export function initGlobalCommands() {
  const store = useStore.getState()

  registerGlobalCommands([
    {
      id: 'nav:catalog',
      keywords: ['返回', '主界面', '目录', '首页', '主页'],
      description: '返回主界面',
      handler: () => store.setView('catalog'),
    },
    {
      id: 'nav:back',
      keywords: ['返回上一页', '后退', '上一页'],
      description: '返回上一页',
      handler: () => store.goBack(),
    },
    {
      id: 'auth:logout',
      keywords: ['退出登录', '注销', '登出'],
      description: '退出登录',
      handler: () => store.logout(),
    },
  ])
}
```

## 3. `frontend/src/voice/VoiceFloatingButton.tsx` — 浮动按钮

```tsx
import { useRef, useCallback, useState, useEffect } from 'react'
import { Mic } from 'lucide-react'
import { useStore } from '../store'
import { match } from './voiceCommandRegistry'
import { initGlobalCommands } from './voiceCommands'

// 确保全局指令只初始化一次
let globalCommandsInitialized = false

export default function VoiceFloatingButton() {
  const { voiceSupported, currentView, showToast } = useStore()
  const recognitionRef = useRef<any>(null)
  const downAtRef = useRef(0)
  const [localStatus, setLocalStatus] = useState<'idle' | 'listening' | 'result'>('idle')
  const [localText, setLocalText] = useState<string | null>(null)
  const localTextRef = useRef<string | null>(null)

  // 保持 ref 与 state 同步，解决闭包陈旧问题
  useEffect(() => {
    localTextRef.current = localText
  }, [localText])

  // 初始化全局指令（仅一次）
  useEffect(() => {
    if (!globalCommandsInitialized) {
      globalCommandsInitialized = true
      initGlobalCommands()
    }
  }, [])

  const startRecognition = useCallback(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) return

    const recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN'
    recognition.interimResults = true
    recognition.continuous = false

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = Array.from(event.results)
        .map((r) => r[0].transcript)
        .join('')
      setLocalText(transcript)
      if (event.results[0]?.isFinal) {
        setLocalStatus('result')
      }
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'not-allowed') {
        showToast('请在浏览器设置中允许麦克风权限')
      } else if (event.error !== 'aborted') {
        showToast('语音识别出错，请重试')
      }
      setLocalStatus('idle')
      setLocalText(null)
    }

    recognition.onend = () => {
      setLocalStatus((prev) => (prev === 'listening' ? 'idle' : prev))
    }

    recognitionRef.current = recognition
    recognition.start()
    setLocalStatus('listening')
    setLocalText(null)
  }, [showToast])

  const stopRecognition = useCallback(() => {
    const rec = recognitionRef.current
    if (rec) {
      rec.stop()
      recognitionRef.current = null
    }
  }, [])

  // 按住开始录音
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      downAtRef.current = Date.now()
      startRecognition()
    },
    [startRecognition],
  )

  // 松手停止并匹配执行
  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const heldMs = Date.now() - downAtRef.current

      // 按住不足 500ms 视为误触，取消
      if (heldMs < 500) {
        stopRecognition()
        setLocalStatus('idle')
        setLocalText(null)
        return
      }

      stopRecognition()

      // 延迟等待 final result 到达
      setTimeout(() => {
        const text = localTextRef.current // 用 ref 避免闭包陈旧
        if (text) {
          const result = match(text, useStore.getState().currentView)
          if (result) {
            showToast(`已执行: ${text}`)
            result.command.handler(result.params)
          } else {
            showToast(`${text} 暂不支持此操作`)
          }
        } else {
          showToast('未识别到语音，请重试')
        }
        setLocalStatus('idle')
        setLocalText(null)
      }, 1000)
    },
    [stopRecognition, showToast],
  )

  // 阻止 click 事件（pointerup 已处理，防止合成 click 再次触发）
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  // 不支持语音则不渲染
  if (!voiceSupported) return null

  const isListening = localStatus === 'listening'
  const showResult = localStatus === 'result' && localText

  return (
    <div className="fixed bottom-24 right-5 z-50 flex flex-col items-end gap-2">
      {/* 识别文字提示气泡 */}
      {(isListening || showResult) && (
        <div className="bg-slate-900 text-white text-sm px-4 py-2 rounded-2xl rounded-br-md shadow-lg max-w-48">
          {isListening && !localText && '正在聆听...'}
          {isListening && localText && localText}
          {showResult && localText}
        </div>
      )}

      {/* 麦克风按钮 */}
      <button
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onClick={handleClick}
        className={`
          w-14 h-14 rounded-full flex items-center justify-center
          shadow-lg transition-all duration-200 select-none touch-none
          ${isListening
            ? 'w-[4.5rem] h-[4.5rem] bg-red-500 scale-110 animate-pulse'
            : 'bg-blue-600 hover:bg-blue-700 active:scale-95'
          }
        `}
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        <Mic
          className={`w-6 h-6 text-white ${isListening ? 'animate-pulse' : ''}`}
          fill={isListening ? 'white' : 'none'}
        />
      </button>
    </div>
  )
}
```

## 4. 修改 `frontend/src/store.ts`

在 store 中新增以下内容：

```typescript
// 类型定义新增
interface AppState {
  // ... 原有字段 ...
  voiceSupported: boolean
  voiceStatus: 'idle' | 'listening' | 'result'
  voiceText: string | null
  viewParams: Record<string, string> | null
  viewHistory: string[]
  setView: (view: string, params?: Record<string, string>) => void
  goBack: () => boolean
}

// 初始值
voiceStatus: 'idle' as const,
voiceText: null,
voiceSupported:
  typeof window !== 'undefined' &&
  !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition),
viewParams: null,
viewHistory: ['catalog'],

// setView 扩展：支持传参 + 记录导航历史
setView: (view: string, params?: Record<string, string>) => {
  const state = get()
  const history = [...state.viewHistory]
  // 去重：连续相同视图不重复压栈
  if (history[history.length - 1] !== view) {
    history.push(view)
  }
  set({ currentView: view, viewParams: params ?? null, viewHistory: history })
},

// goBack：返回上一页
goBack: () => {
  const state = get()
  if (state.viewHistory.length <= 1) return false
  const history = [...state.viewHistory]
  history.pop() // 移除当前
  const prev = history[history.length - 1]
  set({ currentView: prev, viewHistory: history, viewParams: null })
  return true
},

// logout 中重置导航历史
logout: () => {
  // ... 原有逻辑 ...
  set({ viewHistory: ['catalog'], viewParams: null })
},
```

## 5. 修改 `frontend/src/components/MainLayout.tsx`

在文件底部、`<BottomNav />` 之后加入：

```tsx
import VoiceFloatingButton from '../voice/VoiceFloatingButton'

// 在 return 的 JSX 中，BottomNav 下方：
<VoiceFloatingButton />
```

## 6. 视图级指令注册（示例）

在任何需要语音控制的视图中，按需注册和注销指令：

```tsx
import { registerCommands, unregisterCommands } from '../voice/voiceCommandRegistry'

function MyView() {
  useEffect(() => {
    registerCommands('my-view', [
      {
        id: 'my:action',
        keywords: ['关键词1', '关键词2'],
        description: '做什么',
        handler: () => { /* 执行逻辑 */ },
      },
    ])
    return () => unregisterCommands('my-view')
  }, [/* 依赖项 */])
}
```

---

## 踩坑实录

1. **闭包陈旧问题**：`handlePointerUp` 中的 `setTimeout` 如果直接用 `localText` state，拿到的可能是旧值。解决方法：用 `useRef` 同步 state，在 setTimeout 中读 ref。

2. **合成 click 事件**：pointerup 松手后浏览器会额外触发一次 click，如果不阻止会导致按钮行为异常。解决：`onClick` 中 `preventDefault + stopPropagation`。

3. **TypeScript 类型**：`SpeechRecognition` 不在 TypeScript 的 DOM 类型中，需要使用 `(window as any).SpeechRecognition`。

4. **500ms 最短按住时间**：防止用户不小心点到按钮（短触），少于 500ms 视为误触取消。

5. **视图指令必须 cleanup**：在 `useEffect` 的 return 中调用 `unregisterCommands`，否则切换视图后旧指令仍然生效。
