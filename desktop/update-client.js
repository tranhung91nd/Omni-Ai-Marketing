const os = require('os');

const pkg = require('../package.json');
const config = require('./config');

const APP_ID = process.env.LICENSE_APP_ID || config.appId || 'hc-zalo-agent';
const APP_VERSION = process.env.LICENSE_APP_VERSION || pkg.version || '0.0.0';
const UPDATE_CHECK_URL = (process.env.UPDATE_CHECK_URL || config.updateCheckUrl || '').trim();

async function checkUpdate(_req, res) {
  if (!UPDATE_CHECK_URL) {
    return res.json({
      ok: true,
      enabled: false,
      currentVersion: APP_VERSION,
      message: 'Chưa cấu hình UPDATE_CHECK_URL',
    });
  }

  const url = new URL(UPDATE_CHECK_URL);
  url.searchParams.set('appId', APP_ID);
  url.searchParams.set('version', APP_VERSION);
  url.searchParams.set('platform', os.platform());
  url.searchParams.set('arch', os.arch());

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const upstream = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    const json = await upstream.json().catch(() => ({}));
    if (!upstream.ok || json.ok === false) {
      return res.json({
        ok: false,
        currentVersion: APP_VERSION,
        error: json.error || `Update server HTTP ${upstream.status}`,
      });
    }
    return res.json({
      ok: true,
      enabled: true,
      currentVersion: APP_VERSION,
      ...json,
    });
  } catch (e) {
    return res.json({ ok: false, currentVersion: APP_VERSION, error: e.message });
  } finally {
    clearTimeout(timer);
  }
}

function registerRoutes(app) {
  app.get('/api/desktop/update', checkUpdate);
}

module.exports = { registerRoutes };
