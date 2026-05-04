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

  // --- Toast（复用页面已有的 #toast 元素） ---
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

  // --- APP 环境：暴露桥接函数给原生调用 ---
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

  // --- 浏览器环境：Web Speech API ---
  var SpeechRecognitionCtor =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) return; // 不可用则不渲染按钮

  var recognition = null;
  var downAt = 0;
  var localText = null;

  // --- Browser UI ---
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
