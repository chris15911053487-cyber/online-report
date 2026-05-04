(function () {
  'use strict';

  // ==================== 功能开关 ====================
  var voiceMeta = document.querySelector('meta[name="voice-enabled"]');
  if (voiceMeta && voiceMeta.content === 'false') return;

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
  var state = 'idle';     // 'idle' | 'recording' | 'processing'
  var recording = null;   // { stop: fn, chunks: [], sampleRate: number }
  var maxRecordTimer = null;

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
  var sharedAudioCtx = null;  // 复用 AudioContext，避免反复 close → new 的异步冲突

  function getOrCreateAudioCtx() {
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      sharedAudioCtx = new Ctor({ sampleRate: 16000 });
    }
    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume();
    }
    return sharedAudioCtx;
  }

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

      try {
        var ctx = getOrCreateAudioCtx();
        var actualRate = ctx.sampleRate;
        var source = ctx.createMediaStreamSource(stream);
        var processor = ctx.createScriptProcessor(4096, 1, 1);
        var chunks = [];

        processor.onaudioprocess = function (e) {
          chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        };

        source.connect(processor);
        processor.connect(ctx.destination);

        var rec = {
          stop: function () {
            source.disconnect();
            processor.disconnect();
            // 不复用 audioCtx.close()，避免异步 close 与下次 new 冲突
            releaseStream();
            return { chunks: chunks, sampleRate: actualRate };
          }
        };

        cb(null, rec);
      } catch (e) {
        cb(new Error('录音启动失败: ' + (e.message || 'unknown')));
      }
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
  function sendDebugLog(msg) {
    var headers = { 'Content-Type': 'application/json' };
    var token = localStorage.getItem('online_report_token');
    if (token) headers.Authorization = 'Bearer ' + token;
    fetch('/api/speech/debug', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ text: msg }),
    }).catch(function () { /* ignore */ });
  }

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
  function stopAndRecognize() {
    if (maxRecordTimer) {
      clearTimeout(maxRecordTimer);
      maxRecordTimer = null;
    }

    state = 'processing';
    btnEl.classList.remove('voice-btn--listening');
    micEl.classList.remove('voice-btn__mic--listening');
    showBubble('识别中...', false);

    if (!recording) {
      state = 'idle';
      bubble.hidden = true;
      sendDebugLog('[REC_NULL] recording was null at stop');
      return;
    }

    // 安全超时：15 秒后强制重置，避免卡死
    var safetyTimer = setTimeout(function () {
      if (state === 'processing') {
        state = 'idle';
        sendDebugLog('[TIMEOUT] processing reset after 15s');
      }
    }, 15000);

    var result = recording.stop();
    recording = null;

    var totalSamples = 0;
    var peakAbs = 0;
    for (var i = 0; i < result.chunks.length; i++) {
      var ch = result.chunks[i];
      totalSamples += ch.length;
      for (var j = 0; j < ch.length; j++) {
        var absVal = ch[j] < 0 ? -ch[j] : ch[j];
        if (absVal > peakAbs) peakAbs = absVal;
      }
    }
    sendDebugLog('[AUDIO] chunks=' + result.chunks.length + ' samples=' + totalSamples + ' rate=' + result.sampleRate + ' peak=' + peakAbs.toFixed(4));

    recognizeAudio(result.chunks, result.sampleRate, function (err, text) {
      state = 'idle';
      clearTimeout(safetyTimer);
      if (err) {
        sendDebugLog('[ASR_FAIL] ' + (err.message || 'unknown'));
        showBubble('识别失败: ' + (err.message || '请重试'), true);
        return;
      }

      var matched = match(text);
      if (matched) {
        showBubble('已执行: ' + text, true);
        matched.handler();
      } else if (text) {
        showBubble('"' + text + '" 未匹配到指令', true);
      } else {
        showBubble('未识别到语音，请重试', true);
      }
    });
  }

  btnEl.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();

    if (state === 'processing') {
      sendDebugLog('[BUSY] state=processing ignored');
      return;
    }

    if (state === 'recording') {
      // 停止录音并识别
      sendDebugLog('[STOP] user clicked to stop');
      stopAndRecognize();
      return;
    }

    // state === 'idle' — 开始录音
    sendDebugLog('[START] user clicked to start');
    state = 'recording';
    showBubble('正在聆听...', false);
    btnEl.classList.add('voice-btn--listening');
    micEl.classList.add('voice-btn__mic--listening');

    startRecording(function (err, rec) {
      if (err) {
        showBubble('录音失败: ' + err.message, true);
        btnEl.classList.remove('voice-btn--listening');
        micEl.classList.remove('voice-btn__mic--listening');
        state = 'idle';
        sendDebugLog('[REC_ERROR] ' + err.message);
        return;
      }
      sendDebugLog('[REC_OK] AudioContext state=' + (sharedAudioCtx ? sharedAudioCtx.state : 'none'));
      recording = rec;

      // 10 秒最大录音时长，超时自动停止
      maxRecordTimer = setTimeout(function () {
        if (state === 'recording') {
          sendDebugLog('[MAXTIME] auto-stop after 10s');
          stopAndRecognize();
        }
      }, 10000);
    });
  });

  // ---- 预获取麦克风权限（避免 pointerup 时流还没就绪）----
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        micStream = stream;
        micStreamRefs = 1;
      })
      .catch(function () {
        // 用户拒绝权限，后续按钮操作会提示错误
      });
  }

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

  // 页面加载完成标记，方便排查 voice.js 是否正确初始化
  sendDebugLog('[PAGE_READY] voice.js loaded, getUserMedia=' + (!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)));
})();
