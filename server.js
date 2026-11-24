// QuizLive — ระบบตอบคำถามแบบเรียลไทม์ (คล้าย Kahoot / AhaSlides)
// รัน: npm install && npm start  แล้วเปิด http://localhost:3000/host.html
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const PREVIEW_MS = 3000;          // เวลาแสดงคำถามก่อนเปิดให้ตอบ
const GRACE_MS = 600;             // เผื่อความหน่วงเครือข่าย
const GAME_TTL_MS = 6 * 3600e3;   // ลบเกมทิ้งหลัง 6 ชั่วโมง

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000, maxHttpBufferSize: 5e6 });

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'),
}));
app.get('/qr', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 500);
  if (!text) return res.status(400).end();
  try {
    const png = await QRCode.toBuffer(text, { width: 600, margin: 1 });
    res.type('png').send(png);
  } catch { res.status(500).end(); }
});
app.get('/health', (req, res) => res.json({ ok: true, games: games.size }));

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
  if (game.state === 'ended') base.report = report(game);
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

function broadcast(game) {
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

  socket.on('host:create', (data, ack) => {
    const quiz = cleanQuiz(data?.quiz);
    if (!quiz.questions.length) return ack?.({ ok: false, error: 'ยังไม่มีคำถามที่สมบูรณ์ (ต้องมีคำถาม ตัวเลือกอย่างน้อย 2 ข้อ และเฉลย)' });
    const pin = newPin();
    game = {
      pin, hostToken: token(), hostSocket: socket.id, quiz, state: 'lobby', qIndex: -1,
      players: new Map(), names: new Set(), answers: new Map(), stats: [], locked: false,
      showOnDevice: data?.showOnDevice !== false, createdAt: Date.now(), timer: null,
    };
    games.set(pin, game); role = 'host';
    socket.join('h:' + pin);
    ack?.({ ok: true, pin, hostToken: game.hostToken });
    broadcast(game);
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

server.listen(PORT, () => {
  console.log(`QuizLive พร้อมใช้งาน → http://localhost:${PORT}/host.html (ผู้จัด)  |  http://localhost:${PORT}/ (ผู้เล่น)`);
});
