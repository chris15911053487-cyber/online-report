(function () {
  'use strict';

  // ==================== 功能开关 ====================
  var voiceMeta = document.querySelector('meta[name="voice-enabled"]');
  if (voiceMeta && voiceMeta.content === 'false') return;

  // 仅在移动端显示语音按钮
  var isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
  if (!isMobile) return;

  var isInApp = !!window.ReactNativeWebView;

  // ==================== 指令注册表 ====================
  var commands = [];

  /** 底部 Tab：中文说法 → data-nav-tab */
  var NAV_TAB_BY_LABEL = {
    '菜单': 'catalog',
    '目录': 'catalog',
    '首页': 'catalog',
    '主页': 'catalog',
    '主界面': 'catalog',
    '返回': 'catalog',
    'AI': 'ai',
    'ai': 'ai',
    '人工智能': 'ai',
    '智能助手': 'ai',
    '助手': 'ai',
    '消息': 'messages',
    '设置': 'settings',
  };

  /** ASR 常见误听 → 纠正（在规范化时替换） */
  var ASR_TEXT_REPLACEMENTS = [
    ['盛产', '生产'], ['升产', '生产'], ['胜产', '生产'], ['声产', '生产'],
    ['定单', '订单'], ['订但', '订单'], ['订蛋', '订单'],
    ['报宫', '报工'], ['报公', '报工'], ['暴工', '报工'],
    ['登出', '退出登录'], ['注销', '退出登录'],
  ];

  function addCmd(keywords, handler, meta) {
    meta = meta || {};
    commands.push({
      keywords: keywords,
      handler: handler,
      label: meta.label || keywords[0] || '',
      _dynamicCatalog: !!meta.dynamic,
    });
  }

  /** 从当前菜单页 DOM 同步语音指令（管理员配置的菜单名可说即开） */
  function refreshDynamicCatalogCommands() {
    commands = commands.filter(function (c) {
      return !c._dynamicCatalog;
    });
    var items = document.querySelectorAll('[data-voice-catalog-grid] [data-menu-label]');
    var seen = {};
    var i;
    for (i = 0; i < items.length; i++) {
      var label = (items[i].getAttribute('data-menu-label') || '').trim();
      var routeKey = items[i].getAttribute('data-route-key') || '';
      if (!label || seen[label]) continue;
      seen[label] = true;
      (function (rk, lbl) {
        addCmd(
          [lbl, '打开' + lbl, '进入' + lbl, '查看' + lbl],
          function () {
            openCatalogMenu(rk, lbl);
          },
          { dynamic: true, label: lbl }
        );
      })(routeKey, label);
    }
  }

  function ensureCatalogCommandsWatcher() {
    if (ensureCatalogCommandsWatcher._on) return;
    ensureCatalogCommandsWatcher._on = true;
    var obs = new MutationObserver(function () {
      if (document.querySelector('[data-voice-catalog-grid]')) {
        refreshDynamicCatalogCommands();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var row = [];
    var i;
    var j;
    for (j = 0; j <= b.length; j++) row[j] = j;
    for (i = 1; i <= a.length; i++) {
      var prev = i - 1;
      row[0] = i;
      for (j = 1; j <= b.length; j++) {
        var val = a.charAt(i - 1) === b.charAt(j - 1)
          ? prev
          : Math.min(prev + 1, row[j] + 1, row[j - 1] + 1);
        prev = row[j];
        row[j] = val;
      }
    }
    return row[b.length];
  }

  function normalizeVoiceText(text) {
    var s = String(text || '').trim().toLowerCase();
    s = s.replace(/[\s\u3000,.，。!！?？、；;:'"“”‘’\-—_()（）\[\]【】]/g, '');
    s = s.replace(/^(请|帮我|给我|麻烦)?(打开|进入|跳转|去|到|查看|看看|点开)+/g, '');
    var i;
    for (i = 0; i < ASR_TEXT_REPLACEMENTS.length; i++) {
      s = s.split(ASR_TEXT_REPLACEMENTS[i][0]).join(ASR_TEXT_REPLACEMENTS[i][1]);
    }
    return s;
  }

  function fuzzyContains(haystack, needle) {
    if (!needle || !haystack) return false;
    if (haystack.indexOf(needle) !== -1) return true;
    if (needle.length < 2) return false;
    var maxDist = needle.length <= 3 ? 1 : (needle.length <= 5 ? 2 : Math.floor(needle.length * 0.28));
    var len;
    var start;
    for (len = Math.max(2, needle.length - 1); len <= needle.length + 1; len++) {
      if (len > haystack.length) continue;
      for (start = 0; start <= haystack.length - len; start++) {
        if (levenshtein(haystack.substr(start, len), needle) <= maxDist) return true;
      }
    }
    return false;
  }

  function keywordMatches(normText, keyword) {
    return scoreKeywordMatch(normText, keyword) > 0;
  }

  /** 单条关键词得分：越长、越完整匹配分越高，避免短词误触 */
  function scoreKeywordMatch(normText, keyword) {
    var nk = normalizeVoiceText(keyword);
    if (!nk || !normText) return 0;
    if (nk.length <= 2) {
      if (normText === nk) return nk.length + 8;
      if (normText.indexOf(nk) !== -1 && normText.length <= nk.length + 3) return nk.length + 2;
      return 0;
    }
    if (normText === nk) return nk.length + 15;
    if (normText.indexOf(nk) !== -1) return nk.length + 6;
    if (nk.indexOf(normText) !== -1 && normText.length >= 3) return normText.length + 4;
    if (fuzzyContains(normText, nk)) return Math.max(4, nk.length - 1);
    return 0;
  }

  function scoreCommand(normText, cmd) {
    var best = 0;
    var matchedKw = '';
    var j;
    for (j = 0; j < cmd.keywords.length; j++) {
      var s = scoreKeywordMatch(normText, cmd.keywords[j]);
      if (s > best) {
        best = s;
        matchedKw = cmd.keywords[j];
      }
    }
    return {
      score: best,
      keyword: matchedKw,
      label: cmd.label || matchedKw,
    };
  }

  function match(text) {
    var norm = normalizeVoiceText(text);
    if (!norm) return null;
    if (document.querySelector('[data-voice-catalog-grid]')) {
      refreshDynamicCatalogCommands();
    }

    var best = null;
    var bestScore = 0;
    var bestMeta = null;
    var i;
    for (i = 0; i < commands.length; i++) {
      var s = scoreCommand(norm, commands[i]);
      if (s.score > bestScore) {
        bestScore = s.score;
        best = commands[i];
        bestMeta = s;
      }
    }
    if (!best || !bestMeta) return null;

    var minScore = norm.length <= 3 ? 5 : 4;
    if (bestScore < minScore) return null;

    var nk = normalizeVoiceText(bestMeta.keyword);
    if (norm.length >= 8 && nk.length <= 2) return null;
    if (norm.length >= 10 && nk.length <= 3 && bestScore < nk.length + 8) return null;

    return { cmd: best, label: bestMeta.label, keyword: bestMeta.keyword, score: bestScore };
  }

  function execVoiceText(text, options) {
    options = options || {};
    var matched = match(text);
    if (matched && matched.cmd) {
      if (options.onSuccess) options.onSuccess(text, matched.cmd, matched.label);
      else showToast('已执行：' + matched.label);
      matched.cmd.handler();
      return true;
    }
    if (options.onFail) {
      options.onFail(text);
    } else if (text) {
      showToast('"' + text + '" 未匹配到指令');
    } else {
      showToast('未识别到语音，请重试');
    }
    return false;
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

  // ==================== DOM 查找工具 ====================
  function findNavButton(label) {
    var tabId = NAV_TAB_BY_LABEL[label] || label;
    var btn = document.querySelector('[data-voice-nav-label="' + label + '"]');
    if (btn) return btn;
    btn = document.querySelector('[data-nav-tab="' + tabId + '"]');
    if (btn) return btn;
    btn = document.querySelector('[data-root-tab="' + tabId + '"]');
    if (btn) return btn;
    var nav = document.querySelector('.bottom-nav') || document.querySelector('#bottom-nav');
    if (nav) {
      var buttons = nav.querySelectorAll('button');
      var i;
      for (i = 0; i < buttons.length; i++) {
        if (buttons[i].textContent.indexOf(label) !== -1) return buttons[i];
      }
    }
    var allButtons = document.querySelectorAll('button');
    var k;
    for (k = 0; k < allButtons.length; k++) {
      if (allButtons[k].textContent.indexOf(label) !== -1) return allButtons[k];
    }
    return null;
  }

  function isCatalogGridVisible() {
    return !!document.querySelector('[data-voice-catalog-grid]');
  }

  function findCatalogMenuButton(routeKey, menuLabel) {
    var btn = null;
    if (routeKey) {
      btn = document.querySelector('[data-voice-catalog-grid] [data-route-key="' + routeKey + '"]');
      if (btn) return btn;
    }
    if (menuLabel) {
      btn = document.querySelector('[data-voice-catalog-grid] [data-menu-label="' + menuLabel + '"]');
      if (btn) return btn;
      var normLabel = normalizeVoiceText(menuLabel);
      var items = document.querySelectorAll('[data-voice-catalog-grid] [data-menu-label]');
      var i;
      for (i = 0; i < items.length; i++) {
        var el = items[i];
        var lbl = el.getAttribute('data-menu-label') || '';
        if (keywordMatches(normLabel, lbl) || keywordMatches(normalizeVoiceText(lbl), menuLabel)) {
          return el;
        }
      }
    }
    return null;
  }

  function goToCatalogTab(done) {
    if (isCatalogGridVisible()) {
      refreshDynamicCatalogCommands();
      if (done) done();
      return;
    }
    var tab = findNavButton('菜单') || document.querySelector('[data-nav-tab="catalog"]');
    if (!tab) {
      showToast('未找到菜单入口');
      return;
    }
    tab.click();
    var attempts = 0;
    function wait() {
      if (isCatalogGridVisible()) {
        refreshDynamicCatalogCommands();
        if (done) done();
        return;
      }
      attempts++;
      if (attempts > 30) {
        showToast('菜单页加载超时');
        return;
      }
      setTimeout(wait, 50);
    }
    wait();
  }

  function openCatalogMenu(routeKey, menuLabel) {
    goToCatalogTab(function () {
      var btn = findCatalogMenuButton(routeKey, menuLabel);
      if (btn) {
        btn.click();
        return;
      }
      showToast('未找到菜单：' + (menuLabel || routeKey || ''));
    });
  }

  function goToNavTab(tabLabel) {
    var btn = findNavButton(tabLabel);
    if (btn) btn.click();
    else showToast('未找到：' + tabLabel);
  }

  // ==================== 全局指令（固定 Tab / 特殊操作；业务菜单由 refreshDynamicCatalogCommands 同步） ====================
  addCmd(['返回', '主界面', '菜单', '目录', '首页', '主页'], function () {
    goToNavTab('菜单');
  }, { label: '菜单' });

  addCmd(['AI', 'ai', '人工智能', '智能助手', 'AI助手', '打开AI', '打开助手'], function () {
    goToNavTab('AI');
  }, { label: 'AI 助手' });

  addCmd(['消息', '打开消息', '消息中心', '通知中心'], function () {
    goToNavTab('消息');
  }, { label: '消息' });

  addCmd(['设置', '打开设置', '系统设置', '个人设置'], function () {
    goToNavTab('设置');
  }, { label: '设置' });

  /** 常见 ASR 误听 → 仍指向固定菜单名（需菜单页上存在对应 label） */
  addCmd(['盛产订单', '升产订单', '生产定单'], function () {
    openCatalogMenu('', '生产订单');
  }, { label: '生产订单' });

  addCmd(['报宫登记', '暴工登记'], function () {
    openCatalogMenu('', '生产报工登记');
  }, { label: '生产报工登记' });

  addCmd(['退出登录', '注销登录', '注销账号', '登出账号'], function () {
    var settingsTab = findNavButton('设置');
    if (settingsTab) settingsTab.click();
    setTimeout(function () {
      var logoutBtn = document.getElementById('btn-settings-logout');
      if (logoutBtn) { logoutBtn.click(); return; }
      var allButtons = document.querySelectorAll('button');
      var i;
      for (i = 0; i < allButtons.length; i++) {
        if (allButtons[i].textContent.indexOf('退出') !== -1) {
          allButtons[i].click();
          return;
        }
      }
      showToast('未找到退出按钮');
    }, 200);
  }, { label: '退出登录' });

  // ==================== APP 环境：桥接函数 ====================
  if (isInApp) {
    window.__voiceExec = function (text) {
      execVoiceText(text);
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
  /** 贴边时扩大的拖拽热区（比露出的一小条更好点） */
  var pullTab = document.createElement('button');
  pullTab.type = 'button';
  pullTab.className = 'voice-dock-pull';
  pullTab.setAttribute('aria-label', '拖出语音按钮');
  pullTab.hidden = true;
  wrapper.appendChild(pullTab);

  wrapper.appendChild(btnEl);

  var micEl = btnEl.querySelector('.voice-btn__mic');

  // ---- 状态 ----
  var state = 'idle';     // 'idle' | 'recording' | 'processing'
  var recording = null;   // { stop: fn, chunks: [], sampleRate: number }
  var maxRecordTimer = null;

  var VOICE_POS_STORAGE_KEY = 'voice_btn_pos_v2';
  var DRAG_THRESHOLD_PX = 8;
  /** 贴边后露出的宽度（越大越好点） */
  var EDGE_PEEK_PX = 34;
  /** 松手时距屏幕边 ≤ 此值才吸附（需用户自己拖到靠边） */
  var EDGE_SNAP_INSET_PX = 14;
  var EDGE_EXPAND_MARGIN_PX = 16;
  var dragState = null;
  var suppressVoiceClick = false;
  /** @type {null|'left'|'right'|'top'|'bottom'} */
  var voiceDockEdge = null;

  function parseVoiceSavedPos(raw) {
    try {
      var p = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!p || typeof p !== 'object') return null;
      var left = Number(p.left);
      var top = Number(p.top);
      if (!isFinite(left) || !isFinite(top)) return null;
      var edge = p.edge;
      if (edge && edge !== 'left' && edge !== 'right' && edge !== 'top' && edge !== 'bottom') {
        edge = null;
      }
      return { left: left, top: top, edge: edge || null };
    } catch (e) {
      return null;
    }
  }

  function setVoiceWrapperCoords(left, top) {
    wrapper.style.left = left + 'px';
    wrapper.style.top = top + 'px';
    wrapper.style.right = 'auto';
    wrapper.style.bottom = 'auto';
  }

  function clearVoiceDockClasses() {
    wrapper.classList.remove(
      'voice-wrapper--docked',
      'voice-wrapper--docked-left',
      'voice-wrapper--docked-right',
      'voice-wrapper--docked-top',
      'voice-wrapper--docked-bottom'
    );
  }

  function isVoiceWrapperDocked() {
    return !!voiceDockEdge;
  }

  function applyDockedPosition(edge) {
    var w = wrapper.offsetWidth || 56;
    var h = wrapper.offsetHeight || 56;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var rect = wrapper.getBoundingClientRect();
    var top = rect.top;
    var left = rect.left;
    var pad = 8;

    if (edge === 'left' || edge === 'right') {
      top = Math.max(pad, Math.min(vh - h - pad, top));
      left = edge === 'left' ? -(w - EDGE_PEEK_PX) : vw - EDGE_PEEK_PX;
    } else {
      left = Math.max(pad, Math.min(vw - w - pad, left));
      top = edge === 'top' ? -(h - EDGE_PEEK_PX) : vh - EDGE_PEEK_PX;
    }
    setVoiceWrapperCoords(left, top);
  }

  function updateDockPullVisibility() {
    if (pullTab) pullTab.hidden = !voiceDockEdge;
  }

  function dockVoiceWrapper(edge, skipSave) {
    voiceDockEdge = edge;
    clearVoiceDockClasses();
    wrapper.classList.add('voice-wrapper--docked', 'voice-wrapper--docked-' + edge);
    btnEl.setAttribute('aria-label', '展开语音按钮');
    bubble.hidden = true;
    updateDockPullVisibility();
    applyDockedPosition(edge);
    if (!skipSave) saveVoiceWrapperPosition();
  }

  function undockVoiceWrapper() {
    voiceDockEdge = null;
    clearVoiceDockClasses();
    btnEl.setAttribute('aria-label', '语音控制');
    updateDockPullVisibility();
  }

  /** 松手：仅当已拖到贴近某条边时才吸附；否则保持浮层位置 */
  function snapVoiceWrapperToEdge() {
    var rect = wrapper.getBoundingClientRect();
    var distLeft = rect.left;
    var distRight = window.innerWidth - rect.right;
    var distTop = rect.top;
    var distBottom = window.innerHeight - rect.bottom;
    var minDist = Math.min(distLeft, distRight, distTop, distBottom);

    if (minDist > EDGE_SNAP_INSET_PX) {
      undockVoiceWrapper();
      clampVoiceWrapperFullyVisible();
      saveVoiceWrapperPosition();
      return;
    }

    var edge = 'left';
    if (minDist === distRight) edge = 'right';
    else if (minDist === distTop) edge = 'top';
    else if (minDist === distBottom) edge = 'bottom';
    dockVoiceWrapper(edge);
  }

  /** 点击贴边半隐藏按钮时展开到屏幕内 */
  function expandVoiceFromDock() {
    if (!voiceDockEdge) return false;
    var edge = voiceDockEdge;
    var w = wrapper.offsetWidth || 56;
    var h = wrapper.offsetHeight || 56;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var rect = wrapper.getBoundingClientRect();
    var top = rect.top;
    var left = rect.left;
    var m = EDGE_EXPAND_MARGIN_PX;

    undockVoiceWrapper();

    if (edge === 'left') left = m;
    else if (edge === 'right') left = vw - w - m;
    else if (edge === 'top') top = m;
    else top = vh - h - m;

    left = Math.max(m, Math.min(vw - w - m, left));
    top = Math.max(m, Math.min(vh - h - m, top));
    setVoiceWrapperCoords(left, top);
    saveVoiceWrapperPosition();
    return true;
  }

  function applySavedVoicePosition() {
    var p = parseVoiceSavedPos(localStorage.getItem(VOICE_POS_STORAGE_KEY));
    if (!p) return;
    setVoiceWrapperCoords(p.left, p.top);
    if (p.edge) {
      dockVoiceWrapper(p.edge, true);
    } else {
      undockVoiceWrapper();
    }
  }

  function saveVoiceWrapperPosition() {
    var rect = wrapper.getBoundingClientRect();
    try {
      var payload = { left: rect.left, top: rect.top };
      if (voiceDockEdge) payload.edge = voiceDockEdge;
      localStorage.setItem(VOICE_POS_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) { /* ignore quota / private mode */ }
  }

  function voiceWrapperUsesCustomCoords() {
    return !!(wrapper.style && wrapper.style.left !== '' && wrapper.style.top !== '');
  }

  function clampVoiceWrapperFullyVisible() {
    if (!voiceWrapperUsesCustomCoords() || voiceDockEdge) return;
    var rect = wrapper.getBoundingClientRect();
    var w = rect.width;
    var h = rect.height;
    if (!w || !h) return;
    var maxL = Math.max(0, window.innerWidth - w);
    var maxT = Math.max(0, window.innerHeight - h);
    var nl = Math.min(maxL, Math.max(0, rect.left));
    var nt = Math.min(maxT, Math.max(0, rect.top));
    if (nl !== rect.left || nt !== rect.top) {
      setVoiceWrapperCoords(nl, nt);
    }
  }

  function clampVoiceWrapperToViewport() {
    if (!voiceWrapperUsesCustomCoords()) return;
    if (voiceDockEdge) {
      applyDockedPosition(voiceDockEdge);
      saveVoiceWrapperPosition();
      return;
    }
    clampVoiceWrapperFullyVisible();
    saveVoiceWrapperPosition();
  }

  /** 拖动时允许滑出屏幕，便于用户自己「推」进贴边区 */
  function clampVoiceWrapperWhileDragging(left, top, w, h) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var minLeft = -(w - EDGE_PEEK_PX);
    var maxLeft = vw - EDGE_PEEK_PX;
    var minTop = -(h - EDGE_PEEK_PX);
    var maxTop = vh - EDGE_PEEK_PX;
    return {
      left: Math.max(minLeft, Math.min(maxLeft, left)),
      top: Math.max(minTop, Math.min(maxTop, top)),
    };
  }

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
  function startRecording(cb) {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        var audioTrack = stream.getAudioTracks()[0];
        // 强制启用音轨，确保未被浏览器静音
        if (audioTrack) audioTrack.enabled = true;
        sendDebugLog('[TRACK] kind=' + (audioTrack ? audioTrack.kind : 'none') + ' enabled=' + (audioTrack ? audioTrack.enabled : '?') + ' muted=' + (audioTrack ? audioTrack.muted : '?') + ' readyState=' + (audioTrack ? audioTrack.readyState : '?'));

        try {
          var Ctor = window.AudioContext || window.webkitAudioContext;
          // 强制 16000 采样率，百度 ASR 只支持 8000/16000
          var ctx = new Ctor({ sampleRate: 16000 });
          var actualRate = ctx.sampleRate;
          var source = ctx.createMediaStreamSource(stream);
          var processor = ctx.createScriptProcessor(4096, 1, 1);
          var chunks = [];

          processor.onaudioprocess = function (e) {
            var inCh = e.inputBuffer.getChannelData(0);
            var outCh = e.outputBuffer.getChannelData(0);
            // 数据直通：输入 → 输出（部分浏览器需要此通路才产生真实数据）
            for (var i = 0; i < inCh.length; i++) {
              outCh[i] = inCh[i];
            }
            chunks.push(new Float32Array(inCh));
          };

          source.connect(processor);
          // 连接到静音 GainNode 而非 destination，避免回声
          var silenceGain = ctx.createGain();
          silenceGain.gain.value = 0;
          processor.connect(silenceGain);
          silenceGain.connect(ctx.destination);

          var rec = {
            stop: function () {
              source.disconnect();
              processor.disconnect();
              silenceGain.disconnect();
              stream.getTracks().forEach(function (t) { t.stop(); });
              ctx.close();
              return { chunks: chunks, sampleRate: actualRate };
            }
          };

          cb(null, rec);
        } catch (e) {
          cb(new Error('录音启动失败: ' + (e.message || 'unknown')));
        }
      })
      .catch(function () {
        cb(new Error('麦克风权限未授权'));
      });
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

      sendDebugLog('[ASR_OK] text=' + text);

      var ok = execVoiceText(text, {
        onSuccess: function (t, m, actionLabel) {
          sendDebugLog('[MATCH_OK] text=' + t + ' action=' + actionLabel + ' keywords=' + m.keywords.join(','));
          showBubble('已执行：' + (actionLabel || t), true);
        },
        onFail: function (t) {
          if (t) {
            sendDebugLog('[NO_MATCH] text=' + t);
            showBubble('"' + t + '" 未匹配到指令', true);
          } else {
            showBubble('未识别到语音，请重试', true);
          }
        },
      });
    });
  }

  function isVoiceDragTarget(el) {
    if (!el || !wrapper.contains(el)) return false;
    if (voiceDockEdge) {
      return el === pullTab || el === btnEl || el === wrapper || pullTab.contains(el) || btnEl.contains(el);
    }
    return el === btnEl || btnEl.contains(el);
  }

  function beginVoicePointerDrag(e, captureEl) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (state !== 'idle') return;
    var r = wrapper.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: r.left,
      origTop: r.top,
      moved: false,
      wasDocked: !!voiceDockEdge,
      captureEl: captureEl,
    };
    try {
      captureEl.setPointerCapture(e.pointerId);
    } catch (err) { /* older browsers */ }
  }

  function onVoicePointerDown(e) {
    if (!isVoiceDragTarget(e.target)) return;
    beginVoicePointerDrag(e, e.target === pullTab ? pullTab : btnEl);
  }

  function onVoicePointerMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    var dx = e.clientX - dragState.startX;
    var dy = e.clientY - dragState.startY;
    if (!dragState.moved) {
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      dragState.moved = true;
      if (voiceDockEdge) {
        undockVoiceWrapper();
        var r0 = wrapper.getBoundingClientRect();
        dragState.origLeft = r0.left;
        dragState.origTop = r0.top;
        dragState.startX = e.clientX;
        dragState.startY = e.clientY;
        dx = 0;
        dy = 0;
      }
      wrapper.classList.add('voice-wrapper--dragging');
    }
    var w = wrapper.offsetWidth;
    var h = wrapper.offsetHeight;
    var clamped = clampVoiceWrapperWhileDragging(dragState.origLeft + dx, dragState.origTop + dy, w, h);
    setVoiceWrapperCoords(clamped.left, clamped.top);
  }

  function endVoicePointerDrag(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    try {
      if (dragState.captureEl) {
        dragState.captureEl.releasePointerCapture(e.pointerId);
      }
    } catch (err) { /* ignore */ }
    if (dragState.moved) {
      suppressVoiceClick = true;
      snapVoiceWrapperToEdge();
    } else if (dragState.wasDocked) {
      suppressVoiceClick = true;
      expandVoiceFromDock();
    }
    wrapper.classList.remove('voice-wrapper--dragging');
    dragState = null;
  }

  pullTab.addEventListener('pointerdown', onVoicePointerDown);
  btnEl.addEventListener('pointerdown', onVoicePointerDown);
  pullTab.addEventListener('pointermove', onVoicePointerMove);
  btnEl.addEventListener('pointermove', onVoicePointerMove);
  pullTab.addEventListener('pointerup', endVoicePointerDrag);
  btnEl.addEventListener('pointerup', endVoicePointerDrag);
  pullTab.addEventListener('pointercancel', endVoicePointerDrag);
  btnEl.addEventListener('pointercancel', endVoicePointerDrag);

  btnEl.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();

    if (suppressVoiceClick) {
      suppressVoiceClick = false;
      return;
    }

    if (isVoiceWrapperDocked()) {
      return;
    }

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
      sendDebugLog('[REC_OK] recording started');
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

  var style = document.createElement('style');
  style.textContent =
    '.voice-wrapper{position:fixed;bottom:100px;right:16px;z-index:9999;display:flex;flex-direction:column;align-items:flex-end;gap:8px;touch-action:none}' +
    '.voice-wrapper:not(.voice-wrapper--dragging){transition:left .28s ease,top .28s ease}' +
    '.voice-wrapper--dragging{transition:none}' +
    '.voice-wrapper--dragging .voice-btn{transition:none}' +
    '.voice-wrapper--dragging .voice-btn:active{transform:none}' +
    '.voice-wrapper--docked .voice-bubble{display:none!important}' +
    '.voice-wrapper--docked-left{align-items:flex-start}' +
    '.voice-wrapper--docked-right{align-items:flex-end}' +
    '.voice-wrapper--docked-top{align-items:center}' +
    '.voice-wrapper--docked-bottom{align-items:center}' +
    '.voice-dock-pull{display:none;position:absolute;border:none;padding:0;margin:0;background:rgba(37,99,235,.25);z-index:2;touch-action:none;-webkit-tap-highlight-color:transparent;cursor:grab}' +
    '.voice-wrapper--docked .voice-dock-pull{display:block}' +
    '.voice-wrapper--dragging .voice-dock-pull{cursor:grabbing;background:rgba(37,99,235,.35)}' +
    '.voice-wrapper--docked-left .voice-dock-pull{right:0;top:50%;transform:translateY(-50%);width:40px;height:88px;border-radius:0 12px 12px 0}' +
    '.voice-wrapper--docked-right .voice-dock-pull{left:0;top:50%;transform:translateY(-50%);width:40px;height:88px;border-radius:12px 0 0 12px}' +
    '.voice-wrapper--docked-top .voice-dock-pull{bottom:0;left:50%;transform:translateX(-50%);width:88px;height:40px;border-radius:0 0 12px 12px}' +
    '.voice-wrapper--docked-bottom .voice-dock-pull{top:0;left:50%;transform:translateX(-50%);width:88px;height:40px;border-radius:12px 12px 0 0}' +
    '.voice-wrapper--docked .voice-btn{pointer-events:none}' +
    '.voice-bubble{background:#0f172a;color:#fff;font-size:14px;padding:8px 16px;border-radius:16px 16px 4px 16px;box-shadow:0 4px 12px rgba(0,0,0,.25);max-width:200px;line-height:1.4}' +
    '.voice-btn{width:56px;height:56px;border-radius:50%;border:none;background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.3);cursor:pointer;transition:all .2s;-webkit-tap-highlight-color:transparent;touch-action:none;user-select:none}' +
    '.voice-btn:active{transform:scale(.95)}' +
    '.voice-btn--listening{width:64px;height:64px;background:#ef4444;transform:scale(1.1)}' +
    '.voice-btn__mic--listening{animation:voice-pulse .8s ease-in-out infinite}' +
    '@keyframes voice-pulse{0%,100%{opacity:1}50%{opacity:.4}}';
  document.head.appendChild(style);

  document.body.appendChild(wrapper);
  ensureCatalogCommandsWatcher();
  refreshDynamicCatalogCommands();
  applySavedVoicePosition();
  clampVoiceWrapperToViewport();

  window.addEventListener('resize', function () {
    window.requestAnimationFrame(clampVoiceWrapperToViewport);
  });

  // 页面加载完成标记，方便排查 voice.js 是否正确初始化
  sendDebugLog('[PAGE_READY] voice.js loaded, getUserMedia=' + (!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)));
})();
