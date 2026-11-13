// Map Phượt: giai đoạn 1 (PWA online)
import { Map, Marker, Popup } from './lib/maplibre-gl.mjs';

const $ = (id) => document.getElementById(id);

// ---------- Cấu hình ----------
const DEFAULT_CENTER = [106.660, 10.762]; // TP.HCM [lng, lat]
const VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MAX_ALTERNATIVES = 3;
const OFF_ROUTE_M = 80;          // lệch tuyến quá mức này thì tính lại
const OFF_ROUTE_HITS = 2;        // số lần liên tiếp
const REROUTE_MIN_MS = 20000;    // cách lần tính trước tối thiểu
const ARRIVE_M = 30;
const LONG_PRESS_MS = 600;
const LS_POLICE = 'mp.police';
const LS_SETTINGS = 'mp.settings';
const EMPTY = { type: 'FeatureCollection', features: [] };

// ---------- Tiện ích ----------
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

function haversine(a, b) { // a, b: [lng, lat] -> mét
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function fmtDist(m) {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function fmtDur(s) {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} phút`;
  return `${Math.floor(min / 60)} giờ ${min % 60} phút`;
}

function fmtAgo(t) {
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return 'vừa xong';
  if (min < 60) return `${min} phút trước`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} giờ ${min % 60} phút trước`;
  return `${Math.floor(h / 24)} ngày trước`;
}

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* đầy bộ nhớ hoặc chế độ riêng tư */ }
}

let toastTimer;
function toast(msg, ms = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function el(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
}

// ---------- Cài đặt ----------
const settings = Object.assign({ alertM: 500, sound: true }, loadJSON(LS_SETTINGS, {}));

function renderSettings() {
  for (const b of $('alertChoices').children) b.classList.toggle('sel', Number(b.dataset.m) === settings.alertM);
  $('setSound').checked = settings.sound;
  $('policeCount').textContent = police.length
    ? `Đang lưu ${police.length} điểm CSGT trong máy`
    : 'Chưa có điểm CSGT nào';
  $('btnClearPolice').disabled = !police.length;
  showGpsInfo();
  disarmClear();
}
$('alertChoices').addEventListener('click', (e) => {
  const m = Number(e.target.dataset?.m);
  if (!m) return;
  settings.alertM = m;
  saveJSON(LS_SETTINGS, settings);
  renderSettings();
  checkAlerts();
});
$('setSound').addEventListener('change', () => {
  settings.sound = $('setSound').checked;
  saveJSON(LS_SETTINGS, settings);
});

$('btnTestVoice').addEventListener('click', () => {
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume?.();
  if (say('Chú ý, phía trước có chốt cảnh sát giao thông, cách 500 mét')) return;
  beep();
  toast('Máy này chưa có giọng đọc tiếng Việt nên app dùng tiếng bíp', 4000);
});

// Xoá toàn bộ: phải bấm 2 lần để khỏi lỡ tay
let clearArmTimer;
function disarmClear() {
  clearTimeout(clearArmTimer);
  $('btnClearPolice').classList.remove('armed');
  $('btnClearPolice').textContent = 'Xoá toàn bộ điểm CSGT';
}
$('btnClearPolice').addEventListener('click', () => {
  const b = $('btnClearPolice');
  if (!b.classList.contains('armed')) {
    b.classList.add('armed');
    b.textContent = `Bấm lần nữa để xoá ${police.length} điểm`;
    clearArmTimer = setTimeout(disarmClear, 4000);
    return;
  }
  const n = police.length;
  [...police].forEach((p) => removePolice(p.id, false));
  saveJSON(LS_POLICE, police);
  closePopup();
  renderSettings();
  checkAlerts();
  toast(`Đã xoá ${n} điểm CSGT`);
});

// ---------- Bản đồ ----------
const RASTER_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

// Ưu tiên bản đồ vector (nét, chữ rõ). Ko tải được thì lùi về tile ảnh OSM.
async function pickStyle() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(VECTOR_STYLE, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error();
    return await res.json();
  } catch { return RASTER_STYLE; }
}

const map = new Map({
  container: 'map',
  style: await pickStyle(),
  center: DEFAULT_CENTER,
  zoom: 13,
  attributionControl: false,
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate?.disableRotation?.();

const lineLayout = { 'line-join': 'round', 'line-cap': 'round' };
const mapReady = new Promise((res) => map.on('load', res));
mapReady.then(() => {
  map.addSource('alts', { type: 'geojson', data: EMPTY });
  map.addSource('route', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'alts-casing', type: 'line', source: 'alts', layout: lineLayout, paint: { 'line-color': '#ffffff', 'line-width': 10 } });
  map.addLayer({ id: 'alts', type: 'line', source: 'alts', layout: lineLayout, paint: { 'line-color': '#94a3b8', 'line-width': 6 } });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: lineLayout, paint: { 'line-color': '#1e3a8a', 'line-width': 10 } });
  map.addLayer({ id: 'route', type: 'line', source: 'route', layout: lineLayout, paint: { 'line-color': '#3b82f6', 'line-width': 6.5 } });
  // Chạm vào tuyến xám để chọn tuyến đó
  map.on('click', 'alts', (e) => {
    if (mode !== 'preview') return;
    const i = e.features?.[0]?.properties?.i;
    if (i != null) selectRoute(Number(i));
  });
});

// ---------- Trạng thái màn hình ----------
// idle: bản đồ trống | place: thẻ địa điểm | preview: chọn tuyến | nav: đang dẫn đường
let mode = 'idle';
let place = null; // { lngLat, name, sub }

function layout() {
  const open = [...document.querySelectorAll('.sheet')].find((s) => !s.hidden);
  // Màn hình rộng thì thẻ nằm bên trái, ko che các nút nổi nên ko cần dời nút
  const lift = open && window.innerWidth < 700 ? open.offsetHeight : 0;
  document.documentElement.style.setProperty('--dock', `${lift}px`);
  document.body.classList.toggle('docked', !!open);
  document.body.classList.toggle('nav', mode === 'nav');
}

function setMode(m) {
  mode = m;
  $('settings').hidden = true;
  $('placeSheet').hidden = m !== 'place';
  $('routeSheet').hidden = m !== 'preview';
  $('navSheet').hidden = m !== 'nav';
  $('navBanner').hidden = m !== 'nav';
  $('top').hidden = m === 'nav';
  $('results').hidden = true;
  if (m !== 'place') placeMarker?.remove();
  layout();
}

$('btnSettings').addEventListener('click', () => {
  $('q').blur();
  if (mode === 'place') setMode('idle');
  $('routeSheet').hidden = true;
  renderSettings();
  $('settings').hidden = false;
  layout();
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
  const sheet = b.closest('.sheet');
  if (sheet.id === 'settings') {
    sheet.hidden = true;
    $('routeSheet').hidden = mode !== 'preview';
    layout();
  } else if (sheet.id === 'routeSheet') {
    cancelRoutes();
  } else {
    setMode('idle');
  }
}));
window.addEventListener('resize', layout);
// Nội dung thẻ đổi chiều cao thì dời các nút nổi theo, để ko bị thẻ che
const sheetObserver = new ResizeObserver(layout);
document.querySelectorAll('.sheet').forEach((s) => sheetObserver.observe(s));

// ---------- Vị trí ----------
let pos = null;          // [lng, lat]
let lastFix = null;      // { p, t } để tự tính tốc độ khi máy ko trả speed
let follow = true;
const meEl = el('div', { className: 'me' }, el('i'));
const meMarker = new Marker({ element: meEl });

function setFollow(on) {
  follow = on;
  $('btnFollow').classList.toggle('on', on);
  if (on && pos) map.easeTo({ center: pos, zoom: Math.max(map.getZoom(), 15.5) });
}
setFollow(true);
$('btnFollow').addEventListener('click', () => {
  if (!pos) toast('Chưa có vị trí GPS');
  setFollow(!follow);
});
map.on('dragstart', () => setFollow(false));
// Lần cuối người dùng chạm/lăn chuột trên bản đồ, để việc bám theo ko giành điều khiển
let lastTouchAt = 0;
for (const ev of ['touchstart', 'touchmove', 'touchend', 'wheel', 'mousedown']) {
  map.on(ev, () => { lastTouchAt = Date.now(); });
}

function onPosition(p) {
  const { longitude, latitude, speed, heading } = p.coords;
  const first = !pos;
  pos = [longitude, latitude];
  meMarker.setLngLat(pos);
  if (first) meMarker.addTo(map);

  let v = speed; // m/s, có thể null
  if (v == null || Number.isNaN(v)) {
    v = 0;
    if (lastFix) {
      const dt = (p.timestamp - lastFix.t) / 1000;
      if (dt > 0.5 && dt < 10) v = haversine(lastFix.p, pos) / dt;
    }
  }
  lastFix = { p: pos, t: p.timestamp };
  // Dưới 1.5 km/h coi là đứng yên: GPS đứng một chỗ vẫn "trôi" ra 1 đến 2 km/h
  const kmh = Math.max(0, v) * 3.6;
  $('speed').textContent = kmh < 1.5 ? 0 : Math.round(kmh);

  // Số liệu đo thật của GPS máy này (hiện trong cài đặt)
  const now = Date.now();
  if (gps.lastAt) { gps.gaps.push(now - gps.lastAt); if (gps.gaps.length > 8) gps.gaps.shift(); }
  gps.lastAt = now;
  gps.acc = p.coords.accuracy;
  gps.hasSpeed = speed != null && !Number.isNaN(speed);
  $('hud').classList.remove('stale');

  // Mũi tên hướng đi, chỉ hiện khi đang chạy và máy có trả hướng
  const hasHd = v > 1.5 && heading != null && !Number.isNaN(heading);
  meEl.classList.toggle('hd', hasHd);
  if (hasHd) meEl.style.setProperty('--hd', `${heading}deg`);

  // Bám theo vị trí: chỉ dời tâm, KO đụng tới mức zoom, và nhường khi ngón tay đang thao tác.
  // (Trước đây mỗi giây GPS lại ép zoom cũ nên trên điện thoại ko thu nhỏ bản đồ ra xa được.)
  if (first) map.jumpTo({ center: pos, zoom: 16 });
  else if (follow && Date.now() - lastTouchAt > 1500) map.easeTo({ center: pos, duration: 800 });
  checkAlerts();
  updateNavigation();
}

const gps = { lastAt: 0, gaps: [], acc: null, hasSpeed: false };

function gpsInfoText() {
  if (!gps.lastAt) return 'GPS: chưa có tín hiệu';
  const parts = [];
  if (gps.gaps.length) {
    const avg = gps.gaps.reduce((a, b) => a + b, 0) / gps.gaps.length / 1000;
    parts.push(`cập nhật mỗi ${avg.toFixed(1)} giây`);
  }
  if (gps.acc != null) parts.push(`sai số vị trí ±${Math.round(gps.acc)} m`);
  parts.push(gps.hasSpeed ? 'tốc độ do GPS đo' : 'tốc độ tự tính từ quãng đường');
  return `GPS: ${parts.join(' · ')}`;
}

// Quá 4 giây ko có tín hiệu mới thì làm mờ ô tốc độ: con số đang hiện là số cũ
setInterval(() => {
  if (gps.lastAt && Date.now() - gps.lastAt > 4000) $('hud').classList.add('stale');
  if (!$('settings').hidden) showGpsInfo();
}, 1000);

// Có kiểm tra phần tử: trình duyệt có thể còn giữ index.html cũ trong vài phút sau khi cập nhật
function showGpsInfo() {
  const box = $('gpsInfo');
  if (box) box.textContent = gpsInfoText();
}

function onPositionError(e) {
  const msg = e.code === 1 ? 'Chưa cấp quyền vị trí cho trang này'
    : e.code === 2 ? 'Ko lấy được vị trí GPS'
    : 'GPS phản hồi chậm, đang thử lại';
  toast(msg, 4000);
}

if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 20000, // maximumAge 0: ko nhận vị trí cũ đã lưu sẵn
  });
} else {
  toast('Trình duyệt ko hỗ trợ định vị', 4000);
}

// ---------- Chuyến đi: Wake Lock + âm thanh ----------
let tripOn = false;
let wakeLock = null;
let audioCtx = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    return true;
  } catch { return false; }
}

// Phải gọi trong thao tác của người dùng (để tạo được AudioContext)
async function setTrip(on, quiet = false) {
  if (on === tripOn) return;
  tripOn = on;
  $('btnTrip').classList.toggle('on', on);
  $('tripLabel').textContent = on ? 'Đang đi · chạm để kết thúc' : 'Bắt đầu chuyến đi';
  if (on) {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume?.();
    // iPhone chỉ cho đọc sau khi người dùng chạm nút, nên đọc câu đầu ngay tại đây để "mở khoá" giọng nói
    if (settings.sound) say('Bắt đầu chuyến đi');
    const ok = await acquireWakeLock();
    if (!ok) toast('Máy ko hỗ trợ giữ sáng màn hình, fen tự tắt khoá tự động nha', 3500);
    else if (!quiet) toast('Màn hình sẽ luôn sáng trong lúc đi');
  } else {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }
}
$('btnTrip').addEventListener('click', () => {
  setTrip(!tripOn);
  if (tripOn) setFollow(true);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (tripOn && !wakeLock) acquireWakeLock();
  audioCtx?.resume?.();
});

// ---------- Giọng nói (Web Speech API), ko có giọng tiếng Việt thì lùi về tiếng bíp ----------
const canSpeak = 'speechSynthesis' in window;
let voices = [];
function loadVoices() { voices = canSpeak ? speechSynthesis.getVoices() : []; }
if (canSpeak) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

// Trả về true nếu đã đọc được, false nếu máy ko đọc được tiếng Việt
function say(text) {
  if (!canSpeak) return false;
  if (!voices.length) loadVoices();
  const vi = voices.find((v) => /^vi/i.test(v.lang));
  // Có danh sách giọng mà ko có tiếng Việt thì thôi. Danh sách rỗng (vài máy Android) thì vẫn thử đọc theo lang.
  if (voices.length && !vi) return false;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'vi-VN';
  if (vi) u.voice = vi;
  speechSynthesis.cancel(); // câu mới chen lên trước câu cũ
  speechSynthesis.speak(u);
  return true;
}

function spokenDist(m) {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} mét`;
  return `${(m / 1000).toFixed(1).replace('.0', '').replace('.', ' phẩy ')} ki lô mét`;
}

// Cảnh báo bằng âm thanh: ưu tiên giọng nói, ko được thì bíp
function announce(text) {
  if (!settings.sound) return;
  if (!say(text)) beep();
}

function beep() {
  if (!audioCtx || !settings.sound) return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < 3; i++) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.3);
    gain.gain.exponentialRampToValueAtTime(0.5, t0 + i * 0.3 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.3 + 0.2);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + i * 0.3);
    osc.stop(t0 + i * 0.3 + 0.22);
  }
}

// ---------- Điểm CSGT (chỉ xoá tay, ko tự hết hạn) ----------
let police = loadJSON(LS_POLICE, []); // [{ id, lat, lng, t }]
const policeMarkers = new globalThis.Map(); // id -> Marker
const alerted = new Set();                  // id đã báo, bỏ ra khi đi xa
let openPopup = null;
const SHIELD = '<svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5l8-3z"/></svg>';

function closePopup() { openPopup?.remove(); openPopup = null; }
function showPopup(lngLat, content) {
  closePopup();
  openPopup = new Popup({ offset: 26, maxWidth: '260px', closeButton: false })
    .setLngLat(lngLat).setDOMContent(content).addTo(map);
}

function addPoliceMarker(pt) {
  const node = el('div', { className: 'police-mk', innerHTML: SHIELD });
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    showPopup([pt.lng, pt.lat], el('div', {},
      el('div', {}, el('b', { textContent: 'Điểm CSGT' })),
      el('div', { textContent: `Đánh dấu ${fmtAgo(pt.t)}` }),
      el('button', { className: 'danger', textContent: 'Xoá điểm này', onclick: () => { removePolice(pt.id); closePopup(); toast('Đã xoá điểm CSGT'); } }),
    ));
  });
  policeMarkers.set(pt.id, new Marker({ element: node }).setLngLat([pt.lng, pt.lat]).addTo(map));
}

function addPolice(lngLat) {
  const pt = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, lat: lngLat[1], lng: lngLat[0], t: Date.now() };
  police.push(pt);
  saveJSON(LS_POLICE, police);
  addPoliceMarker(pt);
  alerted.add(pt.id); // ko tự báo điểm mình vừa đánh dấu
  navigator.vibrate?.(40);
  toast('Đã đánh dấu CSGT');
}

function removePolice(id, save = true) {
  police = police.filter((p) => p.id !== id);
  policeMarkers.get(id)?.remove();
  policeMarkers.delete(id);
  alerted.delete(id);
  if (save) { saveJSON(LS_POLICE, police); checkAlerts(); }
}

function checkAlerts() {
  const banner = $('alertBanner');
  if (!pos) { banner.hidden = true; return; }
  let nearest = Infinity;
  let fresh = false;
  for (const p of police) {
    const d = haversine(pos, [p.lng, p.lat]);
    if (d <= settings.alertM) {
      nearest = Math.min(nearest, d);
      if (!alerted.has(p.id)) { alerted.add(p.id); fresh = true; }
    } else if (d > settings.alertM * 1.5) {
      alerted.delete(p.id); // đi xa rồi, lần sau lại gần thì báo lại
    }
  }
  banner.hidden = nearest === Infinity;
  if (nearest !== Infinity) banner.textContent = `CSGT phía trước · ${fmtDist(nearest)}`;
  if (fresh) {
    announce(`Chú ý, phía trước có chốt cảnh sát giao thông, cách ${spokenDist(nearest)}`);
    navigator.vibrate?.([300, 150, 300]);
  }
}

$('btnPolice').addEventListener('click', () => {
  if (!pos) { toast('Chưa có vị trí GPS. Nhấn giữ trên bản đồ để đánh dấu tay', 3500); return; }
  addPolice(pos);
});
police.forEach(addPoliceMarker);

// ---------- Thẻ địa điểm ----------
let placeMarker = null;

function openPlace(lngLat, name, sub) {
  if (mode === 'nav') return; // đang dẫn đường thì ko mở thẻ địa điểm
  if (mode === 'preview') cancelRoutes();
  place = { lngLat, name: name || 'Điểm đã chọn' };
  $('placeName').textContent = place.name;
  $('placeSub').textContent = sub || `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`;
  placeMarker ??= new Marker({ color: '#2563eb' });
  placeMarker.setLngLat(lngLat).addTo(map);
  closePopup();
  setMode('place');
  if (!sub) lookupAddress(place, !name);
}

// Địa điểm có tên (trường, quán, cây xăng...) đang hiện trên bản đồ ngay dưới ngón tay
function poiAt(point) {
  if (!map.isStyleLoaded()) return null;
  const box = [[point.x - 14, point.y - 14], [point.x + 14, point.y + 14]];
  const f = map.queryRenderedFeatures(box).find((x) =>
    x.sourceLayer === 'poi' && x.geometry.type === 'Point' && (x.properties['name:vi'] || x.properties.name));
  return f ? { lngLat: f.geometry.coordinates.slice(0, 2), name: f.properties['name:vi'] || f.properties.name } : null;
}

// Hỏi Nominatim xem toạ độ này là chỗ nào (tên địa điểm, số nhà, tên đường)
async function lookupAddress(p, needName) {
  try {
    const wait = lastSearchAt + 1100 - Date.now(); // chung hạn mức 1 yêu cầu/giây với ô tìm kiếm
    lastSearchAt = Date.now() + Math.max(0, wait);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=vi&lat=${p.lngLat[1]}&lon=${p.lngLat[0]}`;
    const d = await (await fetch(url)).json();
    if (place !== p || mode !== 'place' || !d?.display_name) return;
    const a = d.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    if (needName) {
      p.name = d.name || street || p.name;
      $('placeName').textContent = p.name;
    }
    $('placeSub').textContent = d.display_name.split(', ').filter((s) => s !== p.name).slice(0, 5).join(', ');
  } catch { /* mất mạng: giữ toạ độ */ }
}
$('btnGo').addEventListener('click', () => previewRoutes(place.lngLat, place.name));
$('btnMarkHere').addEventListener('click', () => { addPolice(place.lngLat); setMode('idle'); });

// Nhấn giữ trên bản đồ
let pressTimer = null;
let pressStart = null;
const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };

map.on('touchstart', (e) => {
  cancelPress();
  if (e.points.length !== 1) return;
  pressStart = e.point;
  const lngLat = [e.lngLat.lng, e.lngLat.lat];
  const point = e.point;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    navigator.vibrate?.(30);
    const poi = poiAt(point);
    if (poi) openPlace(poi.lngLat, poi.name); else openPlace(lngLat);
  }, LONG_PRESS_MS);
});
map.on('touchmove', (e) => {
  if (!pressTimer) return;
  if (e.points.length !== 1 || Math.hypot(e.point.x - pressStart.x, e.point.y - pressStart.y) > 10) cancelPress();
});
map.on('touchend', cancelPress);
map.on('touchcancel', cancelPress);
// Chuột phải trên máy tính (và nhấn giữ trên Android)
map.on('contextmenu', (e) => {
  e.preventDefault?.();
  cancelPress();
  const poi = poiAt(e.point);
  if (poi) openPlace(poi.lngLat, poi.name); else openPlace([e.lngLat.lng, e.lngLat.lat]);
});
map.on('click', (e) => {
  $('results').hidden = true;
  closePopup();
  // Chạm nhẹ vào một địa điểm có tên trên bản đồ thì mở luôn thẻ của nó
  if (mode === 'idle' || mode === 'place') {
    const poi = poiAt(e.point);
    if (poi) openPlace(poi.lngLat, poi.name);
  }
});

// ---------- Tìm địa điểm (Nominatim) ----------
let lastSearchAt = 0;
let searching = false;

$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q || searching) return;
  searching = true;
  $('q').blur();
  const box = $('results');
  box.hidden = false;
  box.replaceChildren(el('div', { className: 'empty', textContent: 'Đang tìm...' }));
  try {
    // Chính sách Nominatim: tối đa 1 yêu cầu/giây
    const wait = lastSearchAt + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSearchAt = Date.now();
    const url = `${NOMINATIM}?format=jsonv2&limit=8&countrycodes=vn&accept-language=vi&q=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    if (!list.length) {
      box.replaceChildren(el('div', { className: 'empty', textContent: 'Ko tìm thấy địa điểm nào' }));
      return;
    }
    box.replaceChildren(...list.map((it) => {
      const parts = it.display_name.split(', ');
      const name = it.name || parts[0];
      const sub = parts.slice(1).join(', ');
      return el('button', {
        type: 'button',
        onclick: () => {
          const lngLat = [Number(it.lon), Number(it.lat)];
          setFollow(false);
          map.flyTo({ center: lngLat, zoom: 15 });
          openPlace(lngLat, name, sub);
        },
      }, el('b', { textContent: name }), el('span', { textContent: sub }));
    }));
  } catch {
    box.replaceChildren(el('div', { className: 'empty', textContent: 'Lỗi mạng khi tìm kiếm, thử lại sau' }));
  } finally {
    searching = false;
  }
});

// ---------- Tìm đường (OSRM) ----------
let routes = [];     // các tuyến đề xuất đang xem
let sel = 0;         // tuyến đang chọn
let dest = null;     // { lngLat, name }
let route = null;    // tuyến đang dẫn
let destMarker = null;
let offHits = 0;
let lastRouteAt = 0;
let routing = false;
let routeWarn = '';

const MOD = {
  uturn: 'quay đầu',
  'sharp right': 'rẽ gắt sang phải', right: 'rẽ phải', 'slight right': 'chếch sang phải',
  straight: 'đi thẳng',
  'slight left': 'chếch sang trái', left: 'rẽ trái', 'sharp left': 'rẽ gắt sang trái',
};
const ARROW_DEG = {
  uturn: 180, 'sharp right': 135, right: 90, 'slight right': 45, straight: 0,
  'slight left': -45, left: -90, 'sharp left': -135,
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function stepText(step) {
  const m = step.maneuver;
  const mod = MOD[m.modifier] || 'đi tiếp';
  const into = step.name ? ` vào ${step.name}` : '';
  const side = /left/.test(m.modifier || '') ? 'trái' : /right/.test(m.modifier || '') ? 'phải' : '';
  switch (m.type) {
    case 'depart': return `Xuất phát${step.name ? ` theo ${step.name}` : ''}`;
    case 'arrive': return 'Đến nơi';
    case 'roundabout':
    case 'rotary': return `Vào vòng xuyến${m.exit ? `, ra ở lối thứ ${m.exit}` : ''}${into}`;
    case 'exit roundabout':
    case 'exit rotary': return `Ra khỏi vòng xuyến${into}`;
    case 'fork': return `Ngã rẽ: giữ bên ${side || 'phải'}${into}`;
    case 'merge': return `Nhập làn${into}`;
    case 'on ramp': return `Vào đường nhánh${side ? ` bên ${side}` : ''}${into}`;
    case 'off ramp': return `Ra theo đường nhánh${side ? ` bên ${side}` : ''}${into}`;
    case 'end of road': return `Cuối đường ${mod}${into}`;
    case 'new name': return `Đi tiếp${into}`;
    default: return `${cap(mod)}${into}`;
  }
}

// Dạng tuyến dùng chung cho mọi server: steps = [{ text, deg, distance (m) }]
function buildRoute(coords, steps, distance, duration, summary) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  const stepStart = [];
  let acc = 0;
  for (const s of steps) { stepStart.push(acc); acc += s.distance; }
  const total = cum[cum.length - 1] || 1;
  return {
    geometry: { type: 'LineString', coordinates: coords }, coords, cum, steps, stepStart,
    scale: distance / total, distance, duration, summary,
  };
}

// ----- Valhalla (server chính): có profile xe máy, ko vào cao tốc, chỉ dẫn tiếng Việt -----
// Góc mũi tên theo mã loại chỉ dẫn của Valhalla
const VALHALLA_DEG = {
  9: 45, 10: 90, 11: 135, 12: 180, 13: 180, 14: -135, 15: -90, 16: -45,
  18: 45, 19: -45, 20: 45, 21: -45, 23: 30, 24: -30, 37: 30, 38: -30,
};

function decodePolyline6(str) {
  const out = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (k === 0) lat += d; else lng += d;
    }
    out.push([lng / 1e6, lat / 1e6]);
  }
  return out;
}

function parseValhalla(trip) {
  const coords = trip.legs.flatMap((l) => decodePolyline6(l.shape));
  const mans = trip.legs.flatMap((l) => l.maneuvers);
  const steps = mans.map((m) => ({
    // "Rẽ phải vào Pasteur/Đường Pasteur." -> "Rẽ phải vào Pasteur"
    text: m.instruction.replace(/\/[^/.,]*/g, '').replace(/\.$/, ''),
    deg: VALHALLA_DEG[m.type] ?? 0,
    distance: m.length * 1000,
  }));
  // Tóm tắt: 2 đoạn đường dài nhất, theo đúng thứ tự đi
  const major = mans.map((m, i) => ({ i, len: m.length, name: m.street_names?.[0] }))
    .filter((m) => m.name).sort((a, b) => b.len - a.len).slice(0, 2).sort((a, b) => a.i - b.i);
  const r = buildRoute(coords, steps, trip.summary.length * 1000, trip.summary.time,
    [...new Set(major.map((m) => m.name))].join(', '));
  // Đoạn server đánh dấu là đường cao tốc (kèm tên và độ dài để fen tự kiểm)
  const hw = mans.filter((m) => m.highway);
  r.motorway = hw.length > 0 || !!trip.summary.has_highway;
  r.motorwayKm = hw.reduce((s, m) => s + m.length, 0);
  r.motorwayNames = [...new Set(hw.map((m) => m.street_names?.[0]).filter(Boolean))];
  // Điểm giữa mỗi đoạn cao tốc, để chặn lại khi tìm lần nữa (chỉ đúng khi tuyến có 1 chặng)
  r.motorwayPts = trip.legs.length === 1
    ? hw.map((m) => coords[Math.floor((m.begin_shape_index + m.end_shape_index) / 2)]).filter(Boolean)
    : [];
  r.ferry = mans.some((m) => m.type === 28);
  return r;
}

// Xe máy ko được vào cao tốc: tuyến nào dính cao tốc thì chặn đoạn đó rồi tìm lại, tối đa 3 lần.
// Vẫn dính thì trả về tuyến đó kèm cờ motorway để màn hình cảnh báo.
async function requestValhalla(from, to, exclude = []) {
  let r = await requestValhallaOnce(from, to, exclude);
  const banned = [];
  for (let k = 0; k < 3 && r.motorway && r.motorwayPts.length; k++) {
    banned.push(...r.motorwayPts);
    if (exclude.length + banned.length > 48) break; // server giới hạn số điểm chặn
    try { r = await requestValhallaOnce(from, to, [...exclude, ...banned]); } catch { break; }
  }
  return r;
}

// exclude: các điểm [lng, lat] mà tuyến ko được đi qua (để ép ra tuyến khác)
async function requestValhallaOnce(from, to, exclude = []) {
  const res = await fetch(VALHALLA, {
    method: 'POST',
    body: JSON.stringify({
      locations: [{ lat: from[1], lon: from[0] }, { lat: to[1], lon: to[0] }],
      costing: 'motorcycle', language: 'vi-VN', units: 'kilometers',
      exclude_locations: exclude.map((p) => ({ lat: p[1], lon: p[0] })),
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.trip) {
    // 442: ko có đường nối 2 điểm, 171: điểm ko nằm gần đường nào
    throw new Error([442, 171].includes(data?.error_code) ? 'NoRoute' : `Valhalla ${res.status}`);
  }
  return parseValhalla(data.trip);
}

// ----- OSRM demo (dự phòng): profile ô tô, ko loại được cao tốc -----
async function requestOsrm(from, to) {
  const url = `${OSRM}${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(data?.code || `HTTP ${res.status}`);
  }
  const r = data.routes[0];
  const out = buildRoute(
    r.geometry.coordinates,
    r.legs.flatMap((l) => l.steps).map((s) => ({ text: stepText(s), deg: ARROW_DEG[s.maneuver.modifier] ?? 0, distance: s.distance })),
    r.distance, r.duration,
    r.legs.map((l) => l.summary).filter(Boolean).join(', '),
  );
  out.fallback = true;
  return out;
}

// Tuyến chính: nhanh nhất theo profile xe máy
async function fetchMainRoute(from, to) {
  lastRouteAt = Date.now();
  try {
    const r = await requestValhalla(from, to);
    routeWarn = '';
    return r;
  } catch (err) {
    if (err.message === 'NoRoute') throw err;
    const r = await requestOsrm(from, to);
    routeWarn = 'Server tìm đường xe máy đang lỗi nên tạm dùng tuyến ô tô: thời gian ko chuẩn và có thể đi qua cao tốc.';
    return r;
  }
}

// ----- Tìm tuyến khác hẳn -----
// Toạ độ tại quãng m (mét, tính theo đường vẽ) dọc tuyến
function sampleRoute(r, step) {
  const out = [];
  const total = r.cum[r.cum.length - 1];
  let i = 0;
  for (let m = 0; m <= total; m += step) {
    while (i < r.cum.length - 2 && r.cum[i + 1] < m) i++;
    const seg = r.cum[i + 1] - r.cum[i] || 1;
    const t = Math.min(1, Math.max(0, (m - r.cum[i]) / seg));
    const a = r.coords[i], b = r.coords[i + 1] || a;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// Lưới ô ~55 m phủ quanh tuyến, dùng để đo 2 tuyến trùng nhau bao nhiêu
const CELL = 0.0005;
function gridOf(r) {
  if (r.grid) return r.grid;
  r.samples ??= sampleRoute(r, 50);
  const g = new Set();
  for (const p of r.samples) {
    const y = Math.round(p[1] / CELL), x = Math.round(p[0] / CELL);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) g.add(`${y + dy}:${x + dx}`);
  }
  return (r.grid = g);
}

// % quãng đường của tuyến a nằm trùng lên tuyến b
function overlapPct(a, b) {
  a.samples ??= sampleRoute(a, 50);
  const g = gridOf(b);
  const hit = a.samples.filter((p) => g.has(`${Math.round(p[1] / CELL)}:${Math.round(p[0] / CELL)}`)).length;
  return Math.round((100 * hit) / (a.samples.length || 1));
}

// Các điểm chặn rải trên nửa đầu của tuyến: tuyến mới buộc phải tách ra từ sớm,
// nửa sau để ngỏ vì nhiều khi chỉ có 1 đường vào tới đích
function blockPoints(r) {
  const total = r.cum[r.cum.length - 1];
  if (total < 1500) return [];
  const n = Math.min(20, Math.max(3, Math.round(total / 1500)));
  const a = Math.max(0.05, 300 / total), b = 0.5;
  const all = sampleRoute(r, total / 400);
  return Array.from({ length: n }, (_, i) => all[Math.floor(all.length * (a + (b - a) * (i + 0.5) / n))]);
}

let previewToken = 0;
async function findAlternatives(from, to, token) {
  if (routes[0].fallback) return;
  $('routeMore').hidden = false;
  try {
    while (routes.length < MAX_ALTERNATIVES) {
      const exclude = routes.flatMap(blockPoints);
      if (!exclude.length) break;
      const r = await requestValhalla(from, to, exclude);
      if (token !== previewToken || mode !== 'preview') return;
      if (r.duration > routes[0].duration * 2) break;          // vòng quá xa thì thôi
      if (routes.some((x) => overlapPct(r, x) > 85)) break;    // gần như trùng tuyến đã có
      r.overlap = overlapPct(r, routes[0]);
      routes.push(r);
      renderRouteList();
      drawRoutes();
      fitRoutes();
    }
  } catch { /* ko còn đường khác hoặc lỗi mạng: giữ các tuyến đã có */ } finally {
    if (token === previewToken) {
      $('routeMore').hidden = true;
      if (routes.some((r) => r.motorway)) {
        routeWarn = 'Có tuyến đi qua cao tốc. Xe máy ko được vào cao tốc, fen xem kỹ trước khi đi.';
        renderRouteList();
      }
    }
  }
}

function drawRoutes() {
  mapReady.then(() => {
    map.getSource('alts').setData({
      type: 'FeatureCollection',
      features: routes.map((r, i) => ({ type: 'Feature', geometry: r.geometry, properties: { i } })).filter((f, i) => i !== sel),
    });
    const cur = mode === 'nav' ? route : routes[sel];
    map.getSource('route').setData(cur ? { type: 'Feature', geometry: cur.geometry, properties: {} } : EMPTY);
  });
}

function renderRouteList() {
  const fastest = Math.min(...routes.map((r) => r.duration));
  const iFast = routes.findIndex((r) => r.duration === fastest);
  const shortest = Math.min(...routes.map((r) => r.distance));
  $('routeList').replaceChildren(...routes.map((r, i) => {
    const extra = Math.round((r.duration - fastest) / 60);
    const tag = i === iFast ? 'Nhanh nhất'
      : r.distance === shortest ? 'Ngắn nhất'
      : extra > 0 ? `+${fmtDur(extra * 60)}` : 'Tương đương';
    return el('button', { className: `route-opt${i === sel ? ' sel' : ''}`, onclick: () => selectRoute(i) },
      el('div', { className: 't', textContent: fmtDur(r.duration) }),
      el('div', { className: 'd' },
        el('b', { textContent: fmtDist(r.distance) }),
        el('span', { textContent: [
          r.summary ? `Qua ${r.summary}` : `Tuyến ${i + 1}`,
          r.motorway ? `CÓ CAO TỐC ${r.motorwayNames.join(', ')} (${r.motorwayKm.toFixed(1)} km)` : '',
          r.ferry ? 'có đi phà' : '',
          r.overlap != null ? `trùng ${r.overlap}% tuyến đầu` : '',
        ].filter(Boolean).join(' · ') })),
      el('span', { className: `tag${i === iFast ? '' : ' more'}`, textContent: tag }),
    );
  }));
  $('routeWarn').textContent = routeWarn;
  $('routeWarn').hidden = !routeWarn;
}

function selectRoute(i) {
  sel = i;
  renderRouteList();
  drawRoutes();
}

function fitRoutes() {
  const b = routes.flatMap((r) => r.coords).reduce(
    (a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[0]), Math.max(a[3], c[1])],
    [180, 90, -180, -90]);
  const h = map.getContainer().clientHeight;
  const sheetH = $('routeSheet').offsetHeight;
  // Màn hình rộng: thẻ nằm bên trái nên chừa lề trái; điện thoại: thẻ ở đáy nên chừa lề dưới
  const wide = window.innerWidth >= 700;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], {
    padding: wide
      ? { top: 90, bottom: 50, left: Math.min(500, window.innerWidth * 0.55), right: 90 }
      : { top: Math.min(100, h * 0.15), bottom: Math.min(sheetH + 30, h * 0.6), left: 40, right: 40 },
  });
}

async function previewRoutes(lngLat, name) {
  if (!pos) { toast('Chưa có vị trí GPS nên chưa tìm đường được', 3500); return; }
  if (routing) return;
  routing = true;
  toast('Đang tìm đường...');
  const token = ++previewToken;
  const from = [...pos];
  try {
    routes = [await fetchMainRoute(from, lngLat)];
    dest = { lngLat, name };
    sel = 0;
    route = null;
    $('routeDest').textContent = name;
    destMarker ??= new Marker({ color: '#dc2626' });
    destMarker.setLngLat(lngLat).addTo(map);
    setMode('preview');
    renderRouteList();
    layout();
    drawRoutes();
    setFollow(false);
    fitRoutes();
    $('toast').hidden = true;
    findAlternatives(from, lngLat, token); // chạy nền, có tuyến nào thêm tuyến đó
  } catch (err) {
    toast(err.message === 'NoRoute' ? 'Ko tìm được đường tới điểm này' : 'Lỗi khi tìm đường, thử lại sau', 3500);
  } finally {
    routing = false;
  }
}

function cancelRoutes() {
  previewToken++; // huỷ việc tìm thêm tuyến đang chạy nền
  routes = [];
  route = null;
  dest = null;
  offHits = 0;
  destMarker?.remove();
  setMode('idle');
  drawRoutes();
}

$('btnStartNav').addEventListener('click', () => {
  route = routes[sel];
  routes = [];
  offHits = 0;
  setTrip(true, true); // giữ sáng màn hình + bật âm thanh, đang trong thao tác bấm nút
  setMode('nav');
  drawRoutes();
  updateNavigation();
  layout(); // thẻ vừa có số liệu nên cao hơn, dời nút nổi theo
  setFollow(true);
});
$('btnStopNav').addEventListener('click', cancelRoutes);
$('btnRoutes').addEventListener('click', () => previewRoutes(dest.lngLat, dest.name));

async function reroute() {
  if (routing) return;
  routing = true;
  toast('Lệch tuyến, đang tính lại đường...');
  try {
    const r = await fetchMainRoute(pos, dest.lngLat);
    if (mode !== 'nav') return;
    route = r;
    offHits = 0;
    drawRoutes();
    updateNavigation();
  } catch { /* mất mạng thì giữ tuyến cũ, lần sau thử lại */ } finally {
    routing = false;
  }
}

// Chiếu vị trí lên tuyến: trả về khoảng lệch (m) và quãng đã đi dọc tuyến (m)
function projectOnRoute(p) {
  const { coords, cum } = route;
  const kx = Math.cos(rad(p[1])) * rad(1) * R; // m trên 1 độ kinh
  const ky = rad(1) * R;                       // m trên 1 độ vĩ
  let best = { d: Infinity, along: 0 };
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (coords[i][0] - p[0]) * kx, ay = (coords[i][1] - p[1]) * ky;
    const bx = (coords[i + 1][0] - p[0]) * kx, by = (coords[i + 1][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.d) best = { d, along: cum[i] + t * (cum[i + 1] - cum[i]) };
  }
  return best;
}

function updateNavigation() {
  if (mode !== 'nav' || !route || !pos) return;
  const { d, along } = projectOnRoute(pos);

  // Lệch tuyến -> tính lại
  if (d > OFF_ROUTE_M) {
    offHits++;
    if (offHits >= OFF_ROUTE_HITS && Date.now() - lastRouteAt >= REROUTE_MIN_MS) {
      offHits = 0;
      reroute();
      return;
    }
  } else {
    offHits = 0;
  }

  const progress = along * route.scale;
  const remain = Math.max(0, route.distance - progress);
  if (remain < ARRIVE_M && d <= OFF_ROUTE_M) {
    toast('Đã đến nơi 🎉', 4000);
    cancelRoutes();
    return;
  }

  // Bước hiện tại là bước cuối cùng có điểm bắt đầu <= quãng đã đi
  let i = 0;
  while (i + 1 < route.steps.length && route.stepStart[i + 1] <= progress) i++;
  const next = route.steps[i + 1];
  $('navDist').textContent = next ? fmtDist(route.stepStart[i + 1] - progress) : fmtDist(remain);
  $('navText').textContent = next ? next.text : 'Sắp đến nơi';
  $('navArrow').style.transform = `rotate(${next?.deg ?? 0}deg)`;

  const remainS = route.duration * (remain / (route.distance || 1));
  const eta = new Date(Date.now() + remainS * 1000);
  $('navEta').textContent = `${String(eta.getHours()).padStart(2, '0')}:${String(eta.getMinutes()).padStart(2, '0')}`;
  const min = Math.max(1, Math.round(remainS / 60));
  $('navMin').textContent = min < 60 ? min : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
  $('navMinUnit').textContent = min < 60 ? 'phút' : 'giờ:phút';
  $('navKm').textContent = remain < 1000 ? Math.round(remain / 10) * 10 : (remain / 1000).toFixed(remain < 10000 ? 1 : 0);
  $('navKmUnit').textContent = remain < 1000 ? 'm' : 'km';
}

setMode('idle');

// ---------- Giả lập GPS khi thử trên máy tính (chỉ ở localhost) ----------
// Mở console gõ: mpFake(10.7769, 106.7009, 40)  // lat, lng, km/h
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.mpMap = map;
  window.mpRoutes = () => routes;
  window.mpFake = (lat, lng, kmh = 0, heading = null) => onPosition({
    coords: { latitude: lat, longitude: lng, speed: kmh / 3.6, heading },
    timestamp: Date.now(),
  });
}

// ---------- Service worker ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
