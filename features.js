// วงล้อสุ่มโชค + แบบประเมิน
const crypto = require('crypto');

module.exports = function features(app, db, needAuth, wrap) {
  const owners = async () => { const m = {}; (await db.q(`SELECT id, display_name FROM users`)).forEach(u => m[u.id] = u.display_name); return m; };
  const canSee = (user, row) => row && (user.role === 'super' || row.owner_id === user.id);
  const cleanName = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const now = () => Date.now();

  // คิวงานต่อ 1 รายการ: กันข้อมูลทับกันเมื่อหลายคนลงชื่อพร้อมกัน
  const queues = new Map();
  function serial(key, fn) {
    const prev = queues.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    queues.set(key, run.finally(() => { if (queues.get(key) === run) queues.delete(key); }));
    return run;
  }

  /* =================== วงล้อสุ่มโชค =================== */
  function cleanWheel(b, old = {}) {
    const entries = [];
    const seen = new Set();
    for (const e of (Array.isArray(b.entries) ? b.entries : old.entries || []).slice(0, 3000)) {
      const n = cleanName(e); if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); entries.push(n); }
    }
    const prizes = (Array.isArray(b.prizes) ? b.prizes : old.prizes || []).slice(0, 50)
      .map(p => ({ name: String(p?.name || '').trim().slice(0, 80), count: Math.min(500, Math.max(1, parseInt(p?.count) || 1)) }))
      .filter(p => p.name);
    return {
      entries, prizes,
      removeWinners: b.removeWinners !== undefined ? !!b.removeWinners : old.removeWinners !== false,
      round: old.round || 1,
    };
  }
  async function getWheel(user, id) {
    const r = (await db.q(`SELECT * FROM wheels WHERE id = $1`, [Number(id)]))[0];
    return canSee(user, r) ? { ...r, data: JSON.parse(r.data) } : null;
  }
  const roundDraws = (wheelId, round) => db.q(`SELECT * FROM draws WHERE wheel_id = $1 AND round = $2 ORDER BY id`, [wheelId, round]);
  const drawOut = d => ({ id: d.id, round: d.round, prize: d.prize, winner: d.winner, poolSize: d.pool_size, status: d.status, drawnAt: Number(d.drawn_at) });

  // รหัสลงชื่อผ่าน QR (เก็บในหน่วยความจำ — ปิดเมื่อเซิร์ฟเวอร์รีสตาร์ต)
  const regByCode = new Map(), regByWheel = new Map();
  function newCode() { let c; do { c = String(crypto.randomInt(100000, 1000000)); } while (regByCode.has(c)); return c; }

  function poolFor(w, draws) {
    const out = new Set(draws.filter(d => d.status === 'void' || w.data.removeWinners).map(d => d.winner.toLowerCase()));
    return w.data.entries.filter(n => !out.has(n.toLowerCase()));
  }
  function prizeStatus(w, draws) {
    return w.data.prizes.map(p => ({ ...p, drawn: draws.filter(d => d.prize === p.name && d.status === 'ok').length }));
  }

  app.get('/api/wheels', needAuth(), wrap(async (req, res) => {
    const u = req._user;
    const rows = u.role === 'super' ? await db.q(`SELECT * FROM wheels ORDER BY updated_at DESC`) : await db.q(`SELECT * FROM wheels WHERE owner_id = $1 ORDER BY updated_at DESC`, [u.id]);
    const o = await owners();
    res.json({ wheels: rows.map(r => { const d = JSON.parse(r.data); return { id: r.id, title: r.title, entryCount: d.entries.length, prizes: d.prizes, updated: Number(r.updated_at), ownerName: o[r.owner_id] || '-', mine: r.owner_id === u.id }; }) });
  }));
  app.post('/api/wheels', needAuth(), wrap(async (req, res) => {
    const title = String(req.body.title || 'วงล้อสุ่มโชค').trim().slice(0, 120) || 'วงล้อสุ่มโชค';
    const r = await db.q(`INSERT INTO wheels (owner_id, title, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $4) RETURNING id`, [req._user.id, title, JSON.stringify(cleanWheel(req.body)), now()]);
    res.json({ ok: true, id: r[0].id });
  }));
  app.get('/api/wheels/:id', needAuth(), wrap(async (req, res) => {
    const w = await getWheel(req._user, req.params.id);
    if (!w) return res.status(404).json({ error: 'ไม่พบวงล้อ' });
    const draws = await roundDraws(w.id, w.data.round);
    res.json({
      id: w.id, title: w.title, ...w.data, prizes: prizeStatus(w, draws),
      draws: draws.map(drawOut), pool: poolFor(w, draws), regCode: regByWheel.get(w.id) || null,
    });
  }));
  app.put('/api/wheels/:id', needAuth(), wrap(async (req, res) => {
    await serial('w' + req.params.id, async () => {
      const w = await getWheel(req._user, req.params.id);
      if (!w) return res.status(404).json({ error: 'ไม่พบวงล้อ' });
      const title = String(req.body.title ?? w.title).trim().slice(0, 120) || 'วงล้อสุ่มโชค';
      const data = cleanWheel(req.body, w.data);
      await db.q(`UPDATE wheels SET title = $1, data = $2, updated_at = $3 WHERE id = $4`, [title, JSON.stringify(data), now(), w.id]);
      res.json({ ok: true });
    });
  }));
  app.delete('/api/wheels/:id', needAuth(), wrap(async (req, res) => {
    const w = await getWheel(req._user, req.params.id);
    if (!w) return res.status(404).json({ error: 'ไม่พบวงล้อ' });
    const c = regByWheel.get(w.id); if (c) { regByCode.delete(c); regByWheel.delete(w.id); }
    await db.q(`DELETE FROM draws WHERE wheel_id = $1`, [w.id]);
    await db.q(`DELETE FROM wheels WHERE id = $1`, [w.id]);
    res.json({ ok: true });
  }));
  // สุ่ม — ทำบนเซิร์ฟเวอร์ด้วย crypto.randomInt ผลแก้ไขไม่ได้ และบันทึกทุกครั้ง
  app.post('/api/wheels/:id/draw', needAuth(), wrap(async (req, res) => {
    await serial('w' + req.params.id, async () => {
      const w = await getWheel(req._user, req.params.id);
      if (!w) return res.status(404).json({ error: 'ไม่พบวงล้อ' });
      const draws = await roundDraws(w.id, w.data.round);
      const pool = poolFor(w, draws);
      if (!pool.length) return res.status(400).json({ error: 'ไม่มีรายชื่อเหลือให้สุ่มแล้ว' });
      let prize = String(req.body.prize || '').trim().slice(0, 80);
      if (prize) {
        const ps = prizeStatus(w, draws).find(p => p.name === prize);
        if (ps && ps.drawn >= ps.count) return res.status(400).json({ error: `รางวัล “${prize}” ครบจำนวนแล้ว` });
      } else prize = '-';
      const idx = crypto.randomInt(0, pool.length);
      const r = await db.q(`INSERT INTO draws (wheel_id, owner_id, round, prize, winner, pool_size, status, drawn_by, drawn_at) VALUES ($1, $2, $3, $4, $5, $6, 'ok', $7, $8) RETURNING id`,
        [w.id, w.owner_id, w.data.round, prize, pool[idx], pool.length, req._user.id, now()]);
      res.json({ ok: true, pool, index: idx, winner: pool[idx], drawId: r[0].id, prize });
    });
  }));
  // สละสิทธิ์ (ไม่อยู่ในงาน) → ไม่นับรางวัลนี้ และตัดชื่อออกจากรอบนี้
  app.post('/api/wheels/:id/draws/:drawId/void', needAuth(), wrap(async (req, res) => {
    const w = await getWheel(req._user, req.params.id);
    if (!w) return res.status(404).json({ error: 'ไม่พบวงล้อ' });
    await db.q(`UPDATE draws SET status = 'void' WHERE id = $1 AND wheel_id = $2`, [Number(req.params.drawId), w.id]);
    res.json({ ok: true });
  }));
  app.post('/api/wheels/:id/new-round', needAuth(), wrap(async (req, res) => {
    await serial('w' + req.params.id, async () => {
      const w = await getWheel(req._user, req.params.id);
      if (!w) return res.status(404).json({ error: 'ไม่พบวงล้อ' });
      w.data.round = (w.data.round || 1) + 1;
      await db.q(`UPDATE wheels SET data = $1, updated_at = $2 WHERE id = $3`, [JSON.stringify(w.data), now(), w.id]);
      res.json({ ok: true, round: w.data.round });
    });
  }));
  app.get('/api/wheels/:id/history', needAuth(), wrap(async (req, res) => {
    const w = await getWheel(req._user, req.params.id);
    if (!w) return res.status(404).json({ error: 'ไม่พบวงล้อ' });
    const rows = await db.q(`SELECT * FROM draws WHERE wheel_id = $1 ORDER BY id`, [w.id]);
    const o = await owners();
    res.json({ title: w.title, draws: rows.map(d => ({ ...drawOut(d), drawnBy: o[d.drawn_by] || '-' })) });
  }));
  app.post('/api/wheels/:id/registration', needAuth(), wrap(async (req, res) => {
    const w = await getWheel(req._user, req.params.id);
    if (!w) return res.status(404).json({ error: 'ไม่พบวงล้อ' });
    const old = regByWheel.get(w.id);
    if (req.body.open) {
      const code = old || newCode();
      regByCode.set(code, w.id); regByWheel.set(w.id, code);
      return res.json({ ok: true, code });
    }
    if (old) { regByCode.delete(old); regByWheel.delete(w.id); }
    res.json({ ok: true, code: null });
  }));
  // หน้าสาธารณะ: ลงชื่อร่วมลุ้น (ไม่ต้องล็อกอิน)
  app.get('/api/public/wheel/:code', wrap(async (req, res) => {
    const id = regByCode.get(String(req.params.code));
    if (!id) return res.status(404).json({ error: 'ปิดรับลงชื่อแล้ว หรือรหัสไม่ถูกต้อง' });
    const r = (await db.q(`SELECT title FROM wheels WHERE id = $1`, [id]))[0];
    res.json({ title: r ? r.title : '' });
  }));
  app.post('/api/public/wheel/:code/join', wrap(async (req, res) => {
    const id = regByCode.get(String(req.params.code));
    if (!id) return res.status(404).json({ error: 'ปิดรับลงชื่อแล้ว หรือรหัสไม่ถูกต้อง' });
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'กรุณาใส่ชื่อ' });
    await serial('w' + id, async () => {
      const r = (await db.q(`SELECT data FROM wheels WHERE id = $1`, [id]))[0];
      if (!r) return res.status(404).json({ error: 'ไม่พบวงล้อ' });
      const d = JSON.parse(r.data);
      if (d.entries.some(e => e.toLowerCase() === name.toLowerCase())) return res.json({ ok: true, already: true, name });
      if (d.entries.length >= 3000) return res.status(400).json({ error: 'จำนวนผู้ลงชื่อเต็มแล้ว' });
      d.entries.push(name);
      await db.q(`UPDATE wheels SET data = $1, updated_at = $2 WHERE id = $3`, [JSON.stringify(d), now(), id]);
      res.json({ ok: true, name });
    });
  }));

  /* =================== แบบประเมิน =================== */
  const TYPES = ['rating', 'choice', 'multi', 'text'];
  function cleanForm(b) {
    const questions = (Array.isArray(b.questions) ? b.questions : []).slice(0, 60).map(q => ({
      type: TYPES.includes(q?.type) ? q.type : 'rating',
      text: String(q?.text || '').trim().slice(0, 300),
      options: (Array.isArray(q?.options) ? q.options : []).map(o => String(o || '').trim().slice(0, 150)).filter(Boolean).slice(0, 12),
      required: q?.required !== false,
    })).filter(q => q.text && (!['choice', 'multi'].includes(q.type) || q.options.length >= 2));
    return { description: String(b.description || '').trim().slice(0, 1000), questions, askName: b.askName !== false, nameRequired: !!b.nameRequired };
  }
  async function getForm(user, id) {
    const r = (await db.q(`SELECT * FROM forms WHERE id = $1`, [Number(id)]))[0];
    return canSee(user, r) ? { ...r, data: JSON.parse(r.data) } : null;
  }
  async function uniqueCode() {
    for (;;) { const c = String(crypto.randomInt(100000, 1000000)); if (!(await db.q(`SELECT id FROM forms WHERE code = $1`, [c])).length) return c; }
  }
  app.get('/api/forms', needAuth(), wrap(async (req, res) => {
    const u = req._user;
    const rows = u.role === 'super' ? await db.q(`SELECT * FROM forms ORDER BY updated_at DESC`) : await db.q(`SELECT * FROM forms WHERE owner_id = $1 ORDER BY updated_at DESC`, [u.id]);
    const counts = {}; (await db.q(`SELECT form_id FROM responses`)).forEach(r => counts[r.form_id] = (counts[r.form_id] || 0) + 1);
    const o = await owners();
    res.json({ forms: rows.map(r => ({ id: r.id, title: r.title, code: r.code, open: r.is_open, questionCount: JSON.parse(r.data).questions.length, responses: counts[r.id] || 0, updated: Number(r.updated_at), ownerName: o[r.owner_id] || '-', mine: r.owner_id === u.id })) });
  }));
  app.post('/api/forms', needAuth(), wrap(async (req, res) => {
    const title = String(req.body.title || 'แบบประเมิน').trim().slice(0, 150) || 'แบบประเมิน';
    const r = await db.q(`INSERT INTO forms (owner_id, title, data, code, is_open, created_at, updated_at) VALUES ($1, $2, $3, $4, false, $5, $5) RETURNING id`,
      [req._user.id, title, JSON.stringify(cleanForm(req.body)), await uniqueCode(), now()]);
    res.json({ ok: true, id: r[0].id });
  }));
  app.get('/api/forms/:id', needAuth(), wrap(async (req, res) => {
    const f = await getForm(req._user, req.params.id);
    if (!f) return res.status(404).json({ error: 'ไม่พบแบบประเมิน' });
    const resp = await db.q(`SELECT * FROM responses WHERE form_id = $1 ORDER BY id`, [f.id]);
    res.json({ id: f.id, title: f.title, code: f.code, open: f.is_open, ...f.data,
      responses: resp.map(r => ({ id: r.id, name: r.name, answers: JSON.parse(r.answers), at: Number(r.submitted_at) })) });
  }));
  app.put('/api/forms/:id', needAuth(), wrap(async (req, res) => {
    const f = await getForm(req._user, req.params.id);
    if (!f) return res.status(404).json({ error: 'ไม่พบแบบประเมิน' });
    const n = (await db.q(`SELECT id FROM responses WHERE form_id = $1`, [f.id])).length;
    const data = cleanForm(req.body);
    // ถ้ามีคำตอบแล้ว ห้ามเปลี่ยนจำนวน/ชนิดคำถาม (กันผลสรุปเพี้ยน) — แก้ได้เฉพาะข้อความ
    if (n && (data.questions.length !== f.data.questions.length || data.questions.some((q, i) => q.type !== f.data.questions[i].type || q.options.length !== f.data.questions[i].options.length)))
      return res.status(400).json({ error: `มีผู้ตอบแล้ว ${n} คน — แก้ได้เฉพาะข้อความ ถ้าต้องการเพิ่ม/ลบคำถาม ให้ “ทำสำเนา” เป็นแบบประเมินใหม่` });
    const title = String(req.body.title || f.title).trim().slice(0, 150) || 'แบบประเมิน';
    await db.q(`UPDATE forms SET title = $1, data = $2, updated_at = $3 WHERE id = $4`, [title, JSON.stringify(data), now(), f.id]);
    res.json({ ok: true });
  }));
  app.post('/api/forms/:id/open', needAuth(), wrap(async (req, res) => {
    const f = await getForm(req._user, req.params.id);
    if (!f) return res.status(404).json({ error: 'ไม่พบแบบประเมิน' });
    if (req.body.open && !f.data.questions.length) return res.status(400).json({ error: 'ยังไม่มีคำถาม' });
    await db.q(`UPDATE forms SET is_open = $1 WHERE id = $2`, [!!req.body.open, f.id]);
    res.json({ ok: true });
  }));
  app.delete('/api/forms/:id/responses', needAuth(), wrap(async (req, res) => {
    const f = await getForm(req._user, req.params.id);
    if (!f) return res.status(404).json({ error: 'ไม่พบแบบประเมิน' });
    await db.q(`DELETE FROM responses WHERE form_id = $1`, [f.id]);
    res.json({ ok: true });
  }));
  app.delete('/api/forms/:id', needAuth(), wrap(async (req, res) => {
    const f = await getForm(req._user, req.params.id);
    if (!f) return res.status(404).json({ error: 'ไม่พบแบบประเมิน' });
    await db.q(`DELETE FROM responses WHERE form_id = $1`, [f.id]);
    await db.q(`DELETE FROM forms WHERE id = $1`, [f.id]);
    res.json({ ok: true });
  }));
  // หน้าสาธารณะ: ตอบแบบประเมิน
  app.get('/api/public/form/:code', wrap(async (req, res) => {
    const r = (await db.q(`SELECT * FROM forms WHERE code = $1`, [String(req.params.code)]))[0];
    if (!r) return res.status(404).json({ error: 'ไม่พบแบบประเมิน กรุณาตรวจสอบลิงก์' });
    res.json({ title: r.title, open: r.is_open, ...JSON.parse(r.data) });
  }));
  app.post('/api/public/form/:code/submit', wrap(async (req, res) => {
    const r = (await db.q(`SELECT * FROM forms WHERE code = $1`, [String(req.params.code)]))[0];
    if (!r) return res.status(404).json({ error: 'ไม่พบแบบประเมิน' });
    if (!r.is_open) return res.status(400).json({ error: 'แบบประเมินนี้ปิดรับคำตอบแล้ว' });
    const d = JSON.parse(r.data);
    const name = d.askName ? cleanName(req.body.name) : '';
    if (d.askName && d.nameRequired && !name) return res.status(400).json({ error: 'กรุณาใส่ชื่อ' });
    const inA = Array.isArray(req.body.answers) ? req.body.answers : [];
    const answers = [];
    for (let i = 0; i < d.questions.length; i++) {
      const q = d.questions[i], a = inA[i];
      let v = null;
      if (q.type === 'rating') { const n = parseInt(a); v = n >= 1 && n <= 5 ? n : null; }
      if (q.type === 'choice') { const n = parseInt(a); v = Number.isInteger(n) && n >= 0 && n < q.options.length ? n : null; }
      if (q.type === 'multi') { v = [...new Set((Array.isArray(a) ? a : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < q.options.length))]; if (!v.length) v = null; }
      if (q.type === 'text') { v = String(a || '').trim().slice(0, 2000) || null; }
      if (v === null && q.required) return res.status(400).json({ error: `กรุณาตอบข้อ ${i + 1}`, index: i });
      answers.push(v);
    }
    await db.q(`INSERT INTO responses (form_id, name, answers, submitted_at) VALUES ($1, $2, $3, $4)`, [r.id, name, JSON.stringify(answers), now()]);
    res.json({ ok: true });
  }));
};
