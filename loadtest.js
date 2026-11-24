// ทดสอบโหลด: จำลองผู้เล่น N คนเข้าเกมและตอบพร้อมกัน
// ใช้: node loadtest.js [จำนวนผู้เล่น] [URL] [ชื่อผู้ใช้] [รหัสผ่าน]
const { io } = require('socket.io-client');
const N = +process.argv[2] || 100;
const URL = process.argv[3] || 'http://localhost:3000';
const quiz = { title: 'Load test', questions: Array.from({ length: 3 }, (_, i) => ({ text: 'Q' + (i + 1), options: ['A', 'B', 'C', 'D'], correct: [i % 4], time: 10, points: 1000 })) };

const USER = process.argv[4] || process.env.QL_USER, PASS = process.argv[5] || process.env.QL_PASS;
(async () => {
  // เข้าสู่ระบบ + สร้างแบบทดสอบทดสอบโหลด
  const lr = await fetch(URL + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  if (!lr.ok) { console.log('เข้าสู่ระบบไม่สำเร็จ:', (await lr.json()).error); process.exit(1); }
  const cookie = lr.headers.get('set-cookie').split(';')[0];
  const cr = await (await fetch(URL + '/api/quizzes', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(quiz) })).json();
  const host = io(URL, { transports: ['websocket'], extraHeaders: { cookie } });
  const res = await new Promise(r => host.emit('host:create', { quizId: cr.id }, r));
  if (!res.ok) { console.log('สร้างห้องไม่สำเร็จ:', res.error); process.exit(1); }
  const { pin } = res;
  let hostState = null;
  host.on('host:state', s => { hostState = s; });
  console.log('PIN', pin);
  const t0 = Date.now();
  const players = await Promise.all(Array.from({ length: N }, (_, i) => new Promise(res => {
    const s = io(URL, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => s.emit('player:join', { pin, name: 'ผู้เล่น' + (i + 1) }, r => res({ s, ok: r.ok, i })));
    s.on('player:state', v => {
      s.last = v;
      if (v.state === 'question' && !v.answered && !s.sent) {
        s.sent = v.qIndex + 1;
        setTimeout(() => s.emit('player:answer', Math.floor(Math.random() * 4), a => { if (!a.ok) s.fail = (s.fail || 0) + 1; }), Math.random() * 4000);
      }
      if (v.state === 'preview') s.sent = 0;
    });
  })));
  console.log(`เข้าร่วม ${players.filter(p => p.ok).length}/${N} คน ใน ${Date.now() - t0} ms`);
  await new Promise(r => setTimeout(r, 300));
  console.log('host เห็นผู้เล่น', hostState.players.length);
  for (let q = 0; q < 3; q++) {
    host.emit('host:next'); // lobby/leaderboard -> question
    const tq = Date.now();
    while (hostState.state !== 'reveal') await new Promise(r => setTimeout(r, 50));
    console.log(`ข้อ ${q + 1}: ทุกคนตอบครบ → reveal ใน ${Date.now() - tq} ms, ตอบ ${hostState.counts.reduce((a, b) => a + b)} คน, ถูก ${hostState.correctCount}`);
    host.emit('host:next'); // -> leaderboard / ended
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('สถานะสุดท้าย', hostState.state, '| Top3:', hostState.ranking.slice(0, 3).map(r => `${r.name}=${r.score}`).join(', '));
  const endedPlayers = players.filter(p => p.s.last?.state === 'ended').length;
  console.log(`ผู้เล่นได้หน้าจบเกม ${endedPlayers}/${N}, ส่งคำตอบล้มเหลว ${players.reduce((a, p) => a + (p.s.fail || 0), 0)}`);
  const ranks = new Set(players.map(p => p.s.last?.rank));
  console.log('อันดับไม่ซ้ำกัน:', ranks.size === N);
  host.emit('host:close');
  await fetch(URL + '/api/quizzes/' + cr.id, { method: 'DELETE', headers: { cookie } });
  setTimeout(() => process.exit(0), 300);
})();
