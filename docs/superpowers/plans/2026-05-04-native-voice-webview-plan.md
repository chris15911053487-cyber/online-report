# 原生语音 WebView 容器 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 WebView 容器 APP，加载现有网页前端，通过原生语音识别实现语音控制

**Architecture:** WebView 加载 server/public/ 网页 → 原生麦克风按钮(按住说话) → expo-speech-recognition → injectJavaScript 调用 window.__voiceExec(text) → 网页内执行指令

**Tech Stack:** Expo SDK 52, react-native-webview, expo-speech-recognition, Vanilla JS

---

### Task 1: 修改 voice.js — 加环境检测 + 暴露 `__voiceExec` 桥接函数

**Files:**
- Modify: `server/public/js/voice.js`

- [ ] **Step 1: 重写 voice.js，分离浏览器/APP 行为**

移动到文件末尾的 `document.body.appendChild(wrapper)` 之前，用完整的新代码替换整个文件：

```javascript
(function () {
  'use strict';

  var isInApp = !!window.ReactNativeWebView;

  // --- 指令注册表 - 浏览器和 APP 共用 ---
  var commands = [];

  function addCmd(keywords, handler) {
    commands.push({ keywords: keywords, handler: handler });
  }

  function match(text) {
    var bestScore = 0;
    var best = null;
    for (var i = 0; i < commands.length; i++) {
      var cmd = commands[i];
      var score = 0;
      for (var j = 0; j < cmd.keywords.length; j++) {
        if (text.indexOf(cmd.keywords[j]) !== -1) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = cmd;
      }
    }
    return bestScore >= 1 ? best : null;
  }

  // --- Toast ---
  function showToast(msg) {
    var el = document.querySelector('#toast');
    if (el) {
      el.textContent = msg;
      el.hidden = false;
      clearTimeout(showToast._t);
      showToast._t = setTimeout(function () {
        el.hidden = true;
      }, 2000);
    }
  }

  // --- 全局指令 ---
  addCmd(['返回', '主界面', '目录', '首页', '主页'], function () {
    var btn = document.querySelector('[data-root-tab="catalog"]');
    if (btn) btn.click();
  });

  addCmd(['退出登录', '注销', '登出'], function () {
    var settingsTab = document.querySelector('[data-root-tab="settings"]');
    if (settingsTab) settingsTab.click();
    setTimeout(function () {
      var logoutBtn = document.getElementById('btn-settings-logout');
      if (logoutBtn) logoutBtn.click();
    }, 100);
  });

  // --- APP 环境：暴露桥接函数 ---
  if (isInApp) {
    window.__voiceExec = function (text) {
      var matched = match(text);
      if (matched) {
        showToast('已执行: ' + text);
        matched.handler();
      } else {
        showToast(text + ' 暂不支持此操作');
      }
    };
    return; // 不渲染浏览器语音按钮
  }

  // --- 浏览器环境：Web Speech API 国内不可用，不渲染按钮 ---
  // 仅当 SpeechRecognition 可用时才渲染按钮（供海外/调试使用）
  var SpeechRecognitionCtor =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) return;

  // --- 以下为浏览器语音按钮（Web Speech API） ---
  var recognition = null;
  var downAt = 0;
  var localText = null;

  var wrapper = document.createElement('div');
  wrapper.className = 'voice-wrapper';

  var bubble = document.createElement('div');
  bubble.className = 'voice-bubble';
  bubble.hidden = true;
  wrapper.appendChild(bubble);

  var btnEl = document.createElement('button');
  btnEl.className = 'voice-btn';
  btnEl.setAttribute('aria-label', '语音控制');
  btnEl.innerHTML =
    '<svg class="voice-btn__mic" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
  wrapper.appendChild(btnEl);

  var micEl = btnEl.querySelector('.voice-btn__mic');

  function showBubble(text, autoHide) {
    bubble.textContent = text;
    bubble.hidden = false;
    if (autoHide) {
      setTimeout(function () {
        bubble.hidden = true;
      }, 2000);
    }
  }

  function startRecognition() {
    recognition = new SpeechRecognitionCtor();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = function (event) {
      var transcript = '';
      for (var i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      localText = transcript;
      showBubble(transcript, false);
    };

    recognition.onerror = function (event) {
      if (event.error === 'not-allowed') {
        showBubble('请在浏览器设置中允许麦克风权限', true);
      } else if (event.error !== 'aborted') {
        showBubble('语音识别出错，请重试', true);
      }
      localText = null;
    };

    recognition.onend = function () {
      btnEl.classList.remove('voice-btn--listening');
      micEl.classList.remove('voice-btn__mic--listening');
    };

    recognition.start();
    btnEl.classList.add('voice-btn--listening');
    micEl.classList.add('voice-btn__mic--listening');
  }

  function stopRecognition() {
    if (recognition) {
      recognition.stop();
      recognition = null;
    }
  }

  btnEl.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    downAt = Date.now();
    showBubble('正在聆听...', false);
    startRecognition();
  });

  btnEl.addEventListener('pointerup', function (e) {
    e.preventDefault();
    var heldMs = Date.now() - downAt;
    if (heldMs < 500) {
      stopRecognition();
      bubble.hidden = true;
      localText = null;
      return;
    }
    stopRecognition();
    setTimeout(function () {
      var text = localText;
      if (text) {
        var matched = match(text);
        if (matched) {
          showBubble('已执行: ' + text, true);
          matched.handler();
        } else {
          showBubble(text + ' 暂不支持此操作', true);
        }
      } else {
        showBubble('未识别到语音，请重试', true);
      }
      localText = null;
    }, 800);
  });

  btnEl.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
  });

  document.body.appendChild(wrapper);

  var style = document.createElement('style');
  style.textContent =
    '.voice-wrapper{position:fixed;bottom:100px;right:16px;z-index:9999;display:flex;flex-direction:column;align-items:flex-end;gap:8px}' +
    '.voice-bubble{background:#0f172a;color:#fff;font-size:14px;padding:8px 16px;border-radius:16px 16px 4px 16px;box-shadow:0 4px 12px rgba(0,0,0,.25);max-width:200px;line-height:1.4}' +
    '.voice-btn{width:56px;height:56px;border-radius:50%;border:none;background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.3);cursor:pointer;transition:all .2s;-webkit-tap-highlight-color:transparent;touch-action:none;user-select:none}' +
    '.voice-btn:active{transform:scale(.95)}' +
    '.voice-btn--listening{width:64px;height:64px;background:#ef4444;transform:scale(1.1)}' +
    '.voice-btn__mic--listening{animation:voice-pulse .8s ease-in-out infinite}' +
    '@keyframes voice-pulse{0%,100%{opacity:1}50%{opacity:.4}}';
  document.head.appendChild(style);
})();
```

- [ ] **Step 2: 验证 voice.js 语法正确**

Run: `node -c server/public/js/voice.js`
Expected: 无输出（语法正确）

- [ ] **Step 3: 提交**

```bash
git add server/public/js/voice.js
git commit -m "refactor(voice): add WebView bridge and environment detection, hide browser button"
```

---

### Task 2: 创建 mobile-webview Expo 项目

**Files:**
- Create: `mobile-webview/package.json`
- Create: `mobile-webview/app.json`
- Create: `mobile-webview/babel.config.js`
- Create: `mobile-webview/App.js`
- Create: `mobile-webview/VoiceButton.js`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "online-report-webview",
  "version": "1.0.0",
  "private": true,
  "main": "node_modules/expo/AppEntry.js",
  "scripts": {
    "start": "expo start",
    "android": "expo start --android",
    "ios": "expo start --ios"
  },
  "dependencies": {
    "expo": "~52.0.0",
    "expo-speech-recognition": "~0.7.0",
    "expo-status-bar": "~2.0.0",
    "react": "18.3.1",
    "react-native": "0.76.3",
    "react-native-webview": "13.12.5"
  },
  "devDependencies": {
    "@babel/core": "^7.25.0",
    "babel-preset-expo": "~12.0.0"
  }
}
```

- [ ] **Step 2: 创建 app.json**

```json
{
  "expo": {
    "name": "生产报工",
    "slug": "online-report-webview",
    "version": "1.0.0",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "userInterfaceStyle": "light",
    "newArchEnabled": true,
    "ios": {
      "supportsTablet": false,
      "infoPlist": {
        "NSSpeechRecognitionUsageDescription": "用于语音控制报工操作"
      }
    },
    "android": {
      "adaptiveIcon": {
        "backgroundColor": "#0f172a"
      },
      "package": "com.onlinereport.webview"
    }
  }
}
```

- [ ] **Step 3: 创建 babel.config.js**

```javascript
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
```

- [ ] **Step 4: 创建 VoiceButton.js — 原生语音按钮**

```javascript
import { useEffect, useState, useRef, useCallback } from 'react';
import { StyleSheet, TouchableOpacity, Animated, Text, View } from 'react-native';
import { useSpeechRecognition } from 'expo-speech-recognition';

export default function VoiceButton({ webViewRef }) {
  const [isListening, setIsListening] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const {
    startListening,
    stopListening,
    transcript,
    error,
    resetTranscript,
  } = useSpeechRecognition({ lang: 'zh-CN', interimResults: true });

  useEffect(() => {
    if (isListening) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.1, duration: 400, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isListening]);

  useEffect(() => {
    if (error) {
      setIsListening(false);
      stopListening();
      resetTranscript();
    }
  }, [error]);

  const handlePressIn = useCallback(() => {
    setIsListening(true);
    resetTranscript();
    startListening();
  }, [startListening, resetTranscript]);

  const handlePressOut = useCallback(() => {
    setIsListening(false);
    stopListening();
  }, [stopListening]);

  // 识别完成后注入 WebView
  useEffect(() => {
    if (!isListening && transcript) {
      const text = transcript.trim();
      if (text && webViewRef.current) {
        const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        webViewRef.current.injectJavaScript(
          `window.__voiceExec && window.__voiceExec('${escaped}')`
        );
      }
      resetTranscript();
    }
  }, [isListening, transcript]);

  const isActive = isListening;

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.button,
          isActive && styles.buttonActive,
          { transform: [{ scale: isActive ? pulseAnim : 1 }] },
        ]}
      >
        <TouchableOpacity
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          activeOpacity={0.8}
          style={styles.touchable}
        >
          <Text style={styles.micText}>{isActive ? '🎙️' : '🎤'}</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 100,
    right: 16,
    zIndex: 9999,
  },
  button: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#2563eb',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  buttonActive: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#ef4444',
  },
  touchable: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  micText: {
    fontSize: 24,
  },
});
```

- [ ] **Step 5: 创建 App.js — WebView 容器主入口**

```javascript
import { useRef, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Text } from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import VoiceButton from './VoiceButton';

// 生产环境改成实际服务器 IP
const WEBVIEW_URL = process.env.EXPO_PUBLIC_WEBVIEW_URL || 'http://192.168.1.100:3000';

export default function App() {
  const webViewRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      
      {error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>连接失败</Text>
          <Text style={styles.errorHint}>请检查服务器是否正常运行</Text>
        </View>
      ) : (
        <WebView
          ref={webViewRef}
          source={{ uri: WEBVIEW_URL }}
          style={styles.webview}
          onLoadEnd={() => setLoading(false)}
          onError={() => setError(true)}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          startInLoadingState={false}
          allowsInlineMediaPlayback={true}
        />
      )}

      {loading && !error && (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#2563eb" />
          <Text style={styles.loadingText}>加载中...</Text>
        </View>
      )}

      {!loading && !error && <VoiceButton webViewRef={webViewRef} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  webview: { flex: 1 },
  loading: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f172a',
  },
  loadingText: { color: '#94a3b8', marginTop: 12, fontSize: 14 },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    padding: 32,
  },
  errorText: { color: '#f87171', fontSize: 18, fontWeight: '600' },
  errorHint: { color: '#94a3b8', fontSize: 14, marginTop: 8 },
});
```

- [ ] **Step 6: 验证 package.json 语法**

Run: `cd mobile-webview && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')) && console.log('OK')"`
Expected: `OK`

- [ ] **Step 7: 提交**

```bash
git add mobile-webview/
git commit -m "feat: add WebView container with native voice control via expo-speech-recognition"
```

---

### Task 3: 集成验证

- [ ] **Step 1: 验证 voice.js 在 Docker 中正常加载**

不再需要构建前端，Docker 上下文已是 `./server`。重启容器后访问 `http://localhost:3000`，确认：
- 浏览器中不出现语音按钮
- 页面其他功能正常
- Console 无报错

- [ ] **Step 2: 安装 mobile-webview 依赖**

```bash
cd mobile-webview && npm install
```

- [ ] **Step 3: 编译验证 APP**

```bash
cd mobile-webview && npx expo export --platform android --dump-sourcemap 2>&1 | tail -20
```

Expected: 无编译错误

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore: add mobile-webview deps and verify build"
```
