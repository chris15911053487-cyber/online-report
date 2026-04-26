import { useCallback, useRef, type PointerEvent, type MouseEvent, type TouchEvent } from 'react'

type TapHandler = (e: PointerEvent | MouseEvent | TouchEvent) => void

/**
 * 与旧版 app.js 中 bindTap 一致：优先 PointerEvent（pointerup），再用 click 去重；
 * 无 PointerEvent 时用 touchend + click。
 */
export function useBindTap(handler: TapHandler, options?: { disabled?: boolean }) {
  const lastPointerUpAt = useRef(0)
  const lastTouchEndAt = useRef(0)

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (options?.disabled || e.button !== 0) return
      e.preventDefault()
      lastPointerUpAt.current = Date.now()
      handler(e)
    },
    [handler, options?.disabled],
  )

  const onClickPointer = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      if (options?.disabled) return
      if (typeof window !== 'undefined' && window.PointerEvent) {
        if (Date.now() - lastPointerUpAt.current < 500) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
      }
      handler(e)
    },
    [handler, options?.disabled],
  )

  const onTouchEnd = useCallback(
    (e: TouchEvent<HTMLElement>) => {
      if (options?.disabled) return
      e.preventDefault()
      lastTouchEndAt.current = Date.now()
      handler(e)
    },
    [handler, options?.disabled],
  )

  const onClickLegacy = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      if (options?.disabled) return
      if (Date.now() - lastTouchEndAt.current < 500) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      handler(e)
    },
    [handler, options?.disabled],
  )

  if (typeof window !== 'undefined' && window.PointerEvent) {
    return { onPointerUp, onClick: onClickPointer } as const
  }
  return { onTouchEnd, onClick: onClickLegacy } as const
}
