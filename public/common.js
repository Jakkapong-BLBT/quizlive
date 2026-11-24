// รูปทรงประจำตัวเลือก (สามเหลี่ยม ข้าวหลามตัด วงกลม สี่เหลี่ยม)
const SHAPES = [
  '<svg class="shape" viewBox="0 0 24 24"><path d="M12 2 23 21H1z"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24"><path d="M12 1 23 12 12 23 1 12z"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20"/></svg>',
];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = s => document.querySelector(s);
const fmt = n => Number(n || 0).toLocaleString('th-TH');
// ชดเชยนาฬิกาเครื่องกับเซิร์ฟเวอร์
let clockSkew = 0;
function syncClock(serverNow) { if (serverNow) clockSkew = serverNow - Date.now(); }
const serverTime = () => Date.now() + clockSkew;
