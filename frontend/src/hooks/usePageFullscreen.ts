import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 页面内「全屏」：由调用方把目标区域铺满视口（fixed inset-0），
 * 同时尽量让浏览器进入全屏以隐藏地址栏等（整页全屏，浮层 / 提示仍可见）。
 * 浏览器不支持（iOS、部分钉钉 WebView）时只铺满视口。按 Esc 或浏览器退出全屏时同步退出。
 */
export function usePageFullscreen() {
  const [on, setOn] = useState(false)
  const nativeRef = useRef(false) // 本次是否成功进入了浏览器全屏

  const exit = useCallback(() => {
    setOn(false)
    if (nativeRef.current) {
      nativeRef.current = false
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    }
  }, [])

  const enter = useCallback(() => {
    setOn(true)
    const el = document.documentElement
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen()
        .then(() => { nativeRef.current = true })
        .catch(() => {})
    }
  }, [])

  const toggle = useCallback(() => (on ? exit() : enter()), [on, enter, exit])

  useEffect(() => {
    if (!on) return
    // 浏览器全屏被 Esc / 系统手势退出时，一并退出页面全屏
    const onChange = () => {
      if (nativeRef.current && !document.fullscreenElement) {
        nativeRef.current = false
        setOn(false)
      }
    }
    // 未进入浏览器全屏时，Esc 由页面自己处理
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) setOn(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      window.removeEventListener('keydown', onKey)
    }
  }, [on])

  // 离开页面时恢复
  useEffect(() => () => {
    if (nativeRef.current && document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  }, [])

  return { fullscreen: on, enter, exit, toggle }
}
