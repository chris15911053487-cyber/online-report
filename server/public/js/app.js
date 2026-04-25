(function () {
  'use strict';

  var TOKEN_KEY = 'online_report_token';
  var apiBase = '';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function authHeaders() {
    var t = getToken();
    var h = { 'Content-Type': 'application/json' };
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

  function apiFetch(path, options) {
    options = options || {};
    options.headers = Object.assign({}, authHeaders(), options.headers || {});
    return fetch(apiBase + path, options).then(function (res) {
      return res.text().then(function (text) {
        var data = {};
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (_) {
            data = { error: text };
          }
        }
        if (!res.ok) {
          var line =
            data.error ||
            data.message ||
            (res.status + ' ' + (res.statusText || ''));
          if (data.code) {
            line += ' [' + data.code + ']';
          }
          var err = new Error(line.trim() || '请求失败');
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /** 报表查询：超时略大于服务端 REPORT_QUERY_TIMEOUT_MS（默认 60s） */
  function apiFetchReport(path, options) {
    options = options || {};
    var ctrl = new AbortController();
    var ms = 90000;
    var t = setTimeout(function () {
      ctrl.abort();
    }, ms);
    options.signal = ctrl.signal;
    options.headers = Object.assign({}, options.headers || {});
    return apiFetch(path, options).finally(function () {
      clearTimeout(t);
    });
  }

  /**
   * 触摸 / 设备模拟 / iOS：仅用 touchend 在 Chrome 设备模式（指针模拟）下可能收不到。
   * 优先用 PointerEvent（pointerup）统一鼠标与触摸，再用 click 去重兜底。
   */
  function bindTap(el, handler) {
    function invoke(e) {
      if (el.disabled) return;
      handler(e);
    }
    if (window.PointerEvent) {
      var lastPointerUpAt = 0;
      el.addEventListener(
        'pointerup',
        function (e) {
          if (el.disabled || e.button !== 0) return;
          e.preventDefault();
          lastPointerUpAt = Date.now();
          invoke(e);
        },
        { passive: false }
      );
      el.addEventListener('click', function (e) {
        if (el.disabled) return;
        if (Date.now() - lastPointerUpAt < 500) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        invoke(e);
      });
    } else {
      var lastTouchEndAt = 0;
      el.addEventListener(
        'touchend',
        function (e) {
          if (el.disabled) return;
          e.preventDefault();
          lastTouchEndAt = Date.now();
          invoke(e);
        },
        { passive: false }
      );
      el.addEventListener('click', function (e) {
        if (el.disabled) return;
        if (Date.now() - lastTouchEndAt < 500) {
          e.preventDefault();
          return;
        }
        invoke(e);
      });
    }
  }

  var el = {
    login: document.getElementById('view-login'),
    catalog: document.getElementById('view-catalog'),
    catalogGrid: document.getElementById('catalog-grid'),
    catalogEmpty: document.getElementById('catalog-empty'),
    favorites: document.getElementById('view-favorites'),
    messages: document.getElementById('view-messages'),
    tabSettings: document.getElementById('view-tab-settings'),
    settingsDisplayName: document.getElementById('settings-display-name'),
    settingsUsername: document.getElementById('settings-username'),
    settingsRole: document.getElementById('settings-role'),
    btnSettingsLogout: document.getElementById('btn-settings-logout'),
    owor: document.getElementById('view-owor'),
    oworList: document.getElementById('owor-list'),
    oworTablePanel: document.getElementById('owor-table-panel'),
    oworEmpty: document.getElementById('owor-empty'),
    oworErr: document.getElementById('owor-err'),
    orders: document.getElementById('view-orders'),
    menuSettings: document.getElementById('view-menu-settings'),
    detail: document.getElementById('view-detail'),
    title: document.getElementById('page-title'),
    btnBack: document.getElementById('btn-back'),
    formLogin: document.getElementById('form-login'),
    loginErr: document.getElementById('login-err'),
    orderList: document.getElementById('order-list'),
    ordersEmpty: document.getElementById('orders-empty'),
    detailHead: document.getElementById('detail-head'),
    formReport: document.getElementById('form-report'),
    reportErr: document.getElementById('report-err'),
    opWrap: document.getElementById('op-wrap'),
    opChips: document.getElementById('op-chips'),
    reportList: document.getElementById('report-list'),
    reportsEmpty: document.getElementById('reports-empty'),
    toast: document.getElementById('toast'),
    menuAdminList: document.getElementById('menu-admin-list'),
    formAddMenu: document.getElementById('form-add-menu'),
    menuAddErr: document.getElementById('menu-add-err'),
    bottomNav: document.getElementById('bottom-nav'),
    dynamicReport: document.getElementById('view-dynamic-report'),
    dynamicReportTitle: document.getElementById('dynamic-report-title'),
    dynamicReportFormWrap: document.getElementById('dynamic-report-form-wrap'),
    dynamicReportErr: document.getElementById('dynamic-report-err'),
    dynamicReportTableWrap: document.getElementById('dynamic-report-table-wrap'),
    proSignListSticky: document.getElementById('pro-sign-list-sticky'),
    proSignListMergeBtn: document.getElementById('pro-sign-list-merge-btn'),
    reportRowDetail: document.getElementById('view-report-row-detail'),
    reportRowDetailBody: document.getElementById('report-row-detail-body'),
    reportOverlay: document.getElementById('report-overlay'),
    reportOverlayBackdrop: document.getElementById('report-overlay-backdrop'),
    reportOverlayTitle: document.getElementById('report-overlay-title'),
    reportOverlayBody: document.getElementById('report-overlay-body'),
    reportOverlayClose: document.getElementById('report-overlay-close'),
    proSignReceive: document.getElementById('view-pro-sign-receive'),
    proSignReceiveScroll: document.getElementById('pro-sign-receive-scroll'),
    proSignReceiveSticky: document.getElementById('pro-sign-receive-sticky'),
    proSignReceiveBtnSave: document.getElementById('pro-sign-receive-btn-save'),
    workRegistration: document.getElementById('view-work-registration'),
    workRegHead: document.getElementById('work-reg-head'),
    workRegToolbar: document.getElementById('work-reg-toolbar'),
    workRegLines: document.getElementById('work-reg-lines'),
    workRegErr: document.getElementById('work-reg-err'),
  };

  var state = {
    viewName: 'login',
    rootTab: 'catalog',
    userRole: 'operator',
    userDisplayName: '',
    username: '',
    navMenus: [],
    currentOrderId: null,
    detail: null,
    selectedOpId: null,
    dynamicReportRouteKey: '',
    dynamicReportLabel: '',
    dynamicReportFilterSchema: [],
    reportPage: 1,
    reportPageSize: 50,
    reportTotalRowCount: 0,
    reportTruncated: false,
    reportClientSidePaging: false,
    reportClientRowsBuffer: null,
    reportServerRows: null,
    reportLastColumns: [],
    dynamicReportColumnLabels: {},
    dynamicReportRowDetail: { enabled: false, keyColumn: '' },
    proSignMode: false,
    proSignMenu: null,
    proSignTableRows: null,
    proSignReceiveMerge: null,
    proSignReceiveLineResults: null,
    proSignReceiveMergeButtonLabel: null,
    proSignReceiveClockTimer: null,
    proSignSavePreviewOpen: false,
    proSignSavePosting: false,
    /** 从 bindTap(pointerup) 刚打开全屏层时，忽略首轮回弹到 backdrop 的「幽灵 click」，避免移动端/设备模式一打开就关 */
    reportOverlayBackdropGuardUntil: 0,
    workRegBatchId: null,
    workRegPollTimer: null,
    workRegUiTimer: null,
    workRegSnapshot: null,
  };

  function statusLabel(s) {
    var map = {
      open: '待开工',
      in_progress: '进行中',
      completed: '已完成',
      cancelled: '已取消',
    };
    return map[s] || s;
  }

  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      el.toast.hidden = true;
    }, 2200);
  }

  function updateTitle() {
    var v = state.viewName;
    var t = state.rootTab;
    var title = '生产报工';
    if (v === 'login') title = '生产报工';
    else if (v === 'root') {
      if (t === 'catalog') title = '目录';
      else if (t === 'favorites') title = '常用';
      else if (t === 'messages') title = '消息';
      else if (t === 'settings') title = '设置';
    } else if (v === 'owor') title = '生产订单';
    else if (v === 'orders') title = '报工订单';
    else if (v === 'menu-settings') title = '菜单设置';
    else if (v === 'dynamic-report') title = state.dynamicReportLabel || '报表';
    else if (v === 'pro-sign-receive') {
      var mergeSuffix = state.proSignReceiveMergeButtonLabel || '接单';
      title = '合并报工·' + mergeSuffix;
    }
    else if (v === 'work-registration') title = '报工登记';
    else if (v === 'report-row-detail') title = '行详情';
    else if (v === 'detail') title = '订单报工';
    el.title.textContent = title;
  }

  function syncSettingsPanel() {
    el.settingsDisplayName.textContent = state.userDisplayName || '—';
    el.settingsUsername.textContent = state.username || '—';
    var roleLabel = state.userRole === 'admin' ? '管理员' : '普通用户';
    el.settingsRole.textContent = roleLabel;
  }

  function applyUI() {
    var v = state.viewName;
    el.login.hidden = v !== 'login';
    var isRoot = v === 'root';
    var rt = state.rootTab;
    el.catalog.hidden = !isRoot || rt !== 'catalog';
    el.favorites.hidden = !isRoot || rt !== 'favorites';
    el.messages.hidden = !isRoot || rt !== 'messages';
    el.tabSettings.hidden = !isRoot || rt !== 'settings';
    el.owor.hidden = v !== 'owor';
    el.orders.hidden = v !== 'orders';
    el.menuSettings.hidden = v !== 'menu-settings';
    el.dynamicReport.hidden = v !== 'dynamic-report';
    el.reportRowDetail.hidden = v !== 'report-row-detail';
    el.detail.hidden = v !== 'detail';
    if (el.proSignReceive) el.proSignReceive.hidden = v !== 'pro-sign-receive';
    if (el.proSignReceiveSticky) {
      el.proSignReceiveSticky.hidden = v !== 'pro-sign-receive';
    }
    if (el.workRegistration) el.workRegistration.hidden = v !== 'work-registration';

    el.btnBack.hidden = v === 'login' || v === 'root';

    el.bottomNav.hidden = v !== 'root';
    document.body.classList.toggle('has-bottom-nav', v === 'root');
    var showProSignListSticky = v === 'dynamic-report' && state.proSignMode;
    if (el.proSignListSticky) el.proSignListSticky.hidden = !showProSignListSticky;
    document.body.classList.toggle('has-pro-sign-list-sticky', showProSignListSticky);
    if (showProSignListSticky) syncProSignMergeButtonLabel();
    document.body.classList.toggle('app-dark', v !== 'login');

    updateTitle();
    updateBottomTabActive();
    if (isRoot && rt === 'settings') syncSettingsPanel();
  }

  function updateBottomTabActive() {
    var tabs = el.bottomNav.querySelectorAll('[data-root-tab]');
    tabs.forEach(function (btn) {
      var tab = btn.getAttribute('data-root-tab');
      var on = state.viewName === 'root' && state.rootTab === tab;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-current', on ? 'page' : 'false');
    });
  }

  function goRoot(tab) {
    state.viewName = 'root';
    state.rootTab = tab || 'catalog';
    applyUI();
    if (state.rootTab === 'catalog') renderCatalogGrid();
  }

  function renderCatalogGrid() {
    el.catalogGrid.innerHTML = '';
    var items = state.navMenus || [];
    if (items.length === 0) {
      el.catalogEmpty.hidden = false;
      return;
    }
    el.catalogEmpty.hidden = true;
    items.forEach(function (m) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'catalog-tile';
      var icon = document.createElement('span');
      icon.className = 'catalog-tile-icon';
      icon.textContent = m.icon && String(m.icon).trim() ? m.icon : '◇';
      icon.setAttribute('aria-hidden', 'true');
      var lb = document.createElement('span');
      lb.className = 'catalog-tile-label';
      lb.textContent = m.label;
      btn.appendChild(icon);
      btn.appendChild(lb);
      btn.addEventListener('click', function () {
        navigateToRoute(m.routeKey);
      });
      el.catalogGrid.appendChild(btn);
    });
  }

  function navigateToRoute(key) {
    if (key === 'orders') {
      goOwor();
      return;
    }
    if (key === 'menu-settings') {
      goMenuSettings();
      return;
    }
    var menus = state.navMenus || [];
    var found = null;
    for (var i = 0; i < menus.length; i++) {
      if (menus[i].routeKey === key) {
        found = menus[i];
        break;
      }
    }
    if (key === 'pro-sign' && found) {
      goProSignList(found);
      return;
    }
    if (found && found.menuKind === 'report') {
      goDynamicReport(found);
      return;
    }
    showToast('该菜单页面尚未接入');
  }

  function goBackFromProSignReceive() {
    state.proSignSavePosting = false;
    state.proSignSavePreviewOpen = false;
    if (el.reportOverlay) el.reportOverlay.hidden = true;
    if (el.reportOverlayBody) el.reportOverlayBody.innerHTML = '';
    if (el.proSignReceiveBtnSave) {
      el.proSignReceiveBtnSave.disabled = false;
      el.proSignReceiveBtnSave.textContent = '保存';
    }
    clearProSignReceiveClock();
    state.proSignReceiveMerge = null;
    state.proSignReceiveLineResults = null;
    state.proSignReceiveMergeButtonLabel = null;
    state.viewName = 'dynamic-report';
    state.proSignMode = true;
    applyUI();
    window.scrollTo(0, 0);
    if (state.reportServerRows != null || (state.reportClientRowsBuffer && state.reportClientRowsBuffer.length)) {
      renderDynamicReportResult();
    } else {
      runDynamicReportQuery(false);
    }
  }

  function goProSignList(menu) {
    clearWorkRegTimers();
    state.proSignMode = true;
    state.proSignMenu = menu;
    state.viewName = 'dynamic-report';
    state.dynamicReportRouteKey = 'pro-sign';
    state.dynamicReportLabel = (menu && menu.label) || '生产报工';
    state.dynamicReportFilterSchema =
      menu && menu.menuKind === 'report' ? menu.filterSchema || [] : [];
    state.dynamicReportRowDetail = { enabled: false, keyColumn: '' };
    state.reportPage = 1;
    state.reportPageSize = 50;
    state.reportTotalRowCount = 0;
    state.reportTruncated = false;
    state.reportClientSidePaging = false;
    state.reportClientRowsBuffer = null;
    state.reportServerRows = null;
    state.reportLastColumns = [];
    state.dynamicReportColumnLabels =
      menu && menu.menuKind === 'report' && menu.columnLabels && typeof menu.columnLabels === 'object'
        ? menu.columnLabels
        : {};
    if (el.dynamicReportErr) {
      el.dynamicReportErr.hidden = true;
      el.dynamicReportErr.textContent = '';
    }
    if (el.dynamicReportTableWrap) el.dynamicReportTableWrap.innerHTML = '';
    applyUI();
    if (el.dynamicReportTitle) el.dynamicReportTitle.textContent = state.dynamicReportLabel;
    renderDynamicReportForm();
  }

  function clearWorkRegTimers() {
    if (state.workRegPollTimer) {
      clearInterval(state.workRegPollTimer);
      state.workRegPollTimer = null;
    }
    if (state.workRegUiTimer) {
      clearInterval(state.workRegUiTimer);
      state.workRegUiTimer = null;
    }
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatDuration(totalSec) {
    var s = Math.max(0, Math.floor(Number(totalSec) || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(sec);
    return m + ':' + pad2(sec);
  }

  function proSignBatchStatusLabel(st) {
    var map = {
      pending: '待接单',
      received: '已接单',
      in_progress: '进行中',
      paused: '已暂停',
      completed: '已完工',
    };
    return map[st] || st || '—';
  }

  function goWorkRegistration(batchId) {
    clearWorkRegTimers();
    state.proSignMode = false;
    state.proSignReceiveMerge = null;
    state.proSignReceiveLineResults = null;
    state.proSignReceiveMergeButtonLabel = null;
    state.viewName = 'work-registration';
    state.workRegBatchId = batchId;
    state.workRegSnapshot = null;
    applyUI();
    window.scrollTo(0, 0);
    if (el.workRegErr) {
      el.workRegErr.hidden = true;
      el.workRegErr.textContent = '';
    }
    loadWorkRegistration(batchId);
  }

  function loadWorkRegistration(batchId) {
    if (!el.workRegHead) return;
    el.workRegHead.innerHTML = '<p class="muted" style="text-align:center">加载中…</p>';
    if (el.workRegToolbar) el.workRegToolbar.innerHTML = '';
    if (el.workRegLines) el.workRegLines.innerHTML = '';
    apiFetch('/pro-sign/batches/' + batchId)
      .then(function (data) {
        state.workRegSnapshot = data;
        renderWorkRegistrationUI(data);
        startWorkRegistrationPolling(batchId);
      })
      .catch(function (err) {
        if (el.workRegHead)
          el.workRegHead.innerHTML = '<p class="err">' + (err.message || '加载失败') + '</p>';
        if (err.status === 401) goLogin();
      });
  }

  function renderWorkRegistrationUI(data) {
    var batch = data.batch || {};
    var lines = data.lines || [];
    var st = batch.status || '';

    if (el.workRegHead) {
      el.workRegHead.innerHTML =
        '<h2 class="section-title">报工登记</h2>' +
        '<p class="work-reg-meta">账号：<strong>' +
        (state.username || '—') +
        '</strong></p>' +
        '<p class="work-reg-meta">状态：<span class="work-reg-status">' +
        proSignBatchStatusLabel(st) +
        '</span></p>' +
        '<p class="work-reg-meta">累计工时：<span id="work-reg-duration">' +
        formatDuration(batch.displayWorkingSeconds) +
        '</span>（计时含暂停前有效时间）</p>' +
        (batch.pauseReason
          ? '<p class="work-reg-pause-reason">暂停原因：' +
            String(batch.pauseReason).replace(/</g, '&lt;') +
            '</p>'
          : '');
    }

    if (el.workRegToolbar) {
      el.workRegToolbar.innerHTML = '';
      el.workRegToolbar.className = 'work-reg-toolbar';

      function addBtn(label, cls, onTap) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = cls || 'btn-primary';
        b.textContent = label;
        bindTap(b, onTap);
        el.workRegToolbar.appendChild(b);
      }

      if (st === 'pending') {
        addBtn('接单开工', 'btn-primary', function () {
          apiFetch('/pro-sign/batches/' + state.workRegBatchId + '/accept', { method: 'POST', body: '{}' })
            .then(function () {
              showToast('已开始');
              loadWorkRegistration(state.workRegBatchId);
            })
            .catch(function (e) {
              showToast(e.message || '失败');
            });
        });
      }
      if (st === 'in_progress') {
        addBtn('暂停', 'btn-secondary', function () {
          var reason = window.prompt('请填写暂停原因（必填）');
          if (reason == null || !String(reason).trim()) {
            showToast('已取消');
            return;
          }
          apiFetch('/pro-sign/batches/' + state.workRegBatchId + '/pause', {
            method: 'POST',
            body: JSON.stringify({ reason: String(reason).trim() }),
          })
            .then(function () {
              showToast('已暂停');
              loadWorkRegistration(state.workRegBatchId);
            })
            .catch(function (e) {
              showToast(e.message || '失败');
            });
        });
      }
      if (st === 'paused') {
        addBtn('继续开工', 'btn-primary', function () {
          apiFetch('/pro-sign/batches/' + state.workRegBatchId + '/resume', { method: 'POST', body: '{}' })
            .then(function () {
              showToast('已继续');
              loadWorkRegistration(state.workRegBatchId);
            })
            .catch(function (e) {
              showToast(e.message || '失败');
            });
        });
      }
      if (st === 'in_progress' || st === 'paused') {
        addBtn('提交报工', 'btn-primary', function () {
          submitWorkRegistration();
        });
      }
    }

    if (el.workRegLines) {
      var table = document.createElement('table');
      table.className = 'owor-data-table work-reg-lines-table';
      var thead = document.createElement('thead');
      var trh = document.createElement('tr');
      ['订单', '工序', '良品', '不良', '备注']
        .forEach(function (h) {
          var th = document.createElement('th');
          th.textContent = h;
          trh.appendChild(th);
        });
      thead.appendChild(trh);
      var tbody = document.createElement('tbody');
      lines.forEach(function (line) {
        var tr = document.createElement('tr');
        tr.dataset.lineId = String(line.lineId);
        var tdOrder = document.createElement('td');
        tdOrder.textContent =
          (line.orderNo || '') + ' · ' + (line.productName || '');
        var tdOp = document.createElement('td');
        tdOp.textContent = (line.seqNo != null ? line.seqNo + '. ' : '') + (line.operationName || '');
        var tdGood = document.createElement('td');
        var inGood = document.createElement('input');
        inGood.type = 'number';
        inGood.step = 'any';
        inGood.min = '0';
        inGood.className = 'work-reg-qty';
        inGood.name = 'good';
        inGood.disabled = st === 'completed';
        tdGood.appendChild(inGood);
        var tdScrap = document.createElement('td');
        var inScrap = document.createElement('input');
        inScrap.type = 'number';
        inScrap.step = 'any';
        inScrap.min = '0';
        inScrap.value = '0';
        inScrap.className = 'work-reg-qty';
        inScrap.name = 'scrap';
        inScrap.disabled = st === 'completed';
        tdScrap.appendChild(inScrap);
        var tdRm = document.createElement('td');
        var inRm = document.createElement('input');
        inRm.type = 'text';
        inRm.className = 'work-reg-remark';
        inRm.name = 'remark';
        inRm.disabled = st === 'completed';
        tdRm.appendChild(inRm);
        tr.appendChild(tdOrder);
        tr.appendChild(tdOp);
        tr.appendChild(tdGood);
        tr.appendChild(tdScrap);
        tr.appendChild(tdRm);
        tbody.appendChild(tr);
      });
      table.appendChild(thead);
      table.appendChild(tbody);
      el.workRegLines.innerHTML = '';
      el.workRegLines.appendChild(table);
      if (st === 'completed') {
        var done = document.createElement('p');
        done.className = 'muted';
        done.style.marginTop = '12px';
        done.textContent = '该批次已提交完工。';
        el.workRegLines.appendChild(done);
      }
    }

    var durEl = document.getElementById('work-reg-duration');
    if (durEl && batch.displayWorkingSeconds != null) {
      durEl.textContent = formatDuration(batch.displayWorkingSeconds);
    }
  }

  function startWorkRegistrationPolling(batchId) {
    clearWorkRegTimers();
    state.workRegPollTimer = setInterval(function () {
      apiFetch('/pro-sign/batches/' + batchId)
        .then(function (data) {
          state.workRegSnapshot = data;
          var batch = data.batch || {};
          var durEl = document.getElementById('work-reg-duration');
          if (durEl) durEl.textContent = formatDuration(batch.displayWorkingSeconds);
          var stEl = document.querySelector('.work-reg-status');
          if (stEl) stEl.textContent = proSignBatchStatusLabel(batch.status);
        })
        .catch(function () {});
    }, 5000);
    state.workRegUiTimer = setInterval(function () {
      var snap = state.workRegSnapshot;
      if (!snap || !snap.batch) return;
      var b = snap.batch;
      var sec = Number(b.displayWorkingSeconds) || 0;
      if (b.status === 'in_progress' && b.lastActiveAt) {
        var t0 = new Date(b.lastActiveAt).getTime();
        if (!Number.isNaN(t0)) {
          var base = Number(b.totalWorkingSeconds) || 0;
          sec = base + Math.max(0, Math.floor((Date.now() - t0) / 1000));
        }
      }
      var durEl = document.getElementById('work-reg-duration');
      if (durEl) durEl.textContent = formatDuration(sec);
    }, 1000);
  }

  function submitWorkRegistration() {
    if (!el.workRegLines || !state.workRegBatchId) return;
    var rows = el.workRegLines.querySelectorAll('tbody tr');
    var lines = [];
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      var lid = tr.dataset.lineId;
      if (!lid) continue;
      var goodEl = tr.querySelector('input[name="good"]');
      var scrapEl = tr.querySelector('input[name="scrap"]');
      var rmEl = tr.querySelector('input[name="remark"]');
      var good = parseFloat(goodEl && goodEl.value);
      var scrap = parseFloat((scrapEl && scrapEl.value) || '0');
      if (!isFinite(good) || good < 0) {
        showToast('请填写有效的良品数量');
        return;
      }
      if (!isFinite(scrap) || scrap < 0) {
        showToast('请填写有效的不良数量');
        return;
      }
      lines.push({
        lineId: Number(lid),
        goodQty: good,
        scrapQty: scrap,
        remark: (rmEl && rmEl.value) || '',
      });
    }
    if (lines.length === 0) {
      showToast('无明细行');
      return;
    }
    var anyQty = false;
    for (var j = 0; j < lines.length; j++) {
      if (lines[j].goodQty + lines[j].scrapQty > 0) {
        anyQty = true;
        break;
      }
    }
    if (!anyQty) {
      showToast('请至少填写一行数量（良品或不良）');
      return;
    }
    apiFetch('/pro-sign/batches/' + state.workRegBatchId + '/submit', {
      method: 'POST',
      body: JSON.stringify({ lines: lines }),
    })
      .then(function () {
        showToast('报工已提交');
        clearWorkRegTimers();
        goProSignList(
          state.proSignMenu || {
            label: '生产报工',
            menuKind: 'report',
            filterSchema: [],
            columnLabels: {},
          }
        );
      })
      .catch(function (e) {
        showToast(e.message || '提交失败');
      });
  }

  function goDynamicReport(menu) {
    state.proSignMode = false;
    state.proSignMenu = null;
    state.viewName = 'dynamic-report';
    state.dynamicReportRouteKey = menu.routeKey;
    state.dynamicReportLabel = menu.label || '报表';
    state.dynamicReportFilterSchema = menu.filterSchema || [];
    state.dynamicReportColumnLabels =
      menu.columnLabels && typeof menu.columnLabels === 'object' ? menu.columnLabels : {};
    state.dynamicReportRowDetail = {
      enabled: !!(menu.rowDetailEnabled && menu.detailKeyColumn),
      keyColumn: (menu.detailKeyColumn || '').trim(),
    };
    state.reportPage = 1;
    state.reportPageSize = 50;
    state.reportTotalRowCount = 0;
    state.reportTruncated = false;
    state.reportClientSidePaging = false;
    state.reportClientRowsBuffer = null;
    state.reportServerRows = null;
    state.reportLastColumns = [];
    el.dynamicReportErr.hidden = true;
    el.dynamicReportErr.textContent = '';
    el.dynamicReportTableWrap.innerHTML = '';
    applyUI();
    el.dynamicReportTitle.textContent = state.dynamicReportLabel;
    renderDynamicReportForm();
  }

  /**
   * 报表 / 生产报工筛选：摄像头扫码填入文本框（需 HTTPS 与浏览器支持 BarcodeDetector）。
   * 不支持时提示使用外接扫码枪（焦点在输入框即可录入）。
   */
  function openDynamicReportBarcodeScan(targetInput) {
    if (!targetInput || targetInput.tagName !== 'INPUT') return;
    if (!('BarcodeDetector' in window)) {
      showToast('当前环境不支持摄像头扫码，请将焦点放在输入框后用扫码枪或手动输入');
      try {
        targetInput.focus();
      } catch (e) {}
      return;
    }
    var detector;
    try {
      detector = new BarcodeDetector({
        formats: [
          'aztec',
          'code_128',
          'code_39',
          'code_93',
          'codabar',
          'data_matrix',
          'ean_13',
          'ean_8',
          'itf',
          'pdf417',
          'qr_code',
          'upc_a',
          'upc_e',
        ],
      });
    } catch (e0) {
      try {
        detector = new BarcodeDetector();
      } catch (e1) {
        showToast('无法启动扫码识别');
        return;
      }
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('无法打开摄像头，请使用扫码枪或手动输入');
      try {
        targetInput.focus();
      } catch (e2) {}
      return;
    }

    var overlay = document.createElement('div');
    overlay.className = 'scan-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    var panel = document.createElement('div');
    panel.className = 'scan-overlay-panel';
    var hint = document.createElement('p');
    hint.className = 'scan-overlay-hint';
    hint.textContent = '将条码 / 二维码对准取景框';
    var video = document.createElement('video');
    video.className = 'scan-overlay-video';
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
    video.muted = true;
    var actions = document.createElement('div');
    actions.className = 'scan-overlay-actions';
    var btnClose = document.createElement('button');
    btnClose.type = 'button';
    btnClose.className = 'btn-secondary scan-overlay-close';
    btnClose.textContent = '关闭';
    actions.appendChild(btnClose);
    panel.appendChild(hint);
    panel.appendChild(video);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    var stream = null;
    var rafId = 0;
    var closed = false;

    function cleanup() {
      if (closed) return;
      closed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      if (stream) {
        stream.getTracks().forEach(function (t) {
          try {
            t.stop();
          } catch (e3) {}
        });
        stream = null;
      }
      try {
        video.srcObject = null;
      } catch (e4) {}
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function applyCode(raw) {
      var s = raw != null ? String(raw).trim() : '';
      if (!s) return;
      targetInput.value = s;
      try {
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e5) {}
      showToast('已扫码');
      cleanup();
    }

    function tick() {
      if (closed) return;
      if (video.readyState >= 2) {
        detector
          .detect(video)
          .then(function (codes) {
            if (closed) return;
            if (codes && codes.length && codes[0].rawValue) {
              applyCode(codes[0].rawValue);
              return;
            }
            rafId = requestAnimationFrame(tick);
          })
          .catch(function () {
            if (!closed) rafId = requestAnimationFrame(tick);
          });
      } else {
        rafId = requestAnimationFrame(tick);
      }
    }

    bindTap(btnClose, cleanup);
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) cleanup();
    });

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(function (s) {
        if (closed) {
          s.getTracks().forEach(function (t) {
            try {
              t.stop();
            } catch (e6) {}
          });
          return;
        }
        stream = s;
        video.srcObject = stream;
        video.play().catch(function () {});
        rafId = requestAnimationFrame(tick);
      })
      .catch(function () {
        showToast('无法打开摄像头（请检查权限）');
        cleanup();
      });
  }

  /** 下拉是否显示「（全部）」：必选或无全部项 / noAllOption / 生产报工下「状态」筛选不显示全部 */
  function shouldShowFilterSelectAllOption(f) {
    if (f.required) return false;
    if (f.noAllOption === true) return false;
    if (state.proSignMode) {
      var nameLc = f.name ? String(f.name).toLowerCase() : '';
      var lab = f.label ? String(f.label).trim() : '';
      if (nameLc === 'status' || lab === '状态') return false;
    }
    return true;
  }

  function renderDynamicReportForm() {
    var wrap = el.dynamicReportFormWrap;
    wrap.innerHTML = '';
    var schema = state.dynamicReportFilterSchema || [];
    var form = document.createElement('div');
    form.className = 'dynamic-report-fields';

    function addField(f) {
      var lab = document.createElement('label');
      lab.className = 'field';
      var sp = document.createElement('span');
      sp.textContent = f.label || f.name;
      lab.appendChild(sp);
      var input;
      var t = (f.type || 'string').toLowerCase();
      if (f.optionsSql || f.optionsFromSql) {
        input = document.createElement('select');
        input.name = f.name;
        var ld0 = document.createElement('option');
        ld0.value = '';
        ld0.textContent = '加载中…';
        ld0.disabled = true;
        ld0.selected = true;
        input.appendChild(ld0);
      } else if (Array.isArray(f.options) && f.options.length > 0) {
        input = document.createElement('select');
        input.name = f.name;
        if (shouldShowFilterSelectAllOption(f)) {
          var optAll = document.createElement('option');
          optAll.value = '';
          optAll.textContent = '（全部）';
          input.appendChild(optAll);
        }
        for (var oi = 0; oi < f.options.length; oi++) {
          var op = f.options[oi];
          var opt = document.createElement('option');
          var cv = op != null && op.code != null && typeof op.code !== 'object' ? String(op.code) : '';
          opt.value = cv;
          opt.textContent = op != null && op.name != null ? String(op.name) : '';
          input.appendChild(opt);
        }
      } else if (t === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.name = f.name;
      } else if (t === 'date' || t === 'datetime') {
        input = document.createElement('input');
        input.type = t === 'date' ? 'date' : 'datetime-local';
        input.name = f.name;
      } else if (t === 'int' || t === 'decimal') {
        input = document.createElement('input');
        input.type = 'number';
        input.name = f.name;
        input.step = t === 'int' ? '1' : 'any';
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.name = f.name;
      }
      if (!f.required) {
        input.dataset.optional = '1';
      }
      var useScan =
        f.scan === true &&
        (t === 'string' || t === 'int' || t === 'decimal') &&
        input.tagName === 'INPUT' &&
        (input.type === 'text' || input.type === 'number');
      if (useScan) {
        var scanRow = document.createElement('div');
        scanRow.className = 'field-scan-row';
        var btnScan = document.createElement('button');
        btnScan.type = 'button';
        btnScan.className = 'btn-field-scan';
        btnScan.setAttribute('aria-label', '摄像头扫码');
        btnScan.title = '摄像头扫码';
        btnScan.textContent = '扫码';
        bindTap(btnScan, function (ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          openDynamicReportBarcodeScan(input);
        });
        scanRow.appendChild(input);
        scanRow.appendChild(btnScan);
        lab.appendChild(scanRow);
      } else {
        lab.appendChild(input);
      }
      form.appendChild(lab);
    }

    schema.forEach(addField);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-primary';
    btn.textContent = '查询';
    bindTap(btn, function () {
      runDynamicReportQuery(true);
    });
    form.appendChild(btn);
    wrap.appendChild(form);

    if (state.proSignMode && !wrap.dataset.proSignFilterListeners) {
      wrap.dataset.proSignFilterListeners = '1';
      wrap.addEventListener('change', onProSignFilterFormChange);
    }

    var needsOptionsSql = schema.some(function (f) {
      return !!(f.optionsSql || f.optionsFromSql);
    });
    if (schema.length === 0) {
      runDynamicReportQuery(true);
    } else if (needsOptionsSql) {
      btn.disabled = true;
      var rk = state.dynamicReportRouteKey;
      var loads = schema
        .filter(function (f) {
          return !!(f.optionsSql || f.optionsFromSql);
        })
        .map(function (f) {
          return apiFetch('/reports/filter-field-options', {
            method: 'POST',
            body: JSON.stringify({ routeKey: rk, fieldName: f.name }),
          })
            .then(function (data) {
              var sel = wrap.querySelector('select[name="' + f.name + '"]');
              if (!sel) return;
              sel.innerHTML = '';
              if (shouldShowFilterSelectAllOption(f)) {
                var oAll = document.createElement('option');
                oAll.value = '';
                oAll.textContent = '（全部）';
                sel.appendChild(oAll);
              }
              var items = (data && data.items) || [];
              for (var ii = 0; ii < items.length; ii++) {
                var it = items[ii];
                var opEl = document.createElement('option');
                var cvs =
                  it != null && it.code != null && typeof it.code !== 'object' ? String(it.code) : '';
                opEl.value = cvs;
                opEl.textContent = it != null && it.name != null ? String(it.name) : '';
                sel.appendChild(opEl);
              }
              sel.dataset.optionsLoaded = '1';
            })
            .catch(function (err) {
              showToast(err.message || '下拉选项加载失败');
              var sel2 = wrap.querySelector('select[name="' + f.name + '"]');
              if (sel2) {
                sel2.innerHTML = '';
                var bad = document.createElement('option');
                bad.value = '';
                bad.textContent = '（加载失败）';
                bad.disabled = true;
                sel2.appendChild(bad);
              }
            });
        });
      Promise.all(loads).finally(function () {
        btn.disabled = false;
      });
    }
  }

  function collectDynamicReportParams() {
    var schema = state.dynamicReportFilterSchema || [];
    var params = {};
    var wrap = el.dynamicReportFormWrap;
    schema.forEach(function (f) {
      var elInput = wrap.querySelector('[name="' + f.name + '"]');
      if (!elInput) return;
      if (elInput.tagName === 'SELECT') {
        var sv = elInput.value;
        if (sv === '' || sv == null) {
          if (!f.required) params[f.name] = null;
          return;
        }
        if ((f.type || '').toLowerCase() === 'int') {
          params[f.name] = parseInt(sv, 10);
        } else if ((f.type || '').toLowerCase() === 'decimal') {
          params[f.name] = Number(sv);
        } else if ((f.type || '').toLowerCase() === 'bool') {
          if (sv === 'true' || sv === '1' || sv === 'yes') params[f.name] = true;
          else if (sv === 'false' || sv === '0' || sv === 'no') params[f.name] = false;
          else params[f.name] = sv;
        } else {
          params[f.name] = sv;
        }
        return;
      }
      if (elInput.type === 'checkbox') {
        params[f.name] = elInput.checked;
        return;
      }
      var v = elInput.value;
      if (v === '' || v == null) {
        if (!f.required) params[f.name] = null;
        return;
      }
      if ((f.type || '').toLowerCase() === 'int') {
        params[f.name] = parseInt(v, 10);
      } else if ((f.type || '').toLowerCase() === 'decimal') {
        params[f.name] = Number(v);
      } else {
        params[f.name] = v;
      }
    });
    return params;
  }

  /** pro-sign：筛选里「Status」为 0 时主按钮显示「接单」，为 1 时显示「完工」，否则「合并报工」。 */
  function proSignStatusFilterField() {
    var schema = state.dynamicReportFilterSchema || [];
    var i;
    for (i = 0; i < schema.length; i++) {
      var f = schema[i];
      if (f && f.name && String(f.name).toLowerCase() === 'status') return f;
    }
    for (i = 0; i < schema.length; i++) {
      var g = schema[i];
      if (g && g.name && String(g.label || '').trim() === 'Status') return g;
    }
    return null;
  }

  function proSignMergeButtonLabel() {
    var sf = proSignStatusFilterField();
    if (!sf) return '合并报工';
    var params = collectDynamicReportParams();
    var v = params[sf.name];
    if (v === 0 || v === '0') return '接单';
    if (v === 1 || v === '1') return '完工';
    return '合并报工';
  }

  function syncProSignMergeButtonLabel() {
    if (!state.proSignMode) return;
    var btn = el.proSignListMergeBtn;
    if (!btn) return;
    btn.textContent = proSignMergeButtonLabel();
  }

  /** 生产报工列表：说明文案置于表格/分页下方（吸底按钮单独在 #pro-sign-list-sticky） */
  function appendProSignMergeListHint(container) {
    if (!state.proSignMode || !container) return;
    var hint = document.createElement('p');
    hint.className = 'hint pro-sign-merge-hint-bottom';
    hint.textContent =
      '勾选后点「合并报工」：预检（Z_ONLINE_TOOWORSIGN_DETAIL）通过后进入全屏「接单」页；抬头为首行工序 StepCode/StepName、当前时间与多选操作员；子表为 BaseEntry、LastStep*、数量。列表须含逻辑列 DocEntry、StepCode。';
    container.appendChild(hint);
    syncProSignMergeButtonLabel();
  }

  function triggerProSignMergeFromList() {
    var wrap = el.dynamicReportTableWrap;
    if (!wrap || !state.proSignMode) return;
    var selected = [];
    wrap.querySelectorAll('tbody input.pro-sign-row-cb:checked').forEach(function (cb) {
      var tr = cb.closest && cb.closest('tr');
      if (!tr || tr.dataset.proSignRowIndex == null || tr.dataset.proSignRowIndex === '') return;
      var rIdx = parseInt(tr.dataset.proSignRowIndex, 10);
      if (!Number.isFinite(rIdx)) return;
      var row = (state.proSignTableRows && state.proSignTableRows[rIdx]) || null;
      if (!row) return;
      var orderId = getRowValueForColumn(row, 'DocEntry');
      var opRaw = getRowValueForColumn(row, 'StepCode');
      if (orderId == null || opRaw == null || orderId === '' || opRaw === '') {
        return;
      }
      var stepStr =
        typeof opRaw === 'bigint' ? String(opRaw).trim() : String(opRaw).trim();
      if (!stepStr) return;
      if (stepStr.length > 50) stepStr = stepStr.slice(0, 50);
      var oN = Number(typeof orderId === 'bigint' ? orderId.toString() : orderId);
      if (!Number.isFinite(oN)) {
        return;
      }
      selected.push({ orderId: oN, operationId: stepStr, row: row });
    });
    if (selected.length === 0) {
      showToast(
        '请先勾选至少一行（或 DocEntry 不是有效数字、StepCode 为空；StepCode 为文本，与工序编码一致即可）'
      );
      return;
    }
    var lines = selected.map(function (s) {
      return { docEntry: String(s.orderId), stepCode: String(s.operationId) };
    });
    apiFetch('/pro-sign/toowor-sign-detail', {
      method: 'POST',
      body: JSON.stringify({ lines: lines }),
    })
      .then(function (data) {
        goProSignReceive(selected, data && data.lineResults);
      })
      .catch(function (e) {
        showToast(e.message || '预检失败');
      });
  }

  function onProSignFilterFormChange() {
    if (state.proSignMode) syncProSignMergeButtonLabel();
  }

  function runDynamicReportQuery(resetPage) {
    if (resetPage) {
      state.reportPage = 1;
    }
    el.dynamicReportErr.hidden = true;
    el.dynamicReportTableWrap.innerHTML = '<p class="muted" style="text-align:center;padding:12px">加载中…</p>';
    var body = {
      routeKey: state.dynamicReportRouteKey,
      params: collectDynamicReportParams(),
      page: state.reportPage,
      pageSize: state.reportPageSize,
    };
    var reportPath = state.proSignMode ? '/pro-sign/run-list' : '/reports/run';
    apiFetchReport(reportPath, {
      method: 'POST',
      body: JSON.stringify(body),
    })
      .then(function (data) {
        state.reportLastColumns = data.columns || [];
        state.reportTruncated = !!data.truncated;
        state.reportClientSidePaging = !!data.clientSidePaging;
        state.reportTotalRowCount =
          data.totalRowCount != null && data.totalRowCount !== ''
            ? Number(data.totalRowCount)
            : (data.rows || []).length;
        if (!Number.isFinite(state.reportTotalRowCount) || state.reportTotalRowCount < 0) {
          state.reportTotalRowCount = 0;
        }
        state.reportPage = data.page != null ? Number(data.page) || 1 : state.reportPage;
        if (data.pageSize != null) {
          state.reportPageSize = normalizeReportPageSize(data.pageSize);
        }
        if (state.reportClientSidePaging) {
          state.reportClientRowsBuffer = data.rows || [];
          state.reportServerRows = null;
        } else {
          state.reportClientRowsBuffer = null;
          state.reportServerRows = data.rows || [];
        }
        renderDynamicReportResult();
      })
      .catch(function (err) {
        el.dynamicReportTableWrap.innerHTML = '';
        var msg = err.message || '查询失败';
        if (err.name === 'AbortError') {
          msg = '请求超时，请缩小条件或稍后重试';
        }
        // 显示详细错误信息（包括 SQL 错误）
        if (err.data && err.data.detail) {
          msg += '\n\n详细错误：\n' + err.data.detail;
        }
        el.dynamicReportErr.textContent = msg;
        el.dynamicReportErr.hidden = false;
        if (err.status === 401) goLogin();
      });
  }

  function reportMaxPage() {
    var ps = state.reportPageSize || 50;
    if (ps < 1) ps = 1;
    return Math.max(1, Math.ceil(state.reportTotalRowCount / ps));
  }

  var REPORT_PAGE_SIZE_OPTIONS = [50, 100, 200];

  function normalizeReportPageSize(size) {
    var n = Math.trunc(Number(size));
    if (!Number.isFinite(n) || n < 1) return 50;
    if (REPORT_PAGE_SIZE_OPTIONS.indexOf(n) !== -1) return n;
    return 50;
  }

  function changeReportPage(delta) {
    var maxP = reportMaxPage();
    var next = state.reportPage + delta;
    if (next < 1 || next > maxP) return;
    state.reportPage = next;
    if (state.reportClientSidePaging) {
      renderDynamicReportResult();
    } else {
      runDynamicReportQuery(false);
    }
  }

  function goReportPage(targetPage) {
    var maxP = reportMaxPage();
    var p = Math.trunc(Number(targetPage));
    if (!Number.isFinite(p)) return;
    if (p < 1) p = 1;
    if (p > maxP) p = maxP;
    if (p === state.reportPage) return;
    state.reportPage = p;
    if (state.reportClientSidePaging) {
      renderDynamicReportResult();
    } else {
      runDynamicReportQuery(false);
    }
  }

  function setReportPageSize(newSize) {
    var ps = normalizeReportPageSize(newSize);
    if (ps === state.reportPageSize) return;
    state.reportPageSize = ps;
    state.reportPage = 1;
    if (state.reportClientSidePaging) {
      renderDynamicReportResult();
    } else {
      runDynamicReportQuery(false);
    }
  }

  function getRowValueForColumn(row, colName) {
    if (!row || !colName) return undefined;
    if (Object.prototype.hasOwnProperty.call(row, colName)) return row[colName];
    var lower = colName.toLowerCase();
    var keys = Object.keys(row);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === lower) return row[keys[i]];
    }
    return undefined;
  }

  /** 列表列名（英文）-> 表头中文；无映射则显示原列名 */
  function reportColumnHeaderText(colName, labelMap) {
    var map = labelMap || {};
    if (colName == null || String(colName).trim() === '') return '—';
    var s = String(colName);
    if (Object.prototype.hasOwnProperty.call(map, s) && map[s]) return map[s];
    var lower = s.toLowerCase();
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k) && k.toLowerCase() === lower) {
        return map[k];
      }
    }
    return s;
  }

  function armReportOverlayOpenGuard() {
    state.reportOverlayBackdropGuardUntil = Date.now() + 450;
  }

  function closeReportOverlay() {
    if (state.proSignSavePosting) return;
    if (state.proSignSavePreviewOpen) {
      state.proSignSavePreviewOpen = false;
      if (el.proSignReceiveBtnSave && state.viewName === 'pro-sign-receive') {
        el.proSignReceiveBtnSave.disabled = false;
      }
    }
    if (el.reportOverlay) el.reportOverlay.hidden = true;
    if (el.reportOverlayBody) el.reportOverlayBody.innerHTML = '';
  }

  function clearProSignReceiveClock() {
    if (state.proSignReceiveClockTimer != null) {
      clearInterval(state.proSignReceiveClockTimer);
      state.proSignReceiveClockTimer = null;
    }
  }

  function proSignAfterSaveAndReturn() {
    clearProSignReceiveClock();
    state.proSignReceiveMerge = null;
    state.proSignReceiveLineResults = null;
    state.proSignReceiveMergeButtonLabel = null;
    if (el.proSignReceiveBtnSave) el.proSignReceiveBtnSave.textContent = '保存';
    state.viewName = 'dynamic-report';
    state.proSignMode = true;
    applyUI();
    window.scrollTo(0, 0);
    runDynamicReportQuery(false);
  }

  /**
   * 首行/预检 display 与列表行回退。工单用 BaseEntry（与 X_ONLINE_SIGN 自增 DocEntry 区分）；
   * 数量优先预检 display，再从列表行常见数量列解析（与后端 TOOWOR_QUANTITY_NAMES 对齐）。
   */
  var PRO_SIGN_ROW_QTY_COLS = [
    'Quantity',
    'Qty',
    '数量',
    'PlannedQty',
    'PlanQty',
    'GoodQty',
    'ReportQty',
    'ReportedQty',
  ];

  function proSignQuantityFromRow(row) {
    if (!row) return null;
    for (var qi = 0; qi < PRO_SIGN_ROW_QTY_COLS.length; qi += 1) {
      var raw = getRowValueForColumn(row, PRO_SIGN_ROW_QTY_COLS[qi]);
      if (raw == null || raw === '') continue;
      var p =
        typeof raw === 'number'
          ? raw
          : parseFloat(String(raw).replace(/,/g, ''));
      if (Number.isFinite(p)) return p;
    }
    return null;
  }

  function pad2ProSign(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** 本地日期 + 时分（合并报工抬头「当前时间」展示） */
  function formatProSignZhDateMinute(d) {
    if (!d || Number.isNaN(d.getTime())) return '—';
    return (
      d.getFullYear() +
      '-' +
      pad2ProSign(d.getMonth() + 1) +
      '-' +
      pad2ProSign(d.getDate()) +
      ' ' +
      pad2ProSign(d.getHours()) +
      ':' +
      pad2ProSign(d.getMinutes())
    );
  }

  function proSignLineDisplay(mergeItem, lineResult) {
    var d = (lineResult && lineResult.display) || {};
    var row = (mergeItem && mergeItem.row) || {};
    var oi = mergeItem && mergeItem.orderId;
    var oop = mergeItem && mergeItem.operationId;
    var stv = getRowValueForColumn(row, 'StepCode');
    if (stv == null || stv === '') stv = oop;
    var qNum = null;
    if (d.quantity != null) {
      var pq =
        typeof d.quantity === 'number'
          ? d.quantity
          : parseFloat(String(d.quantity).replace(/,/g, ''));
      if (Number.isFinite(pq)) qNum = pq;
    }
    if (qNum == null) qNum = proSignQuantityFromRow(row);
    if (qNum == null) qNum = 0;
    var stepCodeDisp =
      d.setupCode != null && String(d.setupCode).trim() !== ''
        ? String(d.setupCode)
        : stv != null && stv !== ''
          ? String(stv)
          : '—';
    var stepNameDisp =
      d.setupName != null && String(d.setupName).trim() !== ''
        ? String(d.setupName)
        : (function () {
            var a = getRowValueForColumn(row, 'StepName');
            if (a != null && a !== '') return String(a);
            a = getRowValueForColumn(row, 'SetupName');
            if (a != null && a !== '') return String(a);
            a = getRowValueForColumn(row, 'operationName');
            if (a != null && a !== '') return String(a);
            return '—';
          })();
    var rawLastCode =
      d.lastStepCode != null && String(d.lastStepCode).trim() !== ''
        ? String(d.lastStepCode).trim()
        : '';
    if (!rawLastCode) {
      var lc = getRowValueForColumn(row, 'LastStepCode');
      if (lc != null && lc !== '') rawLastCode = String(lc).trim();
    }
    var rawLastName =
      d.lastStepName != null && String(d.lastStepName).trim() !== ''
        ? String(d.lastStepName).trim()
        : '';
    if (!rawLastName) {
      var ln = getRowValueForColumn(row, 'LastStepName');
      if (ln != null && ln !== '') rawLastName = String(ln).trim();
    }
    var rawLastTime =
      d.lastStepTime != null && String(d.lastStepTime).trim() !== ''
        ? String(d.lastStepTime).trim()
        : '';
    if (!rawLastTime) {
      var lt = getRowValueForColumn(row, 'LastStepTime');
      if (lt != null && lt !== '') rawLastTime = String(lt).trim();
    }
    var lastIso = null;
    if (rawLastTime) {
      var dt = new Date(rawLastTime);
      if (!Number.isNaN(dt.getTime())) lastIso = dt.toISOString();
    }
    var lastTimeLabel = '—';
    if (lastIso) lastTimeLabel = formatProSignZhDateMinute(new Date(lastIso));
    else if (rawLastTime) lastTimeLabel = rawLastTime;
    var rawPc = '';
    if (d.pc != null && String(d.pc).trim() !== '') {
      rawPc = String(d.pc).trim();
    } else {
      var PC_COLS = ['PC', 'Pc', '批次', 'BatchNo', 'batchNo', 'Batch', 'Lot', 'LotNo'];
      for (var pci = 0; pci < PC_COLS.length; pci += 1) {
        var pcv = getRowValueForColumn(row, PC_COLS[pci]);
        if (pcv != null && String(pcv).trim() !== '') {
          rawPc = String(pcv).trim();
          break;
        }
      }
    }
    var itemNameDisp = '—';
    if (d.itemName != null && String(d.itemName).trim() !== '') {
      itemNameDisp = String(d.itemName).trim();
    } else {
      var INM_COLS = [
        'ItemName',
        '物料名称',
        '产品名称',
        'MaterialName',
        'materialName',
        'ProductName',
        'ItemDesc',
      ];
      for (var ini = 0; ini < INM_COLS.length; ini += 1) {
        var inv = getRowValueForColumn(row, INM_COLS[ini]);
        if (inv != null && String(inv).trim() !== '') {
          itemNameDisp = String(inv).trim();
          break;
        }
      }
    }
    return {
      baseEntry:
        d.baseEntry != null && String(d.baseEntry).trim() !== ''
          ? String(d.baseEntry)
          : (function () {
              var b = getRowValueForColumn(row, 'BaseEntry');
              if (b != null && b !== '') return String(b);
              if (oi != null && oi !== '') return String(oi);
              return '—';
            })(),
      stepCode: stepCodeDisp,
      stepName: stepNameDisp,
      quantity: qNum,
      lastStepCode: rawLastCode || '—',
      lastStepName: rawLastName || '—',
      lastStepTimeLabel: lastTimeLabel,
      lastStepTimeIso: lastIso,
      pc: rawPc,
      itemName: itemNameDisp,
    };
  }

  function goProSignReceive(mergeItems, lineResults) {
    if (!mergeItems || !mergeItems.length) return;
    if (!el.proSignReceive || !el.proSignReceiveScroll) return;
    state.proSignReceiveMerge = mergeItems;
    state.proSignReceiveLineResults = lineResults && lineResults.length ? lineResults : null;
    state.proSignReceiveMergeButtonLabel = proSignMergeButtonLabel();
    state.viewName = 'pro-sign-receive';
    applyUI();
    window.scrollTo(0, 0);
    renderProSignReceive();
  }

  /**
   * 接单页操作员：原生多选列表 +「仅本人」快捷；列表内直接点选多行。
   */
  function initProSignReceiveOperatorsPicker(picker) {
    if (!picker) return;
    var listEl = picker.querySelector('[data-pro-op-list]');
    var search = picker.querySelector('[data-pro-op-search]');
    var summary = picker.querySelector('[data-pro-op-summary]');
    if (!listEl || listEl.tagName !== 'SELECT' || !summary) return;
    var uc = (state.username || '').trim();
    var ucLower = uc.toLowerCase();

    function selectedCount() {
      var n = 0;
      var opts = listEl.options;
      for (var i = 0; i < opts.length; i += 1) {
        if (opts[i].selected && !opts[i].disabled && String(opts[i].value).trim()) n += 1;
      }
      return n;
    }

    function updateSummary() {
      var parts = [];
      var maxShow = 5;
      var opts = listEl.options;
      for (var i = 0; i < opts.length && parts.length < maxShow; i += 1) {
        var o = opts[i];
        if (!o.selected || o.disabled || !String(o.value).trim()) continue;
        parts.push(o.value);
      }
      var c = selectedCount();
      if (!c) {
        summary.textContent = '未勾选人员；保存时将默认使用当前登录账号';
        return;
      }
      var extra = c > maxShow ? '…' : '';
      summary.textContent =
        '已选 ' + c + ' 人：' + parts.join('、') + extra + (c > maxShow ? '（共 ' + c + ' 人）' : '');
    }

    function ensureLoginSelectedIfNone() {
      if (!uc) return;
      if (selectedCount() > 0) return;
      var opts = listEl.options;
      for (var j = 0; j < opts.length; j += 1) {
        if (opts[j].disabled) continue;
        if (String(opts[j].value).toLowerCase() === ucLower) {
          opts[j].selected = true;
          return;
        }
      }
    }

    function showAllOptions() {
      var opts = listEl.options;
      for (var i = 0; i < opts.length; i += 1) {
        opts[i].hidden = false;
      }
    }

    function applyFilter() {
      if (!search) {
        showAllOptions();
        return;
      }
      var q = (search.value ? String(search.value) : '').trim().toLowerCase();
      var opts = listEl.options;
      for (var i = 0; i < opts.length; i += 1) {
        var o = opts[i];
        if (o.disabled || !String(o.value).trim()) {
          o.hidden = false;
          continue;
        }
        var code = String(o.value).toLowerCase();
        var t = (o.getAttribute('data-op-search-text') || '').toLowerCase();
        var match = !q || code.indexOf(q) >= 0 || t.indexOf(q) >= 0;
        o.hidden = !match;
      }
    }

    function selectLoginOnly() {
      var opts = listEl.options;
      for (var j = 0; j < opts.length; j += 1) {
        var o = opts[j];
        if (o.disabled || !String(o.value).trim()) {
          o.selected = false;
          continue;
        }
        o.selected = String(o.value).toLowerCase() === ucLower;
      }
      if (uc) ensureLoginSelectedIfNone();
      updateSummary();
    }

    function syncListSize() {
      var n = 0;
      var opts = listEl.options;
      for (var i = 0; i < opts.length; i += 1) {
        if (!opts[i].disabled && String(opts[i].value).trim()) n += 1;
      }
      listEl.size = Math.min(Math.max(n, 3), 7);
    }

    function buildRows(ops) {
      listEl.innerHTML = '';
      var seen = {};
      var list = [];
      for (var a = 0; a < (ops || []).length; a += 1) {
        list.push(ops[a]);
      }
      if (uc) {
        var hasUc = false;
        for (var b = 0; b < list.length; b += 1) {
          var oc = list[b] && list[b].code != null ? String(list[b].code).trim() : '';
          if (oc.toLowerCase() === ucLower) hasUc = true;
        }
        if (!hasUc) {
          list.unshift({ code: uc, name: '', unlisted: true });
        }
      }
      var added = 0;
      for (var j = 0; j < list.length; j += 1) {
        var op = list[j];
        if (!op || op.code == null) continue;
        var c = String(op.code).trim();
        if (!c || seen[c]) continue;
        seen[c] = true;
        var nm = op.name != null && String(op.name).trim() !== '' ? String(op.name).trim() : '';
        var opt = document.createElement('option');
        opt.value = c;
        opt.setAttribute('data-op-search-text', (nm ? c + ' ' + nm : c).toLowerCase());
        if (op.unlisted) opt.textContent = c + '（未在目录）';
        else opt.textContent = nm ? c + ' — ' + nm : c;
        listEl.appendChild(opt);
        added += 1;
      }
      if (!added) {
        var ph = document.createElement('option');
        ph.value = '';
        ph.disabled = true;
        ph.textContent = '暂无人员数据（保存时将使用当前登录账号）';
        listEl.appendChild(ph);
        listEl.size = 4;
      } else {
        syncListSize();
        var opts2 = listEl.options;
        for (var k = 0; k < opts2.length; k += 1) {
          if (opts2[k].disabled) continue;
          if (String(opts2[k].value).toLowerCase() === ucLower) opts2[k].selected = true;
        }
        ensureLoginSelectedIfNone();
        showAllOptions();
      }
      updateSummary();
    }

    var btnSelf = picker.querySelector('[data-pro-op-only-self]');
    if (btnSelf) btnSelf.addEventListener('click', selectLoginOnly);
    if (search) {
      search.addEventListener('input', applyFilter);
      search.addEventListener('search', applyFilter);
    }
    listEl.addEventListener('change', updateSummary);

    summary.textContent = '正在加载人员列表…';
    apiFetch('/pro-sign/online-sign-operators')
      .then(function (data) {
        var ops = (data && data.operators) || [];
        buildRows(ops);
      })
      .catch(function () {
        buildRows([]);
      });
  }

  function getProSignReceiveOperatorCodesFromPicker() {
    var root = el.proSignReceiveScroll && el.proSignReceiveScroll.querySelector('[data-pro-operators-root]');
    if (!root) return [];
    var sel = root.querySelector('[data-pro-op-list]');
    if (!sel || sel.tagName !== 'SELECT') return [];
    var out = [];
    var opts = sel.options;
    for (var i = 0; i < opts.length; i += 1) {
      var o = opts[i];
      if (!o.selected || o.disabled) continue;
      var v = String(o.value).trim();
      if (v) out.push(v);
    }
    return out;
  }

  function renderProSignReceive() {
    var cont = el.proSignReceiveScroll;
    if (!cont) return;
    clearProSignReceiveClock();
    cont.innerHTML = '';
    var mergeItems = state.proSignReceiveMerge || [];
    if (!mergeItems.length) return;
    var lineRes = state.proSignReceiveLineResults || [];
    var first0 = proSignLineDisplay(mergeItems[0], lineRes[0] || null);

    var cardH = document.createElement('div');
    cardH.className = 'card pro-sign-receive-block';
    var meta = document.createElement('div');
    meta.className = 'pro-sign-receive-header-meta';
    function addReadonlyRow(lbl, val) {
      var w = document.createElement('div');
      w.className = 'pro-sign-receive-meta-row';
      var sl = document.createElement('span');
      sl.className = 'pro-sign-receive-meta-label';
      sl.textContent = lbl;
      var sv = document.createElement('span');
      sv.className = 'pro-sign-receive-meta-value';
      sv.textContent = val == null || val === '' ? '—' : String(val);
      w.appendChild(sl);
      w.appendChild(sv);
      meta.appendChild(w);
    }
    addReadonlyRow('工序编码', first0.stepCode);
    addReadonlyRow('工序名称', first0.stepName);
    (function () {
      var w = document.createElement('div');
      w.className = 'pro-sign-receive-meta-row';
      var sl = document.createElement('span');
      sl.className = 'pro-sign-receive-meta-label';
      sl.textContent = '当前时间';
      var sv = document.createElement('span');
      sv.className = 'pro-sign-receive-meta-value';
      sv.setAttribute('data-pro-clock', '1');
      sv.textContent = formatProSignZhDateMinute(new Date());
      w.appendChild(sl);
      w.appendChild(sv);
      meta.appendChild(w);
    })();
    cardH.appendChild(meta);

    var opField = document.createElement('div');
    opField.className = 'field pro-sign-receive-operators-field';
    var opLabSpan = document.createElement('span');
    opLabSpan.textContent = '当前操作员';
    opField.appendChild(opLabSpan);
    var picker = document.createElement('div');
    picker.className = 'pro-sign-receive-operators-picker';
    picker.setAttribute('data-pro-operators-root', '1');
    var opHead = document.createElement('div');
    opHead.className = 'pro-sign-receive-operators-head';
    var opSummary = document.createElement('div');
    opSummary.className = 'pro-sign-receive-operators-summary';
    opSummary.setAttribute('data-pro-op-summary', '1');
    opSummary.textContent = '正在加载人员列表…';
    var btnSelfOnly = document.createElement('button');
    btnSelfOnly.type = 'button';
    btnSelfOnly.className = 'pro-sign-receive-operators-action pro-sign-receive-operators-action--compact';
    btnSelfOnly.textContent = '仅本人';
    btnSelfOnly.setAttribute('data-pro-op-only-self', '1');
    btnSelfOnly.setAttribute('aria-label', '仅选中当前登录账号');
    opHead.appendChild(opSummary);
    opHead.appendChild(btnSelfOnly);
    var opListWrap = document.createElement('div');
    opListWrap.className = 'pro-sign-receive-operators-list-wrap';
    var opSelect = document.createElement('select');
    opSelect.className = 'pro-sign-receive-operators-select';
    opSelect.multiple = true;
    opSelect.size = 5;
    opSelect.setAttribute('data-pro-op-list', '1');
    opSelect.setAttribute('aria-label', '操作员列表，可多选');
    opSelect.title = '点击选项切换选中；电脑端可按住 Ctrl 再点多选。';
    opListWrap.appendChild(opSelect);
    picker.appendChild(opHead);
    picker.appendChild(opListWrap);
    opField.appendChild(picker);
    cardH.appendChild(opField);
    initProSignReceiveOperatorsPicker(picker);

    cont.appendChild(cardH);

    var cardChild = document.createElement('div');
    cardChild.className = 'card pro-sign-receive-block pro-sign-receive-block--sub';
    var scroll = document.createElement('div');
    scroll.className = 'pro-sign-receive-child-scroll pro-sign-receive-child-scroll--cards';
    var cardsWrap = document.createElement('div');
    cardsWrap.className = 'pro-sign-receive-line-cards';
    function appendCardRow(card, labelText, valueNode) {
      var rowEl = document.createElement('div');
      rowEl.className = 'pro-sign-receive-line-card__row';
      var labEl = document.createElement('span');
      labEl.className = 'pro-sign-receive-line-card__label';
      labEl.textContent = labelText;
      var valEl = document.createElement('div');
      valEl.className = 'pro-sign-receive-line-card__value';
      if (typeof valueNode === 'string') {
        valEl.textContent = valueNode;
      } else {
        valEl.appendChild(valueNode);
      }
      rowEl.appendChild(labEl);
      rowEl.appendChild(valEl);
      card.appendChild(rowEl);
    }
    mergeItems.forEach(function (item, idx) {
      var lr = (lineRes[idx] != null ? lineRes[idx] : null) || null;
      var dline = proSignLineDisplay(item, lr);
      var card = document.createElement('article');
      card.className = 'pro-sign-receive-line-card';
      card.setAttribute('data-pro-line-card-idx', String(idx));
      var title = document.createElement('div');
      title.className = 'pro-sign-receive-line-card__title';
      title.textContent = '第 ' + (idx + 1) + ' 条 · 工单 ' + dline.baseEntry;
      card.appendChild(title);
      var batchDisp =
        dline.pc != null && String(dline.pc).trim() !== '' ? String(dline.pc).trim() : '—';
      appendCardRow(card, '批次', batchDisp);
      appendCardRow(card, '物料名称', dline.itemName);
      appendCardRow(card, '上道工序编码', dline.lastStepCode);
      appendCardRow(card, '上道工序名称', dline.lastStepName);
      appendCardRow(card, '上道工序时间', dline.lastStepTimeLabel);
      var inQty = document.createElement('input');
      inQty.type = 'number';
      inQty.step = 'any';
      inQty.className = 'pro-sign-line-qty pro-sign-receive-line-qty';
      inQty.setAttribute('data-pro-line-idx', String(idx));
      inQty.setAttribute('aria-label', '数量');
      inQty.value = String(
        dline.quantity != null && Number.isFinite(dline.quantity) ? dline.quantity : 0
      );
      inQty.min = '0';
      appendCardRow(card, '数量', inQty);
      cardsWrap.appendChild(card);
    });
    scroll.appendChild(cardsWrap);
    cardChild.appendChild(scroll);
    cont.appendChild(cardChild);

    if (el.proSignReceiveBtnSave) {
      el.proSignReceiveBtnSave.disabled = false;
      el.proSignReceiveBtnSave.textContent =
        state.proSignReceiveMergeButtonLabel || '保存';
    }

    function tickClock() {
      if (state.viewName !== 'pro-sign-receive' || !cont) return;
      var sp = cont.querySelector('[data-pro-clock]');
      if (sp) sp.textContent = formatProSignZhDateMinute(new Date());
    }
    state.proSignReceiveClockTimer = setInterval(tickClock, 1000);
  }

  /**
   * 合并接单保存：收集请求体（不含 signAt，确认保存时再写入当前时刻）。
   */
  function collectProSignOnlineSaveRequest() {
    if (state.viewName !== 'pro-sign-receive') {
      return { ok: false };
    }
    var mergeItems = state.proSignReceiveMerge;
    if (!mergeItems || !mergeItems.length) {
      return { ok: false };
    }
    var remarks = '';
    var operatorCodes = getProSignReceiveOperatorCodesFromPicker();
    var lrHead = (state.proSignReceiveLineResults && state.proSignReceiveLineResults[0]) || null;
    var headDisp = proSignLineDisplay(mergeItems[0], lrHead);
    var stepCode = headDisp.stepCode === '—' ? null : String(headDisp.stepCode);
    var stepName = headDisp.stepName === '—' ? null : String(headDisp.stepName);
    var lineRes = state.proSignReceiveLineResults || [];
    var lines = [];
    for (var i = 0; i < mergeItems.length; i += 1) {
      var it = mergeItems[i];
      var row = it.row || {};
      var be = Math.trunc(Number(it.orderId));
      if (!Number.isFinite(be)) {
        return {
          ok: false,
          errorMessage: '第' + (i + 1) + ' 行 BaseEntry 无效，请检查列表中 DocEntry 列',
        };
      }
      var lr = (lineRes[i] != null ? lineRes[i] : null) || null;
      var dline = proSignLineDisplay(it, lr);
      var inp = el.proSignReceiveScroll
        ? el.proSignReceiveScroll.querySelector('[data-pro-line-idx="' + i + '"]')
        : null;
      var qv = inp && 'value' in inp ? parseFloat(String(inp.value).replace(/,/g, '')) : 0;
      if (!Number.isFinite(qv)) qv = 0;
      var pcVal =
        dline.pc != null && String(dline.pc).trim() !== '' ? String(dline.pc).trim() : '';
      var lsc = dline.lastStepCode === '—' ? null : String(dline.lastStepCode).trim();
      var lsn = dline.lastStepName === '—' ? null : String(dline.lastStepName).trim();
      var isn = dline.itemName === '—' ? null : String(dline.itemName).trim();
      lines.push({
        baseEntry: be,
        quantity: qv,
        lastStepCode: lsc || null,
        lastStepName: lsn || null,
        lastStepTime: dline.lastStepTimeIso,
        pc: pcVal || null,
        itemName: isn || null,
      });
    }
    return {
      ok: true,
      body: {
        remarks: remarks,
        stepCode: stepCode,
        stepName: stepName,
        operatorCodes: operatorCodes,
        lines: lines,
      },
    };
  }

  function onProSignReceiveSaveClick() {
    var collected = collectProSignOnlineSaveRequest();
    if (!collected.ok) {
      if (collected.errorMessage) showToast(collected.errorMessage);
      return;
    }
    openProSignOnlineSavePreview(collected.body);
  }

  function proSignPreviewLastStepTimeLabel(iso) {
    if (!iso) return '—';
    var dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '—';
    return formatProSignZhDateMinute(dt);
  }

  function openProSignOnlineSavePreview(body) {
    if (!el.reportOverlay || !el.reportOverlayBody) return;
    state.proSignSavePreviewOpen = true;
    if (el.proSignReceiveBtnSave) el.proSignReceiveBtnSave.disabled = true;
    el.reportOverlayTitle.textContent = '保存前确认';
    el.reportOverlayBody.innerHTML = '';

    var root = document.createElement('div');
    root.className = 'pro-sign-save-preview';

    var secHead = document.createElement('div');
    secHead.className = 'pro-sign-save-preview-section';
    var hHead = document.createElement('h3');
    hHead.className = 'pro-sign-save-preview-title';
    hHead.textContent = 'X_ONLINE_SIGN';
    secHead.appendChild(hHead);

    var tblH = document.createElement('table');
    tblH.className = 'report-detail-transpose';
    var tbH = document.createElement('tbody');
    function addPreviewRow(label, val) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.scope = 'row';
      th.textContent = label;
      var td = document.createElement('td');
      td.textContent = val == null || val === '' ? '—' : String(val);
      tr.appendChild(th);
      tr.appendChild(td);
      tbH.appendChild(tr);
    }
    addPreviewRow('工序编码', body.stepCode != null ? body.stepCode : '—');
    addPreviewRow('工序名称', body.stepName != null ? body.stepName : '—');
    addPreviewRow('当前时间 SignAt', '保存时自动记录为提交时刻');
    var opDisp =
      body.operatorCodes && body.operatorCodes.length
        ? body.operatorCodes.join('、')
        : '未勾选（将默认当前登录账号）';
    addPreviewRow('操作员 OperatorCodes', opDisp);
    tblH.appendChild(tbH);
    secHead.appendChild(tblH);
    root.appendChild(secHead);

    var secLines = document.createElement('div');
    secLines.className = 'pro-sign-save-preview-section';

    var scrollWrap = document.createElement('div');
    scrollWrap.className = 'pro-sign-save-preview-lines-scroll pro-sign-save-preview-lines-scroll--cards';
    var prevCards = document.createElement('div');
    prevCards.className = 'pro-sign-save-preview-line-cards';
    function previewCardRow(card, lbl, txt) {
      var rowEl = document.createElement('div');
      rowEl.className = 'pro-sign-save-preview-line-card__row';
      var l = document.createElement('span');
      l.className = 'pro-sign-save-preview-line-card__label';
      l.textContent = lbl;
      var v = document.createElement('span');
      v.className = 'pro-sign-save-preview-line-card__value';
      v.textContent = txt == null || txt === '' ? '—' : String(txt);
      rowEl.appendChild(l);
      rowEl.appendChild(v);
      card.appendChild(rowEl);
    }
    body.lines.forEach(function (ln, idx) {
      var card = document.createElement('article');
      card.className = 'pro-sign-save-preview-line-card';
      var tit = document.createElement('div');
      tit.className = 'pro-sign-save-preview-line-card__title';
      tit.textContent = '第 ' + (idx + 1) + ' 条 · 工单 ' + String(ln.baseEntry);
      card.appendChild(tit);
      previewCardRow(
        card,
        '批次',
        ln.pc != null && String(ln.pc).trim() !== '' ? String(ln.pc).trim() : '—'
      );
      previewCardRow(
        card,
        '物料名称',
        ln.itemName != null && String(ln.itemName).trim() !== '' ? String(ln.itemName).trim() : '—'
      );
      previewCardRow(card, '上道工序编码', ln.lastStepCode != null ? String(ln.lastStepCode) : '—');
      previewCardRow(card, '上道工序名称', ln.lastStepName != null ? String(ln.lastStepName) : '—');
      previewCardRow(card, '上道工序时间', proSignPreviewLastStepTimeLabel(ln.lastStepTime));
      previewCardRow(
        card,
        '数量',
        ln.quantity != null && Number.isFinite(Number(ln.quantity)) ? String(ln.quantity) : '0'
      );
      prevCards.appendChild(card);
    });
    scrollWrap.appendChild(prevCards);
    secLines.appendChild(scrollWrap);
    root.appendChild(secLines);

    var btnRow = document.createElement('div');
    btnRow.className = 'btn-row pro-sign-save-preview-actions';

    var btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'btn-secondary';
    btnCancel.textContent = '取消';
    btnCancel.addEventListener('click', closeReportOverlay);

    var btnConfirm = document.createElement('button');
    btnConfirm.type = 'button';
    btnConfirm.className = 'btn-primary';
    btnConfirm.textContent = '确认';

    btnConfirm.addEventListener('click', function () {
      if (state.proSignSavePosting) return;
      btnConfirm.disabled = true;
      btnCancel.disabled = true;
      btnConfirm.textContent = '保存中…';
      state.proSignSavePosting = true;
      var payload = Object.assign({}, body, { signAt: new Date().toISOString() });
      apiFetch('/pro-sign/online-sign-save', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
        .then(function (data) {
          state.proSignSavePosting = false;
          if (!state.proSignReceiveMerge) {
            var msgLeft = '保存已完成';
            if (data && data.docEntry != null) msgLeft += '，单号 ' + data.docEntry;
            showToast(msgLeft);
            closeReportOverlay();
            return;
          }
          var msg = '已保存';
          if (data && data.docEntry != null) msg += '，单号 ' + data.docEntry;
          showToast(msg);
          closeReportOverlay();
          proSignAfterSaveAndReturn();
        })
        .catch(function (e) {
          state.proSignSavePosting = false;
          showToast(e.message || '保存失败');
          btnConfirm.disabled = false;
          btnCancel.disabled = false;
          btnConfirm.textContent = '确认';
        });
    });

    btnRow.appendChild(btnCancel);
    btnRow.appendChild(btnConfirm);
    root.appendChild(btnRow);

    el.reportOverlayBody.appendChild(root);
    armReportOverlayOpenGuard();
    el.reportOverlay.hidden = false;
  }

  function openReportTextOverlay(title, text) {
    if (!el.reportOverlay) return;
    el.reportOverlayTitle.textContent = title || '全文';
    el.reportOverlayBody.innerHTML = '';
    var pre = document.createElement('pre');
    pre.className = 'report-overlay-text';
    pre.textContent = text;
    el.reportOverlayBody.appendChild(pre);
    armReportOverlayOpenGuard();
    el.reportOverlay.hidden = false;
  }

  function renderReportRowDetailPage(data) {
    if (!el.reportRowDetailBody) return;
    el.reportRowDetailBody.innerHTML = '';
    var cols = data.columns || [];
    var rows = data.rows || [];
    if (rows.length === 0) {
      el.reportRowDetailBody.innerHTML = '<p class="muted">无明细数据</p>';
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'report-detail-scroll report-detail-transpose-wrap';
    rows.forEach(function (row, rowIdx) {
      if (rows.length > 1) {
        var title = document.createElement('div');
        title.className = 'report-detail-record-title';
        title.textContent = '记录 ' + (rowIdx + 1);
        wrap.appendChild(title);
      }
      var table = document.createElement('table');
      table.className = 'report-detail-transpose';
      var tbody = document.createElement('tbody');
      cols.forEach(function (c) {
        var tr = document.createElement('tr');
        var th = document.createElement('th');
        th.scope = 'row';
        th.textContent =
          c != null && String(c).trim() !== ''
            ? reportColumnHeaderText(String(c), state.dynamicReportColumnLabels)
            : '—';
        var td = document.createElement('td');
        var v = row[c];
        td.textContent = v == null || v === '' ? '—' : String(v);
        tr.appendChild(th);
        tr.appendChild(td);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    });
    el.reportRowDetailBody.appendChild(wrap);
    if (data.truncated) {
      var note = document.createElement('p');
      note.className = 'muted';
      note.style.marginTop = '8px';
      note.textContent = '（结果已截断）';
      el.reportRowDetailBody.appendChild(note);
    }
  }

  function loadReportRowDetail(detailKey) {
    if (!el.reportRowDetailBody) return;
    state.viewName = 'report-row-detail';
    applyUI();
    window.scrollTo(0, 0);
    el.reportRowDetailBody.innerHTML =
      '<p class="muted" style="text-align:center;padding:24px">加载中…</p>';
    apiFetchReport('/reports/detail', {
      method: 'POST',
      body: JSON.stringify({
        routeKey: state.dynamicReportRouteKey,
        params: collectDynamicReportParams(),
        detailKey: detailKey,
      }),
    })
      .then(function (data) {
        renderReportRowDetailPage(data);
      })
      .catch(function (err) {
        var detailMsg = err.message || '加载失败';
        if (err.data && err.data.detail) {
          detailMsg +=
            '<br><br><strong style="color:#d32f2f;">详细错误：</strong><br><pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;color:#b71c1c;background:#ffebee;padding:10px;border-radius:4px;margin-top:8px;border:1px solid #ef9a9a;max-height:300px;overflow:auto;">' +
            String(err.data.detail).replace(/</g, '&lt;').replace(/>/g, '&gt;') +
            '</pre>';
        }
        el.reportRowDetailBody.innerHTML =
          '<div class="report-row-detail-error">' + detailMsg + '</div>';
        if (err.status === 401) {
          goLogin();
        }
      });
  }

  function renderDynamicReportResult() {
    var wrap = el.dynamicReportTableWrap;
    wrap.innerHTML = '';
    var columns = state.reportLastColumns || [];
    var rows;
    if (state.reportClientSidePaging && state.reportClientRowsBuffer) {
      var start = (state.reportPage - 1) * state.reportPageSize;
      rows = state.reportClientRowsBuffer.slice(start, start + state.reportPageSize);
    } else {
      rows = state.reportServerRows || [];
    }
    if (state.proSignMode) {
      state.proSignTableRows = rows || [];
    }

    if (state.reportTotalRowCount === 0 && (!rows || !rows.length)) {
      wrap.innerHTML = '<p class="empty">无数据</p>';
      if (state.proSignMode) appendProSignMergeListHint(wrap);
      return;
    }

    if ((!rows || !rows.length) && state.reportTotalRowCount > 0) {
      wrap.innerHTML = '<p class="empty">当前页无数据</p>';
      appendReportPager(wrap);
      if (state.proSignMode) appendProSignMergeListHint(wrap);
      return;
    }

    var table = document.createElement('table');
    table.className = 'owor-data-table dynamic-report-grid';
    var thead = document.createElement('thead');
    var trh = document.createElement('tr');
    var cols = columns.length ? columns : Object.keys(rows[0] || {});

    if (state.proSignMode) {
      var thCheck = document.createElement('th');
      thCheck.className = 'pro-sign-th-check';
      var selAll = document.createElement('input');
      selAll.type = 'checkbox';
      selAll.setAttribute('aria-label', '全选本页');
      selAll.addEventListener('change', function () {
        wrap.querySelectorAll('tbody input.pro-sign-row-cb').forEach(function (cb) {
          cb.checked = selAll.checked;
        });
      });
      thCheck.appendChild(selAll);
      trh.appendChild(thCheck);
    }

    cols.forEach(function (c) {
      var th = document.createElement('th');
      th.textContent = reportColumnHeaderText(c, state.dynamicReportColumnLabels);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    var tbody = document.createElement('tbody');
    var rowDetailOn = state.dynamicReportRowDetail.enabled && !state.proSignMode;
    var keyCol = state.dynamicReportRowDetail.keyColumn;
    rows.forEach(function (row, rowIdx) {
      var tr = document.createElement('tr');
      if (state.proSignMode) {
        tr.dataset.proSignRowIndex = String(rowIdx);
        var tdCheck = document.createElement('td');
        tdCheck.className = 'pro-sign-td-check';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'pro-sign-row-cb';
        var oid = getRowValueForColumn(row, 'DocEntry');
        var opid = getRowValueForColumn(row, 'StepCode');
        cb.dataset.orderId = oid != null && oid !== '' ? String(oid) : '';
        cb.dataset.opId = opid != null && opid !== '' ? String(opid) : '';
        cb.addEventListener('click', function (e) {
          e.stopPropagation();
        });
        tdCheck.appendChild(cb);
        tr.appendChild(tdCheck);
      }
      if (rowDetailOn) {
        tr.className = 'report-row-clickable';
        tr.addEventListener('click', function (e) {
          if (e.target.closest && e.target.closest('.report-cell-expand')) return;
          var raw = getRowValueForColumn(row, keyCol);
          if (raw === undefined || raw === null || raw === '') {
            showToast('当前行缺少主键列「' + keyCol + '」');
            return;
          }
          var dk =
            typeof raw === 'bigint' ? raw.toString() : raw;
          loadReportRowDetail(dk);
        });
      }
      cols.forEach(function (c) {
        var td = document.createElement('td');
        var v = getRowValueForColumn(row, c);
        var display = v == null || v === '' ? '—' : String(v);
        var inner = document.createElement('div');
        inner.className = 'report-cell-inner';
        var textSpan = document.createElement('span');
        textSpan.className = 'report-cell-text';
        textSpan.textContent = display;
        textSpan.title = display !== '—' ? display : '';
        inner.appendChild(textSpan);
        if (display !== '—' && display.length > 36) {
          var exp = document.createElement('button');
          exp.type = 'button';
          exp.className = 'report-cell-expand';
          exp.textContent = '···';
          exp.setAttribute('aria-label', '查看全文');
          exp.addEventListener('click', function (ev) {
            ev.stopPropagation();
          });
          bindTap(exp, function () {
            openReportTextOverlay(c, display);
          });
          inner.appendChild(exp);
        }
        td.appendChild(inner);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    var scroll = document.createElement('div');
    scroll.className = 'report-table-scroll';
    scroll.appendChild(table);
    wrap.appendChild(scroll);
    appendReportPager(wrap);
    if (state.proSignMode) appendProSignMergeListHint(wrap);
    if (wrap.scrollIntoView) {
      requestAnimationFrame(function () {
        wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }

  function appendReportPager(container) {
    var total = state.reportTotalRowCount;
    if (total <= 0) return;
    var maxP = reportMaxPage();
    var nav = document.createElement('div');
    nav.className = 'report-pager';

    var main = document.createElement('div');
    main.className = 'report-pager-main';

    var info = document.createElement('span');
    info.className = 'report-pager-info';
    var trunc = state.reportTruncated ? '（结果已截断）' : '';
    if (maxP > 1) {
      info.textContent =
        '第 ' + state.reportPage + ' / ' + maxP + ' 页，共 ' + total + ' 条' + trunc;
    } else {
      info.textContent = '共 ' + total + ' 条' + trunc;
    }

    if (maxP > 1) {
      var prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'btn-text report-pager-btn';
      prev.textContent = '上一页';
      prev.disabled = state.reportPage <= 1;
      bindTap(prev, function () {
        changeReportPage(-1);
      });

      var next = document.createElement('button');
      next.type = 'button';
      next.className = 'btn-text report-pager-btn';
      next.textContent = '下一页';
      next.disabled = state.reportPage >= maxP;
      bindTap(next, function () {
        changeReportPage(1);
      });

      main.appendChild(prev);
      main.appendChild(info);
      main.appendChild(next);
    } else {
      main.appendChild(info);
    }
    nav.appendChild(main);

    var tools = document.createElement('div');
    tools.className = 'report-pager-tools';

    var sizeLabel = document.createElement('label');
    sizeLabel.className = 'report-pager-field';
    var sizeSpan = document.createElement('span');
    sizeSpan.textContent = '每页';
    var sizeSel = document.createElement('select');
    sizeSel.className = 'report-pager-select';
    sizeSel.setAttribute('aria-label', '每页条数');
    var currentPs = normalizeReportPageSize(state.reportPageSize);
    REPORT_PAGE_SIZE_OPTIONS.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = String(s);
      opt.textContent = s + ' 条';
      if (s === currentPs) opt.selected = true;
      sizeSel.appendChild(opt);
    });
    sizeSel.addEventListener('change', function () {
      setReportPageSize(sizeSel.value);
    });
    sizeLabel.appendChild(sizeSpan);
    sizeLabel.appendChild(sizeSel);
    tools.appendChild(sizeLabel);

    if (maxP > 1) {
      var jumpLabel = document.createElement('label');
      jumpLabel.className = 'report-pager-field';
      var jumpSpan = document.createElement('span');
      jumpSpan.textContent = '跳转';
      var jumpInput = document.createElement('input');
      jumpInput.type = 'number';
      jumpInput.className = 'report-pager-jump-input';
      jumpInput.min = '1';
      jumpInput.max = String(maxP);
      jumpInput.value = String(state.reportPage);
      jumpInput.setAttribute('inputmode', 'numeric');
      jumpInput.setAttribute('aria-label', '跳转到页码');
      var jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      jumpBtn.className = 'btn-text report-pager-btn report-pager-jump-btn';
      jumpBtn.textContent = '前往';
      function doJump() {
        goReportPage(jumpInput.value);
      }
      bindTap(jumpBtn, doJump);
      jumpInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          doJump();
        }
      });
      jumpLabel.appendChild(jumpSpan);
      jumpLabel.appendChild(jumpInput);
      jumpLabel.appendChild(jumpBtn);
      tools.appendChild(jumpLabel);
    }

    nav.appendChild(tools);
    container.appendChild(nav);
  }

  function fetchMenus() {
    return apiFetch('/menus').then(function (data) {
      state.navMenus = data.items || [];
      if (state.viewName === 'root' && state.rootTab === 'catalog') {
        renderCatalogGrid();
      }
    });
  }

  function goLogin() {
    clearWorkRegTimers();
    state.proSignMode = false;
    state.proSignMenu = null;
    state.workRegBatchId = null;
    state.workRegSnapshot = null;
    setToken(null);
    state.navMenus = [];
    state.userRole = 'operator';
    state.userDisplayName = '';
    state.username = '';
    state.viewName = 'login';
    document.body.classList.remove('has-bottom-nav', 'app-dark');
    applyUI();
    el.formLogin.reset();
    el.loginErr.hidden = true;
  }

  function goOwor() {
    state.viewName = 'owor';
    applyUI();
    loadOwor();
  }

  function loadOwor() {
    el.oworEmpty.hidden = true;
    el.oworEmpty.textContent = '暂无数据';
    el.oworErr.hidden = true;
    el.oworErr.textContent = '';
    el.oworList.innerHTML = '<p class="muted" style="text-align:center;padding:20px">加载中…</p>';
    el.oworTablePanel.innerHTML = '';
    apiFetch('/owor')
      .then(function (data) {
        el.oworList.innerHTML = '';
        var rows = data.rows || [];
        var meta = data.meta || {};
        if (rows.length === 0) {
          el.oworEmpty.hidden = false;
          if (meta.database) {
            el.oworEmpty.textContent =
              '暂无数据（当前连接库：' +
              meta.database +
              '）。请核对 .env 的 DB_NAME 是否与 SSMS 中查询 OITM 的数据库一致。';
          } else {
            el.oworEmpty.textContent = '暂无数据';
          }
          return;
        }
        rows.forEach(function (r) {
          var card = document.createElement('article');
          card.className = 'owor-card';
          var head = document.createElement('div');
          head.className = 'owor-card-head';
          var t1 = document.createElement('span');
          t1.className = 'owor-card-title';
          t1.textContent = 'ItemCode';
          var badge = document.createElement('span');
          badge.className = 'owor-doc-badge';
          badge.textContent = r.itemCode || '—';
          head.appendChild(t1);
          head.appendChild(badge);
          var dl = document.createElement('dl');
          dl.className = 'owor-kv';
          function kv(label, val) {
            var dt = document.createElement('dt');
            dt.textContent = label;
            var dd = document.createElement('dd');
            dd.textContent = val;
            dl.appendChild(dt);
            dl.appendChild(dd);
          }
          kv('ItemName', r.itemName || '—');
          kv('FrgnName', r.frgnName || '—');
          card.appendChild(head);
          card.appendChild(dl);
          el.oworList.appendChild(card);
        });

        var table = document.createElement('table');
        table.className = 'owor-data-table';
        var thead = document.createElement('thead');
        var trh = document.createElement('tr');
        ['物料编码', '物料名称', '外文名称'].forEach(function (h) {
          var th = document.createElement('th');
          th.textContent = h;
          trh.appendChild(th);
        });
        thead.appendChild(trh);
        var tbody = document.createElement('tbody');
        rows.forEach(function (r) {
          var tr = document.createElement('tr');
          var cells = [r.itemCode || '—', r.itemName || '—', r.frgnName || '—'];
          cells.forEach(function (c) {
            var td = document.createElement('td');
            td.textContent = c == null ? '—' : String(c);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(thead);
        table.appendChild(tbody);
        el.oworTablePanel.innerHTML = '';
        el.oworTablePanel.appendChild(table);
      })
      .catch(function (err) {
        el.oworList.innerHTML = '';
        el.oworTablePanel.innerHTML = '';
        el.oworErr.textContent = err.message || '加载失败';
        el.oworErr.hidden = false;
        if (err.status === 401) goLogin();
      });
  }

  function goOrders() {
    state.viewName = 'orders';
    applyUI();
    loadOrders();
  }

  function goMenuSettings() {
    state.viewName = 'menu-settings';
    applyUI();
    loadMenuAdmin();
  }

  function loadMenuAdmin() {
    el.menuAdminList.innerHTML = '<p class="muted">加载中…</p>';
    apiFetch('/admin/menus')
      .then(function (data) {
        renderMenuAdminList(data.items || []);
      })
      .catch(function (err) {
        el.menuAdminList.innerHTML =
          '<p class="err">' + (err.message || '加载失败') + '</p>';
        if (err.status === 403) showToast('需要管理员权限');
        if (err.status === 401) goLogin();
      });
  }

  function renderMenuAdminList(items) {
    el.menuAdminList.innerHTML = '';
    if (items.length === 0) {
      var p = document.createElement('p');
      p.className = 'empty';
      p.textContent = '暂无菜单，请在下方添加';
      el.menuAdminList.appendChild(p);
      return;
    }
    items.forEach(function (item) {
      el.menuAdminList.appendChild(buildMenuEditCard(item));
    });
  }

  function buildMenuEditCard(item) {
    var card = document.createElement('div');
    card.className = 'card menu-edit-card';

    var h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = '菜单 #' + item.id;
    card.appendChild(h);

    function addField(labelText, input) {
      var lab = document.createElement('label');
      lab.className = 'field';
      var sp = document.createElement('span');
      sp.textContent = labelText;
      lab.appendChild(sp);
      lab.appendChild(input);
      card.appendChild(lab);
    }

    var inLabel = document.createElement('input');
    inLabel.type = 'text';
    inLabel.value = item.label;
    inLabel.required = true;
    inLabel.maxLength = 128;
    addField('名称', inLabel);

    var inRoute = document.createElement('input');
    inRoute.type = 'text';
    inRoute.value = item.routeKey;
    inRoute.required = true;
    inRoute.maxLength = 64;
    addField('路由标识', inRoute);

    var inIcon = document.createElement('input');
    inIcon.type = 'text';
    inIcon.value = item.icon || '';
    inIcon.maxLength = 32;
    addField('图标', inIcon);

    var inSort = document.createElement('input');
    inSort.type = 'number';
    inSort.step = '1';
    inSort.value = String(item.sortOrder);
    addField('排序', inSort);

    var en = document.createElement('label');
    en.className = 'field row-inline';
    var cbEn = document.createElement('input');
    cbEn.type = 'checkbox';
    cbEn.checked = item.enabled !== false;
    en.appendChild(cbEn);
    var spEn = document.createElement('span');
    spEn.textContent = '启用';
    en.appendChild(spEn);
    card.appendChild(en);

    var rolesDiv = document.createElement('div');
    rolesDiv.className = 'field';
    var rs = document.createElement('span');
    rs.textContent = '可见角色';
    rolesDiv.appendChild(rs);

    var ra = document.createElement('label');
    ra.className = 'row-inline';
    var cba = document.createElement('input');
    cba.type = 'checkbox';
    cba.checked = (item.roles || []).indexOf('admin') >= 0;
    ra.appendChild(cba);
    ra.appendChild(document.createTextNode(' 管理员'));
    rolesDiv.appendChild(ra);

    var ro = document.createElement('label');
    ro.className = 'row-inline';
    var cbo = document.createElement('input');
    cbo.type = 'checkbox';
    cbo.checked = (item.roles || []).indexOf('operator') >= 0;
    ro.appendChild(cbo);
    ro.appendChild(document.createTextNode(' 普通用户'));
    rolesDiv.appendChild(ro);
    card.appendChild(rolesDiv);

    var isReserved = item.routeKey === 'orders' || item.routeKey === 'menu-settings';

    var selKind = document.createElement('select');
    var optB = document.createElement('option');
    optB.value = 'builtin';
    optB.textContent = '内置页面';
    var optR = document.createElement('option');
    optR.value = 'report';
    optR.textContent = '可配置报表（SQL）';
    selKind.appendChild(optB);
    selKind.appendChild(optR);
    selKind.value = item.menuKind || 'builtin';
    if (isReserved) selKind.disabled = true;
    addField('菜单类型', selKind);

    var taQuery = document.createElement('textarea');
    taQuery.rows = 4;
    taQuery.value = item.queryTemplate || '';
    if (isReserved) taQuery.disabled = true;
    addField('SQL 模板', taQuery);

    var taFilter = document.createElement('textarea');
    taFilter.rows = 4;
    try {
      taFilter.value = JSON.stringify(item.filterSchema || [], null, 2);
    } catch (e) {
      taFilter.value = '[]';
    }
    if (isReserved) taFilter.disabled = true;
    addField('查询条件 JSON', taFilter);

    var taColumnLabels = document.createElement('textarea');
    taColumnLabels.rows = 3;
    try {
      taColumnLabels.value = JSON.stringify(item.columnLabels || {}, null, 2);
    } catch (e) {
      taColumnLabels.value = '{}';
    }
    taColumnLabels.placeholder =
      '表头用：键为列名（映射后优先）。未配置列名映射时须与 SQL 原列名一致。';
    if (isReserved) taColumnLabels.disabled = true;
    addField('列表列标题映射 JSON（可选）', taColumnLabels);

    var taColumnNameMapping = document.createElement('textarea');
    taColumnNameMapping.rows = 3;
    try {
      taColumnNameMapping.value = JSON.stringify(item.columnNameMapping || {}, null, 2);
    } catch (e) {
      taColumnNameMapping.value = '{}';
    }
    taColumnNameMapping.placeholder =
      '逻辑列名 -> SQL 列名，例如：{"DocEntry":"order_id","StepCode":"OpId"}，合并报工需 DocEntry、StepCode';
    if (isReserved) taColumnNameMapping.disabled = true;
    addField('列名映射 JSON（可选）', taColumnNameMapping);

    var taDetail = document.createElement('textarea');
    taDetail.rows = 3;
    taDetail.value = item.detailQueryTemplate || '';
    taDetail.placeholder = '留空表示不启用行点击查看详情；SQL 须含主键参数（默认 @detailKey）';
    if (isReserved) taDetail.disabled = true;
    addField('行详情 SQL（可选）', taDetail);

    var inDetailCol = document.createElement('input');
    inDetailCol.type = 'text';
    inDetailCol.maxLength = 256;
    inDetailCol.value = item.detailKeyColumn || '';
    inDetailCol.placeholder = '与列表结果列名一致';
    if (isReserved) inDetailCol.disabled = true;
    addField('行主键列名', inDetailCol);

    var inDetailParam = document.createElement('input');
    inDetailParam.type = 'text';
    inDetailParam.maxLength = 128;
    inDetailParam.value = item.detailKeyParam || 'detailKey';
    if (isReserved) inDetailParam.disabled = true;
    addField('详情 SQL 主键参数名', inDetailParam);

    var selDetailType = document.createElement('select');
    ['string', 'int', 'decimal', 'date', 'datetime', 'bool'].forEach(function (t) {
      var o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      selDetailType.appendChild(o);
    });
    selDetailType.value = item.detailKeyType || 'string';
    if (isReserved) selDetailType.disabled = true;
    addField('行主键类型', selDetailType);

    var btnRow = document.createElement('div');
    btnRow.className = 'btn-row';

    var btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.className = 'btn-primary';
    btnSave.textContent = '保存';
    btnSave.addEventListener('click', function () {
      var roles = [];
      if (cba.checked) roles.push('admin');
      if (cbo.checked) roles.push('operator');
      var mk = isReserved ? 'builtin' : selKind.value;
      var qtpl = isReserved ? '' : taQuery.value.trim();
      var fsParsed = [];
      var columnLabelsParsed = {};
      var columnNameMappingParsed = {};
      if (!isReserved) {
        try {
          fsParsed = taFilter.value.trim() ? JSON.parse(taFilter.value) : [];
        } catch (e) {
          showToast('查询条件 JSON 格式错误');
          return;
        }
        if (mk === 'report') {
          try {
            columnLabelsParsed = taColumnLabels.value.trim()
              ? JSON.parse(taColumnLabels.value)
              : {};
          } catch (e) {
            showToast('列标题映射 JSON 格式错误');
            return;
          }
          try {
            columnNameMappingParsed = taColumnNameMapping.value.trim()
              ? JSON.parse(taColumnNameMapping.value)
              : {};
          } catch (e) {
            showToast('列名映射 JSON 格式错误');
            return;
          }
        }
      }
      var columnNameMappingForPatch =
        !isReserved && mk === 'report' ? columnNameMappingParsed : {};
      var detailBody = {
        detailQueryTemplate: '',
        detailKeyColumn: '',
        detailKeyParam: 'detailKey',
        detailKeyType: 'string',
      };
      if (!isReserved && mk === 'report') {
        detailBody.detailQueryTemplate = taDetail.value.trim();
        detailBody.detailKeyColumn = inDetailCol.value.trim();
        detailBody.detailKeyParam = inDetailParam.value.trim() || 'detailKey';
        detailBody.detailKeyType = selDetailType.value;
      }
      apiFetch('/admin/menus/' + item.id, {
        method: 'PATCH',
        body: JSON.stringify(
          Object.assign(
            {
              label: inLabel.value.trim(),
              routeKey: inRoute.value.trim().toLowerCase(),
              icon: inIcon.value.trim(),
              sortOrder: parseInt(inSort.value, 10),
              enabled: cbEn.checked,
              roles: roles,
              menuKind: mk,
              queryTemplate: qtpl,
              filterSchema: fsParsed,
              columnLabels: columnLabelsParsed,
              columnNameMapping: columnNameMappingForPatch,
            },
            detailBody
          )
        ),
      })
        .then(function () {
          showToast('已保存');
          return fetchMenus();
        })
        .then(function () {
          loadMenuAdmin();
        })
        .catch(function (e) {
          showToast(e.message || '保存失败');
        });
    });

    var btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'btn-secondary danger';
    btnDel.textContent = '删除';
    btnDel.addEventListener('click', function () {
      if (!confirm('确定删除该菜单？')) return;
      apiFetch('/admin/menus/' + item.id, { method: 'DELETE' })
        .then(function () {
          showToast('已删除');
          return fetchMenus();
        })
        .then(function () {
          loadMenuAdmin();
        })
        .catch(function (e) {
          showToast(e.message || '删除失败');
        });
    });

    btnRow.appendChild(btnSave);
    btnRow.appendChild(btnDel);
    card.appendChild(btnRow);

    return card;
  }

  el.formAddMenu.addEventListener('submit', function (e) {
    e.preventDefault();
    el.menuAddErr.hidden = true;
    var fd = new FormData(el.formAddMenu);
    var ra = el.formAddMenu.querySelector('[name="roleAdmin"]');
    var ro = el.formAddMenu.querySelector('[name="roleOperator"]');
    var roles = [];
    if (ra && ra.checked) roles.push('admin');
    if (ro && ro.checked) roles.push('operator');
    var sortRaw = fd.get('sortOrder');
    var sortOrder = parseInt(sortRaw, 10);
    var menuKind = (fd.get('menuKind') || 'builtin').toString();
    var queryTemplate = (fd.get('queryTemplate') || '').toString().trim();
    var filterSchema = [];
    var fsRaw = (fd.get('filterSchema') || '').toString().trim();
    if (fsRaw) {
      try {
        filterSchema = JSON.parse(fsRaw);
      } catch (e) {
        el.menuAddErr.textContent = '查询条件 JSON 格式错误';
        el.menuAddErr.hidden = false;
        return;
      }
    }
    var columnLabels = {};
    var clRaw = (fd.get('columnLabels') || '').toString().trim();
    if (clRaw) {
      try {
        columnLabels = JSON.parse(clRaw);
      } catch (e) {
        el.menuAddErr.textContent = '列标题映射 JSON 格式错误';
        el.menuAddErr.hidden = false;
        return;
      }
    }
    var columnNameMapping = {};
    var cnmRaw = (fd.get('columnNameMapping') || '').toString().trim();
    if (cnmRaw) {
      try {
        columnNameMapping = JSON.parse(cnmRaw);
      } catch (e) {
        el.menuAddErr.textContent = '列名映射 JSON 格式错误';
        el.menuAddErr.hidden = false;
        return;
      }
    }
    apiFetch('/admin/menus', {
      method: 'POST',
      body: JSON.stringify({
        label: (fd.get('label') || '').toString().trim(),
        routeKey: (fd.get('routeKey') || '').toString().trim().toLowerCase(),
        icon: (fd.get('icon') || '').toString().trim(),
        sortOrder: sortOrder,
        enabled: fd.get('enabled') === 'on',
        roles: roles,
        menuKind: menuKind,
        queryTemplate: queryTemplate,
        filterSchema: filterSchema,
        columnLabels: columnLabels,
        columnNameMapping: columnNameMapping,
        detailQueryTemplate: (fd.get('detailQueryTemplate') || '').toString(),
        detailKeyColumn: (fd.get('detailKeyColumn') || '').toString().trim(),
        detailKeyParam: (fd.get('detailKeyParam') || '').toString().trim() || 'detailKey',
        detailKeyType: (fd.get('detailKeyType') || 'string').toString(),
      }),
    })
      .then(function () {
        showToast('已添加');
        el.formAddMenu.reset();
        var so = el.formAddMenu.querySelector('[name="sortOrder"]');
        if (so) so.value = '100';
        var en = el.formAddMenu.querySelector('[name="enabled"]');
        if (en) en.checked = true;
        if (ro) ro.checked = true;
        if (ra) ra.checked = false;
        return fetchMenus();
      })
      .then(function () {
        loadMenuAdmin();
      })
      .catch(function (err) {
        el.menuAddErr.textContent = err.message || '添加失败';
        el.menuAddErr.hidden = false;
      });
  });

  function goDetail(id) {
    state.currentOrderId = id;
    state.selectedOpId = null;
    state.viewName = 'detail';
    applyUI();
    el.formReport.reset();
    el.reportErr.hidden = true;
    var scrap = el.formReport.querySelector('[name="scrapQty"]');
    if (scrap) scrap.value = '0';
    loadDetail(id);
  }

  function loadOrders() {
    el.ordersEmpty.hidden = true;
    el.orderList.innerHTML = '';
    return apiFetch('/orders')
      .then(function (data) {
        var items = data.items || [];
        if (items.length === 0) {
          el.ordersEmpty.hidden = false;
          return;
        }
        items.forEach(function (item) {
          var li = document.createElement('li');
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'order-item';
          btn.innerHTML =
            '<div class="order-row"><span class="order-no"></span><span class="badge"></span></div>' +
            '<div class="order-product"></div>' +
            '<div class="order-meta"></div>';
          btn.querySelector('.order-no').textContent = item.orderNo;
          btn.querySelector('.badge').textContent = statusLabel(item.status);
          btn.querySelector('.order-product').textContent = item.productName || '—';
          btn.querySelector('.order-meta').textContent =
            '计划 ' + item.plannedQty + ' · 已报 ' + item.reportedQty;
          btn.addEventListener('click', function () {
            goDetail(item.id);
          });
          li.appendChild(btn);
          el.orderList.appendChild(li);
        });
      })
      .catch(function (err) {
        if (err.status === 401) goLogin();
        else showToast(err.message || '加载失败');
      });
  }

  function loadDetail(id) {
    el.detailHead.innerHTML = '<p class="muted">加载中…</p>';
    el.reportList.innerHTML = '';
    el.reportsEmpty.hidden = true;
    el.opWrap.hidden = true;
    el.opChips.innerHTML = '';

    return apiFetch('/orders/' + id)
      .then(function (data) {
        state.detail = data;
        var order = data.order;
        el.detailHead.innerHTML =
          '<div class="order-no"></div><div class="meta"></div>';
        el.detailHead.querySelector('.order-no').textContent = order.orderNo;
        el.detailHead.querySelector('.meta').textContent =
          (order.productName || '') +
          ' · 计划 ' +
          order.plannedQty +
          ' · 已报 ' +
          order.reportedQty +
          ' · ' +
          statusLabel(order.status);

        var ops = data.operations || [];
        if (ops.length) {
          el.opWrap.hidden = false;
          state.selectedOpId = ops[0].id;
          ops.forEach(function (op) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'chip';
            if (op.id === state.selectedOpId) b.classList.add('is-active');
            b.textContent = op.seqNo + '. ' + (op.operationName || '');
            b.dataset.id = String(op.id);
            b.addEventListener('click', function () {
              state.selectedOpId = op.id;
              el.opChips.querySelectorAll('.chip').forEach(function (c) {
                c.classList.toggle('is-active', c.dataset.id === String(op.id));
              });
            });
            el.opChips.appendChild(b);
          });
        }

        var reports = data.recentReports || [];
        if (reports.length === 0) {
          el.reportsEmpty.hidden = false;
        } else {
          reports.forEach(function (r) {
            var li = document.createElement('li');
            li.className = 'report-item';
            li.innerHTML = '<div></div><div class="report-sub"></div>';
            li.children[0].textContent =
              '良 ' + r.goodQty + ' / 不良 ' + r.scrapQty + ' · ' + (r.reporterName || '');
            li.children[1].textContent = r.reportedAt || '';
            el.reportList.appendChild(li);
          });
        }
      })
      .catch(function (err) {
        el.detailHead.innerHTML = '<p class="err">' + (err.message || '加载失败') + '</p>';
        if (err.status === 401) goLogin();
      });
  }

  function applyUserFromAuth(data) {
    state.userRole = (data && data.role) || 'operator';
    state.username = (data && data.username) || '';
    state.userDisplayName = (data && data.displayName) || state.username || '';
  }

  el.formLogin.addEventListener('submit', function (e) {
    e.preventDefault();
    el.loginErr.hidden = true;
    var fd = new FormData(el.formLogin);
    var username = (fd.get('username') || '').toString().trim();
    var password = (fd.get('password') || '').toString();
    apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: username, password: password }),
    })
      .then(function (data) {
        setToken(data.token);
        applyUserFromAuth(data.user);
        return fetchMenus();
      })
      .then(function () {
        goRoot('catalog');
      })
      .catch(function (err) {
        el.loginErr.textContent = err.message || '登录失败';
        el.loginErr.hidden = false;
      });
  });

  el.btnSettingsLogout.addEventListener('click', function () {
    goLogin();
  });

  el.bottomNav.querySelectorAll('[data-root-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var tab = btn.getAttribute('data-root-tab');
      state.rootTab = tab;
      state.viewName = 'root';
      applyUI();
      if (tab === 'catalog') renderCatalogGrid();
    });
  });

  el.btnBack.addEventListener('click', function () {
    if (state.viewName === 'detail') {
      goOrders();
    } else if (state.viewName === 'report-row-detail') {
      state.viewName = 'dynamic-report';
      applyUI();
      window.scrollTo(0, 0);
    } else if (state.viewName === 'pro-sign-receive') {
      goBackFromProSignReceive();
    } else if (state.viewName === 'work-registration') {
      clearWorkRegTimers();
      goProSignList(
        state.proSignMenu || {
          label: '生产报工',
          menuKind: 'report',
          filterSchema: [],
          columnLabels: {},
        }
      );
    } else if (state.viewName === 'dynamic-report' && state.proSignMode) {
      state.proSignMode = false;
      state.proSignMenu = null;
      goRoot('catalog');
    } else if (
      state.viewName === 'owor' ||
      state.viewName === 'orders' ||
      state.viewName === 'menu-settings' ||
      state.viewName === 'dynamic-report'
    ) {
      goRoot('catalog');
    } else {
      goRoot('catalog');
    }
  });

  el.formReport.addEventListener('submit', function (e) {
    e.preventDefault();
    el.reportErr.hidden = true;
    var id = state.currentOrderId;
    if (!id) return;
    var fd = new FormData(el.formReport);
    var good = parseFloat(fd.get('goodQty'));
    var scrap = parseFloat(fd.get('scrapQty') || '0');
    if (!isFinite(good) || good <= 0) {
      el.reportErr.textContent = '请填写大于 0 的良品数量';
      el.reportErr.hidden = false;
      return;
    }
    var body = {
      goodQty: good,
      scrapQty: isFinite(scrap) ? scrap : 0,
      remark: (fd.get('remark') || '').toString(),
    };
    if (state.selectedOpId != null) {
      body.operationId = state.selectedOpId;
    }
    apiFetch('/orders/' + id + '/report', {
      method: 'POST',
      body: JSON.stringify(body),
    })
      .then(function () {
        showToast('报工已提交');
        goOrders();
      })
      .catch(function (err) {
        el.reportErr.textContent = err.message || '提交失败';
        el.reportErr.hidden = false;
      });
  });

  var touchStartY = 0;
  el.orders.addEventListener(
    'touchstart',
    function (e) {
      touchStartY = e.touches[0].clientY;
    },
    { passive: true }
  );
  el.orders.addEventListener('touchend', function (e) {
    var dy = e.changedTouches[0].clientY - touchStartY;
    if (window.scrollY <= 0 && dy > 60) loadOrders();
  });

  var oworTouchY = 0;
  el.owor.addEventListener(
    'touchstart',
    function (e) {
      oworTouchY = e.touches[0].clientY;
    },
    { passive: true }
  );
  el.owor.addEventListener('touchend', function (e) {
    var dy = e.changedTouches[0].clientY - oworTouchY;
    if (window.scrollY <= 0 && dy > 60) loadOwor();
  });

  if (el.reportOverlayClose) {
    bindTap(el.reportOverlayClose, closeReportOverlay);
  }
  if (el.reportOverlayBackdrop) {
    el.reportOverlayBackdrop.addEventListener('click', function () {
      if (Date.now() < state.reportOverlayBackdropGuardUntil) return;
      closeReportOverlay();
    });
  }
  if (el.proSignReceiveBtnSave) {
    bindTap(el.proSignReceiveBtnSave, onProSignReceiveSaveClick);
  }
  if (el.proSignListMergeBtn) {
    bindTap(el.proSignListMergeBtn, triggerProSignMergeFromList);
  }

  function boot() {
    if (getToken()) {
      apiFetch('/auth/me')
        .then(function (data) {
          applyUserFromAuth(data);
          return fetchMenus();
        })
        .then(function () {
          goRoot('catalog');
        })
        .catch(function () {
          setToken(null);
          state.viewName = 'login';
          applyUI();
        });
    } else {
      state.viewName = 'login';
      applyUI();
    }
  }

  boot();
})();
