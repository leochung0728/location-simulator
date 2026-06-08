/**
 * renderer.ts — 展示層邏輯（瀏覽器 context）
 *
 * 不含任何移動引擎或裝置邏輯：那些都在 main 程序。
 * 這裡只負責：收集使用者輸入 → 透過 window.simulator 呼叫 main；
 * 訂閱 main 推來的座標/狀態 → 更新地圖與遙測。
 */
interface LatLng { lat: number; lng: number; }
type Mode = 'teleport' | 'two-point' | 'multi-point' | 'joystick';

const sim = window.simulator;
const $ = (id: string) => document.getElementById(id) as HTMLElement;

let mode: Mode = 'teleport';
let waypoints: LatLng[] = [];
let wpMarkers: any[] = [];
let routeLine: any = null;
let trailLine: any = null;
let posMarker: any = null;
let deviceConnected = false;

// ── 設定（存 localStorage）──
interface AppSettings {
  defaultSpeed: number;          // km/h
  jitterM: number;               // 抖動半徑（公尺）
  units: 'metric' | 'imperial';
  rememberLast: boolean;
  follow: boolean;
}
const DEFAULT_SETTINGS: AppSettings = {
  defaultSpeed: 60, jitterM: 3, units: 'metric', rememberLast: true, follow: true,
};
function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(localStorage.getItem('appSettings') || '{}');
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(): void {
  try { localStorage.setItem('appSettings', JSON.stringify(settings)); } catch { /* ignore */ }
}
let settings: AppSettings = loadSettings();

const MS_PER_KMH = 1000 / 3600;
function fmtSpeed(kmh: number): string {
  return settings.units === 'imperial'
    ? `${(kmh * 0.621371).toFixed(0)} mph`
    : `${kmh.toFixed(0)} km/h`;
}
function fmtDist(m: number): string {
  if (settings.units === 'imperial') {
    const mi = m / 1609.344;
    return mi < 0.1 ? `${(m * 3.28084).toFixed(0)} ft` : `${mi.toFixed(2)} mi`;
  }
  return m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`;
}
function fmtKm(km: number): string {
  return settings.units === 'imperial' ? `${(km * 0.621371).toFixed(2)} mi` : `${km.toFixed(km < 10 ? 2 : 1)} km`;
}
function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h} 小時 ${mm} 分` : mm > 0 ? `${mm} 分 ${ss} 秒` : `${ss} 秒`;
}

// ── 地圖 ──
const map = L.map('map', { zoomControl: true, attributionControl: false })
  .setView([25.033, 121.5354], 15);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd', maxZoom: 20,
}).addTo(map);

const wpIcon = (i: number) =>
  L.divIcon({ className: '', html: `<div class="wp-marker"><span>${i + 1}</span></div>`,
    iconSize: [22, 22], iconAnchor: [11, 22] });
const posIcon = L.divIcon({ className: '', html: '<div class="pos-marker"></div>',
  iconSize: [16, 16], iconAnchor: [8, 8] });

map.on('click', (e: any) => {
  const pt = { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) };
  if (spotPickMode) { fillFormCoord(pt); return; }
  if (routePickMode) { addRoutePointFromMap(pt); return; }
  if (currentState === 'running') return;
  addWaypoint(pt);
});

function addWaypoint(pt: LatLng): void {
  if (mode === 'teleport' || mode === 'joystick') waypoints = [pt];
  else if (mode === 'two-point' && waypoints.length >= 2) waypoints = [waypoints[1], pt];
  else waypoints.push(pt);
  redrawWaypoints();
}

function redrawWaypoints(): void {
  wpMarkers.forEach((m) => map.removeLayer(m));
  wpMarkers = waypoints.map((p, i) => {
    const mk = L.marker([p.lat, p.lng], { icon: wpIcon(i), draggable: true }).addTo(map);
    mk.on('dragend', () => {
      const ll = mk.getLatLng();
      waypoints[i] = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) };
      redrawWaypoints();
    });
    return mk;
  });
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (waypoints.length > 1 && mode !== 'teleport' && mode !== 'joystick') {
    const lls = waypoints.map((p) => [p.lat, p.lng]);
    if ((($('loop') as HTMLInputElement).checked)) lls.push([waypoints[0].lat, waypoints[0].lng]);
    routeLine = L.polyline(lls, { color: '#60a5fa', weight: 2, opacity: .6, dashArray: '6 6' }).addTo(map);
  }
  renderWpList();
}

function renderWpList(): void {
  const list = $('wp-list');
  $('wp-count').textContent = waypoints.length ? `(${waypoints.length})` : '';
  list.innerHTML = waypoints.length
    ? waypoints.map((p, i) =>
        `<div class="wp"><span class="idx">${i + 1}</span><span class="coord">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</span></div>`).join('')
    : '<div class="empty-hint">尚無航點。點擊地圖新增座標。</div>';
}

// ── 模式 / 速度 ──
$('modes').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('.mode-btn') as HTMLElement | null;
  if (!b) return;
  document.querySelectorAll('.mode-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  mode = b.dataset.mode as Mode;
  $('dpad-section').style.display = mode === 'joystick' ? 'block' : 'none';
  if (mode === 'teleport' || mode === 'joystick') waypoints = waypoints.slice(-1);
  else if (mode === 'two-point') waypoints = waypoints.slice(-2);
  redrawWaypoints();
});

$('speed').addEventListener('input', (e) =>
  $('speed-val').textContent = fmtSpeed(+(e.target as HTMLInputElement).value));
$('vary').addEventListener('input', (e) =>
  $('vary-val').textContent = `${(e.target as HTMLInputElement).value}%`);
$('loop').addEventListener('change', redrawWaypoints);

// ── 裝置連線 ──
$('btn-device').addEventListener('click', async () => {
  if (deviceConnected) { await sim.disconnect(); return; }
  const platform = ($('platform') as HTMLSelectElement).value as 'ios' | 'android';
  $('btn-device').textContent = '連線中…';
  try {
    await sim.connect(platform, {});
  } catch (err) {
    flash(`連線失敗：${(err as Error).message}`);
    updateDeviceUI(false);
  }
});

// ── 移動控制 ──
$('btn-start').addEventListener('click', async () => {
  if (currentState === 'paused') { await sim.resume(); return; }
  if (!waypoints.length) return flash('請先在地圖新增航點');
  if ((mode === 'two-point' || mode === 'multi-point') && waypoints.length < 2)
    return flash('此模式至少需要兩個航點');
  if (trailLine) { map.removeLayer(trailLine); trailLine = null; }
  const pts = waypoints.map((p) => ({ ...p }));
  if (($('reverse') as HTMLInputElement).checked) pts.reverse();
  await sim.start({
    mode,
    points: pts,
    speedKmh: +($('speed') as HTMLInputElement).value,
    loop: ($('loop') as HTMLInputElement).checked,
    jitterM: ($('jitter') as HTMLInputElement).checked ? settings.jitterM : 0,
    repeat: Math.max(1, +($('repeat') as HTMLInputElement).value || 1),
    dwellSec: Math.max(0, +($('dwell') as HTMLInputElement).value || 0),
    speedVarPct: Math.max(0, Math.min(80, +($('vary') as HTMLInputElement).value || 0)) / 100,
  });
});
$('btn-pause').addEventListener('click', () => sim.pause());
$('btn-clear').addEventListener('click', async () => {
  await sim.stop();
  waypoints = [];
  if (trailLine) { map.removeLayer(trailLine); trailLine = null; }
  if (posMarker) { map.removeLayer(posMarker); posMarker = null; }
  redrawWaypoints();
  resetTelemetry();
});

// ── 搖桿 ──
const keyMap: Record<string, number> = { ArrowUp: 0, ArrowRight: 90, ArrowDown: 180, ArrowLeft: 270 };
document.querySelectorAll('.dbtn[data-dir]').forEach((b) => {
  const dir = +(b as HTMLElement).dataset.dir!;
  const down = () => { b.classList.add('held'); sim.setHeading(dir, true); };
  const up = () => { b.classList.remove('held'); sim.setHeading(dir, false); };
  b.addEventListener('mousedown', down);
  b.addEventListener('mouseup', up);
  b.addEventListener('mouseleave', up);
});
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}
document.addEventListener('keydown', (e) => {
  if (isTyping()) return;
  // 空白鍵：開始 / 暫停
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    if (currentState === 'running') sim.pause();
    else (($('btn-start') as HTMLButtonElement)).click();
    return;
  }
  if (!(e.key in keyMap) || currentState !== 'running') return;
  e.preventDefault(); sim.setHeading(keyMap[e.key], true);
});
document.addEventListener('keyup', (e) => {
  if (isTyping() || !(e.key in keyMap)) return;
  sim.setHeading(keyMap[e.key], false);
});

// ── 來自 main 的事件 ──
let currentState = 'idle';

sim.onPosition(({ pos, session }) => {
  const ll = [pos.lat, pos.lng];
  if (!posMarker) posMarker = L.marker(ll, { icon: posIcon, zIndexOffset: 1000 }).addTo(map);
  else posMarker.setLatLng(ll);
  if (!trailLine) trailLine = L.polyline([ll], { color: '#2dd4bf', weight: 3, opacity: .9 }).addTo(map);
  else trailLine.addLatLng(ll);
  if (settings.follow) map.panTo(ll, { animate: true, duration: 0.2 });

  $('t-pos').textContent = `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
  const m = session.coveredM ?? 0;
  $('t-dist').textContent = fmtDist(m);
  const pct = Math.round((session.progress ?? 0) * 100);
  $('t-prog').textContent = `${pct}%`;
  ($('t-bar') as HTMLElement).style.width = `${pct}%`;

  // 預估剩餘時間（以目前設定速度估算，未計入停留）
  const total = session.totalM ?? 0;
  const speedMs = (+($('speed') as HTMLInputElement).value) * MS_PER_KMH;
  const remainM = Math.max(0, total - m);
  $('t-eta').textContent = total > 0 && speedMs > 0 ? fmtDuration(remainM / speedMs) : '—';
});

sim.onState((state) => {
  currentState = state;
  $('t-state').textContent = state;
  const dot = $('status-dot');
  dot.className = 'dot ' + (state === 'idle' ? '' : state);
  const labels: Record<string, string> = { idle: '待命中', running: '移動中', paused: '已暫停', finished: '已抵達' };
  $('status-text').textContent = labels[state] ?? state;
  ($('btn-pause') as HTMLButtonElement).disabled = state !== 'running';
  $('btn-start').textContent = state === 'paused' ? '繼續' : '開始';
});

sim.onDeviceStatus((s) => {
  if (s.error) flash(`裝置錯誤：${s.error}`);
  updateDeviceUI(!!s.connected, s.platform);
});
sim.onDeviceLog((m) => { console.log('[device]', m); appendLog(m); });

function updateDeviceUI(connected: boolean, platform?: string): void {
  deviceConnected = connected;
  $('btn-device').textContent = connected ? `中斷 ${platform ?? ''}` : '連接裝置';
  $('btn-device').classList.toggle('connected', connected);
  $('device-dot').className = 'dot ' + (connected ? 'running' : '');
}

// ── 工具 ──
function flash(msg: string): void {
  const h = $('map-hint');
  h.textContent = msg; h.style.opacity = '1';
  setTimeout(() => { h.style.opacity = '0'; }, 2200);
}
function resetTelemetry(): void {
  $('t-pos').textContent = '—'; $('t-dist').textContent = fmtDist(0);
  $('t-eta').textContent = '—';
  $('t-prog').textContent = '0%'; ($('t-bar') as HTMLElement).style.width = '0';
}

resetTelemetry();
renderWpList();

/* ════════════════════════════════════════════════════════
   地點庫
   ════════════════════════════════════════════════════════ */
const spotsApi = window.spots;

const TYPE_META: Record<SpotType, { label: string; color: string; glyph: string }> = {
  flower:   { label: '花',   color: '#f472b6', glyph: '✿' },
  mushroom: { label: '菇',   color: '#fbbf24', glyph: '⊕' },
  hidden:   { label: '隱藏', color: '#8a97a6', glyph: '◇' },
};

let allSpots: Spot[] = [];
let spotMarkers: any[] = [];
const filterTypes = new Set<SpotType>(['flower', 'mushroom', 'hidden']);
let filterMinScore = 0;
let sortKey: 'score' | 'lng' | 'tz' = 'score';
let sortDir: 1 | -1 = -1;            // -1 = 降序
let editingId: string | null = null; // null = 新增
let spotPickMode = false;

async function loadSpots(): Promise<void> {
  try {
    allSpots = await spotsApi.list();
  } catch { allSpots = []; }
  renderSpots();
}

function visibleSpots(): Spot[] {
  const out = allSpots.filter(
    (s) => filterTypes.has(s.type) && s.score >= filterMinScore,
  );
  out.sort((a, b) => {
    let d = 0;
    if (sortKey === 'score') d = a.score - b.score;
    else if (sortKey === 'lng') d = a.lng - b.lng;
    else d = (a.utcOffsetMinutes ?? 0) - (b.utcOffsetMinutes ?? 0);
    return d * sortDir;
  });
  return out;
}

function offsetLabel(min?: number): string {
  if (min === undefined) return '';
  const sign = min >= 0 ? '+' : '−';
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.abs(min) % 60;
  return ` (${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''})`;
}

function renderSpots(): void {
  const list = $('spot-list');
  const vis = visibleSpots();
  $('spot-count').textContent = `(${vis.length}/${allSpots.length})`;
  if (vis.length === 0) {
    list.innerHTML = '<div class="empty-hint">沒有符合的地點。按上方「新增地點」建立。</div>';
  } else {
    list.innerHTML = vis
      .map((s) => {
        const t = TYPE_META[s.type];
        const tz = s.timezone ? `${s.country ?? '—'} · ${s.timezone}${offsetLabel(s.utcOffsetMinutes)}` : '—';
        return `<div class="spot">
          <span class="sicon" style="background:${t.color}22;color:${t.color}">${t.glyph}</span>
          <div class="sbody">
            <div class="sname">${esc(s.name)}</div>
            <div class="smeta">${s.score.toFixed(1)} 分 · ${esc(tz)}</div>
            <div class="scoord">${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</div>
          </div>
          <div class="sact">
            <button data-act="load" data-id="${s.id}" aria-label="載入到地圖" title="載入到地圖">⌖</button>
            <button data-act="edit" data-id="${s.id}" aria-label="編輯" title="編輯">✎</button>
            <button data-act="del" data-id="${s.id}" aria-label="刪除" title="刪除">🗑</button>
          </div>
        </div>`;
      })
      .join('');
  }
  renderSpotMarkers(vis);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function renderSpotMarkers(vis: Spot[]): void {
  spotMarkers.forEach((m) => map.removeLayer(m));
  spotMarkers = vis.map((s) => {
    const t = TYPE_META[s.type];
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:14px;height:14px;border-radius:50%;background:${t.color};border:2px solid #0c0f14"></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7],
    });
    return L.marker([s.lat, s.lng], { icon })
      .addTo(map)
      .bindTooltip(`${s.name}（${s.score.toFixed(1)}）`, { direction: 'top' });
  });
}

// 清單上的動作（事件委派）
$('spot-list').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null;
  if (!btn) return;
  const id = btn.dataset.id!;
  const act = btn.dataset.act;
  const spot = allSpots.find((s) => s.id === id);
  if (!spot) return;
  if (act === 'load') loadSpotToMap(spot);
  else if (act === 'edit') openForm(spot);
  else if (act === 'del') deleteSpot(spot);
});

function loadSpotToMap(s: Spot): void {
  addWaypoint({ lat: s.lat, lng: s.lng });   // 依目前模式放上地圖
  map.panTo([s.lat, s.lng], { animate: true });
  flash(`已載入「${s.name}」到地圖`);
}

async function deleteSpot(s: Spot): Promise<void> {
  if (!confirm(`確定刪除地點「${s.name}」？此動作無法復原。`)) return;
  await spotsApi.remove(s.id);
  await loadSpots();
}

// ── 篩選 / 排序控制 ──
$('sf-types').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('.chip') as HTMLElement | null;
  if (!b) return;
  const t = b.dataset.type as SpotType;
  if (filterTypes.has(t)) filterTypes.delete(t);
  else filterTypes.add(t);
  b.classList.toggle('active');
  renderSpots();
});
$('sf-score').addEventListener('input', (e) => {
  filterMinScore = +(e.target as HTMLInputElement).value;
  $('sf-score-val').textContent = filterMinScore.toFixed(1);
  renderSpots();
});
$('sf-sort').addEventListener('change', (e) => {
  sortKey = (e.target as HTMLSelectElement).value as typeof sortKey;
  renderSpots();
});
$('sf-dir').addEventListener('click', () => {
  sortDir = sortDir === 1 ? -1 : 1;
  $('sf-dir').textContent = sortDir === 1 ? '↑' : '↓';
  renderSpots();
});

// ── 新增 / 編輯表單 ──
function openForm(spot?: Spot): void {
  editingId = spot?.id ?? null;
  $('spot-form-title').textContent = spot ? '編輯地點' : '新增地點';
  ($('spot-name') as HTMLInputElement).value = spot?.name ?? '';
  ($('spot-lat') as HTMLInputElement).value = spot ? String(spot.lat) : '';
  ($('spot-lng') as HTMLInputElement).value = spot ? String(spot.lng) : '';
  ($('spot-score') as HTMLInputElement).value = String(spot?.score ?? 8);
  $('spot-score-val').textContent = (spot?.score ?? 8).toFixed(1);
  ($('spot-type') as HTMLSelectElement).value = spot?.type ?? 'mushroom';
  $('spot-form').style.display = 'block';
  $('spot-form').scrollIntoView({ behavior: 'smooth' });
}
function closeForm(): void {
  $('spot-form').style.display = 'none';
  spotPickMode = false;
  editingId = null;
}
function fillFormCoord(pt: LatLng): void {
  ($('spot-lat') as HTMLInputElement).value = String(pt.lat);
  ($('spot-lng') as HTMLInputElement).value = String(pt.lng);
  spotPickMode = false;
  flash('已帶入座標');
}

$('btn-spot-add').addEventListener('click', () => openForm());
$('btn-spot-cancel').addEventListener('click', closeForm);
$('btn-spot-import').addEventListener('click', async () => {
  const res = await spotsApi.importCsv();
  if (res.canceled) return;
  if (!res.ok) {
    flash(`匯入失敗：${res.errors[0] ?? '未知錯誤'}`);
    return;
  }
  await loadSpots();
  let msg = `已匯入 ${res.added} 筆`;
  if (res.skipped) msg += `，略過 ${res.skipped} 筆`;
  flash(msg);
});
$('btn-spot-pick').addEventListener('click', () => {
  spotPickMode = true;
  flash('請在地圖上點選座標');
});
$('spot-score').addEventListener('input', (e) =>
  $('spot-score-val').textContent = (+(e.target as HTMLInputElement).value).toFixed(1));

$('btn-spot-save').addEventListener('click', async () => {
  const name = ($('spot-name') as HTMLInputElement).value.trim();
  const lat = parseFloat(($('spot-lat') as HTMLInputElement).value);
  const lng = parseFloat(($('spot-lng') as HTMLInputElement).value);
  if (!name) return flash('請輸入名稱');
  if (Number.isNaN(lat) || Number.isNaN(lng)) return flash('請輸入有效的經緯度');
  const input: SpotInput = {
    name, lat, lng,
    score: +($('spot-score') as HTMLInputElement).value,
    type: ($('spot-type') as HTMLSelectElement).value as SpotType,
  };
  try {
    if (editingId) await spotsApi.update(editingId, input);
    else await spotsApi.create(input);
    closeForm();
    await loadSpots();
  } catch (err) {
    flash(`儲存失敗：${(err as Error).message}`);
  }
});

loadSpots();

/* ════════════════════════════════════════════════════════
   地點庫面板：拖曳調寬 + 收摺（寬度/收摺狀態存 localStorage）
   ════════════════════════════════════════════════════════ */
const PANEL_MIN = 280;
const PANEL_MAX = 560;
const PANEL_DEFAULT = 340;

const panelEl = $('spots-panel');
const resizerEl = $('spots-resizer');

function setPanelWidth(w: number): void {
  const clamped = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(w)));
  panelEl.style.width = `${clamped}px`;
  try { localStorage.setItem('spotsPanelWidth', String(clamped)); } catch { /* ignore */ }
}

function setCollapsed(collapsed: boolean): void {
  document.body.classList.toggle('spots-collapsed', collapsed);
  try { localStorage.setItem('spotsPanelCollapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
  // 面板開合會改變地圖容器大小，讓 Leaflet 重新計算避免圖磚錯位
  setTimeout(() => map.invalidateSize(), 60);
}

// 還原上次狀態
const savedW = Number(localStorage.getItem('spotsPanelWidth'));
setPanelWidth(Number.isFinite(savedW) && savedW > 0 ? savedW : PANEL_DEFAULT);
setCollapsed(localStorage.getItem('spotsPanelCollapsed') === '1');

// 拖曳調寬
let dragging = false;
resizerEl.addEventListener('mousedown', (e) => {
  e.preventDefault();
  dragging = true;
  resizerEl.classList.add('dragging');
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  setPanelWidth(window.innerWidth - e.clientX); // 面板貼右緣
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  resizerEl.classList.remove('dragging');
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  map.invalidateSize();
});

// 收摺 / 展開
$('btn-spots-collapse').addEventListener('click', () => setCollapsed(true));
$('spots-expand').addEventListener('click', () => setCollapsed(false));

/* ════════════════════════════════════════════════════════
   分頁切換（地點 / 路線）
   ════════════════════════════════════════════════════════ */
$('panel-tabs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('.ptab') as HTMLElement | null;
  if (!b) return;
  const tab = b.dataset.tab;
  document.querySelectorAll('.ptab').forEach((x) => x.classList.toggle('active', x === b));
  $('tab-spots').style.display = tab === 'spots' ? 'flex' : 'none';
  $('tab-routes').style.display = tab === 'routes' ? 'flex' : 'none';
});

/* ════════════════════════════════════════════════════════
   路線庫
   ════════════════════════════════════════════════════════ */
const routesApi = window.routes;

let allRoutes: SavedRoute[] = [];
let routeEditId: string | null = null;     // null = 新路線
let routePts: RoutePoint[] = [];            // 編輯器的工作座標
let routePickMode = false;
let routeEditMarkers: any[] = [];           // 編輯中座標點在地圖上的標記
let routeEditLine: any = null;

const routeEditIcon = (i: number) =>
  L.divIcon({ className: '', html: `<div class="re-marker"><span>${i + 1}</span></div>`,
    iconSize: [22, 22], iconAnchor: [11, 22] });

function clearRouteEditPreview(): void {
  routeEditMarkers.forEach((m) => map.removeLayer(m));
  routeEditMarkers = [];
  if (routeEditLine) { map.removeLayer(routeEditLine); routeEditLine = null; }
}

// 把編輯器目前的座標點畫到地圖（琥珀色，與正式航點的藍色區分）
function drawRouteEditPreview(): void {
  clearRouteEditPreview();
  const pts = routePts.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  routeEditMarkers = pts.map((p, i) => {
    const idx = routePts.indexOf(p);
    const mk = L.marker([p.lat, p.lng], { icon: routeEditIcon(i), draggable: true }).addTo(map);
    mk.on('dragend', () => {
      const ll = mk.getLatLng();
      if (idx >= 0) { routePts[idx] = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }; }
      renderRoutePoints();
    });
    return mk;
  });
  if (pts.length > 1) {
    const lls = pts.map((p) => [p.lat, p.lng]);
    if (($('route-loop') as HTMLInputElement).checked) lls.push([pts[0].lat, pts[0].lng]);
    routeEditLine = L.polyline(lls, { color: '#f59e0b', weight: 3, opacity: 0.85 }).addTo(map);
  }
}

function fitRouteEdit(): void {
  const pts = routePts.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (pts.length > 1) map.fitBounds(pts.map((p) => [p.lat, p.lng]), { padding: [50, 50] });
  else if (pts.length === 1) map.panTo([pts[0].lat, pts[0].lng]);
}

function haversine(a: RoutePoint, b: RoutePoint): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function routeDistanceKm(pts: RoutePoint[], loop: boolean): number {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += haversine(pts[i - 1], pts[i]);
  if (loop && pts.length > 1) m += haversine(pts[pts.length - 1], pts[0]);
  return m / 1000;
}

async function loadRoutes(): Promise<void> {
  try { allRoutes = await routesApi.list(); } catch { allRoutes = []; }
  renderRoutes();
}

function renderRoutes(): void {
  const list = $('route-list');
  $('route-count').textContent = allRoutes.length ? `(${allRoutes.length})` : '';
  if (allRoutes.length === 0) {
    list.innerHTML =
      '<div class="empty-hint">尚無路線。在「多點路線」模式於地圖點航點後，按「從目前航點儲存」。</div>';
    return;
  }
  list.innerHTML = allRoutes
    .map((r) => {
      const km = routeDistanceKm(r.points, r.loop);
      const meta = `${r.points.length} 點 · 約 ${fmtKm(km)}${r.loop ? ' · ⟲循環' : ''}`;
      return `<div class="route">
        <div class="rbody">
          <div class="rname">${esc(r.name)}</div>
          <div class="rmeta">${esc(meta)}</div>
        </div>
        <div class="ract">
          <button data-act="load" data-id="${r.id}" aria-label="載入到地圖" title="載入到地圖">⌖</button>
          <button data-act="edit" data-id="${r.id}" aria-label="編輯" title="編輯">✎</button>
          <button data-act="del" data-id="${r.id}" aria-label="刪除" title="刪除">🗑</button>
        </div>
      </div>`;
    })
    .join('');
}

$('route-list').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null;
  if (!btn) return;
  const r = allRoutes.find((x) => x.id === btn.dataset.id);
  if (!r) return;
  const act = btn.dataset.act;
  if (act === 'load') loadRouteToMap(r);
  else if (act === 'edit') openRouteForm(r);
  else if (act === 'del') deleteRoute(r);
});

// 載入到地圖：切多點模式、灌入航點、代入循環與速度（速度可再自行調整）
function loadRouteToMap(r: SavedRoute): void {
  mode = 'multi-point';
  document.querySelectorAll('.mode-btn').forEach((x) =>
    x.classList.toggle('active', (x as HTMLElement).dataset.mode === 'multi-point'),
  );
  $('dpad-section').style.display = 'none';

  waypoints = r.points.map((p) => ({ lat: p.lat, lng: p.lng }));
  ($('loop') as HTMLInputElement).checked = r.loop;
  if (r.speedKmh !== undefined) {
    ($('speed') as HTMLInputElement).value = String(r.speedKmh);
    $('speed-val').textContent = fmtSpeed(r.speedKmh);
  }
  redrawWaypoints();
  if (waypoints.length > 1) {
    map.fitBounds(waypoints.map((p) => [p.lat, p.lng]), { padding: [40, 40] });
  } else if (waypoints.length === 1) {
    map.panTo([waypoints[0].lat, waypoints[0].lng]);
  }
  flash(`已載入路線「${r.name}」（速度 ${fmtSpeed(+($('speed') as HTMLInputElement).value)}，可再調整）`);
}

async function deleteRoute(r: SavedRoute): Promise<void> {
  if (!confirm(`確定刪除路線「${r.name}」？此動作無法復原。`)) return;
  await routesApi.remove(r.id);
  await loadRoutes();
}

// ── 座標點編輯器 ──
function renderRoutePoints(): void {
  const el = $('route-points');
  $('route-pt-count').textContent = routePts.length ? `(${routePts.length})` : '';
  el.innerHTML =
    routePts
      .map(
        (p, i) => `<div class="rpt" data-i="${i}">
          <span class="ri">${i + 1}</span>
          <input class="rlat" inputmode="decimal" value="${p.lat}" aria-label="緯度">
          <input class="rlng" inputmode="decimal" value="${p.lng}" aria-label="經度">
          <button data-act="up" title="上移">↑</button>
          <button data-act="down" title="下移">↓</button>
          <button data-act="del" title="刪除">✕</button>
        </div>`,
      )
      .join('') || '<div class="empty-hint">尚無座標點。「新增點」或「從地圖點選」。</div>';
  drawRouteEditPreview();
}

$('route-points').addEventListener('input', (e) => {
  const row = (e.target as HTMLElement).closest('.rpt') as HTMLElement | null;
  if (!row) return;
  const i = +row.dataset.i!;
  const t = e.target as HTMLInputElement;
  if (t.classList.contains('rlat')) routePts[i].lat = parseFloat(t.value);
  else if (t.classList.contains('rlng')) routePts[i].lng = parseFloat(t.value);
  drawRouteEditPreview();
});

$('route-points').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null;
  if (!btn) return;
  const row = btn.closest('.rpt') as HTMLElement;
  const i = +row.dataset.i!;
  const act = btn.dataset.act;
  if (act === 'del') routePts.splice(i, 1);
  else if (act === 'up' && i > 0) [routePts[i - 1], routePts[i]] = [routePts[i], routePts[i - 1]];
  else if (act === 'down' && i < routePts.length - 1)
    [routePts[i], routePts[i + 1]] = [routePts[i + 1], routePts[i]];
  renderRoutePoints();
});

function addRoutePointFromMap(pt: LatLng): void {
  routePts.push({ lat: pt.lat, lng: pt.lng });
  renderRoutePoints();
  flash(`已加入座標點（${routePts.length}），可繼續點或再按一次關閉選點`);
}

// ── 表單開關 ──
function openRouteForm(route?: SavedRoute): void {
  routeEditId = route?.id ?? null;
  $('route-form-title').textContent = route ? '編輯路線' : '新路線';
  ($('route-name') as HTMLInputElement).value = route?.name ?? '';
  const spd = route?.speedKmh ?? +($('speed') as HTMLInputElement).value;
  ($('route-speed') as HTMLInputElement).value = String(spd);
  $('route-speed-val').textContent = String(spd);
  ($('route-loop') as HTMLInputElement).checked = route?.loop ?? false;
  routePts = (route?.points ?? []).map((p) => ({ lat: p.lat, lng: p.lng }));
  renderRoutePoints();
  fitRouteEdit();
  $('route-form').style.display = 'block';
  $('route-form').scrollIntoView({ behavior: 'smooth' });
}
function closeRouteForm(): void {
  $('route-form').style.display = 'none';
  routePickMode = false;
  routeEditId = null;
  clearRouteEditPreview();
}
$('route-loop').addEventListener('change', drawRouteEditPreview);

$('btn-route-new').addEventListener('click', () => openRouteForm());
$('btn-route-cancel').addEventListener('click', closeRouteForm);

// 從目前地圖航點開新路線（名稱待輸入、帶入目前速度與循環）
$('btn-route-from-wp').addEventListener('click', () => {
  if (!waypoints.length) return flash('地圖上尚無航點');
  routeEditId = null;
  $('route-form-title').textContent = '新路線（來自目前航點）';
  ($('route-name') as HTMLInputElement).value = '';
  const spd = +($('speed') as HTMLInputElement).value;
  ($('route-speed') as HTMLInputElement).value = String(spd);
  $('route-speed-val').textContent = String(spd);
  ($('route-loop') as HTMLInputElement).checked = ($('loop') as HTMLInputElement).checked;
  routePts = waypoints.map((p) => ({ lat: p.lat, lng: p.lng }));
  renderRoutePoints();
  fitRouteEdit();
  $('route-form').style.display = 'block';
  $('route-form').scrollIntoView({ behavior: 'smooth' });
});

$('btn-route-addpt').addEventListener('click', () => {
  const c = map.getCenter();
  routePts.push({ lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6) });
  renderRoutePoints();
});
$('btn-route-pickpt').addEventListener('click', () => {
  routePickMode = !routePickMode;
  flash(routePickMode ? '點地圖加入座標點（再按一次關閉）' : '已關閉選點');
});
$('btn-route-capture').addEventListener('click', () => {
  if (!waypoints.length) return flash('地圖上尚無航點');
  routePts = waypoints.map((p) => ({ lat: p.lat, lng: p.lng }));
  renderRoutePoints();
  flash(`已用目前 ${routePts.length} 個航點覆蓋`);
});
$('route-speed').addEventListener('input', (e) =>
  ($('route-speed-val').textContent = (e.target as HTMLInputElement).value));

$('btn-route-save').addEventListener('click', async () => {
  const name = ($('route-name') as HTMLInputElement).value.trim();
  const pts = routePts.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!name) return flash('請輸入路線名稱');
  if (pts.length < 2) return flash('路線至少需要兩個有效座標點');
  const input: RouteInput = {
    name,
    points: pts,
    loop: ($('route-loop') as HTMLInputElement).checked,
    speedKmh: +($('route-speed') as HTMLInputElement).value,
  };
  try {
    if (routeEditId) await routesApi.update(routeEditId, input);
    else await routesApi.create(input);
    closeRouteForm();
    await loadRoutes();
    flash('路線已儲存');
  } catch (err) {
    flash(`儲存失敗：${(err as Error).message}`);
  }
});

loadRoutes();

/* ════════════════════════════════════════════════════════
   日誌面板
   ════════════════════════════════════════════════════════ */
const logLines: string[] = [];
function appendLog(msg: string): void {
  const ts = new Date().toLocaleTimeString();
  logLines.push(`[${ts}] ${msg}`);
  if (logLines.length > 500) logLines.shift();
  const body = $('log-body');
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
  body.innerHTML = logLines
    .map((l) => {
      const cut = l.indexOf(']') + 1;
      return `<div><span class="lt">${esc(l.slice(0, cut))}</span>${esc(l.slice(cut))}</div>`;
    })
    .join('');
  if (atBottom) body.scrollTop = body.scrollHeight;
}
$('btn-log').addEventListener('click', () => {
  const p = $('log-panel');
  p.style.display = p.style.display === 'none' ? 'flex' : 'none';
});
$('btn-log-close').addEventListener('click', () => ($('log-panel').style.display = 'none'));
$('btn-log-clear').addEventListener('click', () => { logLines.length = 0; $('log-body').innerHTML = ''; });
$('btn-log-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(logLines.join('\n')); flash('日誌已複製'); }
  catch { flash('複製失敗'); }
});

/* ════════════════════════════════════════════════════════
   通道狀態（iOS）＋ 重啟
   ════════════════════════════════════════════════════════ */
function setTunnelPill(state: 'up' | 'down' | 'checking'): void {
  const pill = $('tunnel-pill');
  pill.className = 'tunnel-pill ' + (state === 'checking' ? '' : state);
  const txt = state === 'up' ? '通道：就緒' : state === 'down' ? '通道：未啟動' : '通道：檢查中…';
  pill.innerHTML = `<span class="tdot"></span>${txt}`;
}
async function refreshTunnel(): Promise<void> {
  if (($('platform') as HTMLSelectElement).value !== 'ios') return;
  setTunnelPill('checking');
  try { setTunnelPill((await sim.tunnelStatus()) ? 'up' : 'down'); }
  catch { setTunnelPill('down'); }
}
function syncTunnelRowVisibility(): void {
  const ios = ($('platform') as HTMLSelectElement).value === 'ios';
  $('tunnel-row').style.display = ios ? 'flex' : 'none';
  if (ios) refreshTunnel();
}
$('btn-tunnel-restart').addEventListener('click', async () => {
  setTunnelPill('checking');
  ($('btn-tunnel-restart') as HTMLButtonElement).disabled = true;
  flash('重啟通道中…（可能需要授權）');
  try { await sim.tunnelRestart(); } finally {
    ($('btn-tunnel-restart') as HTMLButtonElement).disabled = false;
    refreshTunnel();
  }
});
$('platform').addEventListener('change', () => {
  syncTunnelRowVisibility();
  if (settings.rememberLast) {
    try { localStorage.setItem('lastDevice', ($('platform') as HTMLSelectElement).value); } catch { /* ignore */ }
  }
});
setInterval(() => { if ($('tunnel-row').style.display !== 'none') refreshTunnel(); }, 8000);

/* ════════════════════════════════════════════════════════
   設定彈窗
   ════════════════════════════════════════════════════════ */
function applySettings(): void {
  ($('speed') as HTMLInputElement).value = String(settings.defaultSpeed);
  $('speed-val').textContent = fmtSpeed(settings.defaultSpeed);
  ($('follow') as HTMLInputElement).checked = settings.follow;
  resetTelemetry();
  renderRoutes();
}
$('follow').addEventListener('change', () => {
  settings.follow = ($('follow') as HTMLInputElement).checked;
  saveSettings();
});
$('btn-settings').addEventListener('click', () => {
  ($('set-speed') as HTMLInputElement).value = String(settings.defaultSpeed);
  ($('set-jitter') as HTMLInputElement).value = String(settings.jitterM);
  ($('set-units') as HTMLSelectElement).value = settings.units;
  ($('set-remember') as HTMLInputElement).checked = settings.rememberLast;
  $('settings-overlay').style.display = 'flex';
});
function closeSettings(): void { $('settings-overlay').style.display = 'none'; }
$('btn-settings-close').addEventListener('click', closeSettings);
$('settings-overlay').addEventListener('click', (e) => {
  if (e.target === $('settings-overlay')) closeSettings();
});
$('set-speed').addEventListener('change', () => {
  settings.defaultSpeed = Math.max(1, Math.min(500, +($('set-speed') as HTMLInputElement).value || 60));
  saveSettings();
});
$('set-jitter').addEventListener('change', () => {
  settings.jitterM = Math.max(0, Math.min(50, +($('set-jitter') as HTMLInputElement).value || 0));
  saveSettings();
});
$('set-units').addEventListener('change', () => {
  settings.units = ($('set-units') as HTMLSelectElement).value === 'imperial' ? 'imperial' : 'metric';
  saveSettings();
  $('speed-val').textContent = fmtSpeed(+($('speed') as HTMLInputElement).value);
  renderRoutes();
  resetTelemetry();
});
$('set-remember').addEventListener('change', () => {
  settings.rememberLast = ($('set-remember') as HTMLInputElement).checked;
  saveSettings();
});

// 備份匯出 / 匯入
$('btn-backup-export').addEventListener('click', async () => {
  const r = await window.backup.export();
  if (r.canceled) return;
  flash(r.ok ? `已匯出（地點 ${r.spots}、路線 ${r.routes}）` : `匯出失敗：${r.error ?? ''}`);
});
$('btn-backup-import').addEventListener('click', async () => {
  if (!confirm('匯入備份會覆蓋目前的地點與路線，確定繼續？')) return;
  const r = await window.backup.import();
  if (r.canceled) return;
  if (r.ok) {
    flash(`已匯入（地點 ${r.spots}、路線 ${r.routes}）`);
    await loadSpots();
    await loadRoutes();
  } else {
    flash(`匯入失敗：${r.error ?? ''}`);
  }
});

/* ════════════════════════════════════════════════════════
   記住上次的地圖視角 / 模式 / 裝置
   ════════════════════════════════════════════════════════ */
function applyMode(m: Mode): void {
  mode = m;
  document.querySelectorAll('.mode-btn').forEach((x) =>
    x.classList.toggle('active', (x as HTMLElement).dataset.mode === m));
  $('dpad-section').style.display = m === 'joystick' ? 'block' : 'none';
  redrawWaypoints();
}
map.on('moveend', () => {
  if (!settings.rememberLast) return;
  const c = map.getCenter();
  try { localStorage.setItem('lastView', JSON.stringify({ lat: c.lat, lng: c.lng, z: map.getZoom() })); } catch { /* ignore */ }
});
$('modes').addEventListener('click', () => {
  if (settings.rememberLast) { try { localStorage.setItem('lastMode', mode); } catch { /* ignore */ } }
});
function restoreLast(): void {
  if (!settings.rememberLast) return;
  try {
    const v = JSON.parse(localStorage.getItem('lastView') || 'null');
    if (v && isFinite(v.lat) && isFinite(v.lng)) map.setView([v.lat, v.lng], v.z || map.getZoom());
  } catch { /* ignore */ }
  try {
    const dev = localStorage.getItem('lastDevice');
    if (dev === 'ios' || dev === 'android') ($('platform') as HTMLSelectElement).value = dev;
  } catch { /* ignore */ }
  try {
    const lm = localStorage.getItem('lastMode') as Mode | null;
    if (lm && lm !== 'teleport') applyMode(lm);
  } catch { /* ignore */ }
}

// ── 初始化 ──
applySettings();
restoreLast();
syncTunnelRowVisibility();
