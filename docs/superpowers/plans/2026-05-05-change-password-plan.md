# 修改密码功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置页面添加修改密码功能，用户输入新密码+确认后直接更新 OUSR.MobileIMEI，成功后自动退出登录。

**Architecture:** 后端新增 `POST /auth/change-password` 路由（JWT 认证），直接 UPDATE OUSR 表；前端在 SettingsView 添加表单，成功后调用 logout()。

**Tech Stack:** Fastify + mssql (后端), React + TypeScript + TailwindCSS (前端)

---

### Task 1: 后端 — 新增修改密码路由

**Files:**
- Modify: `server/src/routes/auth.js`

- [ ] **Step 1: 在 auth.js 中添加 POST /auth/change-password 路由**

在 `fastify.get('/auth/me', ...)` 之前插入以下代码：

```js
  fastify.post(
    '/auth/change-password',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { newPassword } = request.body || {};
      if (!newPassword || String(newPassword).trim() === '') {
        return reply.code(400).send({ error: '请输入新密码' });
      }

      const username = request.user?.username;
      if (!username) {
        return reply.code(401).send({ error: '无效登录' });
      }

      try {
        const pool = await getPool();
        await pool
          .request()
          .input('pwd', sql.NVarChar(255), String(newPassword).trim())
          .input('code', sql.NVarChar(255), username)
          .query(
            `UPDATE [OUSR] SET [MobileIMEI] = @pwd WHERE [USER_CODE] = @code`
          );
        return { success: true };
      } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: '密码修改失败，请稍后重试' });
      }
    }
  );
```

- [ ] **Step 2: 验证后端路由语法正确**

```bash
cd server && node -e "require('./src/routes/auth.js')" 2>&1 | head -5
```
预期：无报错（可能会有数据库连接警告，忽略）

- [ ] **Step 3: 提交**

```bash
git add server/src/routes/auth.js
git commit -m "feat(auth): add change-password endpoint

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: 前端 — 修改设置页面

**Files:**
- Modify: `frontend/src/views/SettingsView.tsx`

- [ ] **Step 1: 重写 SettingsView.tsx，添加修改密码功能**

完整替换文件内容为：

```tsx
import { useState } from 'react'
import { useStore } from '../store'
import { apiFetch, getToken } from '../utils/api'

export default function SettingsView() {
  const { user, logout } = useStore()
  const [showChangePwd, setShowChangePwd] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleChangePassword = async () => {
    setError('')

    if (!newPassword.trim()) {
      setError('请输入新密码')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }

    setLoading(true)
    try {
      await apiFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ newPassword: newPassword.trim() }),
      })
      logout()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '密码修改失败'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setShowChangePwd(false)
    setNewPassword('')
    setConfirmPassword('')
    setError('')
  }

  return (
    <div className="p-4 max-w-md mx-auto">
      <div className="bg-white rounded-lg shadow p-6 mb-4">
        <h2 className="text-lg font-semibold mb-4">用户信息</h2>
        <div className="text-sm text-slate-600 space-y-2">
          <p>用户名：{user?.username || '-'}</p>
          <p>显示名：{user?.displayName || '-'}</p>
          <p>角色：{user?.role === 'admin' ? '管理员' : '操作员'}</p>
        </div>
      </div>

      {!showChangePwd ? (
        <button
          onClick={() => setShowChangePwd(true)}
          className="w-full py-3 bg-sky-500 text-white rounded-lg font-medium hover:bg-sky-600 transition-colors mb-4"
        >
          修改密码
        </button>
      ) : (
        <div className="bg-white rounded-lg shadow p-6 mb-4">
          <h2 className="text-lg font-semibold mb-4">修改密码</h2>

          {error && (
            <div className="mb-3 p-2 bg-red-50 text-red-600 text-sm rounded">
              {error}
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label className="block text-sm text-slate-600 mb-1">新密码</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-sky-500"
                placeholder="请输入新密码"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">确认新密码</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-sky-500"
                placeholder="请再次输入新密码"
              />
            </div>
          </div>

          <div className="flex gap-3 mt-4">
            <button
              onClick={resetForm}
              className="flex-1 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm hover:bg-slate-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleChangePassword}
              disabled={loading}
              className="flex-1 py-2 bg-sky-500 text-white rounded-lg text-sm font-medium hover:bg-sky-600 disabled:opacity-50 transition-colors"
            >
              {loading ? '修改中...' : '确认修改'}
            </button>
          </div>
        </div>
      )}

      <button
        id="btn-settings-logout"
        onClick={logout}
        className="w-full py-3 bg-red-500 text-white rounded-lg font-medium hover:bg-red-600 transition-colors"
      >
        退出登录
      </button>
    </div>
  )
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```
预期：无新增报错

- [ ] **Step 3: 提交**

```bash
git add frontend/src/views/SettingsView.tsx
git commit -m "feat(settings): add change-password form with logout on success

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
