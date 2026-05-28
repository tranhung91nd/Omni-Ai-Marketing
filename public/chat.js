const state = {
  accounts: [],
  ownId: null,
  threads: [],
  threadFilter: { status: 'all', labels: new Set() },
  labelsCache: [],
  currentThread: null,
  messages: [],
  msgOffset: 0,
  msgHasMore: true,
  msgLoading: false,
  templates: [],
  loginSid: null,
  loginTimer: null,
  ws: null,
  replyTo: null,
  license: null,
};
const PAGE_SIZE = 50;
const DEFAULT_ACCOUNT_PROXY = '1.2.3.4:8080';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function api(url, opts = {}) {
  return fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  }).then(r => r.json()).then(data => {
    if (data?.licenseRequired) showLicenseGate(data.license, data.error);
    return data;
  });
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function licenseMessage(status, fallback) {
  if (fallback) return fallback;
  const reason = status?.reason;
  if (reason === 'not_activated') return 'Bản cài đặt này chưa được kích hoạt.';
  if (reason === 'expired') return 'License đã hết hạn.';
  if (reason === 'machine_mismatch') return 'License không khớp với máy hiện tại.';
  if (reason === 'validation_failed') return 'Không xác thực được license với server.';
  return 'Nhập mã license để sử dụng bản cài đặt này.';
}

function formatLicenseDate(expiresAt) {
  if (!expiresAt) return 'Không giới hạn';
  return new Date(expiresAt).toLocaleDateString('vi-VN');
}

function updateLicenseExpiryBadge(status) {
  const badge = $('#licenseExpiryBadge');
  const text = $('#licenseExpiryText');
  if (!badge || !text) return;
  badge.classList.remove('warn', 'expired');
  if (!status?.enforced) {
    badge.classList.add('hidden');
    return;
  }
  const expiresAt = status?.license?.expiresAt;
  const expired = Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
  const daysLeft = expiresAt ? Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000) : null;
  if (status.active) {
    text.textContent = `HSD: ${formatLicenseDate(expiresAt)}`;
    if (daysLeft !== null && daysLeft <= 7) badge.classList.add('warn');
  } else {
    text.textContent = expired ? 'License đã hết hạn' : 'License chưa kích hoạt';
    if (expired) badge.classList.add('expired');
  }
  badge.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}

function showLicenseGate(status, message) {
  const gate = $('#licenseGate');
  if (!gate) return;
  state.license = status || state.license;
  updateLicenseExpiryBadge(state.license);
  gate.classList.remove('hidden');
  const msg = $('#licenseGateMsg');
  const meta = $('#licenseMeta');
  if (msg) msg.textContent = licenseMessage(status, message);
  if (meta) {
    const parts = [];
    if (status?.machineId) parts.push(`Mã máy: ${status.machineId}`);
    if (status?.license?.customer) parts.push(`Khách hàng: ${status.license.customer}`);
    if (status?.license?.expiresAt) parts.push(`Hết hạn: ${formatLicenseDate(status.license.expiresAt)}`);
    if (status?.warning) parts.push(`Cảnh báo: ${status.warning}`);
    meta.textContent = parts.join(' | ');
  }
  const input = $('#licenseKeyInput');
  if (input) setTimeout(() => input.focus(), 0);
  if (window.lucide) window.lucide.createIcons();
}

function hideLicenseGate() {
  const gate = $('#licenseGate');
  if (gate) gate.classList.add('hidden');
}

async function refreshLicenseStatus(showOk = false) {
  try {
    const status = await fetch('/api/license/status').then(r => r.json());
    state.license = status;
    updateLicenseExpiryBadge(status);
    if (!status.enforced || status.active) {
      hideLicenseGate();
      if (showOk && status.enforced) toast('License hợp lệ', 'ok');
    } else {
      showLicenseGate(status);
    }
    return status;
  } catch (e) {
    showLicenseGate(null, 'Không kiểm tra được license: ' + e.message);
    return null;
  }
}

async function activateLicenseFromGate() {
  const input = $('#licenseKeyInput');
  const btn = $('#licenseActivateBtn');
  const key = (input?.value || '').trim();
  if (!key) return toast('Nhập mã license', 'err');
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/license/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: key }),
    }).then(res => res.json());
    if (!r.ok || !r.active) {
      showLicenseGate(r, r.error || 'Kích hoạt thất bại');
      return toast('Kích hoạt thất bại: ' + (r.error || 'License không hợp lệ'), 'err');
    }
    state.license = r;
    updateLicenseExpiryBadge(r);
    hideLicenseGate();
    toast('Kích hoạt thành công', 'ok');
    await loadAccounts();
  } catch (e) {
    showLicenseGate(null, 'Kích hoạt thất bại: ' + e.message);
    toast('Kích hoạt thất bại: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function checkDesktopUpdate() {
  const status = $('#desktopUpdateStatus');
  if (!status) return;
  try {
    const r = await fetch('/api/desktop/update').then(res => res.json());
    if (!r.enabled) {
      status.textContent = '';
    } else if (r.updateAvailable) {
      status.textContent = `Có bản mới ${r.latestVersion || ''}`;
    } else {
      status.textContent = `Phiên bản hiện tại ${r.currentVersion || ''}`;
    }
  } catch {
    status.textContent = '';
  }
}

function initLicenseGate() {
  const activateBtn = $('#licenseActivateBtn');
  const refreshBtn = $('#licenseRefreshBtn');
  const input = $('#licenseKeyInput');
  if (activateBtn) activateBtn.onclick = activateLicenseFromGate;
  if (refreshBtn) refreshBtn.onclick = () => refreshLicenseStatus(true);
  if (input) {
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        activateLicenseFromGate();
      }
    };
  }
  refreshLicenseStatus();
  checkDesktopUpdate();
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgo(ts) {
  if (!ts) return '';
  if (ts > 1e12) ts = Math.floor(ts / 1000);
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return 'vừa xong';
  if (sec < 3600) return Math.floor(sec / 60) + ' phút';
  if (sec < 86400) return Math.floor(sec / 3600) + ' giờ';
  return new Date(ts * 1000).toLocaleDateString('vi-VN');
}

function avatarText(name) { return (name || '?').trim().slice(0, 2).toUpperCase(); }

async function loadAccounts() {
  const r = await api('/api/chat/accounts');
  state.accounts = r.data || [];
  renderAccountDropdown();
  if (!state.ownId && state.accounts.length) {
    // Ưu tiên 1: account đã chọn lần trước (lưu localStorage)
    const lastOwnId = localStorage.getItem('lastOwnId');
    const lastAcc = lastOwnId && state.accounts.find(a => a.ownId === lastOwnId);
    if (lastAcc) {
      selectAccount(lastAcc.ownId);
    } else {
      // Ưu tiên 2: account đang connected
      const connected = state.accounts.find(a => a.connected);
      if (connected) selectAccount(connected.ownId);
      else if (state.accounts[0]) selectAccount(state.accounts[0].ownId);
    }
  } else {
    renderCurrentAccount();
  }
}

function renderAccountDropdown() {
  const box = $('#accList');
  if (!state.accounts.length) {
    box.innerHTML = '<div class="empty" style="padding:14px">Chưa có tài khoản nào. Bấm "Thêm tài khoản" ở trên cùng để bắt đầu.</div>';
    return;
  }
  box.innerHTML = state.accounts.map(a => `
    <div class="acc-item" data-id="${a.ownId}">
      <div class="dot ${a.connected ? 'on' : ''}"></div>
      <div class="nm">${escapeHtml(a.name || 'Acc')}</div>
      <div class="ix">${a.ownId}</div>
    </div>
  `).join('');
  box.querySelectorAll('.acc-item').forEach(el => {
    el.onclick = () => { selectAccount(el.dataset.id); $('#accDropdown').classList.add('hidden'); };
  });
}

function renderCurrentAccount() {
  const a = state.accounts.find(x => x.ownId === state.ownId);
  if (!a) {
    $('#accAvatar').textContent = '?';
    $('#accName').textContent = 'Chưa có tài khoản';
    $('#accId').textContent = '—';
    return;
  }
  $('#accAvatar').textContent = avatarText(a.name);
  $('#accName').textContent = a.name || 'Tài khoản Zalo';
  $('#accId').textContent = (a.connected ? '🟢 ' : '🔴 ') + a.ownId;
}

async function selectAccount(ownId) {
  if (state.ownId === ownId) return;
  state.ownId = ownId;
  try { localStorage.setItem('lastOwnId', ownId); } catch {}
  // Clear cache khi đổi account (tránh hiện data của account cũ)
  if (typeof pspState !== 'undefined') {
    pspState.friends = [];
    pspState.groups = [];
    pspState.members = [];
    pspState.selectedFriends?.clear?.();
    pspState.selectedMembers?.clear?.();
    pspState.selectedGroupsMulti?.clear?.();
  }
  if (typeof bkState !== 'undefined') {
    bkState.friends = [];
    bkState.selected?.clear?.();
  }
  const acc = state.accounts.find(a => a.ownId === ownId);
  renderCurrentAccount();
  if (acc && !acc.connected) {
    toast('Đang kết nối lại...', 'info');
    const r = await api(`/api/chat/account-connect/${ownId}`, { method: 'POST' });
    if (!r.ok) toast('Kết nối thất bại: ' + r.error, 'err');
    else { toast('Đã kết nối', 'ok'); await loadAccounts(); }
  }
  await loadThreads();
  await loadTemplates();
  state.currentThread = null;
  $('#chatHeader').classList.add('hidden');
  $('#chatFooter').classList.add('hidden');
  $('#messages').classList.add('hidden');
  $('#chatPlaceholder').classList.remove('hidden');
}

// ====== Thread filter (Phân loại) ======
async function loadLabels() {
  const r = await api('/api/labels');
  state.labelsCache = r.ok ? r.data : [];
  renderFilterLabels();
  renderThreads();
}

function renderFilterLabels() {
  const box = $('#filterLabelsList');
  if (!box) return;
  if (!state.labelsCache.length) {
    box.innerHTML = '<div class="hint" style="padding:6px 4px">Chưa có nhãn nào. Bấm "Quản lý nhãn" bên dưới để tạo.</div>';
    renderQuickFilterLabels();
    return;
  }
  box.innerHTML = state.labelsCache.map(lb => `
    <label class="filter-check">
      <input type="checkbox" data-lb="${escapeHtml(lb.name)}" ${state.threadFilter.labels.has(lb.name) ? 'checked' : ''} />
      <span class="lb-dot" style="background:${lb.color}"></span>
      <span>${escapeHtml(lb.name)}</span>
    </label>
  `).join('');
  box.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.onchange = () => {
      setThreadLabelFilter(cb.dataset.lb, cb.checked);
    };
  });
  renderQuickFilterLabels();
}

function setThreadLabelFilter(name, enabled) {
  if (enabled) state.threadFilter.labels.add(name);
  else state.threadFilter.labels.delete(name);
  renderFilterLabels();
  updateFilterBtnLabel();
  renderThreads();
}

function renderQuickFilterLabels() {
  const box = $('#filterQuickLabels');
  if (!box) return;
  if (!state.labelsCache.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = state.labelsCache.map(lb => {
    const active = state.threadFilter.labels.has(lb.name);
    return `<button type="button" class="quick-label-chip ${active ? 'active' : ''}" data-lb="${escapeHtml(lb.name)}" style="--label-color:${lb.color}" aria-pressed="${active}">
      <span class="lb-dot"></span><span class="txt">${escapeHtml(lb.name)}</span>
    </button>`;
  }).join('');
  box.querySelectorAll('.quick-label-chip').forEach(btn => {
    btn.onclick = () => setThreadLabelFilter(btn.dataset.lb, !state.threadFilter.labels.has(btn.dataset.lb));
  });
}

function updateFilterBtnLabel() {
  const f = state.threadFilter;
  const labelMap = { all: 'Tất cả', unread: 'Chưa đọc', user: 'Bạn bè', group: 'Nhóm' };
  $('#filterBtnLabel').textContent = labelMap[f.status] || 'Tất cả';
  const c = f.labels.size;
  const badge = $('#filterBtnCount');
  if (c > 0) { badge.textContent = c; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
  updateFilterCounts();
}

function updateFilterCounts() {
  const all = state.threads.length;
  let unread = 0, user = 0, group = 0;
  for (const t of state.threads) {
    if (t.unread) unread++;
    if (t.type === 0) user++;
    if (t.type === 1) group++;
  }
  const set = (k, n) => {
    const el = document.querySelector(`.filter-cnt[data-cnt="${k}"]`);
    if (el) el.textContent = n;
  };
  set('all', all);
  set('unread', unread);
  set('user', user);
  set('group', group);
}

function initThreadFilter() {
  const btn = $('#filterBtn');
  const pop = $('#filterPopup');
  btn.onclick = (e) => {
    e.stopPropagation();
    pop.classList.toggle('hidden');
  };
  document.addEventListener('click', (e) => {
    if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !btn.contains(e.target)) {
      pop.classList.add('hidden');
    }
  });
  document.querySelectorAll('input[name=thFilterStatus]').forEach(r => {
    r.onchange = () => {
      state.threadFilter.status = r.value;
      updateFilterBtnLabel();
      renderThreads();
    };
  });
  $('#manageLabelsBtn').onclick = () => {
    pop.classList.add('hidden');
    openManageLabels();
  };
  loadLabels();
  updateFilterCounts();
}

// ====== Manage labels modal ======
function openManageLabels() {
  renderLbList();
  $('#lbNewName').value = '';
  $('#lbNewColor').value = '#fbbf24';
  $('#lbAddBtn').onclick = async () => {
    const name = $('#lbNewName').value.trim();
    if (!name) return toast('Nhập tên thẻ', 'err');
    const color = $('#lbNewColor').value;
    const position = (state.labelsCache.slice(-1)[0]?.position || 0) + 1;
    const r = await api('/api/labels', { method: 'POST', body: { name, color, position } });
    if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
    $('#lbNewName').value = '';
    await loadLabels();
    renderLbList();
    toast('Đã thêm', 'ok');
  };
  openModal('modalLabels');
}

function renderLbList() {
  const box = $('#lbList');
  if (!state.labelsCache.length) {
    box.innerHTML = '<div class="hint">Chưa có thẻ. Tạo thẻ trước rồi gắn cho hội thoại (vd: "Khách hàng", "Gia đình", "Team", "Sếp - Nhân sự").</div>';
    return;
  }
  box.innerHTML = state.labelsCache.map(lb => `
    <div class="lb-row-card" data-id="${lb.id}" style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">
      <div class="lb-row" style="margin-bottom:6px">
        <input type="color" value="${lb.color}" data-act="color" />
        <input type="text" value="${escapeHtml(lb.name)}" maxlength="50" data-act="name" placeholder="Tên nhãn" style="flex:1" />
        <button class="btn-icon" data-act="save" title="Lưu tên/màu"><i data-lucide="check"></i></button>
        <button class="btn-icon danger" data-act="del" title="Xoá"><i data-lucide="trash-2"></i></button>
      </div>
      <input type="text" value="${escapeHtml(lb.description || '')}" maxlength="500" data-act="desc"
             placeholder="Mô tả bối cảnh nhãn này (vd: 'Nhóm gia đình - thân mật, xưng anh/em')"
             style="width:100%;font-size:12px" />
    </div>
  `).join('');
  box.querySelectorAll('.lb-row-card').forEach(row => {
    const id = parseInt(row.dataset.id);
    const cur = state.labelsCache.find(x => x.id === id);
    row.querySelector('[data-act="save"]').onclick = async () => {
      const name = row.querySelector('[data-act="name"]').value.trim();
      const color = row.querySelector('[data-act="color"]').value;
      const description = row.querySelector('[data-act="desc"]').value.trim();
      if (!name) return toast('Tên không được rỗng', 'err');
      const r = await api('/api/labels', { method: 'POST', body: { id, name, color, description, position: cur.position } });
      if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
      await loadLabels();
      renderLbList();
      toast('Đã lưu', 'ok');
    };
    row.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm('Xoá thẻ "' + cur.name + '"? (Tất cả hội thoại đang gắn thẻ này sẽ bị bỏ thẻ)')) return;
      const r = await api('/api/labels/' + id, { method: 'DELETE' });
      if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
      for (const t of state.threads) {
        try { const arr = JSON.parse(t.labels || '[]'); const f = arr.filter(x => x !== cur.name); if (f.length !== arr.length) t.labels = JSON.stringify(f); } catch {}
      }
      state.threadFilter.labels.delete(cur.name);
      await loadLabels();
      renderLbList();
      updateFilterBtnLabel();
      toast('Đã xoá', 'ok');
    };
  });
  if (window.lucide) window.lucide.createIcons();
}

function normalizeThreadTime(arr) {
  for (const t of arr) {
    if (t.lastMsgAt && t.lastMsgAt > 1e12) t.lastMsgAt = Math.floor(t.lastMsgAt / 1000);
  }
  return arr;
}

async function loadThreads() {
  if (!state.ownId) return;
  const r = await api(`/api/chat/threads/${state.ownId}?limit=3000`);
  state.threads = normalizeThreadTime(r.data || []);
  updateFilterCounts && updateFilterCounts();
  const needsSync = state.threads.length < 5 || state.threads.some(t => !t.name && t.type === 1);
  if (needsSync) await syncThreadsNow(true);
  renderThreads();
}

async function syncThreadsNow(silent = false) {
  if (!state.ownId) return;
  if (!silent) toast('Đang cập nhật danh sách bạn bè và nhóm...', 'info');
  const r = await api(`/api/chat/sync-threads/${state.ownId}`, { method: 'POST' });
  if (!r.ok) { toast('Cập nhật thất bại: ' + r.error, 'err'); return; }
  const e = await api(`/api/chat/enrich-unknown-threads/${state.ownId}`, { method: 'POST' });
  if (!silent) toast(`Đã cập nhật: ${r.syncedFriends} bạn bè, ${r.syncedGroups} nhóm${e.fixed ? `, bổ sung ${e.fixed} người` : ''}`, 'ok');
  const r2 = await api(`/api/chat/threads/${state.ownId}?limit=3000`);
  state.threads = normalizeThreadTime(r2.data || []);
  renderThreads();
}

function renderThreads() {
  const list = $('#threadList');
  const q = $('#searchInput').value.toLowerCase();
  const filter = state.threadFilter;
  const labelColor = (name) => {
    const lb = state.labelsCache.find(x => x.name === name);
    return lb ? lb.color : '#94a3b8';
  };
  let arr = state.threads.filter(t => {
    if (filter.status === 'unread' && !t.unread) return false;
    if (filter.status === 'user' && t.type !== 0) return false;
    if (filter.status === 'group' && t.type !== 1) return false;
    if (filter.labels && filter.labels.size > 0) {
      let tlabels = [];
      try { tlabels = t.labels ? JSON.parse(t.labels) : []; } catch {}
      const hit = tlabels.some(name => filter.labels.has(name));
      if (!hit) return false;
    }
    if (q && !(t.name || '').toLowerCase().includes(q) && !(t.lastMsg || '').toLowerCase().includes(q)) return false;
    return true;
  });
  if (!arr.length) {
    const hint = (filter.status !== 'all' || filter.labels.size || q)
      ? 'Không khớp filter hiện tại'
      : 'Chưa có hội thoại';
    list.innerHTML = `<div class="empty">${hint}</div>`;
    return;
  }
  list.innerHTML = arr.map(t => {
    let labels = [];
    try { labels = t.labels ? JSON.parse(t.labels) : []; } catch {}
    const isActive = state.currentThread && state.currentThread.id === t.id;
    return `
      <div class="thread-item ${isActive ? 'active' : ''} ${t.pinned ? 'pinned' : ''} ${!t.unread ? 'read' : ''}" data-id="${t.id}" data-type="${t.type}">
        <div class="avatar" style="${t.avatar ? `background-image:url('${t.avatar}')` : ''}">${t.avatar ? '' : escapeHtml(avatarText(t.name))}</div>
        <div class="thread-meta">
          <div class="thread-name">
            <span class="name">${t.pinned ? '<i data-lucide="pin" style="width:12px;height:12px;color:var(--primary);margin-right:3px;vertical-align:middle"></i>' : ''}${escapeHtml(t.name || '—')}</span>
            <span class="time">${t.lastMsgAt ? timeAgo(t.lastMsgAt) : ''}</span>
          </div>
          <div class="thread-last">
            <span class="text">${escapeHtml((t.lastMsg || '').slice(0, 80))}</span>
            ${t.unread > 0 ? `<span class="unread">${t.unread}</span>` : ''}
          </div>
          ${labels.length ? `<div class="thread-labels">${labels.map(l => `<span class="lb"><span class="lb-dot" style="background:${labelColor(l)}"></span>${escapeHtml(l)}</span>`).join('')}</div>` : ''}
        </div>
      </div>`;
  }).join('');
  list.querySelectorAll('.thread-item').forEach(el => {
    el.onclick = () => openThread(el.dataset.id, parseInt(el.dataset.type));
    el.oncontextmenu = (e) => { e.preventDefault(); openThreadContextMenu(e, el.dataset.id, parseInt(el.dataset.type)); };
  });
  if (window.lucide) window.lucide.createIcons();
}

function openThreadContextMenu(evt, threadId, threadType) {
  closeMsgContextMenu();
  const t = state.threads.find(x => x.id === threadId);
  if (!t) return;
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = CTX_MENU_ID;
  const items = [
    { act: 'pin', icon: 'pin', label: t.pinned ? 'Bỏ ghim hội thoại' : 'Ghim hội thoại' },
    { act: 'unread', icon: t.unread ? 'mail-open' : 'mail', label: t.unread ? 'Đánh dấu đã đọc' : 'Đánh dấu chưa đọc' },
    { act: 'labels', icon: 'tag', label: 'Gắn nhãn' },
    { act: 'remove', icon: 'trash-2', label: 'Xoá khỏi danh sách', danger: true },
  ];
  menu.innerHTML = items.map(it => `<div class="ctx-item${it.danger ? ' danger' : ''}" data-act="${it.act}"><i data-lucide="${it.icon}"></i>${it.label}</div>`).join('');
  document.body.appendChild(menu);
  if (window.lucide) window.lucide.createIcons();
  const rect = menu.getBoundingClientRect();
  let x = evt.clientX, y = evt.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.querySelectorAll('.ctx-item').forEach(el => {
    el.onclick = async () => {
      const act = el.dataset.act;
      closeMsgContextMenu();
      if (act === 'pin') {
        const newPinned = !t.pinned;
        const r = await api('/api/chat/thread-pin', { method: 'POST', body: { ownId: state.ownId, threadId, threadType, pinned: newPinned } });
        if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
        t.pinned = newPinned ? 1 : 0;
        state.threads.sort((a, b) => (b.pinned || 0) - (a.pinned || 0) || (b.lastMsgAt || 0) - (a.lastMsgAt || 0));
        renderThreads();
        toast(newPinned ? 'Đã ghim' : 'Đã bỏ ghim', 'ok');
      } else if (act === 'unread') {
        const newUnread = !t.unread;
        const r = await api('/api/chat/thread-unread', { method: 'POST', body: { ownId: state.ownId, threadId, threadType, unread: newUnread } });
        if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
        t.unread = newUnread ? 1 : 0;
        renderThreads();
        toast(newUnread ? 'Đã đánh dấu chưa đọc' : 'Đã đánh dấu đã đọc', 'ok');
      } else if (act === 'labels') {
        openLabelPickerForThread(t, evt);
        return;
      } else if (act === 'remove') {
        if (!confirm('Xoá "' + (t.name || 'hội thoại') + '" khỏi danh sách?\n(Tin nhắn cũ cũng sẽ xoá khỏi cache local. Nhóm/bạn trên Zalo không bị ảnh hưởng.)')) return;
        const r = await api('/api/chat/thread-remove', { method: 'POST', body: { ownId: state.ownId, threadId } });
        if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
        state.threads = state.threads.filter(x => x.id !== threadId);
        if (state.currentThread && state.currentThread.id === threadId) {
          state.currentThread = null;
          state.messages = [];
          renderMessages();
        }
        renderThreads();
        toast('Đã xoá khỏi danh sách', 'ok');
      }
    };
  });
  setTimeout(() => document.addEventListener('click', closeMsgContextMenu, { once: true }), 0);
}

function openLabelPickerForThread(t, evt) {
  closeMsgContextMenu();
  if (!state.labelsCache.length) {
    toast('Chưa có nhãn nào. Mở "Phân loại" → "Quản lý nhãn" để tạo.', 'info');
    return;
  }
  let existing = [];
  try { existing = t.labels ? JSON.parse(t.labels) : []; } catch {}
  const menu = document.createElement('div');
  menu.className = 'ctx-menu label-picker';
  menu.id = CTX_MENU_ID;
  menu.innerHTML = `
    <div style="font-size:11px;font-weight:600;padding:6px 10px;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.06em">Gắn thẻ cho hội thoại</div>
    <div class="label-picker-list">
      ${state.labelsCache.map(lb => `
        <label class="filter-check" data-lb="${escapeHtml(lb.name)}">
          <input type="checkbox" ${existing.includes(lb.name) ? 'checked' : ''} />
          <span class="lb-dot" style="background:${lb.color}"></span>
          <span>${escapeHtml(lb.name)}</span>
        </label>
      `).join('')}
    </div>
  `;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  let x = evt.clientX, y = evt.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.onchange = async (e) => {
      e.stopPropagation();
      const name = cb.closest('label').dataset.lb;
      let arr = [];
      try { arr = t.labels ? JSON.parse(t.labels) : []; } catch {}
      const idx = arr.indexOf(name);
      if (cb.checked && idx < 0) arr.push(name);
      if (!cb.checked && idx >= 0) arr.splice(idx, 1);
      t.labels = JSON.stringify(arr);
      const r = await api(`/api/chat/labels/${state.ownId}/${t.id}`, { method: 'POST', body: { labels: arr } });
      if (!r.ok) { toast('Lỗi: ' + r.error, 'err'); cb.checked = !cb.checked; return; }
      renderThreads();
      // Also re-render labels in right panel if open for this thread
      if (state.currentThread && state.currentThread.id === t.id) {
        state.currentThread.labels = t.labels;
        if (typeof renderLabels === 'function') renderLabels();
      }
    };
  });
  // Prevent menu close on click inside
  menu.onclick = (e) => e.stopPropagation();
  setTimeout(() => document.addEventListener('click', closeMsgContextMenu, { once: true }), 0);
}

async function openThread(threadId, threadType) {
  const t = state.threads.find(x => x.id === threadId);
  if (!t) return;
  state.currentThread = t;
  renderThreads();
  await api(`/api/chat/mark-read/${state.ownId}/${threadId}`, { method: 'POST' });
  t.unread = 0;
  $('#chatPlaceholder').classList.add('hidden');
  $('#chatHeader').classList.remove('hidden');
  $('#chatFooter').classList.remove('hidden');
  $('#messages').classList.remove('hidden');
  $('#chHeadName').textContent = t.name || 'Hội thoại';
  $('#chHeadSub').textContent = threadType === 1 ? 'Nhóm' : 'Cá nhân';
  $('#chHeadAvatar').textContent = avatarText(t.name);
  $('#chHeadAvatar').style.backgroundImage = t.avatar ? `url('${t.avatar}')` : '';
  $('#rpAvatar').textContent = avatarText(t.name);
  $('#rpAvatar').style.backgroundImage = t.avatar ? `url('${t.avatar}')` : '';
  $('#rpName').textContent = t.name || '—';
  $('#rpId').textContent = t.id;
  renderLabels();
  loadAutoReplyPanel();
  // Reload AI panel cho thread mới (nếu panel đang mở)
  if (document.body.classList.contains('ai-open')) {
    refreshAiContext();
    renderAiLog();
  }
  await loadMessages();
  if (state.messages.length === 0 && threadType === 1) {
    await syncHistoryFromZalo(true);
  }
}

async function syncHistoryFromZalo(silent = false) {
  if (!state.currentThread) return;
  const tid = state.currentThread.id;
  const ttype = state.currentThread.type;
  if (!silent) toast('Đang tải lịch sử từ Zalo...', 'info');
  const r = await api(`/api/chat/sync-history/${state.ownId}/${tid}?threadType=${ttype}&count=500`, { method: 'POST' });
  if (!r.ok) {
    if (r.kind === 'user-chat') {
      if (!silent) toast(r.error, 'info');
    } else if (!silent) {
      toast('Lỗi: ' + r.error, 'err');
    }
    return r;
  }
  if (!silent) {
    if (r.inserted > 0) {
      toast(`Đã tải thêm ${r.inserted} tin từ Zalo (tổng ${r.total} tin gần nhất)`, 'ok');
    } else {
      toast(`Zalo chỉ trả ${r.total} tin gần nhất, không có tin cũ hơn để load`, 'info');
    }
  }
  await loadMessages(true);
  return r;
}

async function loadMessages(reset = true) {
  if (!state.currentThread) return;
  if (state.msgLoading) return;
  state.msgLoading = true;
  if (reset) { state.msgOffset = 0; state.msgHasMore = true; state.messages = []; }
  if (!state.msgHasMore) { state.msgLoading = false; return; }
  const r = await api(`/api/chat/messages/${state.ownId}/${state.currentThread.id}?limit=${PAGE_SIZE}&offset=${state.msgOffset}`);
  const batch = r.data || [];
  if (batch.length < PAGE_SIZE) state.msgHasMore = false;
  if (reset) {
    state.messages = batch;
    renderMessages(true);
  } else {
    const box = $('#messages');
    const prevHeight = box.scrollHeight;
    const prevScroll = box.scrollTop;
    state.messages = batch.concat(state.messages);
    renderMessages(false);
    box.scrollTop = box.scrollHeight - prevHeight + prevScroll;
  }
  state.msgOffset += batch.length;
  state.msgLoading = false;
}

function fmtDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  const mm = Math.floor(s / 60), ss = s % 60;
  return mm + ':' + String(ss).padStart(2, '0');
}
function fmtBytes(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

const VN_PHONE_RE = /(?:\+?84|0)(?:[\s.\-]?\d){8,10}/g;

function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length >= 10) return '0' + digits.slice(2);
  return digits;
}

function extractPhones(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  let m;
  VN_PHONE_RE.lastIndex = 0;
  while ((m = VN_PHONE_RE.exec(text)) !== null) {
    const norm = normalizePhone(m[0]);
    if (norm.length < 9 || norm.length > 11) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({ raw: m[0], norm, pos: m.index, len: m[0].length });
  }
  return out;
}

function highlightSpans(text, spans) {
  if (!spans.length) return escapeHtml(text);
  const sorted = spans.slice().sort((a, b) => a.pos - b.pos);
  let out = '';
  let cursor = 0;
  for (const sp of sorted) {
    if (sp.pos < cursor || sp.pos > text.length) continue;
    out += escapeHtml(text.slice(cursor, sp.pos));
    out += sp.html(text.slice(sp.pos, sp.pos + sp.len));
    cursor = sp.pos + sp.len;
  }
  out += escapeHtml(text.slice(cursor));
  return out;
}

function renderTextWithMentions(text, mentions) {
  const spans = [];
  if (mentions && mentions.length) {
    for (const mn of mentions) spans.push({ pos: mn.pos, len: mn.len, html: (raw) => `<span class="mention-tag">${escapeHtml(raw)}</span>` });
  }
  for (const ph of extractPhones(text)) {
    spans.push({ pos: ph.pos, len: ph.len, html: (raw) => `<a class="phone-link" data-phone="${ph.norm}">${escapeHtml(raw)}</a>` });
  }
  return highlightSpans(text, spans);
}

function renderMsgContent(m) {
  let c = null;
  if (typeof m.content === 'string') {
    const s = m.content.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try { c = JSON.parse(s); } catch {}
    }
    if (!c) return renderTextWithMentions(m.content || '', m.mentions);
  } else if (typeof m.content === 'object') {
    c = m.content;
  }
  if (!c || typeof c !== 'object') return escapeHtml(String(m.content || ''));

  let params = c.params;
  if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }

  const action = c.action || '';
  const isCall = action.includes('calltime') || action.includes('calldate') || /Cuộc\s*gọi/i.test(c.description || '');
  const isContact = !isCall && (action.includes('contact') || (action.includes('recommen') && !action.includes('calltime') && (c.uid || c.userId || c.phoneNumber)));
  const isImg = !isCall && c.href && /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(c.href);
  const isVideo = !isCall && params && (params.video_width || params.video_height);
  const isFile = c.fileName && c.fileSize !== undefined;
  const isSticker = c.catId !== undefined && (c.stickerId !== undefined || c.id !== undefined);
  const isLink = !isCall && !isImg && !isVideo && !isFile && !isSticker && (c.title || c.description) && c.href;
  const isVoice = c.fileExt === 'm4a' || c.fileExt === 'mp3' || (c.href && /\.(m4a|mp3|aac)(\?|$)/i.test(c.href));

  if (isCall) {
    const dur = params?.duration ? `${params.duration}s` : '';
    const isVid = params?.calltype === 1;
    const incoming = params?.isCaller === 0;
    return `<div style="display:inline-flex;align-items:center;gap:8px">
      <span style="font-size:18px">${isVid ? '📹' : '📞'}</span>
      <div>
        <div style="font-weight:500">${isVid ? 'Cuộc gọi video' : 'Cuộc gọi thoại'}${incoming ? ' đến' : ' đi'}</div>
        ${dur ? `<div style="font-size:11px;color:var(--muted-foreground)">Thời lượng ${dur}</div>` : ''}
      </div>
    </div>`;
  }
  if (isContact) {
    return `<div style="display:inline-flex;align-items:center;gap:8px">
      <span style="font-size:18px">👤</span>
      <div>
        <div style="font-weight:500">Danh thiếp</div>
        <div style="font-size:11px;color:var(--muted-foreground)">${escapeHtml(c.fullName || c.zaloName || c.phoneNumber || '')}</div>
      </div>
    </div>`;
  }
  if (isSticker) {
    const url = c.url || c.staticUrl || c.image || '';
    return url ? `<img src="${escapeHtml(url)}" style="max-width:120px;max-height:120px" alt="sticker" />` : `🎯 <i>Sticker</i>`;
  }
  if (isImg) {
    return `<a href="${escapeHtml(c.href)}" target="_blank"><img src="${escapeHtml(c.thumb || c.href)}" style="max-width:240px;max-height:300px;border-radius:8px;display:block" alt="image" /></a>`;
  }
  if (isVideo) {
    const dur = params?.duration ? fmtDuration(params.duration) : '';
    const size = params?.fileSize ? fmtBytes(params.fileSize) : '';
    const thumb = c.thumb || '';
    const href = c.href || '#';
    return `<a href="${escapeHtml(href)}" target="_blank" style="display:block;position:relative;text-decoration:none;color:inherit">
      ${thumb ? `<img src="${escapeHtml(thumb)}" style="max-width:260px;max-height:300px;border-radius:8px;display:block" alt="video" />` : ''}
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none">
        <div style="background:rgba(0,0,0,.55);color:#fff;border-radius:50%;width:48px;height:48px;display:flex;align-items:center;justify-content:center;font-size:20px">▶</div>
      </div>
      <div style="margin-top:4px;font-size:12px;color:var(--muted-foreground)">🎬 Video${dur ? ' · ' + dur : ''}${size ? ' · ' + size : ''}</div>
    </a>`;
  }
  if (isVoice) {
    const dur = params?.duration ? fmtDuration(params.duration) : '';
    return `<a href="${escapeHtml(c.href)}" target="_blank" style="display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:inherit">
      🎤 <span>Voice ${dur}</span>
    </a>`;
  }
  if (isFile) {
    return `📎 <a href="${escapeHtml(c.href || '#')}" target="_blank" style="color:var(--primary);text-decoration:none">${escapeHtml(c.fileName)}</a>
      <div style="font-size:11px;color:var(--muted-foreground);margin-top:2px">${fmtBytes(c.fileSize)}</div>`;
  }
  if (isLink) {
    const thumb = c.thumb ? `<img src="${escapeHtml(c.thumb)}" style="max-width:80px;max-height:80px;border-radius:6px;float:left;margin-right:8px" alt="" />` : '';
    return `<a href="${escapeHtml(c.href)}" target="_blank" style="display:block;text-decoration:none;color:inherit">
      ${thumb}
      <div style="font-weight:600;font-size:13px">${escapeHtml(c.title || '')}</div>
      ${c.description ? `<div style="font-size:12px;color:var(--muted-foreground);margin-top:2px">${escapeHtml(c.description)}</div>` : ''}
      <div style="font-size:11px;color:var(--primary);margin-top:4px;clear:both">${escapeHtml(c.href)}</div>
    </a>`;
  }
  if (c.title) return escapeHtml(c.title);
  return escapeHtml(typeof m.content === 'string' ? m.content : JSON.stringify(c));
}

function renderMessages(scrollToBottom = true) {
  const box = $('#messages');
  const isGroup = state.currentThread?.type === 1;
  if (!state.messages.length) {
    if (isGroup) {
      box.innerHTML = `<div class="empty">
        <div style="margin-bottom:10px">Chưa có tin nhắn lưu sẵn. Bấm để tải lịch sử nhóm từ Zalo.</div>
        <button class="btn-primary" onclick="syncHistoryFromZalo()">⬇ Tải lịch sử nhóm (tối đa 500 tin gần nhất)</button>
      </div>`;
    } else {
      box.innerHTML = `<div class="empty">
        <div>Zalo không cho phép lấy lịch sử chat 1-1 qua API.</div>
        <div style="margin-top:6px;font-size:11.5px">Hệ thống chỉ lưu tin nhắn mới từ lúc bạn đăng nhập trở đi. Tin cũ chỉ xem được trên ứng dụng Zalo điện thoại.</div>
      </div>`;
    }
    return;
  }
  const loadMore = isGroup ? `<div class="load-more" id="loadMoreBtn" title="Zalo API chỉ trả các tin gần nhất, không cho phép phân trang sâu hơn">⤴ Tải lịch sử Zalo (tối đa ~500 tin gần nhất)</div>` : (state.msgHasMore ? '<div class="load-more" id="loadMoreBtn">⤴ Tải thêm tin cũ (local)</div>' : '');
  box.innerHTML = loadMore + state.messages.map((m, idx) => {
    const self = m.isSelf;
    const quote = m.quote || null;
    const quoteHtml = quote ? `<div class="msg-quote" data-quote-msgid="${escapeHtml(String(quote.msgId || ''))}">
        <div class="qnm">${escapeHtml(quote.fromName || quote.fromUid || '—')}</div>
        <div class="qmsg">${escapeHtml(typeof quote.content === 'string' ? quote.content : (quote.content?.msg || '[đính kèm]'))}</div>
      </div>` : '';
    const isRecalled = !!m.recalled;
    const bubble = isRecalled ? '<div class="msg-bubble recalled">Tin nhắn đã được thu hồi</div>' : `<div class="msg-bubble">${quoteHtml}${renderMsgContent(m)}</div>`;
    const reactions = m.reactions && Object.keys(m.reactions).length
      ? `<div class="msg-reactions">${Object.entries(m.reactions).map(([em, ct]) => `<span class="pill">${em}<span class="ct">${ct}</span></span>`).join('')}</div>`
      : '';
    const phoneList = !isRecalled && typeof m.content === 'string' ? extractPhones(m.content) : [];
    const phoneCards = phoneList.map(p => `<div class="phone-card" data-phone="${p.norm}" data-idx="${idx}"><div class="pc-head"><div class="avatar">📞</div><div class="info"><div class="nm">Đang tra cứu...</div><div class="ph">${escapeHtml(p.raw)}</div></div></div></div>`).join('');
    return `
      <div class="msg-row ${self ? 'self' : ''}" data-idx="${idx}">
        <div class="msg-content">
          ${!self && state.currentThread.type === 1 && m.fromName ? `<div class="msg-from">${escapeHtml(m.fromName)}</div>` : ''}
          <div class="bubble-wrap">
            ${bubble}
            ${!isRecalled ? `<button class="react-btn" data-act="react-open" title="Thả cảm xúc">👍</button>` : ''}
            ${!isRecalled ? `<div class="msg-actions">
              <button data-act="reply" title="Trả lời"><i data-lucide="reply"></i></button>
              <button data-act="forward" title="Chuyển tiếp"><i data-lucide="forward"></i></button>
              <button data-act="more" title="Thêm"><i data-lucide="more-horizontal"></i></button>
            </div>` : ''}
          </div>
          ${reactions}
          ${phoneCards}
          <div class="msg-time">${new Date(m.ts).toLocaleString('vi-VN')}</div>
        </div>
      </div>`;
  }).join('');
  box.querySelectorAll('.msg-row').forEach(row => {
    row.querySelectorAll('.msg-actions button').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const idx = +row.dataset.idx;
        const m = state.messages[idx];
        if (!m) return;
        if (b.dataset.act === 'reply') startReply(m);
        else if (b.dataset.act === 'forward') openForwardModal(m);
        else if (b.dataset.act === 'more') openMsgContextMenu(e, m, idx);
      };
    });
    const reactBtn = row.querySelector('.react-btn');
    if (reactBtn) {
      reactBtn.onclick = (e) => {
        e.stopPropagation();
        const idx = +row.dataset.idx;
        const m = state.messages[idx];
        if (!m) return;
        openReactionPicker(row, m, idx);
      };
    }
  });
  // Phone links → click to copy
  box.querySelectorAll('.phone-link').forEach(a => {
    a.onclick = async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(a.dataset.phone); toast('Đã sao chép số điện thoại', 'ok'); } catch {}
    };
  });
  // Phone cards → lookup async
  box.querySelectorAll('.phone-card[data-phone]').forEach(card => hydratePhoneCard(card));
  const lm = $('#loadMoreBtn');
  if (lm) lm.onclick = () => {
    if (isGroup) syncHistoryFromZalo();
    else loadMessages(false);
  };
  if (scrollToBottom) box.scrollTop = box.scrollHeight;
  if (window.lucide) window.lucide.createIcons();
}

state.phoneCache = state.phoneCache || {};

async function hydratePhoneCard(card) {
  const phone = card.dataset.phone;
  if (!phone || !state.ownId) return;
  let info = state.phoneCache[phone];
  if (info === undefined) {
    state.phoneCache[phone] = null; // mark in-flight
    try {
      const r = await api('/api/chat/lookup-phone', { method: 'POST', body: { ownId: state.ownId, phone } });
      info = r.ok ? r.data : null;
      state.phoneCache[phone] = info;
    } catch { info = null; state.phoneCache[phone] = null; }
  }
  if (info === null && state.phoneCache[phone] !== null) {
    info = state.phoneCache[phone];
  }
  paintPhoneCard(card, phone, info);
}

function paintPhoneCard(card, phone, info) {
  const pretty = phone.replace(/^(\d{3})(\d{3})(\d{3,4})$/, '$1 $2 $3');
  if (!info) {
    card.innerHTML = `
      <div class="pc-head">
        <div class="avatar">📞</div>
        <div class="info"><div class="nm" style="color:var(--muted-foreground)">Không tìm thấy Zalo</div><div class="ph">${escapeHtml(pretty)}</div></div>
      </div>
      <button class="pc-copy" data-act="copy">Sao chép số điện thoại</button>`;
  } else {
    const av = info.avatar ? `style="background-image:url('${info.avatar}')"` : '';
    const initial = info.name ? avatarText(info.name) : phone.slice(-2);
    card.innerHTML = `
      <div class="pc-head">
        <div class="avatar" ${av}>${info.avatar ? '' : escapeHtml(initial)}</div>
        <div class="info"><div class="nm">${escapeHtml(info.name || 'User ' + info.userId.slice(-6))}</div><div class="ph">${escapeHtml(pretty)}</div></div>
      </div>
      <div class="pc-actions">
        <button data-act="add" data-uid="${info.userId}">Kết bạn</button>
        <button data-act="chat" class="primary" data-uid="${info.userId}">Nhắn tin</button>
      </div>
      <button class="pc-copy" data-act="copy">Sao chép số điện thoại</button>`;
  }
  card.querySelectorAll('button').forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'copy') {
        try { await navigator.clipboard.writeText(phone); toast('Đã sao chép', 'ok'); } catch {}
      } else if (act === 'add' && b.dataset.uid) {
        const greeting = prompt('Lời chào kèm theo lời mời kết bạn:', 'Xin chào, mình muốn kết bạn ạ') || '';
        if (greeting === null) return;
        const r = await api('/api/chat/bulk-action', { method: 'POST', body: { ownId: state.ownId, action: 'friend-phone', targets: [phone], params: { greeting, delay: 1000 } } });
        toast(r.ok ? 'Đã gửi lời mời kết bạn' : ('Lỗi: ' + r.error), r.ok ? 'ok' : 'err');
      } else if (act === 'chat' && b.dataset.uid) {
        const uid = b.dataset.uid;
        // try to open existing thread or create new currentThread context
        const existing = state.threads.find(t => t.id === uid);
        if (existing) {
          openThread(uid, 0);
        } else {
          state.currentThread = { id: uid, type: 0, name: 'Chat với ' + uid.slice(-6) };
          state.messages = [];
          $('#chatPlaceholder').classList.add('hidden');
          $('#chatHeader').classList.remove('hidden');
          $('#chatFooter').classList.remove('hidden');
          $('#messages').classList.remove('hidden');
          $('#chHeadName').textContent = state.currentThread.name;
          $('#chHeadSub').textContent = 'Cá nhân';
          $('#chHeadAvatar').textContent = avatarText(state.currentThread.name);
          renderMessages(true);
          $('#msgInput').focus();
        }
      }
    };
  });
}

function renderLabels() {
  const t = state.currentThread;
  let labels = [];
  try { labels = t && t.labels ? JSON.parse(t.labels) : []; } catch {}
  const colorOf = (name) => (state.labelsCache.find(x => x.name === name) || {}).color || '#94a3b8';
  $('#rpLabels').innerHTML = labels.length
    ? labels.map((l, i) => `<span class="label-chip"><span class="lb-dot" style="background:${colorOf(l)}"></span>${escapeHtml(l)} <span class="x" data-i="${i}">×</span></span>`).join('')
    : '<div class="status-line">Chưa gắn thẻ. Bấm "Sửa nhãn" hoặc chuột phải hội thoại bên trái.</div>';
  $('#rpLabels').querySelectorAll('.x').forEach(x => {
    x.onclick = async () => {
      const i = parseInt(x.dataset.i);
      labels.splice(i, 1);
      t.labels = JSON.stringify(labels);
      await api(`/api/chat/labels/${state.ownId}/${t.id}`, { method: 'POST', body: { labels } });
      renderLabels();
      renderThreads();
    };
  });
}

// ===== Auto-reply per thread =====
let autoReplyCurrent = null;

async function loadAutoReplyPanel() {
  const t = state.currentThread;
  const recentEl = $('#rpAutoReplyRecent');
  if (!t || !state.ownId) {
    $('#rpAutoReplyStatus').textContent = 'Mở 1 hội thoại trước';
    $('#rpAutoReplyEnabled').checked = false;
    $('#rpAutoReplyInfo').textContent = '';
    if (recentEl) recentEl.hidden = true;
    return;
  }
  const r = await api(`/api/auto-reply/thread/${state.ownId}/${encodeURIComponent(t.id)}`);
  autoReplyCurrent = r.data || null;
  const enabled = !!(autoReplyCurrent && autoReplyCurrent.enabled);
  $('#rpAutoReplyEnabled').checked = enabled;
  if (autoReplyCurrent && enabled) {
    const modeLabel = { ai: 'AI tạo', static: 'Câu cố định', keyword: 'Theo từ khoá' }[autoReplyCurrent.mode] || autoReplyCurrent.mode;
    const log = await api(`/api/auto-reply/log/${state.ownId}/${encodeURIComponent(t.id)}`);
    const logs = log.data || [];
    const today = logs.filter(l => (Date.now() / 1000 - l.ts) < 86400).length;
    $('#rpAutoReplyStatus').textContent = `${modeLabel} · ${today} reply / 24h`;
    $('#rpAutoReplyInfo').textContent = '';
    const logBox = $('#rpAutoReplyLog');
    if (recentEl) recentEl.hidden = logs.length === 0;
    if (logBox && logs.length) {
      logBox.innerHTML = logs.slice(0, 10).map(l => `
        <div class="ar-recent-item">
          <div class="ts">${timeAgo(l.ts)} · ${l.mode}</div>
          <div class="content">${escapeHtml((l.reply_content || '').slice(0, 200))}</div>
        </div>
      `).join('');
    } else if (logBox) {
      logBox.innerHTML = '';
    }
  } else {
    $('#rpAutoReplyStatus').textContent = 'Đang tắt';
    $('#rpAutoReplyInfo').textContent = '';
    const logBox = $('#rpAutoReplyLog');
    if (logBox) logBox.innerHTML = '';
    if (recentEl) recentEl.hidden = true;
  }
}

async function quickToggleAutoReply(enabled) {
  const t = state.currentThread;
  if (!t || !state.ownId) {
    $('#rpAutoReplyEnabled').checked = false;
    return toast('Mở 1 hội thoại trước', 'err');
  }
  // Nếu bật mới mà chưa có cài đặt → dùng default AI
  const base = autoReplyCurrent || autoReplyDefaults || AR_DEFAULTS_FALLBACK;
  const allowedUsers = parseAllowedUsersValue(base.allowed_users);
  const replyAllInGroup = !!base.reply_all_in_group;
  const enforceMentionForNewGroup = enabled && t.type === 1
    && !replyAllInGroup && !base.only_when_mentioned && !(Array.isArray(allowedUsers) && allowedUsers.length);
  const body = {
    ownId: state.ownId, threadId: t.id, threadType: t.type,
    enabled,
    mode: base.mode || 'ai',
    static_reply: base.static_reply || '',
    delay_min_sec: base.delay_min_sec ?? 15,
    delay_max_sec: base.delay_max_sec ?? 35,
    max_per_hour: base.max_per_hour || 6,
    work_start: base.work_start || '00:00',
    work_end: base.work_end || '23:59',
    only_first_msg: !!base.only_first_msg,
    first_n_msgs: base.first_n_msgs ?? (base.only_first_msg ? 1 : 0),
    manual_cooldown_min: base.manual_cooldown_min || 10,
    allowed_users: replyAllInGroup ? null : (allowedUsers.length ? allowedUsers : null),
    only_when_mentioned: replyAllInGroup ? false : (!!base.only_when_mentioned || enforceMentionForNewGroup),
    reply_all_in_group: t.type === 1 ? replyAllInGroup : false,
  };
  const r = await api('/api/auto-reply/thread', { method: 'POST', body });
  if (!r.ok) { $('#rpAutoReplyEnabled').checked = !enabled; return toast('Lỗi: ' + r.error, 'err'); }
  toast(enabled
    ? (replyAllInGroup && t.type === 1 ? 'Đã bật cho nhóm: reply toàn bộ tin nhắn' : (enforceMentionForNewGroup ? 'Đã bật cho nhóm ở chế độ an toàn: chỉ reply khi @mention' : 'Đã bật tự động trả lời'))
    : 'Đã tắt tự động trả lời', 'ok');
  loadAutoReplyPanel();
}

// ===== Auto-reply management page =====
// Cache defaults global cho client — dùng làm fallback khi mở modal hội thoại mới
let autoReplyDefaults = null;
let arMgmtList = [];
const arMgmtSelected = new Set();
const AR_DEFAULTS_FALLBACK = {
  mode: 'ai', static_reply: '',
  delay_min_sec: 15, delay_max_sec: 35,
  max_per_hour: 6,
  work_start: '00:00', work_end: '23:59',
  manual_cooldown_min: 10, first_n_msgs: 3, only_first_msg: 0,
  allowed_users: null, only_when_mentioned: 1,
  reply_all_in_group: 0,
};

function parseAllowedUsersValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).map(s => s.trim()).filter(Boolean);
    } catch {}
    return value.split('\n').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function bindGroupReplyControls(replyAllSel, mentionSel, allowedSel) {
  const replyAll = $(replyAllSel);
  const mention = $(mentionSel);
  const allowed = $(allowedSel);
  if (!replyAll || !mention || !allowed) return;
  const apply = () => {
    if (replyAll.checked) {
      mention.checked = false;
      allowed.value = '';
    }
    mention.disabled = replyAll.checked;
    allowed.disabled = replyAll.checked;
    allowed.style.opacity = replyAll.checked ? '0.55' : '';
  };
  replyAll.onchange = apply;
  mention.onchange = () => {
    if (mention.checked) replyAll.checked = false;
    apply();
  };
  allowed.oninput = () => {
    if (allowed.value.trim()) replyAll.checked = false;
    apply();
  };
  apply();
}

async function loadAutoReplyDefaults() {
  const r = await api('/api/auto-reply/defaults');
  autoReplyDefaults = (r.ok && r.data) ? r.data : { ...AR_DEFAULTS_FALLBACK };
  return autoReplyDefaults;
}

function fillDefaultsForm(d) {
  document.querySelectorAll('input[name=arDefMode]').forEach(r => { r.checked = r.value === d.mode; });
  $('#arDefStaticBox').classList.toggle('hidden', d.mode !== 'static');
  $('#arDefStaticReply').value = d.static_reply || '';
  $('#arDefDelayMin').value = d.delay_min_sec ?? 15;
  $('#arDefDelayMax').value = d.delay_max_sec ?? 35;
  $('#arDefMaxPerHour').value = d.max_per_hour ?? 6;
  $('#arDefWorkStart').value = d.work_start || '00:00';
  $('#arDefWorkEnd').value = d.work_end || '23:59';
  $('#arDefCooldown').value = d.manual_cooldown_min ?? 10;
  // Backward compat: only_first_msg=1 → hiển thị 1; first_n_msgs ưu tiên
  $('#arDefFirstN').value = d.first_n_msgs ?? (d.only_first_msg ? 1 : 3);
  $('#arDefReplyAllGroup').checked = !!d.reply_all_in_group;
  $('#arDefOnlyMention').checked = !!d.only_when_mentioned;
  $('#arDefAllowedUsers').value = parseAllowedUsersValue(d.allowed_users).join('\n');
  bindGroupReplyControls('#arDefReplyAllGroup', '#arDefOnlyMention', '#arDefAllowedUsers');
}

async function saveAutoReplyDefaults() {
  const saveBtn = $('#arDefSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  const mode = document.querySelector('input[name=arDefMode]:checked')?.value || 'ai';
  const allowedUsers = parseAllowedUsersValue($('#arDefAllowedUsers').value);
  const replyAllInGroup = $('#arDefReplyAllGroup').checked;
  const body = {
    mode,
    static_reply: $('#arDefStaticReply').value.trim(),
    delay_min_sec: parseInt($('#arDefDelayMin').value) || 0,
    delay_max_sec: parseInt($('#arDefDelayMax').value) || 0,
    max_per_hour: parseInt($('#arDefMaxPerHour').value) || 6,
    work_start: $('#arDefWorkStart').value || '00:00',
    work_end: $('#arDefWorkEnd').value || '23:59',
    manual_cooldown_min: parseInt($('#arDefCooldown').value) || 0,
    first_n_msgs: parseInt($('#arDefFirstN').value) || 0,
    allowed_users: replyAllInGroup ? null : (allowedUsers.length ? allowedUsers : null),
    only_when_mentioned: replyAllInGroup ? false : $('#arDefOnlyMention').checked,
    reply_all_in_group: replyAllInGroup,
  };
  try {
    const r = await api('/api/auto-reply/defaults', { method: 'POST', body });
    if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
    autoReplyDefaults = r.data;
    $('#arDefaultsStatus').textContent = '✓ Đã lưu cấu hình chung';
    toast('Đã lưu cấu hình mặc định', 'ok');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function bindAutoReplyDefaultActions() {
  const saveBtn = $('#arDefSaveBtn');
  const resetBtn = $('#arDefResetBtn');
  if (saveBtn) saveBtn.onclick = saveAutoReplyDefaults;
  if (resetBtn) {
    resetBtn.onclick = () => {
      if (!confirm('Khôi phục cấu hình mặc định gốc?')) return;
      fillDefaultsForm({ ...AR_DEFAULTS_FALLBACK });
      saveAutoReplyDefaults();
    };
  }
}

async function loadStrangerEnableToggle() {
  const r = await api('/api/auto-reply/stranger-enable');
  if (r.ok) $('#arDefStranger').checked = !!r.data?.enabled;
}
async function saveStrangerEnableToggle(enabled) {
  const r = await api('/api/auto-reply/stranger-enable', { method: 'POST', body: { enabled } });
  if (!r.ok) toast('Lỗi lưu: ' + r.error, 'err');
  else toast(enabled ? 'Đã bật tự động cho khách lạ' : 'Đã tắt tự động cho khách lạ', 'ok');
}

// ═══ Bộ lọc nhãn cho AI ═══
const arLabelFilterState = { requireLabels: [], strangerAutoLabel: '' };

async function loadArLabelFilter() {
  // Đảm bảo state.labelsCache đã có (loadLabels chạy khi vào trang)
  if (!state.labelsCache?.length) await loadLabels();
  const r = await api('/api/auto-reply/label-filter');
  if (r.ok && r.data) {
    arLabelFilterState.requireLabels = Array.isArray(r.data.requireLabels) ? r.data.requireLabels : [];
    arLabelFilterState.strangerAutoLabel = r.data.strangerAutoLabel || '';
  }
  renderArLabelFilter();
}

function renderArLabelFilter() {
  const box = $('#arRequireLabelsBox');
  const labels = state.labelsCache || [];
  if (!labels.length) {
    box.innerHTML = '<div class="hint" style="padding:6px">Chưa có nhãn nào. Tạo nhãn ở trang Chat trước khi cấu hình.</div>';
  } else {
    box.innerHTML = labels.map(lb => {
      const active = arLabelFilterState.requireLabels.includes(lb.name);
      return `<button class="ar-label-chip ${active ? 'active' : ''}" data-label="${escapeHtml(lb.name)}">
        <span class="ar-label-dot" style="background:${lb.color}"></span>${escapeHtml(lb.name)}
      </button>`;
    }).join('');
    box.querySelectorAll('.ar-label-chip').forEach(b => {
      b.onclick = () => {
        const name = b.dataset.label;
        const idx = arLabelFilterState.requireLabels.indexOf(name);
        if (idx >= 0) arLabelFilterState.requireLabels.splice(idx, 1);
        else arLabelFilterState.requireLabels.push(name);
        b.classList.toggle('active');
      };
    });
  }
  const sel = $('#arStrangerLabelSelect');
  sel.innerHTML = '<option value="">— Không gán nhãn —</option>' + labels.map(lb =>
    `<option value="${escapeHtml(lb.name)}" ${arLabelFilterState.strangerAutoLabel === lb.name ? 'selected' : ''}>${escapeHtml(lb.name)}</option>`
  ).join('');
  sel.onchange = () => { arLabelFilterState.strangerAutoLabel = sel.value; };
}

async function saveArLabelFilter() {
  const r = await api('/api/auto-reply/label-filter', { method: 'POST', body: {
    requireLabels: arLabelFilterState.requireLabels,
    strangerAutoLabel: arLabelFilterState.strangerAutoLabel,
  }});
  if (!r.ok) return toast('Lỗi lưu bộ lọc nhãn: ' + r.error, 'err');
  $('#arLabelFilterStatus').textContent = '✓ Đã lưu';
  toast('Đã lưu bộ lọc nhãn', 'ok');
}


async function initAutoReplyMgmtPage() {
  if (window.lucide) window.lucide.createIcons();
  bindAutoReplyDefaultActions();
  const initResults = await Promise.allSettled([loadAutoReplyDefaults(), loadStrangerEnableToggle(), loadArLabelFilter()]);
  const initError = initResults.find(r => r.status === 'rejected');
  if (initError) {
    console.warn('[auto-reply] init warning:', initError.reason);
    toast('Một phần cấu hình chưa tải được, nút lưu cấu hình chung vẫn dùng được.', 'info');
  }
  autoReplyDefaults = autoReplyDefaults || { ...AR_DEFAULTS_FALLBACK };
  fillDefaultsForm(autoReplyDefaults);
  bindAutoReplyDefaultActions();
  $('#arDefStranger').onchange = (e) => saveStrangerEnableToggle(e.target.checked);
  $('#arLabelFilterSaveBtn').onclick = saveArLabelFilter;
  $('#arRefreshBtn').onclick = refreshAutoReplyMgmt;
  $('#arBulkSelectAll').onclick = () => {
    arMgmtList.forEach(t => arMgmtSelected.add(String(t.threadId)));
    renderArSelectionState();
  };
  $('#arBulkClear').onclick = () => {
    arMgmtSelected.clear();
    renderArSelectionState();
  };
  $('#arBulkEnable').onclick = () => bulkSetAutoReplyEnabled(true);
  $('#arBulkDisable').onclick = () => bulkSetAutoReplyEnabled(false);
  $('#arBulkDelete').onclick = bulkDeleteAutoReplyConfigs;
  $('#arMasterEnabled').onchange = async (e) => {
    const enabled = e.target.checked;
    if (!confirm(enabled ? 'Bật auto-reply cho các hội thoại hợp lệ? Nhóm thiếu @mention/whitelist/reply toàn bộ sẽ tiếp tục bị tắt.' : 'Tắt auto-reply cho TẤT CẢ hội thoại?')) {
      e.target.checked = !enabled;
      return;
    }
    const r = await api(`/api/auto-reply/master/${state.ownId}`, { method: 'POST', body: { enabled } });
    if (!r.ok) { e.target.checked = !enabled; return toast('Lỗi: ' + r.error, 'err'); }
    const blockedGroups = Number(r.data?.blockedGroups || 0);
    toast(enabled
      ? (blockedGroups ? `Đã bật các hội thoại an toàn; ${blockedGroups} nhóm bị giữ tắt vì thiếu guard.` : 'Đã bật toàn bộ hội thoại hợp lệ')
      : 'Đã tắt toàn bộ', 'ok');
    await refreshAutoReplyMgmt();
  };
  document.querySelectorAll('input[name=arDefMode]').forEach(r => {
    r.onchange = () => $('#arDefStaticBox').classList.toggle('hidden', r.value !== 'static');
  });
  if (!state.ownId) {
    await refreshAutoReplyMgmt();
    return;
  }
  $('#arMasterEnabled').disabled = false;
  await refreshAutoReplyMgmt();
}

function updateArBulkBar() {
  const bar = $('#arBulkBar');
  if (!bar) return;
  const count = arMgmtSelected.size;
  bar.classList.toggle('hidden', !arMgmtList.length);
  $('#arBulkCount').textContent = count ? `${count} đã chọn` : 'Chưa chọn hội thoại';
  ['#arBulkClear', '#arBulkEnable', '#arBulkDisable', '#arBulkDelete'].forEach(sel => {
    const btn = $(sel);
    if (btn) btn.disabled = count === 0;
  });
  const allBtn = $('#arBulkSelectAll');
  if (allBtn) allBtn.disabled = !arMgmtList.length || count === arMgmtList.length;
}

function renderArSelectionState() {
  $$('#arThreadList input[type=checkbox][data-select-thread]').forEach(cb => {
    cb.checked = arMgmtSelected.has(String(cb.dataset.selectThread));
    cb.closest('.ar-mgmt-row')?.classList.toggle('selected', cb.checked);
  });
  updateArBulkBar();
}

function buildAutoReplyThreadBody(t, enabled) {
  return {
    ownId: state.ownId,
    threadId: t.threadId,
    threadType: t.threadType,
    enabled,
    mode: t.mode,
    static_reply: t.static_reply || '',
    delay_min_sec: t.delay_min_sec,
    delay_max_sec: t.delay_max_sec,
    max_per_hour: t.max_per_hour,
    work_start: t.work_start,
    work_end: t.work_end,
    only_first_msg: !!t.only_first_msg,
    first_n_msgs: t.first_n_msgs ?? (t.only_first_msg ? 1 : 0),
    manual_cooldown_min: t.manual_cooldown_min,
    allowed_users: t.reply_all_in_group ? null : parseAllowedUsersValue(t.allowed_users),
    only_when_mentioned: !!t.only_when_mentioned,
    reply_all_in_group: !!t.reply_all_in_group,
  };
}

function selectedAutoReplyThreads() {
  const selected = new Set([...arMgmtSelected].map(String));
  return arMgmtList.filter(t => selected.has(String(t.threadId)));
}

async function setAutoReplyThreadEnabled(t, enabled) {
  return api('/api/auto-reply/thread', {
    method: 'POST',
    body: buildAutoReplyThreadBody(t, enabled),
  });
}

async function bulkSetAutoReplyEnabled(enabled) {
  const targets = selectedAutoReplyThreads();
  if (!targets.length) return toast('Chưa chọn hội thoại', 'err');
  const label = enabled ? 'bật' : 'tắt';
  if (!confirm(`${enabled ? 'Bật' : 'Tắt'} AI cho ${targets.length} hội thoại đã chọn?`)) return;
  let ok = 0, fail = 0;
  for (const t of targets) {
    const r = await setAutoReplyThreadEnabled(t, enabled);
    if (r.ok) ok += 1;
    else fail += 1;
  }
  toast(fail ? `Đã ${label} ${ok}, lỗi ${fail} hội thoại` : `Đã ${label} ${ok} hội thoại`, fail ? 'err' : 'ok');
  await refreshAutoReplyMgmt();
}

async function bulkDeleteAutoReplyConfigs() {
  const targets = selectedAutoReplyThreads();
  if (!targets.length) return toast('Chưa chọn hội thoại', 'err');
  if (!confirm(`Xoá cấu hình riêng của ${targets.length} hội thoại đã chọn?\n\nCác hội thoại này sẽ rời danh sách đã cấu hình và quay về logic mặc định.`)) return;
  let ok = 0, fail = 0;
  for (const t of targets) {
    const r = await api(`/api/auto-reply/thread/${state.ownId}/${encodeURIComponent(t.threadId)}`, { method: 'DELETE' });
    if (r.ok) {
      ok += 1;
      arMgmtSelected.delete(String(t.threadId));
    } else {
      fail += 1;
    }
  }
  toast(fail ? `Đã xoá ${ok}, lỗi ${fail} hội thoại` : `Đã xoá ${ok} cấu hình riêng`, fail ? 'err' : 'ok');
  await refreshAutoReplyMgmt();
}

async function refreshAutoReplyMgmt() {
  if (!state.ownId) {
    arMgmtList = [];
    arMgmtSelected.clear();
    $('#arMasterEnabled').checked = false;
    $('#arMasterEnabled').disabled = true;
    $('#arSummary').textContent = 'Chưa chọn tài khoản';
    $('#arThreadList').innerHTML = '<div class="empty" style="padding:20px">Chọn hoặc thêm tài khoản Zalo để xem hội thoại đã cấu hình.</div>';
    $('#arRecentLog').innerHTML = '<div class="empty" style="padding:20px">Chọn tài khoản Zalo để xem lịch sử reply.</div>';
    updateArBulkBar();
    return;
  }
  const r = await api(`/api/auto-reply/thread/${state.ownId}`);
  const list = r.ok ? r.data : [];
  arMgmtList = list;
  const validIds = new Set(list.map(x => String(x.threadId)));
  [...arMgmtSelected].forEach(id => { if (!validIds.has(id)) arMgmtSelected.delete(id); });
  const enabledCnt = list.filter(x => x.enabled).length;
  $('#arSummary').textContent = `${enabledCnt} đang bật / ${list.length} đã cấu hình`;
  // Master toggle reflects "all enabled" state
  $('#arMasterEnabled').checked = list.length > 0 && enabledCnt === list.length;

  const box = $('#arThreadList');
  if (!list.length) {
    arMgmtSelected.clear();
    box.innerHTML = '<div class="empty" style="padding:20px">Chưa có hội thoại nào được cấu hình auto-reply. Vào panel AI của 1 hội thoại để bật.</div>';
  } else {
    box.innerHTML = list.map(s => {
      const id = String(s.threadId);
      const modeLabel = { ai: 'AI tạo', static: 'Câu cố định', keyword: 'Theo từ khoá' }[s.mode] || s.mode;
      const last = s.lastReplyTs ? timeAgo(s.lastReplyTs) : '—';
      const groupGuard = s.threadType === 1
        ? (s.reply_all_in_group ? ' · Guard: reply toàn bộ' : (s.only_when_mentioned ? ' · Guard: @mention' : (s.allowed_users && s.allowed_users !== '[]' ? ' · Guard: whitelist' : ' · Chưa có guard')))
        : '';
      return `
        <div class="ar-mgmt-row ${arMgmtSelected.has(id) ? 'selected' : ''}" data-id="${escapeHtml(id)}">
          <input class="ar-mgmt-select" type="checkbox" data-select-thread="${escapeHtml(id)}" ${arMgmtSelected.has(id) ? 'checked' : ''} title="Chọn hội thoại" />
          <div class="ar-mgmt-avatar" style="${s.threadAvatar ? `background-image:url('${s.threadAvatar}')` : ''}">${s.threadAvatar ? '' : escapeHtml(avatarText(s.threadName))}</div>
          <div class="ar-mgmt-body">
            <div class="ar-mgmt-name">${escapeHtml(s.threadName)} <span class="ar-mgmt-type">${s.threadType === 1 ? '(nhóm)' : '(cá nhân)'}</span></div>
            <div class="ar-mgmt-meta">Chế độ: <b>${modeLabel}</b>${groupGuard} · ${s.replyCount24h} reply / 24h · Lần cuối: ${last}</div>
          </div>
          <label class="ar-toggle" style="flex-shrink:0">
            <input type="checkbox" data-thread="${escapeHtml(s.threadId)}" ${s.enabled ? 'checked' : ''} />
            <span class="ar-switch"></span>
          </label>
          <button class="btn-ghost danger" data-act="delete-config" title="Xoá cấu hình riêng"><i data-lucide="trash-2"></i></button>
          <button class="btn-ghost" data-act="open" title="Mở hội thoại"><i data-lucide="arrow-right"></i></button>
        </div>
      `;
    }).join('');
    box.querySelectorAll('input[type=checkbox][data-select-thread]').forEach(cb => {
      cb.onchange = () => {
        const id = String(cb.dataset.selectThread);
        if (cb.checked) arMgmtSelected.add(id);
        else arMgmtSelected.delete(id);
        cb.closest('.ar-mgmt-row')?.classList.toggle('selected', cb.checked);
        updateArBulkBar();
      };
    });
    box.querySelectorAll('input[type=checkbox][data-thread]').forEach(cb => {
      cb.onchange = async () => {
        const tid = cb.dataset.thread;
        const t = list.find(x => x.threadId === tid);
        const r = await setAutoReplyThreadEnabled(t, cb.checked);
        if (!r.ok) { cb.checked = !cb.checked; return toast('Lỗi: ' + r.error, 'err'); }
        toast(cb.checked ? 'Đã bật' : 'Đã tắt', 'ok');
        refreshAutoReplyMgmt();
      };
    });
    box.querySelectorAll('[data-act="delete-config"]').forEach(b => {
      b.onclick = async () => {
        const row = b.closest('.ar-mgmt-row');
        const tid = row.dataset.id;
        const t = list.find(x => x.threadId === tid);
        const name = t?.threadName || tid;
        if (!confirm(`Xoá cấu hình riêng của "${name}"?\n\nHội thoại sẽ rời danh sách đã cấu hình và quay về logic mặc định.`)) return;
        const r = await api(`/api/auto-reply/thread/${state.ownId}/${encodeURIComponent(tid)}`, { method: 'DELETE' });
        if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
        toast('Đã xoá cấu hình riêng', 'ok');
        refreshAutoReplyMgmt();
      };
    });
    box.querySelectorAll('[data-act="open"]').forEach(b => {
      b.onclick = () => {
        const tid = b.closest('.ar-mgmt-row').dataset.id;
        const thread = state.threads.find(x => x.id === tid);
        if (thread) {
          history.pushState({}, '', '/chat');
          routeToCurrentPath();
          openThread(thread.id, thread.type);
        } else {
          toast('Không tìm thấy hội thoại trong list local', 'err');
        }
      };
    });
  }
  updateArBulkBar();
  if (window.lucide) window.lucide.createIcons();

  // Recent log
  const logR = await api(`/api/auto-reply/recent/${state.ownId}?limit=50`);
  const logs = logR.ok ? logR.data : [];
  const logBox = $('#arRecentLog');
  if (!logs.length) {
    logBox.innerHTML = '<div class="empty" style="padding:20px">Chưa có reply nào.</div>';
  } else {
    logBox.innerHTML = `
      <table class="ar-log-table">
        <thead><tr>
          <th>Thời gian</th>
          <th>Hội thoại</th>
          <th>Chế độ</th>
          <th>Nội dung reply</th>
        </tr></thead>
        <tbody>
          ${logs.map(l => `
            <tr>
              <td style="white-space:nowrap;font-size:11px">${timeAgo(l.ts)}</td>
              <td>${escapeHtml(l.threadName || '—')}</td>
              <td><span class="ar-mode-badge ar-mode-${l.mode}">${l.mode}</span></td>
              <td>${escapeHtml((l.reply_content || '').slice(0, 200))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
}

async function testAutoReplyNow() {
  const t = state.currentThread;
  if (!t || !state.ownId) return toast('Mở 1 hội thoại trước', 'err');
  const box = $('#rpAutoReplyTestResult');
  box.classList.remove('hidden');
  const closeBtn = '<button class="ar-test-close" type="button" aria-label="Đóng">×</button>';
  box.innerHTML = `${closeBtn}<div>⏳ Đang gọi AI...</div>`;
  box.querySelector('.ar-test-close').onclick = () => box.classList.add('hidden');
  const r = await api(`/api/auto-reply/test/${state.ownId}/${encodeURIComponent(t.id)}`, { method: 'POST' });
  if (!r.ok) {
    box.innerHTML = `${closeBtn}<div>❌ ${escapeHtml(r.error)}</div>`;
    box.querySelector('.ar-test-close').onclick = () => box.classList.add('hidden');
    return;
  }
  box.innerHTML = `
    ${closeBtn}
    <div class="trigger"><b>Tin khách:</b> ${escapeHtml((r.triggerMsg.from || 'KHÁCH') + ': ' + (r.triggerMsg.content || '').slice(0, 200))}</div>
    <div class="reply"><b>AI sẽ trả lời (chế độ ${r.mode}):</b><br>${escapeHtml(r.reply)}</div>
  `;
  box.querySelector('.ar-test-close').onclick = () => box.classList.add('hidden');
}

async function openAutoReplyModal() {
  const t = state.currentThread;
  if (!t) return toast('Mở 1 hội thoại trước', 'err');
  $('#arThreadName').textContent = `Hội thoại: ${t.name || '—'} (${t.type === 1 ? 'nhóm' : 'cá nhân'})`;

  if (!autoReplyDefaults) await loadAutoReplyDefaults();
  const d = autoReplyDefaults || AR_DEFAULTS_FALLBACK;
  const s = autoReplyCurrent || {};
  const hasOwn = !!autoReplyCurrent;
  const pick = (k, fb) => (hasOwn && s[k] !== undefined && s[k] !== null) ? s[k] : (d[k] ?? fb);

  $('#arEnabled').checked = !!s.enabled;
  const mode = pick('mode', 'ai');
  document.querySelectorAll('input[name=arMode]').forEach(r => { r.checked = r.value === mode; });
  $('#arStaticBox').classList.toggle('hidden', mode !== 'static');
  $('#arStaticReply').value = pick('static_reply', '');
  $('#arDelayMin').value = pick('delay_min_sec', 3);
  $('#arDelayMax').value = pick('delay_max_sec', 8);
  $('#arMaxPerHour').value = pick('max_per_hour', 30);
  $('#arWorkStart').value = pick('work_start', '00:00');
  $('#arWorkEnd').value = pick('work_end', '23:59');
  $('#arCooldown').value = pick('manual_cooldown_min', 10);
  $('#arFirstN').value = pick('first_n_msgs', pick('only_first_msg', 0) ? 1 : 3);
  const allowed = parseAllowedUsersValue(hasOwn ? s.allowed_users : d.allowed_users);
  const onlyWhenMentioned = hasOwn ? !!s.only_when_mentioned : !!d.only_when_mentioned;
  const replyAllInGroup = hasOwn ? !!s.reply_all_in_group : !!d.reply_all_in_group;
  const hasGroupGuard = replyAllInGroup || onlyWhenMentioned || allowed.length > 0;
  $('#arReplyAllGroup').checked = t.type === 1 && replyAllInGroup;
  $('#arOnlyMention').checked = t.type === 1 && !hasOwn && !hasGroupGuard ? true : (!replyAllInGroup && onlyWhenMentioned);
  $('#arAllowedUsers').value = replyAllInGroup ? '' : allowed.join('\n');
  $('#arGroupSettings').classList.toggle('hidden', t.type !== 1);
  bindGroupReplyControls('#arReplyAllGroup', '#arOnlyMention', '#arAllowedUsers');

  document.querySelectorAll('input[name=arMode]').forEach(r => {
    r.onchange = () => $('#arStaticBox').classList.toggle('hidden', r.value !== 'static');
  });

  $('#arSaveBtn').onclick = async () => {
    const replyAllGroup = t.type === 1 && $('#arReplyAllGroup').checked;
    const allowedRaw = $('#arAllowedUsers').value.trim();
    const allowed = replyAllGroup ? null : (allowedRaw ? allowedRaw.split('\n').map(s => s.trim()).filter(Boolean) : null);
    const body = {
      ownId: state.ownId,
      threadId: t.id,
      threadType: t.type,
      enabled: $('#arEnabled').checked,
      mode: document.querySelector('input[name=arMode]:checked')?.value || 'ai',
      static_reply: $('#arStaticReply').value.trim(),
      delay_min_sec: Number.isFinite(parseInt($('#arDelayMin').value)) ? parseInt($('#arDelayMin').value) : 15,
      delay_max_sec: Number.isFinite(parseInt($('#arDelayMax').value)) ? parseInt($('#arDelayMax').value) : 35,
      max_per_hour: parseInt($('#arMaxPerHour').value) || 6,
      work_start: $('#arWorkStart').value || '00:00',
      work_end: $('#arWorkEnd').value || '23:59',
      first_n_msgs: Math.max(0, parseInt($('#arFirstN').value) || 0),
      manual_cooldown_min: parseInt($('#arCooldown').value) || 0,
      allowed_users: allowed,
      only_when_mentioned: replyAllGroup ? false : $('#arOnlyMention').checked,
      reply_all_in_group: replyAllGroup,
    };
    if (body.mode === 'static' && !body.static_reply) return toast('Nhập nội dung câu cố định', 'err');
    if (body.enabled && t.type === 1 && !body.reply_all_in_group && !body.only_when_mentioned && !(allowed && allowed.length)) {
      return toast('Nhóm phải chọn @mention, whitelist user, hoặc reply toàn bộ trước khi bật AI.', 'err');
    }
    const r = await api('/api/auto-reply/thread', { method: 'POST', body });
    if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
    toast('Đã lưu cài đặt', 'ok');
    closeModal();
    loadAutoReplyPanel();
  };

  $('#arDeleteBtn').onclick = async () => {
    if (!confirm('Xoá toàn bộ cài đặt tự động trả lời cho hội thoại này?')) return;
    const r = await api(`/api/auto-reply/thread/${state.ownId}/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
    if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
    toast('Đã xoá', 'ok');
    closeModal();
    loadAutoReplyPanel();
  };

  openModal('modalAutoReply');
}

async function sendCurrentMessage() {
  const raw = $('#msgInput').value;
  const text = raw.trim();
  if (!text || !state.currentThread) return;
  $('#msgInput').value = '';
  const quote = state.replyTo ? buildQuotePayload(state.replyTo) : undefined;
  let mentions;
  if (state.currentThread.type === 1 && state.pendingMentions?.length) {
    mentions = state.pendingMentions
      .map(p => {
        const tag = '@' + p.name;
        const pos = raw.indexOf(tag);
        if (pos === -1) return null;
        return { uid: p.uid, pos, len: tag.length, type: 0 };
      })
      .filter(Boolean);
    if (!mentions.length) mentions = undefined;
  }
  const r = await api('/api/chat/send-msg', {
    method: 'POST',
    body: {
      ownId: state.ownId,
      threadId: state.currentThread.id,
      threadType: state.currentThread.type,
      content: text,
      quote,
      mentions,
    },
  });
  if (!r.ok) { toast('Lỗi: ' + r.error, 'err'); $('#msgInput').value = raw; return; }
  cancelReply();
  state.pendingMentions = [];
  toast('Đã gửi', 'ok');
}

function buildQuotePayload(m) {
  return {
    msgId: m.msgId,
    cliMsgId: m.cliMsgId,
    ts: m.ts,
    fromUid: m.fromUid,
    fromName: m.fromName || '',
    content: typeof m.content === 'string' ? m.content : (m.content?.msg || ''),
  };
}

function snippetFromMsg(m) {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (c?.msg) return c.msg;
  if (c?.attachments) return '[đính kèm]';
  return '[tin nhắn]';
}

function startReply(m) {
  state.replyTo = m;
  const name = m.isSelf ? 'chính mình' : (m.fromName || 'người dùng');
  $('#replyName').textContent = name;
  $('#replySnippet').textContent = snippetFromMsg(m).slice(0, 120);
  $('#replyPreview').classList.add('show');
  $('#msgInput').focus();
}

function cancelReply() {
  state.replyTo = null;
  $('#replyPreview').classList.remove('show');
}

const CTX_MENU_ID = 'msgCtxMenu';

function closeMsgContextMenu() {
  const el = document.getElementById(CTX_MENU_ID);
  if (el) el.remove();
}

function openMsgContextMenu(evt, m, idx) {
  closeMsgContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = CTX_MENU_ID;
  const items = [
    { act: 'copy', icon: 'copy', label: 'Copy tin nhắn' },
    { act: 'reply', icon: 'reply', label: 'Trả lời' },
    { act: 'forward', icon: 'forward', label: 'Chuyển tiếp' },
    { act: 'detail', icon: 'info', label: 'Xem chi tiết' },
    { divider: true },
    { act: 'delete', icon: 'trash-2', label: 'Xoá chỉ ở phía tôi', danger: true },
    ...(m.isSelf ? [{ act: 'recall', icon: 'undo-2', label: 'Thu hồi (xoá với mọi người)', danger: true }] : []),
  ];
  menu.innerHTML = items.map(it => it.divider
    ? '<div class="ctx-divider"></div>'
    : `<div class="ctx-item ${it.danger ? 'danger' : ''}" data-act="${it.act}"><i data-lucide="${it.icon}"></i>${it.label}</div>`
  ).join('');
  document.body.appendChild(menu);
  if (window.lucide) window.lucide.createIcons();
  const rect = menu.getBoundingClientRect();
  let x = evt.clientX, y = evt.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.querySelectorAll('.ctx-item').forEach(el => {
    el.onclick = async () => {
      const act = el.dataset.act;
      closeMsgContextMenu();
      if (act === 'copy') {
        try { await navigator.clipboard.writeText(snippetFromMsg(m)); toast('Đã sao chép', 'ok'); } catch { toast('Sao chép thất bại', 'err'); }
      } else if (act === 'reply') {
        startReply(m);
      } else if (act === 'forward') {
        openForwardModal(m);
      } else if (act === 'detail') {
        openMsgDetailModal(m);
      } else if (act === 'delete') {
        if (!confirm('Xoá tin nhắn này khỏi giao diện của bạn? (Tin nhắn vẫn còn ở phía người nhận)')) return;
        state.messages.splice(idx, 1);
        renderMessages(false);
      } else if (act === 'recall') {
        recallMessage(m, idx);
      }
    };
  });
  setTimeout(() => {
    document.addEventListener('click', closeMsgContextMenu, { once: true });
  }, 0);
}

// AI state: lịch sử AI tách theo từng thread
const aiState = {
  histories: {}, // { [threadId]: [{role, content}, ...] }
  busy: false,
  busyThreadId: null,
  streamingIdx: null,
};

const AI_HISTORY_STORAGE_KEY = 'zaloai_ai_histories_v1';

function loadAiHistoriesFromStorage() {
  try {
    const raw = localStorage.getItem(AI_HISTORY_STORAGE_KEY);
    if (raw) aiState.histories = JSON.parse(raw) || {};
  } catch {}
}
function persistAiHistories() {
  try {
    // Giới hạn — chỉ lưu 50 thread gần nhất, mỗi thread 20 lượt
    const entries = Object.entries(aiState.histories);
    if (entries.length > 50) {
      aiState.histories = Object.fromEntries(entries.slice(-50));
    }
    localStorage.setItem(AI_HISTORY_STORAGE_KEY, JSON.stringify(aiState.histories));
  } catch {}
}
function currentAiHistory() {
  const ctx = typeof getActiveChatContext === 'function' ? getActiveChatContext() : null;
  const tid = ctx ? `${ctx.type}:${ctx.threadId}` : state.currentThread?.id;
  if (!tid) return [];
  if (!aiState.histories[tid]) aiState.histories[tid] = [];
  return aiState.histories[tid];
}
function clearCurrentAiHistory() {
  const ctx = typeof getActiveChatContext === 'function' ? getActiveChatContext() : null;
  const tid = ctx ? `${ctx.type}:${ctx.threadId}` : state.currentThread?.id;
  if (!tid) return;
  aiState.histories[tid] = [];
  persistAiHistories();
  renderAiLog();
}

function toggleAiPanel() {
  const open = document.body.classList.toggle('ai-open');
  $('#aiPanel').classList.toggle('hidden', !open);
  // Khi đang ở page khác (Fanpage etc.) → bật overlay mode
  if (open && document.body.classList.contains('page-active')) {
    document.body.classList.add('ai-overlay');
  } else if (!open) {
    document.body.classList.remove('ai-overlay');
  }
  if (open) {
    refreshAiContext();
    renderAiLog();
    if (typeof loadAutoReplyPanel === 'function') loadAutoReplyPanel();
    $('#aiInput').focus();
  }
}
function closeAiPanel() {
  document.body.classList.remove('ai-open');
  document.body.classList.remove('ai-overlay');
  $('#aiPanel').classList.add('hidden');
}

// Phát hiện context đang active: Zalo hay Fanpage
function getActiveChatContext() {
  // Nếu đang ở trang Fanpage và có conversation đang chọn → Fanpage
  if (!$('#pageFanpage')?.classList.contains('hidden') && fpState?.selectedConvoId) {
    const convo = fpState.conversations.find(c => c.id === fpState.selectedConvoId);
    if (convo) {
      return {
        type: 'fanpage',
        threadId: fpState.selectedConvoId,
        name: convo.customerName || 'Khách FB',
        kind: 'Facebook · 1-1',
        messages: fpState.lastMessages || [],
      };
    }
  }
  // Default: Zalo
  if (state.currentThread) {
    return {
      type: 'zalo',
      threadId: state.currentThread.id,
      name: state.currentThread.name,
      kind: state.currentThread.type === 1 ? 'Zalo · nhóm' : 'Zalo · cá nhân',
      messages: state.messages,
    };
  }
  return null;
}

function refreshAiContext() {
  const ctx = getActiveChatContext();
  if (!ctx) { $('#aiCtx').textContent = 'Mở 1 hội thoại để AI có bối cảnh.'; return; }
  const recent = ctx.messages.slice(-15);
  const histLen = currentAiHistory().length;
  $('#aiCtx').textContent = `${ctx.name} (${ctx.kind}) · ${recent.length} tin nạp bối cảnh · ${Math.floor(histLen / 2)} lượt hỏi AI trước đó`;
}

function buildThreadContext() {
  const ctx = getActiveChatContext();
  if (!ctx) return '';
  const recent = ctx.messages.slice(-15);
  if (!recent.length) return '';
  const lines = recent.map(m => {
    const time = new Date(m.ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    // Fanpage dùng isFromPage, Zalo dùng isSelf
    const isSelf = ctx.type === 'fanpage' ? m.isFromPage : m.isSelf;
    const who = isSelf ? 'TÔI' : (m.fromName || 'KHÁCH');
    const text = typeof m.content === 'string' ? m.content : (m.content?.msg || '[đính kèm]');
    return `[${time}] ${who}: ${text.slice(0, 300)}`;
  });
  return `Hội thoại với ${ctx.name} (${ctx.kind}):\n${lines.join('\n')}`;
}

function renderMarkdown(raw) {
  let s = escapeHtml(raw || '');
  // Inline: `code`, **bold**, *italic*
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Block-level: line by line
  const lines = s.split('\n');
  const out = [];
  let listType = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (const line of lines) {
    if (/^\s*---+\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      closeList();
      const level = Math.max(3, Math.min(6, h[1].length + 2));
      out.push(`<h${level}>${h[2]}</h${level}>`);
      continue;
    }
    const bul = line.match(/^\s*[-*]\s+(.+)$/);
    if (bul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${bul[1]}</li>`);
      continue;
    }
    const num = line.match(/^\s*\d+\.\s+(.+)$/);
    if (num) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${num[1]}</li>`);
      continue;
    }
    closeList();
    out.push(line);
  }
  closeList();
  return out.join('\n');
}

function renderAiLog() {
  const log = $('#aiLog');
  if (!log) return;
  const history = currentAiHistory();
  const isBusyHere = aiState.busy && aiState.busyThreadId === state.currentThread?.id;
  if (!history.length) {
    log.innerHTML = '<div class="ai-msg thinking" style="text-align:center;padding:24px">Hỏi AI về hội thoại này — lịch sử riêng cho từng khách.</div>';
    return;
  }
  log.innerHTML = history.map((m, i) => {
    if (m.role === 'user') return `<div class="ai-msg user">${escapeHtml(m.content)}</div>`;
    const isStreaming = isBusyHere && aiState.streamingIdx === i;
    if (isStreaming && !m.content) {
      return `<div class="ai-msg thinking">⏳ Claude đang nghĩ...</div>`;
    }
    const cursor = isStreaming ? '<span class="ai-cursor">▍</span>' : '';
    const actions = isStreaming ? '' : `
      <div class="actions">
        <button data-act="copy"><i data-lucide="copy"></i> Sao chép</button>
        <button data-act="use"><i data-lucide="corner-down-left"></i> Dùng làm reply</button>
      </div>`;
    return `<div class="ai-msg ai" data-idx="${i}">${renderMarkdown(m.content)}${cursor}${actions}</div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;
  log.querySelectorAll('.ai-msg.ai').forEach(el => {
    const idx = +el.dataset.idx;
    const content = history[idx]?.content || '';
    el.querySelectorAll('button').forEach(b => {
      b.onclick = async () => {
        if (b.dataset.act === 'copy') {
          try { await navigator.clipboard.writeText(content); toast('Đã sao chép', 'ok'); } catch {}
        } else if (b.dataset.act === 'use') {
          const input = $('#msgInput');
          if (!input) return;
          input.value = content;
          input.focus();
          input.dispatchEvent(new Event('input'));
          toast('Đã đưa vào ô nhắn', 'ok');
        }
      };
    });
  });
  if (window.lucide) window.lucide.createIcons();
}

async function sendAiMessage() {
  if (aiState.busy) return toast('AI đang xử lý, đợi xong hãy hỏi tiếp', 'info');
  const ctx = getActiveChatContext();
  if (!ctx) return toast('Mở 1 hội thoại trước', 'err');
  const q = $('#aiInput').value.trim();
  if (!q) return;

  const tid = `${ctx.type}:${ctx.threadId}`;
  const history = currentAiHistory();
  history.push({ role: 'user', content: q });
  $('#aiInput').value = '';
  aiState.busy = true;
  aiState.busyThreadId = tid;
  aiState.streamingIdx = null;
  renderAiLog();

  // Push placeholder for streaming reply
  history.push({ role: 'assistant', content: '' });
  const replyIdx = history.length - 1;
  aiState.streamingIdx = replyIdx;

  let accumulated = '';
  let errorMsg = null;

  try {
    const resp = await fetch('/api/ai/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: history.slice(0, -1),
        threadContext: buildThreadContext(),
      }),
    });
    if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        let evt;
        try { evt = JSON.parse(json); } catch { continue; }
        if (evt.chunk) {
          accumulated += evt.chunk;
          // Lưu vào history của thread đó (kể cả user đã chuyển sang thread khác)
          if (aiState.histories[tid] && aiState.histories[tid][replyIdx]) {
            aiState.histories[tid][replyIdx].content = accumulated;
          }
          // Chỉ rerender khi user vẫn đang xem thread đó
          if (state.currentThread?.id === tid) renderAiLog();
        } else if (evt.error) {
          errorMsg = evt.error;
        } else if (evt.done) {
          break;
        }
      }
    }
  } catch (e) {
    errorMsg = e.message;
  }

  const targetHistory = aiState.histories[tid];
  if (targetHistory && targetHistory[replyIdx]) {
    if (errorMsg && !accumulated) {
      targetHistory[replyIdx].content = '❌ ' + errorMsg;
    } else if (errorMsg) {
      targetHistory[replyIdx].content = accumulated + '\n\n⚠️ ' + errorMsg;
    } else if (!accumulated) {
      targetHistory[replyIdx].content = '(trống)';
    }
  }
  aiState.busy = false;
  aiState.busyThreadId = null;
  aiState.streamingIdx = null;
  persistAiHistories();
  if (state.currentThread?.id === tid) renderAiLog();
}

const REACTION_EMOJIS = [
  { em: '👍', icon: '/-strong' },
  { em: '❤️', icon: '/-heart' },
  { em: '😂', icon: ':>' },
  { em: '😮', icon: ':o' },
  { em: '😢', icon: ':-((' },
  { em: '😠', icon: ':-h' },
];

function openReactionPicker(row, m, idx) {
  closeReactionPicker();
  const picker = document.createElement('div');
  picker.className = 'react-picker';
  picker.id = 'msgReactPicker';
  picker.innerHTML = REACTION_EMOJIS.map(r => `<span class="em" data-em="${r.em}" data-icon="${escapeHtml(r.icon)}">${r.em}</span>`).join('');
  (row.querySelector('.bubble-wrap') || row).appendChild(picker);
  picker.querySelectorAll('.em').forEach(el => {
    el.onclick = async (e) => {
      e.stopPropagation();
      closeReactionPicker();
      await sendReaction(m, idx, el.dataset.em, el.dataset.icon);
    };
  });
  setTimeout(() => document.addEventListener('click', closeReactionPicker, { once: true }), 0);
}

function closeReactionPicker() {
  document.getElementById('msgReactPicker')?.remove();
}

async function sendReaction(m, idx, emoji, icon) {
  // optimistic update
  m.reactions = m.reactions || {};
  m.reactions[emoji] = (m.reactions[emoji] || 0) + 1;
  renderMessages(false);
  if (!m.msgId) return; // local-only message
  const r = await api('/api/chat/msg-react', {
    method: 'POST',
    body: {
      ownId: state.ownId,
      threadId: state.currentThread.id,
      threadType: state.currentThread.type,
      msgId: m.msgId,
      cliMsgId: m.cliMsgId,
      icon,
    },
  });
  if (!r.ok) {
    toast('Lỗi gửi reaction: ' + r.error, 'err');
    m.reactions[emoji] = Math.max(0, (m.reactions[emoji] || 1) - 1);
    if (m.reactions[emoji] === 0) delete m.reactions[emoji];
    renderMessages(false);
  }
}

async function deleteCurrentThread() {
  if (!state.currentThread) return toast('Mở 1 hội thoại trước', 'err');
  const t = state.currentThread;
  if (!confirm(`Xoá toàn bộ tin nhắn của "${t.name}" ở phía mình?\n\nLưu ý: chỉ xoá ở tài khoản của bạn, người kia vẫn còn tin nhắn.`)) return;
  const r = await api('/api/chat/delete-chat', {
    method: 'POST',
    body: { ownId: state.ownId, threadId: t.id, threadType: t.type },
  });
  if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
  state.messages = [];
  renderMessages(true);
  toast(r.data && r.data.note ? r.data.note : 'Đã xoá toàn bộ hội thoại', 'ok');
}

async function recallMessage(m, idx) {
  if (!m.msgId) { toast('Tin nhắn chưa được gửi lên server', 'err'); return; }
  if (!confirm('Thu hồi tin nhắn này với tất cả mọi người?')) return;
  const r = await api('/api/chat/msg-recall', {
    method: 'POST',
    body: {
      ownId: state.ownId,
      threadId: state.currentThread.id,
      threadType: state.currentThread.type,
      msgId: m.msgId,
      cliMsgId: m.cliMsgId,
    },
  });
  if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
  m.recalled = true;
  renderMessages(false);
  toast('Đã thu hồi', 'ok');
}

function openMsgDetailModal(m) {
  const w = window.open('', '_blank', 'width=520,height=620,scrollbars=yes');
  if (!w) return toast('Trình duyệt chặn popup', 'err');
  const safe = JSON.stringify(m, null, 2).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  w.document.write(`<title>Chi tiết tin nhắn</title>
    <style>body{font-family:ui-monospace,monospace;font-size:12.5px;padding:16px;background:#fafafa;color:#222}h2{font-family:sans-serif;margin:0 0 12px}pre{white-space:pre-wrap;word-break:break-word}</style>
    <h2>Chi tiết tin nhắn</h2><pre>${safe}</pre>`);
}

async function openForwardModal(m) {
  if (!state.threads.length) await loadThreads();
  const arr = state.threads.slice(0, 100);
  const w = document.createElement('div');
  w.className = 'modal';
  w.id = 'modalForward';
  w.innerHTML = `<div class="modal-head"><h2>Chuyển tiếp tin nhắn</h2><button class="close-btn" data-close="modalForward">×</button></div>
    <div class="modal-body">
      <input type="text" id="fwSearch" placeholder="🔍 Tìm hội thoại..." />
      <div id="fwList" style="max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:6px"></div>
      <div style="margin-top:10px;font-size:12px;color:var(--muted-foreground)">Đã chọn: <span id="fwCount">0</span></div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="btn-primary" id="fwSendBtn">Gửi</button>
        <button class="btn-ghost" data-close="modalForward">Huỷ</button>
      </div>
    </div>`;
  document.body.appendChild(w);
  w.classList.remove('hidden');
  const selected = new Set();
  const render = () => {
    const q = ($('#fwSearch')?.value || '').toLowerCase().trim();
    const list = q ? arr.filter(t => (t.name || '').toLowerCase().includes(q)) : arr;
    $('#fwList').innerHTML = list.map(t => `<label style="display:flex;align-items:center;gap:10px;padding:8px 6px;cursor:pointer;border-radius:6px;font-size:13px">
      <input type="checkbox" data-id="${t.id}" data-tt="${t.type}" ${selected.has(t.id) ? 'checked' : ''} style="width:auto;margin:0" />
      <div class="avatar sm" ${t.avatar ? `style="background-image:url('${t.avatar}')"` : ''}>${t.avatar ? '' : escapeHtml(avatarText(t.name || '?'))}</div>
      <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.name || t.id)}</div>
    </label>`).join('') || '<div class="empty">Không có hội thoại</div>';
    $('#fwList').querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.onchange = () => {
        if (cb.checked) selected.add(cb.dataset.id);
        else selected.delete(cb.dataset.id);
        $('#fwCount').textContent = selected.size;
      };
    });
  };
  render();
  $('#fwSearch').oninput = render;
  $('#fwSendBtn').onclick = async () => {
    if (!selected.size) return toast('Chưa chọn hội thoại nào', 'err');
    const targets = [...selected].map(id => {
      const t = arr.find(x => x.id === id);
      return { threadId: id, threadType: t?.type ?? 0 };
    });
    const content = snippetFromMsg(m);
    const r = await api('/api/chat/msg-forward', { method: 'POST', body: { ownId: state.ownId, targets, content } });
    if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
    const okCount = (r.data || []).filter(x => x.ok).length;
    toast(`Đã chuyển tiếp tới ${okCount}/${targets.length} hội thoại`, 'ok');
    w.remove();
  };
  w.querySelectorAll('[data-close]').forEach(b => b.onclick = () => w.remove());
}

async function loadTemplates() {
  if (!state.ownId) return;
  const r = await api(`/api/chat/templates/${state.ownId}`);
  state.templates = r.data || [];
  $('#quickTemplates').innerHTML = state.templates.slice(0, 8).map(t =>
    `<div class="qt" data-id="${t.id}">${escapeHtml(t.name)}</div>`
  ).join('');
  $('#quickTemplates').querySelectorAll('.qt').forEach(el => {
    el.onclick = () => {
      const tpl = state.templates.find(t => t.id === parseInt(el.dataset.id));
      if (tpl) $('#msgInput').value = tpl.content;
    };
  });
  renderTplList();
}

function renderTplList() {
  $('#tplList').innerHTML = state.templates.map(t => `
    <div class="list-item">
      <div class="body">
        <div class="t1">${escapeHtml(t.name)}</div>
        <div class="t2">${escapeHtml((t.content || '').slice(0, 80))}</div>
      </div>
      <button data-del="${t.id}">Xoá</button>
    </div>
  `).join('') || '<div class="status-line">Chưa có template</div>';
  $('#tplList').querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => { await fetch('/api/chat/templates/' + b.dataset.del, { method: 'DELETE' }); loadTemplates(); };
  });
}

function setupWS() {
  if (state.ws) try { state.ws.close(); } catch {}
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      onWSMessage(m);
    } catch {}
  };
  ws.onclose = () => { state.ws = null; setTimeout(setupWS, 3000); };
  state.ws = ws;
}

function onWSMessage(m) {
  if (m.kind === 'message' && m.ownId === state.ownId) {
    const t = state.threads.find(x => x.id === m.threadId);
    if (t) {
      t.lastMsg = m.preview || m.content;
      t.lastMsgAt = Math.floor(m.ts / 1000);
      if (!m.isSelf && (!state.currentThread || state.currentThread.id !== m.threadId)) t.unread = (t.unread || 0) + 1;
    } else {
      state.threads.unshift({ id: m.threadId, ownId: m.ownId, type: m.threadType, name: m.fromName || m.threadId, lastMsg: m.preview || m.content, lastMsgAt: Math.floor(m.ts / 1000), unread: m.isSelf ? 0 : 1, labels: null });
    }
    state.threads.sort((a, b) => (b.lastMsgAt || 0) - (a.lastMsgAt || 0));
    renderThreads();
    if (state.currentThread && state.currentThread.id === m.threadId) {
      state.messages.push({ msgId: m.msgId, ownId: m.ownId, threadId: m.threadId, threadType: m.threadType, fromId: m.fromId, fromName: m.fromName, content: m.content, ts: m.ts, isSelf: m.isSelf ? 1 : 0, type: m.type || 0, meta: m.meta });
      renderMessages(true);
    } else if (!m.isSelf) {
      toast(`📩 ${m.fromName || 'Tin mới'}: ${(m.content || '').slice(0, 60)}`, 'info');
    }
  }
  if (m.kind === 'account-connected') {
    toast('Tài khoản đã kết nối: ' + m.ownId, 'ok');
    loadAccounts();
  }
  if (m.kind === 'broadcast-progress') {
    $('#bcProgress').textContent = `Đang gửi: ${m.progress}/${m.total}`;
  }
  if (m.kind === 'broadcast-done') {
    $('#bcProgress').textContent = 'Hoàn thành!';
    $('#bcProgress').className = 'status-line ok';
    loadBroadcasts();
  }
  // Fanpage sync progress
  if (m.kind === 'fb-sync-progress' && m.pageId === fpState.selectedPageId) {
    $('#fpSyncStatus').innerHTML = `⏳ Đang đồng bộ... ${m.convos} cuộc hội thoại / ${m.messages} tin`;
    if (!window._lastSyncReload || Date.now() - window._lastSyncReload > 3000) {
      window._lastSyncReload = Date.now();
      loadFbConvos();
    }
  }
  if (m.kind === 'fb-classify-progress' && m.pageId === fpState.selectedPageId) {
    toast(`🏷️ AI phân loại: ${m.classified}/${m.total} (skip ${m.skipped})`, 'info');
  }
  if (m.kind === 'fb-classify-done' && m.pageId === fpState.selectedPageId) {
    const counts = m.counts ? Object.entries(m.counts).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
    toast(`✅ Phân loại xong! ${m.classified} hội thoại đã gắn nhãn (${counts})`, 'ok');
    loadFbConvos();
  }
  if (m.kind === 'fb-sync-done' && m.pageId === fpState.selectedPageId) {
    $('#fpSyncAllBtn').disabled = false;
    if (m.error) {
      $('#fpSyncStatus').innerHTML = '❌ ' + m.error;
      toast('Lỗi sync: ' + m.error, 'err');
    } else {
      $('#fpSyncStatus').innerHTML = `✅ Đồng bộ xong: ${m.convos} hội thoại / ${m.messages} tin`;
      toast(`Đã đồng bộ ${m.convos} hội thoại`, 'ok');
      loadFbConvos();
    }
  }
  // Fanpage realtime
  if (m.kind === 'fb-message') {
    if (document.querySelector('#pageFanpage:not(.hidden)')) {
      // Đang ở trang Fanpage → reload nếu thuộc page đang chọn
      if (m.pageId === fpState.selectedPageId) {
        loadFbConvos();
        if (m.conversationId === fpState.selectedConvoId) loadFbMessages(m.conversationId);
      }
    } else if (!m.isFromPage) {
      // Đang trang khác → notification
      toast(`📩 FB: ${m.customerName || 'Khách'}: ${(m.content || '').slice(0, 50)}`, 'info');
    }
  }
  if (m.kind === 'task-progress' && m.taskId === currentTaskId) {
    $('#actProgress').textContent = `Đang chạy: ${m.done}/${m.total} (OK: ${m.ok}, Fail: ${m.fail})`;
  }
  // Refresh campaign list khi có progress hoặc done (cho mọi campaign, không chỉ currentTaskId)
  if ((m.kind === 'task-progress' || m.kind === 'task-done') && m.campaignId) {
    if (typeof loadCampaigns === 'function' && document.querySelector('#pspCampList')) {
      // Throttle: chỉ reload mỗi 2 giây
      if (!window._lastCampReload || Date.now() - window._lastCampReload > 2000) {
        window._lastCampReload = Date.now();
        loadCampaigns();
      }
    }
  }
  // Auto-detect throttle notification
  if (m.kind === 'task-done' && m.throttled) {
    toast('⚠️ Phát hiện Zalo throttle (response chậm 3 lần liên tiếp). Đã tự pause campaign. Đợi vài giờ rồi bấm "Tiếp tục".', 'err');
  }
  if (m.kind === 'task-done' && m.quotaLimited) {
    toast('Đã đạt giới hạn rời nhóm theo chu kỳ cấu hình. Chiến dịch đã tạm dừng để tiếp tục sau.', 'info');
  }
  if (m.kind === 'task-done' && m.taskId === currentTaskId) {
    if (m.error) { $('#actProgress').textContent = 'Lỗi: ' + m.error; $('#actProgress').className = 'status-line err'; }
    else { $('#actProgress').textContent = `Hoàn thành! OK: ${m.ok}, Fail: ${m.fail}`; $('#actProgress').className = 'status-line ok'; }
    if (m.errors && m.errors.length) {
      $('#actErrors').innerHTML = '<h3 style="font-size:11px;color:var(--muted);margin:10px 0 6px">Lỗi chi tiết</h3>' +
        m.errors.slice(0, 20).map(e => `<div class="list-item"><div class="body"><div class="t1">${escapeHtml(String(e.item))}</div><div class="t2">${escapeHtml(e.err)}</div></div></div>`).join('');
    }
    if (pspState.refreshOnTaskDone === 'groups') {
      pspState.refreshOnTaskDone = null;
      toast(`Đã rời xong (OK: ${m.ok}, Fail: ${m.fail})`, m.fail ? 'info' : 'ok');
      loadPspGroupsMulti();
    }
    currentTaskId = null;
  }
  if (m.kind === 'typing' && m.ownId === state.ownId && state.currentThread?.id === m.threadId) {
    showTypingIndicator(m);
  }
  if (m.kind === 'auto-reply-sent' && m.ownId === state.ownId) {
    toast(`🤖 AI tự động trả lời (${m.mode}): ${(m.content || '').slice(0, 80)}`, 'info');
    if (state.currentThread?.id === m.threadId) loadAutoReplyPanel();
  }
  if (m.kind === 'auto-reply-skipped' && m.ownId === state.ownId) {
    const t = state.threads.find(x => x.id === m.threadId);
    const name = t?.name || 'hội thoại';
    toast(`⚠️ ${name}: ${m.message}`, 'warn');
  }
}

let typingHideTimer = null;
function showTypingIndicator(ev) {
  const sub = $('#chHeadSub');
  if (!sub) return;
  if (!sub.dataset.origSub) sub.dataset.origSub = sub.textContent;
  sub.textContent = ev.isGroup ? 'Một thành viên đang gõ...' : 'Đang gõ...';
  sub.style.color = 'var(--primary)';
  sub.style.fontStyle = 'italic';
  if (typingHideTimer) clearTimeout(typingHideTimer);
  typingHideTimer = setTimeout(() => {
    sub.textContent = sub.dataset.origSub || (state.currentThread?.type === 1 ? 'Nhóm' : 'Cá nhân');
    sub.style.color = '';
    sub.style.fontStyle = '';
    delete sub.dataset.origSub;
  }, 4000);
}

const mentionState = { open: false, members: [], filtered: [], activeIdx: 0, anchorPos: -1 };

async function handleMentionInput() {
  const input = $('#msgInput');
  if (!input || !state.currentThread) return;
  const isGroup = state.currentThread.type === 1;
  if (!isGroup) { hideMentionDropdown(); return; }
  const val = input.value;
  const caret = input.selectionStart;
  const before = val.slice(0, caret);
  const atIdx = before.lastIndexOf('@');
  if (atIdx === -1) { hideMentionDropdown(); return; }
  // Only if @ is at start or after whitespace
  if (atIdx > 0 && !/\s/.test(before[atIdx - 1])) { hideMentionDropdown(); return; }
  const query = before.slice(atIdx + 1);
  if (/\s/.test(query)) { hideMentionDropdown(); return; }
  mentionState.anchorPos = atIdx;
  if (!mentionState.members.length) {
    try {
      const r = await api(`/api/chat/group-members/${state.ownId}/${state.currentThread.id}`);
      mentionState.members = (r.data || []).map(m => typeof m === 'string' ? { userId: m } : m);
    } catch { mentionState.members = []; }
  }
  const friendsMap = new Map(); // optional name lookup
  const q = query.toLowerCase();
  mentionState.filtered = mentionState.members
    .map(m => ({ uid: String(m.userId || m.uid), name: m.displayName || m.zaloName || ('User ' + String(m.userId || m.uid).slice(-6)), avatar: m.avatar || '' }))
    .filter(m => !q || m.name.toLowerCase().includes(q))
    .slice(0, 8);
  mentionState.activeIdx = 0;
  renderMentionDropdown();
}

function renderMentionDropdown() {
  const dd = $('#mentionDropdown');
  if (!dd) return;
  if (!mentionState.filtered.length) { hideMentionDropdown(); return; }
  const input = $('#msgInput');
  dd.classList.add('show');
  mentionState.open = true;
  dd.style.bottom = (input.offsetHeight + 6) + 'px';
  dd.style.left = '0';
  dd.innerHTML = mentionState.filtered.map((m, i) => `
    <div class="mn-item ${i === mentionState.activeIdx ? 'active' : ''}" data-uid="${m.uid}" data-name="${escapeHtml(m.name)}">
      <div class="avatar" ${m.avatar ? `style="background-image:url('${m.avatar}')"` : ''}>${m.avatar ? '' : escapeHtml(avatarText(m.name))}</div>
      <div class="nm">${escapeHtml(m.name)}</div>
    </div>
  `).join('');
  dd.querySelectorAll('.mn-item').forEach((el, i) => {
    el.onclick = () => insertMention(i);
  });
}

function hideMentionDropdown() {
  const dd = $('#mentionDropdown');
  if (dd) dd.classList.remove('show');
  mentionState.open = false;
  mentionState.filtered = [];
  mentionState.anchorPos = -1;
}

function insertMention(i) {
  const m = mentionState.filtered[i];
  if (!m) return;
  const input = $('#msgInput');
  const val = input.value;
  const caret = input.selectionStart;
  const anchor = mentionState.anchorPos;
  const before = val.slice(0, anchor);
  const after = val.slice(caret);
  const tag = '@' + m.name + ' ';
  input.value = before + tag + after;
  const newCaret = before.length + tag.length;
  input.setSelectionRange(newCaret, newCaret);
  input.focus();
  // Track pending mention
  state.pendingMentions = state.pendingMentions || [];
  state.pendingMentions.push({ uid: m.uid, name: m.name, pos: before.length, len: tag.length - 1 });
  hideMentionDropdown();
}

let lastTypingSentAt = 0;
async function emitTyping() {
  if (!state.currentThread || !state.ownId) return;
  const now = Date.now();
  if (now - lastTypingSentAt < 3000) return;
  lastTypingSentAt = now;
  try {
    await api('/api/chat/send-typing', { method: 'POST', body: { ownId: state.ownId, threadId: state.currentThread.id, threadType: state.currentThread.type } });
  } catch {}
}

function openModal(id) {
  $('#modalOverlay').classList.remove('hidden');
  $$('.modal').forEach(m => m.classList.add('hidden'));
  $('#' + id).classList.remove('hidden');
  if (id === 'modalAddAcc') resetAddAccModal();
  if (id === 'modalTemplate') renderTplList();
  if (id === 'modalSchedule') loadScheduled();
  if (id === 'modalAutoreply') loadAutoReplies();
  if (id === 'modalBroadcast') loadBroadcasts();
}
function closeModal() {
  $('#modalOverlay').classList.add('hidden');
  $$('.modal').forEach(m => m.classList.add('hidden'));
  if (state.loginTimer) { clearInterval(state.loginTimer); state.loginTimer = null; }
}

function resetAddAccModal() {
  $('#qrBox').classList.add('hidden');
  $('#qrBox').innerHTML = '';
  $('#addAccStatus').textContent = '';
  $('#addAccStatus').className = 'status-line';
  $('#startQrBtn').disabled = false;
  const proxyInput = $('#addAccProxy');
  if (proxyInput && !proxyInput.value.trim()) proxyInput.value = DEFAULT_ACCOUNT_PROXY;
}

async function startQRLogin() {
  $('#startQrBtn').disabled = true;
  $('#addAccStatus').textContent = 'Đang sinh QR code...';
  const r = await api('/api/chat/login-start', {
    method: 'POST',
    body: { name: $('#addAccName').value, proxy: $('#addAccProxy').value },
  });
  if (!r.ok) { $('#addAccStatus').textContent = 'Lỗi: ' + r.error; $('#startQrBtn').disabled = false; return; }
  state.loginSid = r.sid;
  state.loginTimer = setInterval(pollLogin, 1500);
}

async function pollLogin() {
  const r = await api(`/api/chat/login-poll/${state.loginSid}`);
  if (!r.ok) return;
  if (r.qr && $('#qrBox').classList.contains('hidden')) {
    $('#qrBox').classList.remove('hidden');
    $('#qrBox').innerHTML = `<img src="${r.qr}" alt="QR" />`;
    $('#addAccStatus').textContent = 'Quét QR bằng Zalo trên điện thoại';
  }
  if (r.status === 'scanned') { $('#addAccStatus').textContent = 'Đã quét! Đang chờ xác nhận...'; }
  if (r.status === 'success') {
    clearInterval(state.loginTimer); state.loginTimer = null;
    $('#addAccStatus').textContent = 'Đăng nhập thành công!';
    $('#addAccStatus').className = 'status-line ok';
    toast('Tài khoản đã thêm', 'ok');
    setTimeout(() => { closeModal(); loadAccounts(); }, 800);
  }
  if (r.status === 'error') {
    clearInterval(state.loginTimer); state.loginTimer = null;
    $('#addAccStatus').textContent = 'Lỗi: ' + r.error;
    $('#addAccStatus').className = 'status-line err';
    $('#startQrBtn').disabled = false;
  }
}

async function doBulkSend() {
  const targets = $('#bulkTargets').value.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const content = $('#bulkContent').value.trim();
  const delay = parseInt($('#bulkDelay').value) || 3000;
  if (!targets.length || !content) return toast('Cần ít nhất 1 ID và nội dung', 'err');
  const btn = $('#bulkSendBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Đang gửi...'; }
  $('#bulkProgress').textContent = `Đang gửi 0/${targets.length}...`;
  let done = 0, fail = 0;
  try {
    for (const t of targets) {
      const r = await api('/api/chat/send-msg', { method: 'POST', body: { ownId: state.ownId, threadId: t, threadType: 0, content } });
      if (r.ok) done++; else fail++;
      $('#bulkProgress').textContent = `Đã gửi: ${done} thành công, ${fail} lỗi (${done + fail}/${targets.length})`;
      await new Promise(r => setTimeout(r, delay + Math.random() * 1000));
    }
    $('#bulkProgress').className = 'status-line ok';
    toast(`Bulk send xong: ${done}/${targets.length}`, 'ok');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Gửi'; }
  }
}

async function doBroadcast() {
  const targets = $('#bcTargets').value.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const content = $('#bcContent').value.trim();
  const delayMs = parseInt($('#bcDelay').value) || 5000;
  if (!targets.length || !content) return toast('Cần targets và nội dung', 'err');
  const btn = $('#bcSendBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Đang khởi tạo...'; }
  try {
    const r = await api('/api/chat/broadcast', { method: 'POST', body: { ownId: state.ownId, content, targets, delayMs } });
    if (r.ok) {
      toast(`Broadcast bắt đầu: ${r.total} người`, 'ok');
      $('#bcProgress').textContent = `0/${r.total}`;
    } else toast('Lỗi: ' + r.error, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Bắt đầu broadcast'; }
  }
}

async function loadBroadcasts() {
  if (!state.ownId) return;
  const r = await api(`/api/chat/broadcasts/${state.ownId}`);
  $('#bcHistory').innerHTML = (r.data || []).map(b => `
    <div class="list-item">
      <div class="body">
        <div class="t1">#${b.id} · ${b.status}</div>
        <div class="t2">${b.progress}/${b.total} · ${escapeHtml((b.content || '').slice(0, 60))}</div>
      </div>
    </div>
  `).join('') || '<div class="status-line">Chưa có broadcast</div>';
}

async function addScheduled() {
  const threadId = $('#schThread').value.trim();
  const content = $('#schContent').value.trim();
  const at = $('#schAt').value;
  if (!threadId || !content || !at) return toast('Điền đủ thông tin', 'err');
  const scheduleAt = Math.floor(new Date(at).getTime() / 1000);
  await api('/api/chat/schedule', { method: 'POST', body: { ownId: state.ownId, threadId, threadType: 0, content, scheduleAt } });
  toast('Đã thêm lịch', 'ok'); loadScheduled();
}

async function loadScheduled() {
  if (!state.ownId) return;
  const r = await api(`/api/chat/scheduled/${state.ownId}`);
  $('#schList').innerHTML = (r.data || []).map(s => `
    <div class="list-item">
      <div class="body">
        <div class="t1">→ ${escapeHtml(s.threadId)} · ${s.status}</div>
        <div class="t2">${new Date(s.scheduleAt * 1000).toLocaleString('vi-VN')} — ${escapeHtml((s.content || '').slice(0, 60))}</div>
      </div>
    </div>
  `).join('') || '<div class="status-line">Chưa có lịch</div>';
}

async function addAutoReply() {
  const keyword = $('#arKeyword').value.trim();
  const response = $('#arResponse').value.trim();
  const scope = $('#arScope').value;
  if (!keyword || !response) return toast('Điền đủ keyword và response', 'err');
  await api('/api/chat/auto-replies', { method: 'POST', body: { ownId: state.ownId, keyword, response, scope } });
  $('#arKeyword').value = ''; $('#arResponse').value = '';
  toast('Đã thêm quy tắc', 'ok'); loadAutoReplies();
}

async function loadAutoReplies() {
  if (!state.ownId) return;
  const r = await api(`/api/chat/auto-replies/${state.ownId}`);
  $('#arList').innerHTML = (r.data || []).map(x => `
    <div class="list-item">
      <div class="body">
        <div class="t1">"${escapeHtml(x.keyword)}" → ${escapeHtml((x.response || '').slice(0, 50))}</div>
        <div class="t2">Phạm vi: ${x.scope}</div>
      </div>
      <button data-del="${x.id}">Xoá</button>
    </div>
  `).join('') || '<div class="status-line">Chưa có quy tắc</div>';
  $('#arList').querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => { await fetch('/api/chat/auto-replies/' + b.dataset.del, { method: 'DELETE' }); loadAutoReplies(); };
  });
}

function openInChatSearch() {
  $('#inChatSearchBox').classList.remove('hidden');
  $('#searchInChat').classList.add('hidden');
  $('#inChatSearchInput').value = '';
  $('#inChatSearchInput').focus();
  applyInChatSearch('');
}

function closeInChatSearch() {
  $('#inChatSearchBox').classList.add('hidden');
  $('#searchInChat').classList.remove('hidden');
  $('#inChatSearchInput').value = '';
  applyInChatSearch('');
}

function applyInChatSearch(qRaw) {
  const q = (qRaw || '').trim().toLowerCase();
  const rows = document.querySelectorAll('#messages .msg-row');
  let total = 0;
  rows.forEach(row => {
    row.classList.remove('search-hit', 'search-current');
    const bubble = row.querySelector('.msg-bubble');
    if (!bubble) return;
    const idx = +row.dataset.idx;
    const m = state.messages[idx];
    if (!m) return;
    const text = (typeof m.content === 'string' ? m.content : (m.content?.msg || ''));
    bubble.innerHTML = bubble.innerHTML.replace(/<mark>([^<]+)<\/mark>/g, '$1');
    if (!q) return;
    if (text.toLowerCase().includes(q)) {
      total++;
      row.classList.add('search-hit');
      const safe = escapeHtml(text);
      const re = new RegExp('(' + q.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + ')', 'gi');
      const highlighted = safe.replace(re, '<mark>$1</mark>');
      const contentEl = bubble.querySelector(':scope > :not(.msg-quote)') || bubble;
      if (contentEl === bubble) {
        const quote = bubble.querySelector('.msg-quote')?.outerHTML || '';
        bubble.innerHTML = quote + highlighted;
      }
    }
  });
  const firstHit = document.querySelector('#messages .msg-row.search-hit');
  if (firstHit) firstHit.classList.add('search-current');
  $('#inChatSearchCount').textContent = q ? `${total} kết quả` : '0/0';
  if (firstHit && q) firstHit.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function searchMessages(q) {
  if (!state.ownId || !q) { $('#searchResults').innerHTML = ''; return; }
  const r = await api(`/api/chat/search/${state.ownId}?q=${encodeURIComponent(q)}`);
  $('#searchResults').innerHTML = (r.data || []).map(m => `
    <div class="list-item">
      <div class="body">
        <div class="t1">${escapeHtml(m.fromName || m.threadId)}</div>
        <div class="t2">${escapeHtml((m.content || '').slice(0, 100))}</div>
      </div>
    </div>
  `).join('') || '<div class="status-line">Không tìm thấy</div>';
}

document.addEventListener('DOMContentLoaded', () => {
  $('#accSwitchBtn').onclick = () => $('#accDropdown').classList.toggle('hidden');
  $('#accCurrent').onclick = (e) => { if (e.target.id !== 'accSwitchBtn') $('#accDropdown').classList.toggle('hidden'); };
  $('#addAccBtn').onclick = () => { $('#accDropdown').classList.add('hidden'); openModal('modalAddAcc'); };
  $('#searchInput').oninput = renderThreads;
  initThreadFilter();
  $$('[data-modal]').forEach(b => b.onclick = () => openModal('modal' + b.dataset.modal[0].toUpperCase() + b.dataset.modal.slice(1)));
  $$('[data-close]').forEach(b => b.onclick = closeModal);
  $('#modalOverlay').onclick = (e) => { if (e.target.id === 'modalOverlay') closeModal(); };
  initLicenseGate();

  $('#startQrBtn').onclick = startQRLogin;
  $('#sendBtn').onclick = sendCurrentMessage;
  $('#replyCancel').onclick = cancelReply;
  $('#msgInput').onkeydown = (e) => {
    if (mentionState.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionState.activeIdx = (mentionState.activeIdx + 1) % mentionState.filtered.length; renderMentionDropdown(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionState.activeIdx = (mentionState.activeIdx - 1 + mentionState.filtered.length) % mentionState.filtered.length; renderMentionDropdown(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(mentionState.activeIdx); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideMentionDropdown(); return; }
    }
    if (e.key === 'Escape' && state.replyTo) { e.preventDefault(); cancelReply(); return; }
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.isComposing || e.keyCode === 229 || e.which === 229) return;
    e.preventDefault();
    sendCurrentMessage();
  };
  $('#msgInput').addEventListener('input', () => {
    if ($('#msgInput').value) emitTyping();
    handleMentionInput();
  });
  $('#msgInput').addEventListener('compositionstart', () => { $('#msgInput').dataset.composing = '1'; });
  $('#msgInput').addEventListener('compositionend', () => { delete $('#msgInput').dataset.composing; });

  $('#chatBody').addEventListener('scroll', () => {
    const el = $('#chatBody');
    if (el.scrollTop < 80 && state.msgHasMore && !state.msgLoading && state.currentThread) {
      loadMessages(false);
    }
  });

  $('#attachBtn').onclick = () => $('#attachFile').click();
  $('#attachFile').onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !state.currentThread) return;
    const fd = new FormData();
    fd.append('ownId', state.ownId);
    fd.append('threadId', state.currentThread.id);
    fd.append('threadType', state.currentThread.type);
    for (const f of files) fd.append('files', f);
    toast(`Đang gửi ${files.length} file...`, 'info');
    const r = await fetch('/api/chat/send-attachment', { method: 'POST', body: fd }).then(r => r.json());
    if (r.licenseRequired) showLicenseGate(r.license, r.error);
    else if (r.ok) toast('Đã gửi file', 'ok');
    else toast('Lỗi: ' + r.error, 'err');
    e.target.value = '';
  };

  $('#tplAddBtn').onclick = async () => {
    const name = $('#tplName').value.trim();
    const content = $('#tplContent').value.trim();
    if (!name || !content) return toast('Điền đủ tên và nội dung', 'err');
    await api('/api/chat/templates', { method: 'POST', body: { ownId: state.ownId, name, content } });
    $('#tplName').value = ''; $('#tplContent').value = '';
    toast('Đã thêm template', 'ok'); loadTemplates();
  };

  $('#bulkSendBtn').onclick = doBulkSend;
  $('#bcSendBtn').onclick = doBroadcast;
  $('#schAddBtn').onclick = addScheduled;
  $('#arAddBtn').onclick = addAutoReply;

  $('#searchInChat').onclick = openInChatSearch;
  $('#inChatSearchClose').onclick = closeInChatSearch;
  $('#inChatSearchInput').oninput = (e) => applyInChatSearch(e.target.value);

  $('#toggleRightPanel').onclick = () => {
    const closed = document.body.classList.toggle('rightbar-closed');
    $('#rightbar').classList.toggle('hidden', closed);
  };
  $('#labelBtn').onclick = () => {
    document.body.classList.remove('rightbar-closed');
    $('#rightbar').classList.remove('hidden');
  };
  $('#deleteChatBtn').onclick = deleteCurrentThread;
  $('#aiAdvisorBtn').onclick = toggleAiPanel;
  $('#aiClose').onclick = () => closeAiPanel();
  $('#aiClearBtn').onclick = () => {
    if (!state.currentThread) return toast('Mở 1 hội thoại trước', 'err');
    if (!confirm(`Xoá toàn bộ lịch sử AI cho "${state.currentThread.name}"?`)) return;
    clearCurrentAiHistory();
    refreshAiContext();
    toast('Đã xoá lịch sử AI của hội thoại này', 'ok');
  };
  $('#aiSendBtn').onclick = sendAiMessage;
  loadAiHistoriesFromStorage();
  $('#aiInput').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendAiMessage(); }
  };
  document.querySelectorAll('.ai-quick').forEach(c => {
    c.onclick = () => { $('#aiInput').value = c.dataset.prompt; sendAiMessage(); };
  });

  $('#rpEditLabelsBtn').onclick = (e) => {
    if (!state.currentThread) return toast('Hãy chọn một hội thoại trước', 'err');
    openLabelPickerForThread(state.currentThread, e);
  };

  $('#rpAutoReplyEnabled').onchange = (e) => quickToggleAutoReply(e.target.checked);
  $('#rpAutoReplyConfigBtn').onclick = openAutoReplyModal;
  $('#rpAutoReplyTestBtn').onclick = testAutoReplyNow;

  $('#rpScheduleBtn').onclick = () => {
    if (state.currentThread) $('#schThread').value = state.currentThread.id;
    openModal('modalSchedule');
  };

  $('#scheduleQuickBtn').onclick = () => {
    if (!state.currentThread) return toast('Hãy chọn một hội thoại trước', 'err');
    $('#schThread').value = state.currentThread.id;
    openModal('modalSchedule');
  };

  $('#rpClearHistory').onclick = async () => {
    if (!state.currentThread) return toast('Hãy chọn một hội thoại trước', 'err');
    if (!confirm(`Xoá toàn bộ lịch sử tin nhắn local của "${state.currentThread.name}"?\n(Chỉ xoá cache, không động đến tin trên Zalo.)`)) return;
    const r = await api('/api/chat/thread-remove', { method: 'POST', body: { ownId: state.ownId, threadId: state.currentThread.id } });
    if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
    state.messages = [];
    renderMessages();
    state.threads = state.threads.filter(t => t.id !== state.currentThread.id);
    state.currentThread = null;
    $('#chatHeader').classList.add('hidden');
    $('#chatFooter').classList.add('hidden');
    $('#messages').classList.add('hidden');
    $('#chatPlaceholder').classList.remove('hidden');
    renderThreads();
    toast('Đã xoá lịch sử local', 'ok');
  };

  $('#actRunBtn').onclick = runAction;
  $('#actStopBtn').onclick = () => { currentTaskId = null; $('#actProgress').textContent = 'Đã yêu cầu dừng (đợi task hiện tại xong).'; };
  $('#emojiBtn').onclick = openStickerPicker;
  $('#stSearchBtn').onclick = () => searchStickers($('#stKeyword').value);
  $('#stKeyword').onkeydown = (e) => { if (e.key === 'Enter') searchStickers(e.target.value); };
  $('#reqTabRecv').onclick = () => loadRequests('recv');
  $('#reqTabSent').onclick = () => loadRequests('sent');
  $('#reqAcceptAllBtn').onclick = acceptAllReceived;
  $('#reqRejectAllBtn').onclick = rejectAllReceived;

  setupNavRail();
  setupTopbar();
  setupTheme();
  setupWS();
  loadAccounts();
  if (window.lucide) window.lucide.createIcons();
});

const pspState = { phones: [], files: [], friends: [], groups: [], members: [], links: [], scannedFromLinks: [], selectedFriends: new Set(), selectedMembers: new Set(), selectedGroupsMulti: new Set(), friendLabelFilter: 'all', memberLabelFilter: 'all', memberLabelsByUser: new Map(), action: 'msg-phone' };

async function initSendByPhonePage(action = 'msg-phone') {
  pspState.action = action;
  pspState.editingId = null;
  const cfg = PAGE_TITLES[action] || PAGE_TITLES['msg-phone'];
  // Scope vào pageSendByPhone (DOM có nhiều .page-title trong các page khác nhau)
  document.querySelector('#pageSendByPhone .page-title h1').textContent = cfg.title;
  const iconEl = document.querySelector('#pageSendByPhone .page-title i');
  if (iconEl && cfg.icon) iconEl.setAttribute('data-lucide', cfg.icon);
  if (window.lucide) window.lucide.createIcons();
  if (!state.accounts.length || !state.ownId) await loadAccounts();
  bindPspHandlers(cfg);
  if (cfg.directExecute) {
    await showCampaignForm(cfg);
  } else {
    setPspView('list');
    await loadCampaigns();
  }
}

function setPspView(view) {
  pspState.view = view;
  $('#pspListView').classList.toggle('hidden', view !== 'list');
  $('#pspFormView').classList.toggle('hidden', view !== 'form');
  $('#pspListActions').classList.toggle('hidden', view !== 'list');
  $('#pspFormActions').classList.toggle('hidden', view !== 'form');
}

async function loadCampaigns() {
  if (!state.ownId) return;
  const isLeaveCampaign = pspState.action === 'grp-leave';
  const actions = pspState.action === 'msg-group-mem'
    ? ['msg-group-mem', 'msg-group-other']
    : [pspState.action];
  const responses = await Promise.all(actions.map(action => api(`/api/chat/campaigns/${state.ownId}?action=${action}`)));
  const list = responses.flatMap(r => r.data || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const tbody = $('#pspCampList');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty" style="padding:40px">Chưa có chiến dịch nào. Bấm "+ Tạo yêu cầu" để bắt đầu.</div></td></tr>';
    return;
  }
  tbody.innerHTML = list.map((c, i) => {
    const d = new Date(c.createdAt * 1000);
    const date = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const statusMap = { done: 'Thành công', running: 'Đang chạy', draft: 'Nháp', failed: 'Lỗi', paused: 'Đã dừng', throttled: '⚠️ Zalo throttle (auto-pause)' };
    const cursor = c.cursor || 0;
    const attempted = c.success + c.fail;
    const delivered = c.delivered || 0;  // Số UID THỰC SỰ nhận được tin (từ campaign_deliveries)
    const remaining = Math.max(0, c.total - Math.max(cursor, attempted));
    const isRunning = c.status === 'running';
    const isPaused = c.status === 'paused' || c.status === 'throttled';
    const startLabel = (isPaused || cursor > 0 || attempted > 0)
      ? `Tiếp tục (còn ${remaining})`
      : 'Bắt đầu';
    const startIcon = (isPaused || cursor > 0) ? 'play' : 'play-circle';
    // Delivery records represent completed actions; for leave-group this is a successful leave.
    let progressText = '';
    if (attempted > 0 || delivered > 0) {
      const gap = attempted - delivered;
      const gapNote = isLeaveCampaign ? 'thất bại' : 'không tới';
      const gapWarn = gap > 0 ? ` <span style="color:var(--destructive)">(${gap} ${gapNote})</span>` : '';
      const resultLabel = isLeaveCampaign ? 'Đã rời' : 'Thực nhận';
      progressText = `<div style="font-size:11px;color:var(--muted-foreground);margin-top:2px">${resultLabel}: <b>${delivered}</b> / Đã thử: ${attempted} / Tổng: ${c.total}${gapWarn}</div>`;
    }
    return `<tr data-id="${c.id}" data-total="${c.total}" data-remaining="${remaining}">
      <td>${i + 1}</td>
      <td><b>${escapeHtml(c.name)}</b>${progressText}</td>
      <td>—</td>
      <td>${c.total}</td>
      <td style="color:var(--success);font-weight:600">${delivered > 0 ? delivered : c.success}${delivered > 0 && delivered !== c.success ? `<div style="font-size:10px;color:var(--muted-foreground);font-weight:400">counter: ${c.success}</div>` : ''}</td>
      <td style="color:var(--destructive)">${c.fail}</td>
      <td><span class="status-pill ${c.status}">${statusMap[c.status] || c.status}</span></td>
      <td style="color:var(--muted-foreground);font-size:12px">${date}</td>
      <td>
        <div class="camp-actions">
          ${isRunning
            ? `<a class="danger" data-act="stop"><i data-lucide="stop-circle"></i> Dừng</a>`
            : `<a class="${isLeaveCampaign ? 'danger' : ''}" data-act="run"><i data-lucide="${startIcon}"></i> ${startLabel}</a>`}
          ${isPaused ? `<a data-act="reset" title="Reset về 0, gửi lại từ đầu"><i data-lucide="rotate-ccw"></i> Reset</a>` : ''}
          <a data-act="edit"><i data-lucide="edit-2"></i> Sửa</a>
          <a data-act="clone"><i data-lucide="copy"></i> Sao chép</a>
          <a class="danger" data-act="del"><i data-lucide="trash-2"></i> Xoá</a>
          <a data-act="view"><i data-lucide="eye"></i> Xem</a>
        </div>
      </td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('a[data-act]').forEach(a => {
    a.onclick = () => {
      const id = +a.closest('tr').dataset.id;
      const total = +a.closest('tr').dataset.total;
      const remaining = +a.closest('tr').dataset.remaining;
      const act = a.dataset.act;
      if (act === 'run') runCampaign(id, total, remaining);
      else if (act === 'stop') stopCampaign(id);
      else if (act === 'reset') resetCampaign(id);
      else if (act === 'edit' || act === 'view') editCampaign(id);
      else if (act === 'clone') cloneCampaign(id);
      else if (act === 'del') deleteCampaign(id);
    };
  });
  if (window.lucide) window.lucide.createIcons();
}

async function showCampaignForm(cfg) {
  pspState.phones = [];
  pspState.files = [];
  pspState.selectedFriends = new Set();
  pspState.selectedMembers = new Set();
  pspState.members = [];
  pspState.links = [];
  pspState.friendLabelFilter = 'all';
  pspState.memberLabelFilter = 'all';
  pspState.memberLabelsByUser = new Map();
  $('#pspName').value = '';
  $('#pspContent').value = '';
  $('#pspFileList').innerHTML = '';
  $('#pspPhoneInput').value = '';
  $('#pspSwitchAfter').value = 5;
  $('#pspDelayMin').value = 15;
  $('#pspDelayMax').value = 20;
  $('#pspPauseAfter').value = 2;
  $('#pspPauseSec').value = 10;
  $('#pspQuota').value = 50;
  $('#pspQuotaPer').value = 1;
  $('#pspQuotaUnit').value = 'day';
  $('#pspAutoFriend').checked = false;
  $('#pspSpread').checked = true;
  $('#pspDedupe').checked = false;
  $('#pspDynamic').checked = false;
  $('#pspDynamicBox').classList.add('hidden');
  $('#pspDynamicList').value = '';
  const isLeaveCampaign = pspState.action === 'grp-leave';
  $('#pspSwitchField')?.classList.toggle('hidden', isLeaveCampaign);
  if ($('#pspPauseLabel')) $('#pspPauseLabel').textContent = isLeaveCampaign ? 'Tạm dừng sau khi rời thành công' : 'Dừng lại nếu gửi thành công';
  if ($('#pspQuotaLabel')) $('#pspQuotaLabel').textContent = isLeaveCampaign ? 'Giới hạn nhóm được rời' : 'Giới hạn số lượng thực thi';
  const contentField = $('#pspContent');
  const contentCard = contentField?.closest('.page-card');
  const contentLabel = contentCard?.querySelector('label.required');
  if (contentLabel) contentLabel.textContent = cfg.contentLabel || 'Nội dung nhắn tin';
  if (contentField) contentField.placeholder = cfg.contentPlaceholder || 'Nhập nội dung tin nhắn';
  if (contentCard) contentCard.classList.toggle('hidden', !!cfg.noContent);
  // Hide field tin nhắn (ảnh/video, emoji, naturalize, obfuscate) khi action không gửi tin
  document.querySelectorAll('[data-psp="msg-only"]').forEach(el => el.classList.toggle('hidden', !!cfg.noContent));
  // Hide field SĐT (chia đều, lọc trùng) khi target không phải SĐT
  document.querySelectorAll('[data-psp="phone-only"]').forEach(el => el.classList.toggle('hidden', cfg.target !== 'phones'));
  $('#pspAutoFriend').closest('label')?.classList.toggle('hidden', cfg.target !== 'phones' || ['friend-phone','friend-backup','friend-undo','friend-remove'].includes(pspState.action));

  const phonesPanel = document.querySelector('.target-panel[data-target="phones"]');
  if (phonesPanel) {
    const h3 = phonesPanel.querySelector('h3');
    if (h3) h3.innerHTML = (cfg.targetTitle || 'Danh sách số điện thoại') + ` <span class="hint">(Đã chọn: <span id="pspCount">0</span>)</span>`;
    const input = $('#pspPhoneInput');
    if (input) input.placeholder = cfg.targetPlaceholder || 'Nhập số điện thoại';
    const hint = phonesPanel.querySelector('.hint[style*="destructive"]');
    if (hint) hint.textContent = cfg.acceptUids ? 'Định dạng file .txt hoặc .csv, mỗi User ID 1 dòng.' : 'Định dạng file .txt, mỗi số điện thoại 1 dòng.';
  }

  const submitBtn = $('#pspSubmitBtn');
  if (submitBtn) {
    submitBtn.style.background = cfg.danger ? 'var(--destructive)' : '';
    submitBtn.textContent = cfg.submitLabel || 'Lưu';
  }
  const paramsCard = document.querySelector('#pspFormView .page-card');
  if (paramsCard) paramsCard.classList.toggle('hidden', !!cfg.directExecute);
  // Khi directExecute: ẩn cột trái rỗng + chuyển grid thành 1 cột center
  const leftCol = document.querySelector('#pspFormView .page-col:first-child');
  if (leftCol) leftCol.classList.toggle('hidden', !!cfg.directExecute);
  $('#pspFormView')?.classList.toggle('single-col', !!cfg.directExecute);
  const backBtn = $('#pspBackBtn');
  if (backBtn) backBtn.classList.toggle('hidden', !!cfg.directExecute);

  arrangePspTargetPanels(cfg);
  document.querySelectorAll('.target-panel').forEach(p => {
    const shown = p.dataset.target === cfg.target || p.dataset.target === cfg.extraTarget;
    p.classList.toggle('hidden', !shown);
  });
  renderPspPhones();
  renderPspAccounts();
  pspState.links = [];
  renderPspLinks();
  const targets = [cfg.target, cfg.extraTarget].filter(Boolean);
  if (targets.includes('friends')) await loadPspFriends();
  if (targets.includes('group-mem')) {
    await loadPspGroups();
    if (isMessageMemberLabelPage()) {
      await loadPspMemberLabels();
      renderPspMemberLabelFilter();
    }
  }
  if (targets.includes('groups-multi')) { pspState.selectedGroupsMulti = new Set(); await loadPspGroupsMulti(); }
  setPspView('form');
}

function arrangePspTargetPanels(cfg) {
  const cols = document.querySelectorAll('#pspFormView .page-col');
  const left = cols[0];
  const right = cols[1];
  const groupsPanel = document.querySelector('.target-panel[data-target="groups-multi"]');
  if (!left || !right || !groupsPanel) return;
  const hasDestinationGroups = ['grp-invite-phone', 'grp-invite-friend', 'grp-invite-other'].includes(pspState.action);
  groupsPanel.classList.toggle('psp-destination-panel', hasDestinationGroups);
  (hasDestinationGroups ? left : right).appendChild(groupsPanel);
  const h3 = groupsPanel.querySelector('h3');
  if (h3) {
    h3.innerHTML = (cfg.groupsTitle || 'Danh sách nhóm của tôi') + ` <span class="hint">(Đã chọn: <span id="pspGroupsMultiCount">0</span> / <span id="pspGroupsMultiTotal">${pspState.groups.length || 0}</span>)</span>`;
  }
}

async function loadPspGroupsMulti() {
  if (!state.ownId) return;
  if (!pspState.groups.length) await loadPspGroups();
  // Merge interaction stats 1 lần
  if (!pspState.groupsHasStats) {
    try {
      const sr = await api(`/api/groups/interaction-stats/${state.ownId}`);
      const stats = (sr.ok && sr.data) || {};
      for (const g of pspState.groups) {
        const st = stats[g.id] || {};
        g.msgCount = st.msgCount || 0;
        g.lastTs = st.lastTs || 0;
      }
      pspState.groupsHasStats = true;
    } catch {}
  }
  $('#pspGroupsMultiTotal').textContent = pspState.groups.length;
  if (!pspState.groupSizeFilter) pspState.groupSizeFilter = 'all';
  if (!pspState.groupActFilter) pspState.groupActFilter = 'all';
  if (!pspState.groupSort) pspState.groupSort = 'mem-desc';
  renderPspGroupsMulti();
}

function getGroupSize(g) {
  const m = g.memberCount || 0;
  if (m < 20) return 'small';
  if (m <= 100) return 'medium';
  return 'large';
}

function getGroupActivity(g) {
  if (!g.msgCount) return 'dead';
  const daysAgo = (Date.now() - (g.lastTs || 0)) / 86400000;
  if (daysAgo > 90 || g.msgCount < 10) return 'low';
  if (daysAgo > 30 || g.msgCount < 50) return 'mid';
  return 'high';
}

function renderPspGroupsMulti() {
  const wrap = $('#pspGroupsMultiList');
  const q = ($('#pspGroupsMultiSearch')?.value || '').toLowerCase().trim();
  const sizeFilter = pspState.groupSizeFilter || 'all';
  const actFilter = pspState.groupActFilter || 'all';
  const sort = pspState.groupSort || 'mem-desc';

  let arr = pspState.groups.filter(g => {
    if (q && !(g.name || '').toLowerCase().includes(q)) return false;
    if (sizeFilter !== 'all' && getGroupSize(g) !== sizeFilter) return false;
    if (actFilter !== 'all' && getGroupActivity(g) !== actFilter) return false;
    return true;
  });

  if (sort === 'name') arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'vi'));
  else if (sort === 'mem-desc') arr.sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0));
  else if (sort === 'mem-asc') arr.sort((a, b) => (a.memberCount || 0) - (b.memberCount || 0));
  else if (sort === 'last-desc') arr.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  else if (sort === 'last-asc') arr.sort((a, b) => (a.lastTs || 0) - (b.lastTs || 0));
  else if (sort === 'msg-desc') arr.sort((a, b) => (b.msgCount || 0) - (a.msgCount || 0));

  $('#pspGroupsMultiCount').textContent = pspState.selectedGroupsMulti.size;

  const sizeChips = [
    ['all', 'Mọi cỡ', pspState.groups.length],
    ['small', 'Nhỏ <20', pspState.groups.filter(g => getGroupSize(g) === 'small').length],
    ['medium', 'Vừa 20-100', pspState.groups.filter(g => getGroupSize(g) === 'medium').length],
    ['large', 'Lớn >100', pspState.groups.filter(g => getGroupSize(g) === 'large').length],
  ];
  const actChips = [
    ['all', 'Mọi mức', pspState.groups.length],
    ['dead', 'Không HĐ', pspState.groups.filter(g => getGroupActivity(g) === 'dead').length],
    ['low', 'Ít', pspState.groups.filter(g => getGroupActivity(g) === 'low').length],
    ['mid', 'TB', pspState.groups.filter(g => getGroupActivity(g) === 'mid').length],
    ['high', 'Nhiều', pspState.groups.filter(g => getGroupActivity(g) === 'high').length],
  ];

  const filterBar = `
    <div class="psp-group-filter">
      <div class="psp-filter-row">
        <span class="psp-filter-label">Cỡ nhóm</span>
        ${sizeChips.map(([k, lb, cnt]) => `<button class="ppf-chip ${sizeFilter === k ? 'active' : ''}" data-size="${k}">${lb} <span class="ppf-chip-count">${cnt}</span></button>`).join('')}
      </div>
      <div class="psp-filter-row">
        <span class="psp-filter-label">Hoạt động</span>
        ${actChips.map(([k, lb, cnt]) => `<button class="ppf-chip ${actFilter === k ? 'active' : ''}" data-act="${k}">${lb} <span class="ppf-chip-count">${cnt}</span></button>`).join('')}
        <select class="ppf-sort">
          <option value="mem-desc" ${sort === 'mem-desc' ? 'selected' : ''}>Nhiều TV nhất</option>
          <option value="mem-asc" ${sort === 'mem-asc' ? 'selected' : ''}>Ít TV nhất</option>
          <option value="name" ${sort === 'name' ? 'selected' : ''}>Tên A-Z</option>
          <option value="last-desc" ${sort === 'last-desc' ? 'selected' : ''}>HĐ gần nhất</option>
          <option value="last-asc" ${sort === 'last-asc' ? 'selected' : ''}>Lâu không HĐ</option>
          <option value="msg-desc" ${sort === 'msg-desc' ? 'selected' : ''}>Nhiều tin nhất</option>
        </select>
      </div>
    </div>`;

  const actColor = { dead: '#ef4444', low: '#f59e0b', mid: '#64748b', high: '#16a34a' };
  const rowsHtml = arr.length
    ? arr.slice(0, 300).map(g => {
        const sel = pspState.selectedGroupsMulti.has(g.id);
        const avatar = g.avatar ? `style="background-image:url('${g.avatar}')"` : '';
        const act = getGroupActivity(g);
        const actLabel = act === 'dead' ? 'Không hoạt động' : `${g.msgCount} tin · ${friendlyDaysAgo(g.lastTs)}`;
        return `<label class="psp-group-row ${sel ? 'selected' : ''}" data-id="${g.id}">
          <input type="checkbox" data-id="${g.id}" ${sel ? 'checked' : ''} style="margin:0;width:auto" />
          <div class="avatar" ${avatar}>${g.avatar ? '' : escapeHtml(avatarText(g.name))}</div>
          <div class="body">
            <div class="name">${escapeHtml(g.name)}</div>
            <div class="meta">${g.memberCount ? g.memberCount + ' TV' : '—'} · <span style="color:${actColor[act]}">${actLabel}</span></div>
          </div>
        </label>`;
      }).join('') + (arr.length > 300 ? `<div class="status-line" style="padding:8px;text-align:center">Còn ${arr.length - 300} nhóm — gõ search để tìm</div>` : '')
    : '<div class="empty" style="padding:20px">Không có nhóm phù hợp filter</div>';

  wrap.innerHTML = filterBar + rowsHtml;

  wrap.querySelectorAll('[data-size]').forEach(b => {
    b.onclick = () => { pspState.groupSizeFilter = b.dataset.size; renderPspGroupsMulti(); };
  });
  wrap.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = () => { pspState.groupActFilter = b.dataset.act; renderPspGroupsMulti(); };
  });
  const sortEl = wrap.querySelector('.ppf-sort');
  if (sortEl) sortEl.onchange = (e) => { pspState.groupSort = e.target.value; renderPspGroupsMulti(); };

  wrap.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) pspState.selectedGroupsMulti.add(cb.dataset.id);
      else pspState.selectedGroupsMulti.delete(cb.dataset.id);
      cb.closest('.psp-group-row').classList.toggle('selected', cb.checked);
      $('#pspGroupsMultiCount').textContent = pspState.selectedGroupsMulti.size;
    };
  });
}

function renderPspLinks() {
  const box = $('#pspLinkList');
  if (!box) return;
  const cfg = PAGE_TITLES[pspState.action] || {};
  $('#pspLinkCount').textContent = pspState.links.length;
  const titleH3 = document.querySelector('.target-panel[data-target="group-link"] h3');
  if (titleH3) titleH3.innerHTML = (cfg.linksTitle || 'Danh sách nhóm khác') + ` <span class="hint">(Đã chọn: <span id="pspLinkCount">${pspState.links.length}</span>)</span>`;
  if ($('#pspLinkScanResult')) $('#pspLinkScanResult').classList.toggle('hidden', !!cfg.linksOnly);
  if (!pspState.links.length) { box.innerHTML = '<div class="empty" style="padding:14px">Trống</div>'; return; }
  box.innerHTML = '<div class="psp-phone-list">' + pspState.links.map((l, i) => {
    const scanBtn = cfg.linksOnly ? '' : `<button class="btn-ghost" data-scan="${i}" style="padding:3px 8px;font-size:11px">Quét</button>`;
    return `<div class="psp-phone-row"><span class="idx">${i + 1}</span><span style="flex:1;font-size:12px">${escapeHtml(l)}</span>${scanBtn}<span class="x" data-i="${i}">✕</span></div>`;
  }).join('') + '</div>';
  box.querySelectorAll('.x').forEach(x => x.onclick = () => { pspState.links.splice(+x.dataset.i, 1); renderPspLinks(); });
  box.querySelectorAll('[data-scan]').forEach(b => b.onclick = () => scanPspLink(pspState.links[+b.dataset.scan]));
}

async function scanPspLink(link) {
  if (!link) return;
  const box = $('#pspLinkScanResult');
  box.innerHTML = '<div class="status-line">Đang quét thành viên từ link...</div>';
  const r = await api('/api/chat/group-link-members', { method: 'POST', body: { ownId: state.ownId, link } });
  if (!r.ok) { box.innerHTML = `<div class="status-line err">Lỗi: ${escapeHtml(r.error)}</div>`; return; }
  const g = r.data.group || {};
  const mems = r.data.members || [];
  pspState.scannedFromLinks = mems;
  pspState.members = mems;
  pspState.selectedMembers = isMessageMemberLabelPage() ? new Set() : new Set(mems.map(m => m.userId));
  if (isMessageMemberLabelPage()) {
    await loadPspMemberLabels();
    $('#pspGroupChosenName').textContent = g.name || 'Nhóm qua link';
    $('#pspGroupActions').classList.remove('hidden');
    $('#pspLoadMemBtn').classList.add('hidden');
    $('#pspMemSection').classList.remove('hidden');
    renderPspMembers();
    box.innerHTML = `<div class="status-line ok">Quét xong: <b>${escapeHtml(g.name || 'nhóm')}</b> — ${mems.length}/${g.totalMember || '?'} TV. Hãy lọc nhãn và chọn thành viên bên dưới trước khi gửi.</div>`;
    return;
  }
  box.innerHTML = `<div class="status-line ok">Quét xong: <b>${escapeHtml(g.name || 'nhóm')}</b> — ${mems.length}/${g.totalMember || '?'} TV (đã chọn tất cả).</div>
    <div class="psp-pick-list" style="margin-top:10px;max-height:240px">
      ${mems.slice(0, 100).map(m => `<div class="psp-pick-row">
        <div class="avatar" ${m.avatar ? `style="background-image:url('${m.avatar}')"` : ''}>${m.avatar ? '' : escapeHtml(avatarText(m.displayName || m.userId))}</div>
        <div class="nm">${escapeHtml(m.displayName || m.userId)}</div>
        <div class="uid">${m.userId.slice(-10)}</div>
      </div>`).join('')}
      ${mems.length > 100 ? `<div class="status-line" style="padding:8px">... và ${mems.length - 100} TV khác</div>` : ''}
    </div>`;
}

async function runCampaign(id, total = 0, remaining = total) {
  if (pspState.action === 'grp-leave') {
    const quantity = remaining || total;
    const verb = remaining < total ? 'Tiếp tục rời' : 'Bắt đầu rời';
    if (!confirm(`${verb} ${quantity ? `${quantity} nhóm` : 'các nhóm đã chọn'} trong chiến dịch này? Hành động đã thực hiện sẽ không thể hoàn tác.`)) return;
  }
  const r = await api(`/api/chat/campaigns/${id}/run`, { method: 'POST' });
  if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
  currentTaskId = r.taskId;
  const resumed = r.resumeFrom > 0;
  toast(resumed
    ? `Tiếp tục từ vị trí ${r.resumeFrom}/${r.total} (còn ${r.total - r.resumeFrom})`
    : `Đã bắt đầu chiến dịch (${r.total} target)`, 'ok');
  loadCampaigns();
}

async function stopCampaign(id) {
  if (!confirm('Dừng chiến dịch này? Có thể bấm "Tiếp tục" sau để chạy lại từ chỗ dừng.')) return;
  const r = await api(`/api/chat/campaigns/${id}/stop`, { method: 'POST' });
  if (!r.ok) return toast('Lỗi: ' + (r.error || ''), 'err');
  toast(r.message || 'Đã yêu cầu dừng', 'ok');
  setTimeout(() => loadCampaigns(), 1000);
}

async function resetCampaign(id) {
  if (!confirm('Reset chiến dịch về 0 và gửi lại TẤT CẢ từ đầu?')) return;
  const r = await api(`/api/chat/campaigns/${id}/reset`, { method: 'POST' });
  if (!r.ok) return toast('Lỗi: ' + (r.error || ''), 'err');
  toast('Đã reset. Bấm "Bắt đầu" để chạy lại.', 'ok');
  loadCampaigns();
}

async function editCampaign(id) {
  const r = await api(`/api/chat/campaigns/detail/${id}`);
  if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
  const c = r.data;
  pspState.editingId = id;
  const cfg = PAGE_TITLES[pspState.action];
  await showCampaignForm(cfg);
  $('#pspName').value = c.name;
  const conf = c.config || {};
  $('#pspContent').value = conf.content || '';
  $('#pspDelayMin').value = Math.round((conf.delay || 15000) / 1000);
  $('#pspDelayMax').value = Math.round((conf.delayMax || 20000) / 1000);
  $('#pspSwitchAfter').value = conf.switchAfter || 5;
  $('#pspPauseAfter').value = conf.pauseAfter || 2;
  $('#pspPauseSec').value = conf.pauseSec || 10;
  $('#pspQuota').value = conf.quota || 50;
  $('#pspQuotaPer').value = Number.isFinite(Number(conf.quotaPer)) ? Number(conf.quotaPer) : 1;
  $('#pspQuotaUnit').value = conf.quotaUnit || (conf.quotaPer === 'hour' ? 'hour' : 'day');
  $('#pspAutoFriend').checked = !!conf.autoFriend;
  $('#pspDedupe').checked = !!conf.dedupe;
  if (['msg-phone', 'grp-invite-phone', 'friend-phone', 'friend-backup'].includes(pspState.action)) { pspState.phones = c.targets || []; renderPspPhones(); }
  else if (['msg-friends', 'grp-invite-friend', 'friend-undo', 'friend-remove'].includes(pspState.action)) { pspState.selectedFriends = new Set(c.targets || []); renderPspFriends(); }
  else if (pspState.action === 'grp-leave') { pspState.selectedGroupsMulti = new Set(c.targets || []); renderPspGroupsMulti(); }
  else { pspState.selectedMembers = new Set(c.targets || []); renderPspMembers(); }
  if (conf.groupIds && Array.isArray(conf.groupIds)) { pspState.selectedGroupsMulti = new Set(conf.groupIds); renderPspGroupsMulti(); }
}

async function cloneCampaign(id) {
  await editCampaign(id);
  pspState.editingId = null;
  $('#pspName').value = ($('#pspName').value || '') + ' (Sao chép)';
  toast('Đã clone — bấm Lưu để tạo mới', 'info');
}

async function deleteCampaign(id) {
  if (!confirm('Xoá chiến dịch này?')) return;
  await fetch(`/api/chat/campaigns/${id}`, { method: 'DELETE' });
  toast('Đã xoá', 'ok');
  loadCampaigns();
}

function bindPspHandlers(cfg) {
  $('#pspRefreshBtn').onclick = loadCampaigns;
  $('#pspNewBtn').onclick = () => { pspState.editingId = null; showCampaignForm(cfg); };
  $('#pspBackBtn').onclick = () => { setPspView('list'); loadCampaigns(); };
  $('#pspSubmitBtn').onclick = submitSendByPhone;
  $('#pspAddPhoneBtn').onclick = () => {
    const v = $('#pspPhoneInput').value.trim();
    if (!v) return;
    pspState.phones.push(...v.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean));
    $('#pspPhoneInput').value = '';
    if ($('#pspDedupe').checked) pspState.phones = [...new Set(pspState.phones)];
    renderPspPhones();
  };
  $('#pspPhoneInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#pspAddPhoneBtn').click(); } };
  $('#pspUploadTxtBtn').onclick = () => $('#pspTxtFile').click();
  $('#pspTxtFile').onchange = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const cfg = PAGE_TITLES[pspState.action] || {};
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || '');
      let parsed;
      if (cfg.acceptUids) {
        const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
        const header = lines[0] || '';
        const startIdx = /userid|user_id|uid/i.test(header) ? 1 : 0;
        parsed = lines.slice(startIdx).map(line => {
          const first = line.split(/[,;\t]/)[0] || '';
          return first.replace(/^"|"$/g, '').trim();
        }).filter(s => /^\d{6,}/.test(s));
      } else {
        parsed = raw.split(/[\s,;\n]+/).map(s => s.replace(/[^0-9+]/g, '')).filter(s => s.length >= 9);
      }
      pspState.phones.push(...parsed);
      if ($('#pspDedupe').checked) pspState.phones = [...new Set(pspState.phones)];
      renderPspPhones();
    };
    reader.readAsText(f);
    e.target.value = '';
  };
  $('#pspUploadBox').onclick = () => $('#pspFiles').click();
  $('#pspFiles').onchange = (e) => {
    pspState.files = Array.from(e.target.files || []);
    $('#pspFileList').innerHTML = pspState.files.map(f => `<div>${escapeHtml(f.name)} (${(f.size/1024).toFixed(0)} KB)</div>`).join('');
  };
  $('#pspDedupe').onchange = () => { if ($('#pspDedupe').checked) { pspState.phones = [...new Set(pspState.phones)]; renderPspPhones(); } };
  $('#pspDynamic').onchange = () => $('#pspDynamicBox').classList.toggle('hidden', !$('#pspDynamic').checked);

  $('#pspFriendSearch').oninput = renderPspFriends;
  $('#pspFriendSelectAll').onclick = () => {
    // Chỉ chọn các friend đang khớp filter + search hiện tại
    const q = ($('#pspFriendSearch').value || '').toLowerCase();
    const filter = pspState.friendFilter || 'all';
    const labelFilter = pspState.friendLabelFilter || 'all';
    pspState.friends.forEach(f => {
      if (q && !(f.displayName || f.zaloName || '').toLowerCase().includes(q) && !String(f.userId).includes(q)) return;
      if (filter !== 'all' && getFriendTier(f) !== filter) return;
      if (labelFilter !== 'all' && !(f.labels || []).includes(labelFilter)) return;
      pspState.selectedFriends.add(String(f.userId || f.uid));
    });
    renderPspFriends();
  };
  $('#pspFriendClear').onclick = () => { pspState.selectedFriends.clear(); renderPspFriends(); };
  $('#pspLoadMemBtn').onclick = loadPspMembers;
  $('#pspGroupSearch').oninput = renderPspGroups;
  if ($('#pspGroupsMultiSearch')) {
    $('#pspGroupsMultiSearch').oninput = renderPspGroupsMulti;
    $('#pspGroupsMultiSelectAll').onclick = () => {
      const q = ($('#pspGroupsMultiSearch').value || '').toLowerCase().trim();
      const sizeF = pspState.groupSizeFilter || 'all';
      const actF = pspState.groupActFilter || 'all';
      pspState.groups.forEach(g => {
        if (q && !(g.name || '').toLowerCase().includes(q)) return;
        if (sizeF !== 'all' && getGroupSize(g) !== sizeF) return;
        if (actF !== 'all' && getGroupActivity(g) !== actF) return;
        pspState.selectedGroupsMulti.add(g.id);
      });
      renderPspGroupsMulti();
    };
    $('#pspGroupsMultiClear').onclick = () => { pspState.selectedGroupsMulti.clear(); renderPspGroupsMulti(); };
  }
  if ($('#pspLinkAddBtn')) {
    $('#pspLinkAddBtn').onclick = () => {
      const v = $('#pspLinkInput').value.trim();
      if (!v) return;
      pspState.links.push(...v.split(/[\s,;]+/).filter(Boolean));
      $('#pspLinkInput').value = '';
      renderPspLinks();
    };
    $('#pspLinkInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#pspLinkAddBtn').click(); } };
    $('#pspLinkUploadBtn').onclick = () => $('#pspLinkFile').click();
    $('#pspLinkFile').onchange = (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        pspState.links.push(...String(reader.result || '').split(/\n+/).map(s => s.trim()).filter(s => s.startsWith('http') || s.includes('zalo.me')));
        renderPspLinks();
      };
      reader.readAsText(f);
      e.target.value = '';
    };
  }
  $('#pspMemFriendOnly').onchange = renderPspMembers;
  $('#pspMemSearch').oninput = renderPspMembers;
  $('#pspMemSelectAll').onclick = () => { pspState.members.filter(filterMemRow).forEach(m => pspState.selectedMembers.add(String(m.userId || m.uid || m))); renderPspMembers(); };
  $('#pspMemClear').onclick = () => { pspState.selectedMembers.clear(); renderPspMembers(); };

  if (window.lucide) window.lucide.createIcons();
}

async function loadPspFriends() {
  if (!state.ownId) return;
  const wrap = $('#pspFriendList');
  const cfg = PAGE_TITLES[pspState.action] || {};
  const isSent = cfg.friendsSource === 'sent-requests';
  const showLabels = pspState.action === 'msg-friends';
  wrap.innerHTML = `<div class="empty" style="padding:14px">Đang tải ${isSent ? 'lời mời đã gửi' : 'bạn bè'}...</div>`;
  const endpoint = isSent ? `/api/chat/sent-requests/${state.ownId}` : `/api/chat/all-friends/${state.ownId}`;
  const [r, sr, tr, lr] = await Promise.all([
    api(endpoint),
    isSent ? Promise.resolve({ ok: false }) : api(`/api/friends/interaction-stats/${state.ownId}`),
    showLabels ? api(`/api/chat/threads/${state.ownId}?limit=10000`) : Promise.resolve({ ok: false }),
    showLabels ? api('/api/labels') : Promise.resolve({ ok: false }),
  ]);
  const raw = Array.isArray(r.data) ? r.data : (r.data?.recommendations || r.data?.list || r.data?.requests || []);
  const stats = (sr.ok && sr.data) || {};
  if (showLabels && lr.ok) state.labelsCache = lr.data || [];
  const labelsByUser = new Map();
  if (showLabels && tr.ok) {
    (tr.data || []).filter(t => Number(t.type) === 0).forEach(t => {
      try { labelsByUser.set(String(t.id), JSON.parse(t.labels || '[]')); } catch { labelsByUser.set(String(t.id), []); }
    });
  }
  pspState.friends = (raw || []).map((f, idx) => {
    const userId = String(f.userId || f.uid || f.fid || f.id || '');
    const st = stats[userId] || {};
    return {
      userId,
      displayName: f.displayName || f.zaloName || f.fullname || f.dName || '',
      zaloName: f.zaloName || '',
      avatar: f.avatar || '',
      zaloOrder: idx,  // thứ tự Zalo trả (đa số mới ở đầu)
      msgCount: st.msgCount || 0,
      lastTs: st.lastTs || 0,
      recvCount: st.recvCount || 0,
      sentCount: st.sentCount || 0,
      labels: labelsByUser.get(userId) || [],
    };
  }).filter(f => f.userId);
  const titleH3 = document.querySelector('.target-panel[data-target="friends"] h3');
  if (titleH3) titleH3.innerHTML = (cfg.friendsTitle || 'Danh sách bạn bè') + ` <span class="hint">(Đã chọn: <span id="pspFriendCount">0</span> / <span id="pspFriendTotal">${pspState.friends.length}</span>)</span>`;
  if (showLabels || cfg.hideFriendInteractionFilters) {
    pspState.friendFilter = 'all';
    pspState.friendSort = 'zalo-new';
  } else {
    if (!pspState.friendFilter) pspState.friendFilter = 'all';
    if (!pspState.friendSort) pspState.friendSort = 'zalo-new';
  }
  pspState.isSentRequests = isSent;
  pspState.showFriendLabels = showLabels;
  renderPspFriends();
}

function getFriendTier(f) {
  if (!f.msgCount) return 'none';
  const daysAgo = (Date.now() - f.lastTs) / 86400000;
  if (daysAgo > 90 || f.msgCount < 3) return 'low';
  if (daysAgo > 30) return 'medium';
  return 'high';
}

function friendlyDaysAgo(ts) {
  if (!ts) return '';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days < 1) return 'hôm nay';
  if (days < 7) return `${days} ngày trước`;
  if (days < 30) return `${Math.floor(days/7)} tuần trước`;
  if (days < 365) return `${Math.floor(days/30)} tháng trước`;
  return `${Math.floor(days/365)} năm trước`;
}

function renderPspFriends() {
  const wrap = $('#pspFriendList');
  const q = ($('#pspFriendSearch').value || '').toLowerCase();
  const filter = pspState.friendFilter || 'all';
  const labelFilter = pspState.friendLabelFilter || 'all';
  const sort = pspState.friendSort || 'zalo-new';

  let arr = pspState.friends.filter(f => {
    if (q && !(f.displayName || f.zaloName || '').toLowerCase().includes(q) && !String(f.userId).includes(q)) return false;
    if (filter !== 'all' && getFriendTier(f) !== filter) return false;
    if (labelFilter !== 'all' && !(f.labels || []).includes(labelFilter)) return false;
    return true;
  });

  if (sort === 'zalo-new') arr.sort((a, b) => a.zaloOrder - b.zaloOrder);
  else if (sort === 'zalo-old') arr.sort((a, b) => b.zaloOrder - a.zaloOrder);
  else if (sort === 'name') arr.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'vi'));
  else if (sort === 'msg-asc') arr.sort((a, b) => a.msgCount - b.msgCount);
  else if (sort === 'msg-desc') arr.sort((a, b) => b.msgCount - a.msgCount);
  else if (sort === 'last-old') arr.sort((a, b) => (a.lastTs || 0) - (b.lastTs || 0));

  $('#pspFriendCount').textContent = pspState.selectedFriends.size;

  // Trang nhắn tin theo nhãn chỉ cần lọc nhãn; các badge tương tác vẫn hữu ích trên từng dòng.
  const showInteractionUI = !pspState.isSentRequests;
  const cfg = PAGE_TITLES[pspState.action] || {};
  const showInteractionFilter = showInteractionUI && !pspState.showFriendLabels && !cfg.hideFriendInteractionFilters;

  let filterBar = '';
  if (showInteractionFilter) {
    const chips = [
      ['all', 'Tất cả', pspState.friends.length],
      ['none', 'Chưa nhắn', pspState.friends.filter(f => getFriendTier(f) === 'none').length],
      ['low', 'Ít tương tác', pspState.friends.filter(f => getFriendTier(f) === 'low').length],
      ['medium', 'Trung bình', pspState.friends.filter(f => getFriendTier(f) === 'medium').length],
      ['high', 'Tương tác nhiều', pspState.friends.filter(f => getFriendTier(f) === 'high').length],
    ];
    filterBar = `
      <div class="psp-friend-filter">
        ${chips.map(([k, lb, cnt]) => `<button class="ppf-chip ${filter === k ? 'active' : ''}" data-filter="${k}">${lb} <span class="ppf-chip-count">${cnt}</span></button>`).join('')}
        <select class="ppf-sort">
          <option value="zalo-new" ${sort === 'zalo-new' ? 'selected' : ''}>Mới quen (Zalo order)</option>
          <option value="zalo-old" ${sort === 'zalo-old' ? 'selected' : ''}>Cũ nhất (Zalo order)</option>
          <option value="name" ${sort === 'name' ? 'selected' : ''}>Tên A-Z</option>
          <option value="msg-desc" ${sort === 'msg-desc' ? 'selected' : ''}>Nhiều tin nhất</option>
          <option value="msg-asc" ${sort === 'msg-asc' ? 'selected' : ''}>Ít tin nhất</option>
          <option value="last-old" ${sort === 'last-old' ? 'selected' : ''}>Lâu chưa nhắn</option>
        </select>
      </div>`;
  }
  if (pspState.showFriendLabels) {
    const labels = state.labelsCache || [];
    const allLabeled = pspState.friends.filter(f => (f.labels || []).length).length;
    filterBar += `
      <div class="psp-filter-row ppf-label-filter">
        <span class="psp-filter-label">Nhãn dán</span>
        <button class="ppf-chip ${labelFilter === 'all' ? 'active' : ''}" data-label="all">Tất cả <span class="ppf-chip-count">${pspState.friends.length}</span></button>
        ${labels.map(lb => {
          const count = pspState.friends.filter(f => (f.labels || []).includes(lb.name)).length;
          return `<button class="ppf-chip ppf-label-chip ${labelFilter === lb.name ? 'active' : ''}" data-label="${escapeHtml(lb.name)}" style="--label-color:${escapeHtml(lb.color)}"><span class="ppf-label-dot"></span>${escapeHtml(lb.name)} <span class="ppf-chip-count">${count}</span></button>`;
        }).join('')}
        <span class="ppf-labeled-count">${allLabeled} bạn đã dán nhãn</span>
      </div>`;
  }

  const tierColor = { none: '#ef4444', low: '#f59e0b', medium: '#64748b', high: '#16a34a' };
  const rowsHtml = arr.length
    ? arr.slice(0, 300).map(f => {
        const uid = String(f.userId || '');
        const name = f.displayName || f.zaloName || uid;
        const checked = pspState.selectedFriends.has(uid) ? 'checked' : '';
        const tier = getFriendTier(f);
        const badge = showInteractionUI
          ? (tier === 'none' ? 'Chưa từng nhắn' : `${f.msgCount} tin · ${friendlyDaysAgo(f.lastTs)}`)
          : '';
        const labelBadges = pspState.showFriendLabels && (f.labels || []).length
          ? `<div class="ppf-labels">${f.labels.map(name => {
              const label = (state.labelsCache || []).find(lb => lb.name === name);
              return `<span class="ppf-label" style="--label-color:${escapeHtml(label?.color || '#94a3b8')}"><span></span>${escapeHtml(name)}</span>`;
            }).join('')}</div>`
          : '';
        return `<label class="psp-pick-row">
          <input type="checkbox" data-uid="${uid}" ${checked} />
          <div class="avatar" ${f.avatar ? `style="background-image:url('${f.avatar}')"` : ''}>${f.avatar ? '' : escapeHtml(avatarText(name))}</div>
          <div class="nm">
            ${escapeHtml(name)}
            ${badge ? `<div class="ppf-badge" style="color:${tierColor[tier]}">${badge}</div>` : ''}
            ${labelBadges}
          </div>
          <div class="uid">${uid}</div>
        </label>`;
      }).join('') + (arr.length > 300 ? `<div class="status-line" style="padding:8px">Còn ${arr.length - 300} bạn ẩn — gõ search để tìm</div>` : '')
    : '<div class="empty" style="padding:14px">Không có bạn phù hợp filter</div>';

  wrap.innerHTML = filterBar + rowsHtml;

  wrap.querySelectorAll('.ppf-chip').forEach(b => {
    b.onclick = () => {
      if (b.dataset.filter) pspState.friendFilter = b.dataset.filter;
      if (b.dataset.label) pspState.friendLabelFilter = b.dataset.label;
      renderPspFriends();
    };
  });
  const sortEl = wrap.querySelector('.ppf-sort');
  if (sortEl) sortEl.onchange = (e) => { pspState.friendSort = e.target.value; renderPspFriends(); };

  wrap.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) pspState.selectedFriends.add(cb.dataset.uid);
      else pspState.selectedFriends.delete(cb.dataset.uid);
      $('#pspFriendCount').textContent = pspState.selectedFriends.size;
    };
  });
}

async function loadPspGroups() {
  if (!state.ownId) return;
  const wrap = $('#pspGroupList');
  wrap.innerHTML = '<div class="empty" style="padding:20px">Đang tải nhóm...</div>';
  const r = await api(`/api/chat/all-groups/${state.ownId}`);
  pspState.groups = r.data || [];
  pspState.selectedGroupId = null;
  $('#pspGroupTotal').textContent = pspState.groups.length;
  $('#pspGroupActions').classList.add('hidden');
  renderPspGroups();
}

function renderPspGroups() {
  const wrap = $('#pspGroupList');
  const q = ($('#pspGroupSearch').value || '').toLowerCase().trim();
  const arr = q ? pspState.groups.filter(g => (g.name || '').toLowerCase().includes(q)) : pspState.groups;
  if (!arr.length) { wrap.innerHTML = '<div class="empty" style="padding:20px">Không tìm thấy nhóm</div>'; return; }
  wrap.innerHTML = arr.slice(0, 200).map(g => {
    const sel = pspState.selectedGroupId === g.id ? 'selected' : '';
    const avatar = g.avatar ? `style="background-image:url('${g.avatar}')"` : '';
    return `<div class="psp-group-row ${sel}" data-id="${g.id}">
      <div class="avatar" ${avatar}>${g.avatar ? '' : escapeHtml(avatarText(g.name))}</div>
      <div class="body">
        <div class="name">${escapeHtml(g.name)}</div>
        <div class="meta">${g.memberCount ? g.memberCount + ' thành viên' : '—'}</div>
      </div>
      <div class="check-mark">${sel ? '✓' : ''}</div>
    </div>`;
  }).join('') + (arr.length > 200 ? `<div class="status-line" style="padding:8px;text-align:center">Còn ${arr.length - 200} nhóm — gõ search để tìm</div>` : '');
  wrap.querySelectorAll('.psp-group-row').forEach(el => {
    el.onclick = () => {
      pspState.selectedGroupId = el.dataset.id;
      const g = pspState.groups.find(x => x.id === el.dataset.id);
      $('#pspGroupChosenName').textContent = g?.name || el.dataset.id;
      $('#pspGroupActions').classList.remove('hidden');
      $('#pspLoadMemBtn').classList.remove('hidden');
      const cfg = PAGE_TITLES[pspState.action];
      $('#pspMemFriendOnlyWrap').classList.toggle('hidden', !cfg?.friendOnly);
      renderPspGroups();
    };
  });
}

async function loadPspMembers() {
  const gid = pspState.selectedGroupId;
  if (!gid) return toast('Hãy chọn một nhóm trước', 'err');
  $('#pspMemSection').classList.remove('hidden');
  const wrap = $('#pspMemList');
  wrap.innerHTML = '<div class="empty" style="padding:14px">Đang quét thành viên (có thể mất vài giây cho nhóm lớn)...</div>';
  const r = await api(`/api/chat/group-members/${state.ownId}/${gid}`);
  pspState.links = [];
  pspState.scannedFromLinks = [];
  renderPspLinks();
  $('#pspLinkScanResult').innerHTML = '';
  pspState.members = (r.data || []).map(m => typeof m === 'string' ? { userId: m } : m);
  if (!pspState.friends.length) await loadPspFriends();
  await loadPspMemberLabels();
  pspState.selectedMembers = new Set();
  renderPspMembers();
}

function isMessageMemberLabelPage() {
  return pspState.action === 'msg-group-mem' || pspState.action === 'msg-group-other';
}

async function loadPspMemberLabels() {
  pspState.memberLabelsByUser = new Map();
  if (!isMessageMemberLabelPage()) return;
  const [lr, tr] = await Promise.all([
    api('/api/labels'),
    api(`/api/chat/labeled-users/${state.ownId}`),
  ]);
  if (lr.ok) state.labelsCache = lr.data || [];
  if (tr.ok) {
    (tr.data || []).forEach(t => {
      try { pspState.memberLabelsByUser.set(String(t.id), JSON.parse(t.labels || '[]')); } catch {}
    });
  }
}

function filterMemRow(m) {
  const q = ($('#pspMemSearch').value || '').toLowerCase();
  const wrapHidden = $('#pspMemFriendOnlyWrap')?.classList.contains('hidden');
  const friendOnly = !wrapHidden && $('#pspMemFriendOnly').checked;
  const uid = String(m.userId || m.uid || '');
  const name = (m.displayName || m.zaloName || '').toLowerCase();
  const labelFilter = pspState.memberLabelFilter || 'all';
  if (friendOnly) {
    const friendIds = new Set(pspState.friends.map(f => String(f.userId || f.uid)));
    if (!friendIds.has(uid)) return false;
  }
  if (q && !uid.includes(q) && !name.includes(q)) return false;
  if (isMessageMemberLabelPage() && labelFilter !== 'all' && !(pspState.memberLabelsByUser.get(uid) || []).includes(labelFilter)) return false;
  return true;
}

function renderPspMemberLabelFilter() {
  const box = $('#pspMemLabelFilter');
  if (!box) return;
  if (!isMessageMemberLabelPage()) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const labels = state.labelsCache || [];
  const active = pspState.memberLabelFilter || 'all';
  const hasMembers = pspState.members.length > 0;
  const countFor = (name) => pspState.members.filter(m => (pspState.memberLabelsByUser.get(String(m.userId || m.uid || '')) || []).includes(name)).length;
  const labeled = pspState.members.filter(m => (pspState.memberLabelsByUser.get(String(m.userId || m.uid || '')) || []).length).length;
  box.classList.remove('hidden');
  box.innerHTML = `
    <span class="psp-filter-label">Nhãn dán</span>
    <button class="ppf-chip ${active === 'all' ? 'active' : ''}" data-label="all">Tất cả${hasMembers ? ` <span class="ppf-chip-count">${pspState.members.length}</span>` : ''}</button>
    ${labels.map(lb => `<button class="ppf-chip ppf-label-chip ${active === lb.name ? 'active' : ''}" data-label="${escapeHtml(lb.name)}" style="--label-color:${escapeHtml(lb.color)}"><span class="ppf-label-dot"></span>${escapeHtml(lb.name)}${hasMembers ? ` <span class="ppf-chip-count">${countFor(lb.name)}</span>` : ''}</button>`).join('')}
    <span class="ppf-labeled-count">${hasMembers ? `${labeled} thành viên có nhãn` : 'Chọn nhóm và lấy danh sách TV để lọc theo nhãn'}</span>`;
  box.querySelectorAll('[data-label]').forEach(btn => {
    btn.onclick = () => {
      pspState.memberLabelFilter = btn.dataset.label;
      renderPspMembers();
    };
  });
}

function renderPspMembers() {
  const wrap = $('#pspMemList');
  const arr = pspState.members.filter(filterMemRow);
  renderPspMemberLabelFilter();
  $('#pspMemTotal').textContent = arr.length;
  $('#pspMemCount').textContent = pspState.selectedMembers.size;
  if (!arr.length) { wrap.innerHTML = '<div class="empty" style="padding:14px">Chưa có TV nào (chọn nhóm + bấm "Lấy TV")</div>'; return; }
  const friendsMap = new Map(pspState.friends.map(f => [String(f.userId || f.uid), f]));
  wrap.innerHTML = arr.slice(0, 500).map(m => {
    const uid = String(m.userId || m.uid || '');
    const f = friendsMap.get(uid);
    const name = m.displayName || m.zaloName || f?.displayName || f?.zaloName || ('User ' + uid.slice(-6));
    const avatar = m.avatar || f?.avatar || '';
    const checked = pspState.selectedMembers.has(uid) ? 'checked' : '';
    const labels = isMessageMemberLabelPage() ? (pspState.memberLabelsByUser.get(uid) || []) : [];
    const labelBadges = labels.length ? `<div class="ppf-labels">${labels.map(labelName => {
      const label = (state.labelsCache || []).find(lb => lb.name === labelName);
      return `<span class="ppf-label" style="--label-color:${escapeHtml(label?.color || '#94a3b8')}"><span></span>${escapeHtml(labelName)}</span>`;
    }).join('')}</div>` : '';
    return `<label class="psp-pick-row">
      <input type="checkbox" data-uid="${uid}" ${checked} />
      <div class="avatar" ${avatar ? `style="background-image:url('${avatar}')"` : ''}>${avatar ? '' : escapeHtml(avatarText(name))}</div>
      <div class="nm">${escapeHtml(name)}${f ? ' <span style="font-size:10px;color:var(--success);font-weight:600">● bạn</span>' : ''}${labelBadges}</div>
      <div class="uid">${uid.slice(-10)}</div>
    </label>`;
  }).join('') + (arr.length > 500 ? `<div class="status-line" style="padding:8px">Còn ${arr.length - 500} TV ẩn</div>` : '');
  wrap.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) pspState.selectedMembers.add(cb.dataset.uid);
      else pspState.selectedMembers.delete(cb.dataset.uid);
      $('#pspMemCount').textContent = pspState.selectedMembers.size;
    };
  });
}

function renderPspPhones() {
  const box = $('#pspPhoneList');
  $('#pspCount').textContent = pspState.phones.length;
  if (!pspState.phones.length) { box.innerHTML = '<div class="empty" style="padding:14px">Trống</div>'; return; }
  box.innerHTML = '<div class="psp-phone-list">' + pspState.phones.map((p, i) =>
    `<div class="psp-phone-row"><span class="idx">${i + 1}</span><span>${escapeHtml(p)}</span><span class="x" data-i="${i}">✕</span></div>`
  ).join('') + '</div>';
  box.querySelectorAll('.x').forEach(x => x.onclick = () => { pspState.phones.splice(+x.dataset.i, 1); renderPspPhones(); });
}

function renderPspAccounts() {
  const box = $('#pspAccTable');
  if (!state.accounts.length) {
    box.innerHTML = `<div class="empty" style="padding:18px;text-align:center">
      <div style="margin-bottom:10px">Chưa có tài khoản Zalo nào</div>
      <button class="btn-primary" onclick="openModal('modalAddAcc')">+ Thêm tài khoản</button>
    </div>`;
    return;
  }
  box.innerHTML = state.accounts.map(a => {
    const active = a.ownId === state.ownId;
    return `<div class="psp-acc-row ${active ? 'active' : ''}" data-id="${a.ownId}">
      <div class="avatar" ${a.avatar ? `style="background-image:url('${a.avatar}')"` : ''}>${a.avatar ? '' : escapeHtml(avatarText(a.name || 'Acc'))}</div>
      <div style="flex:1;min-width:0">
        <div class="nm">${escapeHtml(a.name || 'Acc')}${active ? ' <span style="font-size:10px;color:var(--primary);font-weight:600;margin-left:4px">● Đang dùng</span>' : ''}</div>
        <div class="meta">${a.ownId}</div>
      </div>
      <div class="status ${a.connected ? '' : 'off'}">${a.connected ? 'Hoạt động' : 'Mất kết nối'}</div>
    </div>`;
  }).join('');
  box.querySelectorAll('.psp-acc-row').forEach(el => {
    el.onclick = async () => {
      const newId = el.dataset.id;
      if (newId === state.ownId) return;
      await selectAccount(newId);
      renderPspAccounts();
      // Reload groups/friends của account mới
      const cfg = PAGE_TITLES[pspState.action] || {};
      const targets = [cfg.target, cfg.extraTarget].filter(Boolean);
      if (targets.includes('friends')) await loadPspFriends();
      if (targets.includes('group-mem')) await loadPspGroups();
      if (targets.includes('groups-multi')) await loadPspGroupsMulti();
    };
  });
}

async function submitSendByPhone() {
  if (!state.ownId) return toast('Chưa có tài khoản', 'err');
  const name = $('#pspName').value.trim();
  const content = $('#pspContent').value.trim();
  const dyn = $('#pspDynamic').checked;
  const dynList = dyn ? $('#pspDynamicList').value.split(/\n+/).map(s => s.trim()).filter(Boolean) : [];
  const cfg = PAGE_TITLES[pspState.action] || {};
  if (!cfg.directExecute && !name) return toast('Cần điền Tên yêu cầu', 'err');
  if (!cfg.noContent && !content && !dynList.length) return toast('Cần nội dung tin nhắn', 'err');

  const action = pspState.action;
  let targets = [];
  if (action === 'msg-phone' || action === 'friend-phone' || action === 'friend-backup') {
    targets = pspState.phones.slice();
    if ($('#pspDedupe').checked) targets = [...new Set(targets)];
    const unit = action === 'friend-backup' ? 'User ID' : 'số điện thoại';
    if (!targets.length) return toast('Cần ít nhất 1 ' + unit, 'err');
  } else if (action === 'msg-friends' || action === 'friend-undo' || action === 'friend-remove') {
    targets = [...pspState.selectedFriends];
    if (!targets.length) return toast('Cần chọn ít nhất 1 bạn', 'err');
  } else if (action === 'msg-group-mem' || action === 'friend-group') {
    targets = [...pspState.selectedMembers];
    if (!targets.length) return toast('Cần chọn ít nhất 1 thành viên', 'err');
  } else if (action === 'msg-group-other' || action === 'friend-group-other') {
    if (!pspState.links.length) return toast('Cần ít nhất 1 link nhóm', 'err');
    targets = [...pspState.selectedMembers];
    if (!targets.length) return toast('Bấm "Quét" trên link để lấy TV trước', 'err');
  } else if (action === 'grp-join') {
    targets = pspState.links.slice();
    if (!targets.length) return toast('Cần ít nhất 1 link nhóm', 'err');
  } else if (action === 'grp-msg') {
    targets = [...pspState.selectedGroupsMulti];
    if (!targets.length) return toast('Cần chọn ít nhất 1 nhóm', 'err');
  } else if (action === 'grp-invite-phone') {
    targets = pspState.phones.slice();
    if (!targets.length) return toast('Cần ít nhất 1 số điện thoại', 'err');
    if (!pspState.selectedGroupsMulti.size) return toast('Cần chọn ít nhất 1 nhóm để mời', 'err');
  } else if (action === 'grp-invite-friend') {
    targets = [...pspState.selectedFriends];
    if (!targets.length) return toast('Cần chọn ít nhất 1 bạn để mời', 'err');
    if (!pspState.selectedGroupsMulti.size) return toast('Cần chọn ít nhất 1 nhóm đích để mời vào', 'err');
  } else if (action === 'grp-invite-other') {
    if (!pspState.links.length) return toast('Cần ít nhất 1 link nhóm khác', 'err');
    targets = [...pspState.selectedMembers];
    if (!targets.length) return toast('Bấm "Quét" trên link để lấy TV trước', 'err');
    if (!pspState.selectedGroupsMulti.size) return toast('Cần chọn ít nhất 1 nhóm đích để mời vào', 'err');
  } else if (action === 'grp-leave') {
    targets = [...pspState.selectedGroupsMulti];
    if (!targets.length) return toast('Cần chọn ít nhất 1 nhóm để rời', 'err');
  }

  const delayMin = (+$('#pspDelayMin').value || 15) * 1000;
  const delayMax = (+$('#pspDelayMax').value || 20) * 1000;
  const params = {
    name, content,
    dynamic: dyn ? dynList : null,
    delay: delayMin,
    delayMax,
    autoFriend: $('#pspAutoFriend').checked,
    autoEmoji: $('#pspAutoEmoji').checked,
    naturalize: $('#pspNaturalize')?.checked !== false,
    obfuscate: $('#pspObfuscate')?.checked !== false,
    quota: +$('#pspQuota').value || 0,
    quotaPer: +($('#pspQuotaPer')?.value || 1),
    quotaUnit: $('#pspQuotaUnit').value,
    switchAfter: +$('#pspSwitchAfter').value || 0,
    pauseAfter: +$('#pspPauseAfter').value || 0,
    pauseSec: +($('#pspPauseSec')?.value || 0),
    groupIds: pspState.selectedGroupsMulti.size ? [...pspState.selectedGroupsMulti] : undefined,
  };
  if (cfg.directExecute) {
    const r = await api('/api/chat/bulk-action', { method: 'POST', body: { ownId: state.ownId, action, targets, params } });
    if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
    currentTaskId = r.taskId;
    toast(`Đã bắt đầu (${r.total} mục)`, 'ok');
    if (action === 'grp-leave') {
      const leftSet = new Set(targets);
      pspState.groups = pspState.groups.filter(g => !leftSet.has(g.id));
      pspState.selectedGroupsMulti = new Set();
      $('#pspGroupsMultiTotal').textContent = pspState.groups.length;
      renderPspGroupsMulti();
      pspState.refreshOnTaskDone = 'groups';
    }
    return;
  }
  const body = { ownId: state.ownId, action, name, config: params, targets };
  let saveR;
  if (pspState.editingId) {
    saveR = await api(`/api/chat/campaigns/${pspState.editingId}`, { method: 'PATCH', body });
  } else {
    saveR = await api('/api/chat/campaigns', { method: 'POST', body });
  }
  if (!saveR.ok) return toast('Lỗi lưu: ' + saveR.error, 'err');
  toast(pspState.editingId ? 'Đã cập nhật chiến dịch' : 'Đã lưu chiến dịch', 'ok');
  setPspView('list');
  await loadCampaigns();
}

function setupTopbar() {
  const t = document.getElementById('sidebarToggleBtn');
  const syncSidebarToggleLabel = () => {
    if (!t) return;
    const collapsed = document.body.classList.contains('nav-collapsed');
    const text = collapsed ? 'Mở rộng' : 'Thu gọn';
    const title = collapsed ? 'Mở rộng sidebar' : 'Thu gọn sidebar';
    const label = t.querySelector('.sidebar-toggle-label');
    if (label) label.textContent = text;
    t.title = title;
    t.setAttribute('aria-label', title);
  };
  if (t) {
    syncSidebarToggleLabel();
    t.onclick = () => {
      document.body.classList.toggle('nav-collapsed');
      syncSidebarToggleLabel();
    };
  }
  const n = document.getElementById('newAccBtn');
  if (n) n.onclick = () => openModal('modalAddAcc');
  const s = document.getElementById('syncThreadsBtn');
  if (s) s.onclick = () => syncThreadsNow(false);
}

function setupTheme() {
  const saved = localStorage.getItem('za_theme') || 'light';
  if (saved === 'dark') document.documentElement.classList.add('dark');
  updateThemeIcon();
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.onclick = () => {
    document.documentElement.classList.toggle('dark');
    const isDark = document.documentElement.classList.contains('dark');
    localStorage.setItem('za_theme', isDark ? 'dark' : 'light');
    updateThemeIcon();
  };
}
function updateThemeIcon() {
  const isDark = document.documentElement.classList.contains('dark');
  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;
  btn.innerHTML = `<i data-lucide="${isDark ? 'moon' : 'sun'}"></i>`;
  if (window.lucide) window.lucide.createIcons();
}

const ROUTE_TO_ACTION = {
  '/chat': 'chat-overview',
  '/chat/labels': 'chat-labels',
  '/zalo-accounts': 'acc-list',
  '/zalo-accounts/labels': 'acc-labels',
  '/fanpage': 'fanpage',
  '/lich-trinh': 'schedule',
  '/nhan-tin/sdt': 'msg-phone',
  '/nhan-tin/ban-be': 'msg-friends',
  '/nhan-tin/tv-nhom': 'msg-group-mem',
  '/ket-ban/sdt': 'friend-phone',
  '/ket-ban/tv-nhom': 'friend-group',
  '/ket-ban/tv-nhom-khac': 'friend-group-other',
  '/ket-ban/tu-file-backup': 'friend-backup',
  '/ket-ban/thu-hoi': 'friend-undo',
  '/ket-ban/xoa-ban': 'friend-remove',
  '/nhom/tham-gia': 'grp-join',
  '/nhom/nhan-tin': 'grp-msg',
  '/nhom/moi-sdt': 'grp-invite-phone',
  '/nhom/moi-ban-be': 'grp-invite-friend',
  '/nhom/moi-tv-khac': 'grp-invite-other',
  '/nhom/roi-nhom': 'grp-leave',
  '/loi-moi-ket-ban': 'invites',
  '/tu-dong-tra-loi': 'autoreply-mgmt',
  '/backup-ban-be': 'backup',
  '/cai-dat': 'settings',
};
const ACTION_TO_ROUTE = Object.fromEntries(Object.entries(ROUTE_TO_ACTION).map(([k, v]) => [v, k]));

function setupNavRail() {
  document.querySelectorAll('[data-action]').forEach(el => {
    const href = el.getAttribute('href') || ACTION_TO_ROUTE[el.dataset.action];
    el.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const action = el.dataset.action;
      if (href && href !== location.pathname) {
        history.pushState({ action }, '', href);
        routeToCurrentPath();
      } else {
        handleNavAction(action, el);
      }
    };
  });
  document.querySelectorAll('.nav-head[data-grp]').forEach(head => {
    head.onclick = (e) => {
      if (head.dataset.action) return;
      head.parentElement.classList.toggle('collapsed');
    };
  });
  window.addEventListener('popstate', () => {
    routeToCurrentPath();
  });
  routeToCurrentPath();
}

const PAGE_VIEW_ACTIONS = {
  'msg-phone': 'pageSendByPhone',
  'msg-friends': 'pageSendByPhone',
  'msg-group-mem': 'pageSendByPhone',
  'msg-group-other': 'pageSendByPhone',
  'friend-phone': 'pageSendByPhone',
  'friend-group': 'pageSendByPhone',
  'friend-group-other': 'pageSendByPhone',
  'friend-backup': 'pageSendByPhone',
  'friend-undo': 'pageSendByPhone',
  'friend-remove': 'pageSendByPhone',
  'grp-join': 'pageSendByPhone',
  'grp-msg': 'pageSendByPhone',
  'grp-invite-phone': 'pageSendByPhone',
  'grp-invite-friend': 'pageSendByPhone',
  'grp-invite-other': 'pageSendByPhone',
  'grp-leave': 'pageSendByPhone',
  'invites': 'pageInvites',
  'autoreply-mgmt': 'pageAutoReply',
  'backup': 'pageBackup',
  'settings': 'pageSettings',
  'acc-list': 'pageAccounts',
  'fanpage': 'pageFanpage',
};
const PAGE_TITLES = {
  'msg-phone': { title: 'Nhắn tin - Theo số điện thoại', target: 'phones', icon: 'send' },
  'msg-friends': { title: 'Nhắn tin - Bạn bè và nhãn dán', target: 'friends', friendsTitle: 'Danh sách bạn bè và nhãn dán', icon: 'send' },
  'msg-group-mem': { title: 'Nhắn tin - Thành viên nhóm và nhãn dán', target: 'group-mem', extraTarget: 'group-link', linksTitle: 'Nhóm qua link', icon: 'send' },
  'msg-group-other': { title: 'Nhắn tin - Thành viên nhóm và nhãn dán', target: 'group-mem', extraTarget: 'group-link', linksTitle: 'Nhóm qua link', icon: 'send' },
  'friend-phone': { title: 'Kết bạn - Theo số điện thoại', target: 'phones', icon: 'user-plus', contentLabel: 'Lời chào kèm theo lời mời kết bạn', contentPlaceholder: 'Xin chào, mình muốn kết bạn để trao đổi thêm ạ' },
  'friend-group': { title: 'Kết bạn - Theo thành viên nhóm', target: 'group-mem', icon: 'user-plus', contentLabel: 'Lời chào kèm theo lời mời kết bạn', contentPlaceholder: 'Xin chào, mình muốn kết bạn để trao đổi thêm ạ' },
  'friend-group-other': { title: 'Kết bạn - Theo TV nhóm khác', target: 'group-link', icon: 'user-plus', contentLabel: 'Lời chào kèm theo lời mời kết bạn', contentPlaceholder: 'Xin chào, mình muốn kết bạn để trao đổi thêm ạ' },
  'friend-backup': { title: 'Kết bạn - Từ file backup', target: 'phones', icon: 'file-up', contentLabel: 'Lời chào kèm theo lời mời kết bạn', contentPlaceholder: 'Xin chào, mình muốn kết bạn ạ', targetTitle: 'Danh sách User ID từ file backup', targetPlaceholder: 'Nhập User ID hoặc upload CSV backup', acceptUids: true },
  'friend-undo': { title: 'Kết bạn - Thu hồi lời mời', target: 'friends', icon: 'undo-2', noContent: true, friendsSource: 'sent-requests', friendsTitle: 'Danh sách lời mời đã gửi' },
  'friend-remove': { title: 'Kết bạn - Xoá bạn', target: 'friends', icon: 'user-x', noContent: true, friendsTitle: 'Danh sách bạn bè', danger: true },
  'grp-join': { title: 'Nhóm - Tham gia nhóm', target: 'group-link', icon: 'log-in', noContent: true, linksOnly: true, linksTitle: 'Danh sách nhóm cần tham gia' },
  'grp-msg': { title: 'Nhóm - Nhắn tin nhóm', target: 'groups-multi', icon: 'message-square', contentLabel: 'Nội dung tin nhắn', contentPlaceholder: 'Nhập nội dung tin nhắn gửi nhóm' },
  'grp-invite-phone': { title: 'Nhóm - Mời qua số điện thoại', target: 'phones', extraTarget: 'groups-multi', icon: 'phone-incoming', noContent: true, groupsTitle: '1. Chọn nhóm đích', targetTitle: '2. Nhập số điện thoại cần mời' },
  'grp-invite-friend': { title: 'Nhóm - Mời bạn bè vào nhóm', target: 'friends', extraTarget: 'groups-multi', friendsTitle: '2. Chọn bạn bè cần mời', groupsTitle: '1. Chọn nhóm đích', hideFriendInteractionFilters: true, icon: 'user-plus', noContent: true },
  'grp-invite-other': { title: 'Nhóm - Mời thành viên nhóm khác vào nhóm', target: 'group-link', extraTarget: 'groups-multi', icon: 'users', noContent: true, groupsTitle: '1. Chọn nhóm đích', linksTitle: '2. Chọn nhóm nguồn và thành viên cần mời' },
  'grp-leave': { title: 'Nhóm - Rời nhóm', target: 'groups-multi', icon: 'log-out', noContent: true, destructiveRun: true, targetTitle: 'Danh sách nhóm của tôi' },
};

function routeToCurrentPath() {
  const path = location.pathname;
  if (path === '/nhan-tin/tv-nhom-khac') {
    history.replaceState({}, '', '/nhan-tin/tv-nhom');
    return routeToCurrentPath();
  }
  const action = ROUTE_TO_ACTION[path];
  document.querySelectorAll('.nav-item.active, .nav-head.active').forEach(x => x.classList.remove('active'));
  const target = document.querySelector(`[data-action="${action}"]`);
  if (target) target.classList.add('active');
  updateTopbarTitle();
  document.querySelectorAll('.page-view').forEach(p => p.classList.add('hidden'));
  $('#chatMain').classList.remove('hidden');
  document.body.classList.remove('page-active');
  if (action && PAGE_VIEW_ACTIONS[action]) {
    closeModal();
    // Đóng AI panel khi chuyển sang trang khác (không phải chat) — tránh layout vỡ
    if (typeof closeAiPanel === 'function') closeAiPanel();
    $('#chatMain').classList.add('hidden');
    $('#' + PAGE_VIEW_ACTIONS[action]).classList.remove('hidden');
    document.body.classList.add('page-active');
    if (action === 'invites') initInvitesPage();
    else if (action === 'backup') initBackupPage();
    else if (action === 'settings') initSettingsPage();
    else if (action === 'autoreply-mgmt') initAutoReplyMgmtPage();
    else if (action === 'acc-list') initAccountsPage();
    else if (action === 'fanpage') initFanpagePage();
    else initSendByPhonePage(action);
    return;
  }
  if (action && action !== 'chat-overview') {
    handleNavAction(action, target);
  }
}

function updateTopbarTitle() {
  const path = location.pathname;
  const action = ROUTE_TO_ACTION[path];
  const target = document.querySelector(`[data-action="${action}"]`);
  let breadcrumb = '';
  if (target) {
    const grp = target.closest('.nav-group');
    const sec = target.closest('.nav-section');
    const grpHead = grp && grp.querySelector('.nav-head .nav-lb');
    const grpName = grpHead ? grpHead.textContent : '';
    const itemName = target.querySelector('.nav-lb')?.textContent || target.textContent.trim();
    const secLabel = sec && sec.querySelector('.nav-section-label');
    breadcrumb = (secLabel ? secLabel.textContent + ' · ' : '') + (grpName && grpName !== itemName ? grpName + ' · ' : '') + itemName;
  }
  const t = document.getElementById('topbarTitle');
  if (t) t.textContent = breadcrumb || 'Chat';
}

const ACTION_CFG = {
  'msg-phone': { title: 'Nhắn tin theo Số điện thoại', desc: 'Tự tìm Zalo từ SĐT rồi gửi tin nhắn.', fields: [{ id: 'targets', type: 'textarea', label: 'Danh sách SĐT (mỗi dòng 1 số)' }, { id: 'content', type: 'textarea', label: 'Nội dung' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 4000 }] },
  'msg-friends': { title: 'Nhắn tin theo Bạn bè và nhãn dán', desc: 'Chọn bạn bè theo nhãn đã gắn trong hội thoại để gửi tin.', fields: [{ id: 'targets', type: 'textarea', label: 'Danh sách User ID' }, { id: 'content', type: 'textarea', label: 'Nội dung' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 4000 }] },
  'msg-group-mem': { title: 'Nhắn tin theo Thành viên nhóm và nhãn dán', desc: 'Lấy thành viên từ nhóm của tôi hoặc nhóm qua link, lọc theo nhãn rồi gửi tin riêng.', fields: [{ id: 'targets', type: 'hidden-array', value: [1] }, { id: 'groupId', type: 'group-picker', label: 'Chọn nhóm nguồn' }, { id: 'content', type: 'textarea', label: 'Nội dung' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 5000 }] },
  'msg-group-mem-friend': { title: 'Nhắn tin TV nhóm đã kết bạn', desc: 'Nhập User ID đã là bạn (từ danh sách bạn bè).', fields: [{ id: 'targets', type: 'textarea', label: 'Danh sách User ID' }, { id: 'content', type: 'textarea', label: 'Nội dung' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 4000 }] },
  'friend-phone': { title: 'Kết bạn theo Số điện thoại', desc: 'Tìm Zalo từ SĐT rồi gửi lời mời kết bạn.', fields: [{ id: 'targets', type: 'textarea', label: 'Danh sách SĐT' }, { id: 'greeting', type: 'textarea', label: 'Lời chào', default: 'Xin chào, mình muốn kết bạn ạ' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 8000 }] },
  'friend-group': { title: 'Kết bạn thành viên nhóm', desc: 'Quét thành viên 1 nhóm rồi gửi lời mời kết bạn.', fields: [{ id: 'targets', type: 'hidden-array', value: [1] }, { id: 'groupId', type: 'group-picker', label: 'Chọn nhóm' }, { id: 'greeting', type: 'textarea', label: 'Lời chào', default: 'Xin chào, mình muốn kết bạn ạ' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 8000 }] },
  'friend-undo': { title: 'Thu hồi lời mời kết bạn', desc: 'Huỷ những lời mời đã gửi đi.', fields: [{ id: 'targets', type: 'textarea', label: 'Danh sách User ID' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 3000 }] },
  'friend-remove': { title: 'Xoá bạn hàng loạt', desc: 'Xoá khỏi danh bạ Zalo.', fields: [{ id: 'targets', type: 'textarea', label: 'Danh sách User ID' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 3000 }] },
  'grp-join': { title: 'Tham gia nhóm', desc: 'Dán link mời nhóm (mỗi dòng 1 link).', fields: [{ id: 'targets', type: 'textarea', label: 'Link nhóm' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 5000 }] },
  'grp-msg': { title: 'Nhắn tin nhóm hàng loạt', desc: 'Gửi cùng 1 tin tới nhiều nhóm.', fields: [{ id: 'targets', type: 'textarea', label: 'Group ID' }, { id: 'content', type: 'textarea', label: 'Nội dung' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 4000 }] },
  'grp-invite-phone': { title: 'Mời SĐT vào nhóm', desc: 'Tìm Zalo từ SĐT rồi thêm vào nhóm.', fields: [{ id: 'groupId', type: 'group-picker', label: 'Chọn nhóm đích' }, { id: 'targets', type: 'textarea', label: 'Danh sách SĐT' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 5000 }] },
  'grp-invite-friend': { title: 'Mời bạn bè vào nhóm', desc: 'Thêm User ID bạn bè vào nhóm.', fields: [{ id: 'groupId', type: 'group-picker', label: 'Chọn nhóm đích' }, { id: 'targets', type: 'textarea', label: 'User ID bạn bè' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 5000 }] },
  'grp-invite-other': { title: 'Mời thành viên nhóm khác', desc: 'Quét thành viên 1 nhóm rồi thêm vào nhóm khác.', fields: [{ id: 'targets', type: 'hidden-array', value: [1] }, { id: 'fromGroupId', type: 'group-picker', label: 'Nhóm nguồn (quét thành viên)' }, { id: 'groupId', type: 'group-picker', label: 'Nhóm đích (mời vào)' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 5000 }] },
  'grp-leave': { title: 'Rời nhóm', desc: 'Rời nhiều nhóm cùng lúc.', fields: [{ id: 'targets', type: 'textarea', label: 'Group ID' }, { id: 'delay', type: 'number', label: 'Delay (ms)', default: 4000 }] },
};

let currentTaskId = null;

async function openActionModal(action) {
  const cfg = ACTION_CFG[action];
  if (!cfg) { toast('Action chưa cấu hình: ' + action, 'err'); return; }
  $('#actTitle').textContent = cfg.title;
  $('#actDesc').textContent = cfg.desc || '';
  const wrap = $('#actFields'); wrap.innerHTML = '';
  let groupsCache = null;
  const getGroups = async () => {
    if (groupsCache) return groupsCache;
    const r = await api(`/api/chat/all-groups/${state.ownId}`);
    groupsCache = r.data || []; return groupsCache;
  };
  for (const f of cfg.fields) {
    const div = document.createElement('div'); div.className = 'act-field';
    if (f.type === 'hidden-array') { div.dataset.id = f.id; div.dataset.kind = 'hidden'; div.dataset.value = JSON.stringify(f.value || []); wrap.appendChild(div); continue; }
    if (f.label) { const lb = document.createElement('label'); lb.textContent = f.label; div.appendChild(lb); }
    let input;
    if (f.type === 'textarea') {
      input = document.createElement('textarea'); input.rows = 4; if (f.default) input.value = f.default;
    } else if (f.type === 'number') {
      input = document.createElement('input'); input.type = 'number'; input.value = f.default || 4000;
    } else if (f.type === 'group-picker') {
      input = document.createElement('select'); input.innerHTML = '<option value="">Đang tải nhóm...</option>';
      getGroups().then(gs => { input.innerHTML = '<option value="">— Chọn nhóm —</option>' + gs.map(g => `<option value="${g.id}">${escapeHtml(g.name)} (${g.memberCount})</option>`).join(''); });
    } else { input = document.createElement('input'); input.type = 'text'; if (f.default) input.value = f.default; }
    input.dataset.id = f.id; input.dataset.kind = f.type;
    div.appendChild(input); wrap.appendChild(div);
  }
  $('#actRunBtn').dataset.action = action;
  $('#actProgress').textContent = '';
  $('#actProgress').className = 'status-line';
  $('#actErrors').innerHTML = '';
  openModal('modalAction');
}

async function runAction() {
  const action = $('#actRunBtn').dataset.action;
  const params = {};
  let targets = null;
  $('#actFields').querySelectorAll('[data-id]').forEach(el => {
    const id = el.dataset.id; const kind = el.dataset.kind;
    let v;
    if (kind === 'hidden') v = JSON.parse(el.dataset.value);
    else if (kind === 'number') v = parseInt(el.value);
    else v = el.value;
    if (id === 'targets') {
      if (Array.isArray(v)) targets = v;
      else targets = String(v || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
    } else {
      params[id] = v;
    }
  });
  if (!targets || !targets.length) return toast('Cần ít nhất 1 target', 'err');
  if (params.delay) { params.delay = params.delay; }
  const r = await api('/api/chat/bulk-action', { method: 'POST', body: { ownId: state.ownId, action, targets, params } });
  if (!r.ok) { toast('Lỗi: ' + r.error, 'err'); return; }
  currentTaskId = r.taskId;
  $('#actProgress').textContent = `Đã bắt đầu, tổng: ${r.total}. Đang xử lý...`;
}

async function openRequestsModal() {
  $('#reqList').innerHTML = '<div class="status-line">Đang tải...</div>';
  openModal('modalRequests');
  $('#reqTabRecv').click();
}

async function initInvitesPage() {
  if (!state.accounts.length || !state.ownId) await loadAccounts();
  renderInvAccList();
  $('#invReqList').innerHTML = '<div class="empty" style="padding:30px">Chọn tài khoản và bấm "Tải danh sách lời mời kết bạn".</div>';
  $('#invLoadBtn').onclick = loadInvites;
  $('#invAcceptAllBtn').onclick = () => bulkInviteAction('accept');
  $('#invRejectAllBtn').onclick = () => bulkInviteAction('reject');
  if (window.lucide) window.lucide.createIcons();
}

function renderInvAccList() {
  const box = $('#invAccList');
  if (!state.accounts.length) {
    box.innerHTML = '<div class="empty" style="padding:14px">Chưa có tài khoản</div>';
    return;
  }
  box.innerHTML = state.accounts.map(a => {
    const active = a.ownId === state.ownId;
    return `<div class="inv-acc-row ${active ? 'active' : ''}" data-id="${a.ownId}">
      <span class="radio-dot ${active ? 'on' : ''}"></span>
      <div class="avatar sm" ${a.avatar ? `style="background-image:url('${a.avatar}')"` : ''}>${a.avatar ? '' : escapeHtml(avatarText(a.name || 'Acc'))}</div>
      <div class="info">
        <div class="nm">${escapeHtml(a.name || 'Acc')}</div>
        <div class="meta ${a.connected ? 'ok' : 'off'}">${a.connected ? 'Đang hoạt động' : 'Mất kết nối'}</div>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('.inv-acc-row').forEach(row => {
    row.onclick = () => { selectAccount(row.dataset.id); renderInvAccList(); };
  });
}

async function loadInvites() {
  if (!state.ownId) return toast('Chưa chọn tài khoản', 'err');
  const wrap = $('#invReqList');
  wrap.innerHTML = '<div class="empty" style="padding:30px">Đang tải lời mời...</div>';
  const r = await api(`/api/chat/received-requests/${state.ownId}`);
  if (!r.ok) { wrap.innerHTML = `<div class="empty" style="padding:30px;color:var(--destructive)">Lỗi: ${escapeHtml(r.error || '')}</div>`; return; }
  const list = Array.isArray(r.data) ? r.data : (r.data?.recommendations || r.data?.list || []);
  renderInvites(list);
}

function renderInvites(list) {
  const wrap = $('#invReqList');
  if (!list.length) { wrap.innerHTML = '<div class="empty" style="padding:30px">Không có lời mời nào</div>'; return; }
  wrap.innerHTML = list.map(req => {
    const uid = req.userId || req.uid || req.fid || req.id;
    const name = req.displayName || req.zaloName || req.fullname || uid;
    const msg = req.message || req.msg || '';
    const ts = req.timestamp || req.time || req.createdAt || 0;
    const d = ts ? new Date(ts > 1e12 ? ts : ts * 1000) : null;
    const dateStr = d ? `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} · ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` : '';
    const avatar = req.avatar ? `style="background-image:url('${req.avatar}')"` : '';
    return `<div class="inv-item" data-uid="${uid}">
      <div class="avatar lg" ${avatar}>${req.avatar ? '' : escapeHtml(avatarText(name))}</div>
      <div class="inv-body">
        <div class="inv-name">${escapeHtml(name)}</div>
        ${dateStr ? `<div class="inv-time">${dateStr}</div>` : ''}
        ${msg ? `<div class="inv-msg">${escapeHtml(msg)}</div>` : ''}
      </div>
      <div class="inv-actions">
        <button class="btn-ghost danger" data-uid="${uid}" data-act="reject"><i data-lucide="x"></i>Từ chối</button>
        <button class="btn-primary" data-uid="${uid}" data-act="accept"><i data-lucide="check"></i>Đồng ý</button>
      </div>
    </div>`;
  }).join('');
  if (window.lucide) window.lucide.createIcons();
  wrap.querySelectorAll('button[data-act]').forEach(b => {
    b.onclick = async () => {
      const act = b.dataset.act === 'accept' ? 'friend-accept' : 'friend-reject';
      b.disabled = true;
      await api('/api/chat/bulk-action', { method: 'POST', body: { ownId: state.ownId, action: act, targets: [b.dataset.uid], params: { delay: 1000 } } });
      toast(b.dataset.act === 'accept' ? 'Đã đồng ý' : 'Đã từ chối', 'ok');
      b.closest('.inv-item').remove();
      if (!$('#invReqList').querySelector('.inv-item')) renderInvites([]);
    };
  });
}

async function bulkInviteAction(kind) {
  const items = $('#invReqList').querySelectorAll('.inv-item');
  const uids = [...items].map(it => it.dataset.uid);
  if (!uids.length) return toast('Không có lời mời', 'info');
  if (!confirm(`${kind === 'accept' ? 'Đồng ý' : 'Từ chối'} ${uids.length} lời mời?`)) return;
  await api('/api/chat/bulk-action', { method: 'POST', body: { ownId: state.ownId, action: kind === 'accept' ? 'friend-accept' : 'friend-reject', targets: uids, params: { delay: 2000 } } });
  toast(`${kind === 'accept' ? 'Đã đồng ý' : 'Đã từ chối'} ${uids.length} lời mời`, 'ok');
  setTimeout(loadInvites, 1500);
}

async function loadRequests(kind) {
  const url = kind === 'sent' ? `/api/chat/sent-requests/${state.ownId}` : `/api/chat/received-requests/${state.ownId}`;
  const r = await api(url);
  const list = Array.isArray(r.data) ? r.data : (r.data?.recommendations || r.data?.list || []);
  $('#reqList').dataset.kind = kind;
  if (!list.length) { $('#reqList').innerHTML = '<div class="status-line">Không có lời mời</div>'; return; }
  $('#reqList').innerHTML = list.map(req => {
    const uid = req.userId || req.uid || req.fid || req.id;
    const name = req.displayName || req.zaloName || req.fullname || uid;
    const msg = req.message || req.msg || '';
    return `
      <div class="req-item">
        <div class="avatar">${escapeHtml(avatarText(name))}</div>
        <div class="body">
          <div class="name">${escapeHtml(name)}</div>
          <div class="msg">${escapeHtml(msg)} <span style="color:var(--muted)">· ${uid}</span></div>
        </div>
        ${kind === 'recv' ? `<button data-uid="${uid}" data-act="accept">Accept</button> <button data-uid="${uid}" data-act="reject">Reject</button>` : `<button data-uid="${uid}" data-act="undo">Huỷ</button>`}
      </div>
    `;
  }).join('');
  $('#reqList').querySelectorAll('button[data-act]').forEach(b => {
    b.onclick = async () => {
      const map = { accept: 'friend-accept', reject: 'friend-reject', undo: 'friend-undo' };
      await api('/api/chat/bulk-action', { method: 'POST', body: { ownId: state.ownId, action: map[b.dataset.act], targets: [b.dataset.uid], params: { delay: 1000 } } });
      toast('Đã gửi yêu cầu', 'ok');
      setTimeout(() => loadRequests(kind), 800);
    };
  });
}

async function acceptAllReceived() {
  const list = $('#reqList').querySelectorAll('button[data-act="accept"]');
  const uids = Array.from(list).map(b => b.dataset.uid);
  if (!uids.length) return toast('Không có lời mời', 'info');
  await api('/api/chat/bulk-action', { method: 'POST', body: { ownId: state.ownId, action: 'friend-accept', targets: uids, params: { delay: 2000 } } });
  toast(`Đã chấp nhận ${uids.length} lời mời`, 'ok');
}
async function rejectAllReceived() {
  const list = $('#reqList').querySelectorAll('button[data-act="reject"]');
  const uids = Array.from(list).map(b => b.dataset.uid);
  if (!uids.length) return toast('Không có lời mời', 'info');
  await api('/api/chat/bulk-action', { method: 'POST', body: { ownId: state.ownId, action: 'friend-reject', targets: uids, params: { delay: 2000 } } });
  toast(`Đã từ chối ${uids.length} lời mời`, 'ok');
}

async function openStickerPicker() {
  openModal('modalSticker');
  $('#stKeyword').value = 'haha';
  await searchStickers('haha');
}

const stickerCache = new Map();

async function searchStickers(kw) {
  const grid = $('#stGrid'); grid.innerHTML = '<div class="status-line">Đang tải...</div>';
  stickerCache.clear();
  const r = await api(`/api/chat/stickers/${state.ownId}?q=${encodeURIComponent(kw || ':)')}`);
  let ids = (r.data || []).map(s => typeof s === 'object' ? (s.id || s.stickerId) : s).filter(Boolean).slice(0, 30);
  if (!ids.length) { grid.innerHTML = '<div class="status-line">Không tìm thấy sticker</div>'; return; }
  const detail = await api(`/api/chat/sticker-detail/${state.ownId}?ids=${ids.join(',')}`);
  const arr = detail.data || [];
  arr.forEach(s => stickerCache.set(String(s.id), s));
  grid.innerHTML = arr.map(s => {
    const url = s.stickerUrl || s.url || s.image || s.staticUrl || s.staticPath || '';
    return `<div class="st" data-id="${s.id}"><img src="${url}" alt="" loading="lazy" /></div>`;
  }).join('') || '<div class="status-line">Không có dữ liệu</div>';
  grid.querySelectorAll('.st').forEach(el => {
    el.onclick = async () => {
      if (!state.currentThread) { toast('Hãy chọn một hội thoại trước', 'err'); return; }
      const sObj = stickerCache.get(el.dataset.id);
      if (!sObj) return toast('Lỗi: thiếu sticker data', 'err');
      const r2 = await api('/api/chat/send-sticker', {
        method: 'POST',
        body: {
          ownId: state.ownId,
          threadId: state.currentThread.id,
          threadType: state.currentThread.type,
          sticker: { id: sObj.id, cateId: sObj.cateId, type: sObj.type },
        },
      });
      if (r2.ok) { toast('Đã gửi sticker', 'ok'); closeModal(); } else toast('Lỗi: ' + r2.error, 'err');
    };
  });
}

const bkState = { friends: [], selected: new Set() };

// ══════════════════════════════════════════════
// FANPAGE PAGE (Chatwoot-style inbox)
// ══════════════════════════════════════════════
const fpState = {
  pages: [],
  selectedPageId: null,
  conversations: [],
  selectedConvoId: null,
  filter: 'all',  // default load all conversations
  composeTab: 'reply',
  counts: { open: 0, pending: 0, resolved: 0, all: 0 },
  labelFilter: null,
};

async function initFanpagePage() {
  await loadFbPages();
  // Load labels (dùng chung với Zalo)
  if (!state.labelsCache?.length) {
    try { const r = await api('/api/labels'); if (r.ok) state.labelsCache = r.data; } catch {}
  }
  renderFpLabelFilters();
  // Load templates dùng chung với Zalo
  if (!state.templates && state.ownId) {
    try { const r = await api('/api/chat/templates/' + state.ownId); if (r.ok) state.templates = r.data; } catch {}
  }
  renderFpQuickTemplates();
  bindFanpageHandlers();
  const sb = $('#fpSyncAllBtn');
  if (sb) sb.disabled = false;
  if (window.lucide) window.lucide.createIcons();
}

function bindFanpageHandlers() {
  $('#fpAddPageBtn').onclick = () => { closeFpDropdown(); openModal('modalAddFanpage'); resetFanpageModal(); loadFbAppConfig(); };
  $('#fpLoginFbBtn').onclick = startFbOAuth;
  $('#fpQuickConnectBtn').onclick = quickConnectWithToken;
  $('#fpSaveAppConfigBtn').onclick = saveFbAppConfig;
  $('#fpConnectSelectedBtn').onclick = connectSelectedPages;
  $('#fpPageCurrentBtn').onclick = (e) => { e.stopPropagation(); toggleFpDropdown(); };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.fp-page-selector')) closeFpDropdown();
  });
  window.addEventListener('message', handleFbOAuthMessage);
  // Tab switcher
  document.querySelectorAll('.fp-conn-tab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.fp-conn-tab').forEach(x => {
        x.classList.remove('active');
        x.style.borderBottomColor = 'transparent';
        x.style.color = 'var(--muted-foreground)';
        x.style.fontWeight = '400';
      });
      t.classList.add('active');
      t.style.borderBottomColor = 'var(--primary)';
      t.style.color = 'var(--primary)';
      t.style.fontWeight = '600';
      document.querySelectorAll('.fp-conn-pane').forEach(p => p.classList.add('hidden'));
      $('#fpConn' + (t.dataset.conn === 'token' ? 'Token' : 'Oauth')).classList.remove('hidden');
    };
  });
  $('#fpSyncAllBtn').onclick = () => { closeFpDropdown(); syncAllFbConversations(); };
  $('#fpAutoClassifyBtn').onclick = () => { closeFpDropdown(); openAutoClassifyModal(); };
  $('#fpSendBtn').onclick = sendFbMessage;
  $('#fpInput').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFbMessage(); }
  };
  $('#fpMarkResolvedBtn').onclick = () => setFbConvoStatus('resolved');
  $('#fpAssignBtn').onclick = () => toast('Tính năng "Giao agent" sẽ có khi build multi-user/team', 'info');
  $('#fpLabelBtn').onclick = (e) => openFbConvoLabels(e);
  $('#fpAiBtn').onclick = () => {
    if (typeof toggleAiPanel === 'function') toggleAiPanel();
  };
  // AI suggest moved to AI panel in header — bỏ button trong composer để giống Zalo
  $('#fpSearchInChatBtn').onclick = () => searchInFbChat();
  $('#fpToggleInfoBtn').onclick = () => $('#fpInfoPanel').classList.toggle('hidden');
  $('#fpAttachBtn').onclick = () => toast('Đính kèm — cần build endpoint upload', 'info');
  $('#fpEmojiBtn').onclick = () => insertFpEmoji();
  $('#fpScheduleBtn').onclick = () => openModal('modalSchedule');
  $('#fpReplyCancel').onclick = () => cancelFpReply();
  // Info panel buttons
  $('#fpInfoScheduleBtn').onclick = () => openModal('modalSchedule');
  $('#fpInfoEditLabelsBtn').onclick = (e) => openFbConvoLabels(e);
  $('#fpInfoClearAiBtn').onclick = () => {
    if (!fpState.selectedConvoId) return;
    if (!confirm('Xoá lịch sử AI của hội thoại này?')) return;
    localStorage.removeItem('fpAiHistory:' + fpState.selectedConvoId);
    toast('Đã xoá lịch sử AI', 'ok');
  };
  $('#fpInfoDisconnectBtn').onclick = async () => {
    if (!fpState.selectedPageId) return;
    const p = fpState.pages.find(x => x.pageId === fpState.selectedPageId);
    if (!confirm(`Ngắt Fanpage "${p?.name}"? (Hội thoại + tin nhắn cũ vẫn giữ trong DB)`)) return;
    await api('/api/fb/pages/' + fpState.selectedPageId, { method: 'DELETE' });
    fpState.selectedPageId = null;
    loadFbPages();
  };
  $('#fpAutoReplyEnabled').onchange = () => toggleFpAutoReply();
  $('#fpSearchConvo').oninput = renderFbConvos;
  // Status filter (Mở/Chờ/Xong) đã bỏ — default 'all' load tất cả
  // Note toggle button (thay cho tabs)
  const noteBtn = $('#fpNoteToggleBtn');
  if (noteBtn) {
    noteBtn.onclick = () => {
      const isNote = noteBtn.dataset.tab === 'note';
      const next = isNote ? 'reply' : 'note';
      noteBtn.dataset.tab = next;
      fpState.composeTab = next;
      // Visual style note mode
      if (next === 'note') {
        noteBtn.style.color = 'rgb(202, 138, 4)';
        noteBtn.style.background = 'rgba(250, 204, 21, 0.15)';
        $('#fpInput').placeholder = '📝 Ghi chú nội bộ (chỉ team thấy, KHÔNG gửi tới khách)…';
        $('#fpInput').style.background = 'rgba(250, 204, 21, 0.05)';
        $('#fpSendBtn').textContent = '📝 Lưu note';
        toast('Đã chuyển sang chế độ Ghi chú nội bộ', 'info');
      } else {
        noteBtn.style.color = '';
        noteBtn.style.background = '';
        $('#fpInput').placeholder = 'Nhập tin nhắn…';
        $('#fpInput').style.background = '';
        $('#fpSendBtn').innerHTML = '<i data-lucide="send-horizontal"></i><span>Gửi</span>';
        if (window.lucide) window.lucide.createIcons();
      }
    };
  }
}

async function loadFbPages() {
  const r = await api('/api/fb/pages');
  fpState.pages = r.ok ? r.data : [];
  // Auto-select first page nếu chưa chọn
  if (!fpState.selectedPageId && fpState.pages.length) {
    fpState.selectedPageId = fpState.pages[0].pageId;
    loadFbConvos();
  }
  renderFbPages();
  renderFpCurrentPage();
}

function renderFpCurrentPage() {
  const cur = fpState.pages.find(p => p.pageId === fpState.selectedPageId);
  if (!cur) {
    $('#fpCurrentName').textContent = 'Chọn Fanpage';
    $('#fpCurrentMeta').textContent = fpState.pages.length ? `${fpState.pages.length} Fanpages đã kết nối` : '— chưa có Fanpage nào';
    $('#fpCurrentAvatar').style.backgroundImage = '';
    $('#fpCurrentAvatar').textContent = '';
    return;
  }
  $('#fpCurrentName').textContent = cur.name;
  const others = fpState.pages.length - 1;
  $('#fpCurrentMeta').textContent = others > 0 ? `+ ${others} Fanpages khác` : (cur.instagramId ? '📷 Có Instagram Business' : 'Đang quản lý');
  $('#fpCurrentAvatar').style.backgroundImage = cur.avatar ? `url('${cur.avatar}')` : '';
  $('#fpCurrentAvatar').textContent = cur.avatar ? '' : avatarText(cur.name);
}

function renderFbPages() {
  const box = $('#fpPageList');
  if (!fpState.pages.length) {
    box.innerHTML = '<div class="empty" style="padding:20px;font-size:12px">Chưa có Fanpage nào kết nối.</div>';
    return;
  }
  box.innerHTML = fpState.pages.map(p => `
    <div class="fp-page-item ${p.pageId === fpState.selectedPageId ? 'active' : ''}" data-id="${p.pageId}" title="${p.reauthRequired ? 'Cần cập nhật token: ' + (p.lastError || '') : (p.lastError || '')}">
      <div class="avatar" ${p.avatar ? `style="background-image:url('${p.avatar}')"` : ''}>${p.avatar ? '' : escapeHtml(avatarText(p.name))}</div>
      <div class="nm">${escapeHtml(p.name)}${p.instagramId ? ' <span title="Có Instagram Business liên kết" style="font-size:10px">📷</span>' : ''}</div>
      ${p.reauthRequired ? '<span class="badge">⚠</span>' : ''}
      <button class="btn-icon" data-act="update-token" title="Cập nhật token" style="padding:4px;background:transparent;border:0;cursor:pointer"><i data-lucide="key-round" style="width:14px;height:14px"></i></button>
    </div>
  `).join('');
  box.querySelectorAll('.fp-page-item').forEach(el => {
    el.onclick = (e) => {
      // Nếu click vào nút update token → open modal
      if (e.target.closest('[data-act="update-token"]')) {
        e.stopPropagation();
        const pid = el.dataset.id;
        const p = fpState.pages.find(x => x.pageId === pid);
        openUpdateTokenModal(p);
        return;
      }
      fpState.selectedPageId = el.dataset.id;
      renderFbPages();
      renderFpCurrentPage();
      closeFpDropdown();
      loadFbConvos();
    };
  });
  if (window.lucide) window.lucide.createIcons();
}

function openUpdateTokenModal(page) {
  if (!page) return;
  closeFpDropdown();
  $('#fpUpdatePageName').textContent = page.name;
  $('#fpUpdatePageId').textContent = page.pageId;
  $('#fpUpdateToken').value = '';
  $('#fpUpdateTokenStatus').textContent = '';
  openModal('modalUpdateFbToken');
  $('#fpUpdateTokenBtn').onclick = () => updateFbPageToken(page.pageId);
}

async function updateFbPageToken(pageId) {
  const accessToken = $('#fpUpdateToken').value.trim();
  if (!accessToken) return toast('Cần token', 'err');
  const btn = $('#fpUpdateTokenBtn');
  btn.disabled = true;
  $('#fpUpdateTokenStatus').innerHTML = '⏳ Đang kiểm tra token + quyền messaging...';
  $('#fpUpdateTokenStatus').className = 'status-line';
  try {
    const r = await api(`/api/fb/pages/${pageId}/update-token`, { method: 'POST', body: { accessToken } });
    if (!r.ok) {
      $('#fpUpdateTokenStatus').innerHTML = '❌ ' + r.error;
      $('#fpUpdateTokenStatus').className = 'status-line err';
      return;
    }
    $('#fpUpdateTokenStatus').innerHTML = `✅ Token OK, đã update. Quyền messaging hoạt động.${r.data.instagramId ? ' 📷 Có Instagram Business.' : ''}`;
    $('#fpUpdateTokenStatus').className = 'status-line ok';
    toast('Đã update token!', 'ok');
    setTimeout(() => { closeModal(); loadFbPages(); }, 1200);
  } finally { btn.disabled = false; }
}

function toggleFpDropdown() {
  $('#fpPageDropdown').classList.toggle('hidden');
}
function closeFpDropdown() {
  $('#fpPageDropdown').classList.add('hidden');
}

function resetFanpageModal() {
  $('#fpStep1').classList.remove('hidden');
  $('#fpStep2').classList.add('hidden');
  $('#fpLoginStatus').textContent = '';
  $('#fpConnectStatus').textContent = '';
  $('#fpQuickStatus').textContent = '';
  if ($('#fpQuickToken')) $('#fpQuickToken').value = '';
}

async function quickConnectWithToken() {
  const userToken = $('#fpQuickToken').value.trim();
  if (!userToken) return toast('Cần User Access Token', 'err');
  if (userToken.length < 50) return toast('Token có vẻ không hợp lệ (quá ngắn)', 'err');

  const btn = $('#fpQuickConnectBtn');
  btn.disabled = true;
  $('#fpQuickStatus').innerHTML = '⏳ Đang gọi Facebook lấy danh sách Fanpage...';
  $('#fpQuickStatus').className = 'status-line';

  try {
    const r = await api('/api/fb/quick-connect', { method: 'POST', body: { userToken } });
    if (!r.ok) {
      $('#fpQuickStatus').innerHTML = '❌ ' + r.error;
      $('#fpQuickStatus').className = 'status-line err';
      return;
    }
    $('#fpQuickStatus').innerHTML = `✅ Tìm thấy ${r.pageCount} Fanpage!`;
    $('#fpQuickStatus').className = 'status-line ok';

    // Load và hiện list pages
    const s = await api(`/api/fb/oauth-session/${r.sessionId}`);
    if (!s.ok) { toast('Lỗi: ' + s.error, 'err'); return; }
    fpState.oauthSessionId = r.sessionId;
    fpState.oauthPages = s.data.pages || [];
    renderFbPageOptions(fpState.oauthPages);
    $('#fpStep1').classList.add('hidden');
    $('#fpStep2').classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function loadFbAppConfig() {
  const r = await api('/api/fb/app-config');
  if (r.ok && r.data) {
    $('#fpAppId').value = r.data.appId || '';
    if (r.data.appSecretSet) $('#fpAppSecret').placeholder = '✓ Đã có (nhập lại nếu muốn đổi)';
  }
}

async function saveFbAppConfig() {
  const appId = $('#fpAppId').value.trim();
  const appSecret = $('#fpAppSecret').value.trim();
  const body = { appId };
  if (appSecret) body.appSecret = appSecret;
  const r = await api('/api/fb/app-config', { method: 'POST', body });
  if (!r.ok) {
    $('#fpAppConfigStatus').textContent = '❌ ' + r.error;
    $('#fpAppConfigStatus').className = 'status-line err';
    return;
  }
  $('#fpAppConfigStatus').textContent = '✅ Đã lưu cấu hình. Giờ bấm "Đăng nhập Facebook" ở trên.';
  $('#fpAppConfigStatus').className = 'status-line ok';
}

async function startFbOAuth() {
  $('#fpLoginStatus').textContent = '⏳ Đang kiểm tra cấu hình...';
  $('#fpLoginStatus').className = 'status-line';

  // Check cấu hình App ID/Secret trước khi mở popup
  const cfg = await api('/api/fb/app-config');
  if (!cfg.ok || !cfg.data?.appId || !cfg.data?.appSecretSet) {
    $('#fpLoginStatus').innerHTML = '❌ <b>Chưa cấu hình Facebook App.</b><br>Mở phần "⚙️ Cấu hình Facebook App (lần đầu)" bên dưới → nhập App ID + App Secret → Lưu → bấm lại Đăng nhập.';
    $('#fpLoginStatus').className = 'status-line err';
    // Auto mở details
    document.querySelector('#fpStep1 details')?.setAttribute('open', '');
    return;
  }

  $('#fpLoginStatus').textContent = '⏳ Mở cửa sổ Facebook login...';
  const w = 600, h = 700;
  const left = (window.screen.width - w) / 2;
  const top = (window.screen.height - h) / 2;
  const popup = window.open('/api/fb/oauth-start', 'fbOauth', `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);
  if (!popup || popup.closed) {
    $('#fpLoginStatus').innerHTML = '❌ <b>Popup bị block.</b><br>Cho phép popup cho domain này:<br>Trên Chrome → click icon 🔒/⚠ bên trái URL → Site settings → Pop-ups = Allow → reload trang → thử lại.';
    $('#fpLoginStatus').className = 'status-line err';
    return;
  }

  // Theo dõi popup, nếu user đóng mà không hoàn thành OAuth → báo
  const watchTimer = setInterval(() => {
    if (popup.closed) {
      clearInterval(watchTimer);
      const status = $('#fpLoginStatus').textContent || '';
      if (!status.startsWith('✅')) {
        $('#fpLoginStatus').innerHTML = '⚠️ Đã đóng cửa sổ Facebook. Nếu bạn chưa hoàn tất login, bấm lại.';
        $('#fpLoginStatus').className = 'status-line';
      }
    }
  }, 1000);
}

async function handleFbOAuthMessage(e) {
  if (!e.data || !e.data.fbOauth) return;
  if (e.data.fbOauth === 'error') {
    $('#fpLoginStatus').textContent = '❌ ' + e.data.error;
    $('#fpLoginStatus').className = 'status-line err';
    return;
  }
  if (e.data.fbOauth === 'success') {
    $('#fpLoginStatus').textContent = `✅ Đăng nhập thành công! Tìm thấy ${e.data.pageCount} Fanpage.`;
    $('#fpLoginStatus').className = 'status-line ok';
    // Load list pages
    const r = await api(`/api/fb/oauth-session/${e.data.sessionId}`);
    if (!r.ok) { toast('Lỗi: ' + r.error, 'err'); return; }
    const pages = r.data.pages || [];
    if (!pages.length) {
      $('#fpLoginStatus').textContent = '⚠️ Tài khoản này không quản lý Fanpage nào.';
      return;
    }
    fpState.oauthSessionId = e.data.sessionId;
    fpState.oauthPages = pages;
    renderFbPageOptions(pages);
    $('#fpStep1').classList.add('hidden');
    $('#fpStep2').classList.remove('hidden');
  }
}

function renderFbPageOptions(pages) {
  const box = $('#fpPageOptions');
  box.innerHTML = pages.map(p => `
    <label style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid var(--border);cursor:pointer">
      <input type="checkbox" data-page-id="${p.pageId}" checked style="margin:0;width:auto" />
      <div class="avatar" ${p.avatar ? `style="background-image:url('${p.avatar}')"` : ''}>${p.avatar ? '' : escapeHtml(avatarText(p.name))}</div>
      <div style="flex:1">
        <div style="font-weight:600;font-size:13px">${escapeHtml(p.name)}</div>
        <div style="font-size:11px;color:var(--muted-foreground)">ID: ${p.pageId}</div>
      </div>
    </label>
  `).join('');
}

async function connectSelectedPages() {
  if (!fpState.oauthSessionId) return;
  const pageIds = Array.from(document.querySelectorAll('#fpPageOptions input[type="checkbox"]:checked')).map(c => c.dataset.pageId);
  if (!pageIds.length) return toast('Chọn ít nhất 1 Fanpage', 'err');
  $('#fpConnectStatus').textContent = '⏳ Đang kết nối...';
  $('#fpConnectStatus').className = 'status-line';
  const r = await api('/api/fb/connect-pages', { method: 'POST', body: { sessionId: fpState.oauthSessionId, pageIds } });
  if (!r.ok) {
    $('#fpConnectStatus').textContent = '❌ ' + r.error;
    $('#fpConnectStatus').className = 'status-line err';
    return;
  }
  $('#fpConnectStatus').textContent = `✅ Đã kết nối ${r.data.length} Fanpage!`;
  $('#fpConnectStatus').className = 'status-line ok';
  toast('Kết nối thành công!', 'ok');
  setTimeout(() => { closeModal(); loadFbPages(); }, 800);
}

async function loadFbConvos() {
  if (!fpState.selectedPageId) return;
  const r = await api(`/api/fb/pages/${fpState.selectedPageId}/conversations?status=${fpState.filter}&limit=2000`);
  fpState.conversations = r.ok ? r.data : [];
  fpState.counts = r.counts || {};
  // Tổng all
  renderFpLabelFilters();
  renderFbConvos();
}

function renderFbConvos() {
  const box = $('#fpConvoList');
  const q = ($('#fpSearchConvo')?.value || '').toLowerCase().trim();
  const labelFilter = fpState.labelFilter || null;
  let arr = fpState.conversations;
  // Filter theo nhãn
  if (labelFilter) {
    arr = arr.filter(c => {
      try { const ls = JSON.parse(c.labels || '[]'); return ls.includes(labelFilter); } catch { return false; }
    });
  }
  if (q) {
    arr = arr.filter(c => (c.customerName || '').toLowerCase().includes(q) || (c.lastMsg || '').toLowerCase().includes(q));
  }
  if (!arr.length) {
    box.innerHTML = '<div class="empty" style="padding:40px;font-size:12px;text-align:center">Không có hội thoại khớp filter</div>';
    return;
  }
  box.innerHTML = arr.map(c => {
    const time = c.lastMsgAt ? timeAgo(c.lastMsgAt) : '';
    const statusClass = c.status || 'open';
    // Render label chips từ JSON
    let labelChips = '';
    if (c.labels) {
      try {
        const labels = JSON.parse(c.labels);
        labelChips = labels.map(l => {
          const lbl = (state.labelsCache || []).find(x => x.name === l);
          const color = lbl?.color || '#fbbf24';
          return `<span style="display:inline-flex;align-items:center;gap:3px;background:${color}22;color:${color};padding:1px 6px;border-radius:8px;font-size:10px;font-weight:500"><span style="width:5px;height:5px;background:${color};border-radius:50%"></span>${escapeHtml(l)}</span>`;
        }).join('');
      } catch {}
    }
    return `<div class="fp-convo-item ${c.id === fpState.selectedConvoId ? 'active' : ''}" data-id="${c.id}">
      <div class="avatar" ${c.customerAvatar ? `style="background-image:url('${c.customerAvatar}')"` : ''}>${c.customerAvatar ? '' : escapeHtml(avatarText(c.customerName || '?'))}</div>
      <div class="fp-convo-body">
        <div class="fp-convo-name">${escapeHtml(c.customerName || 'Khách FB')}<span class="time">${time}</span></div>
        <div class="fp-convo-preview">${escapeHtml((c.lastMsg || '').slice(0, 80))}</div>
        ${labelChips ? `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:4px">${labelChips}</div>` : ''}
        <div class="fp-convo-meta">
          <span class="fp-convo-status ${statusClass}">${({open:'Mở',pending:'Chờ',resolved:'Xong',snoozed:'Tạm hoãn'})[statusClass] || statusClass}</span>
          ${c.unread > 0 ? `<span class="fp-convo-unread">${c.unread}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('.fp-convo-item').forEach(el => {
    el.onclick = () => openFbConvo(el.dataset.id);
  });
}

async function openFbConvo(convoId) {
  fpState.selectedConvoId = convoId;
  renderFbConvos();
  $('#fpChatPlaceholder').classList.add('hidden');
  $('#fpChatHeader').classList.remove('hidden');
  $('#fpChatBody').classList.remove('hidden');
  $('#fpChatFooter').classList.remove('hidden');
  $('#fpInfoPanel').classList.remove('hidden');
  const convo = fpState.conversations.find(c => c.id === convoId);
  if (!convo) return;
  $('#fpHeadAvatar').style.backgroundImage = convo.customerAvatar ? `url('${convo.customerAvatar}')` : '';
  $('#fpHeadAvatar').textContent = convo.customerAvatar ? '' : avatarText(convo.customerName || '?');
  $('#fpHeadName').textContent = convo.customerName || 'Khách FB';
  const pageObj = fpState.pages.find(p => p.pageId === convo.pageId);
  $('#fpHeadPage').textContent = pageObj?.name || '';
  // 24h window indicator (Facebook policy)
  const ageH = (Date.now() - (convo.lastMsgAt || 0)) / 3600000;
  const within24h = ageH < 24;
  const hint = $('#fpComposeWindowHint');
  if (hint) {
    hint.textContent = within24h
      ? `✅ Trong cửa sổ 24h (${ageH.toFixed(1)}h từ tin cuối)`
      : `⚠️ Ngoài 24h — cần MESSAGE_TAG`;
    hint.style.color = within24h ? '#16a34a' : 'var(--destructive)';
  }
  $('#fpInfoAvatar').style.backgroundImage = convo.customerAvatar ? `url('${convo.customerAvatar}')` : '';
  $('#fpInfoAvatar').textContent = convo.customerAvatar ? '' : avatarText(convo.customerName || '?');
  $('#fpInfoName').textContent = convo.customerName || 'Khách FB';
  $('#fpInfoFbId').textContent = `PSID: ${convo.customerPsid}`;
  $('#fpInfoFirstSeen').textContent = `Lần đầu: ${new Date(convo.createdAt * 1000).toLocaleDateString('vi-VN')}`;
  cancelFpReply();  // Reset reply preview khi đổi convo
  refreshFpAutoReplyState();
  await loadFbMessages(convoId);
  if (window.lucide) window.lucide.createIcons();
}

async function loadFbMessages(convoId) {
  const r = await api(`/api/fb/conversations/${convoId}/messages?limit=100`);
  if (!r.ok) return toast('Lỗi load tin: ' + r.error, 'err');
  const msgs = r.data || [];
  fpState.lastMessages = msgs;
  $('#fpInfoMsgCount').textContent = `${msgs.length} tin`;
  renderFpInfoPanel();
  const box = $('#fpMessages');
  box.innerHTML = msgs.map((m, idx) => {
    const isSelf = !!m.isFromPage;
    const klass = m.isNote ? 'note' : (isSelf ? 'self' : '');
    // Full date-time format giống Zalo
    const time = new Date(m.ts).toLocaleString('vi-VN');
    const fromName = m.fromName || (isSelf ? 'Page' : 'Khách');
    let statusIcon = '';
    if (isSelf && !m.isNote) {
      if (m.status === 'read') statusIcon = ' 👁';
      else if (m.status === 'delivered') statusIcon = ' ✓✓';
      else if (m.status === 'sent') statusIcon = ' ✓';
    }
    return `<div class="msg-row ${klass}" data-mid="${m.msgId}" data-idx="${idx}">
      <div class="msg-content">
        ${!isSelf && !m.isNote ? `<div class="msg-from">${escapeHtml(fromName)}</div>` : ''}
        <div class="msg-bubble">${escapeHtml(m.content || '(không có nội dung)')}</div>
        <div class="msg-time">${time}${statusIcon}</div>
        ${m.isNote ? '' : `<div class="msg-actions" style="display:flex;gap:4px;margin-top:2px;opacity:0;transition:opacity .15s">
          <button class="icon-btn" data-act="fp-reply" title="Trả lời"><i data-lucide="reply" style="width:14px;height:14px"></i></button>
          <button class="icon-btn" data-act="fp-forward" title="Chuyển tiếp"><i data-lucide="forward" style="width:14px;height:14px"></i></button>
          <button class="icon-btn" data-act="fp-copy" title="Copy"><i data-lucide="copy" style="width:14px;height:14px"></i></button>
          <button class="icon-btn" data-act="fp-quote-ai" title="Hỏi AI về tin này"><i data-lucide="sparkles" style="width:14px;height:14px"></i></button>
        </div>`}
      </div>
    </div>`;
  }).join('');
  // Hover hiện actions
  box.querySelectorAll('.msg-row').forEach(row => {
    const actions = row.querySelector('.msg-actions');
    if (actions) {
      row.addEventListener('mouseenter', () => actions.style.opacity = '1');
      row.addEventListener('mouseleave', () => actions.style.opacity = '0');
    }
  });
  // Action handlers
  box.querySelectorAll('[data-act="fp-reply"]').forEach(b => b.onclick = () => {
    const idx = +b.closest('.msg-row').dataset.idx;
    startFpReply(msgs[idx]);
  });
  box.querySelectorAll('[data-act="fp-copy"]').forEach(b => b.onclick = () => {
    const idx = +b.closest('.msg-row').dataset.idx;
    navigator.clipboard.writeText(msgs[idx].content || '');
    toast('Đã copy', 'ok');
  });
  box.querySelectorAll('[data-act="fp-forward"]').forEach(b => b.onclick = () => {
    const idx = +b.closest('.msg-row').dataset.idx;
    forwardFpMessage(msgs[idx]);
  });
  box.querySelectorAll('[data-act="fp-quote-ai"]').forEach(b => b.onclick = () => {
    const idx = +b.closest('.msg-row').dataset.idx;
    const m = msgs[idx];
    $('#fpInput').value = `Khách vừa nhắn: "${m.content}"\n\nGợi ý cho mình câu reply phù hợp.`;
    suggestFbReply();
  });
  if (window.lucide) window.lucide.createIcons();
  const body = $('#fpChatBody');
  if (body) body.scrollTop = body.scrollHeight;
}

async function sendFbMessage() {
  const content = $('#fpInput').value.trim();
  if (!content || !fpState.selectedConvoId) return;
  const isNote = fpState.composeTab === 'note';
  $('#fpInput').value = '';
  const r = await api(`/api/fb/conversations/${fpState.selectedConvoId}/send`, { method: 'POST', body: { content, isNote } });
  if (!r.ok) { toast('Lỗi gửi: ' + r.error, 'err'); $('#fpInput').value = content; return; }
  await loadFbMessages(fpState.selectedConvoId);
  loadFbConvos();
}

// Render filter nhãn cho Fanpage
function renderFpLabelFilters() {
  const box = $('#fpLabelFilters');
  if (!box) return;
  const labels = state.labelsCache || [];
  if (!labels.length) { box.innerHTML = ''; return; }
  // Đếm conversations theo từng nhãn
  const counts = {};
  for (const c of (fpState.conversations || [])) {
    try {
      const ls = JSON.parse(c.labels || '[]');
      for (const l of ls) counts[l] = (counts[l] || 0) + 1;
    } catch {}
  }
  const activeFilter = fpState.labelFilter;
  const chips = [
    `<button class="fp-lbl-chip ${!activeFilter ? 'active' : ''}" data-l="" style="font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid var(--border);cursor:pointer;background:${!activeFilter ? 'var(--primary)' : 'transparent'};color:${!activeFilter ? 'white' : 'inherit'}">Tất cả nhãn</button>`,
    ...labels.map(l => {
      const isActive = activeFilter === l.name;
      const cnt = counts[l.name] || 0;
      return `<button class="fp-lbl-chip ${isActive ? 'active' : ''}" data-l="${escapeHtml(l.name)}" style="font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid ${l.color};cursor:pointer;background:${isActive ? l.color : l.color + '22'};color:${isActive ? 'white' : l.color};display:inline-flex;align-items:center;gap:4px">${escapeHtml(l.name)}${cnt ? ` (${cnt})` : ''}</button>`;
    }),
  ].join('');
  box.innerHTML = chips;
  box.querySelectorAll('.fp-lbl-chip').forEach(b => {
    b.onclick = () => {
      fpState.labelFilter = b.dataset.l || null;
      renderFpLabelFilters();
      renderFbConvos();
    };
  });
}

// Quick templates chips (giống Zalo)
function renderFpQuickTemplates() {
  const box = $('#fpQuickTemplates');
  if (!box) return;
  const list = state.templates || [];
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = list.slice(0, 8).map((t, i) =>
    `<button class="qt" data-i="${i}" title="${escapeHtml(t.content)}">${escapeHtml(t.title || t.content.slice(0, 30))}</button>`
  ).join('');
  box.querySelectorAll('.qt').forEach(b => {
    b.onclick = () => {
      const t = list[+b.dataset.i];
      $('#fpInput').value = t.content;
      $('#fpInput').focus();
    };
  });
}

// Reply preview (giống Zalo)
let fpReplyTarget = null;
function startFpReply(msg) {
  fpReplyTarget = msg;
  $('#fpReplyName').textContent = msg.fromName || (msg.isFromPage ? 'Mình' : 'Khách');
  $('#fpReplySnippet').textContent = (msg.content || '').slice(0, 80);
  $('#fpReplyPreview').classList.remove('hidden');
  $('#fpInput').focus();
}
function cancelFpReply() {
  fpReplyTarget = null;
  $('#fpReplyPreview').classList.add('hidden');
}

// Auto-reply toggle cho conversation Fanpage — lưu vào DB qua API
async function toggleFpAutoReply() {
  if (!fpState.selectedConvoId) return;
  const convo = fpState.conversations.find(c => c.id === fpState.selectedConvoId);
  if (!convo) return;
  const enabled = $('#fpAutoReplyEnabled').checked;
  const r = await api('/api/auto-reply/thread', {
    method: 'POST',
    body: {
      ownId: convo.pageId,            // dùng pageId làm ownId cho FB
      threadId: fpState.selectedConvoId,
      threadType: 99,                  // 99 = FB conversation
      enabled,
      mode: 'ai',
      delay_min_sec: 3,
      delay_max_sec: 10,
      max_per_hour: 30,
      manual_cooldown_min: 10,
    },
  });
  if (!r.ok) { toast('Lỗi lưu setting: ' + r.error, 'err'); return; }
  $('#fpAutoReplyStatus').textContent = enabled ? '🟢 Đang bật' : 'Đang tắt';
  toast(enabled ? '✅ Đã bật AI auto-reply' : 'Đã tắt', 'ok');
}

async function refreshFpAutoReplyState() {
  if (!fpState.selectedConvoId) return;
  const convo = fpState.conversations.find(c => c.id === fpState.selectedConvoId);
  if (!convo) return;
  const r = await api(`/api/auto-reply/thread/${convo.pageId}/${fpState.selectedConvoId}`);
  const enabled = !!(r.ok && r.data?.enabled);
  $('#fpAutoReplyEnabled').checked = enabled;
  $('#fpAutoReplyStatus').textContent = enabled ? '🟢 Đang bật' : 'Đang tắt';
}

// Emoji catalog với tag tiếng Anh để search
const FP_EMOJI_CATALOG = [
  { e: '😊', t: 'smile happy vui' }, { e: '😄', t: 'happy laugh cười' },
  { e: '😂', t: 'laugh lol cười rớt' }, { e: '🥰', t: 'love yêu' },
  { e: '😍', t: 'love heart yêu mê' }, { e: '😎', t: 'cool ngầu' },
  { e: '🤔', t: 'thinking suy nghĩ' }, { e: '😅', t: 'sweat ngại' },
  { e: '🥲', t: 'tearful xúc động' }, { e: '😢', t: 'cry khóc buồn' },
  { e: '😭', t: 'cry tears khóc' }, { e: '😡', t: 'angry giận' },
  { e: '🤯', t: 'mind blown sốc' }, { e: '🙏', t: 'thanks cảm ơn pray' },
  { e: '👍', t: 'thumbs up like ok đồng ý' }, { e: '👎', t: 'thumbs down không' },
  { e: '👌', t: 'ok okay được' }, { e: '✌️', t: 'peace V hai' },
  { e: '🤝', t: 'handshake bắt tay' }, { e: '👏', t: 'clap vỗ tay' },
  { e: '🙌', t: 'raise hands yay' }, { e: '👋', t: 'wave chào hi' },
  { e: '💪', t: 'strong muscle mạnh' }, { e: '🤞', t: 'fingers crossed' },
  { e: '❤️', t: 'red heart yêu' }, { e: '🧡', t: 'orange heart' },
  { e: '💛', t: 'yellow heart' }, { e: '💚', t: 'green heart' },
  { e: '💙', t: 'blue heart' }, { e: '💜', t: 'purple heart' },
  { e: '🖤', t: 'black heart' }, { e: '🤍', t: 'white heart' },
  { e: '💔', t: 'broken heart đau' }, { e: '💕', t: 'two hearts' },
  { e: '💯', t: 'hundred 100 tuyệt' }, { e: '🔥', t: 'fire hot hot trend' },
  { e: '✨', t: 'sparkles lấp lánh' }, { e: '🌟', t: 'star sao' },
  { e: '⭐', t: 'star' }, { e: '💫', t: 'dizzy stars' },
  { e: '🎉', t: 'party tada chúc mừng' }, { e: '🎊', t: 'confetti' },
  { e: '🎁', t: 'gift quà tặng' }, { e: '🎂', t: 'cake birthday' },
  { e: '🍰', t: 'cake bánh' }, { e: '☕', t: 'coffee cafe' },
  { e: '🍵', t: 'tea trà' }, { e: '🍻', t: 'beer bia' },
  { e: '🥂', t: 'cheers chúc mừng' }, { e: '✅', t: 'check ok done xong' },
  { e: '❌', t: 'cross x sai' }, { e: '⚠️', t: 'warning cảnh báo' },
  { e: '❓', t: 'question hỏi' }, { e: '❗', t: 'exclamation' },
  { e: '💡', t: 'idea ý tưởng bóng đèn' }, { e: '📞', t: 'phone call gọi' },
  { e: '📱', t: 'mobile phone đt' }, { e: '💻', t: 'laptop máy tính' },
  { e: '⏰', t: 'clock alarm chuông' }, { e: '⏳', t: 'hourglass đợi' },
  { e: '📍', t: 'pin location vị trí' }, { e: '📌', t: 'pushpin ghim' },
  { e: '🛒', t: 'cart mua' }, { e: '💰', t: 'money bag tiền' },
  { e: '💸', t: 'money fly tiền bay' }, { e: '🏷️', t: 'tag nhãn giá' },
];

function insertFpEmoji() {
  openModal('modalFpEmoji');
  $('#fpEmojiSearch').value = '';
  renderFpEmojiGrid('');
  setTimeout(() => $('#fpEmojiSearch').focus(), 100);
  $('#fpEmojiSearch').oninput = (e) => renderFpEmojiGrid(e.target.value);
}

function renderFpEmojiGrid(q) {
  const query = (q || '').toLowerCase().trim();
  const list = query ? FP_EMOJI_CATALOG.filter(x => x.t.includes(query)) : FP_EMOJI_CATALOG;
  const grid = $('#fpEmojiGrid');
  if (!list.length) { grid.innerHTML = '<div class="status-line" style="grid-column:span 10">Không có emoji khớp</div>'; return; }
  grid.innerHTML = list.map(x => `<button type="button" class="fp-emo-btn" data-e="${x.e}" title="${x.t}" style="font-size:24px;padding:6px;background:transparent;border:1px solid transparent;border-radius:6px;cursor:pointer">${x.e}</button>`).join('');
  grid.querySelectorAll('.fp-emo-btn').forEach(b => {
    b.onmouseenter = () => { b.style.background = 'var(--accent)'; b.style.borderColor = 'var(--border)'; };
    b.onmouseleave = () => { b.style.background = 'transparent'; b.style.borderColor = 'transparent'; };
    b.onclick = () => {
      const input = $('#fpInput');
      const cursorPos = input.selectionStart;
      input.value = input.value.slice(0, cursorPos) + b.dataset.e + input.value.slice(cursorPos);
      closeModal();
      input.focus();
      input.setSelectionRange(cursorPos + b.dataset.e.length, cursorPos + b.dataset.e.length);
    };
  });
}

function openFpTemplatePicker() {
  // Reuse existing templates from Zalo (templates table chung)
  api('/api/chat/templates/' + (state.ownId || 'all')).then(r => {
    const list = r.ok ? (r.data || []) : [];
    if (!list.length) return toast('Chưa có mẫu nào. Vào tab Template để tạo.', 'info');
    const choice = prompt('Chọn template (gõ số):\n\n' + list.map((t, i) => `${i + 1}. ${t.title || t.content.slice(0, 40)}`).join('\n'));
    const idx = parseInt(choice) - 1;
    if (idx >= 0 && idx < list.length) {
      $('#fpInput').value = list[idx].content;
      $('#fpInput').focus();
    }
  });
}

function searchInFbChat() {
  const q = prompt('Tìm trong hội thoại này:');
  if (!q) return;
  const matches = (fpState.lastMessages || []).filter(m => (m.content || '').toLowerCase().includes(q.toLowerCase()));
  toast(`Tìm thấy ${matches.length} tin chứa "${q}"`, matches.length ? 'ok' : 'info');
}

async function forwardFpMessage(msg) {
  if (!msg) return;
  // Lấy danh sách conversations của tất cả pages user đang quản lý
  const convoList = fpState.conversations.filter(c => c.id !== fpState.selectedConvoId);
  if (!convoList.length) return toast('Không có hội thoại khác để chuyển tiếp', 'err');

  // Render modal đơn giản
  const html = convoList.slice(0, 30).map((c, i) =>
    `${i + 1}. ${c.customerName || 'Khách FB'} — ${(c.lastMsg || '').slice(0, 30)}`
  ).join('\n');
  const choice = prompt(`Chuyển tiếp tới hội thoại (gõ số):\n\n${html}\n\nNội dung sẽ gửi:\n"${(msg.content || '').slice(0, 100)}"`, '1');
  const idx = parseInt(choice) - 1;
  if (idx < 0 || idx >= convoList.length || isNaN(idx)) return;

  const target = convoList[idx];
  const r = await api(`/api/fb/conversations/${target.id}/send`, {
    method: 'POST',
    body: { content: msg.content, isNote: false },
  });
  if (r.ok) toast(`Đã chuyển tiếp tới ${target.customerName}`, 'ok');
  else toast('Lỗi: ' + r.error, 'err');
}

async function suggestFbReply() {
  if (!fpState.selectedConvoId) return toast('Chọn hội thoại trước', 'err');
  const msgs = fpState.lastMessages || [];
  if (!msgs.length) return toast('Chưa có tin nhắn để AI phân tích', 'err');
  const convo = fpState.conversations.find(c => c.id === fpState.selectedConvoId);
  if (!convo) return;
  toast('⏳ Đang hỏi AI...', 'info');
  // Build context từ 10 tin gần nhất
  const ctx = msgs.slice(-10).map(m => `${m.isFromPage ? 'TÔI' : (m.fromName || 'KHÁCH')}: ${m.content || ''}`).join('\n');
  const userMsg = `Đây là cuộc trò chuyện Facebook Messenger với khách:\n\n${ctx}\n\nSoạn cho tôi 1 câu reply tự nhiên, đúng tone "bên mình - bạn". Chỉ trả về câu reply, không giải thích.`;
  const r = await api('/api/ai/chat', { method: 'POST', body: { messages: [{ role: 'user', content: userMsg }], model: 'haiku', task: 'quick' } });
  if (!r.ok) return toast('Lỗi AI: ' + r.error, 'err');
  const suggestion = r.data?.content || '';
  if (suggestion) {
    $('#fpInput').value = suggestion;
    $('#fpInput').focus();
    toast('✨ AI đã gợi ý — xem ô soạn tin', 'ok');
  }
}

function renderFpInfoPanel() {
  if (!fpState.selectedConvoId) return;
  const convo = fpState.conversations.find(c => c.id === fpState.selectedConvoId);
  if (!convo) return;

  // Labels chips (cùng style Zalo)
  const labelsBox = $('#fpInfoLabels');
  if (labelsBox) {
    let labels = [];
    try { labels = convo.labels ? JSON.parse(convo.labels) : []; } catch {}
    if (labels.length) {
      labelsBox.innerHTML = '<div class="thread-labels" style="display:flex;flex-wrap:wrap;gap:6px">' + labels.map(l => {
        const lbl = (state.labelsCache || []).find(x => x.name === l);
        const color = lbl?.color || '#fbbf24';
        return `<span class="lb" style="background:${color}22;color:${color}"><span class="lb-dot" style="background:${color}"></span>${escapeHtml(l)}</span>`;
      }).join('') + '</div>';
    } else {
      labelsBox.innerHTML = '<div class="hint" style="font-size:11px">Chưa gắn nhãn.</div>';
    }
  }

  // Notes (private notes là tin có isNote=1)
  const notesBox = $('#fpInfoNotes');
  if (notesBox && fpState.lastMessages) {
    const notes = fpState.lastMessages.filter(m => m.isNote);
    if (notes.length) {
      notesBox.innerHTML = notes.map(n => {
        const time = new Date(n.ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
        return `<div style="background:rgba(250,204,21,.1);border-left:3px solid rgb(202,138,4);padding:8px;margin-bottom:6px;border-radius:4px;font-size:12px">
          <div style="color:var(--muted-foreground);font-size:10px;margin-bottom:2px">${time}</div>
          ${escapeHtml(n.content)}
        </div>`;
      }).join('');
    } else {
      notesBox.innerHTML = '<div class="hint" style="font-size:11px">Chưa có ghi chú. Tab "Ghi chú nội bộ" khi soạn → thêm.</div>';
    }
  }

  // Update meta line (first seen + msg count)
  if (convo.createdAt) {
    $('#fpInfoFirstSeen').textContent = `Lần đầu ${new Date(convo.createdAt * 1000).toLocaleDateString('vi-VN')}`;
  }
}

function openFbConvoLabels(evt) {
  if (!fpState.selectedConvoId) return toast('Chọn hội thoại trước', 'err');
  const labels = state.labelsCache || [];
  if (!labels.length) return toast('Chưa có nhãn nào. Vào Quản lý nhãn để tạo.', 'info');
  const convo = fpState.conversations.find(c => c.id === fpState.selectedConvoId);
  if (!convo) return;
  const existing = (() => { try { return JSON.parse(convo.labels || '[]'); } catch { return []; } })();
  // Toạ độ mở menu — nếu không có event thì căn giữa
  const e = evt && evt.clientX ? evt : { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 };

  closeMsgContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu label-picker';
  menu.id = CTX_MENU_ID;
  menu.innerHTML = `
    <div style="font-size:11px;font-weight:600;padding:6px 10px;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.06em">Gắn nhãn cho hội thoại Fanpage</div>
    <div class="label-picker-list">
      ${labels.map(lb => `
        <label class="filter-check" data-lb="${escapeHtml(lb.name)}">
          <input type="checkbox" ${existing.includes(lb.name) ? 'checked' : ''} />
          <span class="lb-dot" style="background:${lb.color}"></span>
          <span>${escapeHtml(lb.name)}</span>
        </label>
      `).join('')}
    </div>
  `;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  let x = e.clientX, y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.onchange = async (ev) => {
      ev.stopPropagation();
      const name = cb.closest('label').dataset.lb;
      let arr = [];
      try { arr = JSON.parse(convo.labels || '[]'); } catch {}
      const idx = arr.indexOf(name);
      if (cb.checked && idx < 0) arr.push(name);
      if (!cb.checked && idx >= 0) arr.splice(idx, 1);
      const r = await api(`/api/fb/conversations/${fpState.selectedConvoId}/labels`, { method: 'POST', body: { labels: arr } });
      if (!r.ok) { toast('Lỗi: ' + r.error, 'err'); cb.checked = !cb.checked; return; }
      convo.labels = JSON.stringify(arr);
      renderFbConvos();
      renderFpInfoPanel();
      renderFpLabelFilters();
    };
  });
  menu.onclick = (ev) => ev.stopPropagation();
  setTimeout(() => document.addEventListener('click', closeMsgContextMenu, { once: true }), 0);
}

function openAutoClassifyModal() {
  if (!fpState.selectedPageId) return toast('Chọn Fanpage trước', 'err');
  openModal('modalAutoClassify');
  $('#acAddServiceBtn').onclick = () => {
    const idx = document.querySelectorAll('.ac-service').length;
    const html = `<div class="ac-service" data-i="${idx}" style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <input type="color" class="ac-color" value="#f59e0b" />
        <input type="text" class="ac-label" placeholder="Tên nhãn" style="flex:1" />
        <button class="btn-icon" data-act="del-service" title="Xoá">🗑</button>
      </div>
      <textarea class="ac-desc" rows="3" placeholder="Mô tả dịch vụ"></textarea>
    </div>`;
    $('#acAddServiceBtn').insertAdjacentHTML('beforebegin', html);
    bindAcServiceDel();
  };
  bindAcServiceDel();
  $('#acStartBtn').onclick = startAutoClassify;
}

function bindAcServiceDel() {
  document.querySelectorAll('[data-act="del-service"]').forEach(b => {
    b.onclick = (e) => e.target.closest('.ac-service').remove();
  });
}

async function startAutoClassify() {
  const services = [];
  document.querySelectorAll('.ac-service').forEach(s => {
    const label = s.querySelector('.ac-label').value.trim();
    const color = s.querySelector('.ac-color').value;
    const description = s.querySelector('.ac-desc').value.trim();
    if (label && description) services.push({ label, color, description });
  });
  if (!services.length) return toast('Cần ít nhất 1 dịch vụ', 'err');

  $('#acStartBtn').disabled = true;
  $('#acStatus').innerHTML = '⏳ Đang gửi yêu cầu...';

  const r = await api(`/api/fb/pages/${fpState.selectedPageId}/auto-classify`, {
    method: 'POST',
    body: { services, autoCreateLabels: true },
  });
  if (!r.ok) {
    $('#acStatus').innerHTML = '❌ ' + r.error;
    $('#acStartBtn').disabled = false;
    return;
  }
  $('#acStatus').innerHTML = '✅ Đã bắt đầu phân loại trong background. Có thể đóng modal — theo dõi qua WebSocket toast.';
}

async function syncAllFbConversations() {
  if (!fpState.selectedPageId) return toast('Chọn Fanpage trước', 'err');
  if (!confirm(`Đồng bộ TẤT CẢ hội thoại của Fanpage này?\n\nApp sẽ kéo về tối đa 100 conversations, mỗi cái 50 tin gần nhất. Quá trình mất 1-3 phút.`)) return;

  $('#fpSyncStatus').innerHTML = '⏳ Đang gọi Facebook Graph API...';
  const btn = $('#fpSyncAllBtn');
  btn.disabled = true;

  const r = await api(`/api/fb/pages/${fpState.selectedPageId}/sync-all?limit=100&msgs=50`, { method: 'POST' });
  if (!r.ok) {
    $('#fpSyncStatus').innerHTML = '❌ ' + r.error;
    btn.disabled = false;
    toast('Lỗi: ' + r.error, 'err');
    return;
  }
  fpState.syncTaskId = r.taskId;
  $('#fpSyncStatus').innerHTML = '⏳ Đang đồng bộ... (xem progress qua WebSocket)';
  // Button sẽ unlock khi nhận task-done
}

async function setFbConvoStatus(status) {
  if (!fpState.selectedConvoId) return;
  await api(`/api/fb/conversations/${fpState.selectedConvoId}/status`, { method: 'POST', body: { status } });
  toast('Đã đổi trạng thái: ' + status, 'ok');
  loadFbConvos();
}

async function initAccountsPage() {
  await loadAccounts();
  renderAccountsPage();
  $('#paRefreshBtn').onclick = async () => { await loadAccounts(); renderAccountsPage(); };
  $('#paAddBtn').onclick = () => openModal('modalAddAcc');
  if (window.lucide) window.lucide.createIcons();
}

function renderAccountsPage() {
  const box = $('#paAccountsList');
  const accs = state.accounts || [];
  $('#paSummary').textContent = accs.length ? `${accs.length} tài khoản · ${accs.filter(a => a.connected).length} đang kết nối` : '';
  if (!accs.length) {
    box.innerHTML = '<div class="empty" style="padding:40px">Chưa có tài khoản. Bấm "Thêm tài khoản" để bắt đầu.</div>';
    return;
  }
  box.innerHTML = `<div class="pa-table">
    <div class="pa-row pa-head">
      <div>Tài khoản</div>
      <div>Trạng thái</div>
      <div>Proxy</div>
      <div style="text-align:right">Thao tác</div>
    </div>
    ${accs.map(a => {
      const proxy = a.proxy || '';
      return `<div class="pa-row" data-id="${a.ownId}">
        <div class="pa-acc">
          <div class="avatar md" ${a.avatar ? `style="background-image:url('${a.avatar}')"` : ''}>${a.avatar ? '' : escapeHtml(avatarText(a.name || 'Acc'))}</div>
          <div class="pa-info">
            <div class="pa-name">${escapeHtml(a.name || 'Tài khoản')}</div>
            <div class="pa-id">${a.ownId}</div>
          </div>
        </div>
        <div>
          <span class="pa-badge ${a.connected ? 'on' : 'off'}">
            <span class="pa-dot"></span>${a.connected ? 'Đang kết nối' : 'Mất kết nối'}
          </span>
        </div>
        <div class="pa-proxy">
          <input type="text" class="pa-proxy-input" value="${escapeHtml(proxy)}"
                 placeholder="host:port:user:pass hoặc http://user:pass@host:port" />
          <button class="btn-ghost pa-proxy-save" title="Lưu proxy"><i data-lucide="save"></i></button>
        </div>
        <div class="pa-actions">
          ${a.connected
            ? `<button class="btn-ghost pa-disconnect" title="Ngắt kết nối"><i data-lucide="power-off"></i></button>`
            : `<button class="btn-primary pa-connect" title="Kết nối lại"><i data-lucide="plug"></i> Kết nối</button>`}
          <button class="btn-ghost pa-remove" title="Xoá tài khoản" style="color:var(--destructive)"><i data-lucide="trash-2"></i></button>
        </div>
      </div>`;
    }).join('')}
  </div>`;

  box.querySelectorAll('.pa-row[data-id]').forEach(row => {
    const ownId = row.dataset.id;
    row.querySelector('.pa-proxy-save').onclick = () => saveAccountProxy(ownId, row.querySelector('.pa-proxy-input').value);
    const connectBtn = row.querySelector('.pa-connect');
    if (connectBtn) connectBtn.onclick = () => connectAccount(ownId);
    const disconnectBtn = row.querySelector('.pa-disconnect');
    if (disconnectBtn) disconnectBtn.onclick = () => disconnectAccount(ownId);
    row.querySelector('.pa-remove').onclick = () => removeAccount(ownId);
  });

  if (window.lucide) window.lucide.createIcons();
}

async function saveAccountProxy(ownId, proxy) {
  const r = await api(`/api/chat/account-set-proxy/${ownId}`, { method: 'POST', body: { proxy } });
  if (r.ok) {
    toast('Đã lưu proxy. Cần ngắt + kết nối lại để áp dụng.', 'ok');
    await loadAccounts(); renderAccountsPage();
  } else toast('Lỗi: ' + (r.error || ''), 'err');
}

async function connectAccount(ownId) {
  toast('Đang kết nối...', 'info');
  const r = await api(`/api/chat/account-connect/${ownId}`, { method: 'POST' });
  if (r.ok) { toast('Đã kết nối', 'ok'); await loadAccounts(); renderAccountsPage(); }
  else toast('Lỗi: ' + (r.error || ''), 'err');
}

async function disconnectAccount(ownId) {
  if (!confirm('Ngắt kết nối tài khoản này?')) return;
  const r = await api(`/api/chat/account-disconnect/${ownId}`, { method: 'POST' });
  if (r.ok) { toast('Đã ngắt kết nối', 'ok'); await loadAccounts(); renderAccountsPage(); }
  else toast('Lỗi: ' + (r.error || ''), 'err');
}

async function removeAccount(ownId) {
  if (!confirm('Xoá tài khoản khỏi hệ thống? (Tin nhắn cũ vẫn được giữ lại)')) return;
  const r = await api(`/api/chat/account-remove/${ownId}`, { method: 'POST' });
  if (r.ok) { toast('Đã xoá', 'ok'); await loadAccounts(); renderAccountsPage(); }
  else toast('Lỗi: ' + (r.error || ''), 'err');
}

async function initSettingsPage() {
  if (window.lucide) window.lucide.createIcons();
  const r = await api('/api/settings/ai');
  const s = r.ok ? r.data : { provider: 'claude-cli', model: 'sonnet' };
  $('#stProvider').value = s.provider || 'claude-cli';
  $('#stModel').value = s.model || 'sonnet';
  $('#stAnthropicKey').value = '';
  $('#stOpenAiKey').value = '';
  $('#stLocalUrl').value = s.localUrl || 'http://127.0.0.1:11434';
  $('#stAnthropicStatus').textContent = s.anthropicKeySet ? '✓ Đã có' : '(chưa nhập)';
  $('#stOpenAiStatus').textContent = s.openaiKeySet ? '✓ Đã có' : '(chưa nhập)';
  renderChatGptOAuthStatus({
    connected: s.chatgptOAuthConnected,
    planType: s.chatgptOAuthPlanType,
    accountId: s.chatgptOAuthAccountId,
  });
  toggleStSections();
  $('#stProvider').onchange = toggleStSections;
  $('#stSaveBtn').onclick = saveAiSettings;
  $('#stCliLoginBtn').onclick = startCliLogin;
  $('#stCliSubmitBtn').onclick = submitCliCode;
  $('#stCliOpenUrlBtn').onclick = () => {
    const u = $('#stCliAuthUrl').value;
    if (u) window.open(u, '_blank', 'noopener');
  };
  $('#stCliCopyUrlBtn').onclick = async () => {
    const u = $('#stCliAuthUrl').value;
    if (!u) return;
    try { await navigator.clipboard.writeText(u); toast('Đã sao chép đường dẫn', 'ok'); }
    catch { $('#stCliAuthUrl').select(); document.execCommand('copy'); toast('Đã sao chép đường dẫn', 'ok'); }
  };
  $('#stCliCode').onkeydown = (e) => { if (e.key === 'Enter') submitCliCode(); };
  cliAuthSession = null;
  $('#stCliLoginFlow').classList.add('hidden');
  $('#stCliLoginStatus').textContent = '';
  $('#stOpenAiTestBtn').onclick = testOpenAiKey;
  $('#stLocalTestBtn').onclick = testLocalLlm;
  $('#stChatGptLoginBtn').onclick = startChatGptOAuthLogin;
  $('#stChatGptSubmitBtn').onclick = submitChatGptOAuthRedirect;
  $('#stChatGptLogoutBtn').onclick = logoutChatGptOAuth;
  $('#stChatGptOpenUrlBtn').onclick = () => {
    const u = $('#stChatGptAuthUrl').value;
    if (u) window.open(u, '_blank', 'noopener');
  };
  $('#stChatGptCopyUrlBtn').onclick = async () => {
    const u = $('#stChatGptAuthUrl').value;
    if (!u) return;
    try { await navigator.clipboard.writeText(u); toast('Đã sao chép đường dẫn', 'ok'); }
    catch { $('#stChatGptAuthUrl').select(); document.execCommand('copy'); toast('Đã sao chép đường dẫn', 'ok'); }
  };
  $('#stChatGptRedirectUrl').onkeydown = (e) => { if (e.key === 'Enter') submitChatGptOAuthRedirect(); };
  chatGptOAuthFlowId = null;
  $('#stChatGptLoginFlow').classList.add('hidden');
  $('#stAddProductBtn').onclick = () => openProductModal(null);
  $('#mpSaveBtn').onclick = saveProduct;
  $('#stPromptPreviewBtn').onclick = () => openPromptPreview('full');
  document.querySelectorAll('[data-prev-mode]').forEach(b => {
    b.onclick = () => openPromptPreview(b.dataset.prevMode);
  });
  document.querySelectorAll('[data-usage-days]').forEach(b => {
    b.onclick = () => loadAiUsage(parseInt(b.dataset.usageDays, 10));
  });
  $('#stUsageRefreshBtn').onclick = () => loadAiUsage(aiUsageDays);
  loadAiUsage(aiUsageDays);
  loadPromptSections();
  loadProducts();
}

let aiUsageDays = 30;

function formatUsageNumber(n) {
  return Number(n || 0).toLocaleString('vi-VN');
}

function formatUsageUsd(n) {
  const value = Number(n || 0);
  return '$' + value.toLocaleString('en-US', {
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 6 : 2,
  });
}

function formatUsageCost(row) {
  return formatUsageUsd(row?.costUsd) + (Number(row?.unpricedCalls || 0) ? '*' : '');
}

function providerUsage(rows, provider) {
  return (rows || []).find(r => r.provider === provider) || {
    provider, calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    outputTokens: 0, totalTokens: 0, costUsd: 0, unpricedCalls: 0,
  };
}

function dailyUsageTotal(day) {
  return (day.providers || []).reduce((out, row) => {
    out.calls += Number(row.calls || 0);
    out.totalTokens += Number(row.totalTokens || 0);
    out.costUsd += Number(row.costUsd || 0);
    return out;
  }, { calls: 0, totalTokens: 0, costUsd: 0 });
}

async function loadAiUsage(days = 30) {
  aiUsageDays = days;
  document.querySelectorAll('[data-usage-days]').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.usageDays) === days);
  });
  const loading = $('#stUsageLoading');
  const content = $('#stUsageContent');
  loading.classList.remove('hidden');
  loading.textContent = 'Đang tải số liệu...';
  content.classList.add('hidden');
  try {
    const r = await api(`/api/settings/ai-usage?days=${days}`);
    if (!r.ok) throw new Error(r.error || 'Không tải được số liệu');
    renderAiUsage(r.data);
    loading.classList.add('hidden');
    content.classList.remove('hidden');
  } catch (e) {
    loading.textContent = 'Không tải được số liệu API: ' + e.message;
  }
}

function renderAiUsage(data) {
  const total = data.summary || {};
  const inputTotal = Number(total.inputTokens || 0) + Number(total.cacheReadTokens || 0) + Number(total.cacheWriteTokens || 0);
  const cacheTokens = Number(total.cacheReadTokens || 0);
  const cacheRate = inputTotal ? ((cacheTokens / inputTotal) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + '%' : '0%';
  $('#stUsageMetrics').innerHTML = [
    { label: 'Tổng chi phí', value: formatUsageCost(total), detail: `${formatUsageNumber(total.calls)} request API` },
    { label: 'Tổng token', value: formatUsageNumber(total.totalTokens), detail: `${formatUsageNumber(total.inputTokens)} input mới` },
    { label: 'Output token', value: formatUsageNumber(total.outputTokens), detail: 'Nội dung AI sinh ra' },
    { label: 'Cache đọc', value: formatUsageNumber(total.cacheReadTokens), detail: `${cacheRate} lượng input` },
  ].map(m => `<div class="usage-metric"><div class="usage-metric-label">${m.label}</div><div class="usage-metric-value">${m.value}</div><div class="usage-metric-detail">${m.detail}</div></div>`).join('');

  const providers = [
    { id: 'openai', label: 'OpenAI API' },
    { id: 'anthropic', label: 'Anthropic API' },
  ];
  $('#stUsageProviders').innerHTML = providers.map(p => {
    const row = providerUsage(data.providers, p.id);
    return `<div class="usage-provider ${p.id}">
      <div class="usage-provider-head">
        <span class="usage-provider-name"><span class="usage-provider-dot ${p.id}"></span>${p.label}</span>
        <span class="usage-provider-cost">${formatUsageCost(row)}</span>
      </div>
      <div class="usage-provider-data">
        <span>${formatUsageNumber(row.calls)} request</span>
        <span>${formatUsageNumber(row.totalTokens)} token</span>
        <span>${formatUsageNumber(row.outputTokens)} output</span>
      </div>
    </div>`;
  }).join('');

  renderAiUsageChart('#stUsageTokenChart', data.daily, 'totalTokens');
  renderAiUsageChart('#stUsageCostChart', data.daily, 'costUsd');
  renderAiUsageTables(data);
  $('#stUsageMeta').textContent = `Giá chuẩn API cập nhật ${data.pricingAsOf} · bắt đầu ghi nhận từ khi triển khai${Number(total.unpricedCalls || 0) ? ' · * có lượt chưa định giá' : ''}`;
}

function renderAiUsageChart(selector, daily, field) {
  const values = daily.map(day => {
    const openai = providerUsage(day.providers, 'openai');
    const anthropic = providerUsage(day.providers, 'anthropic');
    return {
      day: day.day,
      openai: Number(openai[field] || 0),
      anthropic: Number(anthropic[field] || 0),
      total: Number(openai[field] || 0) + Number(anthropic[field] || 0),
    };
  });
  const max = Math.max(0, ...values.map(v => v.total));
  const formatter = field === 'costUsd' ? formatUsageUsd : formatUsageNumber;
  const showEach = values.length <= 7 ? 1 : (values.length <= 30 ? 5 : 15);
  $(selector).innerHTML = values.map((v, i) => {
    const height = max ? Math.max(2, Math.round(v.total / max * 104)) : 2;
    const openaiHeight = v.total ? Math.round(height * v.openai / v.total) : 0;
    const anthropicHeight = v.total ? Math.max(0, height - openaiHeight) : 0;
    const label = (i % showEach === 0 || i === values.length - 1) ? v.day.slice(5).replace('-', '/') : '';
    return `<div class="usage-bar" title="${v.day}: ${formatter(v.total)}">
      <div class="usage-bar-stack ${v.total ? '' : 'empty'}" style="height:${height}px">
        ${anthropicHeight ? `<div class="usage-bar-part anthropic" style="height:${anthropicHeight}px"></div>` : ''}
        ${openaiHeight ? `<div class="usage-bar-part openai" style="height:${openaiHeight}px"></div>` : ''}
      </div>
      <span class="usage-bar-label">${label}</span>
    </div>`;
  }).join('');
}

function renderAiUsageTables(data) {
  const rows = [...data.daily].reverse().map(day => {
    const total = dailyUsageTotal(day);
    const openai = providerUsage(day.providers, 'openai');
    const anthropic = providerUsage(day.providers, 'anthropic');
    const date = day.day.split('-').reverse().join('/');
    return `<tr>
      <td>${date}</td>
      <td>${formatUsageNumber(total.calls)}</td>
      <td>${formatUsageNumber(openai.totalTokens)}</td>
      <td>${formatUsageCost(openai)}</td>
      <td>${formatUsageNumber(anthropic.totalTokens)}</td>
      <td>${formatUsageCost(anthropic)}</td>
      <td><b>${formatUsageCost({ costUsd: total.costUsd, unpricedCalls: Number(openai.unpricedCalls || 0) + Number(anthropic.unpricedCalls || 0) })}</b></td>
    </tr>`;
  }).join('');
  $('#stUsageDailyTable').innerHTML = `<thead><tr><th>Ngày</th><th>Lượt</th><th>OpenAI token</th><th>OpenAI USD</th><th>Anthropic token</th><th>Anthropic USD</th><th>Tổng USD</th></tr></thead><tbody>${rows}</tbody>`;

  const modelRows = (data.models || []).length ? data.models.map(row => `
    <tr>
      <td><span class="usage-provider-dot ${escapeHtml(row.provider)}"></span>${escapeHtml(row.model)}</td>
      <td>${row.provider === 'openai' ? 'OpenAI' : 'Anthropic'}</td>
      <td>${formatUsageNumber(row.calls)}</td>
      <td>${formatUsageNumber(row.inputTokens)}</td>
      <td>${formatUsageNumber(Number(row.cacheReadTokens || 0) + Number(row.cacheWriteTokens || 0))}</td>
      <td>${formatUsageNumber(row.outputTokens)}</td>
      <td>${formatUsageCost(row)}</td>
    </tr>`).join('') : '<tr><td colspan="7">Chưa có request API trong kỳ đã chọn</td></tr>';
  $('#stUsageModelTable').innerHTML = `<thead><tr><th>Model</th><th>Provider</th><th>Lượt</th><th>Input mới</th><th>Cache</th><th>Output</th><th>Chi phí</th></tr></thead><tbody>${modelRows}</tbody>`;
}

const PROMPT_SECTION_META = {
  identity: { label: '1. Role & Identity', icon: 'user-circle', hint: 'AI là ai? Nhiệm vụ chính? Đối tượng phục vụ (team nội bộ hay khách trực tiếp)' },
  businessContext: { label: '2. Business Context', icon: 'briefcase', hint: 'Brand, hotline, lĩnh vực, khách hàng mục tiêu, giá trị cốt lõi' },
  tone: { label: '3. Tone & Style', icon: 'mic', hint: 'Xưng hô, tính cách, độ dài, emoji, ngôn ngữ, cấm pattern AI, từ điển Anh→Việt' },
  behavioralRules: { label: '5. Behavioral Rules (DO/DON\'T)', icon: 'list-checks', hint: 'Hành vi BẮT BUỘC và CẤM khi gặp các tình huống thường gặp' },
  workflow: { label: '6. Workflow', icon: 'workflow', hint: 'Các bước AI nên đi qua khi xử lý 1 yêu cầu (đọc context → nhận diện SP → áp rule → đề xuất)' },
  escalation: { label: '7. Escalation Rules', icon: 'shield-alert', hint: 'Khi nào AI nên dừng tư vấn bình thường và đề xuất chuyển CSKH/sale senior' },
  examples: { label: '8. Examples (few-shot)', icon: 'sparkles', hint: '2-3 đoạn hội thoại mẫu cho AI học đúng tone + flow. Anthropic khuyến nghị quan trọng nhất' },
};

let promptSectionsState = { sections: {}, defaults: {}, usingDefault: {} };

async function loadPromptSections() {
  const r = await api('/api/settings/prompt-sections');
  if (!r.ok) return;
  promptSectionsState = r.data || promptSectionsState;
  renderPromptSections();
}

function renderPromptSections() {
  const list = $('#stPromptSectionsList');
  if (!list) return;
  const keys = promptSectionsState.keys || Object.keys(PROMPT_SECTION_META);
  list.innerHTML = keys.map(k => {
    const meta = PROMPT_SECTION_META[k] || { label: k, icon: 'file-text', hint: '' };
    const customVal = promptSectionsState.sections?.[k] || '';
    const usingDefault = promptSectionsState.usingDefault?.[k] !== false;
    const badge = usingDefault
      ? '<span style="font-size:10px;color:var(--muted-foreground);background:var(--accent);padding:2px 8px;border-radius:999px">mặc định</span>'
      : '<span style="font-size:10px;color:var(--primary);background:oklch(from var(--primary) l c h / 0.12);padding:2px 8px;border-radius:999px;font-weight:600">đã tùy chỉnh</span>';
    return `
      <details class="prompt-section" data-key="${k}" style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <summary style="padding:10px 12px;cursor:pointer;display:flex;align-items:center;gap:10px;background:var(--card);user-select:none">
          <i data-lucide="${meta.icon}" style="width:16px;height:16px;color:var(--primary);flex-shrink:0"></i>
          <span style="font-weight:600;font-size:13px;flex:1">${meta.label}</span>
          ${badge}
        </summary>
        <div style="padding:10px 12px;border-top:1px solid var(--border);background:var(--background)">
          <div class="hint" style="font-size:11px;margin-bottom:6px">${meta.hint}</div>
          <textarea data-section="${k}" rows="8" placeholder="(Dùng mặc định) — bấm 'Xem mặc định' để chép sang chỉnh"
            style="font-size:12px;font-family:ui-monospace,Menlo,monospace;line-height:1.5">${escapeHtml(customVal)}</textarea>
          <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px;flex-wrap:wrap">
            <button class="btn-ghost" data-act="show-default" data-key="${k}" style="font-size:11px;padding:4px 10px"><i data-lucide="eye"></i> Xem mặc định</button>
            <button class="btn-ghost" data-act="copy-default" data-key="${k}" style="font-size:11px;padding:4px 10px"><i data-lucide="copy"></i> Chép mặc định</button>
            <button class="btn-ghost" data-act="reset" data-key="${k}" style="font-size:11px;padding:4px 10px;color:var(--destructive)"><i data-lucide="rotate-ccw"></i> Reset</button>
            <button class="btn-primary" data-act="save" data-key="${k}" style="font-size:12px;padding:4px 12px"><i data-lucide="save"></i> Lưu phần này</button>
          </div>
        </div>
      </details>
    `;
  }).join('');

  list.querySelectorAll('[data-act]').forEach(btn => {
    const k = btn.dataset.key;
    const act = btn.dataset.act;
    btn.onclick = async () => {
      const ta = list.querySelector(`textarea[data-section="${k}"]`);
      if (act === 'save') {
        const r = await api('/api/settings/prompt-sections', { method: 'POST', body: { key: k, value: ta.value } });
        if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
        toast(`Đã lưu phần "${PROMPT_SECTION_META[k]?.label || k}"`, 'ok');
        loadPromptSections();
      } else if (act === 'reset') {
        if (!confirm(`Xoá nội dung tùy chỉnh phần "${PROMPT_SECTION_META[k]?.label || k}" và dùng lại mặc định?`)) return;
        ta.value = '';
        const r = await api('/api/settings/prompt-sections', { method: 'POST', body: { key: k, value: '' } });
        if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
        toast('Đã reset về mặc định', 'ok');
        loadPromptSections();
      } else if (act === 'show-default') {
        alert(`MẶC ĐỊNH cho "${PROMPT_SECTION_META[k]?.label || k}":\n\n${promptSectionsState.defaults?.[k] || ''}`);
      } else if (act === 'copy-default') {
        if (ta.value.trim() && !confirm('Textarea đang có nội dung. Ghi đè bằng mặc định?')) return;
        ta.value = promptSectionsState.defaults?.[k] || '';
        toast('Đã chép mặc định vào ô. Bấm "Lưu phần này" để áp dụng.', 'info');
      }
    };
  });

  // Status line
  const totalCustom = Object.values(promptSectionsState.usingDefault || {}).filter(v => v === false).length;
  const totalSec = (promptSectionsState.keys || []).length;
  $('#stPromptStatusLine').textContent = totalCustom > 0
    ? `✓ Đã tùy chỉnh ${totalCustom}/${totalSec} phần. Knowledge Base (phần 4) tự lấy từ Sản phẩm bên dưới.`
    : `Đang dùng mặc định toàn bộ. Knowledge Base (phần 4) tự lấy từ Sản phẩm bên dưới.`;

  if (window.lucide) window.lucide.createIcons();
}

async function openPromptPreview(mode = 'full') {
  const r = await api(`/api/settings/prompt-preview?mode=${mode}`);
  if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
  const d = r.data;
  $('#stPromptPreviewText').value = d.text;
  $('#stPromptPreviewLength').textContent = `${d.length.toLocaleString('vi-VN')} ký tự (mode: ${d.mode.toUpperCase()})`;
  // Highlight active mode button
  document.querySelectorAll('[data-prev-mode]').forEach(b => {
    b.style.background = b.dataset.prevMode === d.mode ? 'oklch(from var(--primary) l c h / 0.15)' : '';
  });
  openModal('modalPromptPreview');
}

let productsCache = [];
async function loadProducts() {
  const r = await api('/api/products');
  productsCache = r.ok ? r.data : [];
  renderProductList();
}

function renderProductList() {
  const list = $('#stProductList');
  if (!productsCache.length) {
    list.innerHTML = '<div class="hint">Chưa có sản phẩm. Bấm "Thêm sản phẩm" ở góc trên.</div>';
    return;
  }
  list.innerHTML = productsCache.map(p => `
    <div class="product-row" data-id="${p.id}">
      <div style="flex:1;min-width:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span style="font-weight:600">${escapeHtml(p.name)}</span>
          <span class="badge${p.enabled ? '' : ' off'}">${p.enabled ? 'ON' : 'OFF'}</span>
          <span class="badge muted">P${p.priority}</span>
          <code style="font-size:11px;opacity:.7">${escapeHtml(p.id)}</code>
        </div>
        <div style="font-size:12px;color:var(--muted-foreground);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((p.target || '').slice(0, 120))}</div>
      </div>
      <button class="btn-ghost" data-act="edit" title="Sửa"><i data-lucide="pencil"></i></button>
      <button class="btn-ghost" data-act="del" title="Xoá" style="color:var(--destructive)"><i data-lucide="trash-2"></i></button>
    </div>
  `).join('');
  list.querySelectorAll('.product-row').forEach(row => {
    const id = row.dataset.id;
    row.querySelector('[data-act="edit"]').onclick = () => openProductModal(id);
    row.querySelector('[data-act="del"]').onclick = async () => {
      const p = productsCache.find(x => x.id === id);
      if (!confirm('Xoá sản phẩm "' + p.name + '"?')) return;
      const r = await api('/api/products/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
      toast('Đã xoá', 'ok');
      loadProducts();
    };
  });
  if (window.lucide) window.lucide.createIcons();
}

function openProductModal(id) {
  const p = id ? productsCache.find(x => x.id === id) : null;
  $('#mpTitle').textContent = p ? 'Sửa: ' + p.name : 'Thêm sản phẩm';
  $('#mpId').value = p ? p.id : '';
  $('#mpId').disabled = !!p;
  $('#mpName').value = p ? p.name : '';
  $('#mpTarget').value = p ? (p.target || '') : '';
  $('#mpUsp').value = p ? (p.usp || '') : '';
  $('#mpPricing').value = p ? (p.pricing_note || '') : '';
  $('#mpKeywords').value = p ? (p.keywords || '') : '';
  $('#mpQQ').value = p ? (p.qualify_questions || []).join('\n') : '';
  $('#mpClose').value = p ? (p.close_script || '') : '';
  $('#mpObj').value = p ? (p.objections || []).map(o => `${o.q} | ${o.a}`).join('\n') : '';
  $('#mpPriority').value = p ? p.priority : 99;
  $('#mpEnabled').checked = p ? !!p.enabled : true;
  openModal('modalProduct');
}

async function saveProduct() {
  const id = $('#mpId').value.trim();
  const name = $('#mpName').value.trim();
  if (!id || !name) return toast('Cần nhập ID và Tên sản phẩm', 'err');
  if (!/^[a-z0-9-]+$/.test(id)) return toast('ID chỉ chứa a-z, 0-9, dấu gạch', 'err');
  const objs = $('#mpObj').value.trim().split('\n').filter(Boolean).map(l => {
    const [q, ...rest] = l.split('|');
    return { q: (q || '').trim(), a: rest.join('|').trim() };
  }).filter(o => o.q);
  const qq = $('#mpQQ').value.trim().split('\n').map(s => s.trim()).filter(Boolean);
  const body = {
    id, name,
    target: $('#mpTarget').value.trim(),
    usp: $('#mpUsp').value.trim(),
    pricing_note: $('#mpPricing').value.trim(),
    keywords: $('#mpKeywords').value.trim(),
    qualify_questions: qq,
    close_script: $('#mpClose').value.trim(),
    objections: objs,
    priority: parseInt($('#mpPriority').value) || 99,
    enabled: $('#mpEnabled').checked,
  };
  const r = await api('/api/products', { method: 'POST', body });
  if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
  toast('Đã lưu', 'ok');
  closeModal('modalProduct');
  loadProducts();
}

let cliAuthSession = null;
let cliAuthPollTimer = null;
let chatGptOAuthFlowId = null;
let chatGptOAuthConnected = false;

function stopCliPoll() {
  if (cliAuthPollTimer) { clearInterval(cliAuthPollTimer); cliAuthPollTimer = null; }
}

function cliLoginSuccess() {
  stopCliPoll();
  cliAuthSession = null;
  $('#stCliLoginFlow').classList.add('hidden');
  $('#stCliLoginStatus').textContent = '✓ Đã đăng nhập Claude CLI';
  $('#stCliLoginBtn').disabled = false;
  $('#stCliSubmitBtn').disabled = false;
  toast('Đăng nhập Claude thành công', 'ok');
}

function cliLoginFail(msg) {
  stopCliPoll();
  cliAuthSession = null;
  $('#stCliLoginStatus').textContent = '';
  $('#stCliLoginBtn').disabled = false;
  $('#stCliSubmitBtn').disabled = false;
  toast('Lỗi: ' + msg, 'err');
}

async function startCliLogin() {
  stopCliPoll();
  const btn = $('#stCliLoginBtn');
  btn.disabled = true;
  $('#stCliLoginStatus').textContent = 'Đang khởi tạo... (browser có thể tự mở)';
  $('#stCliLoginFlow').classList.add('hidden');
  const r = await api('/api/settings/claude-login/start', { method: 'POST', body: {} });
  if (!r.ok) return cliLoginFail(r.error);

  if (r.autoCompleted) {
    cliLoginSuccess();
    return;
  }
  cliAuthSession = r.sessionId;
  $('#stCliAuthUrl').value = r.authUrl;
  $('#stCliCode').value = '';
  $('#stCliLoginFlow').classList.remove('hidden');
  $('#stCliLoginStatus').textContent = 'Đang chờ login (nếu browser mở sẵn → tự hoàn tất)';
  btn.disabled = false;

  cliAuthPollTimer = setInterval(async () => {
    if (!cliAuthSession) return stopCliPoll();
    const p = await api('/api/settings/claude-login/poll?sessionId=' + encodeURIComponent(cliAuthSession));
    if (!p.ok) return;
    if (p.state === 'success') return cliLoginSuccess();
    if (p.state === 'failed') return cliLoginFail(p.error || 'Login thất bại');
    if (p.state === 'gone') return cliLoginFail('Session hết hạn');
  }, 2000);
}

async function submitCliCode() {
  if (!cliAuthSession) return toast('Bấm "Đăng nhập Claude" trước', 'err');
  const code = $('#stCliCode').value.trim();
  if (!code) return toast('Nhập code', 'err');
  const btn = $('#stCliSubmitBtn');
  btn.disabled = true;
  $('#stCliLoginStatus').textContent = 'Đang xác thực code...';
  const r = await api('/api/settings/claude-login/submit', {
    method: 'POST',
    body: { sessionId: cliAuthSession, code },
  });
  btn.disabled = false;
  if (r.ok) return cliLoginSuccess();
  // Don't kill session on submit timeout — keep polling
  if (/Timeout/i.test(r.error || '')) {
    $('#stCliLoginStatus').textContent = 'Đang đợi thêm... (sẽ tự cập nhật)';
    return;
  }
  cliLoginFail(r.error);
}

function toggleStSections() {
  const p = $('#stProvider').value;
  $('#stAnthropicWrap').classList.toggle('hidden', p !== 'anthropic');
  $('#stOpenAiWrap').classList.toggle('hidden', p !== 'openai');
  $('#stLocalWrap').classList.toggle('hidden', p !== 'local');
  $('#stChatGptOauthWrap').classList.toggle('hidden', p !== 'chatgpt-oauth');
  $('#stCliInfo').classList.toggle('hidden', p !== 'claude-cli');
  // Auto-set default model when switching
  const modelEl = $('#stModel');
  if (p === 'openai' && !modelEl.value.startsWith('gpt')) modelEl.value = 'gpt-5.4-mini';
  const oauthModels = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex'];
  if (p === 'chatgpt-oauth' && !oauthModels.includes(modelEl.value)) modelEl.value = 'gpt-5.4-mini';
  if ((p === 'anthropic' || p === 'claude-cli') && (modelEl.value.startsWith('gpt') || modelEl.value.startsWith('qwen3:'))) modelEl.value = 'sonnet';
  if (p === 'local' && !modelEl.value.startsWith('qwen3:')) modelEl.value = 'qwen3:4b-q4_K_M';
}

async function testOpenAiKey() {
  const key = $('#stOpenAiKey').value.trim();
  const box = $('#stOpenAiTestResult');
  box.classList.remove('hidden');
  box.innerHTML = key ? '⏳ Đang kiểm tra key vừa nhập...' : '⏳ Đang kiểm tra key đã lưu...';
  // Nếu user nhập key mới → test key đó. Nếu chưa nhập → server tự dùng key đã lưu (fallback)
  const r = await api('/api/settings/openai/test', { method: 'POST', body: { apiKey: key } });
  if (!r.ok) {
    box.innerHTML = `❌ <span style="color:var(--destructive)">${escapeHtml(r.error)}</span>`;
    return;
  }
  const gpt5Tag = r.hasGpt5
    ? `<span style="color:var(--success);font-weight:600">✓ Có GPT-5 (${r.gpt5Sample.join(', ')})</span>`
    : `<span style="color:var(--muted-foreground)">Chưa có GPT-5 — có thể cần tier cao hơn. Hiện key dùng được: ${r.gpt4Sample.slice(0, 3).join(', ')}</span>`;
  box.innerHTML = `
    ✓ Key hợp lệ · Tổng ${r.totalModels} model khả dụng<br>
    ${gpt5Tag}
  `;
}

async function testLocalLlm() {
  const localUrl = $('#stLocalUrl').value.trim() || 'http://127.0.0.1:11434';
  const model = $('#stModel').value;
  const box = $('#stLocalTestResult');
  box.classList.remove('hidden');
  box.innerHTML = '⏳ Đang kết nối Ollama...';
  const r = await api('/api/settings/local/test', { method: 'POST', body: { localUrl, model } });
  if (!r.ok) {
    box.innerHTML = `❌ <span style="color:var(--destructive)">${escapeHtml(r.error)}</span>`;
    return;
  }
  box.innerHTML = `✓ Đã kết nối <code>${escapeHtml(r.url)}</code> · model <code>${escapeHtml(r.model)}</code> sẵn sàng`;
}

function renderChatGptOAuthStatus(status) {
  chatGptOAuthConnected = !!status?.connected;
  const plan = status?.planType ? ` (${status.planType})` : '';
  $('#stChatGptStatus').textContent = chatGptOAuthConnected ? `✓ Đã kết nối${plan}` : '(chưa đăng nhập)';
  $('#stChatGptLogoutBtn').classList.toggle('hidden', !chatGptOAuthConnected);
}

async function startChatGptOAuthLogin() {
  const btn = $('#stChatGptLoginBtn');
  btn.disabled = true;
  $('#stChatGptStatus').textContent = 'Đang tạo liên kết đăng nhập...';
  const r = await api('/api/settings/chatgpt-oauth/start', { method: 'POST', body: {} });
  btn.disabled = false;
  if (!r.ok) {
    renderChatGptOAuthStatus({ connected: chatGptOAuthConnected });
    return toast('Lỗi: ' + r.error, 'err');
  }
  chatGptOAuthFlowId = r.data.flowId;
  $('#stChatGptAuthUrl').value = r.data.authUrl;
  $('#stChatGptRedirectUrl').value = '';
  $('#stChatGptLoginFlow').classList.remove('hidden');
  $('#stChatGptStatus').textContent = 'Đang chờ URL callback';
  window.open(r.data.authUrl, '_blank', 'noopener');
}

async function submitChatGptOAuthRedirect() {
  if (!chatGptOAuthFlowId) return toast('Bấm "Đăng nhập ChatGPT" trước', 'err');
  const redirectUrl = $('#stChatGptRedirectUrl').value.trim();
  if (!redirectUrl) return toast('Dán URL callback sau khi đăng nhập', 'err');
  const btn = $('#stChatGptSubmitBtn');
  btn.disabled = true;
  $('#stChatGptStatus').textContent = 'Đang xác thực...';
  const r = await api('/api/settings/chatgpt-oauth/callback', {
    method: 'POST',
    body: { flowId: chatGptOAuthFlowId, redirectUrl },
  });
  btn.disabled = false;
  if (!r.ok) {
    $('#stChatGptStatus').textContent = 'Đăng nhập thất bại';
    return toast('Lỗi: ' + r.error, 'err');
  }
  chatGptOAuthFlowId = null;
  $('#stChatGptLoginFlow').classList.add('hidden');
  toast('Đã kết nối ChatGPT OAuth và chuyển provider', 'ok');
  await initSettingsPage();
}

async function logoutChatGptOAuth() {
  if (!confirm('Ngắt kết nối ChatGPT OAuth? Nếu đang dùng provider này, hệ thống sẽ chuyển lại OpenAI API.')) return;
  const r = await api('/api/settings/chatgpt-oauth/logout', { method: 'POST', body: {} });
  if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
  toast('Đã ngắt kết nối ChatGPT OAuth', 'ok');
  await initSettingsPage();
}

async function saveAiSettings() {
  if ($('#stProvider').value === 'chatgpt-oauth' && !chatGptOAuthConnected) {
    return toast('Hãy đăng nhập ChatGPT OAuth trước khi chọn provider này', 'err');
  }
  const body = {
    provider: $('#stProvider').value,
    model: $('#stModel').value,
    localUrl: $('#stLocalUrl').value.trim() || 'http://127.0.0.1:11434',
  };
  const ak = $('#stAnthropicKey').value.trim();
  const ok = $('#stOpenAiKey').value.trim();
  if (ak) body.anthropicKey = ak;
  if (ok) body.openaiKey = ok;
  const r = await api('/api/settings/ai', { method: 'POST', body });
  if (!r.ok) return toast('Lỗi: ' + r.error, 'err');
  toast('Đã lưu cài đặt', 'ok');
  await initSettingsPage();
}

async function initBackupPage() {
  if (!state.accounts.length || !state.ownId) await loadAccounts();
  bkState.friends = [];
  bkState.selected = new Set();
  renderBkAccList();
  renderBkFriends();
  $('#bkLoadBtn').onclick = loadBkFriends;
  $('#bkExportBtn').onclick = exportBkCsv;
  $('#bkSearch').oninput = renderBkFriends;
  if (window.lucide) window.lucide.createIcons();
}

function renderBkAccList() {
  const box = $('#bkAccList');
  if (!state.accounts.length) { box.innerHTML = '<div class="empty" style="padding:14px">Chưa có tài khoản</div>'; return; }
  box.innerHTML = state.accounts.map(a => {
    const active = a.ownId === state.ownId;
    return `<div class="inv-acc-row ${active ? 'active' : ''}" data-id="${a.ownId}">
      <span class="radio-dot ${active ? 'on' : ''}"></span>
      <div class="avatar sm" ${a.avatar ? `style="background-image:url('${a.avatar}')"` : ''}>${a.avatar ? '' : escapeHtml(avatarText(a.name || 'Acc'))}</div>
      <div class="info">
        <div class="nm">${escapeHtml(a.name || 'Acc')}</div>
        <div class="meta ${a.connected ? 'ok' : 'off'}">${a.connected ? 'Đang hoạt động' : 'Mất kết nối'}</div>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('.inv-acc-row').forEach(row => {
    row.onclick = () => { selectAccount(row.dataset.id); renderBkAccList(); };
  });
}

async function loadBkFriends() {
  if (!state.ownId) return toast('Chưa chọn tài khoản', 'err');
  $('#bkFriendList').innerHTML = '<div class="empty" style="padding:30px">Đang tải...</div>';
  const r = await api(`/api/chat/all-friends/${state.ownId}`);
  if (!r.ok) { $('#bkFriendList').innerHTML = `<div class="empty" style="padding:30px;color:var(--destructive)">Lỗi: ${escapeHtml(r.error || '')}</div>`; return; }
  bkState.friends = (r.data || []).map(f => ({
    userId: String(f.userId || f.uid || ''),
    displayName: f.displayName || f.zaloName || '',
    zaloName: f.zaloName || '',
    avatar: f.avatar || '',
    phoneNumber: f.phoneNumber || '',
    gender: f.gender || '',
  }));
  bkState.selected = new Set();
  renderBkFriends();
  $('#bkExportBtn').disabled = bkState.friends.length === 0;
  toast(`Đã tải ${bkState.friends.length} bạn`, 'ok');
}

function renderBkFriends() {
  const wrap = $('#bkFriendList');
  const q = ($('#bkSearch')?.value || '').toLowerCase().trim();
  const arr = q ? bkState.friends.filter(f => (f.displayName + ' ' + f.zaloName + ' ' + f.phoneNumber).toLowerCase().includes(q)) : bkState.friends;
  $('#bkTotal').textContent = bkState.friends.length;
  $('#bkSelCount').textContent = bkState.selected.size;
  if (!bkState.friends.length) { wrap.innerHTML = '<div class="empty" style="padding:30px">Chọn tài khoản và bấm "Tải bạn bè".</div>'; return; }
  if (!arr.length) { wrap.innerHTML = '<div class="empty" style="padding:30px">Không khớp tìm kiếm</div>'; return; }
  const accName = (state.accounts.find(a => a.ownId === state.ownId)?.name) || '';
  const headerChecked = arr.every(f => bkState.selected.has(f.userId)) ? 'checked' : '';
  wrap.innerHTML = `<table class="camp-table bk-table">
    <thead>
      <tr>
        <th style="width:40px"><input type="checkbox" id="bkSelectAll" ${headerChecked} style="margin:0;width:auto" /></th>
        <th style="width:50px">#</th>
        <th style="width:60px">Hình ảnh</th>
        <th>Tên</th>
        <th>Nhãn</th>
        <th>SĐT</th>
        <th>Bạn của</th>
      </tr>
    </thead>
    <tbody>
      ${arr.slice(0, 500).map((f, i) => {
        const checked = bkState.selected.has(f.userId) ? 'checked' : '';
        const avatar = f.avatar ? `<div class="avatar sm" style="background-image:url('${f.avatar}')"></div>` : `<div class="avatar sm">${escapeHtml(avatarText(f.displayName || f.userId))}</div>`;
        return `<tr>
          <td><input type="checkbox" data-uid="${f.userId}" ${checked} style="margin:0;width:auto" /></td>
          <td>${i + 1}</td>
          <td>${avatar}</td>
          <td>${escapeHtml(f.displayName || '(không tên)')}</td>
          <td>${escapeHtml(f.zaloName || '—')}</td>
          <td>${escapeHtml(f.phoneNumber || '—')}</td>
          <td>${escapeHtml(accName)}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>${arr.length > 500 ? `<div class="status-line" style="padding:8px;text-align:center">Hiển thị 500 / ${arr.length} — gõ tìm để lọc</div>` : ''}`;
  $('#bkSelectAll').onchange = (e) => {
    if (e.target.checked) arr.forEach(f => bkState.selected.add(f.userId));
    else arr.forEach(f => bkState.selected.delete(f.userId));
    renderBkFriends();
  };
  wrap.querySelectorAll('tbody input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) bkState.selected.add(cb.dataset.uid);
      else bkState.selected.delete(cb.dataset.uid);
      $('#bkSelCount').textContent = bkState.selected.size;
    };
  });
}

function exportBkCsv() {
  if (!bkState.friends.length) return toast('Chưa có dữ liệu', 'err');
  const accName = (state.accounts.find(a => a.ownId === state.ownId)?.name) || '';
  const subset = bkState.selected.size ? bkState.friends.filter(f => bkState.selected.has(f.userId)) : bkState.friends;
  const rows = [['userId', 'displayName', 'zaloName', 'phoneNumber', 'gender', 'avatar', 'banCua']];
  for (const f of subset) {
    rows.push([f.userId, f.displayName, f.zaloName, f.phoneNumber, f.gender, f.avatar, accName]);
  }
  const csv = rows.map(r => r.map(v => '"' + String(v || '').replace(/"/g, '""') + '"').join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `friends-${state.ownId}-${Date.now()}.csv`;
  a.click();
  toast(`Đã xuất ${subset.length} bạn`, 'ok');
}

function handleNavAction(action, el) {
  if (el && el.classList.contains('nav-item')) {
    document.querySelectorAll('.nav-item.active').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
  }
  if (PAGE_VIEW_ACTIONS[action]) return;
  const directOpen = [];
  if (directOpen.includes(action)) return openActionModal(action);

  const ACTIONS = {
    'acc-list': () => {},
    'acc-labels': () => toast('Quản lý nhãn tài khoản: dùng tag trong DB (chưa có UI)', 'info'),
    'chat-overview': () => {},
    'chat-labels': () => toast('Dùng nút 🏷️ trong khung chat để gắn nhãn hội thoại', 'info'),
    'schedule': () => openModal('modalSchedule'),
  };
  if (ACTIONS[action]) ACTIONS[action]();
}
