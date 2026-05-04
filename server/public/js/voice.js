(function () {
  'use strict';

  var isInApp = !!window.ReactNativeWebView;

  // ==================== 指令注册表 ====================
  var commands = [];

  function addCmd(keywords, handler) {
    commands.push({ keywords: keywords, handler: handler });
  }

  function match(text) {
    var bestScore = 0;
    var best = null;
    for (var i = 0; i < commands.length; i++) {
      var score = 0;
      var kw = commands[i].keywords;
      for (var j = 0; j < kw.length; j++) {
        if (text.indexOf(kw[j]) !== -1) score++;
      }
      if (score > bestScore) { bestScore = score; best = commands[i]; }
    }
    return bestScore >= 1 ? best : null;
  }

  // ==================== Toast ====================
  function showToast(msg) {
    var el = document.querySelector('#toast');
    if (el) {
      el.textContent = msg;
      el.hidden = false;
      clearTimeout(showToast._t);
      showToast._t = setTimeout(function () { el.hidden = true; }, 2000);
    }
  }

  // ==================== 全局指令 ====================
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

  // ==================== APP 环境：桥接函数 ====================
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
    return;
  }

  // ==================== 浏览器环境：百度 ASR ====================

  // ---- DOM 元素 ----
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

  // ---- 状态 ----
  var recording = null;   // { stop: fn, chunks: [], sampleRate: number }
  var processing = false;
  var downAt = 0;

  function showBubble(msg, autoHide) {
    bubble.textContent = msg;
    bubble.hidden = false;
    if (autoHide) {
      setTimeout(function () { bubble.hidden = true; }, 2500);
    }
  }

  // ---- WAV 工具 ----
  function writeString(view, offset, str) {
    for (var i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  function pcmChunksToWav(chunks, sampleRate) {
    var len = 0;
    for (var i = 0; i < chunks.length; i++) { len += chunks[i].length; }

    var buf = new ArrayBuffer(44 + len * 2);
    var v = new DataView(buf);

    // RIFF header
    writeString(v, 0, 'RIFF');
    v.setUint32(4, 36 + len * 2, true);
    writeString(v, 8, 'WAVE');
    // fmt chunk
    writeString(v, 12, 'fmt ');
    v.setUint32(16, 16, true);       // chunk size
    v.setUint16(20, 1, true);        // PCM
    v.setUint16(22, 1, true);        // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); // byte rate
    v.setUint16(32, 2, true);        // block align
    v.setUint16(34, 16, true);       // bits per sample
    // data chunk
    writeString(v, 36, 'data');
    v.setUint32(40, len * 2, true);

    var off = 44;
    for (var i = 0; i < chunks.length; i++) {
      var ch = chunks[i];
      for (var j = 0; j < ch.length; j++) {
        var s = Math.max(-1, Math.min(1, ch[j]));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }
    return buf;
  }

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // ---- 录音 ----
  var micStream = null;       // cached stream to avoid re-requesting permission
  var micStreamRefs = 0;

  function releaseStream() {
    micStreamRefs--;
    if (micStreamRefs <= 0 && micStream) {
      micStream.getTracks().forEach(function (t) { t.stop(); });
      micStream = null;
      micStreamRefs = 0;
    }
  }

  function startRecording(cb) {
    function doStart(stream) {
      micStream = stream;
      micStreamRefs++;

      var audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      var actualRate = audioCtx.sampleRate;
      var source = audioCtx.createMediaStreamSource(stream);
      var processor = audioCtx.createScriptProcessor(4096, 1, 1);
      var chunks = [];

      processor.onaudioprocess = function (e) {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      var rec = {
        stop: function () {
          source.disconnect();
          processor.disconnect();
          audioCtx.close();
          releaseStream();
          return { chunks: chunks, sampleRate: actualRate };
        }
      };

      cb(null, rec);
    }

    if (micStream && micStream.active) {
      doStart(micStream);
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) { doStart(stream); })
      .catch(function () { cb(new Error('麦克风权限未授权')); });
  }

  // ---- 调用百度 ASR ----
  function recognizeAudio(chunks, sampleRate, cb) {
    var wav = pcmChunksToWav(chunks, sampleRate || 16000);
    var base64 = arrayBufferToBase64(wav);

    var headers = { 'Content-Type': 'application/json' };
    var token = localStorage.getItem('online_report_token');
    if (token) headers.Authorization = 'Bearer ' + token;

    fetch('/api/speech/recognize', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ audio: base64, format: 'wav', rate: sampleRate || 16000 }),
    })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (json.error) { cb(new Error(json.error)); return; }
        cb(null, json.text || '');
      })
      .catch(function (err) { cb(err); });
  }

  // ---- 按钮交互 ----
  btnEl.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    if (processing) return;
    downAt = Date.now();
    showBubble('正在聆听...', false);
    btnEl.classList.add('voice-btn--listening');
    micEl.classList.add('voice-btn__mic--listening');

    startRecording(function (err, rec) {
      if (err) {
        showBubble(err.message, true);
        btnEl.classList.remove('voice-btn--listening');
        micEl.classList.remove('voice-btn__mic--listening');
        return;
      }
      recording = rec;
    });
  });

  btnEl.addEventListener('pointerup', function (e) {
    e.preventDefault();
    var heldMs = Date.now() - downAt;

    if (heldMs < 500) {
      // 太短，取消
      if (recording) {
        recording.stop();
        recording = null;
      }
      bubble.hidden = true;
      btnEl.classList.remove('voice-btn--listening');
      micEl.classList.remove('voice-btn__mic--listening');
      return;
    }

    if (!recording) {
      btnEl.classList.remove('voice-btn--listening');
      micEl.classList.remove('voice-btn__mic--listening');
      bubble.hidden = true;
      return;
    }

    processing = true;
    btnEl.classList.remove('voice-btn--listening');
    micEl.classList.remove('voice-btn__mic--listening');
    showBubble('识别中...', false);

    var result = recording.stop();
    recording = null;

    recognizeAudio(result.chunks, result.sampleRate, function (err, text) {
      processing = false;
      if (err) {
        showBubble('识别失败: ' + (err.message || '请重试'), true);
        return;
      }

      var matched = match(text);
      if (matched) {
        showBubble('已执行: ' + text, true);
        matched.handler();
      } else if (text) {
        showBubble(text + ' 暂不支持此操作', true);
      } else {
        showBubble('未识别到语音，请重试', true);
      }
    });
  });

  btnEl.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
  });

  // ---- 预获取麦克风权限（避免 pointerup 时流还没就绪）----
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(function (stream) {
      micStream = stream;
      micStreamRefs = 1;
    })
    .catch(function () {
      // 用户拒绝权限，后续按钮操作会提示错误
    });

  // ---- 挂载到页面 ----
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
