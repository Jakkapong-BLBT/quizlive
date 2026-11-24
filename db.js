// ชั้นฐานข้อมูล — ใช้ PostgreSQL (เช่น Neon) ผ่านตัวแปร DATABASE_URL
// ถ้าไม่ได้ตั้ง DATABASE_URL จะใช้ฐานข้อมูลในหน่วยความจำ (ข้อมูลหายเมื่อรีสตาร์ต — ใช้ทดสอบเท่านั้น)
const crypto = require('crypto');

let pool, persistent = false;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL.trim();
  const local = /localhost|127\.0\.0\.1/.test(url);
  pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 30000 });
  pool.on('error', e => console.error('DB pool error:', e.message));
  persistent = true;
} else {
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  console.warn('⚠️  ยังไม่ได้ตั้ง DATABASE_URL — ใช้ฐานข้อมูลชั่วคราวในหน่วยความจำ ข้อมูลจะหายเมื่อเซิร์ฟเวอร์รีสตาร์ต');
}

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

async function init() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
    must_change BOOLEAN NOT NULL DEFAULT true, created_at BIGINT NOT NULL, last_login BIGINT)`);
  await q(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at BIGINT NOT NULL)`);
  await q(`CREATE TABLE IF NOT EXISTS quizzes (
    id SERIAL PRIMARY KEY, owner_id INTEGER NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`);
  await q(`CREATE TABLE IF NOT EXISTS games (
    id SERIAL PRIMARY KEY, owner_id INTEGER NOT NULL, quiz_title TEXT NOT NULL, pin TEXT NOT NULL,
    player_count INTEGER NOT NULL, question_count INTEGER NOT NULL, played_at BIGINT NOT NULL, report TEXT NOT NULL)`);
  await bootstrapSuper();
}

/* ---------- รหัสผ่าน (scrypt + salt) ---------- */
function hashPassword(pw) {
  return new Promise((res, rej) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 64, (e, key) => e ? rej(e) : res(`scrypt$${salt.toString('hex')}$${key.toString('hex')}`));
  });
}
function verifyPassword(pw, stored) {
  return new Promise(res => {
    const [alg, saltHex, keyHex] = String(stored).split('$');
    if (alg !== 'scrypt' || !saltHex || !keyHex) return res(false);
    crypto.scrypt(pw, Buffer.from(saltHex, 'hex'), 64, (e, key) => {
      if (e) return res(false);
      const k = Buffer.from(keyHex, 'hex');
      res(k.length === key.length && crypto.timingSafeEqual(k, key));
    });
  });
}

/* ---------- Super Admin เริ่มต้น ---------- */
async function bootstrapSuper() {
  const uname = (process.env.SUPER_ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const pw = process.env.SUPER_ADMIN_PASSWORD || '';
  const supers = await q(`SELECT id, username FROM users WHERE role = 'super'`);
  if (!supers.length) {
    if (!pw) {
      console.warn('⚠️  ยังไม่มีบัญชี Super Admin — ตั้งตัวแปร SUPER_ADMIN_PASSWORD (และ SUPER_ADMIN_USERNAME) แล้วรีสตาร์ต');
      return;
    }
    const existing = await q(`SELECT id FROM users WHERE username = $1`, [uname]);
    const h = await hashPassword(pw);
    if (existing.length) await q(`UPDATE users SET role = 'super', password_hash = $1, active = true WHERE id = $2`, [h, existing[0].id]);
    else await q(`INSERT INTO users (username, display_name, password_hash, role, active, must_change, created_at) VALUES ($1, $2, $3, 'super', true, false, $4)`, [uname, 'Super Admin', h, Date.now()]);
    console.log(`✅ สร้างบัญชี Super Admin "${uname}" แล้ว`);
  } else if (process.env.RESET_SUPER_PASSWORD === '1' && pw) {
    // ใช้เมื่อลืมรหัส Super Admin: ตั้ง RESET_SUPER_PASSWORD=1 ชั่วคราว แล้วลบออกหลังเข้าได้
    const h = await hashPassword(pw);
    await q(`UPDATE users SET password_hash = $1, active = true WHERE id = $2`, [h, supers[0].id]);
    console.log(`🔑 รีเซ็ตรหัสผ่าน Super Admin "${supers[0].username}" แล้ว — อย่าลืมลบ RESET_SUPER_PASSWORD`);
  }
}

/* ---------- Session ---------- */
const SESSION_MS = 7 * 24 * 3600e3;
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`, [token, userId, Date.now() + SESSION_MS]);
  return token;
}
async function userFromToken(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const s = await q(`SELECT user_id, expires_at FROM sessions WHERE token = $1`, [token]);
  if (!s.length || Number(s[0].expires_at) < Date.now()) return null;
  const u = await q(`SELECT id, username, display_name, role, active, must_change FROM users WHERE id = $1`, [s[0].user_id]);
  if (!u.length || !u[0].active) return null;
  return u[0];
}
const deleteSession = token => q(`DELETE FROM sessions WHERE token = $1`, [token]);
const deleteUserSessions = (userId, exceptToken = '') => q(`DELETE FROM sessions WHERE user_id = $1 AND token <> $2`, [userId, exceptToken]);
const purgeSessions = () => q(`DELETE FROM sessions WHERE expires_at < $1`, [Date.now()]);

module.exports = { q, init, hashPassword, verifyPassword, createSession, userFromToken, deleteSession, deleteUserSessions, purgeSessions, persistent: () => persistent };
