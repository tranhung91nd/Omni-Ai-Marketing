const { Zalo, ThreadType, LoginQRCallbackEventType } = require('zca-js');
const { imageSize } = require('image-size');
const fs = require('node:fs');
const { db, stmts } = require('./db');

const sessions = new Map();
let broadcastFn = () => {};
let sendGuardFn = async () => true;

function setBroadcaster(fn) { broadcastFn = fn; }
function setSendGuard(fn) { sendGuardFn = typeof fn === 'function' ? fn : async () => true; }

async function canSendByGuard() {
  try { return await sendGuardFn(); }
  catch (e) {
    console.warn('[send-guard]', e.message);
    return false;
  }
}

async function imageMetadataGetter(filePath) {
  const data = await fs.promises.readFile(filePath);
  const { width, height } = imageSize(data);
  return { width, height, size: data.length };
}

const ZALO_OPTIONS = { selfListen: true, checkUpdate: false, imageMetadataGetter };

async function startQRLogin(name, proxy, onQR, onComplete, onError) {
  const zalo = new Zalo(ZALO_OPTIONS);
  try {
    const api = await zalo.loginQR(
      { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', language: 'vi' },
      (event) => {
        if (!event) return;
        if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
          const raw = event.data.image;
          const dataUrl = typeof raw === 'string' && raw.startsWith('data:') ? raw
            : Buffer.isBuffer(raw) ? `data:image/png;base64,${raw.toString('base64')}`
            : `data:image/png;base64,${raw}`;
          onQR && onQR(dataUrl);
        } else if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
          onQR && onQR(null, 'scanned', event.data);
        } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
          onError && onError(new Error('QR đã hết hạn'));
        } else if (event.type === LoginQRCallbackEventType.QRCodeDeclined) {
          onError && onError(new Error('Người dùng từ chối'));
        }
      }
    );

    const ctx = api.getContext();
    const cookieJar = api.getCookie();
    const cookies = JSON.stringify(cookieJar);
    const ownId = api.getOwnId();

    stmts.upsertAccount.run(ownId, name || event?.data?.display_name || '', cookies, ctx.imei, ctx.userAgent, ctx.language || 'vi', proxy || null);
    attachSession(ownId, api);
    onComplete && onComplete(ownId);
    return api;
  } catch (e) {
    onError && onError(e);
    throw e;
  }
}

async function loginFromStored(ownId) {
  if (sessions.has(ownId)) return sessions.get(ownId).api;
  const row = stmts.getAccount.get(ownId);
  if (!row) throw new Error('Account not found: ' + ownId);
  const zalo = new Zalo(ZALO_OPTIONS);
  const cookies = JSON.parse(row.cookies);
  const api = await zalo.login({
    cookie: cookies,
    imei: row.imei,
    userAgent: row.userAgent,
    language: row.language || 'vi',
    ...(row.proxy ? { proxy: row.proxy } : {}),
  });
  attachSession(ownId, api);
  return api;
}

function friendlyPreview(rawContent, msgType) {
  if (typeof rawContent === 'string') return rawContent;
  if (!rawContent || typeof rawContent !== 'object') return '';
  let params = rawContent.params;
  if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
  const action = rawContent.action || '';
  if (action.includes('calltime') || action.includes('calldate')) return '📞 Cuộc gọi';
  if (params && (params.video_width || params.video_height)) return '🎬 Video';
  if (rawContent.catId !== undefined && (rawContent.stickerId !== undefined || rawContent.id !== undefined)) return '🎯 Sticker';
  if (rawContent.href && /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(rawContent.href)) return '🖼️ Hình ảnh';
  if (rawContent.fileExt === 'm4a' || rawContent.fileExt === 'mp3') return '🎤 Voice';
  if (rawContent.fileName) return '📎 ' + rawContent.fileName;
  if (action.includes('contact') || (action.includes('recommen') && (rawContent.uid || rawContent.phoneNumber))) return '👤 Danh thiếp';
  if (rawContent.title && rawContent.title !== 'sendBubbleMessage') return '🔗 ' + rawContent.title;
  if (msgType === 7 || msgType === 30) return '🎯 Sticker';
  if (msgType === 19 || msgType === 5) return '🖼️ Hình ảnh';
  if (msgType === 6) return '📎 File';
  return '[Tin nhắn]';
}

function persistMessage(ownId, msg, opts = {}) {
  const isSelf = msg.isSelf;
  const threadId = msg.threadId;
  const threadType = msg.type;
  const fromId = msg.data?.uidFrom || msg.data?.idTo || '';
  const fromName = msg.data?.dName || '';
  const rawContent = msg.data?.content;
  const isStr = typeof rawContent === 'string';
  const content = isStr ? rawContent : JSON.stringify(rawContent || '');
  const preview = friendlyPreview(rawContent, msg.data?.msgType);
  const ts = parseInt(msg.data?.ts || Date.now());
  const msgId = msg.data?.msgId || msg.data?.cliMsgId || (ts + '-' + Math.random().toString(36).slice(2, 8));
  stmts.insertMsg.run(String(msgId), ownId, String(threadId), threadType, String(fromId), fromName, content, msg.data?.msgType || 0, JSON.stringify(msg.data || {}), ts, isSelf ? 1 : 0);
  if (!opts.skipThreadUpdate) {
    const fallbackName = (threadType === 0 && !isSelf && fromName) ? fromName : null;
    stmts.upsertThread.run(String(threadId), ownId, threadType, fallbackName, null, preview.slice(0, 100), ts);
    if (!isSelf && !opts.skipUnread) stmts.incUnread.run(ownId, String(threadId));
  }
  return { msgId: String(msgId), threadId: String(threadId), threadType, fromId: String(fromId), fromName, content, preview, ts, isSelf, type: msg.data?.msgType || 0 };
}

function attachSession(ownId, api) {
  if (sessions.has(ownId)) {
    try { sessions.get(ownId).api.listener.stop(); } catch {}
  }
  api.listener.on('message', async (msg) => {
    try {
      const p = persistMessage(ownId, msg);
      console.log(`[msg] ${ownId} ${p.threadId} from=${p.fromName || p.fromId} isSelf=${p.isSelf} content=${(p.content || '').slice(0, 50)}`);
      broadcastFn({ kind: 'message', ownId, threadId: p.threadId, threadType: p.threadType, msgId: p.msgId, fromId: p.fromId, fromName: p.fromName, content: p.content, preview: p.preview, ts: p.ts, isSelf: !!p.isSelf, type: p.type, meta: JSON.stringify(msg.data || {}) });
      if (!p.isSelf) await maybeAutoReply(ownId, api, msg, p.threadType, p.content, p.threadId);
    } catch (e) { console.error('message handler error', e); }
  });

  api.listener.on('typing', (ev) => {
    try {
      const isGroup = ev.type === ThreadType.Group;
      broadcastFn({ kind: 'typing', ownId, threadId: ev.threadId, threadType: ev.type, uid: ev.data?.uid, ts: Date.now(), isGroup });
    } catch {}
  });

  api.listener.on('error', (e) => console.error(`[listener] ${ownId} error:`, e?.message || e));
  api.listener.on('closed', () => {
    console.log(`[listener] ${ownId} closed`);
    if (sessions.get(ownId)?.api === api) {
      sessions.delete(ownId);
      broadcastFn({ kind: 'disconnected', ownId });
    }
  });
  api.listener.on('connected', () => console.log(`[listener] ${ownId} connected ✓`));
  api.listener.on('disconnected', (code, reason) => console.log(`[listener] ${ownId} disconnected code=${code} reason=${reason}`));
  sessions.set(ownId, { api, startedAt: Date.now() });
  api.listener.start();
  console.log(`[listener] ${ownId} start() called`);
}

async function maybeAutoReply(ownId, api, msg, threadType, content, threadId) {
  if (!(await canSendByGuard())) {
    console.log(`[auto-reply] skip ${threadId}: send guard blocked`);
    return;
  }

  // Per-thread auto-reply (ưu tiên cao hơn keyword global)
  const handled = await maybeAutoReplyThread(ownId, api, msg, threadType, content, threadId);
  if (handled) return;

  // Nhóm bắt buộc cấu hình riêng có guard; không cho rule global gửi ngoài ý muốn.
  if (threadType === ThreadType.Group) return;

  // Fallback: keyword global cũ, chỉ áp dụng chat cá nhân.
  const rules = stmts.enabledAutoReplies.all(ownId);
  if (!rules || !rules.length) return;
  const c = (content || '').toLowerCase();
  for (const r of rules) {
    const kw = (r.keyword || '').toLowerCase();
    if (!kw) continue;
    if (r.scope === 'user' && threadType !== ThreadType.User) continue;
    if (r.scope === 'group' && threadType !== ThreadType.Group) continue;
    if (c.includes(kw)) {
      try { await api.sendMessage({ msg: r.response }, threadId, threadType); } catch {}
      break;
    }
  }
}

// AI caller injection — server.js gọi setAiCaller để inject hàm gọi Claude
let aiCallerFn = null;
function setAiCaller(fn) { aiCallerFn = fn; }

// In-memory state để gom burst tin và phân biệt AI-sent vs user-sent.
// Key phải gồm ownId vì cùng một nhóm có thể xuất hiện ở nhiều tài khoản Zalo.
const autoReplyState = new Map();

function autoReplyStateKey(ownId, threadId) {
  return `${String(ownId)}:${String(threadId)}`;
}

function hasGuardedGroupReply(setting, threadType = Number(setting?.threadType)) {
  if (!setting || Number(threadType) !== ThreadType.Group) return true;
  if (Number(setting.reply_all_in_group) === 1) return true;
  if (Number(setting.only_when_mentioned) === 1) return true;
  try {
    const allowed = JSON.parse(setting.allowed_users || '[]');
    return Array.isArray(allowed) && allowed.length > 0;
  } catch {
    return false;
  }
}

function finishQueuedReply(key, job) {
  const state = autoReplyState.get(key);
  if (!state) return;
  state.processing = false;
  if (state.queued === job) state.queued = null;
  if (!state.pendingTimer && !state.queued) autoReplyState.delete(key);
  else autoReplyState.set(key, state);
}

function scheduleAutoReply(job, delayMs) {
  const key = autoReplyStateKey(job.ownId, job.threadId);
  const state = autoReplyState.get(key) || {};
  if (state.pendingTimer) clearTimeout(state.pendingTimer);
  state.queued = job;
  state.pendingTimer = setTimeout(() => flushQueuedAutoReply(key), delayMs);
  autoReplyState.set(key, state);
  console.log(`[auto-reply] ${job.threadId}: queued latest message, flush in ${Math.round(delayMs / 1000)}s`);
}

async function flushQueuedAutoReply(key) {
  const state = autoReplyState.get(key);
  if (!state || !state.queued) return;
  if (state.processing) {
    state.pendingTimer = setTimeout(() => flushQueuedAutoReply(key), 250);
    autoReplyState.set(key, state);
    return;
  }

  const job = state.queued;
  state.pendingTimer = null;
  state.processing = true;
  autoReplyState.set(key, state);

  if (!(await canSendByGuard())) {
    console.log(`[auto-reply] skip ${job.threadId}: send guard blocked`);
    finishQueuedReply(key, job);
    return;
  }

  let setting = stmts.getAutoReplyThread.get(job.ownId, String(job.threadId));
  if (!setting || !setting.enabled || !hasGuardedGroupReply(setting, job.threadType)) {
    finishQueuedReply(key, job);
    return;
  }

  // Nếu quản trị viên trả lời tay trong lúc AI đang chờ, huỷ lượt tự động.
  const lastSelf = stmts.lastSelfMsgTs.get(job.ownId, String(job.threadId));
  if (lastSelf && Number(lastSelf.ts) > job.triggerTs) {
    console.log(`[auto-reply] skip ${job.threadId}: user replied while queued`);
    finishQueuedReply(key, job);
    return;
  }

  let reply = '';
  try {
    if (setting.mode === 'static') {
      reply = (setting.static_reply || '').trim();
    } else if (setting.mode === 'ai') {
      if (!aiCallerFn) {
        console.warn('[auto-reply] aiCallerFn not set');
        finishQueuedReply(key, job);
        return;
      }
      reply = await aiCallerFn({
        ownId: job.ownId,
        threadId: job.threadId,
        threadType: job.threadType,
        triggerContent: job.content || '',
        triggerFromName: job.msg.data?.dName || '',
        triggerMsgType: job.msg.data?.msgType || 0,
        triggerRawContent: job.msg.data?.content,
      });
      reply = (reply || '').trim();
    }
  } catch (e) {
    console.warn('[auto-reply] generate failed', e.message);
    finishQueuedReply(key, job);
    return;
  }

  const latest = autoReplyState.get(key);
  if (!latest || latest.queued !== job) {
    // Có tin mới đến trong lúc AI sinh nội dung: bỏ câu cũ, reply sẽ dùng tin mới nhất.
    if (latest) {
      if (latest.pendingTimer) clearTimeout(latest.pendingTimer);
      latest.processing = false;
      latest.pendingTimer = setTimeout(() => flushQueuedAutoReply(key), 0);
      autoReplyState.set(key, latest);
    }
    console.log(`[auto-reply] discard stale reply for ${job.threadId}: newer message queued`);
    return;
  }
  if (!reply) {
    console.log(`[auto-reply] skip ${job.threadId}: empty reply from generator`);
    finishQueuedReply(key, job);
    return;
  }

  setting = stmts.getAutoReplyThread.get(job.ownId, String(job.threadId));
  const latestSelf = stmts.lastSelfMsgTs.get(job.ownId, String(job.threadId));
  if (!setting || !setting.enabled || !hasGuardedGroupReply(setting, job.threadType)
    || (latestSelf && Number(latestSelf.ts) > job.triggerTs)) {
    console.log(`[auto-reply] skip ${job.threadId}: config changed or manual takeover before send`);
    finishQueuedReply(key, job);
    return;
  }

  if (!(await canSendByGuard())) {
    console.log(`[auto-reply] skip ${job.threadId}: send guard blocked before send`);
    finishQueuedReply(key, job);
    return;
  }

  try {
    await job.api.sendMessage({ msg: reply }, job.threadId, job.threadType);
    const current = autoReplyState.get(key) || {};
    current.lastAiSentMs = Date.now();
    autoReplyState.set(key, current);
    stmts.insertAutoReplyLog.run(job.ownId, String(job.threadId), job.msg.data?.msgId || '', reply, setting.mode);
    broadcastFn({ kind: 'auto-reply-sent', ownId: job.ownId, threadId: job.threadId, mode: setting.mode, content: reply.slice(0, 120) });
    console.log(`[auto-reply] sent to ${job.threadId}`);
  } catch (e) {
    console.warn(`[auto-reply] send failed for ${job.threadId}:`, e.message);
  } finally {
    finishQueuedReply(key, job);
  }
}

function isWithinWorkHours(start, end) {
  const now = new Date();
  const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  if (start === '00:00' && end === '23:59') return true; // 24/7
  if (start <= end) return hm >= start && hm <= end;
  return hm >= start || hm <= end; // qua đêm
}

function randDelayMs(minSec, maxSec) {
  const min = Math.max(0, minSec || 0);
  const max = Math.max(min, maxSec || min);
  return (min + Math.random() * (max - min)) * 1000;
}

const FRIEND_CACHE_TTL_MS = 15 * 60 * 1000;
const friendIdCache = new Map();

function friendCacheKey(ownId) {
  return `autoReply.friendIds.${ownId}`;
}

function normalizeFriendId(friend) {
  if (!friend) return '';
  return String(friend.userId || friend.uid || friend.id || '').trim();
}

function readFriendIdCache(ownId) {
  const key = friendCacheKey(ownId);
  const cached = friendIdCache.get(key);
  if (cached && Date.now() - cached.ts < FRIEND_CACHE_TTL_MS) return cached.ids;

  try {
    const raw = stmts.getSetting.get(key)?.value || '';
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.ts || !Array.isArray(parsed.ids)) return null;
    if (Date.now() - parsed.ts >= FRIEND_CACHE_TTL_MS) return null;
    const ids = new Set(parsed.ids.map(String).filter(Boolean));
    friendIdCache.set(key, { ts: parsed.ts, ids });
    return ids;
  } catch {
    return null;
  }
}

function writeFriendIdCache(ownId, ids) {
  const key = friendCacheKey(ownId);
  const payload = { ts: Date.now(), ids: Array.from(ids) };
  friendIdCache.set(key, { ts: payload.ts, ids });
  try { stmts.setSetting.run(key, JSON.stringify(payload)); } catch {}
}

async function getFriendIdSetForAutoReply(ownId, api) {
  const cached = readFriendIdCache(ownId);
  if (cached) return cached;

  if (!api || typeof api.getAllFriends !== 'function') throw new Error('Không có API danh sách bạn bè');
  const friends = await api.getAllFriends();
  const ids = new Set((Array.isArray(friends) ? friends : []).map(normalizeFriendId).filter(Boolean));
  writeFriendIdCache(ownId, ids);
  return ids;
}

async function isVerifiedStrangerThread(ownId, api, threadId) {
  const friendIds = await getFriendIdSetForAutoReply(ownId, api);
  return !friendIds.has(String(threadId));
}

async function maybeAutoReplyThread(ownId, api, msg, threadType, content, threadId) {
  let setting = stmts.getAutoReplyThread.get(ownId, String(threadId));
  // Tự động bật chỉ cho chat cá nhân mới chưa nằm trong danh sách bạn bè đã xác minh.
  if (!setting) {
    const strangerEnabled = stmts.getSetting.get('autoReply.autoEnableForStrangers')?.value === '1';
    if (strangerEnabled && threadType === ThreadType.User) {
      let isStranger = false;
      try {
        isStranger = await isVerifiedStrangerThread(ownId, api, threadId);
      } catch (e) {
        console.warn(`[auto-reply] skip ${threadId}: cannot verify stranger status:`, e.message);
        return false;
      }
      if (!isStranger) {
        console.log(`[auto-reply] skip ${threadId}: existing friend, not stranger`);
        return false;
      }

      let defaults = {};
      try { defaults = JSON.parse(stmts.getSetting.get('autoReply.defaults')?.value || '{}'); } catch {}
      const payload = {
        ownId, threadId: String(threadId), threadType,
        enabled: 1,
        mode: defaults.mode || 'ai',
        static_reply: defaults.static_reply || '',
        delay_min_sec: defaults.delay_min_sec ?? 15,
        delay_max_sec: defaults.delay_max_sec ?? 35,
        max_per_hour: defaults.max_per_hour ?? 6,
        work_start: defaults.work_start || '00:00',
        work_end: defaults.work_end || '23:59',
        only_first_msg: 0,
        first_n_msgs: defaults.first_n_msgs ?? 3,
        manual_cooldown_min: defaults.manual_cooldown_min ?? 10,
        allowed_users: null,
        only_when_mentioned: 0,
        reply_all_in_group: 0,
      };
      stmts.upsertAutoReplyThread.run(payload);
      // Auto-gán nhãn cho khách mới (nếu config strangerAutoLabel có giá trị)
      const strangerLabel = stmts.getSetting.get('autoReply.strangerAutoLabel')?.value || '';
      if (strangerLabel) {
        try {
          const t = stmts.getThread.get(ownId, String(threadId));
          let arr = [];
          try { arr = JSON.parse(t?.labels || '[]'); } catch {}
          if (!Array.isArray(arr)) arr = [];
          if (!arr.includes(strangerLabel)) {
            arr.push(strangerLabel);
            stmts.setLabels.run(JSON.stringify(arr), ownId, String(threadId));
            console.log(`[auto-reply] auto-tagged stranger ${threadId} with label "${strangerLabel}"`);
          }
        } catch (e) { console.warn('auto-tag stranger label err', e.message); }
      }
      setting = stmts.getAutoReplyThread.get(ownId, String(threadId));
      console.log(`[auto-reply] auto-enabled stranger thread ${threadId}`);
      broadcastFn({ kind: 'auto-reply-stranger-enabled', ownId, threadId });
    }
  }
  if (!setting || !setting.enabled) {
    console.log(`[auto-reply] skip ${threadId}: ${!setting ? 'no setting' : 'disabled'}`);
    return false;
  }

  if (threadType === ThreadType.Group && !hasGuardedGroupReply(setting, threadType)) {
    console.log(`[auto-reply] skip group ${threadId}: requires mention-only, allowed-users, or reply-all opt-in`);
    broadcastFn({
      kind: 'auto-reply-skipped',
      ownId, threadId,
      reason: 'group-guard',
      message: 'Nhóm đang bị chặn an toàn: hãy bật @mention, whitelist người gửi, hoặc reply toàn bộ tin nhắn trong nhóm.',
    });
    return true;
  }

  // Whitelist nhãn: AI chỉ rep thread có nhãn trong list (nếu list rỗng → áp tất cả)
  let requireLabels = [];
  try { requireLabels = JSON.parse(stmts.getSetting.get('autoReply.requireLabels')?.value || '[]'); } catch {}
  if (Array.isArray(requireLabels) && requireLabels.length > 0) {
    const t = stmts.getThread.get(ownId, String(threadId));
    let threadLabels = [];
    try { threadLabels = JSON.parse(t?.labels || '[]'); } catch {}
    const hasMatch = Array.isArray(threadLabels) && threadLabels.some(l => requireLabels.includes(l));
    if (!hasMatch) {
      console.log(`[auto-reply] skip ${threadId}: không có nhãn trong whitelist [${requireLabels.join(',')}]`);
      return true;
    }
  }
  console.log(`[auto-reply] check ${threadId}: enabled=${setting.enabled} mode=${setting.mode}`);

  const tKey = autoReplyStateKey(ownId, threadId);
  const state = autoReplyState.get(tKey) || {};

  // 1. Khung giờ
  if (!isWithinWorkHours(setting.work_start || '00:00', setting.work_end || '23:59')) return false;

  // 2. Cooldown sau khi USER vừa gửi tay (loại trừ tin AI tự gửi)
  const cooldownMin = setting.manual_cooldown_min || 0;
  if (cooldownMin > 0) {
    const last = stmts.lastSelfMsgTs.get(ownId, String(threadId));
    if (last) {
      // Check 2 nguồn: in-memory lastAiSentMs + DB auto_reply_log
      const lastAiMemMs = state.lastAiSentMs || 0;
      const isFromMem = lastAiMemMs > 0 && Math.abs(last.ts - lastAiMemMs) < 60000;
      // Check DB: có auto_reply_log entry gần với last.ts không?
      const sinceSec = Math.floor((last.ts - 60000) / 1000);
      const ar = db.prepare('SELECT ts FROM auto_reply_log WHERE ownId=? AND threadId=? AND ts >= ? ORDER BY ts DESC LIMIT 1').get(ownId, String(threadId), sinceSec);
      const isFromDB = !!ar;
      const isFromAI = isFromMem || isFromDB;
      if (!isFromAI && (Date.now() - last.ts) < cooldownMin * 60 * 1000) {
        console.log(`[auto-reply] skip ${threadId}: cooldown (user vừa gửi tay ${Math.round((Date.now() - last.ts) / 1000)}s trước)`);
        return true;
      }
      if (isFromAI) console.log(`[auto-reply] last self msg là AI tự gửi → bỏ qua cooldown`);
    }
  }

  // 3. Rate limit
  const since = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
  const cnt = stmts.countAutoReplyLastHour.get(ownId, String(threadId), since).c;
  const limit = setting.max_per_hour || 30;
  if (cnt >= limit) {
    console.log(`[auto-reply] skip ${threadId}: rate limit (${cnt}/${limit}/h)`);
    broadcastFn({
      kind: 'auto-reply-skipped',
      ownId, threadId,
      reason: 'rate-limit',
      message: `AI đã trả lời ${cnt}/${limit} tin trong 1 giờ qua — đụng giới hạn, tin mới của khách chưa được rep tự động. Bạn nên trả lời tay.`,
    });
    return true;
  }

  // 4. Chỉ trả lời N tin đầu (first_n_msgs). Legacy: only_first_msg=1 ↔ first_n_msgs=1
  const firstN = setting.first_n_msgs > 0
    ? setting.first_n_msgs
    : (setting.only_first_msg ? 1 : 0);
  if (firstN > 0) {
    const total = stmts.countAutoReplyTotalForThread.get(ownId, String(threadId)).c;
    if (total >= firstN) {
      console.log(`[auto-reply] skip ${threadId}: first_n_msgs limit (${total}/${firstN})`);
      return true;
    }
  }

  // 5. (Nhóm) filter user whitelist
  const replyAllInGroup = threadType === ThreadType.Group && Number(setting.reply_all_in_group) === 1;

  if (threadType === ThreadType.Group && !replyAllInGroup && setting.allowed_users) {
    try {
      const allowed = JSON.parse(setting.allowed_users);
      if (Array.isArray(allowed) && allowed.length > 0) {
        const fromUid = String(msg.data?.uidFrom || msg.data?.idTo || '');
        if (!allowed.includes(fromUid)) return true;
      }
    } catch {}
  }

  // 6. (Nhóm) chỉ khi mention
  if (threadType === ThreadType.Group && !replyAllInGroup && setting.only_when_mentioned) {
    const ownIdStr = String(ownId);
    const mentions = msg.data?.mentions || [];
    const wasMentioned = Array.isArray(mentions) && mentions.some(m => String(m.uid) === ownIdStr);
    if (!wasMentioned) return true;
  }

  // 7. Gom các tin đến sát nhau rồi chỉ sinh reply cho tin mới nhất của đúng thread.
  const delayMs = randDelayMs(setting.delay_min_sec, setting.delay_max_sec);
  scheduleAutoReply({
    ownId,
    api,
    msg,
    threadId: String(threadId),
    threadType,
    content,
    triggerTs: Number(msg.data?.ts || Date.now()),
  }, delayMs);

  return true;
}

function getSession(ownId) { return sessions.get(ownId); }
function listSessions() { return Array.from(sessions.keys()); }

function disconnectAccount(ownId) {
  const s = sessions.get(ownId);
  if (!s) return false;
  try { s.api.listener.stop(); } catch {}
  sessions.delete(ownId);
  broadcastFn({ kind: 'disconnected', ownId });
  return true;
}

// Cache UIDs đã enrich gần đây để tránh spam getUserInfo
const _enrichedUids = new Map();  // ownId -> Set of uids
const ENRICH_TTL_MS = 30 * 60 * 1000;  // 30 phút

async function enrichThreadName(ownId, uid) {
  if (!uid) return null;
  const cacheKey = `${ownId}:${uid}`;
  const cached = _enrichedUids.get(cacheKey);
  if (cached && Date.now() - cached < ENRICH_TTL_MS) return null;
  _enrichedUids.set(cacheKey, Date.now());

  const s = sessions.get(ownId);
  if (!s || typeof s.api.getUserInfo !== 'function') return null;
  try {
    const resp = await s.api.getUserInfo([uid]);
    const p = resp?.changed_profiles?.[uid];
    if (!p) return null;
    const name = p.displayName || p.zaloName || p.dName || '';
    const avatar = p.avatar || '';
    if (name) {
      try { require('./db').db.prepare('UPDATE threads SET name=?, avatar=? WHERE ownId=? AND id=?').run(name, avatar, ownId, uid); } catch {}
      return { name, avatar };
    }
  } catch (e) { /* silent */ }
  return null;
}

async function sendMessage(ownId, threadId, threadType, content, quote, mentions) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account not connected: ' + ownId);
  // Auto-enrich thread name nếu chưa có (chat 1-1) — chạy nền không block
  if (threadType === ThreadType.User) {
    enrichThreadName(ownId, String(threadId)).catch(() => {});
  }
  const payload = { msg: content };
  if (quote) payload.quote = quote;
  if (mentions && mentions.length) payload.mentions = mentions;
  return await s.api.sendMessage(payload, threadId, threadType);
}

async function sendImage(ownId, threadId, threadType, imagePaths) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account not connected: ' + ownId);
  return await s.api.sendMessage({ msg: '', attachments: imagePaths }, threadId, threadType);
}

async function getThreadInfo(ownId, threadId, threadType) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account not connected: ' + ownId);
  if (threadType === ThreadType.Group) {
    try { return await s.api.getGroupInfo(threadId); } catch { return null; }
  }
  try { return await s.api.getUserInfo(threadId); } catch { return null; }
}

async function getAllFriends(ownId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account not connected: ' + ownId);
  return await s.api.getAllFriends();
}

async function getAllGroups(ownId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account not connected: ' + ownId);
  return await s.api.getAllGroups();
}

async function autoReconnectAll() {
  const accs = stmts.listAccounts.all();
  for (const a of accs) {
    try { await loginFromStored(a.ownId); console.log('Reconnected', a.ownId); }
    catch (e) { console.warn('Reconnect failed for', a.ownId, e.message); }
  }
}

async function findUserByPhone(ownId, phone) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối: ' + ownId);
  try { return await s.api.findUser(phone); } catch (e) { return null; }
}
async function sendFriendRequest(ownId, userId, msg) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  try {
    return await s.api.sendFriendRequest(msg || 'Xin chào, mình muốn kết bạn', userId);
  } catch (e) {
    // Zalo error codes thường gặp: 225=đã là bạn, 215=bị block, 222=đã có lời mời từ user, 162=quota/spam
    const code = e?.code;
    const map = { 225: 'Đã là bạn', 215: 'Bị block hoặc user ẩn', 222: 'User đã gửi lời mời trước → đã accept', 162: 'Quá quota / nghi spam', 130: 'User không tồn tại / privacy', 8: 'User không cho phép kết bạn', 114: 'Tài khoản bị Zalo hạn chế chức năng kết bạn — verify SĐT hoặc dùng account khác' };
    const hint = code && map[code] ? ` — ${map[code]}` : '';
    const codeStr = code != null ? ` [code ${code}]` : '';
    const err = new Error(`${e.message}${codeStr}${hint}`);
    err.code = code;
    throw err;
  }
}
async function acceptFriendRequest(ownId, userId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  return await s.api.acceptFriendRequest(userId);
}
async function undoFriendRequest(ownId, userId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  if (typeof s.api.undoFriendRequest === 'function') return await s.api.undoFriendRequest(userId);
  if (typeof s.api.cancelSentFriendRequest === 'function') return await s.api.cancelSentFriendRequest(userId);
  throw new Error('Hàm undoFriendRequest không có trong zca-js version này');
}
async function rejectFriendRequest(ownId, userId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  if (typeof s.api.rejectFriendRequest === 'function') return await s.api.rejectFriendRequest(userId);
  throw new Error('Hàm rejectFriendRequest không có');
}
async function removeFriend(ownId, userId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  if (typeof s.api.removeFriend === 'function') return await s.api.removeFriend(userId);
  if (typeof s.api.deleteFriend === 'function') return await s.api.deleteFriend(userId);
  throw new Error('Hàm removeFriend không có');
}
async function addUserToGroup(ownId, userId, groupId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  return await s.api.addUserToGroup(userId, groupId);
}
async function removeUserFromGroup(ownId, userId, groupId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  return await s.api.removeUserFromGroup(userId, groupId);
}
async function getGroupMembers(ownId, groupId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  try {
    const info = await s.api.getGroupInfo(groupId);
    const rawIds = info?.gridInfoMap?.[groupId]?.memVerList || info?.memVerList || info?.memberIds || [];
    if (!rawIds.length) return [];
    const out = [];
    const cleanId = (id) => String(id).replace(/_\d+$/, '');
    if (typeof s.api.getGroupMembersInfo === 'function') {
      for (let i = 0; i < rawIds.length; i += 50) {
        const batch = rawIds.slice(i, i + 50);
        try {
          const resp = await s.api.getGroupMembersInfo(batch);
          const profiles = resp?.profiles || {};
          for (const raw of batch) {
            const id = cleanId(raw);
            const p = profiles[id] || profiles[raw] || {};
            out.push({ userId: id, displayName: p.displayName || p.zaloName || '', zaloName: p.zaloName || '', avatar: p.avatar || '', globalId: p.globalId || '' });
          }
        } catch (e) { for (const raw of batch) out.push({ userId: cleanId(raw) }); }
      }
    } else {
      for (const raw of rawIds) out.push({ userId: cleanId(raw) });
    }
    return out;
  } catch { return []; }
}
async function getReceivedRequests(ownId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  if (typeof s.api.getFriendRecommendations !== 'function') return [];
  const resp = await s.api.getFriendRecommendations();
  const items = Array.isArray(resp?.recommItems) ? resp.recommItems : [];
  // recommType === 2 = ReceivedFriendRequest (1 = RecommendedFriend / gợi ý)
  return items
    .map(it => it?.dataInfo)
    .filter(d => d && d.recommType === 2 && d.userId)
    .map(d => ({
      userId: d.userId,
      displayName: d.displayName || d.zaloName || d.userId,
      zaloName: d.zaloName,
      avatar: d.avatar,
      gender: d.gender,
      message: d.recommInfo?.message || '',
      source: d.recommInfo?.source,
      time: d.recommTime || 0,
      isSeen: !!d.isSeenFriendReq,
    }));
}
async function getSentRequests(ownId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  const fn = s.api.getSentFriendRequest || s.api.getSentFriendRequests;
  if (typeof fn !== 'function') return [];
  const resp = await fn.call(s.api);
  // zca-js trả { [userId]: SentFriendRequestInfo } — flatten về array
  if (Array.isArray(resp)) return resp;
  if (!resp || typeof resp !== 'object') return [];
  return Object.values(resp).map(d => ({
    userId: d.userId,
    displayName: d.displayName || d.zaloName || d.userId,
    zaloName: d.zaloName,
    avatar: d.avatar,
    message: d.fReqInfo?.message || '',
    source: d.fReqInfo?.src,
    time: d.fReqInfo?.time || 0,
  }));
}
async function getStickersBy(ownId, keyword) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  if (typeof s.api.getStickers === 'function') return await s.api.getStickers(keyword || ':)');
  return [];
}
async function getStickerDetail(ownId, stickerIds) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  if (typeof s.api.getStickersDetail === 'function') return await s.api.getStickersDetail(stickerIds);
  return [];
}
async function sendSticker(ownId, threadId, threadType, stickerId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  return await s.api.sendSticker(stickerId, threadId, threadType);
}
async function getMembersFromLink(ownId, link, maxPages = 10) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  if (typeof s.api.getGroupLinkInfo !== 'function') throw new Error('Hàm getGroupLinkInfo không có trong zca-js');
  const out = [];
  let groupInfo = null;
  for (let page = 1; page <= maxPages; page++) {
    const r = await s.api.getGroupLinkInfo({ link, memberPage: page });
    if (page === 1) groupInfo = { groupId: r.groupId, name: r.name, totalMember: r.totalMember, avatar: r.avt };
    for (const m of (r.currentMems || [])) {
      out.push({ userId: String(m.id), displayName: m.dName || m.zaloName || '', zaloName: m.zaloName || '', avatar: m.avatar || '' });
    }
    if (!r.hasMoreMember) break;
  }
  return { group: groupInfo, members: out };
}

async function joinGroupByLink(ownId, link) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  for (const n of ['joinGroup', 'joinGroupByLink', 'joinGroupViaLink']) if (typeof s.api[n] === 'function') return await s.api[n](link);
  throw new Error('Hàm joinGroup không có');
}
async function loadGroupHistory(ownId, groupId, count = 50) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  if (typeof s.api.getGroupChatHistory !== 'function') throw new Error('Hàm getGroupChatHistory không có trong zca-js');
  const resp = await s.api.getGroupChatHistory(String(groupId), count);
  const msgs = resp?.groupMsgs || [];
  let inserted = 0;
  for (const m of msgs) {
    try {
      persistMessage(ownId, m, { skipUnread: true });
      inserted++;
    } catch {}
  }
  if (msgs.length) {
    const last = msgs[msgs.length - 1];
    const preview = friendlyPreview(last.data?.content, last.data?.msgType);
    stmts.upsertThread.run(String(groupId), ownId, ThreadType.Group, null, null, preview.slice(0, 100), parseInt(last.data?.ts || Date.now()));
  }
  return { inserted, total: msgs.length, hasMore: resp?.more === 1 };
}

async function leaveGroup(ownId, groupId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account chưa kết nối');
  const myId = s.api.getOwnId();
  for (const n of ['leaveGroup', 'leaveGroupChat']) if (typeof s.api[n] === 'function') return await s.api[n](groupId);
  return await s.api.removeUserFromGroup(myId, groupId);
}

async function addReaction(ownId, threadId, threadType, msgId, cliMsgId, icon) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account not connected: ' + ownId);
  if (typeof s.api.addReaction !== 'function') throw new Error('addReaction không có trong zca-js version này');
  return await s.api.addReaction(icon, { data: { msgId: String(msgId), cliMsgId: String(cliMsgId || msgId) }, threadId: String(threadId), type: threadType });
}

async function sendTyping(ownId, threadId, threadType) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account not connected: ' + ownId);
  if (typeof s.api.sendTypingEvent !== 'function') throw new Error('sendTypingEvent không có trong zca-js version này');
  return await s.api.sendTypingEvent(String(threadId), threadType);
}

async function setPinnedConversation(ownId, threadId, threadType, pinned) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account not connected: ' + ownId);
  if (typeof s.api.setPinnedConversations !== 'function') throw new Error('setPinnedConversations không có trong zca-js version này');
  return await s.api.setPinnedConversations(!!pinned, String(threadId), threadType);
}

async function setUnreadMark(ownId, threadId, threadType, unread) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account not connected: ' + ownId);
  const fn = unread ? s.api.addUnreadMark : s.api.removeUnreadMark;
  if (typeof fn !== 'function') throw new Error('addUnreadMark/removeUnreadMark không có trong zca-js version này');
  return await fn.call(s.api, String(threadId), threadType);
}

async function undoMessage(ownId, threadId, threadType, msgId, cliMsgId) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account not connected: ' + ownId);
  const fn = s.api.undo || s.api.undoMessage;
  if (typeof fn !== 'function') throw new Error('undo không có trong zca-js version này');
  return await fn.call(s.api, { msgId: String(msgId), cliMsgId: String(cliMsgId || msgId) }, String(threadId), threadType);
}

async function deleteChat(ownId, threadId, threadType, lastMessage) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account not connected: ' + ownId);
  const fn = s.api.deleteChat;
  if (typeof fn !== 'function') throw new Error('deleteChat không có trong zca-js version này');
  const payload = {
    ownerId: String(lastMessage.ownerId),
    cliMsgId: String(lastMessage.cliMsgId),
    globalMsgId: String(lastMessage.globalMsgId),
  };
  return await fn.call(s.api, payload, String(threadId), threadType);
}

const IMAGE_MSG_TYPES = new Set([5, 19]);

function extractImageUrls(content, msgType) {
  let c = content;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { return []; } }
  if (!c || typeof c !== 'object') return [];
  const urls = [];
  const isImg = (u) => typeof u === 'string' && /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(u);
  if (isImg(c.href)) urls.push(c.href);
  if (isImg(c.normalUrl)) urls.push(c.normalUrl);
  if (isImg(c.hdUrl)) urls.push(c.hdUrl);
  if (Array.isArray(c.params?.images)) {
    for (const im of c.params.images) {
      const u = im.href || im.url || im.normalUrl || im.hdUrl;
      if (isImg(u)) urls.push(u);
    }
  }
  return [...new Set(urls)];
}

async function fetchImageAsDataUrl(url, maxBytes = 4 * 1024 * 1024) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Referer': 'https://chat.zalo.me/',
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`Ảnh ${(buf.length / 1048576).toFixed(1)}MB > ${maxBytes / 1048576}MB`);
  let mime = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\//.test(mime)) mime = 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function deleteMessage(ownId, threadId, threadType, msgId, cliMsgId, uidFrom, onlyMe = true) {
  const s = sessions.get(ownId);
  if (!s) throw new Error('Account not connected: ' + ownId);
  const fn = s.api.deleteMessage;
  if (typeof fn !== 'function') throw new Error('deleteMessage không có trong zca-js version này');
  const dest = {
    data: { cliMsgId: String(cliMsgId || msgId), msgId: String(msgId), uidFrom: String(uidFrom || ownId) },
    threadId: String(threadId),
    type: threadType,
  };
  return await fn.call(s.api, dest, !!onlyMe);
}

module.exports = {
  startQRLogin, loginFromStored, attachSession, getSession, listSessions, disconnectAccount, enrichThreadName,
  sendMessage, sendImage, getThreadInfo, getAllFriends, getAllGroups,
  findUserByPhone, sendFriendRequest, acceptFriendRequest, undoFriendRequest, rejectFriendRequest, removeFriend,
  addUserToGroup, removeUserFromGroup, getGroupMembers, getMembersFromLink, joinGroupByLink, leaveGroup,
  getReceivedRequests, getSentRequests,
  getStickersBy, getStickerDetail, sendSticker,
  loadGroupHistory,
  addReaction, undoMessage, deleteChat, deleteMessage, setPinnedConversation, setUnreadMark, sendTyping,
  setBroadcaster, setAiCaller, setSendGuard, autoReconnectAll, ThreadType,
  IMAGE_MSG_TYPES, extractImageUrls, fetchImageAsDataUrl,
};
