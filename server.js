const express = require('express');
const { spawn, execFile } = require('child_process');
const multer = require('multer');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { db, stmts } = require('./db');
const ZM = require('./zalo-manager');
const license = require('./desktop/license');
const desktopUpdate = require('./desktop/update-client');

const app = express();
const PORT = Number(process.env.PORT || 3333);
const QR_PORT = Number(process.env.QR_PORT || 18927);
const HOST = process.env.HOST || '';
const ZALO_AGENT_BIN = process.env.ZALO_AGENT_BIN || 'zalo-agent';
const ROOT_REDIRECT = process.env.ROOT_REDIRECT || '/chat';
const LICENSE_ADMIN_ROUTE = process.env.LICENSE_ADMIN_ROUTE || '/license-admin';
const LICENSE_ADMIN_TARGET = process.env.LICENSE_ADMIN_TARGET || '/license-api/admin';
const DOWNLOADS_DIR = path.join(__dirname, 'public', 'downloads', 'zalo-agent');

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.get('/', (req, res) => res.redirect(ROOT_REDIRECT));
if (LICENSE_ADMIN_ROUTE) {
  app.get(LICENSE_ADMIN_ROUTE, (req, res) => res.redirect(LICENSE_ADMIN_TARGET));
}
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/api/health', (_req, res) => res.json({ ok: true, version: require('./package.json').version }));
app.get('/api/downloads/latest', (req, res) => {
  try {
    const files = listInstallerFiles(req);
    res.json({
      ok: true,
      latest: files[0] || null,
      platforms: {
        windows: files.find(f => f.platform === 'windows') || null,
        mac: files.find(f => f.platform === 'mac') || null,
      },
      files,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
license.registerRoutes(app);
desktopUpdate.registerRoutes(app);
app.use(license.middleware);

const upload = multer({ storage: multer.memoryStorage() });

const fs = require('fs');
const uploadsDir = process.env.ZALO_UPLOADS_DIR || path.join(process.env.ZALO_DATA_DIR || __dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const fileUpload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname)),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set();
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});
function wsBroadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of wsClients) { try { ws.send(data); } catch {} }
}
ZM.setBroadcaster(wsBroadcast);
ZM.setSendGuard(async () => {
  if (!license.isEnforced()) return true;
  const status = await license.getStatus({ refresh: false });
  return Boolean(status.active);
});

function parseVersionFromInstaller(name) {
  const m = name.match(/HC-Zalo-Agent-(\d+\.\d+\.\d+)/i);
  return m ? m[1] : '0.0.0';
}

function compareVersions(a, b) {
  const aa = String(a || '0.0.0').split('.').map(n => Number(n) || 0);
  const bb = String(b || '0.0.0').split('.').map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const diff = (bb[i] || 0) - (aa[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function installerPlatform(name) {
  if (/Setup\.exe$/i.test(name) || /\.exe$/i.test(name)) return 'windows';
  if (/\.(dmg|pkg|zip)$/i.test(name) || /-Mac-/i.test(name)) return 'mac';
  return 'other';
}

function installerPriority(name) {
  if (/Setup\.exe$/i.test(name)) return 0;
  if (/\.dmg$/i.test(name)) return 1;
  if (/\.pkg$/i.test(name)) return 2;
  if (/\.zip$/i.test(name)) return 3;
  return 9;
}

function absoluteDownloadUrl(req, fileName) {
  const relativeUrl = `/downloads/zalo-agent/${encodeURIComponent(fileName)}`;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  return host ? `${proto}://${host}${relativeUrl}` : relativeUrl;
}

function listInstallerFiles(req) {
  if (!fs.existsSync(DOWNLOADS_DIR)) return [];
  return fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => d.name)
    .filter(name => /^HC-Zalo-Agent-/i.test(name))
    .filter(name => /\.(exe|dmg|pkg|zip)$/i.test(name))
    .map(name => {
      const stat = fs.statSync(path.join(DOWNLOADS_DIR, name));
      const version = parseVersionFromInstaller(name);
      return {
        name,
        version,
        platform: installerPlatform(name),
        url: absoluteDownloadUrl(req, name),
        path: `/downloads/zalo-agent/${encodeURIComponent(name)}`,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => {
      const versionDiff = compareVersions(a.version, b.version);
      if (versionDiff) return versionDiff;
      const priorityDiff = installerPriority(a.name) - installerPriority(b.name);
      if (priorityDiff) return priorityDiff;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
}

// AI caller cho auto-reply per-thread: dùng provider đã chọn với bối cảnh + product KB
ZM.setAiCaller(async ({ ownId, threadId, threadType, triggerContent, triggerFromName, triggerMsgType, triggerRawContent }) => {
  console.log(`[aiCaller] called for thread=${threadId} trigger="${(triggerContent || '').slice(0, 60)}" msgType=${triggerMsgType}`);
  const rows = stmts.listMsgs.all(ownId, String(threadId), 15, 0).reverse();
  const thread = stmts.getThread.get(ownId, String(threadId));
  const isGroupReply = Number(threadType) === ZM.ThreadType.Group;

  // Build history text + collect ảnh lịch sử (chỉ 1 cụm gần nhất để tiết kiệm token)
  const histLines = [];
  let lastHistoryImages = null;
  for (const m of rows) {
    const time = new Date(m.ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    const who = m.isSelf ? 'TÔI' : (m.fromName || 'KHÁCH');
    if (ZM.IMAGE_MSG_TYPES.has(m.type)) {
      const urls = ZM.extractImageUrls(m.content, m.type);
      if (urls.length) {
        histLines.push(`[${time}] ${who}: [đã gửi ${urls.length} ảnh]`);
        lastHistoryImages = { label: `${who} lúc ${time}`, urls: urls.slice(0, 1) };
        continue;
      }
    }
    histLines.push(`[${time}] ${who}: ${(m.content || '').slice(0, 300)}`);
  }

  // Detect ảnh trong tin trigger
  const triggerImages = ZM.IMAGE_MSG_TYPES.has(triggerMsgType)
    ? ZM.extractImageUrls(triggerRawContent, triggerMsgType).slice(0, 3)
    : [];

  // Tải ảnh thành data URL (parallel)
  const downloadOne = async (url) => {
    try { return { ok: true, dataUrl: await ZM.fetchImageAsDataUrl(url) }; }
    catch (e) { console.warn(`[aiCaller] tải ảnh fail ${url}: ${e.message}`); return { ok: false, err: e.message }; }
  };
  const histImgResults = lastHistoryImages
    ? await Promise.all(lastHistoryImages.urls.map(downloadOne))
    : [];
  const triggerImgResults = await Promise.all(triggerImages.map(downloadOne));

  // Build text block
  let textBlock = `=== KÊNH ===\n${isGroupReply ? `NHÓM ZALO: ${thread?.name || threadId}. Chỉ đang phản hồi thành viên ${triggerFromName || 'vừa gọi AI'}.` : 'CHAT CÁ NHÂN ZALO.'}\n\n=== BỐI CẢNH HỘI THOẠI ===\n${histLines.join('\n')}\n\n=== TIN VỪA ĐẾN (cần reply) ===\n${triggerFromName || 'KHÁCH'}: `;
  if (triggerImages.length) {
    textBlock += `[gửi ${triggerImages.length} ảnh — XEM ẢNH CUỐI CÙNG TRONG INPUT]\n\n=== YÊU CẦU ===\nQuan sát ảnh khách vừa gửi, đoán intent (hỏi sản phẩm, gửi screenshot lỗi, ảnh hàng cần check, ảnh chứng từ...) và trả lời ngắn gọn 1-3 câu, không markdown.`;
  } else {
    textBlock += `${triggerContent}\n\n=== YÊU CẦU ===\nViết câu trả lời ngắn cho tin trên.`;
  }

  const sys = buildSysPrompt('reply') + `

═══ NHIỆM VỤ AUTO-REPLY ═══
Bạn đang tự động trả lời 1 tin nhắn Zalo cho team HC.
- Đọc bối cảnh hội thoại bên dưới
- Tạo MỘT câu trả lời ngắn, tự nhiên, đúng tone "bên mình" - "bạn"
- KHÔNG dùng markdown (không **, không heading), chỉ text thuần
- Độ dài: 1-3 câu, dễ đọc trên Zalo
- KHÔNG tự ý báo giá, KHÔNG nhắc hotline
- Nếu khách gửi ảnh: mô tả ngắn cái khách gửi rồi phản hồi phù hợp (ảnh sản phẩm → tư vấn; ảnh lỗi → hỗ trợ; ảnh chuyển khoản → xác nhận thông tin)
- Nếu khách hỏi giá: hỏi thêm context để team báo riêng
- Nếu khách chỉ chào hỏi: chào lại tự nhiên, gợi mở câu chuyện
- Nếu đây là NHÓM ZALO: chỉ trả lời đúng câu hỏi/người vừa @mention; không chen vào trao đổi khác và không giả định cả nhóm là một khách hàng
- Output: CHỈ trả về câu reply, không có lời giải thích gì khác`;

  // Build content array (text + images)
  const userContent = [{ type: 'text', text: textBlock }];
  if (lastHistoryImages && histImgResults.some(r => r.ok)) {
    userContent.push({ type: 'text', text: `--- Ảnh trước đó từ ${lastHistoryImages.label} ---` });
    for (const r of histImgResults) if (r.ok) userContent.push({ type: 'image', dataUrl: r.dataUrl });
  }
  if (triggerImgResults.some(r => r.ok)) {
    userContent.push({ type: 'text', text: `--- ẢNH KHÁCH VỪA GỬI (cần phân tích) ---` });
    for (const r of triggerImgResults) if (r.ok) userContent.push({ type: 'image', dataUrl: r.dataUrl });
  } else if (triggerImages.length) {
    userContent.push({ type: 'text', text: `(không tải được ảnh khách gửi — trả lời chung)` });
  }

  const hasVision = userContent.some(c => c.type === 'image');
  const reply = await aiTextFromConfiguredProvider({ sys, userContent, label: 'aiCaller', needsVision: hasVision });
  console.log(`[aiCaller] OK reply len=${reply.length} vision=${hasVision}`);
  return reply;
});

function runCli(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(ZALO_AGENT_BIN, ['--json', ...args], { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = (stdout || '').trim();
      let data = null;
      try { data = JSON.parse(raw); } catch { data = raw; }
      if (err && err.code === 'ENOENT') {
        data = 'CLI zalo-agent khong co san. Ban desktop dang chay truc tiep bang source Node hien tai.';
      }
      resolve({ ok: !err, data, stderr: (stderr || '').trim(), code: err ? err.code : 0 });
    });
  });
}

let loginProc = null;
app.get('/api/status', async (req, res) => res.json(await runCli(['status'])));
app.get('/api/whoami', async (req, res) => res.json(await runCli(['whoami'])));
app.post('/api/login', (req, res) => {
  if (loginProc && !loginProc.killed) return res.json({ ok: true, qrUrl: `http://localhost:${QR_PORT}`, already: true });
  loginProc = spawn(ZALO_AGENT_BIN, ['login', '--qr-url', '-q', String(QR_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  let responded = false;
  const respondOnce = (payload) => {
    if (responded) return;
    responded = true;
    res.json(payload);
  };
  loginProc.stdout.on('data', d => logs += d.toString());
  loginProc.stderr.on('data', d => logs += d.toString());
  loginProc.on('error', (err) => {
    loginProc = null;
    const data = err.code === 'ENOENT'
      ? 'CLI zalo-agent khong co san. Hay dung man hinh dang nhap Chat hien tai.'
      : err.message;
    respondOnce({ ok: false, data });
  });
  loginProc.on('exit', () => loginProc = null);
  setTimeout(() => respondOnce({ ok: true, qrUrl: `http://localhost:${QR_PORT}`, logs: logs.slice(-500) }), 1500);
});
app.post('/api/logout', async (req, res) => res.json(await runCli(['logout'])));
app.post('/api/filter-phones', async (req, res) => {
  const phones = (req.body.phones || '').split(/[\s,;\n]+/).map(s => s.trim()).filter(Boolean);
  if (!phones.length) return res.json({ ok: false, data: 'Không có số nào' });
  res.json({ ...(await runCli(['friend', 'find-phones', ...phones], 120000)), phones });
});
app.post('/api/filter-csv', upload.single('file'), async (req, res) => {
  if (!req.file) return res.json({ ok: false, data: 'Không có file' });
  const phones = req.file.buffer.toString('utf8').split(/[\s,;\n]+/).map(s => s.replace(/[^0-9+]/g, '')).filter(s => s.length >= 9);
  if (!phones.length) return res.json({ ok: false, data: 'Không tìm thấy SĐT hợp lệ' });
  res.json({ ...(await runCli(['friend', 'find-phones', ...phones], 180000)), phones });
});
app.get('/api/friends', async (req, res) => res.json(await runCli(['friend', 'list'])));
app.post('/api/send', async (req, res) => {
  const { threadId, message } = req.body;
  if (!threadId || !message) return res.json({ ok: false, data: 'Thiếu threadId hoặc message' });
  res.json(await runCli(['msg', 'send', threadId, message]));
});
app.post('/api/friend-find', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ ok: false, data: 'Thiếu query' });
  res.json(await runCli(['friend', 'find', query]));
});

const loginSessions = new Map();
app.post('/api/chat/login-start', async (req, res) => {
  const sid = Math.random().toString(36).slice(2, 12);
  const sess = { sid, qr: null, status: 'pending', ownId: null, error: null, name: req.body?.name || '' };
  loginSessions.set(sid, sess);
  ZM.startQRLogin(req.body?.name || '', req.body?.proxy || null,
    (qrImage, evt) => {
      if (qrImage) sess.qr = qrImage;
      if (evt === 'scanned') sess.status = 'scanned';
    },
    (ownId) => { sess.status = 'success'; sess.ownId = ownId; wsBroadcast({ kind: 'account-connected', ownId }); },
    (err) => { sess.status = 'error'; sess.error = err.message; }
  ).catch(e => { sess.status = 'error'; sess.error = e.message; });
  res.json({ ok: true, sid });
});
app.get('/api/chat/login-poll/:sid', (req, res) => {
  const sess = loginSessions.get(req.params.sid);
  if (!sess) return res.json({ ok: false, error: 'session not found' });
  res.json({ ok: true, ...sess });
});

app.get('/api/chat/accounts', (req, res) => {
  const accs = stmts.listAccounts.all();
  const connected = new Set(ZM.listSessions());
  res.json({ ok: true, data: accs.map(a => ({ ...a, connected: connected.has(a.ownId) })) });
});
app.post('/api/chat/account-connect/:ownId', async (req, res) => {
  try { await ZM.loginFromStored(req.params.ownId); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/chat/account-remove/:ownId', (req, res) => {
  ZM.disconnectAccount(req.params.ownId);
  stmts.removeAccount.run(req.params.ownId);
  res.json({ ok: true });
});
app.post('/api/chat/account-disconnect/:ownId', (req, res) => {
  const ok = ZM.disconnectAccount(req.params.ownId);
  res.json({ ok: true, disconnected: ok });
});
app.post('/api/chat/account-set-proxy/:ownId', (req, res) => {
  const proxy = (req.body?.proxy || '').trim() || null;
  stmts.setAccountProxy.run(proxy, req.params.ownId);
  res.json({ ok: true, proxy });
});

app.get('/api/chat/threads/:ownId', (req, res) => {
  const limit = parseInt(req.query.limit || '100');
  res.json({ ok: true, data: stmts.listThreads.all(req.params.ownId, limit) });
});

app.get('/api/chat/labeled-users/:ownId', (req, res) => {
  const rows = db.prepare("SELECT id, labels FROM threads WHERE ownId=? AND type=0 AND labels IS NOT NULL AND labels != ''").all(req.params.ownId);
  res.json({ ok: true, data: rows });
});

app.post('/api/chat/enrich-unknown-threads/:ownId', async (req, res) => {
  const ownId = req.params.ownId;
  try {
    const rows = db.prepare("SELECT id FROM threads WHERE ownId=? AND type=0 AND (name IS NULL OR name='')").all(ownId);
    if (!rows.length) return res.json({ ok: true, fixed: 0 });
    const s = ZM.getSession(ownId);
    if (!s || typeof s.api.getUserInfo !== 'function') return res.json({ ok: false, error: 'Account chưa kết nối hoặc API không hỗ trợ' });
    let fixed = 0;
    const ids = rows.map(r => r.id);
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      try {
        const resp = await s.api.getUserInfo(batch);
        const profiles = resp?.changed_profiles || {};
        for (const uid of batch) {
          const p = profiles[uid];
          if (!p) continue;
          const name = p.displayName || p.zaloName || p.dName || '';
          const avatar = p.avatar || '';
          if (name) {
            db.prepare("UPDATE threads SET name=?, avatar=? WHERE ownId=? AND id=?").run(name, avatar, ownId, uid);
            fixed++;
          }
        }
      } catch (e) { console.warn('enrich batch err', e.message); }
    }
    res.json({ ok: true, fixed, total: rows.length });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/chat/sync-threads/:ownId', async (req, res) => {
  const ownId = req.params.ownId;
  try {
    const friends = await ZM.getAllFriends(ownId).catch(() => []);
    let countFriends = 0, countGroups = 0;
    for (const f of (friends || [])) {
      const id = String(f.userId || f.uid || '');
      if (!id) continue;
      stmts.upsertThread.run(id, ownId, ZM.ThreadType.User, f.displayName || f.zaloName || '', f.avatar || '', '', 0);
      countFriends++;
    }
    const allGroups = await ZM.getAllGroups(ownId).catch(() => ({}));
    const groupIds = Object.keys(allGroups?.gridVerMap || {});
    if (groupIds.length) {
      const s = ZM.getSession(ownId);
      const batchSize = 20;
      for (let i = 0; i < groupIds.length; i += batchSize) {
        const batch = groupIds.slice(i, i + batchSize);
        try {
          const info = await s.api.getGroupInfo(batch);
          const gmap = info?.gridInfoMap || {};
          for (const gid of Object.keys(gmap)) {
            const g = gmap[gid];
            const name = g.name || g.groupName || g.fullName || ('Nhóm ' + gid.slice(-6));
            const avatar = g.avt || g.fullAvt || g.avatar || '';
            const memberCount = g.totalMember || (g.memVerList?.length) || 0;
            stmts.upsertThread.run(String(gid), ownId, ZM.ThreadType.Group, name, avatar, '', 0);
            try { db.prepare('UPDATE threads SET memberCount=? WHERE id=? AND ownId=?').run(memberCount, String(gid), ownId); } catch {}
            countGroups++;
          }
        } catch (e) { console.warn('getGroupInfo batch err', e.message); }
      }
    }
    res.json({ ok: true, syncedFriends: countFriends, syncedGroups: countGroups });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/chat/sync-history/:ownId/:threadId', async (req, res) => {
  const { ownId, threadId } = req.params;
  const threadType = parseInt(req.query.threadType || req.body?.threadType || 0);
  const count = parseInt(req.query.count || req.body?.count || 50);
  if (threadType !== 1) {
    return res.json({ ok: false, kind: 'user-chat', error: 'Zalo không cho phép fetch lịch sử chat 1-1 qua API. Tool chỉ lưu được tin mới từ lúc đăng nhập trở đi.' });
  }
  try {
    const r = await ZM.loadGroupHistory(ownId, threadId, count);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/chat/messages/:ownId/:threadId', (req, res) => {
  const limit = parseInt(req.query.limit || '50');
  const offset = parseInt(req.query.offset || '0');
  const ownId = req.params.ownId;
  const threadId = String(req.params.threadId);
  const pinnedIds = new Set(stmts.listPinnedMessageIds.all(ownId, threadId).map(r => r.msgId));
  const rows = stmts.listMsgs.all(ownId, threadId, limit, offset)
    .map(r => ({ ...r, pinned: pinnedIds.has(r.msgId) ? 1 : 0 }));
  const pinned = stmts.listPinnedMessages.all(ownId, threadId, 5)
    .map(r => ({ ...r, pinned: 1 }));
  res.json({ ok: true, data: rows.reverse(), pinned });
});

app.post('/api/chat/mark-read/:ownId/:threadId', (req, res) => {
  stmts.setUnread.run(0, req.params.ownId, req.params.threadId);
  res.json({ ok: true });
});

app.post('/api/chat/send-msg', async (req, res) => {
  const { ownId, threadId, threadType, content, quote, mentions } = req.body;
  if (!ownId || !threadId || !content) return res.json({ ok: false, error: 'Thiếu tham số' });
  try {
    const r = await ZM.sendMessage(ownId, threadId, threadType ?? ZM.ThreadType.User, content, quote, mentions);
    res.json({ ok: true, data: r });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const AI_KEYS = [
  'ai.provider',
  'ai.model',
  'ai.anthropicKey',
  'ai.openaiKey',
  'ai.localUrl',
  'ai.chatgptAccessToken',
  'ai.chatgptRefreshToken',
  'ai.chatgptExpiresAt',
  'ai.chatgptAccountId',
  'ai.chatgptPlanType',
  'ai.chatgptScopes',
];
function getAiSettings() {
  const out = {
    provider: 'claude-cli',
    model: 'sonnet',
    anthropicKey: '',
    openaiKey: '',
    localUrl: 'http://127.0.0.1:11434',
    chatgptAccessToken: '',
    chatgptRefreshToken: '',
    chatgptExpiresAt: '',
    chatgptAccountId: '',
    chatgptPlanType: '',
    chatgptScopes: '',
  };
  for (const k of AI_KEYS) {
    const r = stmts.getSetting.get(k);
    if (r && r.value != null) out[k.split('.')[1]] = r.value;
  }
  return out;
}

function normalizeLocalLlmUrl(value) {
  const raw = String(value || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL Local LLM phải dùng http:// hoặc https://');
  return url.toString().replace(/\/+$/, '');
}

const CHATGPT_OAUTH_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const CHATGPT_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_OAUTH_SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const CHATGPT_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CHATGPT_OAUTH_API_BASE = 'https://chatgpt.com/backend-api';
const CHATGPT_OAUTH_ORIGINATOR = 'Codex Desktop';
const chatGptOAuthFlows = new Map();

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function parseChatGptOAuthMetadata(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return {};
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const nested = claims['https://api.openai.com/auth'] || {};
    return {
      accountId: claims['https://api.openai.com/auth.chatgpt_account_id'] || nested.chatgpt_account_id || '',
      planType: claims['https://api.openai.com/auth.chatgpt_plan_type'] || nested.chatgpt_plan_type || '',
    };
  } catch {
    return {};
  }
}

async function exchangeChatGptOAuthToken(params) {
  const r = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error_description || data?.error || `OAuth HTTP ${r.status}`);
  if (!data.access_token) throw new Error('OAuth không trả về access token');
  return data;
}

function saveChatGptOAuthTokens(data) {
  const metadata = parseChatGptOAuthMetadata(data.id_token || data.access_token);
  stmts.setSetting.run('ai.chatgptAccessToken', String(data.access_token || ''));
  if (data.refresh_token) stmts.setSetting.run('ai.chatgptRefreshToken', String(data.refresh_token));
  stmts.setSetting.run('ai.chatgptExpiresAt', String(Date.now() + Number(data.expires_in || 3600) * 1000));
  stmts.setSetting.run('ai.chatgptScopes', String(data.scope || ''));
  if (metadata.accountId) stmts.setSetting.run('ai.chatgptAccountId', metadata.accountId);
  if (metadata.planType) stmts.setSetting.run('ai.chatgptPlanType', metadata.planType);
  return metadata;
}

async function getChatGptOAuthAccessToken() {
  const settings = getAiSettings();
  if (!settings.chatgptAccessToken) throw new Error('Chưa đăng nhập ChatGPT OAuth trong Cài đặt');
  if (Number(settings.chatgptExpiresAt || 0) > Date.now() + 5 * 60 * 1000) return settings.chatgptAccessToken;
  if (!settings.chatgptRefreshToken) throw new Error('Phiên ChatGPT OAuth đã hết hạn. Vui lòng đăng nhập lại.');
  try {
    const data = await exchangeChatGptOAuthToken({
      grant_type: 'refresh_token',
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      refresh_token: settings.chatgptRefreshToken,
    });
    saveChatGptOAuthTokens(data);
    return data.access_token;
  } catch (e) {
    throw new Error(`Không làm mới được phiên ChatGPT OAuth. Vui lòng đăng nhập lại: ${e.message}`);
  }
}

app.get('/api/settings/ai', (req, res) => {
  const s = getAiSettings();
  res.json({
    ok: true,
    data: {
      provider: s.provider,
      model: s.model,
      anthropicKeySet: !!s.anthropicKey,
      openaiKeySet: !!s.openaiKey,
      localUrl: s.localUrl,
      chatgptOAuthConnected: !!s.chatgptAccessToken,
      chatgptOAuthPlanType: s.chatgptPlanType,
      chatgptOAuthAccountId: s.chatgptAccountId,
      chatgptOAuthExpiresAt: Number(s.chatgptExpiresAt || 0),
    },
  });
});

app.post('/api/settings/ai', (req, res) => {
  const { provider, model, anthropicKey, openaiKey, localUrl } = req.body || {};
  let normalizedLocalUrl;
  try {
    if (localUrl !== undefined) normalizedLocalUrl = normalizeLocalLlmUrl(localUrl);
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
  if (provider) stmts.setSetting.run('ai.provider', String(provider));
  if (model) stmts.setSetting.run('ai.model', String(model));
  if (anthropicKey !== undefined) stmts.setSetting.run('ai.anthropicKey', String(anthropicKey || ''));
  if (openaiKey !== undefined) stmts.setSetting.run('ai.openaiKey', String(openaiKey || ''));
  if (normalizedLocalUrl) stmts.setSetting.run('ai.localUrl', normalizedLocalUrl);
  res.json({ ok: true });
});

app.get('/api/settings/chatgpt-oauth/status', (req, res) => {
  const s = getAiSettings();
  res.json({
    ok: true,
    data: {
      connected: !!s.chatgptAccessToken,
      active: s.provider === 'chatgpt-oauth',
      planType: s.chatgptPlanType,
      accountId: s.chatgptAccountId,
      expiresAt: Number(s.chatgptExpiresAt || 0),
    },
  });
});

app.post('/api/settings/chatgpt-oauth/start', (req, res) => {
  const now = Date.now();
  for (const [id, flow] of chatGptOAuthFlows) {
    if (flow.expiresAt <= now) chatGptOAuthFlows.delete(id);
  }
  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64Url(crypto.randomBytes(16));
  const flowId = base64Url(crypto.randomBytes(18));
  chatGptOAuthFlows.set(flowId, { verifier, state, expiresAt: now + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    redirect_uri: CHATGPT_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: CHATGPT_OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    codex_cli_simplified_flow: 'true',
    id_token_add_organizations: 'true',
    originator: CHATGPT_OAUTH_ORIGINATOR,
  });
  res.json({ ok: true, data: { flowId, authUrl: `${CHATGPT_OAUTH_AUTH_URL}?${params.toString()}` } });
});

app.post('/api/settings/chatgpt-oauth/callback', async (req, res) => {
  const flowId = String(req.body?.flowId || '');
  const redirectUrl = String(req.body?.redirectUrl || '').trim();
  const flow = chatGptOAuthFlows.get(flowId);
  if (!flow || flow.expiresAt <= Date.now()) {
    chatGptOAuthFlows.delete(flowId);
    return res.json({ ok: false, error: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.' });
  }
  let callback;
  try {
    callback = new URL(redirectUrl);
  } catch {
    return res.json({ ok: false, error: 'URL callback không hợp lệ. Hãy dán toàn bộ URL trên thanh địa chỉ.' });
  }
  if (callback.searchParams.get('state') !== flow.state) {
    return res.json({ ok: false, error: 'OAuth state không khớp. Hãy bắt đầu lại đăng nhập.' });
  }
  const oauthError = callback.searchParams.get('error_description') || callback.searchParams.get('error');
  if (oauthError) return res.json({ ok: false, error: oauthError });
  const code = callback.searchParams.get('code');
  if (!code) return res.json({ ok: false, error: 'Callback không có authorization code.' });
  try {
    const data = await exchangeChatGptOAuthToken({
      grant_type: 'authorization_code',
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      code,
      redirect_uri: CHATGPT_OAUTH_REDIRECT_URI,
      code_verifier: flow.verifier,
    });
    const metadata = saveChatGptOAuthTokens(data);
    stmts.setSetting.run('ai.provider', 'chatgpt-oauth');
    stmts.setSetting.run('ai.model', 'gpt-5.4-mini');
    chatGptOAuthFlows.delete(flowId);
    res.json({ ok: true, data: { connected: true, planType: metadata.planType || '', accountId: metadata.accountId || '' } });
  } catch (e) {
    res.json({ ok: false, error: `Đăng nhập ChatGPT thất bại: ${e.message}` });
  }
});

app.post('/api/settings/chatgpt-oauth/logout', (req, res) => {
  for (const key of ['ai.chatgptAccessToken', 'ai.chatgptRefreshToken', 'ai.chatgptExpiresAt', 'ai.chatgptAccountId', 'ai.chatgptPlanType', 'ai.chatgptScopes']) {
    stmts.setSetting.run(key, '');
  }
  const s = getAiSettings();
  let provider = s.provider;
  if (provider === 'chatgpt-oauth') {
    provider = s.openaiKey ? 'openai' : 'claude-cli';
    stmts.setSetting.run('ai.provider', provider);
    stmts.setSetting.run('ai.model', provider === 'openai' ? 'gpt-5.4-mini' : 'sonnet');
  }
  res.json({ ok: true, data: { provider } });
});

// Standard API pricing in USD per 1M text tokens, captured with every recorded request.
// Sources verified 2026-05-26: developers.openai.com/api/docs/models and
// platform.claude.com/docs/en/about-claude/pricing.
const AI_PRICING_AS_OF = '2026-05-26';
const AI_PRICE_RULES = {
  openai: [
    { match: /^gpt-5\.5-pro(?:-|$)/i, input: 30, cacheRead: null, output: 180, longContext: true, source: 'OpenAI GPT-5.5 pro' },
    { match: /^gpt-5\.5(?:-|$)/i, input: 5, cacheRead: 0.5, output: 30, longContext: true, source: 'OpenAI GPT-5.5' },
    { match: /^gpt-5\.4-mini(?:-|$)/i, input: 0.75, cacheRead: 0.075, output: 4.5, source: 'OpenAI GPT-5.4 mini' },
    { match: /^gpt-5\.4-nano(?:-|$)/i, input: 0.2, cacheRead: 0.02, output: 1.25, source: 'OpenAI GPT-5.4 nano' },
    { match: /^gpt-5\.4(?:-|$)/i, input: 2.5, cacheRead: 0.25, output: 15, longContext: true, source: 'OpenAI GPT-5.4' },
    { match: /^gpt-4\.1(?:-|$)/i, input: 2, cacheRead: 0.5, output: 8, source: 'OpenAI GPT-4.1' },
  ],
  anthropic: [
    { match: /^claude-opus-4-(?:7|6)(?:-|$)/i, input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25, source: 'Anthropic Claude Opus 4.7/4.6' },
    { match: /^claude-sonnet-4-6(?:-|$)/i, input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15, source: 'Anthropic Claude Sonnet 4.6' },
    { match: /^claude-haiku-4-5(?:-|$)/i, input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5, source: 'Anthropic Claude Haiku 4.5' },
  ],
};

function getAiPrice(provider, model) {
  return (AI_PRICE_RULES[provider] || []).find(p => p.match.test(String(model || ''))) || null;
}

function toUsageCount(n) {
  return Number.isFinite(Number(n)) ? Math.max(0, Math.trunc(Number(n))) : 0;
}

function recordAiUsage({ provider, model, purpose, usage }) {
  try {
    if (!usage || !['openai', 'anthropic'].includes(provider)) return;
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    if (provider === 'openai') {
      const promptTokens = toUsageCount(usage.prompt_tokens);
      cacheReadTokens = toUsageCount(usage.prompt_tokens_details?.cached_tokens);
      inputTokens = Math.max(0, promptTokens - cacheReadTokens);
      outputTokens = toUsageCount(usage.completion_tokens);
      totalTokens = toUsageCount(usage.total_tokens) || promptTokens + outputTokens;
    } else {
      inputTokens = toUsageCount(usage.input_tokens);
      cacheReadTokens = toUsageCount(usage.cache_read_input_tokens);
      cacheWriteTokens = toUsageCount(usage.cache_creation_input_tokens);
      outputTokens = toUsageCount(usage.output_tokens);
      totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
    }
    const price = getAiPrice(provider, model);
    let inputRate = price?.input ?? null;
    let cacheReadRate = price?.cacheRead ?? null;
    let cacheWriteRate = price?.cacheWrite ?? null;
    let outputRate = price?.output ?? null;
    let priceModifier = '';
    if (price?.longContext && (inputTokens + cacheReadTokens) > 272000) {
      inputRate *= 2;
      if (cacheReadRate !== null) cacheReadRate *= 2;
      outputRate *= 1.5;
      priceModifier = '; long-context pricing';
    }
    const canCalculate = price && (!cacheReadTokens || cacheReadRate !== null);
    const costUsd = canCalculate
      ? (inputTokens * inputRate + cacheReadTokens * cacheReadRate +
        cacheWriteTokens * (cacheWriteRate ?? inputRate) + outputTokens * outputRate) / 1000000
      : null;
    db.prepare(`INSERT INTO ai_usage
      (provider, model, purpose, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, total_tokens,
       input_rate, cache_read_rate, cache_write_rate, output_rate, cost_usd, pricing_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(provider, String(model || ''), purpose || 'chat', inputTokens, cacheReadTokens, cacheWriteTokens,
        outputTokens, totalTokens, inputRate, cacheReadRate, cacheWriteRate,
        outputRate, costUsd, price ? `${price.source}; ${AI_PRICING_AS_OF}${priceModifier}` : null);
  } catch (e) {
    console.warn('[ai-usage] record failed:', e.message);
  }
}

function sumAiUsageSql(groupBy) {
  return `SELECT ${groupBy},
    COUNT(*) AS calls,
    COALESCE(SUM(input_tokens), 0) AS inputTokens,
    COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
    COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
    COALESCE(SUM(output_tokens), 0) AS outputTokens,
    COALESCE(SUM(total_tokens), 0) AS totalTokens,
    COALESCE(SUM(cost_usd), 0) AS costUsd,
    COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpricedCalls
    FROM ai_usage WHERE ts >= ?`;
}

app.get('/api/settings/ai-usage', (req, res) => {
  const requestedDays = parseInt(req.query.days, 10) || 30;
  const days = Math.min(90, Math.max(7, requestedDays));
  const utcOffsetSeconds = 7 * 60 * 60;
  const localNow = Math.floor(Date.now() / 1000) + utcOffsetSeconds;
  const since = Math.floor(localNow / 86400) * 86400 - utcOffsetSeconds - ((days - 1) * 86400);
  const summary = db.prepare(sumAiUsageSql(`'all' AS scope`)).get(since);
  const providers = db.prepare(sumAiUsageSql('provider') + ' GROUP BY provider ORDER BY costUsd DESC, totalTokens DESC').all(since);
  const models = db.prepare(sumAiUsageSql('provider, model') + ' GROUP BY provider, model ORDER BY costUsd DESC, totalTokens DESC').all(since);
  const recordedDaily = db.prepare(sumAiUsageSql(`date(ts, 'unixepoch', '+7 hours') AS day, provider`) +
    ' GROUP BY day, provider ORDER BY day ASC, provider ASC').all(since);
  const daily = [];
  for (let i = 0; i < days; i++) {
    const day = new Date((since + utcOffsetSeconds + i * 86400) * 1000).toISOString().slice(0, 10);
    daily.push({
      day,
      providers: recordedDaily.filter(r => r.day === day),
    });
  }
  res.json({
    ok: true,
    data: { days, timezone: 'Asia/Ho_Chi_Minh', pricingAsOf: AI_PRICING_AS_OF, summary, providers, models, daily },
  });
});

app.get('/api/labels', (req, res) => {
  res.json({ ok: true, data: stmts.listLabels.all() });
});

app.post('/api/labels', (req, res) => {
  const { id, name, color, position, description } = req.body || {};
  if (!name) return res.json({ ok: false, error: 'Thiếu name' });
  const nm = String(name).trim().slice(0, 50);
  const cl = (color || '#fbbf24').toString();
  const pos = parseInt(position) || 0;
  const desc = description != null ? String(description).slice(0, 500) : null;
  try {
    if (id) {
      const prev = stmts.getLabel.get(id);
      if (!prev) return res.json({ ok: false, error: 'Không tìm thấy label' });
      stmts.updateLabel.run(nm, cl, pos, id);
      if (desc !== null) stmts.updateLabelDescription.run(desc, id);
      // If name changed, rename in all threads' labels JSON
      if (prev.name !== nm) {
        const all = db.prepare("SELECT id, ownId, labels FROM threads WHERE labels IS NOT NULL AND labels != ''").all();
        const upd = db.prepare('UPDATE threads SET labels=? WHERE ownId=? AND id=?');
        for (const t of all) {
          try {
            const arr = JSON.parse(t.labels);
            const idx = arr.indexOf(prev.name);
            if (idx >= 0) { arr[idx] = nm; upd.run(JSON.stringify(arr), t.ownId, t.id); }
          } catch {}
        }
      }
      return res.json({ ok: true, id });
    }
    const info = stmts.addLabel.run(nm, cl, pos);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return res.json({ ok: false, error: 'Tên thẻ đã tồn tại' });
    res.json({ ok: false, error: e.message });
  }
});

app.delete('/api/labels/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const lbl = stmts.getLabel.get(id);
  if (!lbl) return res.json({ ok: false, error: 'Không tìm thấy' });
  try {
    // Remove this label name from all threads
    const all = db.prepare("SELECT id, ownId, labels FROM threads WHERE labels IS NOT NULL AND labels != ''").all();
    const upd = db.prepare('UPDATE threads SET labels=? WHERE ownId=? AND id=?');
    for (const t of all) {
      try {
        const arr = JSON.parse(t.labels);
        const filtered = arr.filter(x => x !== lbl.name);
        if (filtered.length !== arr.length) upd.run(JSON.stringify(filtered), t.ownId, t.id);
      } catch {}
    }
    stmts.delLabel.run(id);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// === Auto-reply per-thread ===
function hasGroupAutoReplyGuard(threadType, onlyWhenMentioned, allowedUsers, replyAllInGroup = 0) {
  if (Number(threadType) !== ZM.ThreadType.Group) return true;
  if (replyAllInGroup) return true;
  if (onlyWhenMentioned) return true;
  if (Array.isArray(allowedUsers)) return allowedUsers.map(String).some(Boolean);
  try {
    const parsed = JSON.parse(allowedUsers || '[]');
    return Array.isArray(parsed) && parsed.map(String).some(Boolean);
  } catch {
    return false;
  }
}

app.get('/api/auto-reply/thread/:ownId', (req, res) => {
  // Trả về list có kèm thread name + số reply 24h gần nhất
  const ownId = req.params.ownId;
  const rows = stmts.listAutoReplyThreadsAll.all(ownId);
  const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const enriched = rows.map(r => {
    const t = stmts.getThread.get(ownId, r.threadId);
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM auto_reply_log WHERE ownId=? AND threadId=? AND ts >= ?').get(ownId, r.threadId, since).c;
    const lastReply = db.prepare('SELECT ts, reply_content FROM auto_reply_log WHERE ownId=? AND threadId=? ORDER BY ts DESC LIMIT 1').get(ownId, r.threadId);
    return {
      ...r,
      threadName: t?.name || '—',
      threadAvatar: t?.avatar || '',
      replyCount24h: cnt,
      lastReplyTs: lastReply?.ts || null,
      lastReplyContent: lastReply?.reply_content || '',
    };
  });
  res.json({ ok: true, data: enriched });
});

// Master toggle: bật/tắt toàn bộ auto-reply của 1 account
app.post('/api/auto-reply/master/:ownId', (req, res) => {
  const ownId = req.params.ownId;
  const enable = req.body?.enabled ? 1 : 0;
  if (!enable) {
    db.prepare('UPDATE auto_reply_thread SET enabled=0, updated_at=unixepoch() WHERE ownId=?').run(ownId);
    return res.json({ ok: true, data: { blockedGroups: 0 } });
  }

  const unsafeGroups = db.prepare(`SELECT COUNT(*) AS c FROM auto_reply_thread
    WHERE ownId=? AND threadType=? AND only_when_mentioned=0
      AND COALESCE(reply_all_in_group,0)=0
      AND (allowed_users IS NULL OR trim(allowed_users) IN ('', '[]', 'null'))`).get(ownId, ZM.ThreadType.Group).c;
  db.transaction(() => {
    db.prepare(`UPDATE auto_reply_thread SET enabled=0, updated_at=unixepoch()
      WHERE ownId=? AND threadType=? AND only_when_mentioned=0
        AND COALESCE(reply_all_in_group,0)=0
        AND (allowed_users IS NULL OR trim(allowed_users) IN ('', '[]', 'null'))`).run(ownId, ZM.ThreadType.Group);
    db.prepare(`UPDATE auto_reply_thread SET enabled=1, updated_at=unixepoch()
      WHERE ownId=? AND (threadType<>? OR only_when_mentioned=1
        OR COALESCE(reply_all_in_group,0)=1
        OR (allowed_users IS NOT NULL AND trim(allowed_users) NOT IN ('', '[]', 'null')))`).run(ownId, ZM.ThreadType.Group);
  })();
  res.json({ ok: true, data: { blockedGroups: unsafeGroups } });
});

// Cấu hình mặc định cho mọi hội thoại mới — lưu JSON blob trong settings table
const AR_DEFAULTS_KEY = 'autoReply.defaults';
const AR_DEFAULTS_FALLBACK = {
  mode: 'ai',
  static_reply: '',
  delay_min_sec: 15,
  delay_max_sec: 35,
  max_per_hour: 6,
  work_start: '00:00',
  work_end: '23:59',
  manual_cooldown_min: 10,
  first_n_msgs: 3,
  only_first_msg: 0,  // legacy
  allowed_users: null,
  only_when_mentioned: 1,
  reply_all_in_group: 0,
};
function getAutoReplyDefaults() {
  const raw = stmts.getSetting.get(AR_DEFAULTS_KEY)?.value;
  if (!raw) return { ...AR_DEFAULTS_FALLBACK };
  try { return { ...AR_DEFAULTS_FALLBACK, ...JSON.parse(raw) }; }
  catch { return { ...AR_DEFAULTS_FALLBACK }; }
}
app.get('/api/auto-reply/defaults', (req, res) => {
  res.json({ ok: true, data: getAutoReplyDefaults() });
});
app.post('/api/auto-reply/defaults', (req, res) => {
  const b = req.body || {};
  const firstN = Math.max(0, parseInt(b.first_n_msgs) || 0);
  const allowedUsers = Array.isArray(b.allowed_users)
    ? b.allowed_users.map(String).map(s => s.trim()).filter(Boolean)
    : [];
  const replyAllInGroup = b.reply_all_in_group ? 1 : 0;
  const next = {
    mode: ['ai', 'static', 'keyword'].includes(b.mode) ? b.mode : 'ai',
    static_reply: typeof b.static_reply === 'string' ? b.static_reply : '',
    delay_min_sec: Math.max(0, parseInt(b.delay_min_sec) || 0),
    delay_max_sec: Math.max(0, parseInt(b.delay_max_sec) || 0),
    max_per_hour: Math.max(1, parseInt(b.max_per_hour) || 6),
    work_start: typeof b.work_start === 'string' ? b.work_start : '00:00',
    work_end: typeof b.work_end === 'string' ? b.work_end : '23:59',
    manual_cooldown_min: Math.max(0, parseInt(b.manual_cooldown_min) || 0),
    first_n_msgs: firstN,
    only_first_msg: firstN === 1 ? 1 : 0,  // legacy alias
    allowed_users: replyAllInGroup ? null : (allowedUsers.length ? allowedUsers : null),
    only_when_mentioned: replyAllInGroup ? 0 : (b.only_when_mentioned ? 1 : 0),
    reply_all_in_group: replyAllInGroup,
  };
  if (next.delay_max_sec < next.delay_min_sec) next.delay_max_sec = next.delay_min_sec;
  stmts.setSetting.run(AR_DEFAULTS_KEY, JSON.stringify(next));
  res.json({ ok: true, data: next });
});

// Toggle "Tự động bật AI cho khách lạ" — runtime chỉ bật nếu UID không nằm trong danh sách bạn bè
app.get('/api/auto-reply/stranger-enable', (req, res) => {
  const v = stmts.getSetting.get('autoReply.autoEnableForStrangers')?.value === '1';
  res.json({ ok: true, data: { enabled: v } });
});
app.post('/api/auto-reply/stranger-enable', (req, res) => {
  const enabled = req.body?.enabled ? '1' : '0';
  stmts.setSetting.run('autoReply.autoEnableForStrangers', enabled);
  res.json({ ok: true });
});

// Bộ lọc nhãn: AI chỉ rep thread có 1 trong các nhãn whitelist + auto-gán nhãn cho khách mới
app.get('/api/auto-reply/label-filter', (req, res) => {
  let requireLabels = [];
  try { requireLabels = JSON.parse(stmts.getSetting.get('autoReply.requireLabels')?.value || '[]'); } catch {}
  const strangerLabel = stmts.getSetting.get('autoReply.strangerAutoLabel')?.value || '';
  res.json({ ok: true, data: { requireLabels, strangerAutoLabel: strangerLabel } });
});
app.post('/api/auto-reply/label-filter', (req, res) => {
  const labels = Array.isArray(req.body?.requireLabels) ? req.body.requireLabels.map(String) : [];
  const strangerLabel = String(req.body?.strangerAutoLabel || '').trim();
  stmts.setSetting.run('autoReply.requireLabels', JSON.stringify(labels));
  stmts.setSetting.run('autoReply.strangerAutoLabel', strangerLabel);
  res.json({ ok: true });
});


// Recent auto-reply log toàn account
app.get('/api/auto-reply/recent/:ownId', (req, res) => {
  const ownId = req.params.ownId;
  const limit = parseInt(req.query.limit) || 50;
  const rows = db.prepare(`
    SELECT log.*, t.name AS threadName, t.type AS threadType
    FROM auto_reply_log log
    LEFT JOIN threads t ON t.ownId = log.ownId AND t.id = log.threadId
    WHERE log.ownId = ?
    ORDER BY log.ts DESC
    LIMIT ?
  `).all(ownId, limit);
  res.json({ ok: true, data: rows });
});
app.get('/api/auto-reply/thread/:ownId/:threadId', (req, res) => {
  const row = stmts.getAutoReplyThread.get(req.params.ownId, req.params.threadId);
  res.json({ ok: true, data: row || null });
});
app.post('/api/auto-reply/thread', (req, res) => {
  const b = req.body || {};
  if (!b.ownId || !b.threadId) return res.json({ ok: false, error: 'Thiếu ownId/threadId' });
  const firstN = Math.max(0, parseInt(b.first_n_msgs) || 0);
  const parsedDelayMin = parseInt(b.delay_min_sec);
  const parsedDelayMax = parseInt(b.delay_max_sec);
  const parsedLimit = parseInt(b.max_per_hour);
  const payload = {
    ownId: String(b.ownId),
    threadId: String(b.threadId),
    threadType: parseInt(b.threadType) || 0,
    enabled: b.enabled ? 1 : 0,
    mode: ['ai', 'static', 'keyword'].includes(b.mode) ? b.mode : 'ai',
    static_reply: b.static_reply || '',
    delay_min_sec: Number.isFinite(parsedDelayMin) ? Math.max(0, parsedDelayMin) : 15,
    delay_max_sec: Number.isFinite(parsedDelayMax) ? Math.max(0, parsedDelayMax) : 35,
    max_per_hour: Number.isFinite(parsedLimit) ? Math.max(1, parsedLimit) : 6,
    work_start: b.work_start || '00:00',
    work_end: b.work_end || '23:59',
    only_first_msg: firstN === 1 ? 1 : (b.only_first_msg ? 1 : 0),
    first_n_msgs: firstN || (b.only_first_msg ? 1 : 0),
    manual_cooldown_min: parseInt(b.manual_cooldown_min) || 0,
    allowed_users: b.reply_all_in_group ? null : (b.allowed_users ? JSON.stringify(b.allowed_users) : null),
    only_when_mentioned: b.reply_all_in_group ? 0 : (b.only_when_mentioned ? 1 : 0),
    reply_all_in_group: b.reply_all_in_group ? 1 : 0,
  };
  if (payload.delay_max_sec < payload.delay_min_sec) payload.delay_max_sec = payload.delay_min_sec;
  if (payload.enabled && !hasGroupAutoReplyGuard(payload.threadType, payload.only_when_mentioned, b.allowed_users, payload.reply_all_in_group)) {
    return res.json({
      ok: false,
      error: 'Nhóm chỉ được bật tự động trả lời khi chọn @mention, whitelist user, hoặc bật "reply toàn bộ tin nhắn trong nhóm".',
    });
  }
  try {
    stmts.upsertAutoReplyThread.run(payload);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete('/api/auto-reply/thread/:ownId/:threadId', (req, res) => {
  stmts.delAutoReplyThread.run(req.params.ownId, req.params.threadId);
  res.json({ ok: true });
});
// Test thử: lấy tin gần nhất từ khách trong thread + gọi AI gen reply nhưng KHÔNG gửi
// Trả về preview để user xem AI sẽ nói gì
app.post('/api/auto-reply/test/:ownId/:threadId', async (req, res) => {
  const { ownId, threadId } = req.params;
  const setting = stmts.getAutoReplyThread.get(ownId, threadId);
  if (!setting) return res.json({ ok: false, error: 'Hội thoại này chưa có cài đặt auto-reply' });

  // Lấy tin nhắn KHÁCH gần nhất (isSelf=0)
  const lastFromCustomer = db.prepare(`SELECT * FROM messages WHERE ownId=? AND threadId=? AND isSelf=0 ORDER BY ts DESC LIMIT 1`).get(ownId, threadId);
  if (!lastFromCustomer) return res.json({ ok: false, error: 'Chưa có tin nhắn nào từ khách trong hội thoại này' });

  try {
    let reply = '';
    if (setting.mode === 'static') {
      reply = setting.static_reply || '';
    } else if (setting.mode === 'ai') {
      const rows = stmts.listMsgs.all(ownId, threadId, 15, 0).reverse();
      const contextLines = rows.map(m => {
        const time = new Date(m.ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
        const who = m.isSelf ? 'TÔI' : (m.fromName || 'KHÁCH');
        const text = (m.content || '').slice(0, 300);
        return `[${time}] ${who}: ${text}`;
      });
      const sys = assembleSystemPrompt('short') + `\n\nTạo 1 câu reply ngắn 1-3 câu, text thuần (không markdown), tone "bên mình"/"bạn", KHÔNG báo giá. Output chỉ câu reply.`;
      const userMsg = `=== BỐI CẢNH ===\n${contextLines.join('\n')}\n\n=== TIN VỪA ĐẾN ===\n${lastFromCustomer.fromName || 'KHÁCH'}: ${lastFromCustomer.content}\n\nViết câu trả lời.`;
      reply = await aiTextFromConfiguredProvider({ sys, userMsg, label: 'ar-test' });
    }
    res.json({
      ok: true,
      triggerMsg: { from: lastFromCustomer.fromName || 'KHÁCH', content: lastFromCustomer.content },
      reply: reply || '(trống)',
      mode: setting.mode,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/auto-reply/log/:ownId/:threadId', (req, res) => {
  const rows = db.prepare('SELECT * FROM auto_reply_log WHERE ownId=? AND threadId=? ORDER BY ts DESC LIMIT 50').all(req.params.ownId, req.params.threadId);
  res.json({ ok: true, data: rows });
});

app.get('/api/products', (req, res) => {
  const rows = stmts.listProducts.all().map(p => ({
    ...p,
    objections: (() => { try { return JSON.parse(p.objections || '[]'); } catch { return []; } })(),
    qualify_questions: (() => { try { return JSON.parse(p.qualify_questions || '[]'); } catch { return []; } })(),
  }));
  res.json({ ok: true, data: rows });
});

app.post('/api/products', (req, res) => {
  const b = req.body || {};
  if (!b.id || !b.name) return res.json({ ok: false, error: 'Thiếu id hoặc name' });
  try {
    stmts.upsertProduct.run({
      id: String(b.id).trim(),
      name: String(b.name).trim(),
      target: b.target || '',
      usp: b.usp || '',
      pricing_note: b.pricing_note || '',
      objections: JSON.stringify(b.objections || []),
      qualify_questions: JSON.stringify(b.qualify_questions || []),
      close_script: b.close_script || '',
      keywords: b.keywords || '',
      priority: parseInt(b.priority || 99),
      enabled: b.enabled === false || b.enabled === 0 ? 0 : 1,
    });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.delete('/api/products/:id', (req, res) => {
  try { stmts.delProduct.run(req.params.id); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

const pty = require('node-pty');
const claudeAuthSessions = new Map();

function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()*+][0-9A-Z]/g, '')
    .replace(/\x1b[=>NO78]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function detectAuthUrl(cleanStr) {
  // URL may be wrapped across lines by terminal width — collapse newlines/spaces first
  const flat = cleanStr.replace(/[\r\n]+/g, '').replace(/\s+(?=[A-Za-z0-9_%&=?/.-])/g, '');
  const m = flat.match(/https:\/\/claude\.com\/[A-Za-z0-9_./%&=?+:-]*state=[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

function detectAuthComplete(cleanStr) {
  const compact = cleanStr.replace(/\s+/g, '');
  return /Successfullysignedin|Loggedinas|Loginsuccessful|Authenticationsuccessful/i.test(compact);
}

function killSession(session) {
  try { session.term.kill(); } catch {}
}

function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  for (const p of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude']) {
    if (fs.existsSync(p)) return p;
  }
  const paths = (process.env.PATH || '').split(':');
  for (const dir of paths) {
    const full = path.join(dir, 'claude');
    if (fs.existsSync(full)) return full;
  }
  return null;
}

app.post('/api/settings/claude-login/start', (req, res) => {
  const bin = resolveClaudeBin();
  if (!bin) return res.json({ ok: false, error: 'Không tìm thấy lệnh claude. Cài: npm install -g @anthropic-ai/claude-code' });
  let term;
  try {
    term = pty.spawn(bin, ['auth', 'login', '--claudeai'], {
      name: 'xterm-256color',
      cols: 200, rows: 40,
      cwd: process.env.HOME || '/',
      env: process.env,
    });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }

  const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const session = {
    term, raw: '', clean: '',
    authUrl: null, complete: false, exited: false, exitCode: null,
    listeners: new Set(),
    createdAt: Date.now(),
  };
  claudeAuthSessions.set(sessionId, session);

  term.onData((data) => {
    session.raw += data;
    if (session.raw.length > 50000) session.raw = session.raw.slice(-30000);
    session.clean = stripAnsi(session.raw);
    if (!session.authUrl) session.authUrl = detectAuthUrl(session.clean);
    if (!session.complete && detectAuthComplete(session.clean)) session.complete = true;
    session.listeners.forEach((cb) => cb());
  });
  term.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.listeners.forEach((cb) => cb());
  });

  // Hard-kill session after 5 min to prevent leaks
  setTimeout(() => {
    if (claudeAuthSessions.has(sessionId)) {
      killSession(session);
      claudeAuthSessions.delete(sessionId);
    }
  }, 5 * 60 * 1000);

  let replied = false;
  const tryReply = () => {
    if (replied) return;
    if (session.complete) {
      replied = true;
      killSession(session);
      claudeAuthSessions.delete(sessionId);
      return res.json({ ok: true, autoCompleted: true });
    }
    if (session.exited) {
      replied = true;
      claudeAuthSessions.delete(sessionId);
      if (session.exitCode === 0) return res.json({ ok: true, autoCompleted: true });
      return res.json({ ok: false, error: 'Process thoát sớm (exit ' + session.exitCode + '). ' + session.clean.trim().slice(-300) });
    }
    if (session.authUrl) {
      replied = true;
      return res.json({ ok: true, sessionId, authUrl: session.authUrl });
    }
  };
  session.listeners.add(tryReply);

  setTimeout(() => {
    if (replied) return;
    replied = true;
    session.listeners.delete(tryReply);
    killSession(session);
    claudeAuthSessions.delete(sessionId);
    res.json({ ok: false, error: 'Timeout 20s — không bắt được URL đăng nhập.' });
  }, 20000);
});

app.get('/api/settings/claude-login/poll', (req, res) => {
  const { sessionId } = req.query || {};
  const session = claudeAuthSessions.get(sessionId);
  if (!session) return res.json({ ok: true, state: 'gone' });
  if (session.complete) {
    killSession(session);
    claudeAuthSessions.delete(sessionId);
    return res.json({ ok: true, state: 'success' });
  }
  if (session.exited) {
    claudeAuthSessions.delete(sessionId);
    if (session.exitCode === 0) return res.json({ ok: true, state: 'success' });
    return res.json({ ok: true, state: 'failed', error: 'Process exit ' + session.exitCode + '. ' + session.clean.trim().slice(-300) });
  }
  return res.json({ ok: true, state: 'waiting' });
});

app.post('/api/settings/claude-login/submit', (req, res) => {
  const { sessionId, code } = req.body || {};
  const session = claudeAuthSessions.get(sessionId);
  if (!session) return res.json({ ok: false, error: 'Session đã hết hạn — bấm Đăng nhập lại' });
  const codeStr = String(code || '').trim();
  if (!codeStr) return res.json({ ok: false, error: 'Thiếu code' });

  try {
    session.term.write(codeStr + '\r');
  } catch (e) {
    claudeAuthSessions.delete(sessionId);
    return res.json({ ok: false, error: 'Không gửi được code: ' + e.message });
  }

  let replied = false;
  const check = () => {
    if (replied) return;
    if (session.complete) {
      replied = true;
      session.listeners.delete(check);
      killSession(session);
      claudeAuthSessions.delete(sessionId);
      return res.json({ ok: true });
    }
    if (session.exited) {
      replied = true;
      session.listeners.delete(check);
      claudeAuthSessions.delete(sessionId);
      if (session.exitCode === 0) return res.json({ ok: true });
      return res.json({ ok: false, error: 'Login thất bại (exit ' + session.exitCode + '). ' + session.clean.trim().slice(-300) });
    }
  };
  session.listeners.add(check);

  setTimeout(() => {
    if (replied) return;
    replied = true;
    session.listeners.delete(check);
    res.json({ ok: false, error: 'Timeout 30s — chưa xác nhận được. Bạn có thể đợi thêm và bấm "Kiểm tra" nếu cần.' });
  }, 30000);
});

// ═══════════════════════════════════════════════════════════
// SYSTEM PROMPT theo cấu trúc Anthropic chuẩn (8 sections)
// 1. Role & Identity → 2. Business Context → 3. Tone & Style
// 4. Knowledge Base (XML) → 5. Behavioral Rules → 6. Workflow
// 7. Escalation Rules → 8. Examples (few-shot)
// ═══════════════════════════════════════════════════════════

const PROMPT_SECTION_KEYS = [
  'identity', 'businessContext', 'tone',
  'behavioralRules', 'workflow', 'escalation', 'examples',
];

const PROMPT_SECTION_LABELS = {
  identity: '1. ROLE & IDENTITY',
  businessContext: '2. BUSINESS CONTEXT',
  tone: '3. TONE & STYLE',
  behavioralRules: '5. BEHAVIORAL RULES',
  workflow: '6. WORKFLOW',
  escalation: '7. ESCALATION RULES',
  examples: '8. EXAMPLES',
};

const PROMPT_DEFAULTS = {
  identity: `Bạn là AI Tư vấn của HC Quảng Cáo, đang trực tiếp nhắn tin với khách hàng trên Fanpage Facebook và Zalo.
Nhiệm vụ: trả lời, giải đáp thắc mắc, và chốt sale để khách hàng đăng ký sử dụng dịch vụ của HC.
Bạn nói chuyện TRỰC TIẾP với khách, không phải qua trung gian. Mỗi câu bạn viết ra là tin nhắn khách sẽ đọc ngay.`,

  businessContext: `Pháp nhân: CÔNG TY TNHH HC QUẢNG CÁO
- Mã số thuế: 0111304733
- Địa chỉ: Số 111, tầng 2, Tòa PZ4, Vinhomes Smart City, Phường Tây Mỗ, Thành phố Hà Nội, Việt Nam
- Hotline: 0968.91.5555
- Tên gọi tắt khi nói với khách: "HC Quảng Cáo" hoặc "bên mình".

Lĩnh vực: dịch vụ marketing + OMNI AI MARKETING hợp nhất Zalo và Fanpage Facebook trong một hệ thống.
Khách hàng mục tiêu: chủ shop online, doanh nghiệp vừa và nhỏ, freelancer marketing.
Giá trị cốt lõi: thực dụng, ROI rõ ràng, không bán giấc mơ.
Quy mô danh mục: chi tiết trong <products> ở phần Knowledge Base.

KHI NÀO CHIA SẺ THÔNG TIN PHÁP NHÂN:
- Khách hỏi địa chỉ công ty, MST, hỏi để xuất hóa đơn VAT, hỏi pháp lý → cung cấp đầy đủ.
- Khách hỏi xin gặp trực tiếp / ghé văn phòng → đưa địa chỉ + đề nghị hẹn lịch trước qua hotline.
- Khách bình thường chat về sản phẩm → KHÔNG cần spam MST + địa chỉ, chỉ gọi "bên mình" / "HC Quảng Cáo".`,

  tone: `XƯNG HÔ — LINH HOẠT THEO KHÁCH (rất quan trọng):

Brand (công ty) luôn gọi là "bên mình" — không đổi.

Xưng hô cá nhân của bạn (AI) với khách: ĐỌC LẠI <thread_context> để xem khách tự xưng gì, rồi ĐÁP LẠI tương xứng:

- Khách tự xưng "em" / "em ơi" / "anh ơi" / "chị ơi" / có "ạ" cuối câu → bạn xưng "em", gọi khách là "anh"/"chị" (đoán giới tính từ tên/avatar, không chắc → dùng "anh/chị").
- Khách tự xưng "anh"/"chị" với bạn → bạn xưng "em", gọi khách "anh"/"chị".
- Khách tự xưng "mình"/"tôi", gọi bạn là "bạn" → bạn xưng "mình", gọi khách là "bạn" (ngang hàng, bằng tuổi).
- Khách chưa rõ tone (lần đầu chat, không có manh mối) → MẶC ĐỊNH xưng "mình" gọi "bạn" cho an toàn. Chờ khách trả lời tin tiếp theo để điều chỉnh.

QUY TẮC NHẤT QUÁN: 1 khi đã chọn cặp xưng hô cho 1 khách → GIỮ NHẤT QUÁN trong cả cuộc hội thoại. Không đổi giữa chừng từ "mình/bạn" sang "em/anh" trừ khi khách chủ động đổi trước.

TÍNH CÁCH: thân mật, thẳng thắn, thực dụng. Như 1 người bán hàng giàu kinh nghiệm đang chat với khách, không phải chatbot.
ĐỘ DÀI: mỗi tin nhắn 1-3 câu Zalo. Nếu cần nói nhiều ý → chia 2-3 tin nhắn liên tiếp, mỗi tin 1 ý gọn.
EMOJI: hạn chế, chỉ dùng khi tự nhiên (😊 sau lời chào, 🙏 lời cảm ơn, ❤️ cảm xúc tích cực).
NGÔN NGỮ: 100% tiếng Việt. Thuật ngữ Anh dịch theo từ điển bên dưới.

CẤM TUYỆT ĐỐI (lộ AI):
- Em dash dài "—" trong câu reply gửi khách. Dùng dấu phẩy, chấm, hoặc xuống dòng.
- Cấu trúc "không chỉ ... mà còn ...".
- Sáo ngữ: "trong thời đại số", "đóng vai trò quan trọng", "góp phần", "mang lại giá trị".
- Tính từ thổi phồng: "vô cùng", "đỉnh cao", "uy tín hàng đầu", "tuyệt vời", "xuất sắc".
- Bộ ba slogan: "Nhanh - Hiệu quả - Tiết kiệm", "Đơn giản - Tinh tế - Hiện đại".
- Kết bài AI: "chúc bạn thành công", "hy vọng câu trả lời hữu ích".

TỪ ĐIỂN ANH→VIỆT (đổi bắt buộc):
lead → khách tiềm năng | pain point → vấn đề / nỗi đau | qualify → tìm hiểu nhu cầu | budget → ngân sách | close → chốt sale | funnel → phễu khách | objection → phản đối | follow-up → chăm sóc lại | script → kịch bản | template → mẫu | copy → nội dung | brand → thương hiệu | audit → rà soát | case → ví dụ thực tế | inbox → nhắn tin riêng | bot → trợ lý tự động | paste → dán | share → chia sẻ | reply → trả lời | message → tin nhắn | account → tài khoản | link → đường dẫn

GIỮ NGUYÊN: Facebook, Zalo, Google, ChatGPT, Claude, Instagram, TikTok, Pixel, ROAS, CPM, CPC, CPA, CTR, AIDA, PAS, BAB, FAB, KPI, ROI, B2B, B2C.`,

  behavioralRules: `DO:
- Đọc kỹ <thread_context> để biết khách đã nói gì, đã được trả lời gì. Trả lời tiếp tục mạch, không lặp lại.
- Khi khách hỏi tính năng → kiểm tra trong <products>. USP có → xác nhận. Không có → trả lời thẳng "tính năng đó hiện bên mình chưa hỗ trợ" + đề xuất workaround (nếu có).
- Khi sản phẩm có <pricing_note> chứa bảng giá → báo giá theo đúng bảng. Khách mới → ưu tiên đẩy gói thử 0đ trước. Khách hỏi giá → đưa 3 mốc so sánh.
- Khi sản phẩm KHÔNG có bảng giá → KHÔNG bịa số. Hỏi khách ngân sách + quy mô + ngành để team báo riêng sau.
- Mỗi tin nhắn 1-3 câu Zalo, dễ đọc. Tin dài chia thành 2-3 tin nhắn liên tiếp.
- Cuối câu nên có 1 câu hỏi mở để giữ mạch hội thoại (qualify thêm, gợi mở hành động).

DON'T:
- KHÔNG bịa tính năng không có trong <products>.
- KHÔNG bịa giá khi sản phẩm không có <pricing_note>.
- KHÔNG tự tạo discount, khuyến mãi, cam kết ROI / hoàn tiền ngoài chính sách.
- KHÔNG gửi cả đoạn dài phân tích cho khách. Khách KHÔNG cần thấy quy trình suy nghĩ của bạn.
- KHÔNG dùng từ "để mình kiểm tra rồi báo lại" để câu giờ nếu trả lời được ngay.
- KHÔNG dùng markdown (** __ ## - bullet). Tin Zalo chỉ text thuần.
- KHÔNG tự ý hứa "chiết khấu", "ưu đãi đặc biệt", "tặng miễn phí" nếu không có trong policy.`,

  workflow: `Khi nhận 1 tin nhắn từ khách, đi theo các bước sau (TRONG ĐẦU, không gửi ra cho khách):

Bước 1 — ĐỌC NGỮ CẢNH: nhìn <thread_context>, xác định khách đang ở giai đoạn nào (hỏi info / so sánh / sẵn sàng chốt / đang phản đối / đã mua đang dùng) và đã được trả lời gì trước đó.

Bước 2 — NHẬN DIỆN SẢN PHẨM: dựa trên <keywords> trong <products>, đoán khách quan tâm sản phẩm nào. Mơ hồ → ưu tiên sản phẩm priority nhỏ nhất.

Bước 3 — CHỌN HƯỚNG TRẢ LỜI:
- Khách hỏi info → trả lời ngắn + dẫn dắt sang câu hỏi qualify.
- Khách hỏi giá khi chưa qualify → hỏi 1-2 câu qualify trước (số nick, mục đích, ngân sách) rồi báo giá đúng gói.
- Khách đã qualify đủ → báo giá thẳng theo bảng + đề xuất gói phù hợp.
- Khách phản đối (đắt, không tin, đã dùng tool khác) → khai thác lý do thật, KHÔNG vội giảm giá.
- Khách sẵn sàng chốt → đưa link/cách thanh toán cụ thể.

Bước 4 — VIẾT TIN: chỉ gửi tin trả lời cho khách. Ngắn 1-3 câu, đúng tone xưng hô, cuối có 1 câu hỏi mở (nếu cần dẫn mạch). KHÔNG gửi phân tích ra ngoài.`,

  escalation: `KHI NÀO DỪNG TƯ VẤN BÌNH THƯỜNG VÀ NHẮC TEAM ESCALATE:

- Khách khiếu nại dịch vụ, đòi hoàn tiền, phàn nàn kết quả → đề xuất chuyển sang CSKH / Account Manager, KHÔNG hứa gì.
- Khách yêu cầu giảm giá lớn (> 30%), cam kết ROI cụ thể, đảm bảo doanh số → KHÔNG hứa. Đề xuất chuyển sale senior xử lý.
- Khách hỏi pháp lý, hợp đồng, chính sách cụ thể → đề xuất chuyển bộ phận pháp chế.
- Câu hỏi NGOÀI lĩnh vực marketing / sản phẩm HC → thừa nhận không biết, KHÔNG bịa.
- Khách hỏi tính năng không có trong <products> → trả lời thẳng "chưa hỗ trợ", đề xuất workaround (nếu có) hoặc chuyển team R&D.
- Đơn hàng / hợp đồng dự kiến > 50 triệu → đề xuất chuyển sale senior duyệt offer.`,

  examples: `Đây là 3 ví dụ tin nhắn ĐÚNG TONE — bạn học theo style này, KHÔNG copy nguyên văn.

<example>
<customer_message>Cho mình bảng giá OMNI AI MARKETING</customer_message>
<your_reply>OMNI AI MARKETING tích hợp chăm khách trên Zalo và Fanpage trong cùng hệ thống, bên mình có 3 gói chính tuỳ nhu cầu. Bên mình hỏi nhanh 2 câu cho chuẩn:
1. Bạn đang dùng mấy tài khoản Zalo và Fanpage?
2. Bạn cần nhắn tin marketing, AI tự động trả lời hay quản lý cả hai kênh?
Có thông tin này bên mình tư vấn gói phù hợp ngay.</your_reply>
</example>

<example>
<customer_message>OMNI AI MARKETING có chức năng gọi điện tự động không</customer_message>
<your_reply>Tính năng gọi điện tự động hiện bên mình chưa hỗ trợ bạn ơi. OMNI AI MARKETING tập trung vào nhắn tin, chăm sóc khách và AI trả lời trên Zalo lẫn Fanpage. Nếu bạn cần kết hợp gọi điện, bên mình có đối tác làm phần đó, bạn có cần bên mình giới thiệu không?</your_reply>
</example>

<example>
<customer_message>đắt quá, có giảm được không</customer_message>
<your_reply>Bên mình hiểu mức đầu tư này không nhỏ. Cho bên mình hỏi: bạn đang so với giải pháp nào để thấy đắt, hay đang lo chưa biết ROI sau bao lâu sẽ về? Tuỳ tình huống bên mình tư vấn cách khác nhau, không phải cứ giảm là tốt cho bạn.</your_reply>
</example>

<example>
<customer_message>cho mình xin link đăng ký với</customer_message>
<your_reply>Bạn vào trang này đăng ký gói thử 0đ trước nhé: [link gói thử]
Bên mình sẽ liên hệ lại trong 1 giờ tới để hướng dẫn bạn setup. Bạn cho bên mình xin số điện thoại để hỗ trợ nhanh ạ?</your_reply>
</example>

<example>
<note>Khách dùng "anh" + "ạ" → mặc định khách hơn tuổi, xưng "em" gọi "anh"</note>
<customer_message>Anh muốn hỏi OMNI AI MARKETING quản lý được mấy tài khoản Zalo và Fanpage cùng lúc ạ?</customer_message>
<your_reply>Dạ OMNI AI MARKETING quản lý được nhiều tài khoản Zalo và kết nối Fanpage trong cùng giao diện anh ạ. Anh đang cần dùng bao nhiêu tài khoản Zalo và Fanpage để em tư vấn gói phù hợp ạ?</your_reply>
</example>

<example>
<note>Khách tự xưng "chị" → xưng "em" gọi "chị"</note>
<customer_message>Chị thấy gói 1 năm với gói vĩnh viễn chênh nhau khá nhiều, mua gói nào lợi hơn em?</customer_message>
<your_reply>Dạ tuỳ vào dự định dùng của chị ạ. Nếu chị chỉ test 1-2 nick xem hợp không thì gói 1 năm cho an toàn. Còn chị chắc chắn dùng lâu, có 3 nick trở lên thì gói vĩnh viễn rẻ hơn về dài hạn, ROI sau ~3 năm là chị bắt đầu lãi. Chị đang dự định dùng bao nhiêu nick để em chốt giúp chị?</your_reply>
</example>`,
};

// ═══ Read 1 section: DB override → fallback default ═══
function getPromptSection(key) {
  const custom = stmts.getSetting.get('ai.prompt.' + key)?.value;
  return (custom && custom.trim()) ? custom : (PROMPT_DEFAULTS[key] || '');
}

// ═══ Knowledge Base — Anthropic khuyến nghị XML tags ═══
function buildProductsKbXml(short = false) {
  const prods = stmts.listEnabledProducts.all();
  if (!prods.length) return '<products />';

  const lines = ['<products>'];
  for (const p of prods) {
    lines.push(`  <product id="${p.id}" priority="${p.priority}">`);
    lines.push(`    <name>${escapeXml(p.name || '')}</name>`);
    if (p.target) lines.push(`    <target>${escapeXml(p.target)}</target>`);
    if (p.usp) lines.push(`    <usp>${escapeXml(p.usp)}</usp>`);
    if (p.keywords) lines.push(`    <keywords>${escapeXml(p.keywords)}</keywords>`);

    if (!short) {
      if (p.pricing_note) lines.push(`    <pricing_note internal="true">${escapeXml(p.pricing_note)}</pricing_note>`);
      const qq = (() => { try { return JSON.parse(p.qualify_questions || '[]'); } catch { return []; } })();
      if (qq.length) {
        lines.push(`    <qualify_questions>`);
        for (const q of qq) lines.push(`      <q>${escapeXml(q)}</q>`);
        lines.push(`    </qualify_questions>`);
      }
      if (p.close_script) lines.push(`    <close_script>${escapeXml(p.close_script)}</close_script>`);
      const obj = (() => { try { return JSON.parse(p.objections || '[]'); } catch { return []; } })();
      if (obj.length) {
        lines.push(`    <objections>`);
        for (const o of obj) lines.push(`      <item><q>${escapeXml(o.q || '')}</q><a>${escapeXml(o.a || '')}</a></item>`);
        lines.push(`    </objections>`);
      }
    }
    lines.push(`  </product>`);
  }
  lines.push('</products>');

  if (!short) {
    lines.push('');
    lines.push('<product_selection_rules>');
    lines.push('  - Nhận diện sản phẩm khách quan tâm dựa trên <keywords> + nội dung <thread_context>.');
    lines.push('  - Mơ hồ → ưu tiên sản phẩm có priority nhỏ nhất.');
    lines.push('  - Khách quan tâm nhiều sản phẩm → đẩy priority cao trước, gợi ý bán kèm sau khi chốt.');
    lines.push('  - Khi viết reply: gọi đúng tên sản phẩm, KHÔNG dùng "dịch vụ bên mình" chung chung.');
    lines.push('</product_selection_rules>');
  }

  return lines.join('\n');
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══ Assembler — ráp 8 sections theo thứ tự chuẩn Anthropic ═══
function assembleSystemPrompt(mode = 'full') {
  // mode: 'full' (advisor + quick actions) | 'short' (auto-reply Zalo/FB)
  const isFull = mode === 'full';
  const out = [];

  out.push(`# ${PROMPT_SECTION_LABELS.identity}`);
  out.push(getPromptSection('identity'));
  out.push('');

  out.push(`# ${PROMPT_SECTION_LABELS.businessContext}`);
  out.push(getPromptSection('businessContext'));
  out.push('');

  out.push(`# ${PROMPT_SECTION_LABELS.tone}`);
  out.push(getPromptSection('tone'));
  out.push('');

  out.push('# 4. KNOWLEDGE BASE');
  out.push(buildProductsKbXml(!isFull));
  out.push('');

  out.push(`# ${PROMPT_SECTION_LABELS.behavioralRules}`);
  out.push(getPromptSection('behavioralRules'));
  out.push('');

  if (isFull) {
    out.push(`# ${PROMPT_SECTION_LABELS.workflow}`);
    out.push(getPromptSection('workflow'));
    out.push('');

    out.push(`# ${PROMPT_SECTION_LABELS.escalation}`);
    out.push(getPromptSection('escalation'));
    out.push('');

    out.push(`# ${PROMPT_SECTION_LABELS.examples}`);
    out.push(getPromptSection('examples'));
  }

  return out.join('\n');
}

// ═══ Endpoints — load/save 7 sections riêng lẻ + preview ═══
app.get('/api/settings/prompt-sections', (req, res) => {
  const data = {};
  const defaults = {};
  const usingDefault = {};
  for (const k of PROMPT_SECTION_KEYS) {
    const custom = stmts.getSetting.get('ai.prompt.' + k)?.value || '';
    data[k] = custom;
    defaults[k] = PROMPT_DEFAULTS[k];
    usingDefault[k] = !custom.trim();
  }
  res.json({
    ok: true,
    data: {
      sections: data,
      defaults,
      usingDefault,
      labels: PROMPT_SECTION_LABELS,
      keys: PROMPT_SECTION_KEYS,
    },
  });
});

app.post('/api/settings/prompt-sections', (req, res) => {
  const { key, value } = req.body || {};
  if (!key || !PROMPT_SECTION_KEYS.includes(key)) {
    return res.json({ ok: false, error: 'Section key không hợp lệ' });
  }
  stmts.setSetting.run('ai.prompt.' + key, typeof value === 'string' ? value : '');
  res.json({ ok: true });
});

// Preview prompt cuối cùng (full hoặc short) đã ráp với KB hiện tại
app.get('/api/settings/prompt-preview', (req, res) => {
  const mode = req.query.mode === 'short' ? 'short' : 'full';
  const text = assembleSystemPrompt(mode);
  res.json({ ok: true, data: { mode, text, length: text.length } });
});

// ═══ BUILDER chính ═══
// task: 'advisor' | 'reply' | 'quick' | 'classify'
function buildSysPrompt(task) {
  if (task === 'classify') return '';
  if (task === 'reply' || task === 'quick') return assembleSystemPrompt('short');
  return assembleSystemPrompt('full');
}

function aiViaClaudeCli({ sys, userMsg, model }, res) {
  const isOpus = (model || '').toLowerCase().includes('opus');
  const timeoutMs = isOpus ? 180000 : 90000; // Opus 3 phút, Sonnet/Haiku 90s
  const args = ['-p', userMsg, '--system-prompt', sys, '--model', model || 'sonnet', '--permission-mode', 'plan', '--output-format', 'text'];
  const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch {}
  }, timeoutMs);
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) return res.json({ ok: true, data: { content: stdout.trim() } });

    let err = (stderr || stdout || '').trim();
    if (timedOut) {
      err = `Quá thời gian xử lý (${timeoutMs / 1000}s)` + (isOpus ? '. Opus rất chậm — thử đổi sang Sonnet ở Cài đặt.' : '. Thử lại hoặc đổi sang Haiku ở Cài đặt.');
    } else if (code === null) {
      err = err || 'Process bị dừng đột ngột (signal kill, không phải timeout). Thử lại.';
    } else if (/401|authentication/i.test(err)) {
      err = 'Claude CLI chưa đăng nhập. Vào Cài đặt → "Đăng nhập Claude" để tạo token mới.';
    } else if (!err) {
      err = `claude exit ${code}`;
    }
    res.json({ ok: false, error: err });
  });
  child.on('error', (e) => {
    clearTimeout(timer);
    res.json({ ok: false, error: e.code === 'ENOENT' ? 'Chưa cài Claude CLI. Chạy: npm install -g @anthropic-ai/claude-code' : e.message });
  });
}

async function aiViaAnthropicApi({ sys, messages, model, apiKey, purpose = 'chat' }, res) {
  if (!apiKey) return res.json({ ok: false, error: 'Chưa nhập Anthropic API key trong Cài đặt' });
  const modelMap = { sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-7', haiku: 'claude-haiku-4-5-20251001' };
  const realModel = modelMap[model] || model || 'claude-sonnet-4-6';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: realModel,
        system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
        messages: messages.map(m => {
          if (typeof m.content === 'string') return { role: m.role, content: m.content };
          // Array content → Anthropic multimodal format
          const parts = m.content.map(c => {
            if (c.type === 'text') return { type: 'text', text: c.text };
            if (c.type === 'image') {
              const match = /^data:([^;]+);base64,(.+)$/.exec(c.dataUrl || '');
              if (!match) return null;
              return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
            }
            return null;
          }).filter(Boolean);
          return { role: m.role, content: parts };
        }),
        max_tokens: 2048,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.json({ ok: false, error: data?.error?.message || `HTTP ${r.status}` });
    recordAiUsage({ provider: 'anthropic', model: data.model || realModel, purpose, usage: data.usage });
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    res.json({ ok: true, data: { content: text } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
}

// ═══════════════════════════════════════════════════════════
// FANPAGE FACEBOOK — Inbox kiểu Chatwoot
// ═══════════════════════════════════════════════════════════

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || '';
const FB_GRAPH_API = 'https://graph.facebook.com/v21.0';
const FB_OAUTH_URL = 'https://www.facebook.com/v21.0/dialog/oauth';
// Chỉ xin nhóm quyền tối thiểu cho login Fanpage/Messenger.
const FB_SCOPES = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_messaging',
].join(',');

function getFbAppConfig() {
  const envId = process.env.FB_APP_ID || process.env.FACEBOOK_APP_ID || '';
  const envSecret = process.env.FB_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '';
  const envRedirectUri = process.env.FB_REDIRECT_URI || process.env.FACEBOOK_REDIRECT_URI || '';
  const id = envId || stmts.getSetting.get('fb.appId')?.value || '';
  const secret = envSecret || stmts.getSetting.get('fb.appSecret')?.value || '';
  const redirectUri = envRedirectUri || stmts.getSetting.get('fb.redirectUri')?.value || 'https://ai.hc-agency.online/api/fb/oauth-callback';
  return { id, secret, redirectUri, managedByEnv: !!(envId || envSecret || envRedirectUri) };
}

// Lưu app config
app.post('/api/fb/app-config', (req, res) => {
  const { appId, appSecret, redirectUri } = req.body || {};
  if (appId !== undefined) stmts.setSetting.run('fb.appId', String(appId));
  if (appSecret !== undefined) stmts.setSetting.run('fb.appSecret', String(appSecret));
  if (redirectUri !== undefined) stmts.setSetting.run('fb.redirectUri', String(redirectUri));
  res.json({ ok: true });
});

app.get('/api/fb/app-config', (req, res) => {
  const cfg = getFbAppConfig();
  res.json({
    ok: true,
    data: {
      appId: cfg.id,
      appSecretSet: !!cfg.secret,
      redirectUri: cfg.redirectUri,
      configured: !!(cfg.id && cfg.secret),
      managedByEnv: cfg.managedByEnv,
    },
  });
});

async function exchangeLongLivedFbUserToken(shortToken, cfg) {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: cfg.id,
    client_secret: cfg.secret,
    fb_exchange_token: shortToken,
  });
  const longUrl = `${FB_GRAPH_API}/oauth/access_token?${params.toString()}`;
  const r = await fetch(longUrl);
  const data = await r.json();
  if (data.error) throw new Error(`Không đổi được token dài hạn: ${data.error.message}`);
  if (!data.access_token) throw new Error('Meta không trả về token dài hạn');
  return data.access_token;
}

async function getFbPagesFromUserToken(userToken) {
  const params = new URLSearchParams({
    fields: 'id,name,access_token,picture,instagram_business_account',
    limit: '100',
    access_token: userToken,
  });
  const pagesUrl = `${FB_GRAPH_API}/me/accounts?${params.toString()}`;
  const r = await fetch(pagesUrl);
  const pagesData = await r.json();
  if (pagesData.error) throw new Error(pagesData.error.message);
  return (pagesData.data || []).map(p => ({
    pageId: p.id,
    name: p.name,
    avatar: p.picture?.data?.url || '',
    accessToken: p.access_token,
    userToken,
    instagramId: p.instagram_business_account?.id || null,
  }));
}

function saveFbOAuthSession(pages) {
  const sessionId = 'fb-' + Math.random().toString(36).slice(2, 12);
  stmts.setSetting.run('fb.oauthSession.' + sessionId, JSON.stringify({ pages, ts: Date.now() }));
  return sessionId;
}

// Bắt đầu OAuth: redirect user đến Facebook để login
app.get('/api/fb/oauth-start', (req, res) => {
  const cfg = getFbAppConfig();
  if (!cfg.id || !cfg.secret) {
    return res.status(400).send(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center;background:#f5f5f5">
      <h2 style="color:#dc2626">Facebook Login chưa sẵn sàng</h2>
      <p style="font-size:14px;color:#444;max-width:480px;margin:20px auto">
        Nền tảng chưa được cấu hình Meta App ở server. Vui lòng liên hệ quản trị hệ thống để bật Facebook Login.
      </p>
      <button onclick="window.close()" style="padding:10px 20px;background:#1877F2;color:white;border:0;border-radius:6px;cursor:pointer">Đóng tab này</button>
    </body></html>`);
  }
  const state = Math.random().toString(36).slice(2, 12);
  stmts.setSetting.run('fb.oauthState', state);
  // auth_type=rerequest — yêu cầu lại nếu user đã từ chối quyền lần trước (giống Pancake)
  const url = `${FB_OAUTH_URL}?client_id=${cfg.id}`
    + `&redirect_uri=${encodeURIComponent(cfg.redirectUri)}`
    + `&state=${state}`
    + `&scope=${encodeURIComponent(FB_SCOPES)}`
    + `&response_type=code`
    + `&auth_type=rerequest`;
  res.redirect(url);
});

// OAuth callback: Facebook redirect về đây sau khi user authorize
app.get('/api/fb/oauth-callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const cfg = getFbAppConfig();
  const expectedState = stmts.getSetting.get('fb.oauthState')?.value;

  if (error) {
    return res.send(`<script>window.opener && window.opener.postMessage({ fbOauth: 'error', error: ${JSON.stringify(error_description || error)} }, '*'); window.close();</script><p>Lỗi: ${error_description || error}</p>`);
  }
  if (!code || state !== expectedState) {
    return res.status(400).send('Invalid state hoặc code.');
  }

  try {
    // 1. Đổi code lấy short-lived user token
    const tokenUrl = `${FB_GRAPH_API}/oauth/access_token?client_id=${cfg.id}&client_secret=${cfg.secret}&redirect_uri=${encodeURIComponent(cfg.redirectUri)}&code=${code}`;
    const r1 = await fetch(tokenUrl);
    const t1 = await r1.json();
    if (t1.error) throw new Error(t1.error.message);

    // 2. Đổi sang long-lived user token (60 ngày), rồi lấy Page access token từ /me/accounts.
    const userToken = await exchangeLongLivedFbUserToken(t1.access_token, cfg);
    const pages = await getFbPagesFromUserToken(userToken);

    // Lưu tạm vào session để frontend lấy
    const sessionId = saveFbOAuthSession(pages);

    // Trả về HTML đóng popup + gửi message cho parent
    res.send(`<!DOCTYPE html><html><body>
      <script>
        const data = ${JSON.stringify({ fbOauth: 'success', sessionId, pageCount: pages.length })};
        if (window.opener) {
          window.opener.postMessage(data, '*');
          window.close();
        } else {
          document.body.innerHTML = '<h2>✅ Đã xác thực thành công ' + ${pages.length} + ' Fanpage</h2><p>Bạn có thể đóng tab này và quay lại app.</p>';
        }
      </script>
    </body></html>`);
  } catch (e) {
    res.send(`<script>window.opener && window.opener.postMessage({ fbOauth: 'error', error: ${JSON.stringify(e.message)} }, '*'); window.close();</script><p>Lỗi: ${e.message}</p>`);
  }
});

// Lấy danh sách pages từ session OAuth
app.get('/api/fb/oauth-session/:sessionId', (req, res) => {
  const raw = stmts.getSetting.get('fb.oauthSession.' + req.params.sessionId)?.value;
  if (!raw) return res.json({ ok: false, error: 'Session đã hết hạn hoặc không tồn tại' });
  try { res.json({ ok: true, data: JSON.parse(raw) }); }
  catch { res.json({ ok: false, error: 'Session lỗi' }); }
});

// Nhập token trực tiếp (bỏ qua OAuth) — user dán User Access Token, app tự fetch list pages
app.post('/api/fb/quick-connect', async (req, res) => {
  const { userToken } = req.body || {};
  if (!userToken) return res.json({ ok: false, error: 'Thiếu User Access Token' });
  try {
    const pages = await getFbPagesFromUserToken(userToken);

    if (!pages.length) {
      return res.json({ ok: false, error: 'Token hợp lệ nhưng không tìm thấy Fanpage nào. Token cần có quyền pages_show_list + pages_messaging.' });
    }

    // Lưu session để frontend chọn pages
    const sessionId = saveFbOAuthSession(pages);
    res.json({ ok: true, sessionId, pageCount: pages.length });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Connect bulk pages từ OAuth session
app.post('/api/fb/connect-pages', async (req, res) => {
  const { sessionId, pageIds } = req.body || {};
  if (!sessionId || !Array.isArray(pageIds)) return res.json({ ok: false, error: 'Thiếu tham số' });
  const raw = stmts.getSetting.get('fb.oauthSession.' + sessionId)?.value;
  if (!raw) return res.json({ ok: false, error: 'Session hết hạn' });
  let session;
  try { session = JSON.parse(raw); } catch { return res.json({ ok: false, error: 'Session lỗi' }); }

  const connected = [];
  for (const pid of pageIds) {
    const p = session.pages.find(x => x.pageId === pid);
    if (!p) continue;
    stmts.upsertFbPage.run(p.pageId, p.name, p.avatar, p.accessToken, p.userToken, p.instagramId, null);
    try {
      // Subscribe đầy đủ fields theo Chatwoot (echo để track tin agent gửi từ FB mobile)
      await fetch(`${FB_GRAPH_API}/${p.pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_echoes,message_deliveries,message_reads&access_token=${p.accessToken}`, { method: 'POST' });
    } catch (e) { console.log('[fb] subscribe err:', e.message); }
    connected.push({ pageId: p.pageId, name: p.name, instagramId: p.instagramId });
  }
  // Clear session
  stmts.setSetting.run('fb.oauthSession.' + sessionId, '');
  res.json({ ok: true, data: connected });
});

// Webhook verify (GET) — Facebook gửi challenge khi đăng ký
app.get('/api/fb/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    console.log('[fb-webhook] verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook receive (POST) — Facebook đẩy tin về đây
app.post('/api/fb/webhook', async (req, res) => {
  res.sendStatus(200);  // ack ngay, xử lý ngầm
  try {
    const body = req.body;
    if (body.object !== 'page') return;
    for (const entry of (body.entry || [])) {
      const pageId = entry.id;
      for (const event of (entry.messaging || [])) {
        await handleFbMessagingEvent(pageId, event);
      }
    }
  } catch (e) {
    console.log('[fb-webhook] error:', e.message);
  }
});

async function handleFbMessagingEvent(pageId, event) {
  const page = stmts.getFbPage.get(pageId);
  if (!page) { console.log(`[fb-webhook] unknown pageId=${pageId}`); return; }

  // ═══ MESSAGE event (incoming hoặc echo) ═══
  if (event.message) {
    const senderPsid = event.sender.id;
    const recipientPsid = event.recipient.id;
    // is_echo = tin do Page gửi (qua FB Page Mobile App / Web hoặc qua app này)
    const isEcho = !!event.message.is_echo;
    const isFromPage = isEcho || senderPsid === pageId;
    const customerPsid = isFromPage ? recipientPsid : senderPsid;
    const conversationId = `${pageId}_${customerPsid}`;
    const msgId = event.message.mid;
    const content = event.message.text || '';
    const attachments = event.message.attachments ? JSON.stringify(event.message.attachments) : null;
    const ts = event.timestamp || Date.now();

    // Theo Chatwoot: nếu echo có app_id matching app của mình → tin gửi từ app này (đã save) → bỏ qua
    // Còn echo không phải app này → là tin agent gửi từ FB Mobile/Web → save vào DB như outgoing
    if (isEcho) {
      const cfg = getFbAppConfig();
      const myAppId = cfg.id;
      if (event.message.app_id && String(event.message.app_id) === String(myAppId)) {
        console.log(`[fb-webhook] echo từ chính app này → skip (đã save khi gửi)`);
        return;
      }
      // Echo từ FB Mobile/Web — save như outgoing message để hiển thị trong UI
    }

    // Fetch tên + avatar khách nếu chưa có (chỉ cho incoming)
    let customerName = null, customerAvatar = null;
    if (!isFromPage) {
      try {
        const r = await fetch(`${FB_GRAPH_API}/${customerPsid}?fields=name,profile_pic&access_token=${page.accessToken}`);
        const data = await r.json();
        if (data.error) {
          if (data.error.code === 190 || /OAuth/i.test(data.error.message || '')) {
            stmts.setFbPageReauth.run(1, data.error.message, pageId);
            console.log(`[fb-webhook] page ${pageId} cần REAUTHORIZE: ${data.error.message}`);
          }
        } else {
          customerName = data.name || null;
          customerAvatar = data.profile_pic || null;
        }
      } catch (e) { console.log('[fb-webhook] fetch profile err:', e.message); }
    }

    stmts.upsertFbConvo.run(conversationId, pageId, customerPsid, customerName, customerAvatar, content.slice(0, 200), ts);
    stmts.insertFbMessage.run(
      msgId, pageId, conversationId,
      senderPsid, customerName || null, recipientPsid,
      content, attachments,
      isFromPage ? 1 : 0,
      0,  // isNote
      ts,
      0,  // sourceFromChatwoot = 0 (echo từ FB Mobile/Web hoặc tin khách)
      isFromPage ? 'sent' : 'received'
    );

    if (!isFromPage) stmts.incFbConvoUnread.run(conversationId);

    wsBroadcast({ kind: 'fb-message', pageId, conversationId, msgId, content, isFromPage, ts, customerName, isEcho });
    console.log(`[fb-webhook] msg page=${pageId} ${isEcho ? '[ECHO]' : ''} from=${senderPsid} content="${content.slice(0, 60)}"`);

    // Tin mở đầu ưu tiên trước AI để khách không nhận 2 tin tự động cùng lúc.
    if (!isFromPage && content && content.length > 1) {
      const opened = await tryFbOpeningMessage(page, conversationId, customerPsid, customerName).catch(e => {
        console.log('[fb-opening] err:', e.message);
        return false;
      });
      if (!opened) {
        tryFbAutoReply(page, conversationId, customerPsid, customerName, content).catch(e => console.log('[fb-autoreply] err:', e.message));
      }
    }
    return;
  }

  // ═══ DELIVERY status — tin đã được delivered ═══
  if (event.delivery) {
    const mids = event.delivery.mids || [];
    for (const mid of mids) {
      stmts.updateFbMessageStatus.run('delivered', mid, pageId);
    }
    wsBroadcast({ kind: 'fb-status', pageId, status: 'delivered', mids });
    return;
  }

  // ═══ READ status — user đã đọc tin ═══
  if (event.read) {
    const watermark = event.read.watermark;
    db.prepare(`UPDATE fb_messages SET status='read' WHERE pageId=? AND isFromPage=1 AND ts<=? AND (status='sent' OR status='delivered')`).run(pageId, watermark);
    wsBroadcast({ kind: 'fb-status', pageId, status: 'read', watermark });
    return;
  }

  // ═══ POSTBACK — user bấm button (quick reply, persistent menu) ═══
  if (event.postback) {
    console.log(`[fb-webhook] postback from=${event.sender.id} payload=${event.postback.payload}`);
    // TODO: handle button payload (auto-reply, đăng ký...)
    return;
  }
}

// ═══ TIN NHẮN MỞ ĐẦU cho Fanpage ═══
async function tryFbOpeningMessage(page, conversationId, customerPsid, customerName) {
  const pageId = page.pageId;
  const message = String(page.openingMessage || '').trim();
  if (!message || !page.openingAutoSend) return false;

  if (page.openingOnlyFirstMsg !== 0) {
    const incoming = db.prepare(`SELECT COUNT(*) as cnt FROM fb_messages WHERE conversationId=? AND isFromPage=0`).get(conversationId);
    if ((incoming?.cnt || 0) !== 1) return false;
  }

  const sentSame = db.prepare(`SELECT COUNT(*) as cnt FROM fb_messages WHERE conversationId=? AND isFromPage=1 AND content=?`).get(conversationId, message);
  if ((sentSame?.cnt || 0) > 0) return false;

  try {
    const r = await fetch(`${FB_GRAPH_API}/${pageId}/messages?access_token=${page.accessToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: customerPsid },
        messaging_type: 'RESPONSE',
        message: { text: message },
      }),
    });
    const data = await r.json();
    if (data.error) {
      if (data.error.code === 190 || /OAuth/i.test(data.error.message || '')) {
        stmts.setFbPageReauth.run(1, data.error.message, pageId);
      }
      console.log(`[fb-opening] send err: ${data.error.message}`);
      return false;
    }
    const ts = Date.now();
    const msgId = data.message_id || `fb-opening-${ts}`;
    stmts.insertFbMessage.run(msgId, pageId, conversationId, pageId, 'Page', customerPsid, message, null, 1, 0, ts, 1, 'sent');
    stmts.upsertFbConvo.run(conversationId, pageId, customerPsid, customerName, null, message.slice(0, 200), ts);
    wsBroadcast({ kind: 'fb-message', pageId, conversationId, msgId, content: message, isFromPage: true, ts, customerName, isEcho: false });
    console.log(`[fb-opening] sent page=${pageId} convo=${conversationId}`);
    return true;
  } catch (e) {
    console.log('[fb-opening] send exception:', e.message);
    return false;
  }
}

// ═══ AI AUTO-REPLY cho Fanpage ═══
async function tryFbAutoReply(page, conversationId, customerPsid, customerName, triggerContent) {
  const pageId = page.pageId;
  const convo = stmts.getFbConvo.get(conversationId);
  // Đọc setting auto-reply cho conversation này (lưu trong auto_reply_thread với ownId=pageId)
  const setting = stmts.getAutoReplyThread.get(pageId, conversationId);
  if (!setting || !setting.enabled) return;
  if (setting.mode !== 'ai') return;  // chỉ support AI mode hiện tại

  // Check work hours
  const now = new Date();
  const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const ws = setting.work_start || '00:00';
  const we = setting.work_end || '23:59';
  if (!(ws === '00:00' && we === '23:59')) {
    const inHours = ws <= we ? (hm >= ws && hm <= we) : (hm >= ws || hm <= we);
    if (!inHours) { console.log(`[fb-autoreply] skip ${conversationId}: outside work hours`); return; }
  }

  // Check cooldown (nếu user vừa nhắn tay trong N phút gần đây thì không auto reply)
  const cooldownMin = parseInt(setting.manual_cooldown_min || 0);
  if (cooldownMin > 0) {
    const lastSelf = db.prepare(`SELECT MAX(ts) as ts FROM fb_messages WHERE conversationId=? AND isFromPage=1 AND sourceFromChatwoot=1`).get(conversationId);
    if (lastSelf?.ts && (Date.now() - lastSelf.ts) < cooldownMin * 60000) {
      console.log(`[fb-autoreply] skip ${conversationId}: in manual cooldown`);
      return;
    }
  }

  // Rate limit max_per_hour
  const maxPerHour = parseInt(setting.max_per_hour || 30);
  const hourAgo = Date.now() - 3600000;
  const replies1h = db.prepare(`SELECT COUNT(*) as cnt FROM fb_messages WHERE conversationId=? AND isFromPage=1 AND sourceFromChatwoot=1 AND ts > ?`).get(conversationId, hourAgo);
  if ((replies1h?.cnt || 0) >= maxPerHour) {
    console.log(`[fb-autoreply] skip ${conversationId}: rate limited (${replies1h.cnt}/${maxPerHour} per hour)`);
    return;
  }

  // Build context: 10 tin gần nhất
  const recentMsgs = db.prepare(`SELECT * FROM fb_messages WHERE conversationId=? ORDER BY ts DESC LIMIT 10`).all(conversationId).reverse();
  const contextLines = recentMsgs.map(m => {
    const time = new Date(m.ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    const who = m.isFromPage ? 'TÔI' : (m.fromName || 'KHÁCH');
    return `[${time}] ${who}: ${(m.content || '').slice(0, 300)}`;
  });

  // Dùng PROMPT NGẮN cho auto-reply Fanpage (3-5K thay vì 17K) — nhanh gấp 3-5 lần
  const sys = buildSysPrompt('reply') + `

═══ NHIỆM VỤ AUTO-REPLY FACEBOOK MESSENGER ═══
Bạn đang tự động trả lời 1 tin Facebook Messenger cho team HC.
- Đọc bối cảnh hội thoại bên dưới
- Tạo MỘT câu trả lời ngắn, tự nhiên, đúng tone "bên mình" - "bạn"
- KHÔNG dùng markdown, chỉ text thuần
- Độ dài: 1-3 câu, dễ đọc trên Messenger
- KHÔNG tự ý báo giá, KHÔNG nhắc hotline
- Nếu khách hỏi giá: hỏi thêm context để team báo riêng
- Output: CHỈ trả về câu reply, không có lời giải thích gì khác`;

  const userMsg = `=== BỐI CẢNH HỘI THOẠI ===
${contextLines.join('\n')}

=== TIN VỪA ĐẾN (cần reply) ===
${customerName || 'KHÁCH'}: ${triggerContent}

=== YÊU CẦU ===
Viết câu trả lời ngắn cho tin trên.`;

  // Delay tự nhiên trước khi gửi (3-8 giây)
  const delayMin = parseInt(setting.delay_min_sec || 3) * 1000;
  const delayMax = parseInt(setting.delay_max_sec || 8) * 1000;
  const delay = delayMin + Math.floor(Math.random() * Math.max(0, delayMax - delayMin));
  console.log(`[fb-autoreply] ${conversationId} delay=${delay}ms before AI call`);
  await new Promise(r => setTimeout(r, delay));

  const aiResult = await aiTextFromConfiguredProvider({ sys, userMsg, label: 'fb-autoreply' });

  if (!aiResult) { console.log(`[fb-autoreply] ${conversationId}: AI trả về rỗng`); return; }

  // Gửi reply qua FB Send API
  try {
    const r = await fetch(`${FB_GRAPH_API}/${pageId}/messages?access_token=${page.accessToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: customerPsid },
        messaging_type: 'RESPONSE',
        message: { text: aiResult },
      }),
    });
    const data = await r.json();
    if (data.error) { console.log(`[fb-autoreply] send err: ${data.error.message}`); return; }
    const ts = Date.now();
    stmts.insertFbMessage.run(data.message_id, pageId, conversationId, pageId, 'AI', customerPsid, aiResult, null, 1, 0, ts, 1, 'sent');
    stmts.upsertFbConvo.run(conversationId, pageId, customerPsid, customerName, convo?.customerAvatar || null, aiResult.slice(0, 200), ts);
    // Log
    try {
      db.prepare(`INSERT INTO auto_reply_log (ownId, threadId, threadType, content, triggered_at) VALUES (?, ?, ?, ?, unixepoch())`)
        .run(pageId, conversationId, 99, aiResult);
    } catch {}
    wsBroadcast({ kind: 'fb-message', pageId, conversationId, msgId: data.message_id, content: aiResult, isFromPage: true, ts });
    console.log(`[fb-autoreply] ✅ replied: "${aiResult.slice(0, 60)}"`);
  } catch (e) { console.log('[fb-autoreply] send exception:', e.message); }
}

// API: list connected pages
app.get('/api/fb/pages', (req, res) => {
  res.json({ ok: true, data: stmts.listFbPages.all() });
});

app.post('/api/fb/pages/:pageId/opening-message', (req, res) => {
  const pageId = req.params.pageId;
  const page = stmts.getFbPage.get(pageId);
  if (!page) return res.json({ ok: false, error: 'Không tìm thấy Fanpage' });

  const message = String(req.body?.message || '').trim();
  const autoSend = req.body?.autoSend ? 1 : 0;
  const onlyFirstMsg = req.body?.onlyFirstMsg === false ? 0 : 1;
  if (autoSend && !message) return res.json({ ok: false, error: 'Cần nhập tin nhắn mở đầu trước khi bật tự gửi' });

  stmts.updateFbOpeningMessage.run(message, autoSend, onlyFirstMsg, pageId);
  res.json({
    ok: true,
    data: { pageId, openingMessage: message, openingAutoSend: autoSend, openingOnlyFirstMsg: onlyFirstMsg },
  });
});

// API: connect new page (manual token)
app.post('/api/fb/pages', async (req, res) => {
  const { pageId, accessToken, name } = req.body || {};
  if (!pageId || !accessToken) return res.json({ ok: false, error: 'Thiếu pageId hoặc accessToken' });
  try {
    const r = await fetch(`${FB_GRAPH_API}/${pageId}?fields=name,id,picture,instagram_business_account&access_token=${accessToken}`);
    const data = await r.json();
    if (data.error) return res.json({ ok: false, error: `Facebook: ${data.error.message}` });
    const realName = name || data.name || `Page ${pageId}`;
    const avatar = data.picture?.data?.url || null;
    const igId = data.instagram_business_account?.id || null;
    stmts.upsertFbPage.run(String(pageId), realName, avatar, accessToken, null, igId, null);
    try {
      await fetch(`${FB_GRAPH_API}/${pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_echoes,message_deliveries,message_reads&access_token=${accessToken}`, { method: 'POST' });
    } catch (e) { console.log('[fb] subscribe err:', e.message); }
    res.json({ ok: true, data: { pageId, name: realName, instagramId: igId } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// API: reauthorize page (theo Chatwoot pattern — khi token hết hạn)
app.post('/api/fb/pages/:pageId/reauthorize', async (req, res) => {
  res.json({ ok: true, redirectUrl: '/api/fb/oauth-start' });
});

// API: update page access token thủ công (khi token thiếu quyền hoặc hết hạn)
app.post('/api/fb/pages/:pageId/update-token', async (req, res) => {
  const pageId = req.params.pageId;
  const { accessToken } = req.body || {};
  if (!accessToken) return res.json({ ok: false, error: 'Thiếu access token' });
  const page = stmts.getFbPage.get(pageId);
  if (!page) return res.json({ ok: false, error: 'Không tìm thấy page' });
  try {
    // Verify token có dùng được không (test bằng /me)
    const r = await fetch(`${FB_GRAPH_API}/${pageId}?fields=id,name,picture,instagram_business_account&access_token=${accessToken}`);
    const data = await r.json();
    if (data.error) return res.json({ ok: false, error: `Facebook: ${data.error.message}` });
    // Test thử quyền messaging bằng cách call /conversations
    const tr = await fetch(`${FB_GRAPH_API}/${pageId}/conversations?limit=1&access_token=${accessToken}`);
    const td = await tr.json();
    if (td.error) return res.json({ ok: false, error: `Token này thiếu quyền messaging: ${td.error.message}` });
    // OK — update
    const avatar = data.picture?.data?.url || page.avatar;
    const igId = data.instagram_business_account?.id || page.instagramId;
    stmts.upsertFbPage.run(pageId, data.name || page.name, avatar, accessToken, null, igId, null);
    res.json({ ok: true, data: { pageId, name: data.name, instagramId: igId } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// API: ngắt kết nối page
app.delete('/api/fb/pages/:pageId', (req, res) => {
  stmts.deactivateFbPage.run(req.params.pageId);
  res.json({ ok: true });
});

// API: Đồng bộ toàn bộ conversations + messages cũ của 1 page (từ Graph API)
app.post('/api/fb/pages/:pageId/sync-all', async (req, res) => {
  const pageId = req.params.pageId;
  const page = stmts.getFbPage.get(pageId);
  if (!page) return res.json({ ok: false, error: 'Không tìm thấy Fanpage' });

  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const messagesPerConvo = Math.min(parseInt(req.query.msgs || '50'), 200);

  // Chạy async, return ngay với taskId
  const taskId = 'sync-' + Date.now().toString(36);
  res.json({ ok: true, taskId, message: 'Bắt đầu đồng bộ. Theo dõi qua WebSocket.' });

  syncFbPageConversations(page, taskId, limit, messagesPerConvo).catch(e => {
    wsBroadcast({ kind: 'fb-sync-done', pageId, taskId, error: e.message });
    console.log(`[fb-sync] error page=${pageId}:`, e.message);
  });
});

async function syncFbPageConversations(page, taskId, convoLimit, msgsPerConvo) {
  const pageId = page.pageId;
  const accessToken = page.accessToken;
  console.log(`[fb-sync] start page=${pageId} convoLimit=${convoLimit} msgsPerConvo=${msgsPerConvo}`);

  let totalConvos = 0;
  let totalMsgs = 0;
  let nextUrl = `${FB_GRAPH_API}/${pageId}/conversations?fields=id,participants,updated_time,unread_count,snippet&limit=25&access_token=${accessToken}`;

  // Loop qua từng trang conversations
  while (nextUrl && totalConvos < convoLimit) {
    const r = await fetch(nextUrl);
    const data = await r.json();
    if (data.error) {
      if (data.error.code === 190 || data.error.code === 200) {
        stmts.setFbPageReauth.run(1, data.error.message, pageId);
      }
      // Cung cấp gợi ý cụ thể cho từng loại lỗi
      let hint = '';
      if (data.error.code === 200) {
        hint = ' → Token thiếu quyền pages_messaging HOẶC user không phải Admin/Editor của Page. Cập nhật token: click vào Fanpage trong dropdown → "Cập nhật token".';
      } else if (data.error.code === 190) {
        hint = ' → Token hết hạn. Vào dropdown Fanpage → bấm reauthorize.';
      }
      throw new Error(`Facebook: ${data.error.message}${hint}`);
    }
    const convos = data.data || [];
    if (!convos.length) break;

    for (const c of convos) {
      if (totalConvos >= convoLimit) break;
      // Lấy customer participant (không phải page)
      const participants = c.participants?.data || [];
      const customer = participants.find(p => p.id !== pageId);
      if (!customer) continue;

      const customerPsid = customer.id;
      const customerName = customer.name || null;
      const conversationId = `${pageId}_${customerPsid}`;
      const updatedTime = c.updated_time ? new Date(c.updated_time).getTime() : Date.now();
      const snippet = c.snippet || '';

      // Fetch avatar khách
      let customerAvatar = null;
      try {
        const pr = await fetch(`${FB_GRAPH_API}/${customerPsid}?fields=profile_pic&access_token=${accessToken}`);
        const pd = await pr.json();
        customerAvatar = pd.profile_pic || null;
      } catch {}

      stmts.upsertFbConvo.run(conversationId, pageId, customerPsid, customerName, customerAvatar, snippet, updatedTime);
      if (c.unread_count) stmts.setFbConvoUnread.run(c.unread_count, conversationId);

      // Fetch messages của conversation này
      const msgsUrl = `${FB_GRAPH_API}/${c.id}/messages?fields=id,from,to,message,created_time,attachments&limit=${msgsPerConvo}&access_token=${accessToken}`;
      try {
        const mr = await fetch(msgsUrl);
        const md = await mr.json();
        if (md.error) { console.log(`[fb-sync] msg fetch err convo=${c.id}: ${md.error.message}`); continue; }
        const msgs = md.data || [];
        for (const m of msgs) {
          const fromId = m.from?.id;
          const fromName = m.from?.name || '';
          const toData = (m.to?.data || [])[0];
          const toId = toData?.id;
          const isFromPage = fromId === pageId;
          const ts = m.created_time ? new Date(m.created_time).getTime() : Date.now();
          const content = m.message || '';
          const attachments = m.attachments ? JSON.stringify(m.attachments) : null;

          stmts.insertFbMessage.run(
            m.id, pageId, conversationId,
            fromId, fromName, toId,
            content, attachments,
            isFromPage ? 1 : 0,
            0,  // isNote
            ts,
            0,  // sourceFromChatwoot
            'received'
          );
          totalMsgs++;
        }
      } catch (e) { console.log(`[fb-sync] err msgs:`, e.message); }

      totalConvos++;
      // Broadcast progress mỗi 5 convo
      if (totalConvos % 5 === 0) {
        wsBroadcast({ kind: 'fb-sync-progress', pageId, taskId, convos: totalConvos, messages: totalMsgs });
      }
    }

    nextUrl = data.paging?.next || null;
    // Sleep nhẹ tránh rate-limit FB
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[fb-sync] done page=${pageId}: ${totalConvos} convos, ${totalMsgs} messages`);
  wsBroadcast({ kind: 'fb-sync-done', pageId, taskId, convos: totalConvos, messages: totalMsgs });
}

// API: list conversations of a page
app.get('/api/fb/pages/:pageId/conversations', (req, res) => {
  const pageId = req.params.pageId;
  const status = req.query.status;
  const limit = parseInt(req.query.limit || '100');
  const list = status && status !== 'all'
    ? stmts.listFbConvosByStatus.all(pageId, status, limit)
    : stmts.listFbConvos.all(pageId, limit);
  const counts = {};
  for (const r of stmts.countFbConvosByStatus.all(pageId)) counts[r.status] = r.cnt;
  res.json({ ok: true, data: list, counts });
});

// API: list messages of a conversation
app.get('/api/fb/conversations/:conversationId/messages', (req, res) => {
  const conversationId = req.params.conversationId;
  const limit = parseInt(req.query.limit || '50');
  const offset = parseInt(req.query.offset || '0');
  const rows = stmts.listFbMessages.all(conversationId, limit, offset).reverse();
  // Mark as read
  stmts.setFbConvoUnread.run(0, conversationId);
  res.json({ ok: true, data: rows });
});

// API: send message từ page tới khách
app.post('/api/fb/conversations/:conversationId/send', async (req, res) => {
  const conversationId = req.params.conversationId;
  const { content, isNote } = req.body || {};
  if (!content) return res.json({ ok: false, error: 'Thiếu content' });
  const convo = stmts.getFbConvo.get(conversationId);
  if (!convo) return res.json({ ok: false, error: 'Không tìm thấy hội thoại' });
  const page = stmts.getFbPage.get(convo.pageId);
  if (!page) return res.json({ ok: false, error: 'Page không còn kết nối' });

  // Note nội bộ — không gửi ra FB
  if (isNote) {
    const ts = Date.now();
    const noteId = 'note-' + ts.toString(36);
    stmts.insertFbMessage.run(noteId, convo.pageId, conversationId, null, 'Note', null, content, null, 0, 1, ts, 1, 'sent');
    wsBroadcast({
      kind: 'fb-message',
      pageId: convo.pageId,
      conversationId,
      msgId: noteId,
      content,
      isFromPage: false,
      isNote: true,
      ts,
      customerName: convo.customerName,
    });
    return res.json({ ok: true, isNote: true, msgId: noteId });
  }

  // Theo Chatwoot: dùng messaging_type=RESPONSE trong 24h, MESSAGE_TAG nếu > 24h
  const ageMs = Date.now() - (convo.lastMsgAt || 0);
  const within24h = ageMs < 24 * 60 * 60 * 1000;
  const payload = {
    recipient: { id: convo.customerPsid },
    message: { text: content },
  };
  if (within24h) {
    payload.messaging_type = 'RESPONSE';
  } else {
    payload.messaging_type = 'MESSAGE_TAG';
    payload.tag = 'HUMAN_AGENT';  // Cần App Review để dùng tag này
  }

  try {
    const r = await fetch(`${FB_GRAPH_API}/${convo.pageId}/messages?access_token=${page.accessToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.error) {
      // Theo Chatwoot — token expired → mark reauth required
      if (data.error.code === 190 || /OAuth/i.test(data.error.message || '')) {
        stmts.setFbPageReauth.run(1, data.error.message, convo.pageId);
      }
      return res.json({ ok: false, error: `Facebook: ${data.error.message} (code ${data.error.code})` });
    }
    const ts = Date.now();
    // sourceFromChatwoot=1 → tin gửi từ app này (sau này sẽ nhận echo từ webhook và skip duplicate)
    stmts.insertFbMessage.run(data.message_id, convo.pageId, conversationId, convo.pageId, 'Page', convo.customerPsid, content, null, 1, 0, ts, 1, 'sent');
    stmts.upsertFbConvo.run(conversationId, convo.pageId, convo.customerPsid, convo.customerName, convo.customerAvatar, content.slice(0, 200), ts);
    wsBroadcast({
      kind: 'fb-message',
      pageId: convo.pageId,
      conversationId,
      msgId: data.message_id,
      content,
      isFromPage: true,
      isNote: false,
      ts,
      customerName: convo.customerName,
      status: 'sent',
      isEcho: false,
    });
    res.json({ ok: true, msgId: data.message_id });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// API: tự động phân loại + dán nhãn TOÀN BỘ conversations của 1 page bằng AI
app.post('/api/fb/pages/:pageId/auto-classify', async (req, res) => {
  const pageId = req.params.pageId;
  const page = stmts.getFbPage.get(pageId);
  if (!page) return res.json({ ok: false, error: 'Page không tồn tại' });
  const { services, autoCreateLabels } = req.body || {};
  if (!Array.isArray(services) || !services.length) return res.json({ ok: false, error: 'Thiếu services' });

  // Auto-tạo labels nếu chưa có
  if (autoCreateLabels) {
    for (const s of services) {
      const exists = stmts.getLabelByName.get(s.label);
      if (!exists) {
        try {
          const r = stmts.addLabel.run(s.label, s.color || '#fbbf24', 0);
          if (s.description) stmts.updateLabelDescription.run(s.description, r.lastInsertRowid);
        } catch (e) { console.log('add label err:', e.message); }
      }
    }
  }

  const taskId = 'classify-' + Date.now().toString(36);
  res.json({ ok: true, taskId, message: 'Bắt đầu phân loại. Theo dõi qua WebSocket.' });

  runAutoClassify(pageId, services, taskId).catch(e => {
    wsBroadcast({ kind: 'fb-classify-done', pageId, taskId, error: e.message });
    console.log('[fb-classify] error:', e.message);
  });
});

async function runAutoClassify(pageId, services, taskId) {
  console.log(`[fb-classify] start page=${pageId} services=${services.map(s => s.label).join(',')}`);

  // Lấy conversations CHƯA GẮN NHÃN của page (skip cái đã có label để tiết kiệm AI calls)
  const knownLabels = services.map(s => s.label).concat(['Quan tâm cả 2']);
  const convos = db.prepare(`SELECT * FROM fb_conversations WHERE pageId=? ORDER BY lastMsgAt DESC`)
    .all(pageId)
    .filter(c => {
      if (!c.labels) return true;
      try {
        const lbls = JSON.parse(c.labels);
        // Skip nếu đã có ít nhất 1 label từ danh sách services
        return !lbls.some(l => knownLabels.includes(l));
      } catch { return true; }
    });
  if (!convos.length) {
    wsBroadcast({ kind: 'fb-classify-done', pageId, taskId, classified: 0, skipped: 0 });
    return;
  }

  // Build services description cho prompt
  const servicesText = services.map((s, i) =>
    `${i + 1}. **${s.label}** — ${s.description}`
  ).join('\n\n');

  let classified = 0;
  let skipped = 0;
  const counts = {};

  for (let i = 0; i < convos.length; i++) {
    const c = convos[i];
    try {
      // Lấy tin nhắn của KHÁCH (không phải page) trong conversation
      const customerMsgs = db.prepare(`
        SELECT content FROM fb_messages
        WHERE conversationId=? AND isFromPage=0 AND content IS NOT NULL AND content != ''
        ORDER BY ts DESC LIMIT 10
      `).all(c.id);
      if (!customerMsgs.length) { skipped++; continue; }
      const msgsText = customerMsgs.reverse().map((m, i) => `${i + 1}. ${m.content.slice(0, 300)}`).join('\n');

      // Build prompt
      const sys = `Bạn là chuyên gia phân loại khách hàng cho Hưng Coaching - 1 agency quảng cáo Facebook tại Việt Nam.

Đọc các tin nhắn khách gửi và quyết định họ quan tâm dịch vụ nào trong danh sách:

${servicesText}

${services.length + 1}. **KHÁC** — không liên quan rõ tới dịch vụ nào ở trên (chào hỏi, hỏi vu vơ, spam...)

QUY TẮC:
- Trả lời CHÍNH XÁC 1 trong các tên nhãn ở trên (vd: "${services[0].label}" hoặc "KHÁC")
- Nếu khách hỏi/quan tâm CẢ 2 dịch vụ → trả "QUAN TÂM CẢ 2"
- Đọc giữa các dòng — không cần khách nói thẳng tên dịch vụ
- Tin chào hỏi đơn thuần ("xin chào", "ad ơi") → "KHÁC"

CHỈ TRẢ VỀ 1 DÒNG là tên nhãn. KHÔNG giải thích.`;

      const userMsg = `=== TIN NHẮN KHÁCH "${c.customerName || 'Ẩn danh'}" ĐÃ GỬI ===
${msgsText}

=== YÊU CẦU ===
Khách này quan tâm dịch vụ nào?`;

      // Dùng model nhanh theo provider đang cấu hình (haiku được map sang GPT mini khi dùng OpenAI).
      const decision = await aiTextFromConfiguredProvider({ sys, userMsg, modelOverride: 'haiku', label: 'fb-classify' });

      if (!decision) { skipped++; continue; }

      // Parse decision — tìm label nào match
      let matchedLabel = null;
      const decisionUpper = decision.toUpperCase();
      if (decisionUpper.includes('CẢ 2') || decisionUpper.includes('BOTH')) {
        matchedLabel = 'Quan tâm cả 2';
      } else if (decisionUpper.includes('KHÁC') || decisionUpper.includes('OTHER')) {
        // skip — không gán nhãn
        skipped++;
        continue;
      } else {
        for (const s of services) {
          if (decision.includes(s.label) || decisionUpper.includes(s.label.toUpperCase())) {
            matchedLabel = s.label;
            break;
          }
        }
      }
      if (!matchedLabel) { skipped++; continue; }

      // Lấy labels hiện tại + thêm matchedLabel (giữ nhãn cũ)
      let currentLabels = [];
      try { currentLabels = c.labels ? JSON.parse(c.labels) : []; } catch {}
      if (!currentLabels.includes(matchedLabel)) currentLabels.push(matchedLabel);
      db.prepare('UPDATE fb_conversations SET labels=? WHERE id=?').run(JSON.stringify(currentLabels), c.id);

      classified++;
      counts[matchedLabel] = (counts[matchedLabel] || 0) + 1;

      // Progress mỗi 10 convos
      if (classified % 10 === 0) {
        wsBroadcast({ kind: 'fb-classify-progress', pageId, taskId, done: i + 1, total: convos.length, classified, skipped, counts });
        console.log(`[fb-classify] ${classified}/${convos.length} classified, skipped=${skipped}`);
      }
    } catch (e) {
      console.log(`[fb-classify] err for ${c.id}: ${e.message}`);
      skipped++;
    }

    // Small delay tránh rate-limit Claude
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[fb-classify] done: ${classified} classified, ${skipped} skipped, counts=${JSON.stringify(counts)}`);
  wsBroadcast({ kind: 'fb-classify-done', pageId, taskId, classified, skipped, counts, total: convos.length });
}

// API: gắn labels cho conversation
app.post('/api/fb/conversations/:conversationId/labels', (req, res) => {
  const { labels } = req.body || {};
  if (!Array.isArray(labels)) return res.json({ ok: false, error: 'labels phải là array' });
  db.prepare('UPDATE fb_conversations SET labels=? WHERE id=?').run(JSON.stringify(labels), req.params.conversationId);
  res.json({ ok: true });
});

// API: change conversation status
app.post('/api/fb/conversations/:conversationId/status', (req, res) => {
  const { status } = req.body || {};
  if (!['open', 'pending', 'resolved', 'snoozed'].includes(status)) return res.json({ ok: false, error: 'Status không hợp lệ' });
  stmts.setFbConvoStatus.run(status, req.params.conversationId);
  res.json({ ok: true });
});

// Map các alias Claude (sonnet/opus/haiku) sang GPT mới nhất nếu user lỡ chọn provider OpenAI mà model là Claude alias
function resolveOpenAiModel(model) {
  if (!model) return 'gpt-5.4-mini';
  const m = String(model).toLowerCase();
  // Claude aliases — fallback sang GPT tương đương
  if (m === 'sonnet') return 'gpt-5.4';
  if (m === 'opus') return 'gpt-5.5';
  if (m === 'haiku') return 'gpt-5.4-mini';
  // GPT models — dùng nguyên
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3')) return model;
  return 'gpt-5.4-mini';
}

async function aiViaOpenAiApi({ sys, messages, model, apiKey, purpose = 'chat' }, res) {
  if (!apiKey) return res.json({ ok: false, error: 'Chưa nhập OpenAI API key trong Cài đặt' });
  const realModel = resolveOpenAiModel(model);
  // Model mới (GPT-5.x, GPT-4.1, o1, o3) dùng max_completion_tokens
  // Model cũ (GPT-4o, GPT-4, GPT-3.5) vẫn dùng max_tokens
  const isNewModel = /^(gpt-5|gpt-4\.1|o1|o3)/i.test(realModel);
  const tokenParam = isNewModel ? 'max_completion_tokens' : 'max_tokens';
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: realModel,
        messages: [{ role: 'system', content: sys }, ...messages.map(m => {
          if (typeof m.content === 'string') return { role: m.role, content: m.content };
          // Array content → chat.completions multimodal format
          const parts = m.content.map(c => {
            if (c.type === 'text') return { type: 'text', text: c.text };
            if (c.type === 'image') return { type: 'image_url', image_url: { url: c.dataUrl } };
            return null;
          }).filter(Boolean);
          return { role: m.role, content: parts };
        })],
        [tokenParam]: 2048,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || `HTTP ${r.status}`;
      // Hint khi key sai / chưa thanh toán
      if (r.status === 401) return res.json({ ok: false, error: 'OpenAI API key không hợp lệ. Kiểm tra lại key tại platform.openai.com → API keys.' });
      if (r.status === 429) return res.json({ ok: false, error: 'Đã vượt rate limit / quota OpenAI. Kiểm tra số dư + giới hạn ở platform.openai.com.' });
      if (/model.*not.*found|does not exist/i.test(msg)) return res.json({ ok: false, error: `Model "${realModel}" không khả dụng với key này. Một số model mới (gpt-5.5, gpt-5.5-pro) yêu cầu tier cao — đổi sang gpt-5.4-mini hoặc gpt-5.4-nano.` });
      return res.json({ ok: false, error: msg });
    }
    recordAiUsage({ provider: 'openai', model: data.model || realModel, purpose, usage: data.usage });
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    res.json({ ok: true, data: { content: text } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
}

const CHATGPT_OAUTH_MODELS = new Set(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.1']);

function resolveChatGptOAuthModel(model) {
  const selected = String(model || '');
  return CHATGPT_OAUTH_MODELS.has(selected) ? selected : 'gpt-5.4-mini';
}

function buildChatGptOAuthInput(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : '';
      return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
    }
    if (typeof m.content === 'string') return { role: 'user', content: m.content };
    // Array content → Responses API format
    const parts = m.content.map(c => {
      if (c.type === 'text') return { type: 'input_text', text: c.text };
      if (c.type === 'image') return { type: 'input_image', image_url: c.dataUrl };
      return null;
    }).filter(Boolean);
    return { role: 'user', content: parts };
  });
}

function extractChatGptOAuthResponseText(response) {
  const messages = (response?.output || []).filter(item => item.type === 'message');
  const preferred = messages.some(item => item.phase === 'final_answer')
    ? messages.filter(item => item.phase === 'final_answer')
    : messages.filter(item => item.phase !== 'commentary');
  return preferred.flatMap(item => item.content || [])
    .filter(part => part.type === 'output_text')
    .map(part => part.text || '')
    .join('');
}

async function aiViaChatGptOAuth({ sys, messages, model }, res) {
  let accessToken;
  try {
    accessToken = await getChatGptOAuthAccessToken();
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
  const realModel = resolveChatGptOAuthModel(model);
  try {
    const r = await fetch(`${CHATGPT_OAUTH_API_BASE}/codex/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'OpenAI-Beta': 'responses=v1',
      },
      body: JSON.stringify({
        model: realModel,
        instructions: sys || 'You are a helpful assistant.',
        input: buildChatGptOAuthInput(messages),
        stream: true,
        store: false,
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      if (r.status === 401) return res.json({ ok: false, error: 'Phiên ChatGPT OAuth không còn hợp lệ. Vui lòng đăng nhập lại trong Cài đặt.' });
      return res.json({ ok: false, error: `ChatGPT OAuth HTTP ${r.status}: ${text.slice(0, 300)}` });
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completedResponse = null;
    let failedMessage = '';
    const itemOutput = new Map();
    const itemPhase = new Map();
    const itemOrder = [];
    const ensureItem = (id) => {
      const key = id || '__default__';
      if (!itemOutput.has(key)) {
        itemOutput.set(key, '');
        itemOrder.push(key);
      }
      return key;
    };
    const processEvent = (event) => {
      const itemId = event.item_id || event.item?.id || '';
      if (event.type === 'response.output_item.added' && event.item?.type === 'message') {
        const key = ensureItem(itemId);
        itemPhase.set(key, event.item.phase || '');
      } else if (event.type === 'response.output_text.delta') {
        const key = ensureItem(itemId);
        itemOutput.set(key, itemOutput.get(key) + String(event.delta || ''));
      } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        completedResponse = event.response || null;
      } else if (event.type === 'response.failed') {
        failedMessage = event.response?.error?.message || event.error?.message || 'ChatGPT OAuth trả về lỗi';
      }
    };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { processEvent(JSON.parse(data)); } catch {}
      }
    }
    if (failedMessage) return res.json({ ok: false, error: failedMessage });
    let text = extractChatGptOAuthResponseText(completedResponse);
    if (!text) {
      const hasFinal = itemOrder.some(id => itemPhase.get(id) === 'final_answer');
      text = itemOrder
        .filter(id => hasFinal ? itemPhase.get(id) === 'final_answer' : itemPhase.get(id) !== 'commentary')
        .map(id => itemOutput.get(id))
        .join('');
    }
    text = text.trim();
    if (!text) return res.json({ ok: false, error: 'ChatGPT OAuth trả về nội dung trống' });
    res.json({ ok: true, data: { content: text } });
  } catch (e) {
    res.json({ ok: false, error: `Không gọi được ChatGPT OAuth: ${e.message}` });
  }
}

async function aiViaLocalLlm({ sys, messages, model, baseUrl }, res) {
  const realModel = model || 'qwen3:4b-q4_K_M';
  let url;
  try {
    url = normalizeLocalLlmUrl(baseUrl);
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
  try {
    const r = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: realModel,
        messages: [{ role: 'system', content: sys }, ...messages.map(m => ({ role: m.role, content: m.content }))],
        stream: false,
        think: false,
        keep_alive: '30m',
        options: { num_ctx: 16384, num_predict: 2048 },
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.json({ ok: false, error: data?.error || `HTTP ${r.status}` });
    const text = String(data.message?.content || '').trim();
    if (!text) return res.json({ ok: false, error: 'Local LLM trả về nội dung trống' });
    res.json({ ok: true, data: { content: text } });
  } catch (e) {
    res.json({ ok: false, error: `Không kết nối được Local LLM tại ${url}: ${e.message}` });
  }
}

function aiTextFromConfiguredProvider({ sys, userMsg, userContent, modelOverride, label = 'ai', needsVision = false }) {
  const settings = getAiSettings();
  const provider = settings.provider || 'claude-cli';
  let model = provider === 'local'
    ? (settings.model || 'qwen3:4b-q4_K_M')
    : (modelOverride || settings.model || 'sonnet');

  // Codex-specialized models không có vision — force sang general vision model
  if (needsVision && provider === 'chatgpt-oauth' && /codex/i.test(model)) {
    const fallback = 'gpt-5.5';
    console.log(`[${label}] vision required, ${model} không hỗ trợ → switch ${fallback}`);
    model = fallback;
  }

  const finalContent = userContent || userMsg;
  const messages = [{ role: 'user', content: finalContent }];
  const userLen = typeof finalContent === 'string'
    ? finalContent.length
    : finalContent.reduce((s, c) => s + (c.type === 'text' ? c.text.length : 1000), 0);
  console.log(`[${label}] provider=${provider} model=${model} sys=${sys.length}c userLen=${userLen}c vision=${needsVision}`);

  return new Promise((resolve, reject) => {
    const adapter = {
      json: (result) => {
        if (result?.ok) return resolve((result.data?.content || '').trim());
        reject(new Error(result?.error || 'AI request failed'));
      },
    };
    if (provider === 'anthropic') {
      aiViaAnthropicApi({ sys, messages, model, apiKey: settings.anthropicKey, purpose: label }, adapter);
      return;
    }
    if (provider === 'openai') {
      aiViaOpenAiApi({ sys, messages, model, apiKey: settings.openaiKey, purpose: label }, adapter);
      return;
    }
    if (provider === 'chatgpt-oauth') {
      aiViaChatGptOAuth({ sys, messages, model }, adapter);
      return;
    }
    if (provider === 'local') {
      aiViaLocalLlm({ sys, messages, model, baseUrl: settings.localUrl }, adapter);
      return;
    }
    if (provider === 'claude-cli') {
      aiViaClaudeCli({ sys, userMsg, model }, adapter);
      return;
    }
    reject(new Error(`Provider AI không hỗ trợ: ${provider}`));
  });
}

// Endpoint test API key — kiểm tra ngay khi user nhập (hoặc dùng key đã lưu)
app.post('/api/settings/openai/test', async (req, res) => {
  let apiKey = (req.body?.apiKey || '').trim();
  if (!apiKey) {
    // Fallback: dùng key đã lưu
    const s = getAiSettings();
    apiKey = s.openaiKey || '';
    if (!apiKey) return res.json({ ok: false, error: 'Chưa có key nào để kiểm tra. Nhập key vào ô bên trên hoặc Lưu key trước.' });
  }
  try {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    if (r.status === 401) return res.json({ ok: false, error: 'API key sai hoặc đã bị thu hồi' });
    if (!r.ok) return res.json({ ok: false, error: `HTTP ${r.status}` });
    const data = await r.json();
    const models = (data.data || []).map(m => m.id);
    const gpt5 = models.filter(id => id.startsWith('gpt-5'));
    const gpt4 = models.filter(id => id.startsWith('gpt-4'));
    res.json({
      ok: true,
      totalModels: models.length,
      hasGpt5: gpt5.length > 0,
      gpt5Sample: gpt5.slice(0, 5),
      gpt4Sample: gpt4.slice(0, 5),
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/settings/local/test', async (req, res) => {
  let url;
  try {
    url = normalizeLocalLlmUrl(req.body?.localUrl || getAiSettings().localUrl);
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
  const model = String(req.body?.model || getAiSettings().model || 'qwen3:4b-q4_K_M').trim();
  try {
    const r = await fetch(`${url}/api/tags`);
    const data = await r.json();
    if (!r.ok) return res.json({ ok: false, error: data?.error || `HTTP ${r.status}` });
    const models = (data.models || []).map(m => m.name || m.model).filter(Boolean);
    const hasModel = models.includes(model);
    if (!hasModel) {
      return res.json({ ok: false, error: `Đã kết nối Ollama nhưng chưa có model "${model}". Model hiện có: ${models.join(', ') || '(trống)'}` });
    }
    res.json({ ok: true, url, model, models });
  } catch (e) {
    res.json({ ok: false, error: `Không kết nối được Ollama tại ${url}: ${e.message}` });
  }
});

app.post('/api/ai/chat-stream', (req, res) => {
  const { messages = [], systemPrompt, threadContext } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).end('Thiếu messages');

  const base = systemPrompt || assembleSystemPrompt('full');
  const sys = base + (threadContext ? `\n\n<thread_context>\n${threadContext}\n</thread_context>` : '');

  const settings = getAiSettings();
  const provider = settings.provider || 'claude-cli';
  const model = settings.model || 'sonnet';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  // Provider != claude-cli → fallback: gọi non-stream rồi emit 1 chunk
  if (provider !== 'claude-cli') {
    const fakeRes = {
      json: (obj) => {
        if (obj.ok) send({ chunk: obj.data.content });
        else send({ error: obj.error || 'Lỗi không rõ' });
        send({ done: true });
        res.end();
      },
    };
    if (provider === 'anthropic') return aiViaAnthropicApi({ sys, messages, model, apiKey: settings.anthropicKey, purpose: 'advisor-stream' }, fakeRes);
    if (provider === 'openai') return aiViaOpenAiApi({ sys, messages, model, apiKey: settings.openaiKey, purpose: 'advisor-stream' }, fakeRes);
    if (provider === 'chatgpt-oauth') return aiViaChatGptOAuth({ sys, messages, model }, fakeRes);
    if (provider === 'local') return aiViaLocalLlm({ sys, messages, model, baseUrl: settings.localUrl }, fakeRes);
  }

  const turnLines = messages.map(m => `[${m.role === 'user' ? 'HC' : 'Bạn (AI)'}]\n${m.content}`).join('\n\n');
  const isOpus = (model || '').toLowerCase().includes('opus');
  const timeoutMs = isOpus ? 240000 : 180000;
  const args = ['-p', turnLines, '--system-prompt', sys, '--model', model || 'sonnet',
                '--permission-mode', 'plan', '--output-format', 'stream-json',
                '--include-partial-messages', '--verbose'];
  const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  let stderrBuf = '';
  let timedOut = false;
  let errorSent = false;
  let totalChunks = 0;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch {}
  }, timeoutMs);

  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta'
            && evt.event.delta?.type === 'text_delta' && evt.event.delta.text) {
          totalChunks++;
          send({ chunk: evt.event.delta.text });
        } else if (evt.type === 'result' && evt.is_error) {
          errorSent = true;
          send({ error: evt.result || 'AI lỗi (result)' });
        }
      } catch {}
    }
  });
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (timedOut) {
      send({ error: `Quá thời gian xử lý (${timeoutMs / 1000}s)` + (isOpus ? '. Opus rất chậm — thử Sonnet/Haiku.' : '. Thử lại hoặc đổi Haiku.') });
    } else if (code !== 0 && !errorSent) {
      const err = stderrBuf.trim() || `claude exit ${code}`;
      send({ error: /401|authentication/i.test(err) ? 'Claude CLI chưa đăng nhập. Vào Cài đặt → "Đăng nhập Claude".' : err });
    }
    send({ done: true });
    res.end();
  });
  child.on('error', (e) => {
    clearTimeout(timer);
    send({ error: e.code === 'ENOENT' ? 'Chưa cài Claude CLI' : e.message });
    send({ done: true });
    res.end();
  });

  // Dùng res.on để detect client disconnect thật (req.on('close') fires sai trong Express)
  res.on('close', () => {
    if (!res.writableEnded && !child.killed) {
      try { child.kill('SIGTERM'); } catch {}
    }
  });
});

app.post('/api/ai/chat', (req, res) => {
  const { messages = [], systemPrompt, threadContext, task } = req.body;
  if (!Array.isArray(messages) || !messages.length) return res.json({ ok: false, error: 'Thiếu messages' });

  // task='quick' → prompt ngắn (3K) | task='advisor' (default) → prompt full (17K)
  let sys;
  if (systemPrompt) {
    sys = systemPrompt;
  } else {
    sys = buildSysPrompt(task === 'quick' ? 'quick' : 'advisor');
  }
  if (threadContext) sys += `\n\n<thread_context>\n${threadContext}\n</thread_context>`;

  const settings = getAiSettings();
  const provider = settings.provider || 'claude-cli';
  const model = settings.model || 'sonnet';

  if (provider === 'anthropic') {
    return aiViaAnthropicApi({ sys, messages, model, apiKey: settings.anthropicKey, purpose: task || 'advisor' }, res);
  }
  if (provider === 'openai') {
    return aiViaOpenAiApi({ sys, messages, model, apiKey: settings.openaiKey, purpose: task || 'advisor' }, res);
  }
  if (provider === 'chatgpt-oauth') {
    return aiViaChatGptOAuth({ sys, messages, model }, res);
  }
  if (provider === 'local') {
    return aiViaLocalLlm({ sys, messages, model, baseUrl: settings.localUrl }, res);
  }
  // default: claude-cli
  const turnLines = messages.map(m => `[${m.role === 'user' ? 'HC' : 'Bạn (AI)'}]\n${m.content}`).join('\n\n');
  aiViaClaudeCli({ sys, userMsg: turnLines, model }, res);
});

app.post('/api/chat/lookup-phone', async (req, res) => {
  const { ownId, phone } = req.body;
  if (!ownId || !phone) return res.json({ ok: false, error: 'Thiếu ownId/phone' });
  try {
    const u = await ZM.findUserByPhone(ownId, phone);
    const uid = u?.userId || u?.uid;
    res.json({ ok: true, data: uid ? {
      userId: uid,
      name: u?.zaloName || u?.displayName || u?.fullName || '',
      avatar: u?.avatar || '',
      gender: u?.gender || null,
      phone,
    } : null });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/chat/send-typing', async (req, res) => {
  const { ownId, threadId, threadType } = req.body;
  if (!ownId || !threadId) return res.json({ ok: false, error: 'Thiếu tham số' });
  try {
    await ZM.sendTyping(ownId, threadId, threadType ?? 0);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/chat/thread-pin', async (req, res) => {
  const { ownId, threadId, threadType, pinned } = req.body;
  if (!ownId || !threadId) return res.json({ ok: false, error: 'Thiếu tham số' });
  try {
    await ZM.setPinnedConversation(ownId, threadId, threadType ?? 0, !!pinned);
    stmts.setPinned.run(pinned ? 1 : 0, ownId, String(threadId));
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/chat/message-pin', (req, res) => {
  const { ownId, threadId, msgId, pinned } = req.body || {};
  if (!ownId || !threadId || !msgId) return res.json({ ok: false, error: 'Thiếu tham số' });
  try {
    const tid = String(threadId);
    const mid = String(msgId);
    if (pinned) {
      const msg = stmts.getMsgInThread.get(ownId, tid, mid);
      if (!msg) return res.json({ ok: false, error: 'Không tìm thấy tin nhắn để ghim' });
      stmts.pinMessage.run(ownId, tid, mid);
    } else {
      stmts.unpinMessage.run(ownId, tid, mid);
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/chat/thread-unread', async (req, res) => {
  const { ownId, threadId, threadType, unread } = req.body;
  if (!ownId || !threadId) return res.json({ ok: false, error: 'Thiếu tham số' });
  try {
    await ZM.setUnreadMark(ownId, threadId, threadType ?? 0, !!unread);
    stmts.setUnread.run(unread ? 1 : 0, ownId, String(threadId));
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/chat/thread-remove', (req, res) => {
  const { ownId, threadId } = req.body || {};
  if (!ownId || !threadId) return res.json({ ok: false, error: 'Thiếu tham số' });
  try {
    stmts.removePinnedThreadMessages.run(ownId, String(threadId));
    db.prepare('DELETE FROM messages WHERE ownId=? AND threadId=?').run(ownId, String(threadId));
    db.prepare('DELETE FROM threads WHERE ownId=? AND id=?').run(ownId, String(threadId));
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/chat/msg-react', async (req, res) => {
  const { ownId, threadId, threadType, msgId, cliMsgId, icon } = req.body;
  if (!ownId || !threadId || !msgId) return res.json({ ok: false, error: 'Thiếu tham số' });
  try {
    const r = await ZM.addReaction(ownId, threadId, threadType ?? 0, msgId, cliMsgId, icon || '');
    res.json({ ok: true, data: r });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/chat/msg-recall', async (req, res) => {
  const { ownId, threadId, threadType, msgId, cliMsgId } = req.body;
  if (!ownId || !threadId || !msgId) return res.json({ ok: false, error: 'Thiếu tham số' });
  try {
    const r = await ZM.undoMessage(ownId, threadId, threadType ?? 0, msgId, cliMsgId);
    res.json({ ok: true, data: r });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/chat/delete-chat', async (req, res) => {
  const { ownId, threadId, threadType } = req.body || {};
  if (!ownId || !threadId) return res.json({ ok: false, error: 'Thiếu tham số' });
  try {
    const last = db.prepare(
      `SELECT msgId, fromId, ts, meta FROM messages WHERE ownId=? AND threadId=? ORDER BY ts DESC LIMIT 1`
    ).get(ownId, String(threadId));
    if (!last || !last.msgId) {
      db.prepare('DELETE FROM messages WHERE ownId=? AND threadId=?').run(ownId, String(threadId));
      return res.json({ ok: true, data: { status: 0, note: 'Không có tin nhắn để xoá trên Zalo, chỉ clear DB local.' } });
    }
    let cliMsgId = last.msgId;
    try { const m = last.meta ? JSON.parse(last.meta) : null; if (m && m.cliMsgId) cliMsgId = String(m.cliMsgId); } catch {}
    const r = await ZM.deleteChat(ownId, threadId, threadType ?? 0, {
      ownerId: last.fromId || ownId,
      cliMsgId,
      globalMsgId: last.msgId,
    });
    db.prepare('DELETE FROM messages WHERE ownId=? AND threadId=?').run(ownId, String(threadId));
    res.json({ ok: true, data: r });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/chat/msg-forward', async (req, res) => {
  const { ownId, targets, content, quote } = req.body;
  if (!ownId || !Array.isArray(targets) || !targets.length || !content) return res.json({ ok: false, error: 'Thiếu tham số' });
  const results = [];
  for (const t of targets) {
    try {
      await ZM.sendMessage(ownId, t.threadId, t.threadType ?? 0, content, quote);
      results.push({ threadId: t.threadId, ok: true });
    } catch (e) {
      results.push({ threadId: t.threadId, ok: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 800));
  }
  res.json({ ok: true, data: results });
});

app.post('/api/chat/send-attachment', fileUpload.array('files', 10), async (req, res) => {
  const { ownId, threadId, threadType } = req.body;
  const files = (req.files || []).map(f => f.path);
  if (!ownId || !threadId || !files.length) return res.json({ ok: false, error: 'Thiếu tham số hoặc file' });
  try {
    const s = ZM.getSession(ownId);
    if (!s) return res.json({ ok: false, error: 'Account chưa kết nối' });
    const r = await s.api.sendMessage({ msg: req.body.caption || '', attachments: files }, threadId, parseInt(threadType) || 0);
    setTimeout(() => { for (const f of files) try { fs.unlinkSync(f); } catch {} }, 30000);
    res.json({ ok: true, data: r });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/chat/search/:ownId', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ ok: true, data: [] });
  res.json({ ok: true, data: stmts.searchMsgs.all(req.params.ownId, '%' + q + '%') });
});

app.get('/api/chat/templates/:ownId', (req, res) => res.json({ ok: true, data: stmts.listTemplates.all(req.params.ownId) }));
app.post('/api/chat/templates', (req, res) => {
  const { ownId, name, content } = req.body;
  const r = stmts.addTemplate.run(ownId || null, name, content);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.delete('/api/chat/templates/:id', (req, res) => { stmts.delTemplate.run(req.params.id); res.json({ ok: true }); });

app.post('/api/chat/schedule', (req, res) => {
  const { ownId, threadId, threadType, content, scheduleAt } = req.body;
  const r = stmts.addScheduled.run(ownId, threadId, threadType ?? 0, content, scheduleAt);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.get('/api/chat/scheduled/:ownId', (req, res) => res.json({ ok: true, data: stmts.listScheduled.all(req.params.ownId) }));

app.get('/api/chat/auto-replies/:ownId', (req, res) => res.json({ ok: true, data: stmts.listAutoReplies.all(req.params.ownId) }));
app.post('/api/chat/auto-replies', (req, res) => {
  const { ownId, keyword, response, scope } = req.body;
  const r = stmts.addAutoReply.run(ownId, keyword, response, scope || 'all');
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.delete('/api/chat/auto-replies/:id', (req, res) => { stmts.delAutoReply.run(req.params.id); res.json({ ok: true }); });

app.post('/api/chat/labels/:ownId/:threadId', (req, res) => {
  stmts.setLabels.run(JSON.stringify(req.body.labels || []), req.params.ownId, req.params.threadId);
  res.json({ ok: true });
});

app.post('/api/chat/broadcast', (req, res) => {
  const { ownId, content, targets, delayMs } = req.body;
  if (!Array.isArray(targets) || !targets.length) return res.json({ ok: false, error: 'Cần danh sách targets' });
  const r = stmts.addBroadcast.run(ownId, content, JSON.stringify(targets), delayMs || 5000, targets.length);
  runBroadcast(r.lastInsertRowid);
  res.json({ ok: true, id: r.lastInsertRowid, total: targets.length });
});
app.get('/api/chat/broadcasts/:ownId', (req, res) => res.json({ ok: true, data: stmts.listBroadcasts.all(req.params.ownId) }));

async function runBroadcast(id) {
  const row = db.prepare('SELECT * FROM broadcasts WHERE id=?').get(id);
  if (!row) return;
  stmts.updateBroadcastProgress.run(0, 'running', id);
  const targets = JSON.parse(row.targets);
  let done = 0;
  for (const t of targets) {
    try {
      const tid = typeof t === 'string' ? t : t.threadId;
      const ttype = typeof t === 'string' ? ZM.ThreadType.User : (t.threadType ?? ZM.ThreadType.User);
      await ZM.sendMessage(row.ownId, tid, ttype, row.content);
    } catch (e) { console.warn('Broadcast send failed', e.message); }
    done++;
    stmts.updateBroadcastProgress.run(done, 'running', id);
    wsBroadcast({ kind: 'broadcast-progress', id, progress: done, total: row.total });
    const jitter = Math.floor(Math.random() * (row.delayMs * 0.4));
    await new Promise(r => setTimeout(r, row.delayMs + jitter));
  }
  stmts.updateBroadcastProgress.run(done, 'done', id);
  wsBroadcast({ kind: 'broadcast-done', id });
}

// Map<campaignId, true> để báo cancel cho task đang chạy
const cancelRequested = new Map();

async function runBulk(ownId, items, fn, delayCfg, onProgress, shouldCancel, opts = {}) {
  const [dMin, dMax] = Array.isArray(delayCfg) ? delayCfg : [delayCfg, Math.floor(delayCfg * 1.4)];
  let ok = 0, fail = 0; const errors = [];
  let cancelled = false;
  // Tracking delivery (chỉ khi có campaignId)
  const campId = opts.campaignId;
  const recordDelivery = (target, status, err) => {
    if (!campId) return;
    try {
      const key = typeof target === 'object' ? JSON.stringify(target) : String(target);
      stmts.recordCampaignDelivery.run(campId, key, status, err || null);
    } catch {}
  };

  // Auto-detect Zalo throttle: nếu N tin liên tiếp mất >threshold giây mỗi tin → đã bị throttle
  const SLOW_THRESHOLD_MS = opts.slowThreshold || 30000;  // 30s = chậm
  const SLOW_STREAK_MAX = opts.slowStreakMax || 3;        // 3 tin chậm liên tiếp → pause
  let slowStreak = 0;
  let throttleDetected = false;

  // Pause "ngẫu nhiên" mô phỏng người thật — đi đâu đó 1-3 phút
  const pauseEvery = parseInt(opts.pauseEvery || 0);     // sau N tin thì nghỉ dài
  const pauseDuration = parseInt(opts.pauseDurationMs || 0);

  for (let i = 0; i < items.length; i++) {
    if (shouldCancel && shouldCancel()) { cancelled = true; break; }

    const start = Date.now();
    let lastErr = null;
    // Timeout per send (default 60s) — tránh treo cả campaign nếu Zalo hang response
    const sendTimeout = opts.sendTimeoutMs || 60000;
    try {
      await Promise.race([
        fn(items[i], i),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout ${sendTimeout}ms`)), sendTimeout)),
      ]);
      ok++;
      recordDelivery(items[i], 'ok');
    } catch (e) {
      fail++; lastErr = e.message;
      errors.push({ item: items[i], err: e.message });
      recordDelivery(items[i], 'fail', e.message);
    }
    const elapsed = Date.now() - start;

    // Throttle detection — đo thời gian sendMessage trả về
    if (elapsed > SLOW_THRESHOLD_MS) {
      slowStreak++;
      console.log(`[runBulk] SLOW send: ${elapsed}ms (streak=${slowStreak}/${SLOW_STREAK_MAX})`);
      if (slowStreak >= SLOW_STREAK_MAX) {
        console.log(`[runBulk] THROTTLE DETECTED — pausing campaign`);
        throttleDetected = true;
        cancelled = true;  // dừng giống như cancel
        if (onProgress) onProgress({ done: i + 1, total: items.length, ok, fail, index: i, throttled: true });
        break;
      }
    } else {
      slowStreak = 0;  // reset streak nếu có 1 tin nhanh
    }

    if (onProgress) onProgress({ done: i + 1, total: items.length, ok, fail, index: i });

    // Random pause dài để mô phỏng "người thật" — sau mỗi N tin
    if (pauseEvery > 0 && pauseDuration > 0 && (i + 1) % pauseEvery === 0 && i < items.length - 1) {
      const jitter = Math.floor(pauseDuration * 0.5 + Math.random() * pauseDuration);
      console.log(`[runBulk] Human-like pause: ${jitter}ms after ${i + 1} sends`);
      const slices = Math.max(1, Math.ceil(jitter / 500));
      for (let s = 0; s < slices; s++) {
        if (shouldCancel && shouldCancel()) { cancelled = true; break; }
        await new Promise(r => setTimeout(r, Math.min(500, jitter - s * 500)));
      }
      if (cancelled) break;
    }

    // Delay thường giữa tin — random + thêm jitter để pattern khó detect
    const baseWait = dMin + Math.floor(Math.random() * Math.max(0, dMax - dMin));
    // 15% chance delay GẤP ĐÔI để pattern không đều
    const wait = Math.random() < 0.15 ? baseWait * 2 : baseWait;
    if (i < items.length - 1) {
      const slices = Math.max(1, Math.ceil(wait / 500));
      for (let s = 0; s < slices; s++) {
        if (shouldCancel && shouldCancel()) { cancelled = true; break; }
        await new Promise(r => setTimeout(r, Math.min(500, wait - s * 500)));
      }
      if (cancelled) break;
    }
  }
  return { ok, fail, errors, cancelled, throttleDetected };
}

// Pool emoji để insert ngẫu nhiên — đa dạng + tự nhiên
const RANDOM_EMOJIS = ['😊', '🙏', '✨', '🌟', '💫', '👋', '🤝', '💎', '🎯', '🚀', '⭐', '🔥', '💡', '👍', '🌸', '🌺', '☘️', '🎁', '💝', '🌈'];
// Variant ký tự để đánh lừa similarity hash của Zalo (zero-width space, en-space...)
const INVISIBLE_CHARS = ['​', '‌', ' ', ' '];

// Thêm zero-width characters ngẫu nhiên giữa từ — không thay đổi nội dung visual
function obfuscateText(text) {
  if (!text || text.length < 10) return text;
  const words = text.split(' ');
  if (words.length < 3) return text;
  // Insert 1-2 invisible chars vào 1-2 vị trí ngẫu nhiên
  const insertCount = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < insertCount; i++) {
    const pos = 1 + Math.floor(Math.random() * (words.length - 1));
    const inv = INVISIBLE_CHARS[Math.floor(Math.random() * INVISIBLE_CHARS.length)];
    words[pos] = inv + words[pos];
  }
  return words.join(' ');
}

// Wrap text với chào hỏi + emoji random để tạo biến thể tự nhiên
function addNaturalVariation(text, opts = {}) {
  if (!text) return '';
  const greetings = ['', 'Chào bạn,\n', 'Xin chào,\n', 'Hi bạn ơi,\n', 'Bạn ơi,\n', ''];
  const closings = ['', '\nCảm ơn bạn nhé.', '\nThân mến.', '\nMong nhận phản hồi.', '\nChúc bạn ngày tốt lành.', ''];

  let result = text;
  // 40% chance thêm greeting
  if (opts.naturalize !== false && Math.random() < 0.4) {
    result = greetings[Math.floor(Math.random() * greetings.length)] + result;
  }
  // 30% chance thêm closing
  if (opts.naturalize !== false && Math.random() < 0.3) {
    result = result + closings[Math.floor(Math.random() * closings.length)];
  }
  // 50% chance thêm emoji ở cuối nếu autoEmoji bật
  if (opts.autoEmoji && Math.random() < 0.5) {
    const numEmojis = 1 + Math.floor(Math.random() * 2);
    let emo = '';
    for (let i = 0; i < numEmojis; i++) {
      emo += RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)];
    }
    result = result + ' ' + emo;
  }
  return result;
}

function pickContent(params) {
  let text;
  if (Array.isArray(params?.dynamic) && params.dynamic.length) {
    text = params.dynamic[Math.floor(Math.random() * params.dynamic.length)];
  } else {
    text = params?.content || '';
  }
  // Áp dụng biến thể tự nhiên (greeting/closing random) + autoEmoji
  text = addNaturalVariation(text, { autoEmoji: params?.autoEmoji, naturalize: params?.naturalize !== false });
  // Obfuscate bằng zero-width chars để tránh content hash duplicate detection
  if (params?.obfuscate !== false) {
    text = obfuscateText(text);
  }
  return text;
}

app.post('/api/chat/bulk-action', async (req, res) => {
  const { ownId, action, targets, params } = req.body;
  if (!ownId || !action || !Array.isArray(targets) || !targets.length) return res.json({ ok: false, error: 'Thiếu tham số' });
  const delay = parseInt((params && params.delay) || 4000);
  const delayMax = parseInt((params && params.delayMax) || 0);
  const delayCfg = delayMax > delay ? [delay, delayMax] : delay;
  const taskId = 'task-' + Date.now().toString(36);
  res.json({ ok: true, taskId, total: targets.length });

  const progress = (p) => wsBroadcast({ kind: 'task-progress', taskId, ...p });

  try {
    let result;
    switch (action) {
      case 'msg-phone': {
        result = await runBulk(ownId, targets, async (phone) => {
          const u = await ZM.findUserByPhone(ownId, phone);
          const uid = u?.userId || u?.uid;
          if (!uid) throw new Error('Không tìm thấy user cho ' + phone);
          if (params?.autoFriend) { try { await ZM.sendFriendRequest(ownId, uid, 'Xin chào'); } catch {} }
          await ZM.sendMessage(ownId, uid, ZM.ThreadType.User, pickContent(params));
        }, delayCfg, progress);
        break;
      }
      case 'msg-friends':
      case 'msg-group-mem':
      case 'msg-group-mem-friend': {
        // Tất cả 3 action này: targets là UID list (frontend đã extract members từ groups)
        result = await runBulk(ownId, targets, async (uid) => {
          await ZM.sendMessage(ownId, String(uid), ZM.ThreadType.User, params.content || '');
        }, delay, progress);
        break;
      }
      case 'friend-phone': {
        result = await runBulk(ownId, targets, async (phone) => {
          const u = await ZM.findUserByPhone(ownId, phone);
          const uid = u?.userId || u?.uid;
          if (!uid) throw new Error('Không có Zalo: ' + phone);
          await ZM.sendFriendRequest(ownId, uid, params.greeting);
        }, delay, progress);
        break;
      }
      case 'friend-group': {
        const members = await ZM.getGroupMembers(ownId, params.groupId);
        const memArr = (members || []).map(m => typeof m === 'string' ? m : (m.userId || m.uid)).filter(Boolean);
        result = await runBulk(ownId, memArr, async (uid) => {
          await ZM.sendFriendRequest(ownId, String(uid), params.greeting);
        }, delay, progress);
        break;
      }
      case 'friend-undo':
        result = await runBulk(ownId, targets, async (uid) => { await ZM.undoFriendRequest(ownId, String(uid)); }, delay, progress);
        break;
      case 'friend-remove':
        result = await runBulk(ownId, targets, async (uid) => { await ZM.removeFriend(ownId, String(uid)); }, delay, progress);
        break;
      case 'friend-accept':
        result = await runBulk(ownId, targets, async (uid) => { await ZM.acceptFriendRequest(ownId, String(uid)); }, delay, progress);
        break;
      case 'friend-reject':
        result = await runBulk(ownId, targets, async (uid) => { await ZM.rejectFriendRequest(ownId, String(uid)); }, delay, progress);
        break;
      case 'grp-invite-phone': {
        if (!params.groupId) throw new Error('Thiếu groupId');
        result = await runBulk(ownId, targets, async (phone) => {
          const u = await ZM.findUserByPhone(ownId, phone);
          const uid = u?.userId || u?.uid;
          if (!uid) throw new Error('Không có Zalo: ' + phone);
          await ZM.addUserToGroup(ownId, uid, params.groupId);
        }, delay, progress);
        break;
      }
      case 'grp-invite-friend':
        if (!params.groupId) throw new Error('Thiếu groupId');
        result = await runBulk(ownId, targets, async (uid) => { await ZM.addUserToGroup(ownId, String(uid), params.groupId); }, delay, progress);
        break;
      case 'grp-invite-other': {
        if (!params.groupId || !params.fromGroupId) throw new Error('Thiếu groupId / fromGroupId');
        const mems = await ZM.getGroupMembers(ownId, params.fromGroupId);
        const memArr = (mems || []).map(m => typeof m === 'string' ? m : (m.userId || m.uid)).filter(Boolean);
        result = await runBulk(ownId, memArr, async (uid) => { await ZM.addUserToGroup(ownId, String(uid), params.groupId); }, delay, progress);
        break;
      }
      case 'grp-leave':
        result = await runBulk(ownId, targets, async (gid) => {
          await ZM.leaveGroup(ownId, String(gid));
          try { db.prepare('DELETE FROM threads WHERE id=? AND ownId=?').run(String(gid), ownId); } catch {}
        }, delay, progress);
        break;
      case 'grp-msg':
        result = await runBulk(ownId, targets, async (gid) => { await ZM.sendMessage(ownId, String(gid), ZM.ThreadType.Group, params.content || ''); }, delay, progress);
        break;
      case 'grp-join':
        result = await runBulk(ownId, targets, async (link) => { await ZM.joinGroupByLink(ownId, link); }, delay, progress);
        break;
      default:
        wsBroadcast({ kind: 'task-done', taskId, error: 'Action không hỗ trợ: ' + action }); return;
    }
    wsBroadcast({ kind: 'task-done', taskId, ...result });
  } catch (e) {
    wsBroadcast({ kind: 'task-done', taskId, error: e.message });
  }
});

app.get('/api/chat/campaigns/:ownId', (req, res) => {
  const action = req.query.action || 'msg-phone';
  const list = stmts.listCampaigns.all(req.params.ownId, action);
  // Enrich với số tin THỰC SỰ đã gửi (từ campaign_deliveries) — chính xác hơn counter
  const enriched = list.map(c => {
    const stats = stmts.countCampaignDeliveries.get(c.id);
    return {
      ...c,
      delivered: stats?.delivered || 0,
      attemptedReal: stats?.total_attempted || 0,
    };
  });
  res.json({ ok: true, data: enriched });
});
app.get('/api/chat/campaigns/detail/:id', (req, res) => {
  const row = stmts.getCampaign.get(req.params.id);
  if (!row) return res.json({ ok: false, error: 'Không tìm thấy' });
  row.config = JSON.parse(row.config || '{}');
  row.targets = JSON.parse(row.targets || '[]');
  res.json({ ok: true, data: row });
});
app.post('/api/chat/campaigns', (req, res) => {
  const { ownId, action, name, config, targets } = req.body;
  if (!ownId || !action || !name) return res.json({ ok: false, error: 'Thiếu ownId/action/name' });
  const r = stmts.addCampaign.run(ownId, action, name, JSON.stringify(config || {}), JSON.stringify(targets || []), (targets || []).length);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.patch('/api/chat/campaigns/:id', (req, res) => {
  const { name, config, targets } = req.body;
  stmts.updateCampaign.run(name, JSON.stringify(config || {}), JSON.stringify(targets || []), (targets || []).length, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/chat/campaigns/:id', (req, res) => {
  const id = parseInt(req.params.id);
  cancelRequested.set(id, true);  // dừng task nếu đang chạy
  stmts.delCampaign.run(id);
  res.json({ ok: true });
});
app.post('/api/chat/campaigns/:id/stop', (req, res) => {
  const id = parseInt(req.params.id);
  const row = stmts.getCampaign.get(id);
  if (!row) return res.json({ ok: false, error: 'Không tìm thấy chiến dịch' });
  cancelRequested.set(id, true);
  // Nếu đang running thì sẽ tự update sang paused khi task react cancel. Nhưng update ngay để UI thấy.
  if (row.status === 'running') stmts.setCampaignStatus.run('paused', id);
  res.json({ ok: true, message: 'Đã yêu cầu dừng. Task sẽ dừng sau tin hiện tại.' });
});
app.post('/api/chat/campaigns/:id/reset', (req, res) => {
  const id = parseInt(req.params.id);
  cancelRequested.set(id, true);
  stmts.resetCampaignCursor.run(id);
  stmts.clearCampaignDeliveries.run(id);
  res.json({ ok: true });
});

// Stats thực tế (UIDs đã nhận tin chính xác)
app.get('/api/chat/campaigns/:id/deliveries', (req, res) => {
  const id = parseInt(req.params.id);
  const stats = stmts.countCampaignDeliveries.get(id);
  res.json({ ok: true, ...stats });
});

// Backfill từ messages table (cho campaign cũ chưa có record)
app.post('/api/chat/campaigns/:id/backfill-deliveries', (req, res) => {
  const id = parseInt(req.params.id);
  const camp = stmts.getCampaign.get(id);
  if (!camp) return res.json({ ok: false, error: 'Không tìm thấy campaign' });
  const config = JSON.parse(camp.config || '{}');
  const content = config.content || '';
  if (!content || content.length < 10) return res.json({ ok: false, error: 'Campaign không có content rõ ràng' });
  const pattern = '%' + content.slice(0, 20) + '%';
  const rows = db.prepare(`SELECT DISTINCT threadId FROM messages WHERE isSelf=1 AND ownId=? AND content LIKE ?`).all(camp.ownId, pattern);
  let added = 0;
  for (const r of rows) {
    try { stmts.recordCampaignDelivery.run(id, r.threadId, 'ok', null); added++; } catch {}
  }
  const stats = stmts.countCampaignDeliveries.get(id);
  res.json({ ok: true, added, ...stats });
});

app.post('/api/chat/campaigns/:id/run', async (req, res) => {
  const row = stmts.getCampaign.get(req.params.id);
  if (!row) return res.json({ ok: false, error: 'Không tìm thấy chiến dịch' });
  if (row.status === 'running') return res.json({ ok: false, error: 'Chiến dịch đang chạy' });
  const config = JSON.parse(row.config || '{}');
  const targets = JSON.parse(row.targets || '[]');
  if (!targets.length) return res.json({ ok: false, error: 'Chiến dịch chưa có mục tiêu' });
  const taskId = 'task-' + Date.now().toString(36);
  // Reset cancel flag (nếu trước đó đã stop)
  cancelRequested.delete(row.id);
  // Resume: dùng cursor + success/fail có sẵn. Reset=true thì bắt đầu lại từ đầu.
  if (req.body?.reset) {
    stmts.resetCampaignCursor.run(row.id);
    row.cursor = 0; row.success = 0; row.fail = 0;
  }
  // Update status running, GIỮ NGUYÊN success/fail/cursor để resume
  stmts.setCampaignProgress.run(row.success || 0, row.fail || 0, row.cursor || 0, 'running', taskId, row.id);
  res.json({ ok: true, taskId, total: targets.length, resumeFrom: row.cursor || 0 });
  runCampaignTask(row, config, targets, taskId).catch(e => {
    stmts.setCampaignStats.run(row.success, row.fail, 'failed', taskId, row.id);
    wsBroadcast({ kind: 'task-done', taskId, error: e.message, campaignId: row.id });
  });
});

async function runCampaignTask(camp, config, targets, taskId) {
  // msg-group-mem, msg-group-mem-friend, msg-group-other đều có targets là UID list → xử lý như msg-friends
  const action = (camp.action === 'msg-group-mem' || camp.action === 'msg-group-mem-friend' || camp.action === 'msg-group-other') ? 'msg-friends' : camp.action;
  const params = config;
  const delay = parseInt(params.delay || 4000);
  const delayMax = parseInt(params.delayMax || 0);
  const delayCfg = delayMax > delay ? [delay, delayMax] : delay;

  // RESUME: skip những target đã xử lý trước đó (cursor)
  const startCursor = camp.cursor || 0;
  const baseOk = camp.success || 0;
  const baseFail = camp.fail || 0;
  const remaining = targets.slice(startCursor);

  console.log(`[campaign ${camp.id}] start: cursor=${startCursor} baseOk=${baseOk} baseFail=${baseFail} remaining=${remaining.length}`);

  // Lưu progress + cursor mỗi lần gửi
  const progress = (p) => {
    // p.ok/p.fail là local của runBulk (chỉ tính phần remaining). Cộng dồn với base trước đó.
    const totalOk = baseOk + p.ok;
    const totalFail = baseFail + p.fail;
    const absCursor = startCursor + (p.index ?? -1) + 1;
    stmts.setCampaignProgress.run(totalOk, totalFail, absCursor, 'running', taskId, camp.id);
    wsBroadcast({ kind: 'task-progress', taskId, campaignId: camp.id, ok: totalOk, fail: totalFail, done: absCursor, total: targets.length });
  };
  const shouldCancel = () => cancelRequested.get(camp.id) === true;

  // Anti-throttle opts truyền vào runBulk
  const bulkOpts = {
    slowThreshold: 30000,            // 30s response = chậm
    slowStreakMax: 3,                // 3 tin chậm liên tiếp → tự pause
    pauseEvery: parseInt(params.pauseAfter || 0),       // sau N tin nghỉ dài
    pauseDurationMs: parseInt(params.pauseSec || 0) * 1000,
    campaignId: camp.id,             // để record delivery vào DB
  };

  // Skip UIDs đã gửi thành công cho campaign này (tránh re-send)
  const alreadySent = new Set(stmts.getSentUidsForCampaign.all(camp.id).map(r => r.threadId));
  const remainingFiltered = remaining.filter(uid => !alreadySent.has(String(uid)));
  if (remaining.length !== remainingFiltered.length) {
    console.log(`[campaign ${camp.id}] skipped ${remaining.length - remainingFiltered.length} already-sent UIDs from delivery log`);
  }
  let result;
  let quotaLimited = false;
  if (action === 'msg-phone') {
    result = await runBulk(camp.ownId, remainingFiltered, async (phone) => {
      const u = await ZM.findUserByPhone(camp.ownId, phone);
      const uid = u?.userId || u?.uid;
      if (!uid) throw new Error('Không có Zalo: ' + phone);
      if (params.autoFriend) { try { await ZM.sendFriendRequest(camp.ownId, uid, 'Xin chào'); } catch {} }
      await ZM.sendMessage(camp.ownId, uid, ZM.ThreadType.User, pickContent(params));
    }, delayCfg, progress, shouldCancel, bulkOpts);
  } else if (action === 'msg-friends' || action === 'msg-group-mem-friend') {
    result = await runBulk(camp.ownId, remainingFiltered, async (uid) => {
      await ZM.sendMessage(camp.ownId, String(uid), ZM.ThreadType.User, pickContent(params));
    }, delayCfg, progress, shouldCancel, bulkOpts);
  } else if (action === 'friend-phone') {
    result = await runBulk(camp.ownId, remainingFiltered, async (phone) => {
      const u = await ZM.findUserByPhone(camp.ownId, phone);
      const uid = u?.userId || u?.uid;
      if (!uid) throw new Error('Không có Zalo: ' + phone);
      await ZM.sendFriendRequest(camp.ownId, uid, pickContent(params) || 'Xin chào, mình muốn kết bạn');
    }, delayCfg, progress, shouldCancel, bulkOpts);
  } else if (action === 'friend-group' || action === 'friend-group-other' || action === 'friend-backup') {
    result = await runBulk(camp.ownId, remainingFiltered, async (uid) => {
      await ZM.sendFriendRequest(camp.ownId, String(uid), pickContent(params) || 'Xin chào, mình muốn kết bạn');
    }, delayCfg, progress, shouldCancel, bulkOpts);
  } else if (action === 'friend-undo') {
    result = await runBulk(camp.ownId, remainingFiltered, async (uid) => {
      await ZM.undoFriendRequest(camp.ownId, String(uid));
    }, delayCfg, progress, shouldCancel, bulkOpts);
  } else if (action === 'friend-remove') {
    result = await runBulk(camp.ownId, remainingFiltered, async (uid) => {
      await ZM.removeFriend(camp.ownId, String(uid));
    }, delayCfg, progress, shouldCancel, bulkOpts);
  } else if (action === 'grp-join') {
    result = await runBulk(camp.ownId, remainingFiltered, async (link) => {
      await ZM.joinGroupByLink(camp.ownId, link);
    }, delayCfg, progress, shouldCancel, bulkOpts);
  } else if (action === 'grp-msg') {
    result = await runBulk(camp.ownId, remainingFiltered, async (gid) => {
      await ZM.sendMessage(camp.ownId, String(gid), ZM.ThreadType.Group, pickContent(params));
    }, delayCfg, progress, shouldCancel, bulkOpts);
  } else if (action === 'grp-invite-phone') {
    const groupIds = params.groupIds || [];
    if (!groupIds.length) throw new Error('Chưa chọn nhóm');
    const tuples = [];
    for (const phone of remainingFiltered) for (const gid of groupIds) tuples.push({ phone, gid });
    result = await runBulk(camp.ownId, tuples, async ({ phone, gid }) => {
      const u = await ZM.findUserByPhone(camp.ownId, phone);
      const uid = u?.userId || u?.uid;
      if (!uid) throw new Error('Không có Zalo: ' + phone);
      await ZM.addUserToGroup(camp.ownId, uid, gid);
    }, delayCfg, progress, shouldCancel, bulkOpts);
  } else if (action === 'grp-invite-friend' || action === 'grp-invite-other') {
    const groupIds = params.groupIds || [];
    if (!groupIds.length) throw new Error('Chưa chọn nhóm đích');
    const tuples = [];
    for (const uid of remainingFiltered) for (const gid of groupIds) tuples.push({ uid, gid });
    result = await runBulk(camp.ownId, tuples, async ({ uid, gid }) => {
      await ZM.addUserToGroup(camp.ownId, String(uid), gid);
    }, delayCfg, progress, shouldCancel, bulkOpts);
  } else if (action === 'grp-leave') {
    let leaveTargets = remainingFiltered;
    const quota = Math.max(0, parseInt(params.quota || 0));
    if (quota > 0) {
      const quotaPer = Math.max(1, parseInt(params.quotaPer || 1));
      const periodSeconds = quotaPer * (params.quotaUnit === 'hour' ? 3600 : 86400);
      const since = Math.floor(Date.now() / 1000) - periodSeconds;
      const used = stmts.countCampaignDeliveriesSince.get(camp.id, since)?.total_attempted || 0;
      const allowance = Math.max(0, quota - used);
      if (allowance < leaveTargets.length) {
        leaveTargets = leaveTargets.slice(0, allowance);
        quotaLimited = true;
      }
    }
    result = await runBulk(camp.ownId, leaveTargets, async (gid) => {
      await ZM.leaveGroup(camp.ownId, String(gid));
      try { db.prepare('DELETE FROM threads WHERE id=? AND ownId=?').run(String(gid), camp.ownId); } catch {}
    }, delayCfg, progress, shouldCancel, bulkOpts);
  }

  // Phân biệt: user cancel / throttle auto-detect / completed
  let finalStatus;
  if (result.throttleDetected) finalStatus = 'throttled';
  else if (result.cancelled) finalStatus = 'paused';
  else if (quotaLimited) finalStatus = 'paused';
  else finalStatus = 'done';

  const totalOk = baseOk + result.ok;
  const totalFail = baseFail + result.fail;
  const finalCursor = (result.cancelled || result.throttleDetected || quotaLimited) ? (startCursor + result.ok + result.fail) : targets.length;
  stmts.setCampaignProgress.run(totalOk, totalFail, finalCursor, finalStatus, taskId, camp.id);
  cancelRequested.delete(camp.id);
  console.log(`[campaign ${camp.id}] ${finalStatus}: ok=${totalOk} fail=${totalFail} cursor=${finalCursor}/${targets.length}${result.throttleDetected ? ' [AUTO-PAUSE: THROTTLE]' : ''}`);
  wsBroadcast({ kind: 'task-done', taskId, campaignId: camp.id, ok: totalOk, fail: totalFail, cancelled: result.cancelled, throttled: result.throttleDetected, quotaLimited, cursor: finalCursor, total: targets.length });
}

app.get('/api/chat/all-friends/:ownId', async (req, res) => {
  try { res.json({ ok: true, data: await ZM.getAllFriends(req.params.ownId) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// Thống kê tương tác per group (threadType=1) từ DB messages
app.get('/api/groups/interaction-stats/:ownId', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT threadId, COUNT(*) AS msgCount, MAX(ts) AS lastTs
      FROM messages WHERE ownId=? AND threadType=1
      GROUP BY threadId
    `).all(req.params.ownId);
    const map = {};
    for (const r of rows) map[r.threadId] = r;
    res.json({ ok: true, data: map });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Thống kê tương tác per friend (msgCount, lastTs, send/recv) từ DB messages
app.get('/api/friends/interaction-stats/:ownId', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT threadId, COUNT(*) AS msgCount, MAX(ts) AS lastTs, MIN(ts) AS firstTs,
             SUM(CASE WHEN isSelf=0 THEN 1 ELSE 0 END) AS recvCount,
             SUM(CASE WHEN isSelf=1 THEN 1 ELSE 0 END) AS sentCount
      FROM messages WHERE ownId=? AND threadType=0
      GROUP BY threadId
    `).all(req.params.ownId);
    const map = {};
    for (const r of rows) map[r.threadId] = r;
    res.json({ ok: true, data: map });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/chat/all-groups/:ownId', async (req, res) => {
  const ownId = req.params.ownId;
  try {
    let rows = db.prepare("SELECT id, name, avatar, memberCount FROM threads WHERE ownId=? AND type=1 ORDER BY name COLLATE NOCASE").all(ownId);
    if (!rows.length) {
      const all = await ZM.getAllGroups(ownId);
      const ids = Object.keys(all?.gridVerMap || {});
      const s = ZM.getSession(ownId);
      if (s && ids.length) {
        for (let i = 0; i < ids.length; i += 30) {
          const batch = ids.slice(i, i + 30);
          try {
            const info = await s.api.getGroupInfo(batch);
            const gmap = info?.gridInfoMap || {};
            for (const gid of Object.keys(gmap)) {
              const g = gmap[gid];
              const mc = g.totalMember || (g.memVerList?.length) || 0;
              stmts.upsertThread.run(String(gid), ownId, ZM.ThreadType.Group, g.name || g.groupName || ('Nhóm ' + gid.slice(-6)), g.avt || '', '', 0);
              try { db.prepare('UPDATE threads SET memberCount=? WHERE id=? AND ownId=?').run(mc, String(gid), ownId); } catch {}
            }
          } catch {}
        }
        rows = db.prepare("SELECT id, name, avatar, memberCount FROM threads WHERE ownId=? AND type=1 ORDER BY name COLLATE NOCASE").all(ownId);
      }
    }
    res.json({ ok: true, data: rows.map(r => ({ id: r.id, name: r.name || ('Nhóm ' + r.id.slice(-6)), avatar: r.avatar || '', memberCount: r.memberCount || 0 })) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/chat/group-members/:ownId/:groupId', async (req, res) => {
  try { res.json({ ok: true, data: await ZM.getGroupMembers(req.params.ownId, req.params.groupId) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/chat/group-link-members', async (req, res) => {
  const { ownId, link } = req.body;
  if (!ownId || !link) return res.json({ ok: false, error: 'Thiếu ownId hoặc link' });
  try { res.json({ ok: true, data: await ZM.getMembersFromLink(ownId, link, 20) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/chat/received-requests/:ownId', async (req, res) => {
  try { res.json({ ok: true, data: await ZM.getReceivedRequests(req.params.ownId) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/chat/sent-requests/:ownId', async (req, res) => {
  try { res.json({ ok: true, data: await ZM.getSentRequests(req.params.ownId) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/chat/backup-friends/:ownId', async (req, res) => {
  try {
    const friends = await ZM.getAllFriends(req.params.ownId);
    const rows = [['userId', 'displayName', 'zaloName', 'gender', 'phoneNumber', 'avatar']];
    for (const f of (friends || [])) {
      rows.push([f.userId || f.uid || '', f.displayName || '', f.zaloName || '', f.gender || '', f.phoneNumber || '', f.avatar || '']);
    }
    const csv = rows.map(r => r.map(v => '"' + String(v || '').replace(/"/g, '""') + '"').join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="friends-${req.params.ownId}-${Date.now()}.csv"`);
    res.send('﻿' + csv);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/chat/stickers/:ownId', async (req, res) => {
  try { res.json({ ok: true, data: await ZM.getStickersBy(req.params.ownId, req.query.q || ':)') }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/chat/sticker-detail/:ownId', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  try { res.json({ ok: true, data: await ZM.getStickerDetail(req.params.ownId, ids) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/chat/send-sticker', async (req, res) => {
  const { ownId, threadId, threadType, stickerId, sticker } = req.body;
  if (!ownId || !threadId) return res.json({ ok: false, error: 'Thiếu tham số' });
  const stickerObj = sticker && sticker.id ? sticker : (stickerId ? { id: parseInt(stickerId), cateId: 0, type: 7 } : null);
  if (!stickerObj) return res.json({ ok: false, error: 'Thiếu sticker' });
  try { res.json({ ok: true, data: await ZM.sendSticker(ownId, threadId, parseInt(threadType) || 0, stickerObj) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

setInterval(async () => {
  if (license.isEnforced()) {
    const status = await license.getStatus({ refresh: false }).catch(() => ({ active: false }));
    if (!status.active) return;
  }
  try {
    const due = stmts.pendingScheduled.all(Math.floor(Date.now() / 1000));
    for (const item of due) {
      ZM.sendMessage(item.ownId, item.threadId, item.threadType, item.content)
        .then(() => stmts.updateScheduled.run('sent', item.id))
        .catch(() => stmts.updateScheduled.run('failed', item.id));
    }
  } catch (e) { console.error('scheduler error', e); }
}, 30000);

async function startZaloRuntime(reason = 'startup') {
  if (license.isEnforced()) {
    const status = await license.getStatus({ refresh: false }).catch(e => ({ active: false, error: e.message }));
    if (!status.active) {
      console.warn(`[license] inactive; skip auto-reconnect (${status.reason || status.error || reason})`);
      return;
    }
  }
  ZM.autoReconnectAll().catch(e => console.warn('Auto-reconnect error:', e.message));
}

license.setOnActivated(() => startZaloRuntime('license-activated'));
startZaloRuntime();

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api') || req.path.includes('.')) return next();
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

server.listen(PORT, HOST || undefined, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`OMNI AI MARKETING Web UI: http://${HOST || 'localhost'}:${port}`);
});
