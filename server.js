// QuizLive — ระบบตอบคำถามแบบเรียลไทม์ (คล้าย Kahoot / AhaSlides)
// รัน: npm install && npm start  แล้วเปิด http://localhost:3000/host.html
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PREVIEW_MS = 3000;          // เวลาแสดงคำถามก่อนเปิดให้ตอบ
const GRACE_MS = 600;             // เผื่อความหน่วงเครือข่าย
const GAME_TTL_MS = 6 * 3600e3;   // ลบเกมทิ้งหลัง 6 ชั่วโมง

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000, maxHttpBufferSize: 5e6 });
app.set('trust proxy', 1);
app.use(express.json({ limit: '6mb' }));

/* ---------- คุกกี้ / ผู้ใช้ปัจจุบัน ---------- */
const COOKIE = 'ql_sid';
function readCookie(header, name) {
  const m = String(header || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function setSessionCookie(req, res, tok) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}${secure ? '; Secure' : ''}`);
}
const clearCookie = res => res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
async function currentUser(req) {
  if (req._user !== undefined) return req._user;
  req._user = await db.userFromToken(readCookie(req.headers.cookie, COOKIE)).catch(() => null);
  return req._user;
}
const wrap = fn => (req, res, next) => fn(req, res, next).catch(e => { console.error(e); res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ ลองใหม่อีกครั้ง' }); });
const needAuth = (superOnly = false) => wrap(async (req, res, next) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  if (superOnly && u.role !== 'super') return res.status(403).json({ error: 'เฉพาะ Super Admin' });
  if (u.must_change && !['/api/me', '/api/change-password', '/api/logout'].includes(req.path)) return res.status(403).json({ error: 'กรุณาเปลี่ยนรหัสผ่านก่อนใช้งาน', mustChange: true });
  next();
});
// ป้องกันการส่งฟอร์มข้ามเว็บ: คำสั่งที่เปลี่ยนข้อมูลต้องเป็น JSON เท่านั้น
app.use('/api', (req, res, next) => {
  // DELETE ส่งข้ามเว็บด้วยฟอร์มไม่ได้ (เบราว์เซอร์บังคับตรวจ CORS) จึงไม่ต้องมีข้อมูลแนบ
  if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'รูปแบบคำขอไม่ถูกต้อง' });
  next();
});
const pub = u => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, active: u.active, mustChange: u.must_change, lastLogin: u.last_login ? Number(u.last_login) : null, createdAt: u.created_at ? Number(u.created_at) : null,
  expiresAt: u.expires_at !== null && u.expires_at !== undefined ? Number(u.expires_at) : null, expired: db.isExpired(u), hasRecovery: !!u.recovery_hash });
const thDate = t => new Date(t).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'long', timeStyle: 'short' });
// วันหมดอายุ: null = ไม่จำกัด, ตัวเลข = เวลา (ms) ต้องอยู่ในอนาคต และไม่เกิน 5 ปี
function parseExpiry(v) {
  if (v === null || v === '' || v === undefined) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < Date.now() || n > Date.now() + 5 * 365 * 864e5) return { ok: false };
  return { ok: true, value: Math.round(n) };
}
const validUsername = s => /^[a-z0-9._-]{3,30}$/.test(s);
const validPassword = s => typeof s === 'string' && s.length >= 8 && s.length <= 100;

/* ---------- กันเดารหัส: ผิด 5 ครั้ง ล็อก 5 นาที ---------- */
const fails = new Map();
function lockedFor(key) { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; }
function addFail(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60e3; f.n = 0; }
  fails.set(key, f);
}

/* ---------- เข้าสู่ระบบ ---------- */
app.post('/api/login', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = username + '|' + req.ip;
  const lock = lockedFor(key);
  if (lock) return res.status(429).json({ error: `ใส่รหัสผิดหลายครั้ง กรุณารอ ${lock} นาที` });
  const rows = await db.q(`SELECT * FROM users WHERE username = $1`, [username]);
  const u = rows[0];
  const ok = u ? await db.verifyPassword(password, u.password_hash) : (await db.verifyPassword(password, 'scrypt$00$00'), false);
  if (!u || !ok) { addFail(key); return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }); }
  if (!u.active) return res.status(403).json({ error: 'บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ' });
  if (db.isExpired(u)) return res.status(403).json({ error: `บัญชีนี้หมดอายุเมื่อ ${thDate(Number(u.expires_at))} กรุณาติดต่อผู้ดูแลระบบเพื่อต่ออายุ` });
  fails.delete(key);
  await db.q(`UPDATE users SET last_login = $1 WHERE id = $2`, [Date.now(), u.id]);
  setSessionCookie(req, res, await db.createSession(u.id));
  res.json({ ok: true, user: pub(u) });
}));
app.post('/api/logout', wrap(async (req, res) => {
  const tok = readCookie(req.headers.cookie, COOKIE);
  if (tok) await db.deleteSession(tok);
  clearCookie(res); res.json({ ok: true });
}));
app.get('/api/me', wrap(async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  res.json({ user: pub(u), persistent: db.persistent() });
}));
app.post('/api/change-password', needAuth(), wrap(async (req, res) => {
  const u = req._user;
  const { current, next: nw } = req.body;
  const row = (await db.q(`SELECT password_hash FROM users WHERE id = $1`, [u.id]))[0];
  if (!(await db.verifyPassword(String(current || ''), row.password_hash))) return res.status(400).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
  if (!validPassword(nw)) return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร' });
  if (nw === current) return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม' });
  await db.q(`UPDATE users SET password_hash = $1, must_change = false WHERE id = $2`, [await db.hashPassword(nw), u.id]);
  await db.deleteUserSessions(u.id, readCookie(req.headers.cookie, COOKIE));
  // ยังไม่มีรหัสกู้คืน → ออกให้ทันที (แสดงครั้งเดียว)
  const recoveryCode = u.recovery_hash ? null : await db.setRecoveryCode(u.id);
  res.json({ ok: true, recoveryCode });
}));
// สร้างรหัสกู้คืนใหม่ (ต้องยืนยันรหัสผ่านปัจจุบัน) — รหัสเก่าใช้ไม่ได้ทันที
app.post('/api/recovery-code', needAuth(), wrap(async (req, res) => {
  const row = (await db.q(`SELECT password_hash FROM users WHERE id = $1`, [req._user.id]))[0];
  if (!(await db.verifyPassword(String(req.body.password || ''), row.password_hash))) return res.status(400).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  res.json({ ok: true, recoveryCode: await db.setRecoveryCode(req._user.id) });
}));
// ลืมรหัสผ่าน: ชื่อผู้ใช้ + รหัสกู้คืน → ตั้งรหัสใหม่เอง (รหัสกู้คืนเดิมถูกใช้แล้ว ระบบออกรหัสใหม่ให้)
app.post('/api/forgot-password', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const key = 'rc|' + username + '|' + req.ip;
  const lock = lockedFor(key);
  if (lock) return res.status(429).json({ error: `ลองผิดหลายครั้ง กรุณารอ ${lock} นาที` });
  const nw = req.body.next;
  if (!validPassword(nw)) return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร' });
  const u = (await db.q(`SELECT * FROM users WHERE username = $1`, [username]))[0];
  const ok = u ? await db.verifyRecovery(req.body.code, u.recovery_hash) : (await db.verifyPassword('x', 'scrypt$00$00'), false);
  if (!u || !ok) { addFail(key); return res.status(400).json({ error: 'ชื่อผู้ใช้หรือรหัสกู้คืนไม่ถูกต้อง' }); }
  if (!u.active) return res.status(403).json({ error: 'บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ' });
  if (db.isExpired(u)) return res.status(403).json({ error: `บัญชีนี้หมดอายุแล้ว กรุณาติดต่อผู้ดูแลระบบเพื่อต่ออายุ` });
  fails.delete(key);
  await db.q(`UPDATE users SET password_hash = $1, must_change = false WHERE id = $2`, [await db.hashPassword(nw), u.id]);
  await db.deleteUserSessions(u.id);
  res.json({ ok: true, recoveryCode: await db.setRecoveryCode(u.id) });
}));

/* ---------- จัดการผู้ใช้ (Super Admin) ---------- */
app.get('/api/users', needAuth(true), wrap(async (req, res) => {
  const users = await db.q(`SELECT * FROM users ORDER BY id`);
  const quizzes = await db.q(`SELECT owner_id FROM quizzes`);
  const games = await db.q(`SELECT owner_id FROM games`);
  const count = (arr, id) => arr.filter(x => x.owner_id === id).length;
  res.json({ users: users.map(u => ({ ...pub(u), quizCount: count(quizzes, u.id), gameCount: count(games, u.id) })) });
}));
app.post('/api/users', needAuth(true), wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const displayName = String(req.body.displayName || '').trim().slice(0, 60);
  const password = String(req.body.password || '');
  const role = req.body.role === 'super' ? 'super' : 'organizer';
  const exp = parseExpiry(req.body.expiresAt);
  if (!exp.ok) return res.status(400).json({ error: 'วันหมดอายุไม่ถูกต้อง (ต้องเป็นวันในอนาคต)' });
  if (!validUsername(username)) return res.status(400).json({ error: 'ชื่อผู้ใช้ต้องเป็น a-z, 0-9, จุด, ขีด ยาว 3–30 ตัว (ภาษาอังกฤษ)' });
  if (!displayName) return res.status(400).json({ error: 'กรุณาใส่ชื่อที่แสดง' });
  if (!validPassword(password)) return res.status(400).json({ error: 'รหัสผ่านชั่วคราวต้องยาวอย่างน้อย 8 ตัวอักษร' });
  if ((await db.q(`SELECT id FROM users WHERE username = $1`, [username])).length) return res.status(400).json({ error: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' });
  await db.q(`INSERT INTO users (username, display_name, password_hash, role, active, must_change, created_at, expires_at) VALUES ($1, $2, $3, $4, true, true, $5, $6)`,
    [username, displayName, await db.hashPassword(password), role, Date.now(), exp.value]);
  res.json({ ok: true });
}));
app.patch('/api/users/:id', needAuth(true), wrap(async (req, res) => {
  const id = Number(req.params.id), me = req._user;
  const u = (await db.q(`SELECT * FROM users WHERE id = $1`, [id]))[0];
  if (!u) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  const b = req.body;
  if (id === me.id && (b.active === false || b.role === 'organizer')) return res.status(400).json({ error: 'ไม่สามารถระงับหรือลดสิทธิ์บัญชีของตัวเองได้' });
  if (b.displayName !== undefined) {
    const dn = String(b.displayName).trim().slice(0, 60);
    if (!dn) return res.status(400).json({ error: 'กรุณาใส่ชื่อที่แสดง' });
    await db.q(`UPDATE users SET display_name = $1 WHERE id = $2`, [dn, id]);
  }
  if (b.role !== undefined) await db.q(`UPDATE users SET role = $1 WHERE id = $2`, [b.role === 'super' ? 'super' : 'organizer', id]);
  if (b.expiresAt !== undefined) {
    if (id === me.id && b.expiresAt !== null) return res.status(400).json({ error: 'ไม่สามารถกำหนดวันหมดอายุให้บัญชีของตัวเองได้' });
    const exp = parseExpiry(b.expiresAt);
    if (!exp.ok) return res.status(400).json({ error: 'วันหมดอายุไม่ถูกต้อง (ต้องเป็นวันในอนาคต)' });
    await db.q(`UPDATE users SET expires_at = $1 WHERE id = $2`, [exp.value, id]);
  }
  if (b.active !== undefined) {
    await db.q(`UPDATE users SET active = $1 WHERE id = $2`, [!!b.active, id]);
    if (!b.active) await db.deleteUserSessions(id);
  }
  if (b.password !== undefined) {
    if (!validPassword(b.password)) return res.status(400).json({ error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร' });
    await db.q(`UPDATE users SET password_hash = $1, must_change = true WHERE id = $2`, [await db.hashPassword(b.password), id]);
    await db.deleteUserSessions(id);
  }
  res.json({ ok: true });
}));
app.delete('/api/users/:id', needAuth(true), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req._user.id) return res.status(400).json({ error: 'ไม่สามารถลบบัญชีของตัวเองได้' });
  // แบบทดสอบและประวัติเกมของผู้ใช้ที่ถูกลบ จะโอนมาเป็นของ Super Admin ที่ลบ เพื่อไม่ให้ข้อมูลหาย
  await db.q(`UPDATE quizzes SET owner_id = $1 WHERE owner_id = $2`, [req._user.id, id]);
  await db.q(`UPDATE games SET owner_id = $1 WHERE owner_id = $2`, [req._user.id, id]);
  await db.deleteUserSessions(id);
  await db.q(`DELETE FROM users WHERE id = $1`, [id]);
  res.json({ ok: true });
}));

/* ---------- แบบทดสอบ ---------- */
async function ownersMap() {
  const m = {}; (await db.q(`SELECT id, display_name FROM users`)).forEach(u => m[u.id] = u.display_name); return m;
}
async function quizFor(user, id) {
  const r = (await db.q(`SELECT * FROM quizzes WHERE id = $1`, [Number(id)]))[0];
  if (!r || (user.role !== 'super' && r.owner_id !== user.id)) return null;
  return r;
}
app.get('/api/quizzes', needAuth(), wrap(async (req, res) => {
  const u = req._user;
  const rows = u.role === 'super' ? await db.q(`SELECT * FROM quizzes ORDER BY updated_at DESC`) : await db.q(`SELECT * FROM quizzes WHERE owner_id = $1 ORDER BY updated_at DESC`, [u.id]);
  const owners = await ownersMap();
  res.json({ quizzes: rows.map(r => ({ id: r.id, title: r.title, questions: JSON.parse(r.data), updated: Number(r.updated_at), ownerId: r.owner_id, ownerName: owners[r.owner_id] || '-', mine: r.owner_id === u.id })) });
}));
app.post('/api/quizzes', needAuth(), wrap(async (req, res) => {
  const list = Array.isArray(req.body.quizzes) ? req.body.quizzes : [req.body];
  const ids = [];
  for (const item of list.slice(0, 100)) {
    const title = String(item.title || 'แบบทดสอบไม่มีชื่อ').slice(0, 120);
    const questions = Array.isArray(item.questions) ? item.questions.slice(0, 100) : [];
    const now = Date.now();
    const r = await db.q(`INSERT INTO quizzes (owner_id, title, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [req._user.id, title, JSON.stringify(questions), now, now]);
    ids.push(r[0].id);
  }
  res.json({ ok: true, ids, id: ids[0] });
}));
app.put('/api/quizzes/:id', needAuth(), wrap(async (req, res) => {
  const r = await quizFor(req._user, req.params.id);
  if (!r) return res.status(404).json({ error: 'ไม่พบแบบทดสอบ หรือไม่มีสิทธิ์แก้ไข' });
  const title = String(req.body.title || 'แบบทดสอบไม่มีชื่อ').slice(0, 120);
  const questions = Array.isArray(req.body.questions) ? req.body.questions.slice(0, 100) : [];
  await db.q(`UPDATE quizzes SET title = $1, data = $2, updated_at = $3 WHERE id = $4`, [title, JSON.stringify(questions), Date.now(), r.id]);
  res.json({ ok: true });
}));
app.delete('/api/quizzes/:id', needAuth(), wrap(async (req, res) => {
  const r = await quizFor(req._user, req.params.id);
  if (!r) return res.status(404).json({ error: 'ไม่พบแบบทดสอบ หรือไม่มีสิทธิ์ลบ' });
  await db.q(`DELETE FROM quizzes WHERE id = $1`, [r.id]);
  res.json({ ok: true });
}));

/* ---------- ประวัติผลเกม ---------- */
app.get('/api/games', needAuth(), wrap(async (req, res) => {
  const u = req._user;
  const rows = u.role === 'super'
    ? await db.q(`SELECT id, owner_id, quiz_title, pin, player_count, question_count, played_at FROM games ORDER BY played_at DESC`)
    : await db.q(`SELECT id, owner_id, quiz_title, pin, player_count, question_count, played_at FROM games WHERE owner_id = $1 ORDER BY played_at DESC`, [u.id]);
  const owners = await ownersMap();
  res.json({ games: rows.map(r => ({ id: r.id, title: r.quiz_title, pin: r.pin, players: r.player_count, questions: r.question_count, playedAt: Number(r.played_at), ownerName: owners[r.owner_id] || '-' })) });
}));
app.get('/api/games/:id', needAuth(), wrap(async (req, res) => {
  const r = (await db.q(`SELECT * FROM games WHERE id = $1`, [Number(req.params.id)]))[0];
  if (!r || (req._user.role !== 'super' && r.owner_id !== req._user.id)) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
  res.json({ id: r.id, title: r.quiz_title, playedAt: Number(r.played_at), players: r.player_count, report: JSON.parse(r.report) });
}));
app.delete('/api/games/:id', needAuth(), wrap(async (req, res) => {
  const r = (await db.q(`SELECT * FROM games WHERE id = $1`, [Number(req.params.id)]))[0];
  if (!r || (req._user.role !== 'super' && r.owner_id !== req._user.id)) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
  await db.q(`DELETE FROM games WHERE id = $1`, [r.id]);
  res.json({ ok: true });
}));

/* ---------- วงล้อสุ่มโชค + แบบประเมิน ---------- */
require('./features')(app, db, needAuth, wrap);

/* ---------- หน้าเว็บ: หน้าผู้จัดต้องล็อกอินก่อน ---------- */
const noCache = res => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
for (const page of ['host', 'wheel', 'forms']) {
  app.get(['/' + page, '/' + page + '.html'], wrap(async (req, res) => {
    if (!(await currentUser(req))) return res.redirect('/login.html');
    noCache(res); res.sendFile(path.join(__dirname, 'public', page + '.html'));
  }));
}
app.get(['/login', '/admin'], (req, res) => res.redirect('/login.html'));
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: noCache }));
app.get('/qr', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 500);
  if (!text) return res.status(400).end();
  try {
    const png = await QRCode.toBuffer(text, { width: 600, margin: 1 });
    res.type('png').send(png);
  } catch { res.status(500).end(); }
});
app.get('/health', (req, res) => res.json({ ok: true, games: games.size, db: db.persistent() ? 'postgres' : 'memory' }));

/** @type {Map<string, any>} */
const games = new Map();

function newPin() {
  let pin;
  do { pin = String(Math.floor(100000 + Math.random() * 900000)); } while (games.has(pin));
  return pin;
}
const token = () => crypto.randomBytes(16).toString('hex');

function cleanQuiz(q) {
  const title = String(q?.title || 'แบบทดสอบ').slice(0, 120);
  const questions = (Array.isArray(q?.questions) ? q.questions : []).slice(0, 100).map(x => {
    const options = (Array.isArray(x.options) ? x.options : []).slice(0, 4).map(o => String(o ?? '').slice(0, 150));
    let correct = (Array.isArray(x.correct) ? x.correct : [x.correct]).map(Number)
      .filter(i => Number.isInteger(i) && i >= 0 && i < options.length && options[i].trim() !== '');
    return {
      text: String(x.text || '').slice(0, 300),
      image: /^https?:\/\//.test(x.image || '') || /^data:image\//.test(x.image || '') ? String(x.image).slice(0, 3e6) : '',
      options,
      correct: [...new Set(correct)],
      time: Math.min(240, Math.max(5, Number(x.time) || 20)),
      points: [0, 1000, 2000].includes(Number(x.points)) ? Number(x.points) : 1000,
    };
  }).filter(x => x.text.trim() && x.options.filter(o => o.trim()).length >= 2 && x.correct.length);
  return { title, questions };
}

function ranking(game) {
  return [...game.players.values()]
    .sort((a, b) => b.score - a.score || a.totalTime - b.totalTime || a.joinedAt - b.joinedAt)
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score, correct: p.correctCount, streak: p.streak, connected: p.connected }));
}

function publicQuestion(game, withAnswer) {
  const q = game.quiz.questions[game.qIndex];
  return {
    index: game.qIndex, total: game.quiz.questions.length,
    text: q.text, image: q.image, options: q.options, time: q.time, points: q.points,
    multi: q.correct.length > 1,
    ...(withAnswer ? { correct: q.correct } : {}),
  };
}

function hostView(game) {
  const base = {
    pin: game.pin, title: game.quiz.title, state: game.state, locked: game.locked,
    showOnDevice: game.showOnDevice,
    players: [...game.players.values()].map(p => ({ id: p.id, name: p.name, connected: p.connected })),
    total: game.quiz.questions.length, qIndex: game.qIndex,
  };
  if (['preview', 'question', 'reveal'].includes(game.state)) {
    base.question = publicQuestion(game, game.state === 'reveal');
    base.answered = game.answers.size;
    base.openAt = game.openAt; base.endAt = game.endAt; base.now = Date.now();
  }
  if (game.state === 'reveal') {
    const q = game.quiz.questions[game.qIndex];
    const counts = q.options.map(() => 0);
    for (const a of game.answers.values()) counts[a.choice]++;
    base.counts = counts;
    base.correctCount = [...game.answers.values()].filter(a => a.correct).length;
  }
  if (['leaderboard', 'reveal', 'ended'].includes(game.state)) base.ranking = ranking(game);
  if (game.state === 'ended') { base.report = report(game); base.saved = !!game.saved; }
  return base;
}

function playerView(game, p) {
  const v = { pin: game.pin, title: game.quiz.title, state: game.state, name: p.name, score: p.score, total: game.quiz.questions.length, qIndex: game.qIndex };
  if (['preview', 'question'].includes(game.state)) {
    const q = publicQuestion(game, false);
    v.question = game.showOnDevice ? q : { ...q, text: '', image: '', options: q.options.map(() => '') };
    v.question.optionCount = q.options.length;
    v.question.nonEmpty = q.options.map(o => o.trim() !== '');
    v.openAt = game.openAt; v.endAt = game.endAt; v.now = Date.now();
    v.answered = game.answers.has(p.id);
  }
  if (game.state === 'reveal' || game.state === 'leaderboard' || game.state === 'ended') {
    const a = game.answers.get(p.id);
    const r = ranking(game);
    const me = r.find(x => x.id === p.id);
    v.rank = me?.rank; v.playerCount = r.length;
    v.streak = p.streak;
    if (game.state !== 'ended') {
      v.result = a ? { answered: true, correct: a.correct, points: a.points } : { answered: false, correct: false, points: 0 };
      const q = game.quiz.questions[game.qIndex];
      v.correctText = q.correct.map(i => q.options[i]).join(' / ');
      const ahead = r[(me?.rank || 1) - 2];
      v.behind = ahead ? { name: ahead.name, diff: ahead.score - p.score } : null;
    } else {
      v.correctCount = p.correctCount;
      v.podium = r.slice(0, 3).map(x => ({ name: x.name, score: x.score }));
    }
  }
  return v;
}

function report(game) {
  const qs = game.quiz.questions;
  return {
    questions: qs.map((q, i) => {
      const st = game.stats[i] || { answered: 0, correct: 0 };
      return { text: q.text, answered: st.answered, correct: st.correct };
    }),
    players: ranking(game).map(r => {
      const p = game.players.get(r.id);
      return { ...r, answers: qs.map((_, i) => p.answers[i] || null) };
    }),
  };
}

async function saveGame(game) {
  if (game.saved || !game.players.size) return;
  game.saved = true;
  try {
    const r = await db.q(`INSERT INTO games (owner_id, quiz_title, pin, player_count, question_count, played_at, report) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [game.ownerId, game.quiz.title, game.pin, game.players.size, game.quiz.questions.length, Date.now(), JSON.stringify(report(game))]);
    game.savedId = r[0].id;
  } catch (e) { game.saved = false; console.error('บันทึกผลไม่สำเร็จ:', e.message); }
}

function broadcast(game) {
  if (game.state === 'ended' && !game.saved) saveGame(game).then(() => { if (game.hostSocket) io.to(game.hostSocket).emit('host:saved', { ok: game.saved, id: game.savedId }); });
  if (game.hostSocket) io.to(game.hostSocket).emit('host:state', hostView(game));
  for (const p of game.players.values()) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('player:state', playerView(game, p));
  }
}
// ระหว่างช่วงตอบ ส่งเฉพาะจำนวนคนตอบให้ host (ไม่ต้องส่งทุกคน)
function pushAnswerCount(game) {
  if (game.hostSocket) io.to(game.hostSocket).emit('host:answered', { answered: game.answers.size, players: game.players.size });
}

function clearTimers(game) { clearTimeout(game.timer); game.timer = null; }

function startQuestion(game, index) {
  clearTimers(game);
  game.qIndex = index;
  game.answers = new Map();
  const q = game.quiz.questions[index];
  game.state = 'preview';
  game.openAt = Date.now() + PREVIEW_MS;
  game.endAt = game.openAt + q.time * 1000;
  broadcast(game);
  game.timer = setTimeout(() => {
    game.state = 'question';
    broadcast(game);
    game.timer = setTimeout(() => reveal(game), q.time * 1000 + GRACE_MS);
  }, PREVIEW_MS);
}

function reveal(game) {
  if (game.state !== 'question' && game.state !== 'preview') return;
  clearTimers(game);
  // ผู้ที่ไม่ตอบ → streak หลุด
  for (const p of game.players.values()) {
    if (!game.answers.has(p.id)) { p.streak = 0; p.answers[game.qIndex] = null; }
  }
  game.stats[game.qIndex] = {
    answered: game.answers.size,
    correct: [...game.answers.values()].filter(a => a.correct).length,
  };
  game.state = 'reveal';
  broadcast(game);
}

function next(game) {
  if (game.state === 'lobby') return startQuestion(game, 0);
  if (game.state === 'preview' || game.state === 'question') return reveal(game);
  if (game.state === 'reveal') {
    if (game.qIndex >= game.quiz.questions.length - 1) { game.state = 'ended'; game.endedAt = Date.now(); return broadcast(game); }
    game.state = 'leaderboard'; return broadcast(game);
  }
  if (game.state === 'leaderboard') return startQuestion(game, game.qIndex + 1);
}

io.on('connection', socket => {
  let role = null, game = null, player = null;

  socket.on('host:create', async (data, ack) => {
    try {
      const user = await db.userFromToken(readCookie(socket.handshake.headers.cookie, COOKIE));
      if (!user) return ack?.({ ok: false, error: 'หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่', auth: true });
      if (user.must_change) return ack?.({ ok: false, error: 'กรุณาเปลี่ยนรหัสผ่านก่อนใช้งาน' });
      const row = (await db.q(`SELECT * FROM quizzes WHERE id = $1`, [Number(data?.quizId)]))[0];
      if (!row || (user.role !== 'super' && row.owner_id !== user.id)) return ack?.({ ok: false, error: 'ไม่พบแบบทดสอบ' });
      const quiz = cleanQuiz({ title: row.title, questions: JSON.parse(row.data) });
      if (!quiz.questions.length) return ack?.({ ok: false, error: 'ยังไม่มีคำถามที่สมบูรณ์ (ต้องมีคำถาม ตัวเลือกอย่างน้อย 2 ข้อ และเฉลย)' });
      const pin = newPin();
      game = {
        pin, hostToken: token(), hostSocket: socket.id, quiz, state: 'lobby', qIndex: -1,
        players: new Map(), names: new Set(), answers: new Map(), stats: [], locked: false,
        showOnDevice: data?.showOnDevice !== false, createdAt: Date.now(), timer: null,
        ownerId: user.id, saved: false,
      };
      games.set(pin, game); role = 'host';
      ack?.({ ok: true, pin, hostToken: game.hostToken });
      broadcast(game);
    } catch (e) { console.error(e); ack?.({ ok: false, error: 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง' }); }
  });

  socket.on('host:rejoin', ({ pin, hostToken } = {}, ack) => {
    const g = games.get(String(pin));
    if (!g || g.hostToken !== hostToken) return ack?.({ ok: false });
    game = g; role = 'host'; g.hostSocket = socket.id;
    ack?.({ ok: true }); broadcast(g);
  });

  const hostOnly = fn => (...args) => { if (role === 'host' && game && game.hostSocket === socket.id) fn(...args); };
  socket.on('host:next', hostOnly(() => next(game)));
  socket.on('host:lock', hostOnly(v => { game.locked = !!v; broadcast(game); }));
  socket.on('host:device', hostOnly(v => { game.showOnDevice = !!v; broadcast(game); }));
  socket.on('host:kick', hostOnly(id => {
    const p = game.players.get(id); if (!p) return;
    game.players.delete(id); game.names.delete(p.name.toLowerCase());
    if (p.socketId) io.to(p.socketId).emit('player:kicked');
    broadcast(game);
  }));
  socket.on('host:end', hostOnly(() => {
    clearTimers(game);
    if (game.state === 'preview' || game.state === 'question') reveal(game);
    game.state = 'ended'; game.endedAt = Date.now(); broadcast(game);
  }));
  socket.on('host:close', hostOnly(() => {
    clearTimers(game);
    for (const p of game.players.values()) if (p.socketId) io.to(p.socketId).emit('player:closed');
    games.delete(game.pin); game = null; role = null;
  }));

  socket.on('player:join', ({ pin, name, playerId } = {}, ack) => {
    const g = games.get(String(pin || '').trim());
    if (!g) return ack?.({ ok: false, error: 'ไม่พบเกมนี้ กรุณาตรวจสอบ PIN' });
    // กลับเข้าเกมเดิม (รีเฟรช/เน็ตหลุด)
    if (playerId && g.players.has(playerId)) {
      const p = g.players.get(playerId);
      p.socketId = socket.id; p.connected = true;
      game = g; player = p; role = 'player';
      ack?.({ ok: true, playerId: p.id, name: p.name });
      socket.emit('player:state', playerView(g, p));
      if (g.hostSocket) io.to(g.hostSocket).emit('host:state', hostView(g));
      return;
    }
    if (!name) return ack?.({ ok: true, needName: true, title: g.quiz.title });
    if (g.state === 'ended') return ack?.({ ok: false, error: 'เกมนี้จบแล้ว' });
    if (g.locked) return ack?.({ ok: false, error: 'ผู้จัดล็อกห้องแล้ว ไม่สามารถเข้าร่วมได้' });
    const nm = String(name).replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!nm) return ack?.({ ok: false, error: 'กรุณาใส่ชื่อ' });
    if (g.names.has(nm.toLowerCase())) return ack?.({ ok: false, error: 'ชื่อนี้มีคนใช้แล้ว ลองชื่ออื่น' });
    if (g.players.size >= 500) return ack?.({ ok: false, error: 'ห้องเต็มแล้ว' });
    const p = {
      id: token(), name: nm, score: 0, streak: 0, correctCount: 0, totalTime: 0,
      answers: [], socketId: socket.id, connected: true, joinedAt: Date.now(),
    };
    g.players.set(p.id, p); g.names.add(nm.toLowerCase());
    game = g; player = p; role = 'player';
    ack?.({ ok: true, playerId: p.id, name: p.name });
    socket.emit('player:state', playerView(g, p));
    if (g.hostSocket) io.to(g.hostSocket).emit('host:state', hostView(g));
  });

  socket.on('player:answer', (choice, ack) => {
    if (role !== 'player' || !game || !player || !game.players.has(player.id)) return ack?.({ ok: false });
    const g = game, now = Date.now();
    if (g.state !== 'question' || now > g.endAt + GRACE_MS) return ack?.({ ok: false, error: 'หมดเวลา' });
    if (g.answers.has(player.id)) return ack?.({ ok: false, error: 'ตอบไปแล้ว' });
    const q = g.quiz.questions[g.qIndex];
    const c = Number(choice);
    if (!Number.isInteger(c) || c < 0 || c >= q.options.length || !q.options[c].trim()) return ack?.({ ok: false });
    const elapsed = Math.max(0, Math.min(q.time * 1000, now - g.openAt));
    const correct = q.correct.includes(c);
    // สูตรแบบ Kahoot: ตอบถูกเร็ว = คะแนนเต็ม, ช้าสุด = ครึ่งหนึ่ง
    const points = correct ? Math.round(q.points * (1 - (elapsed / (q.time * 1000)) / 2)) : 0;
    g.answers.set(player.id, { choice: c, correct, points, ms: elapsed });
    player.answers[g.qIndex] = { choice: c, correct, points, ms: elapsed };
    player.score += points;
    if (correct) { player.correctCount++; player.streak++; player.totalTime += elapsed; } else player.streak = 0;
    ack?.({ ok: true });
    pushAnswerCount(g);
    const active = [...g.players.values()].filter(p => p.connected).length;
    if (g.answers.size >= Math.max(1, active)) setTimeout(() => reveal(g), 400);
  });

  socket.on('disconnect', () => {
    if (role === 'player' && player && game) {
      if (player.socketId === socket.id) { player.connected = false; }
      if (game.hostSocket) io.to(game.hostSocket).emit('host:state', hostView(game));
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [pin, g] of games) if (now - g.createdAt > GAME_TTL_MS) { clearTimers(g); games.delete(pin); }
}, 10 * 60e3);

setInterval(() => db.purgeSessions().catch(() => {}), 3600e3);

db.init().then(() => {
  server.listen(PORT, () => {
    console.log(`QuizLive พร้อมใช้งาน → http://localhost:${PORT}/login.html (ผู้จัด)  |  http://localhost:${PORT}/ (ผู้เล่น)`);
  });
}).catch(e => { console.error('เชื่อมต่อฐานข้อมูลไม่สำเร็จ:', e.message); process.exit(1); });
