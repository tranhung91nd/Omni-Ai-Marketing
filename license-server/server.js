const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.LICENSE_SERVER_PORT || process.env.PORT || 5050);
const DB_FILE = process.env.LICENSE_SERVER_DB || path.join(__dirname, 'licenses.json');
const SECRET = process.env.LICENSE_SERVER_SECRET || 'change-me';
const BASE_PATH = String(process.env.LICENSE_SERVER_BASE_PATH || '').replace(/\/+$/, '');

if (SECRET === 'change-me') {
  console.warn('[license-server] Set LICENSE_SERVER_SECRET before production.');
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

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
  const latest = process.env.UPDATE_LATEST_VERSION || current;
  const downloadUrl = process.env.UPDATE_DOWNLOAD_URL || '';
  const notes = process.env.UPDATE_NOTES || '';
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
