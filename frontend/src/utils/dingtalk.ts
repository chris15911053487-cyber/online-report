/**
 * 钉钉 H5 微应用免登工具
 *
 * 检测是否在钉钉容器中运行，如果是则自动获取 authCode 并调用后端完成免登。
 */
import { apiFetch, setToken } from './api'

declare global {
  interface Window {
    dd?: {
      ready: (callback: () => void) => void
      error: (callback: (err: any) => void) => void
      runtime: {
        permission: {
          requestAuthCode: (params: {
            corpId: string
            onSuccess: (result: { code: string }) => void
            onFail: (err: any) => void
          }) => void
        }
      }
      requestAuthCode: (params: {
        corpId: string
        onSuccess: (result: { code: string }) => void
        onFail: (err: any) => void
      }) => void
      env: {
        platform: string
      }
    }
  }
}

/** 检测当前是否运行在钉钉客户端内 */
export function isDingTalkEnv(): boolean {
  const ua = navigator.userAgent.toLowerCase()
  const result = ua.includes('dingtalk')
  console.log('[dingtalk-sso] isDingTalkEnv =', result, '| UA =', ua.substring(0, 100))
  return result
}

/** 从后端获取钉钉 corpId 配置 */
async function fetchCorpId(): Promise<string | null> {
  try {
    const data = await apiFetch('/auth/dingtalk/config')
    return data.corpId || null
  } catch {
    return null
  }
}

/** 调用钉钉 JSAPI 获取免登授权码 */
function requestAuthCode(corpId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const dd = window.dd
    if (!dd) {
      reject(new Error('钉钉 JSAPI 未加载'))
      return
    }

    const doRequest = () => {
      // 兼容不同版本 API 路径
      const fn = dd.runtime?.permission?.requestAuthCode || dd.requestAuthCode
      if (!fn) {
        reject(new Error('钉钉 requestAuthCode API 不可用'))
        return
      }
      fn({
        corpId,
        onSuccess: (result: { code: string }) => {
          resolve(result.code)
        },
        onFail: (err: any) => {
          reject(new Error(typeof err === 'string' ? err : JSON.stringify(err)))
        },
      })
    }

    // 必须等待 dd.ready 后才能调用 JSAPI
    if (dd.ready) {
      dd.ready(doRequest)
      dd.error?.((err: any) => {
        reject(new Error('钉钉 JSAPI 初始化失败: ' + JSON.stringify(err)))
      })
    } else {
      // 降级：直接尝试调用
      doRequest()
    }
  })
}

export interface DingTalkLoginResult {
  success: boolean
  token?: string
  user?: {
    id: number
    username: string
    displayName: string
    role: string
    roles: string[]
  }
  error?: string
  needBind?: boolean
}

/**
 * 执行钉钉免登全流程：
 * 1. 获取 corpId
 * 2. 调用 dd.runtime.permission.requestAuthCode
 * 3. POST /auth/dingtalk/login
 * 4. 存储 token
 */
export async function dingtalkLogin(): Promise<DingTalkLoginResult> {
  try {
    console.log('[dingtalk-sso] 开始免登流程...')
    console.log('[dingtalk-sso] window.dd =', window.dd ? '已加载' : '未加载')

    // 1. 获取 corpId
    const corpId = await fetchCorpId()
    console.log('[dingtalk-sso] corpId =', corpId)
    if (!corpId) {
      return { success: false, error: '钉钉 SSO 未配置' }
    }

    // 2. 获取免登码
    console.log('[dingtalk-sso] 开始获取 authCode...')
    const authCode = await requestAuthCode(corpId)
    console.log('[dingtalk-sso] authCode =', authCode ? '已获取' : '为空')

    // 3. 调后端完成登录
    console.log('[dingtalk-sso] 调用后端登录...')
    const data = await apiFetch('/auth/dingtalk/login', {
      method: 'POST',
      body: JSON.stringify({ authCode }),
    })

    // 4. 存储 token
    setToken(data.token)
    console.log('[dingtalk-sso] 免登成功, user =', data.user?.username)

    return {
      success: true,
      token: data.token,
      user: data.user,
    }
  } catch (err: any) {
    console.error('[dingtalk-sso] 免登失败:', err)
    const status = err?.status
    const needBind = status === 403
    return {
      success: false,
      error: err?.data?.error || err?.message || '钉钉免登失败',
      needBind,
    }
  }
}
