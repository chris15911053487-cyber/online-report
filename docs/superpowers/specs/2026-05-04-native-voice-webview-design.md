# 原生语音 + WebView 容器 APP — 设计文档

## 目标

1. **浏览器环境**：隐藏语音按钮（Web Speech API 依赖 Google，国内不可用）
2. **APP 环境**：WebView 加载现有网页前端 + 原生语音识别（设备语音引擎，不依赖 Google）

## 架构

```
┌──────────────────────────────────────────┐
│  新 APP (Expo + WebView)                  │
│                                           │
│  ┌────────────────────────────────────┐  │
│  │  WebView                            │  │
│  │  加载 server/public/ 完整网页        │  │
│  │  界面、功能完全不变                   │  │
│  │                                     │  │
│  │  voice.js 检测到在 APP 内:           │  │
│  │  - 隐藏浏览器语音按钮                │  │
│  │  - 暴露 window.__voiceExec() 等待调用│  │
│  └────────────────────────────────────┘  │
│           ▲ injectJavaScript              │
│  ┌────────┴───────────────────────────┐  │
│  │  原生浮动麦克风按钮                  │  │
│  │  expo-speech-recognition            │  │
│  │  (设备原生语音引擎，不走 Google)      │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

## 交互流程

1. 用户按住原生麦克风按钮 → 设备语音引擎开始识别
2. 识别出文字 → `webViewRef.injectJavaScript('window.__voiceExec("text")')`
3. WebView 内 voice.js 匹配指令、操作 DOM、切换页面、显示 toast

## 涉及文件

### 新建：`mobile-webview/`

Expo WebView 容器项目，与现有 `mobile/` 独立。

```
mobile-webview/
├── App.js          — WebView 全屏 + 浮动麦克风按钮
├── app.json        — Expo 配置
├── package.json    — 依赖
└── VoiceButton.js  — 原生语音按钮组件（按住说话）
```

**依赖：**
- `react-native-webview` — 加载服务器网页
- `expo-speech-recognition` — 原生语音识别
- `expo` — 基础框架

### 修改：`server/public/js/voice.js`

改动内容：
- 移除浏览器语音按钮渲染（Web Speech API 国内不可用）
- 检测 `window.ReactNativeWebView` 判断是否在 APP 内
- APP 内暴露 `window.__voiceExec(text)` 供原生通过 `injectJavaScript` 调用
- 保留已有指令匹配逻辑（`match`、`addCmd`）
- 保留已有指令：返回主界面、退出登录
- Toast 复用页面已有 `#toast` 元素

## 环境行为

| 环境 | 语音按钮 | 语音引擎 |
|------|---------|---------|
| Chrome/Edge 浏览器 | 不显示 | 不可用 |
| APP (WebView) | 原生浮动按钮 | 设备原生引擎 |
| 其他浏览器 | 不显示 | 不可用 |

## 错误处理

- 麦克风权限未授权：VoiceButton 显示 toast 提示
- 语音识别结果为空：显示"未识别到语音，请重试"
- 指令未匹配：显示"xxx 暂不支持此操作"
- 语音识别错误：显示具体错误信息

## 限制

- `expo-speech-recognition` 为社区包，需验证 Expo SDK 52 兼容性
- Android 原生语音引擎依赖设备厂商（小米/华为/OPPO 等各自引擎），部分设备可能无离线语音包
- iOS SFSpeechRecognizer 需联网授权
- APP 加载的网页地址需配置（开发用 localhost，生产用服务器 IP）
