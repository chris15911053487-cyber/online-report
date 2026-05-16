/**
 * 动态报表筛选「扫码」：与 legacy server/public/js/app.js 行为对齐。
 * 通过 CDN 加载 html5-qrcode，HTTPS 走摄像头，否则提示相册选图。
 */

const HTML5_QR_SCRIPT = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'

type Html5Instance = {
  start(
    cameraIdOrConfig: { facingMode: string } | string,
    configuration: { fps: number; qrbox: { width: number; height: number } },
    qrCodeSuccessCallback: (decodedText: string) => void,
    qrCodeErrorCallback: () => void,
  ): Promise<void>
  stop(): Promise<void>
  clear(): void
  scanFile(file: File, showImage?: boolean): Promise<string>
}

type Html5Ctor = new (elementId: string) => Html5Instance

declare global {
  interface Window {
    Html5Qrcode?: Html5Ctor
    __html5QrcodeLoadPromise?: Promise<void>
  }
}

function loadHtml5QrcodeOnce(): Promise<void> {
  if (typeof window.Html5Qrcode !== 'undefined') return Promise.resolve()
  if (window.__html5QrcodeLoadPromise) return window.__html5QrcodeLoadPromise
  window.__html5QrcodeLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = HTML5_QR_SCRIPT
    s.async = true
    s.crossOrigin = 'anonymous'
    s.onload = () => {
      if (typeof window.Html5Qrcode === 'undefined') {
        reject(new Error('扫码库加载异常'))
        return
      }
      resolve()
    }
    s.onerror = () =>
      reject(new Error('无法从网络加载扫码库，请检查网络或改用 HTTPS'))
    document.head.appendChild(s)
  })
  return window.__html5QrcodeLoadPromise
}

function canUseLiveCamera(): boolean {
  return !!(
    window.isSecureContext &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  )
}

export interface OpenBarcodeScanOptions {
  showToast: (msg: string, durationMs?: number) => void
  /** 识别成功（未 trim 的空串不会调用） */
  onDecoded: (text: string) => void
}

/**
 * 打开全屏扫码浮层；成功时调用 onDecoded 并关闭。
 */
export function openBarcodeScan(opts: OpenBarcodeScanOptions): void {
  const { showToast, onDecoded } = opts

  loadHtml5QrcodeOnce()
    .then(() => {
      const Html5Qrcode = window.Html5Qrcode!
      const readerId = 'html5-scan-reader-' + String(Date.now())

      const overlay = document.createElement('div')
      overlay.className =
        'fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4'
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.style.pointerEvents = 'none'
      let closed = false
      setTimeout(() => {
        if (!closed) overlay.style.pointerEvents = ''
      }, 600)

      const panel = document.createElement('div')
      panel.className =
        'flex max-h-[min(90vh,560px)] w-full max-w-md flex-col gap-3 rounded-2xl bg-white p-4 shadow-xl'

      const hint = document.createElement('p')
      hint.className = 'hidden whitespace-pre-wrap text-center text-sm text-amber-800'

      const readerDiv = document.createElement('div')
      readerDiv.id = readerId
      readerDiv.className = 'min-h-[200px] w-full overflow-hidden rounded-lg bg-black'

      const fileInput = document.createElement('input')
      fileInput.type = 'file'
      fileInput.accept = 'image/*'
      fileInput.hidden = true

      let html5QrCode: Html5Instance | null = null
      let liveStarted = false
      const overlayCreatedAt = Date.now()

      function forceStopTracks() {
        try {
          const v = readerDiv.querySelector('video')
          if (v && v.srcObject) {
            ;(v.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
            v.srcObject = null
          }
        } catch {
          /* ignore */
        }
      }

      function shutdownCamera(): Promise<void> {
        forceStopTracks()
        if (!liveStarted || !html5QrCode) return Promise.resolve()
        liveStarted = false
        const p = html5QrCode.stop().catch(() => {})
        const t = new Promise<void>((r) => setTimeout(r, 3000))
        return Promise.race([p, t]).then(() => {
          forceStopTracks()
          try {
            html5QrCode?.clear()
          } catch {
            /* ignore */
          }
        })
      }

      function cleanup() {
        if (closed) return
        closed = true
        shutdownCamera()
          .catch(() => {})
          .finally(() => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
          })
      }

      function applyCode(raw: string | null | undefined) {
        const s = raw != null ? String(raw).trim() : ''
        if (!s) return
        onDecoded(s)
        showToast('已扫码')
        setTimeout(cleanup, 0)
      }

      const actions = document.createElement('div')
      actions.className = 'flex flex-wrap items-center justify-center gap-2'

      const btnFile = document.createElement('button')
      btnFile.type = 'button'
      btnFile.className =
        'hidden rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white active:bg-blue-700'
      btnFile.textContent = '选择照片识别'
      btnFile.addEventListener('click', (ev) => {
        ev.preventDefault()
        fileInput.click()
      })

      fileInput.addEventListener('change', (ev) => {
        const f = (ev.target as HTMLInputElement).files?.[0]
        ;(ev.target as HTMLInputElement).value = ''
        if (!f || closed) return
        shutdownCamera()
          .then(() => html5QrCode && html5QrCode.scanFile(f, false))
          .then((text) => applyCode(text))
          .catch(() => {
            showToast('未能从照片中识别条码，请换一张更清晰、正对条码的照片', 4500)
          })
      })

      const btnClose = document.createElement('button')
      btnClose.type = 'button'
      btnClose.className =
        'rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 active:bg-gray-50'
      btnClose.textContent = '关闭'
      btnClose.addEventListener('click', cleanup)

      actions.appendChild(btnFile)
      actions.appendChild(btnClose)
      panel.appendChild(hint)
      panel.appendChild(readerDiv)
      panel.appendChild(actions)
      panel.appendChild(fileInput)
      overlay.appendChild(panel)
      document.body.appendChild(overlay)

      try {
        html5QrCode = new Html5Qrcode(readerId)
      } catch {
        showToast('无法初始化扫码界面', 4000)
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        return
      }

      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay && Date.now() - overlayCreatedAt > 500) cleanup()
      })

      function tryStartCamera() {
        if (!canUseLiveCamera()) {
          hint.textContent =
            '当前为 HTTP 访问，无法使用摄像头。\n请点击下方「选择照片识别」从相册选图，或使用外接扫码枪直接扫入。'
          hint.classList.remove('hidden')
          btnFile.classList.remove('hidden')
          return
        }
        const box = Math.min(280, Math.max(200, window.innerWidth - 48))
        html5QrCode!
          .start(
            { facingMode: 'environment' },
            { fps: 8, qrbox: { width: box, height: Math.min(240, box) } },
            (decodedText) => applyCode(decodedText),
            () => {},
          )
          .then(() => {
            if (!closed) liveStarted = true
          })
          .catch(() => {
            hint.textContent =
              '无法启动摄像头。\n请点击下方「选择照片识别」从相册选图，或使用外接扫码枪直接扫入。'
            hint.classList.remove('hidden')
            btnFile.classList.remove('hidden')
          })
      }

      tryStartCamera()
    })
    .catch((err: Error) => {
      showToast(err?.message || '无法加载扫码组件', 6000)
    })
}
