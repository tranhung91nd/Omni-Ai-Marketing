const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.LICENSE_SERVER_DB || path.join(__dirname, 'licenses.json');

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
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
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function makeKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `HC-${part()}-${part()}-${part()}`;
}

const days = Number(arg('days', '365'));
const expiresAt = days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;
const key = makeKey();
const db = loadDb();

db.licenses[key] = {
  appId: arg('appId', 'hc-zalo-agent'),
  customer: arg('customer', 'Khach hang'),
  plan: arg('plan', 'standard'),
  maxMachines: Number(arg('seats', '1')),
  expiresAt,
  disabled: false,
  createdAt: new Date().toISOString(),
  activations: {},
};

saveDb(db);
console.log(key);
