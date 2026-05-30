const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dataDir = process.env.ZALO_DATA_DIR || __dirname;
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'zalo-data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  ownId TEXT PRIMARY KEY,
  name TEXT,
  cookies TEXT NOT NULL,
  imei TEXT NOT NULL,
  userAgent TEXT NOT NULL,
  language TEXT DEFAULT 'vi',
  proxy TEXT,
  active INTEGER DEFAULT 1,
  createdAt INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT NOT NULL,
  ownId TEXT NOT NULL,
  type INTEGER NOT NULL,
  name TEXT,
  avatar TEXT,
  lastMsg TEXT,
  lastMsgAt INTEGER DEFAULT 0,
  unread INTEGER DEFAULT 0,
  labels TEXT,
  PRIMARY KEY (id, ownId)
);
CREATE INDEX IF NOT EXISTS idx_threads_lastMsg ON threads(ownId, lastMsgAt DESC);
`);

try { db.exec('ALTER TABLE threads ADD COLUMN memberCount INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE threads ADD COLUMN pinned INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE campaigns ADD COLUMN cursor INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE labels ADD COLUMN description TEXT'); } catch {}
try { db.exec('ALTER TABLE fb_pages ADD COLUMN avatar TEXT'); } catch {}
try { db.exec('ALTER TABLE fb_pages ADD COLUMN userAccessToken TEXT'); } catch {}
try { db.exec('ALTER TABLE fb_pages ADD COLUMN instagramId TEXT'); } catch {}
try { db.exec('ALTER TABLE fb_pages ADD COLUMN reauthRequired INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE fb_pages ADD COLUMN lastError TEXT'); } catch {}
try { db.exec('ALTER TABLE fb_pages ADD COLUMN openingMessage TEXT'); } catch {}
try { db.exec('ALTER TABLE fb_pages ADD COLUMN openingAutoSend INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE fb_pages ADD COLUMN openingOnlyFirstMsg INTEGER DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE fb_messages ADD COLUMN status TEXT'); } catch {}  // sent / delivered / read / failed
try { db.exec('ALTER TABLE fb_messages ADD COLUMN sourceFromChatwoot INTEGER DEFAULT 0'); } catch {}  // 1 = gửi từ app này, 0 = gửi từ FB Page Mobile/Web
// ═══ FANPAGE FACEBOOK ═══
db.exec(`
CREATE TABLE IF NOT EXISTS fb_pages (
  pageId TEXT PRIMARY KEY,
  name TEXT,
  avatar TEXT,
  accessToken TEXT NOT NULL,
  userAccessToken TEXT,
  instagramId TEXT,
  ownerOwnId TEXT,
  active INTEGER DEFAULT 1,
  reauthRequired INTEGER DEFAULT 0,
  lastError TEXT,
  openingMessage TEXT,
  openingAutoSend INTEGER DEFAULT 0,
  openingOnlyFirstMsg INTEGER DEFAULT 1,
  createdAt INTEGER DEFAULT (unixepoch()),
  updatedAt INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS fb_conversations (
  id TEXT PRIMARY KEY,  -- conversation id từ Facebook
  pageId TEXT NOT NULL,
  customerPsid TEXT NOT NULL,  -- Page-Scoped ID của khách
  customerName TEXT,
  customerAvatar TEXT,
  lastMsg TEXT,
  lastMsgAt INTEGER DEFAULT 0,
  unread INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open',  -- open / pending / resolved / snoozed
  labels TEXT,  -- JSON array
  assignedTo TEXT,
  createdAt INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_fb_convo_page ON fb_conversations(pageId, lastMsgAt DESC);

CREATE TABLE IF NOT EXISTS fb_messages (
  msgId TEXT NOT NULL,
  pageId TEXT NOT NULL,
  conversationId TEXT NOT NULL,
  fromPsid TEXT,  -- ai gửi (null nếu là page tự gửi)
  fromName TEXT,
  toPsid TEXT,
  content TEXT,
  attachments TEXT,  -- JSON
  isFromPage INTEGER DEFAULT 0,
  isNote INTEGER DEFAULT 0,  -- ghi chú nội bộ, không gửi ra FB
  ts INTEGER NOT NULL,
  sourceFromChatwoot INTEGER DEFAULT 0,
  status TEXT,
  PRIMARY KEY (msgId, pageId)
);
CREATE INDEX IF NOT EXISTS idx_fb_msg_convo ON fb_messages(conversationId, ts DESC);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS campaign_deliveries (
  campaignId INTEGER NOT NULL,
  threadId TEXT NOT NULL,
  status TEXT NOT NULL,
  ts INTEGER DEFAULT (unixepoch()),
  err TEXT,
  PRIMARY KEY (campaignId, threadId)
);
CREATE INDEX IF NOT EXISTS idx_camp_del_camp ON campaign_deliveries(campaignId, status);
`);

db.exec(`

CREATE TABLE IF NOT EXISTS messages (
  msgId TEXT NOT NULL,
  ownId TEXT NOT NULL,
  threadId TEXT NOT NULL,
  threadType INTEGER NOT NULL,
  fromId TEXT,
  fromName TEXT,
  content TEXT,
  type INTEGER DEFAULT 0,
  meta TEXT,
  ts INTEGER NOT NULL,
  isSelf INTEGER DEFAULT 0,
  PRIMARY KEY (msgId, ownId)
);
CREATE INDEX IF NOT EXISTS idx_msgs_thread ON messages(ownId, threadId, ts DESC);
CREATE INDEX IF NOT EXISTS idx_msgs_search ON messages(ownId, content);

CREATE TABLE IF NOT EXISTS pinned_messages (
  ownId TEXT NOT NULL,
  threadId TEXT NOT NULL,
  msgId TEXT NOT NULL,
  pinnedAt INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (ownId, threadId, msgId)
);
CREATE INDEX IF NOT EXISTS idx_pinned_messages_thread ON pinned_messages(ownId, threadId, pinnedAt DESC);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ownId TEXT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  createdAt INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS scheduled (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ownId TEXT NOT NULL,
  threadId TEXT NOT NULL,
  threadType INTEGER NOT NULL,
  content TEXT NOT NULL,
  scheduleAt INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  createdAt INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS auto_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ownId TEXT NOT NULL,
  keyword TEXT NOT NULL,
  response TEXT NOT NULL,
  scope TEXT DEFAULT 'all',
  enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ownId TEXT NOT NULL,
  action TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  targets TEXT NOT NULL,
  total INTEGER DEFAULT 0,
  success INTEGER DEFAULT 0,
  fail INTEGER DEFAULT 0,
  cursor INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  taskId TEXT,
  createdAt INTEGER DEFAULT (unixepoch()),
  updatedAt INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_campaigns_acc ON campaigns(ownId, action, createdAt DESC);

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ownId TEXT NOT NULL,
  content TEXT NOT NULL,
  targets TEXT NOT NULL,
  delayMs INTEGER DEFAULT 5000,
  status TEXT DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  createdAt INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target TEXT,
  usp TEXT,
  pricing_note TEXT,
  objections TEXT,
  qualify_questions TEXT,
  close_script TEXT,
  keywords TEXT,
  priority INTEGER DEFAULT 99,
  enabled INTEGER DEFAULT 1,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#fbbf24',
  position INTEGER DEFAULT 0,
  description TEXT,
  createdAt INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS auto_reply_thread (
  ownId TEXT NOT NULL,
  threadId TEXT NOT NULL,
  threadType INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 0,
  mode TEXT DEFAULT 'ai',                  -- 'ai' | 'static' | 'keyword'
  static_reply TEXT,
  delay_min_sec INTEGER DEFAULT 3,
  delay_max_sec INTEGER DEFAULT 8,
  max_per_hour INTEGER DEFAULT 30,
  work_start TEXT DEFAULT '00:00',
  work_end TEXT DEFAULT '23:59',
  only_first_msg INTEGER DEFAULT 0,
  manual_cooldown_min INTEGER DEFAULT 10,
  allowed_users TEXT,
  only_when_mentioned INTEGER DEFAULT 0,
  reply_all_in_group INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (ownId, threadId)
);
CREATE INDEX IF NOT EXISTS idx_arthread_enabled ON auto_reply_thread(ownId, enabled);

CREATE TABLE IF NOT EXISTS auto_reply_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ownId TEXT NOT NULL,
  threadId TEXT NOT NULL,
  triggered_msgId TEXT,
  reply_content TEXT,
  mode TEXT,
  ts INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_arlog_thread ON auto_reply_log(ownId, threadId, ts DESC);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT,
  input_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  input_rate REAL,
  cache_read_rate REAL,
  cache_write_rate REAL,
  output_rate REAL,
  cost_usd REAL,
  pricing_source TEXT,
  ts INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_ts ON ai_usage(ts DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_provider_ts ON ai_usage(provider, ts DESC);
`);

// Các migration phụ thuộc bảng auto_reply_thread phải chạy sau CREATE TABLE ở database mới.
try { db.exec('ALTER TABLE auto_reply_thread ADD COLUMN first_n_msgs INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE auto_reply_thread ADD COLUMN reply_all_in_group INTEGER DEFAULT 0'); } catch {}
try { db.exec("UPDATE auto_reply_thread SET first_n_msgs=1 WHERE only_first_msg=1 AND first_n_msgs=0"); } catch {}
// Không giữ trạng thái ON cho cấu hình nhóm đời cũ vốn chưa có hàng rào an toàn.
try {
  db.exec(`UPDATE auto_reply_thread SET enabled=0, updated_at=unixepoch()
    WHERE threadType=1 AND enabled=1 AND only_when_mentioned=0
      AND COALESCE(reply_all_in_group,0)=0
      AND (allowed_users IS NULL OR trim(allowed_users) IN ('', '[]', 'null'))`);
} catch {}

// Seed default labels if empty
(() => {
  const n = db.prepare('SELECT COUNT(*) AS c FROM labels').get().c;
  if (n > 0) return;
  const ins = db.prepare('INSERT INTO labels (name, color, position) VALUES (?, ?, ?)');
  const defaults = [
    ['Khách tiềm năng', '#fbbf24', 1],
    ['Đang làm việc', '#fb923c', 2],
    ['Đã chốt', '#22c55e', 3],
    ['Cần follow-up', '#a855f7', 4],
    ['Spam / không quan tâm', '#94a3b8', 5],
  ];
  for (const [name, color, pos] of defaults) ins.run(name, color, pos);
})();

const OMNI_AI_PRODUCT = {
  id: 'zalo-ai',
  name: 'OMNI AI MARKETING',
  target: 'Chủ shop, doanh nghiệp, agency và đội sale/marketing cần quản lý đồng thời nhiều tài khoản Zalo và Fanpage Facebook. Có nhu cầu nhắn tin, chăm sóc lead và tự động trả lời bằng AI trên cả hai kênh trong một hệ thống.',
  usp: `Giải pháp AI Marketing hợp nhất: ZALO AI MARKETING + FANPAGE AI MARKETING trong cùng một giao diện.

TÍNH NĂNG ZALO AI MARKETING:
1) Quản lý đa tài khoản Zalo: đăng nhập nhiều tài khoản qua mã QR, tự kết nối lại, chuyển tài khoản nhanh.
2) Chat tập trung: hội thoại cá nhân/nhóm theo thời gian thực, gắn nhãn màu, lọc, ghim, đánh dấu chưa đọc, gửi sticker/đính kèm.
3) Nhắn tin hàng loạt: theo số điện thoại, bạn bè, thành viên nhóm hiện tại hoặc nhóm khác; có hẹn giờ và mẫu tin.
4) Kết bạn tự động: theo số điện thoại, thành viên nhóm, file sao lưu; thu hồi lời mời và xoá bạn hàng loạt.
5) Quản lý nhóm: tham gia nhóm bằng link, mời thành viên, rời nhiều nhóm.

TÍNH NĂNG FANPAGE AI MARKETING ĐÃ CÓ:
1) Kết nối và quản lý Fanpage Facebook bằng token hoặc Facebook Login.
2) Inbox Fanpage tập trung: đồng bộ hội thoại/tin nhắn cũ, nhận và gửi tin realtime qua webhook.
3) Quản lý lead Fanpage: tìm kiếm, gắn nhãn, lọc và cập nhật trạng thái hội thoại.
4) AI tự động trả lời theo từng hội thoại Fanpage, dùng bối cảnh chat và knowledge base sản phẩm.
5) AI tự phân loại/gắn nhãn khách hàng Fanpage; AI cố vấn gợi ý phản hồi và hướng chốt sale.

AI DÙNG CHUNG CHO CẢ HAI KÊNH:
- AI Cố vấn chốt sale: phân tích lead, gợi ý reply, kịch bản chốt và xử lý phản đối.
- AI Tự động trả lời: bật/tắt theo hội thoại, tạo phản hồi theo bối cảnh + knowledge base, có độ trễ và giới hạn chống gửi dồn.

GIỚI HẠN CẦN NÓI ĐÚNG:
- Zalo không hỗ trợ tìm bạn theo GPS, gọi thoại/video/livestream, đăng Khoảnh khắc hoặc đọc lịch sử cá nhân quá xa qua bản web.
- Fanpage AI Marketing phục vụ inbox/chăm sóc khách trên Page đã kết nối; không đồng nghĩa với tự vận hành chiến dịch quảng cáo Facebook.
- Dịch vụ chạy quảng cáo Facebook là sản phẩm riêng nếu khách hỏi về ads/budget/ROAS.`,
  pricing_note: `BẢNG GIÁ CỐ ĐỊNH OMNI AI MARKETING (được phép báo cho khách):

GÓI DÙNG THỬ: 0đ / 3 ngày - trải nghiệm AI tự động trả lời và luồng chăm sóc khách.
GÓI 1 NĂM: 3.000.000đ / 365 ngày - đầy đủ tính năng OMNI AI MARKETING, tích hợp Zalo AI Marketing và Fanpage AI Marketing, cầm tay chỉ việc 1-1.
GÓI 2 NĂM: 5.000.000đ / 730 ngày (tiết kiệm 1tr) - thêm tài liệu marketing và 50 kịch bản chốt sale.
GÓI VĨNH VIỄN: 10.000.000đ / trọn đời - thêm hỗ trợ triển khai và coaching Leader Admin.

NGUYÊN TẮC ĐẨY GÓI:
- Khách mới chưa tin tưởng -> đẩy DÙNG THỬ 0đ trước.
- Khách hỏi giá lần đầu -> đưa 3 mốc 1 năm / 2 năm / vĩnh viễn để khách so sánh.
- Khách cần đồng thời Zalo và Fanpage -> gọi đúng tên OMNI AI MARKETING và nhấn mạnh quản lý hai kênh trong một hệ thống.
- Khách hỏi giảm giá -> nói giá cố định, có thể tư vấn gói phù hợp hơn hoặc quyền lợi đi kèm.`,
  objections: JSON.stringify([
    { q: 'Có tự động trả lời được cả Zalo và Fanpage không?', a: 'Có. OMNI AI MARKETING đã tích hợp AI tự động trả lời theo từng hội thoại trên Zalo và Fanpage Facebook, dùng bối cảnh chat cùng kho thông tin sản phẩm để trả lời đúng nhu cầu khách.' },
    { q: 'Fanpage có thật sự kết nối vào hệ thống hay chỉ gợi ý trả lời?', a: 'Fanpage được kết nối trực tiếp để đồng bộ inbox, nhận/gửi tin realtime, gắn nhãn và bật AI tự động trả lời theo từng hội thoại.' },
    { q: 'Có bị Zalo khoá tài khoản không?', a: 'Các thao tác cần cấu hình tốc độ và quy trình phù hợp. Bên mình hướng dẫn chi tiết để vận hành hợp lý; không hứa tuyệt đối về chính sách nền tảng.' },
    { q: 'Có khó dùng không, có cần lập trình viên không?', a: 'Không cần biết code. Giao diện quản lý tập trung cho Zalo và Fanpage, bên mình có hướng dẫn triển khai 1-1.' },
    { q: 'Có tự chạy quảng cáo Facebook không?', a: 'OMNI AI MARKETING tập trung vào inbox và AI chăm sóc/chốt khách trên Fanpage. Nếu bạn cần chạy ads, bên mình có sản phẩm Dịch vụ Quảng cáo Facebook riêng để tư vấn.' }
  ]),
  qualify_questions: JSON.stringify([
    'Bạn đang cần chăm khách trên Zalo, Fanpage hay muốn quản lý cả hai kênh cùng lúc?',
    'Bạn hiện có bao nhiêu tài khoản Zalo và bao nhiêu Fanpage cần kết nối?',
    'Mỗi ngày đội bạn xử lý khoảng bao nhiêu cuộc hội thoại, đang vướng chậm phản hồi hay bỏ sót lead?',
    'Bạn cần AI tự động trả lời, phân loại lead, hay thêm các hoạt động marketing Zalo như kết bạn/nhắn tin hàng loạt?'
  ]),
  close_script: 'AIDA: Attention (pain bỏ sót lead giữa Zalo và Fanpage) -> Interest (một inbox vận hành cùng AI trả lời trên cả hai kênh) -> Desire (demo hội thoại Fanpage + Zalo, nhãn lead và auto-reply) -> Action (mời trải nghiệm gói thử và buổi setup 1-1).',
  keywords: 'omni,omni ai marketing,zalo ai marketing,fanpage ai marketing,chat ai marketing,fanpage,facebook,messenger,inbox,page,chatbot,auto reply,tự động trả lời,zalo,kết bạn,gửi tin hàng loạt,quản lý đa kênh,chăm sóc khách,khách tiềm năng',
  priority: 2,
  enabled: 1,
};

// Seed 2 default products if products table is empty
(() => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  if (count > 0) return;
  const seed = db.prepare(`INSERT INTO products
    (id, name, target, usp, pricing_note, objections, qualify_questions, close_script, keywords, priority, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  seed.run(
    'fb-ads',
    'Dịch vụ Quảng cáo Facebook',
    'Chủ shop, SME có sản phẩm vật lý / dịch vụ. Budget ads tối thiểu 5tr/tháng. Đã/đang chạy ads mà ROAS thấp hoặc chưa biết tối ưu.',
    'Trọn gói setup pixel + chạy + tối ưu hàng ngày + báo cáo tuần. Đội ngũ chuyên ngách (thời trang, mỹ phẩm, F&B, dịch vụ). Cam kết minh bạch chi phí, không ăn % budget.',
    'Phí dịch vụ tùy ngành + budget khách. KHÔNG quote giá public — luôn dẫn về tư vấn 1-1 qua hotline 0968.91.5555 hoặc inbox.',
    JSON.stringify([
      { q: 'Đắt quá so với tự chạy', a: 'Tự chạy đốt 3-5tr test thì cũng mất tiền học phí mà chưa chắc ra đơn. Bên mình tính đúng theo hiệu quả, ROAS không đạt là bên mình lỗ chứ bạn không lỗ.' },
      { q: 'Tự chạy được, không cần thuê', a: 'Tự chạy được thì quá tốt. Bên mình thường nhận case của người đã tự chạy 6-12 tháng rồi thấy cần tối ưu sâu hơn. Bạn đang đo ROAS bằng cách nào?' },
      { q: 'Sao bên kia rẻ hơn', a: 'Mỗi bên có cách tính khác nhau. Bên mình tính trọn gói gồm: pixel + content + chạy + báo cáo. Bạn có thể so từng đầu mục để rõ.' },
      { q: 'Cam kết ROAS bao nhiêu?', a: 'Tùy ngành + sản phẩm. Bên mình review pixel + landing trước rồi mới cam kết con số cụ thể, không hứa khống.' }
    ]),
    JSON.stringify([
      'Bạn đang chạy ads ngành gì, sản phẩm chính là gì?',
      'Budget ads hàng tháng đang ở mức nào?',
      'Đã có fanpage + pixel chưa, hay cần setup từ đầu?',
      'Mục tiêu chính: ra đơn online, hay kéo khách offline, hay branding?'
    ]),
    'AIDA: Attention (hỏi pain hiện tại) → Interest (chia ngách bên mình mạnh + case study cùng ngành) → Desire (so sánh chi phí tự chạy vs thuê + ROAS thực tế) → Action (mời 1 buổi audit pixel/landing miễn phí 30 phút qua Zalo/Meet).',
    'quảng cáo,facebook,fb ads,chạy ads,roas,pixel,fanpage,booking,marketing,target,budget,leadgen,conversion',
    1
  );
  seed.run(
    OMNI_AI_PRODUCT.id, OMNI_AI_PRODUCT.name, OMNI_AI_PRODUCT.target, OMNI_AI_PRODUCT.usp,
    OMNI_AI_PRODUCT.pricing_note, OMNI_AI_PRODUCT.objections, OMNI_AI_PRODUCT.qualify_questions,
    OMNI_AI_PRODUCT.close_script, OMNI_AI_PRODUCT.keywords, OMNI_AI_PRODUCT.priority
  );
})();

// One-time product migration: rename Zalo-only positioning to the unified Omni product.
(() => {
  const migrationKey = 'migration.product.omni-ai-v1';
  const done = db.prepare('SELECT value FROM settings WHERE key=?').get(migrationKey);
  if (done) return;
  const current = db.prepare('SELECT id FROM products WHERE id=?').get(OMNI_AI_PRODUCT.id);
  if (current) {
    db.prepare(`UPDATE products SET name=?, target=?, usp=?, pricing_note=?, objections=?,
      qualify_questions=?, close_script=?, keywords=?, priority=?, enabled=?, updated_at=unixepoch()
      WHERE id=?`).run(
      OMNI_AI_PRODUCT.name, OMNI_AI_PRODUCT.target, OMNI_AI_PRODUCT.usp, OMNI_AI_PRODUCT.pricing_note,
      OMNI_AI_PRODUCT.objections, OMNI_AI_PRODUCT.qualify_questions, OMNI_AI_PRODUCT.close_script,
      OMNI_AI_PRODUCT.keywords, OMNI_AI_PRODUCT.priority, OMNI_AI_PRODUCT.enabled, OMNI_AI_PRODUCT.id
    );
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(migrationKey, String(Date.now()));
})();

// Keep an existing customized business context aligned with the Omni product rename.
(() => {
  const migrationKey = 'migration.prompt.omni-ai-v1';
  const done = db.prepare('SELECT value FROM settings WHERE key=?').get(migrationKey);
  if (done) return;
  const settingKey = 'ai.prompt.businessContext';
  const current = db.prepare('SELECT value FROM settings WHERE key=?').get(settingKey)?.value;
  const oldDescription = 'Lĩnh vực: dịch vụ marketing + phần mềm hỗ trợ Zalo, Facebook.';
  const omniDescription = 'Lĩnh vực: dịch vụ marketing + OMNI AI MARKETING hợp nhất Zalo và Fanpage Facebook trong một hệ thống.';
  if (current && current.includes(oldDescription)) {
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(
      current.replace(oldDescription, omniDescription),
      settingKey
    );
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(migrationKey, String(Date.now()));
})();

const stmts = {
  upsertAccount: db.prepare(`INSERT INTO accounts (ownId, name, cookies, imei, userAgent, language, proxy)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ownId) DO UPDATE SET name=excluded.name, cookies=excluded.cookies, imei=excluded.imei, userAgent=excluded.userAgent, language=excluded.language, proxy=excluded.proxy, active=1`),
  listAccounts: db.prepare(`SELECT ownId, name, language, proxy, active, createdAt FROM accounts WHERE active=1 ORDER BY createdAt DESC`),
  getAccount: db.prepare(`SELECT * FROM accounts WHERE ownId=?`),
  removeAccount: db.prepare(`UPDATE accounts SET active=0 WHERE ownId=?`),
  setAccountProxy: db.prepare(`UPDATE accounts SET proxy=? WHERE ownId=?`),

  upsertThread: db.prepare(`INSERT INTO threads (id, ownId, type, name, avatar, lastMsg, lastMsgAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, ownId) DO UPDATE SET
      name = COALESCE(excluded.name, threads.name),
      avatar = COALESCE(excluded.avatar, threads.avatar),
      lastMsg = CASE WHEN excluded.lastMsg IS NOT NULL AND excluded.lastMsg != '' THEN excluded.lastMsg ELSE threads.lastMsg END,
      lastMsgAt = CASE WHEN excluded.lastMsgAt > threads.lastMsgAt THEN excluded.lastMsgAt ELSE threads.lastMsgAt END`),
  listThreads: db.prepare(`SELECT * FROM threads WHERE ownId=? ORDER BY pinned DESC, lastMsgAt DESC LIMIT ?`),
  getThread: db.prepare(`SELECT * FROM threads WHERE ownId=? AND id=?`),
  setUnread: db.prepare(`UPDATE threads SET unread=? WHERE ownId=? AND id=?`),
  incUnread: db.prepare(`UPDATE threads SET unread=unread+1 WHERE ownId=? AND id=?`),
  setLabels: db.prepare(`UPDATE threads SET labels=? WHERE ownId=? AND id=?`),
  setPinned: db.prepare(`UPDATE threads SET pinned=? WHERE ownId=? AND id=?`),

  insertMsg: db.prepare(`INSERT OR IGNORE INTO messages (msgId, ownId, threadId, threadType, fromId, fromName, content, type, meta, ts, isSelf)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  listMsgs: db.prepare(`SELECT * FROM messages WHERE ownId=? AND threadId=? ORDER BY ts DESC LIMIT ? OFFSET ?`),
  getMsgInThread: db.prepare(`SELECT * FROM messages WHERE ownId=? AND threadId=? AND msgId=?`),
  searchMsgs: db.prepare(`SELECT * FROM messages WHERE ownId=? AND content LIKE ? ORDER BY ts DESC LIMIT 100`),
  pinMessage: db.prepare(`INSERT OR REPLACE INTO pinned_messages (ownId, threadId, msgId, pinnedAt) VALUES (?, ?, ?, unixepoch())`),
  unpinMessage: db.prepare(`DELETE FROM pinned_messages WHERE ownId=? AND threadId=? AND msgId=?`),
  listPinnedMessageIds: db.prepare(`SELECT msgId FROM pinned_messages WHERE ownId=? AND threadId=?`),
  listPinnedMessages: db.prepare(`SELECT m.*, p.pinnedAt
    FROM pinned_messages p
    JOIN messages m ON m.ownId=p.ownId AND m.threadId=p.threadId AND m.msgId=p.msgId
    WHERE p.ownId=? AND p.threadId=?
    ORDER BY p.pinnedAt DESC LIMIT ?`),
  removePinnedThreadMessages: db.prepare(`DELETE FROM pinned_messages WHERE ownId=? AND threadId=?`),

  addTemplate: db.prepare(`INSERT INTO templates (ownId, name, content) VALUES (?, ?, ?)`),
  listTemplates: db.prepare(`SELECT * FROM templates WHERE ownId IS NULL OR ownId=? ORDER BY id DESC`),
  delTemplate: db.prepare(`DELETE FROM templates WHERE id=?`),

  addScheduled: db.prepare(`INSERT INTO scheduled (ownId, threadId, threadType, content, scheduleAt) VALUES (?, ?, ?, ?, ?)`),
  listScheduled: db.prepare(`SELECT * FROM scheduled WHERE ownId=? ORDER BY scheduleAt DESC LIMIT 100`),
  pendingScheduled: db.prepare(`SELECT * FROM scheduled WHERE status='pending' AND scheduleAt<=?`),
  updateScheduled: db.prepare(`UPDATE scheduled SET status=? WHERE id=?`),

  addAutoReply: db.prepare(`INSERT INTO auto_replies (ownId, keyword, response, scope) VALUES (?, ?, ?, ?)`),
  listAutoReplies: db.prepare(`SELECT * FROM auto_replies WHERE ownId=?`),
  delAutoReply: db.prepare(`DELETE FROM auto_replies WHERE id=?`),
  enabledAutoReplies: db.prepare(`SELECT * FROM auto_replies WHERE ownId=? AND enabled=1`),

  addCampaign: db.prepare(`INSERT INTO campaigns (ownId, action, name, config, targets, total) VALUES (?, ?, ?, ?, ?, ?)`),
  updateCampaign: db.prepare(`UPDATE campaigns SET name=?, config=?, targets=?, total=?, updatedAt=unixepoch() WHERE id=?`),
  listCampaigns: db.prepare(`SELECT id, ownId, action, name, total, success, fail, cursor, status, taskId, createdAt, updatedAt FROM campaigns WHERE ownId=? AND action=? ORDER BY createdAt DESC`),
  getCampaign: db.prepare(`SELECT * FROM campaigns WHERE id=?`),
  delCampaign: db.prepare(`DELETE FROM campaigns WHERE id=?`),
  setCampaignStats: db.prepare(`UPDATE campaigns SET success=?, fail=?, status=?, taskId=? WHERE id=?`),
  setCampaignProgress: db.prepare(`UPDATE campaigns SET success=?, fail=?, cursor=?, status=?, taskId=?, updatedAt=unixepoch() WHERE id=?`),
  setCampaignStatus: db.prepare(`UPDATE campaigns SET status=? WHERE id=?`),
  resetCampaignCursor: db.prepare(`UPDATE campaigns SET cursor=0, success=0, fail=0, status='draft' WHERE id=?`),
  recordCampaignDelivery: db.prepare(`INSERT OR REPLACE INTO campaign_deliveries (campaignId, threadId, status, ts, err) VALUES (?, ?, ?, unixepoch(), ?)`),
  countCampaignDeliveries: db.prepare(`SELECT
    COUNT(CASE WHEN status='ok' THEN 1 END) as delivered,
    COUNT(CASE WHEN status='fail' THEN 1 END) as failed,
    COUNT(*) as total_attempted
    FROM campaign_deliveries WHERE campaignId=?`),
  countCampaignDeliveriesSince: db.prepare(`SELECT COUNT(*) as total_attempted
    FROM campaign_deliveries WHERE campaignId=? AND ts>=?`),
  listCampaignDeliveries: db.prepare(`SELECT threadId, status, ts, err FROM campaign_deliveries WHERE campaignId=? ORDER BY ts DESC`),
  getSentUidsForCampaign: db.prepare(`SELECT threadId FROM campaign_deliveries WHERE campaignId=? AND status='ok'`),
  clearCampaignDeliveries: db.prepare(`DELETE FROM campaign_deliveries WHERE campaignId=?`),

  addBroadcast: db.prepare(`INSERT INTO broadcasts (ownId, content, targets, delayMs, total) VALUES (?, ?, ?, ?, ?)`),
  listBroadcasts: db.prepare(`SELECT * FROM broadcasts WHERE ownId=? ORDER BY id DESC LIMIT 50`),
  updateBroadcastProgress: db.prepare(`UPDATE broadcasts SET progress=?, status=? WHERE id=?`),

  getSetting: db.prepare(`SELECT value FROM settings WHERE key=?`),
  setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
  listSettings: db.prepare(`SELECT key, value FROM settings WHERE key LIKE ?`),

  // Auto-reply per thread
  getAutoReplyThread: db.prepare(`SELECT * FROM auto_reply_thread WHERE ownId=? AND threadId=?`),
  listAutoReplyThreadsEnabled: db.prepare(`SELECT * FROM auto_reply_thread WHERE ownId=? AND enabled=1`),
  listAutoReplyThreadsAll: db.prepare(`SELECT * FROM auto_reply_thread WHERE ownId=? ORDER BY updated_at DESC`),
  upsertAutoReplyThread: db.prepare(`INSERT INTO auto_reply_thread
    (ownId, threadId, threadType, enabled, mode, static_reply, delay_min_sec, delay_max_sec, max_per_hour, work_start, work_end, only_first_msg, first_n_msgs, manual_cooldown_min, allowed_users, only_when_mentioned, reply_all_in_group, updated_at)
    VALUES (@ownId, @threadId, @threadType, @enabled, @mode, @static_reply, @delay_min_sec, @delay_max_sec, @max_per_hour, @work_start, @work_end, @only_first_msg, @first_n_msgs, @manual_cooldown_min, @allowed_users, @only_when_mentioned, @reply_all_in_group, unixepoch())
    ON CONFLICT(ownId, threadId) DO UPDATE SET
      threadType=excluded.threadType, enabled=excluded.enabled, mode=excluded.mode,
      static_reply=excluded.static_reply,
      delay_min_sec=excluded.delay_min_sec, delay_max_sec=excluded.delay_max_sec,
      max_per_hour=excluded.max_per_hour, work_start=excluded.work_start, work_end=excluded.work_end,
      only_first_msg=excluded.only_first_msg, first_n_msgs=excluded.first_n_msgs,
      manual_cooldown_min=excluded.manual_cooldown_min,
      allowed_users=excluded.allowed_users, only_when_mentioned=excluded.only_when_mentioned,
      reply_all_in_group=excluded.reply_all_in_group,
      updated_at=unixepoch()`),
  delAutoReplyThread: db.prepare(`DELETE FROM auto_reply_thread WHERE ownId=? AND threadId=?`),
  countAutoReplyLastHour: db.prepare(`SELECT COUNT(*) AS c FROM auto_reply_log WHERE ownId=? AND threadId=? AND ts > ?`),
  countAutoReplyTotalForThread: db.prepare(`SELECT COUNT(*) AS c FROM auto_reply_log WHERE ownId=? AND threadId=?`),
  insertAutoReplyLog: db.prepare(`INSERT INTO auto_reply_log (ownId, threadId, triggered_msgId, reply_content, mode) VALUES (?, ?, ?, ?, ?)`),
  lastSelfMsgTs: db.prepare(`SELECT ts FROM messages WHERE ownId=? AND threadId=? AND isSelf=1 ORDER BY ts DESC LIMIT 1`),

  listLabels: db.prepare(`SELECT * FROM labels ORDER BY position ASC, id ASC`),
  getLabel: db.prepare(`SELECT * FROM labels WHERE id=?`),
  getLabelByName: db.prepare(`SELECT * FROM labels WHERE name=?`),
  addLabel: db.prepare(`INSERT INTO labels (name, color, position) VALUES (?, ?, ?)`),
  updateLabel: db.prepare(`UPDATE labels SET name=?, color=?, position=? WHERE id=?`),
  updateLabelDescription: db.prepare(`UPDATE labels SET description=? WHERE id=?`),
  delLabel: db.prepare(`DELETE FROM labels WHERE id=?`),
  // Lấy tất cả thread có gắn label name nào đó (labels lưu dạng JSON array)
  threadsByLabelName: db.prepare(`SELECT id FROM threads WHERE ownId=? AND labels LIKE '%' || ? || '%'`),

  // ═══ FANPAGE STATEMENTS ═══
  listFbPages: db.prepare(`SELECT pageId, name, avatar, instagramId, reauthRequired, lastError, ownerOwnId, active, openingMessage, openingAutoSend, openingOnlyFirstMsg, createdAt FROM fb_pages WHERE active=1 ORDER BY createdAt DESC`),
  getFbPage: db.prepare(`SELECT * FROM fb_pages WHERE pageId=?`),
  upsertFbPage: db.prepare(`INSERT INTO fb_pages (pageId, name, avatar, accessToken, userAccessToken, instagramId, ownerOwnId)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pageId) DO UPDATE SET
      name=excluded.name,
      avatar=COALESCE(excluded.avatar, fb_pages.avatar),
      accessToken=excluded.accessToken,
      userAccessToken=COALESCE(excluded.userAccessToken, fb_pages.userAccessToken),
      instagramId=COALESCE(excluded.instagramId, fb_pages.instagramId),
      ownerOwnId=excluded.ownerOwnId,
      active=1, reauthRequired=0, lastError=NULL,
      updatedAt=unixepoch()`),
  deactivateFbPage: db.prepare(`UPDATE fb_pages SET active=0 WHERE pageId=?`),
  setFbPageReauth: db.prepare(`UPDATE fb_pages SET reauthRequired=?, lastError=? WHERE pageId=?`),
  updateFbOpeningMessage: db.prepare(`UPDATE fb_pages SET openingMessage=?, openingAutoSend=?, openingOnlyFirstMsg=?, updatedAt=unixepoch() WHERE pageId=?`),
  updateFbMessageStatus: db.prepare(`UPDATE fb_messages SET status=? WHERE msgId=? AND pageId=?`),

  listFbConvos: db.prepare(`SELECT * FROM fb_conversations WHERE pageId=? ORDER BY lastMsgAt DESC LIMIT ?`),
  listFbConvosByStatus: db.prepare(`SELECT * FROM fb_conversations WHERE pageId=? AND status=? ORDER BY lastMsgAt DESC LIMIT ?`),
  getFbConvo: db.prepare(`SELECT * FROM fb_conversations WHERE id=?`),
  upsertFbConvo: db.prepare(`INSERT INTO fb_conversations (id, pageId, customerPsid, customerName, customerAvatar, lastMsg, lastMsgAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      customerName=COALESCE(excluded.customerName, fb_conversations.customerName),
      customerAvatar=COALESCE(excluded.customerAvatar, fb_conversations.customerAvatar),
      lastMsg=excluded.lastMsg,
      lastMsgAt=CASE WHEN excluded.lastMsgAt > fb_conversations.lastMsgAt THEN excluded.lastMsgAt ELSE fb_conversations.lastMsgAt END`),
  setFbConvoStatus: db.prepare(`UPDATE fb_conversations SET status=? WHERE id=?`),
  setFbConvoUnread: db.prepare(`UPDATE fb_conversations SET unread=? WHERE id=?`),
  incFbConvoUnread: db.prepare(`UPDATE fb_conversations SET unread=unread+1 WHERE id=?`),
  countFbConvosByStatus: db.prepare(`SELECT status, COUNT(*) as cnt FROM fb_conversations WHERE pageId=? GROUP BY status`),

  listFbMessages: db.prepare(`SELECT * FROM fb_messages WHERE conversationId=? ORDER BY ts DESC LIMIT ? OFFSET ?`),
  insertFbMessage: db.prepare(`INSERT OR IGNORE INTO fb_messages
    (msgId, pageId, conversationId, fromPsid, fromName, toPsid, content, attachments, isFromPage, isNote, ts, sourceFromChatwoot, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),

  listProducts: db.prepare(`SELECT * FROM products ORDER BY enabled DESC, priority ASC, name`),
  listEnabledProducts: db.prepare(`SELECT * FROM products WHERE enabled=1 ORDER BY priority ASC`),
  getProduct: db.prepare(`SELECT * FROM products WHERE id=?`),
  upsertProduct: db.prepare(`INSERT INTO products
    (id, name, target, usp, pricing_note, objections, qualify_questions, close_script, keywords, priority, enabled, updated_at)
    VALUES (@id, @name, @target, @usp, @pricing_note, @objections, @qualify_questions, @close_script, @keywords, @priority, @enabled, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, target=excluded.target, usp=excluded.usp, pricing_note=excluded.pricing_note,
      objections=excluded.objections, qualify_questions=excluded.qualify_questions, close_script=excluded.close_script,
      keywords=excluded.keywords, priority=excluded.priority, enabled=excluded.enabled, updated_at=unixepoch()`),
  delProduct: db.prepare(`DELETE FROM products WHERE id=?`),
};

module.exports = { db, stmts };
