const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.LICENSE_SERVER_PORT || process.env.PORT || 5050);
const DB_FILE = process.env.LICENSE_SERVER_DB || path.join(__dirname, 'licenses.json');
const SECRET = process.env.LICENSE_SERVER_SECRET || 'change-me';
const BASE_PATH = String(process.env.LICENSE_SERVER_BASE_PATH || '').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.LICENSE_ADMIN_TOKEN || '';
const DEFAULT_DAYS = Number(process.env.LICENSE_DEFAULT_DAYS || 365);
const DEFAULT_APP_ID = process.env.LICENSE_DEFAULT_APP_ID || 'hc-zalo-agent';

if (SECRET === 'change-me') {
  console.warn('[license-server] Set LICENSE_SERVER_SECRET before production.');
}
if (!ADMIN_TOKEN) {
  console.warn('[license-server] Set LICENSE_ADMIN_TOKEN to enable the admin UI.');
}

app.use(express.json({ limit: '1mb' }));

if (BASE_PATH) {
  app.use((req, _res, next) => {
    if (req.url === BASE_PATH) {
      req.url = '/';
    } else if (req.url.startsWith(`${BASE_PATH}/`)) {
      req.url = req.url.slice(BASE_PATH.length);
    }
    next();
  });
}

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { licenses: {} };
  }
}

function saveDb(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function nowIso() {
  return new Date().toISOString();
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now();
}

function getLicense(db, licenseKey, appId) {
  const key = String(licenseKey || '').trim().toUpperCase();
  const lic = db.licenses[key];
  if (!lic) throw new Error('License không tồn tại');
  if (lic.disabled) throw new Error('License đã bị khóa');
  if (lic.appId && appId && lic.appId !== appId) throw new Error('License không đúng ứng dụng');
  if (isExpired(lic.expiresAt)) throw new Error('License đã hết hạn');
  lic.activations ||= {};
  return { key, lic };
}

function publicPayload(key, lic, activationToken) {
  return {
    ok: true,
    licenseKey: key,
    activationToken,
    customer: lic.customer || '',
    plan: lic.plan || '',
    expiresAt: lic.expiresAt || null,
    maxMachines: lic.maxMachines || 1,
  };
}

function makeToken(licenseKey, machineId) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${licenseKey}|${machineId}|${Date.now()}|${crypto.randomBytes(8).toString('hex')}`)
    .digest('hex');
}

function makeKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `HC-${part()}-${part()}-${part()}`;
}

function makeUniqueKey(db) {
  let key = makeKey();
  while (db.licenses[key]) key = makeKey();
  return key;
}

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function resolveExpiresAt(input = {}) {
  if (input.noExpiry || input.durationUnit === 'lifetime') return null;

  if (input.expiresAt) {
    const raw = String(input.expiresAt).trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? new Date(`${raw}T23:59:59.999+07:00`)
      : new Date(raw);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
      throw new Error('Ngày hết hạn không hợp lệ');
    }
    return date.toISOString();
  }

  const amount = toInt(input.durationValue, DEFAULT_DAYS || 365, 1, 3650);
  const unit = input.durationUnit || 'days';
  const date = new Date();
  if (unit === 'months') {
    date.setMonth(date.getMonth() + amount);
  } else if (unit === 'years') {
    date.setFullYear(date.getFullYear() + amount);
  } else {
    date.setDate(date.getDate() + amount);
  }
  return date.toISOString();
}

function sanitizeLicense(key, lic) {
  const activations = Object.values(lic.activations || {});
  return {
    licenseKey: key,
    appId: lic.appId || '',
    customer: lic.customer || '',
    plan: lic.plan || '',
    maxMachines: Number(lic.maxMachines || 1),
    expiresAt: lic.expiresAt || null,
    disabled: Boolean(lic.disabled),
    createdAt: lic.createdAt || null,
    activeMachines: activations.filter(a => !a.revokedAt).length,
  };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function adminTokenFromReq(req) {
  const auth = req.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.get('x-admin-token') || '';
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, error: 'Chưa cấu hình LICENSE_ADMIN_TOKEN trên server' });
  }
  if (!safeEqual(adminTokenFromReq(req), ADMIN_TOKEN)) {
    return res.status(401).json({ ok: false, error: 'Token admin không đúng' });
  }
  next();
}

function adminPageHtml() {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tạo License | HC Zalo Agent</title>
  <style>
    :root { color-scheme: light; --bg:#f7f5f2; --card:#fff; --line:#ded7cf; --text:#1d1712; --muted:#746b62; --accent:#e84a1c; --soft:#fff0ea; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    main { width:min(1120px, calc(100% - 32px)); margin:32px auto 48px; }
    header { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:18px; }
    h1 { margin:0 0 6px; font-size:30px; letter-spacing:0; }
    p { margin:0; color:var(--muted); }
    .grid { display:grid; grid-template-columns: 1.05fr .95fr; gap:16px; align-items:start; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:22px; box-shadow:0 18px 42px rgba(45, 33, 24, .08); }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    label { display:block; font-weight:700; color:var(--muted); margin:0 0 7px; font-size:14px; }
    input, select { width:100%; height:46px; border:1px solid var(--line); border-radius:8px; padding:0 13px; font-size:16px; color:var(--text); background:#fff; }
    input:focus, select:focus { outline:2px solid rgba(232, 74, 28, .22); border-color:var(--accent); }
    .field { margin-bottom:14px; }
    .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:16px; }
    button { height:44px; border-radius:8px; border:1px solid var(--line); background:#fff; color:var(--text); padding:0 16px; font-size:15px; font-weight:700; cursor:pointer; }
    button.primary { background:var(--accent); border-color:var(--accent); color:white; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .quick { display:flex; flex-wrap:wrap; gap:8px; }
    .quick button { height:36px; padding:0 11px; font-size:14px; }
    .token { display:flex; gap:8px; min-width:420px; }
    .token input { height:42px; font-size:14px; }
    .status { min-height:22px; margin-top:10px; font-weight:700; color:var(--muted); }
    .status.err { color:#b42318; }
    .status.ok { color:#16703a; }
    .result { background:var(--soft); border:1px solid #ffd3c3; border-radius:8px; padding:16px; margin-top:16px; display:none; }
    .result strong { display:block; font-size:24px; margin-top:8px; word-break:break-all; }
    table { width:100%; border-collapse:collapse; }
    th, td { border-bottom:1px solid var(--line); padding:11px 8px; text-align:left; vertical-align:top; font-size:14px; }
    th { color:var(--muted); font-size:13px; }
    .key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight:800; }
    .muted { color:var(--muted); }
    @media (max-width: 860px) { header, .grid, .row { grid-template-columns:1fr; display:grid; } .token { min-width:0; width:100%; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Tạo License</h1>
        <p>Tạo mã kích hoạt cho HC Zalo Agent theo khách hàng, số máy và thời hạn.</p>
      </div>
      <div class="token">
        <input id="adminToken" type="password" placeholder="Admin token">
        <button id="saveTokenBtn">Lưu token</button>
      </div>
    </header>

    <div class="grid">
      <section class="card">
        <form id="licenseForm">
          <div class="field">
            <label for="customer">Khách hàng</label>
            <input id="customer" required placeholder="VD: Công ty ABC">
          </div>
          <div class="row">
            <div class="field">
              <label for="plan">Gói</label>
              <input id="plan" value="standard" placeholder="trial, standard, agency">
            </div>
            <div class="field">
              <label for="maxMachines">Số máy</label>
              <input id="maxMachines" type="number" min="1" max="1000" value="1">
            </div>
          </div>
          <div class="field">
            <label for="appId">Ứng dụng</label>
            <input id="appId" value="hc-zalo-agent">
          </div>
          <div class="row">
            <div class="field">
              <label for="durationValue">Thời hạn</label>
              <input id="durationValue" type="number" min="1" max="3650" value="365">
            </div>
            <div class="field">
              <label for="durationUnit">Đơn vị</label>
              <select id="durationUnit">
                <option value="days">Ngày</option>
                <option value="months">Tháng</option>
                <option value="years">Năm</option>
                <option value="lifetime">Vĩnh viễn</option>
              </select>
            </div>
          </div>
          <div class="quick">
            <button type="button" data-days="7">7 ngày</button>
            <button type="button" data-days="30">30 ngày</button>
            <button type="button" data-days="90">90 ngày</button>
            <button type="button" data-days="365">1 năm</button>
          </div>
          <div class="actions">
            <button class="primary" id="createBtn" type="submit">Tạo license</button>
            <button id="resetBtn" type="reset">Làm mới</button>
          </div>
          <div id="status" class="status"></div>
        </form>
        <div id="result" class="result">
          <span class="muted">License vừa tạo</span>
          <strong id="resultKey"></strong>
          <p id="resultMeta"></p>
          <div class="actions">
            <button id="copyBtn">Copy mã</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="actions" style="justify-content:space-between;margin-top:0">
          <h2 style="margin:0;font-size:21px">License gần đây</h2>
          <button id="reloadBtn">Tải lại</button>
        </div>
        <div style="overflow:auto;margin-top:12px">
          <table>
            <thead><tr><th>Mã</th><th>Khách</th><th>Hết hạn</th><th>Máy</th></tr></thead>
            <tbody id="licenseRows"><tr><td colspan="4" class="muted">Nhập token admin để xem danh sách.</td></tr></tbody>
          </table>
        </div>
      </section>
    </div>
  </main>

  <script>
    const API_BASE = ${JSON.stringify(BASE_PATH || '')};
    const $ = (s) => document.querySelector(s);
    const tokenInput = $('#adminToken');
    const statusEl = $('#status');
    const result = $('#result');
    const rows = $('#licenseRows');
    let lastKey = '';

    tokenInput.value = localStorage.getItem('licenseAdminToken') || '';

    function setStatus(text, type = '') {
      statusEl.textContent = text || '';
      statusEl.className = 'status ' + type;
    }

    async function api(path, options = {}) {
      const headers = {
        'Content-Type': 'application/json',
        'X-Admin-Token': tokenInput.value.trim(),
        ...(options.headers || {}),
      };
      const res = await fetch(API_BASE + path, { ...options, headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || 'Không gọi được API');
      return data;
    }

    function formatDate(value) {
      if (!value) return 'Vĩnh viễn';
      return new Date(value).toLocaleDateString('vi-VN');
    }

    async function loadConfig() {
      const data = await api('/api/admin/config');
      $('#appId').value = data.defaultAppId || 'hc-zalo-agent';
      $('#durationValue').value = data.defaultDays || 365;
      $('#durationUnit').value = 'days';
    }

    async function loadLicenses() {
      try {
        const data = await api('/api/admin/licenses');
        rows.innerHTML = data.licenses.map(lic => '<tr>' +
          '<td class="key">' + lic.licenseKey + '<div class="muted">' + (lic.plan || '') + '</div></td>' +
          '<td>' + (lic.customer || '') + '</td>' +
          '<td>' + formatDate(lic.expiresAt) + '</td>' +
          '<td>' + lic.activeMachines + '/' + lic.maxMachines + '</td>' +
        '</tr>').join('') || '<tr><td colspan="4" class="muted">Chưa có license.</td></tr>';
      } catch (e) {
        rows.innerHTML = '<tr><td colspan="4" class="muted">' + e.message + '</td></tr>';
      }
    }

    document.querySelectorAll('[data-days]').forEach(btn => {
      btn.addEventListener('click', () => {
        $('#durationValue').value = btn.dataset.days;
        $('#durationUnit').value = 'days';
      });
    });

    $('#saveTokenBtn').addEventListener('click', async () => {
      localStorage.setItem('licenseAdminToken', tokenInput.value.trim());
      setStatus('Đã lưu token trên trình duyệt này.', 'ok');
      try { await loadConfig(); } catch {}
      loadLicenses();
    });

    $('#licenseForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      setStatus('Đang tạo license...');
      $('#createBtn').disabled = true;
      try {
        const body = {
          customer: $('#customer').value.trim(),
          plan: $('#plan').value.trim(),
          maxMachines: $('#maxMachines').value,
          appId: $('#appId').value.trim(),
          durationValue: $('#durationValue').value,
          durationUnit: $('#durationUnit').value,
        };
        const data = await api('/api/admin/licenses', { method: 'POST', body: JSON.stringify(body) });
        lastKey = data.licenseKey;
        $('#resultKey').textContent = data.licenseKey;
        $('#resultMeta').textContent = 'Khách hàng: ' + data.license.customer + ' | Hết hạn: ' + formatDate(data.license.expiresAt);
        result.style.display = 'block';
        setStatus('Tạo license thành công.', 'ok');
        loadLicenses();
      } catch (e) {
        setStatus(e.message, 'err');
      } finally {
        $('#createBtn').disabled = false;
      }
    });

    $('#copyBtn').addEventListener('click', async () => {
      if (!lastKey) return;
      await navigator.clipboard.writeText(lastKey);
      setStatus('Đã copy mã license.', 'ok');
    });

    $('#reloadBtn').addEventListener('click', loadLicenses);
    if (tokenInput.value.trim()) {
      loadConfig().catch(() => {});
      loadLicenses();
    }
  </script>
</body>
</html>`;
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/', (_req, res) => {
  res.redirect(`${BASE_PATH || ''}/admin`);
});

app.get('/admin', (_req, res) => {
  res.type('html').send(adminPageHtml());
});

app.get('/api/admin/config', requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    defaultDays: DEFAULT_DAYS || 365,
    defaultAppId: DEFAULT_APP_ID,
  });
});

app.get('/api/admin/licenses', requireAdmin, (_req, res) => {
  const db = loadDb();
  const licenses = Object.entries(db.licenses || {})
    .map(([key, lic]) => sanitizeLicense(key, lic))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 100);
  res.json({ ok: true, licenses });
});

app.post('/api/admin/licenses', requireAdmin, (req, res) => {
  try {
    const customer = String(req.body?.customer || '').trim();
    if (!customer) throw new Error('Nhập tên khách hàng');
    const db = loadDb();
    const key = makeUniqueKey(db);
    db.licenses[key] = {
      appId: String(req.body?.appId || DEFAULT_APP_ID).trim() || DEFAULT_APP_ID,
      customer,
      plan: String(req.body?.plan || 'standard').trim() || 'standard',
      maxMachines: toInt(req.body?.maxMachines ?? req.body?.seats, 1, 1, 1000),
      expiresAt: resolveExpiresAt(req.body),
      disabled: false,
      createdAt: nowIso(),
      activations: {},
    };
    saveDb(db);
    res.json({ ok: true, licenseKey: key, license: sanitizeLicense(key, db.licenses[key]) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/licenses/activate', (req, res) => {
  try {
    const { appId, licenseKey, machineId, machineName, platform, version } = req.body || {};
    if (!licenseKey || !machineId) throw new Error('Thiếu licenseKey hoặc machineId');
    const db = loadDb();
    const { key, lic } = getLicense(db, licenseKey, appId);
    const existing = lic.activations[machineId];
    const activeMachines = Object.values(lic.activations).filter(a => !a.revokedAt).length;
    if (!existing && activeMachines >= Number(lic.maxMachines || 1)) {
      throw new Error('License đã dùng hết số máy cho phép');
    }
    const activationToken = existing?.activationToken || makeToken(key, machineId);
    lic.activations[machineId] = {
      activationToken,
      machineId,
      machineName: machineName || '',
      platform: platform || '',
      version: version || '',
      activatedAt: existing?.activatedAt || nowIso(),
      lastSeenAt: nowIso(),
      revokedAt: null,
    };
    saveDb(db);
    res.json(publicPayload(key, lic, activationToken));
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/licenses/validate', (req, res) => {
  try {
    const { appId, licenseKey, activationToken, machineId, platform, version } = req.body || {};
    if (!licenseKey || !activationToken || !machineId) throw new Error('Thiếu thông tin kích hoạt');
    const db = loadDb();
    const { key, lic } = getLicense(db, licenseKey, appId);
    const activation = lic.activations?.[machineId];
    if (!activation || activation.revokedAt) throw new Error('Máy này chưa được kích hoạt');
    if (activation.activationToken !== activationToken) throw new Error('Token kích hoạt không hợp lệ');
    activation.platform = platform || activation.platform || '';
    activation.version = version || activation.version || '';
    activation.lastSeenAt = nowIso();
    saveDb(db);
    res.json(publicPayload(key, lic, activationToken));
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/licenses/deactivate', (req, res) => {
  try {
    const { appId, licenseKey, activationToken, machineId } = req.body || {};
    const db = loadDb();
    const { lic } = getLicense(db, licenseKey, appId);
    const activation = lic.activations?.[machineId];
    if (activation && activation.activationToken === activationToken) {
      activation.revokedAt = nowIso();
      saveDb(db);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/updates/check', (req, res) => {
  const current = req.query.version || '0.0.0';
  const platform = String(req.query.platform || '').toLowerCase();
  const isMac = ['darwin', 'mac', 'macos'].includes(platform);
  const isWin = ['win32', 'win', 'windows'].includes(platform);
  const versionEnv = isMac ? 'UPDATE_LATEST_VERSION_MAC' : isWin ? 'UPDATE_LATEST_VERSION_WIN' : 'UPDATE_LATEST_VERSION';
  const urlEnv = isMac ? 'UPDATE_DOWNLOAD_URL_MAC' : isWin ? 'UPDATE_DOWNLOAD_URL_WIN' : 'UPDATE_DOWNLOAD_URL';
  const notesEnv = isMac ? 'UPDATE_NOTES_MAC' : isWin ? 'UPDATE_NOTES_WIN' : 'UPDATE_NOTES';
  const latest = process.env[versionEnv] || process.env.UPDATE_LATEST_VERSION || current;
  const downloadUrl = process.env[urlEnv] || process.env.UPDATE_DOWNLOAD_URL || '';
  const notes = process.env[notesEnv] || process.env.UPDATE_NOTES || '';
  res.json({
    ok: true,
    currentVersion: current,
    latestVersion: latest,
    updateAvailable: latest !== current,
    downloadUrl,
    notes,
  });
});

app.listen(PORT, () => {
  console.log(`License server listening on http://localhost:${PORT}${BASE_PATH || ''}`);
});
