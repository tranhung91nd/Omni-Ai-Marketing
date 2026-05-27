const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const pkg = require(path.join(rootDir, 'package.json'));
const desktopConfig = require(path.join(rootDir, 'desktop', 'config.js'));

const errors = [];
const warnings = [];

function rel(file) {
  return path.relative(rootDir, file).replace(/\\/g, '/');
}

function cleanUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function looksPlaceholder(value) {
  return !value || /your-domain|tenmiencuaban|example\.com/i.test(value);
}

const zaloAgentExe = path.join(rootDir, 'bin', 'zalo-agent.exe');
if (!fs.existsSync(zaloAgentExe)) {
  warnings.push(`Optional ${rel(zaloAgentExe)} not found. The desktop app will use the bundled Node source; legacy CLI endpoints will be disabled.`);
}

const licenseServerUrl = process.env.LICENSE_SERVER_URL || desktopConfig.licenseServerUrl;
const updateCheckUrl = process.env.UPDATE_CHECK_URL || desktopConfig.updateCheckUrl;
const updateFeedUrl = process.env.UPDATE_FEED_URL || desktopConfig.updateFeedUrl;
const publishUrl = pkg.build?.publish?.[0]?.url || '';

if (looksPlaceholder(licenseServerUrl)) {
  errors.push('LICENSE_SERVER_URL/desktop.config licenseServerUrl is not ready.');
}

if (looksPlaceholder(updateCheckUrl)) {
  errors.push('UPDATE_CHECK_URL/desktop.config updateCheckUrl is not ready.');
}

if (looksPlaceholder(updateFeedUrl)) {
  errors.push('UPDATE_FEED_URL/desktop.config updateFeedUrl is not ready.');
}

if (looksPlaceholder(publishUrl)) {
  errors.push('electron-builder publish.url is not ready.');
}

if (cleanUrl(updateFeedUrl) !== cleanUrl(publishUrl)) {
  warnings.push(`updateFeedUrl (${updateFeedUrl}) differs from build.publish.url (${publishUrl}).`);
}

if (process.platform !== 'win32') {
  warnings.push('For a customer-ready installer, build on Windows or a Windows CI runner.');
}

for (const warning of warnings) {
  console.warn(`[preflight:warn] ${warning}`);
}

if (errors.length) {
  for (const error of errors) {
    console.error(`[preflight:error] ${error}`);
  }
  process.exit(1);
}

console.log('[preflight] Windows packaging config looks ready.');
