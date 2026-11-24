// แถบเมนูร่วม + ฟังก์ชันช่วยเรียก API (ใช้ในหน้า wheel.html / forms.html)
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('th-TH');
const dt = t => new Date(t).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
let ME = null;

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let d = {}; try { d = await r.json(); } catch {}
  if (r.status === 401) { location.replace('/login.html'); throw new Error('กรุณาเข้าสู่ระบบ'); }
  if (d.mustChange) { location.replace('/host.html'); throw new Error(d.error); }
  if (!r.ok) throw new Error(d.error || 'เกิดข้อผิดพลาด');
  return d;
}
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name.replace(/[\\/:*?"<>|]/g, '_'); a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const toCsv = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');

async function bootNav(active) {
  const d = await api('GET', '/api/me');
  ME = d.user;
  if (ME.mustChange) { location.replace('/host.html'); return; }
  const tabs = [
    ['lib', '📚 แบบทดสอบ', '/host.html#lib'],
    ['hist', '📊 ประวัติผล', '/host.html#hist'],
    ['wheel', '🎡 วงล้อสุ่มโชค', '/wheel.html'],
    ['forms', '📝 แบบประเมิน', '/forms.html'],
    ...(ME.role === 'super' ? [['users', '👥 จัดการผู้ใช้', '/host.html#users']] : []),
  ];
  $('#nav').innerHTML = `<span class="brand">Quiz<b>Live</b></span>
    ${tabs.map(([k, t, h]) => `<a class="tab ${k === active ? 'on' : ''}" href="${h}">${t}</a>`).join('')}
    <span class="sp"></span>
    <span class="who">${esc(ME.displayName)} (${esc(ME.username)})${ME.role === 'super' ? '<small>SUPER</small>' : ''}</span>
    ${ME.expiresAt && ME.expiresAt - Date.now() < 7 * 864e5 ? `<span class="who" style="color:var(--accent)" title="ติดต่อผู้ดูแลระบบเพื่อต่ออายุ">⏳ บัญชีเหลือ ${Math.ceil((ME.expiresAt - Date.now()) / 864e5)} วัน</span>` : ''}
    <a class="tab small" href="/host.html#pw">เปลี่ยนรหัสผ่าน</a>
    <a class="tab small" href="/host.html#rc">รหัสกู้คืน</a>
    <button class="ghost small" id="navLogout">ออกจากระบบ</button>`;
  $('#navLogout').onclick = async () => { if (!confirm('ออกจากระบบ?')) return; await api('POST', '/api/logout', {}).catch(() => {}); location.replace('/login.html'); };
  return d;
}
