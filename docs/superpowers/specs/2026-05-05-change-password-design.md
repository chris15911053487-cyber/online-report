# 修改密码功能设计

## 需求

用户在已登录状态下，在设置页面修改自己的密码，无需验证旧密码。修改成功后自动退出，用户用新密码重新登录。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `server/src/routes/auth.js` | 新增 `POST /auth/change-password` 路由 |
| `frontend/src/views/SettingsView.tsx` | 添加修改密码按钮和表单 |

## 后端 — POST /auth/change-password

- 需 JWT 认证（`preHandler: [fastify.authenticate]`）
- 请求体：`{ newPassword: string }`
- 从 JWT 取 `request.user.username`（即 OUSR USER_CODE）
- 执行 `UPDATE OUSR SET MobileIMEI = @newPassword WHERE USER_CODE = @userCode`
- 校验：newPassword 非空，长度 >= 1
- 成功返回 `{ success: true }`

## 前端 — SettingsView

交互流程：
1. 设置页新增「修改密码」按钮
2. 点击 → 展开/切换到表单：新密码输入框 + 确认新密码输入框 + 提交按钮
3. 前端校验：非空、两次输入一致
4. 调用 `POST /auth/change-password` → 成功后 `logout()` → 自动回到登录页

实现细节：
- 使用局部 `useState` 管理表单状态（展开/收起、输入值、错误提示、loading）
- 密码输入框 type="password"
- 与现有 UI 风格保持一致（TailwindCSS）
- 按钮样式参考现有「退出登录」按钮

## 错误处理

- 新密码为空 → "请输入新密码"
- 两次密码不一致 → "两次输入的密码不一致"
- API 调用失败 → 显示错误信息，不退出登录
