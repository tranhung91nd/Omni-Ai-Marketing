const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pkg = require('../package.json');
const config = require('./config');

const APP_ID = process.env.LICENSE_APP_ID || config.appId || 'hc-zalo-agent';
const APP_VERSION = process.env.LICENSE_APP_VERSION || pkg.version || '0.0.0';
const DATA_DIR = process.env.ZALO_DATA_DIR || path.join(__dirname, '..');
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');
const SERVER_URL = (process.env.LICENSE_SERVER_URL || config.licenseServerUrl || '').replace(/\/+$/, '');
const CHECK_INTERVAL_MS = Number(process.env.LICENSE_CHECK_INTERVAL_MS || 12 * 60 * 60 * 1000);
const GRACE_MS = Number(process.env.LICENSE_GRACE_DAYS || 3) * 24 * 60 * 60 * 1000;

let activeCache = process.env.LICENSE_ENFORCE !== '1';
let onActivated = null;

function isEnforced() {
  return process.env.LICENSE_ENFORCE === '1';
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getMachineId() {
  const raw = [
    os.hostname(),
    os.platform(),
    os.arch(),
    process.env.COMPUTERNAME || '',
    process.env.USERDOMAIN || '',
    os.cpus()?.[0]?.model || '',
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function readLocalLicense() {
  try {
    return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeLocalLicense(data) {
  ensureDataDir();
  fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2));
}

function removeLocalLicense() {
  try { fs.unlinkSync(LICENSE_FILE); } catch {}
}

function publicLicense(data) {
  if (!data) return null;
  return {
    licenseKey: data.licenseKey,
    customer: data.customer || '',
    plan: data.plan || '',
    expiresAt: data.expiresAt || null,
    maxMachines: data.maxMachines || 1,
    machineId: data.machineId || getMachineId(),
    lastValidatedAt: data.lastValidatedAt || null,
  };
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now();
}

function inactive(reason, extra = {}) {
  activeCache = false;
  return {
    ok: true,
    enforced: true,
    active: false,
    reason,
    machineId: getMachineId(),
    ...extra,
  };
}

function active(data, extra = {}) {
  activeCache = true;
  return {
    ok: true,
    enforced: true,
    active: true,
    machineId: getMachineId(),
    license: publicLicense(data),
    ...extra,
  };
}

async function postJson(endpoint, body) {
  if (!SERVER_URL) throw new Error('Chưa cấu hình LICENSE_SERVER_URL');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${SERVER_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(json.error || `License server HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeActivation(payload, licenseKey) {
  const data = payload.data || payload.license || payload;
  return {
    licenseKey,
    activationToken: data.activationToken,
    activationId: data.activationId || '',
    customer: data.customer || '',
    plan: data.plan || '',
    expiresAt: data.expiresAt || null,
    maxMachines: data.maxMachines || data.seats || 1,
    machineId: getMachineId(),
    lastValidatedAt: new Date().toISOString(),
  };
}

async function getStatus(options = {}) {
  if (!isEnforced()) {
    activeCache = true;
    return { ok: true, enforced: false, active: true, machineId: getMachineId() };
  }

  const local = readLocalLicense();
  if (!local?.licenseKey || !local?.activationToken) {
    return inactive('not_activated');
  }
  if (local.machineId && local.machineId !== getMachineId()) {
    return inactive('machine_mismatch', { license: publicLicense(local) });
  }
  if (isExpired(local.expiresAt)) {
    return inactive('expired', { license: publicLicense(local) });
  }

  const lastCheck = local.lastValidatedAt ? new Date(local.lastValidatedAt).getTime() : 0;
  const shouldRefresh = options.refresh || !lastCheck || Date.now() - lastCheck > CHECK_INTERVAL_MS;
  if (!shouldRefresh) return active(local);

  try {
    const payload = await postJson('/api/licenses/validate', {
      appId: APP_ID,
      version: APP_VERSION,
      licenseKey: local.licenseKey,
      activationToken: local.activationToken,
      machineId: getMachineId(),
      machineName: os.hostname(),
      platform: os.platform(),
    });
    const next = normalizeActivation(payload, local.licenseKey);
    writeLocalLicense(next);
    return active(next);
  } catch (e) {
    const withinGrace = lastCheck && Date.now() - lastCheck <= GRACE_MS;
    if (withinGrace) return active(local, { offline: true, warning: e.message });
    return inactive('validation_failed', { error: e.message, license: publicLicense(local) });
  }
}

async function activateLicense(licenseKey) {
  const key = String(licenseKey || '').trim().toUpperCase();
  if (!key) throw new Error('Thiếu mã license');
  const payload = await postJson('/api/licenses/activate', {
    appId: APP_ID,
    version: APP_VERSION,
    licenseKey: key,
    machineId: getMachineId(),
    machineName: os.hostname(),
    platform: os.platform(),
  });
  const data = normalizeActivation(payload, key);
  if (!data.activationToken) throw new Error('License server không trả activationToken');
  writeLocalLicense(data);
  activeCache = true;
  if (onActivated) onActivated(data);
  return active(data);
}

async function deactivateLicense() {
  const local = readLocalLicense();
  if (local?.activationToken) {
    try {
      await postJson('/api/licenses/deactivate', {
        appId: APP_ID,
        licenseKey: local.licenseKey,
        activationToken: local.activationToken,
        machineId: getMachineId(),
      });
    } catch {}
  }
  removeLocalLicense();
  activeCache = !isEnforced();
  return { ok: true };
}

function registerRoutes(app) {
  app.get('/api/license/status', async (_req, res) => {
    try { res.json(await getStatus({ refresh: false })); }
    catch (e) { res.json(inactive('status_error', { error: e.message })); }
  });
  app.post('/api/license/activate', async (req, res) => {
    try { res.json(await activateLicense(req.body?.licenseKey)); }
    catch (e) { res.json({ ok: false, error: e.message, machineId: getMachineId() }); }
  });
  app.post('/api/license/deactivate', async (_req, res) => {
    try { res.json(await deactivateLicense()); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
}

function middleware(req, res, next) {
  if (!isEnforced()) return next();
  if (!req.path.startsWith('/api')) return next();
  if (
    req.path === '/api/health' ||
    req.path.startsWith('/api/license/') ||
    req.path.startsWith('/api/desktop/update')
  ) return next();

  getStatus({ refresh: false })
    .then((status) => {
      if (status.active) return next();
      return res.json({
        ok: false,
        code: 'LICENSE_REQUIRED',
        licenseRequired: true,
        error: 'Phần mềm chưa kích hoạt license hoặc license đã hết hạn.',
        license: status,
      });
    })
    .catch((e) => res.json({
      ok: false,
      code: 'LICENSE_REQUIRED',
      licenseRequired: true,
      error: e.message,
    }));
}

function isActiveCached() {
  return activeCache;
}

function setOnActivated(fn) {
  onActivated = fn;
}

module.exports = {
  getStatus,
  isActiveCached,
  isEnforced,
  middleware,
  registerRoutes,
  setOnActivated,
};
