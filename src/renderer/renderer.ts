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

const DEVICE_COLORS = ['#2dd4bf', '#f59e0b', '#a78bfa', '#f472b6', '#38bdf8', '#a3e635'];
interface DeviceState {
  id: string;
  platform: 'ios' | 'android';
  name: string;
  connection: 'usb' | 'wifi' | '';
  color: string;
  // 設定（每台一份）
  mode: Mode; waypoints: LatLng[];
  speedKmh: number; loop: boolean; jitter: boolean; reverse: boolean;
  repeat: number; dwellSec: number; varyPct: number;
  // 執行期
  state: 'idle' | 'running' | 'paused' | 'finished';
  coveredM: number; totalM: number; progress: number;
  posMarker: any; trailLine: any;
}
const connected = new Map<string, DeviceState>();
let activeId: string | null = null;

// ── 設定（存 localStorage）──
interface AppSettings {
  defaultSpeed: number;          // km/h
  jitterM: number;               // 抖動半徑（公尺）
  units: 'metric' | 'imperial';
  rememberLast: boolean;
  follow: boolean;
  autoTunnel: boolean;           // 啟動時自動暖機 iOS 通道
  // 地點篩選/排序（下次開啟還原）
  spotTypes: SpotType[];
  spotMinScore: number;
  spotSort: 'score' | 'lng' | 'tz';
  spotSortDir: 1 | -1;
}
const DEFAULT_SETTINGS: AppSettings = {
  defaultSpeed: 60, jitterM: 3, units: 'metric', rememberLast: true, follow: true, autoTunnel: true,
  spotTypes: ['flower', 'mushroom', 'hidden'], spotMinScore: 0, spotSort: 'score', spotSortDir: -1,
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
// 單一張世界：限制平移範圍、邊界擋住、圖磚不橫向重複（避免捲到「世界副本」導致經度超出 ±180）
const WORLD_BOUNDS = L.latLngBounds([-85, -180], [85, 180]);
const map = L.map('map', {
  zoomControl: true,
  attributionControl: false,
  maxBounds: WORLD_BOUNDS,
  maxBoundsViscosity: 1.0,
  minZoom: 2,
  worldCopyJump: false,
})
  .setView([25.033, 121.5354], 15);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd', maxZoom: 20, noWrap: true, bounds: WORLD_BOUNDS,
}).addTo(map);

const wpIcon = (i: number) =>
  L.divIcon({ className: '', html: `<div class="wp-marker"><span>${i + 1}</span></div>`,
    iconSize: [22, 22], iconAnchor: [11, 22] });

// 把經度 wrap 回 −180～180、緯度夾在 ±90。
// 從地圖取點時若地圖被捲到下一個「世界副本」，Leaflet 會回傳超出 ±180 的經度
//（例如巴黎 +2.3 變成 −357.7），不修正就會畫到地圖另一端、注入裝置也會錯。
function normLng(lng: number): number { return ((lng + 180) % 360 + 360) % 360 - 180; }
function normPt(p: { lat: number; lng: number }): LatLng {
  return {
    lat: +Math.max(-90, Math.min(90, p.lat)).toFixed(6),
    lng: +normLng(p.lng).toFixed(6),
  };
}

map.on('click', (e: any) => {
  const pt = normPt({ lat: e.latlng.lat, lng: e.latlng.lng });
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
      waypoints[i] = normPt({ lat: ll.lat, lng: ll.lng });
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
  if (currentState === 'running' || currentState === 'paused') {
    flash('移動中無法切換模式，請先停止');
    return;
  }
  document.querySelectorAll('.mode-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  mode = b.dataset.mode as Mode;
  $('dpad-section').style.display = mode === 'joystick' ? 'block' : 'none';
  if (mode === 'teleport' || mode === 'joystick') waypoints = waypoints.slice(-1);
  else if (mode === 'two-point') waypoints = waypoints.slice(-2);
  redrawWaypoints();
});

$('speed').addEventListener('input', (e) => {
  const v = +(e.target as HTMLInputElement).value;
  $('speed-val').textContent = fmtSpeed(v);
  if (activeId && (currentState === 'running' || currentState === 'paused')) sim.setSpeed(activeId, v);
});
$('vary').addEventListener('input', (e) =>
  $('vary-val').textContent = `${(e.target as HTMLInputElement).value}%`);
$('loop').addEventListener('change', redrawWaypoints);

/* ════════════════════════════════════════════════════════
   多裝置：每台一份 DeviceState，activeId 決定控制面板顯示哪一台
   ════════════════════════════════════════════════════════ */
const posIconColored = (color: string) =>
  L.divIcon({ className: '', html: `<div class="pos-marker" style="background:${color}"></div>`,
    iconSize: [16, 16], iconAnchor: [8, 8] });

function setModeButtons(m: Mode): void {
  document.querySelectorAll('.mode-btn').forEach((x) =>
    x.classList.toggle('active', (x as HTMLElement).dataset.mode === m));
}

function defaultConfig() {
  return {
    mode: 'teleport' as Mode, waypoints: [] as LatLng[], speedKmh: settings.defaultSpeed,
    loop: false, jitter: true, reverse: false, repeat: 1, dwellSec: 0, varyPct: 0,
  };
}

function buildRouteFrom(d: DeviceState) {
  const pts = d.waypoints.map((p) => normPt(p));
  if (d.reverse) pts.reverse();
  return {
    mode: d.mode, points: pts, speedKmh: d.speedKmh, loop: d.loop,
    jitterM: d.jitter ? settings.jitterM : 0,
    repeat: Math.max(1, d.repeat), dwellSec: Math.max(0, d.dwellSec),
    speedVarPct: Math.max(0, Math.min(80, d.varyPct)) / 100,
  };
}

// 把目前 DOM/全域（=作用中裝置的編輯狀態）存回該裝置
function captureActive(): void {
  if (!activeId) return;
  const d = connected.get(activeId);
  if (!d) return;
  d.mode = mode;
  d.waypoints = waypoints.map((p) => ({ ...p }));
  d.speedKmh = +($('speed') as HTMLInputElement).value;
  d.loop = ($('loop') as HTMLInputElement).checked;
  d.jitter = ($('jitter') as HTMLInputElement).checked;
  d.reverse = ($('reverse') as HTMLInputElement).checked;
  d.repeat = Math.max(1, +($('repeat') as HTMLInputElement).value || 1);
  d.dwellSec = Math.max(0, +($('dwell') as HTMLInputElement).value || 0);
  d.varyPct = Math.max(0, Math.min(80, +($('vary') as HTMLInputElement).value || 0));
}

// 切換到某台：先存舊的，再把它的設定灌進控制面板與地圖
function applyActive(id: string): void {
  if (activeId && id !== activeId) captureActive();
  const d = connected.get(id);
  if (!d) return;
  activeId = id;
  mode = d.mode;
  waypoints = d.waypoints.map((p) => ({ ...p }));
  setModeButtons(mode);
  $('dpad-section').style.display = mode === 'joystick' ? 'block' : 'none';
  ($('speed') as HTMLInputElement).value = String(d.speedKmh);
  $('speed-val').textContent = fmtSpeed(d.speedKmh);
  ($('loop') as HTMLInputElement).checked = d.loop;
  ($('jitter') as HTMLInputElement).checked = d.jitter;
  ($('reverse') as HTMLInputElement).checked = d.reverse;
  ($('repeat') as HTMLInputElement).value = String(d.repeat);
  ($('dwell') as HTMLInputElement).value = String(d.dwellSec);
  ($('vary') as HTMLInputElement).value = String(d.varyPct);
  $('vary-val').textContent = `${d.varyPct}%`;
  $('ctl-name').textContent = d.name;
  $('control-section').classList.remove('disabled');
  redrawWaypoints();
  reflectActiveState();
  renderSessions();
}

function clearActive(): void {
  activeId = null;
  waypoints = [];
  redrawWaypoints();
  $('ctl-name').textContent = '—';
  $('control-section').classList.add('disabled');
  currentState = 'idle';
  resetTelemetry();
  $('t-state').textContent = '—';
  $('tele-title').textContent = '遙測';
  $('tele-dot').className = 'dot';
  $('tele-card').classList.add('idle');
  $('status-dot').className = 'dot';
  $('status-text').textContent = connected.size ? '請選擇裝置' : '待命中';
}

// 依作用中裝置更新狀態指示、按鈕、鎖定與遙測
function reflectActiveState(): void {
  const d = activeId ? connected.get(activeId) : null;
  if (!d) { clearActive(); return; }
  currentState = d.state;
  $('t-state').textContent = d.state;
  const dotCls = 'dot ' + (d.state === 'idle' ? '' : d.state);
  $('status-dot').className = dotCls;
  $('tele-dot').className = dotCls;
  const labels: Record<string, string> = { idle: '待命中', running: '移動中', paused: '已暫停', finished: '已抵達' };
  $('status-text').textContent = labels[d.state] ?? d.state;
  $('tele-title').textContent = `${d.name} · ${labels[d.state] ?? d.state}`;
  $('tele-card').classList.toggle('idle', d.state === 'idle' || d.state === 'finished');
  ($('btn-pause') as HTMLButtonElement).disabled = d.state !== 'running';
  $('btn-start-label').textContent = d.state === 'paused' ? '繼續' : '開始';
  setParamLock(d.state === 'running' || d.state === 'paused');
  document.body.classList.toggle('sim-active', d.state === 'running' || d.state === 'paused');
  $('t-dist').textContent = fmtDist(d.coveredM);
  const pct = Math.round(d.progress * 100);
  $('t-prog').textContent = `${pct}%`;
  ($('t-bar') as HTMLElement).style.width = `${pct}%`;
}

function sessSubtext(d: DeviceState): string {
  const labels: Record<string, string> = { idle: '待命中', running: '移動中', paused: '已暫停', finished: '已抵達' };
  const label = labels[d.state] ?? d.state;
  return d.state === 'idle'
    ? label
    : `${label} · ${Math.round(d.progress * 100)}% · ${fmtSpeed(d.speedKmh)}`;
}

function updateSessionRow(d: DeviceState): void {
  const row = document.querySelector(`.sess[data-id="${d.id}"]`);
  if (!row) return;
  const st = row.querySelector('.st');
  const bar = row.querySelector('.mini>div') as HTMLElement | null;
  if (st) st.textContent = sessSubtext(d);
  if (bar) bar.style.width = `${Math.round(d.progress * 100)}%`;
}

function renderSessions(): void {
  const list = $('session-list');
  $('sess-count').textContent = connected.size ? `(${connected.size})` : '';
  if (connected.size === 0) {
    list.innerHTML = '<div class="dev-empty">尚未連接裝置。按「＋ 連接裝置」加入。</div>';
  } else {
    list.innerHTML = [...connected.values()].map((d) => {
      const act = d.id === activeId ? ' active' : '';
      const badge = d.connection === 'wifi' ? '<span class="dev-badge wifi">WiFi</span>'
        : d.connection === 'usb' ? '<span class="dev-badge usb">USB</span>' : '';
      return `<div class="sess${act}" data-id="${esc(d.id)}">
        <span class="swatch" style="background:${d.color}"></span>
        <div class="info">
          <div class="nm">${esc(d.name)} ${badge}</div>
          <div class="st">${esc(sessSubtext(d))}</div>
          <div class="mini"><div style="width:${Math.round(d.progress * 100)}%;background:${d.color}"></div></div>
        </div>
        <button class="x" data-act="disc" data-id="${esc(d.id)}" title="中斷"><svg class="ic" style="width:14px;height:14px"><use href="#i-x"/></svg></button>
      </div>`;
    }).join('');
  }
  const has = connected.size > 0;
  $('group-row').style.display = connected.size > 1 ? 'flex' : 'none';
  $('btn-apply-all').style.display = connected.size > 1 ? 'block' : 'none';
  $('ctl-head').style.display = has ? 'block' : 'none';
  $('control-section').classList.toggle('disabled', !has);
  const anyIos = [...connected.values()].some((d) => d.platform === 'ios');
  const showTunnel = anyIos || settings.autoTunnel;
  $('tunnel-row').style.display = showTunnel ? 'flex' : 'none';
  if (showTunnel) refreshTunnel();
}

async function connectDevice(platform: 'ios' | 'android', opts: { udid?: string; name?: string; connection?: string }): Promise<void> {
  const id = opts.udid ?? (platform === 'android' ? 'android' : 'ios-default');
  if (connected.has(id)) { applyActive(id); closeAddDevice(); return; }
  if (connectingId) return;                       // 已有裝置在連線中，忽略

  connectingId = id;
  const androidBtn = $('btn-connect-android') as HTMLButtonElement;
  if (platform === 'ios') renderDevices();        // 在該列顯示 spinner、其餘暫時不可點
  else { androidBtn.disabled = true; androidBtn.textContent = '連線中…'; }

  try {
    await sim.connect(platform, opts);
  } catch (err) {
    connectingId = null;
    if (platform === 'ios') renderDevices();
    else { androidBtn.disabled = false; androidBtn.textContent = '連接 Android（adb）'; }
    flash(`連線失敗：${(err as Error).message}`);
    return;
  }

  connectingId = null;
  if (platform === 'android') { androidBtn.disabled = false; androidBtn.textContent = '連接 Android（adb）'; }
  const color = DEVICE_COLORS[connected.size % DEVICE_COLORS.length];
  const d: DeviceState = {
    id, platform, name: opts.name ?? id,
    connection: (opts.connection as DeviceState['connection']) ?? '', color,
    ...defaultConfig(),
    state: 'idle', coveredM: 0, totalM: 0, progress: 0, posMarker: null, trailLine: null,
  };
  connected.set(id, d);
  applyActive(id);
  closeAddDevice();
  flash(`已連接「${d.name}」`);
}

async function disconnectDevice(id: string): Promise<void> {
  const d = connected.get(id);
  if (!d) return;
  if (!confirm(`中斷「${d.name}」？`)) return;
  await sim.disconnect(id).catch(() => undefined);
  if (d.posMarker) map.removeLayer(d.posMarker);
  if (d.trailLine) map.removeLayer(d.trailLine);
  connected.delete(id);
  if (activeId === id) {
    activeId = null;
    const next = [...connected.keys()][0];
    if (next) applyActive(next);
    else clearActive();
  }
  renderSessions();
}

$('session-list').addEventListener('click', (e) => {
  const x = (e.target as HTMLElement).closest('[data-act="disc"]') as HTMLElement | null;
  if (x) { disconnectDevice(x.dataset.id!); return; }
  const row = (e.target as HTMLElement).closest('.sess') as HTMLElement | null;
  if (row?.dataset.id) applyActive(row.dataset.id);
});

// 群組操作
$('btn-all-start').addEventListener('click', async () => {
  captureActive();
  for (const d of connected.values()) {
    if (!d.waypoints.length) continue;
    if ((d.mode === 'two-point' || d.mode === 'multi-point') && d.waypoints.length < 2) continue;
    if (d.trailLine) { map.removeLayer(d.trailLine); d.trailLine = null; }
    await sim.start(d.id, buildRouteFrom(d));
  }
});
$('btn-all-stop').addEventListener('click', async () => {
  for (const d of connected.values()) await sim.stop(d.id);
});
$('btn-apply-all').addEventListener('click', () => {
  captureActive();
  const a = activeId ? connected.get(activeId) : null;
  if (!a) return;
  if (!confirm('把目前裝置的路線與參數套用到其他所有裝置？')) return;
  for (const d of connected.values()) {
    if (d.id === a.id) continue;
    d.mode = a.mode; d.waypoints = a.waypoints.map((p) => ({ ...p }));
    d.speedKmh = a.speedKmh; d.loop = a.loop; d.jitter = a.jitter; d.reverse = a.reverse;
    d.repeat = a.repeat; d.dwellSec = a.dwellSec; d.varyPct = a.varyPct;
  }
  flash('已套用到全部');
});

// 新增裝置彈窗
function closeAddDevice(): void { $('add-device-overlay').style.display = 'none'; }
function syncAddDeviceUI(): void {
  const ios = ($('platform') as HTMLSelectElement).value === 'ios';
  $('ios-devices').style.display = ios ? 'block' : 'none';
  $('android-connect').style.display = ios ? 'none' : 'block';
  if (ios) refreshDevices();
}
$('btn-add-device').addEventListener('click', () => { $('add-device-overlay').style.display = 'flex'; syncAddDeviceUI(); });
$('btn-add-close').addEventListener('click', closeAddDevice);
$('add-device-overlay').addEventListener('click', (e) => { if (e.target === $('add-device-overlay')) closeAddDevice(); });
$('platform').addEventListener('change', syncAddDeviceUI);
$('btn-connect-android').addEventListener('click', () => connectDevice('android', { name: 'Android' }));

// ── 移動控制（作用於目前選取的裝置）──
$('btn-start').addEventListener('click', async () => {
  if (!activeId) return flash('請先連接並選取裝置');
  const d = connected.get(activeId);
  if (!d) return;
  if (currentState === 'paused') { await sim.resume(activeId); return; }
  if (!waypoints.length) return flash('請先在地圖新增航點');
  if ((mode === 'two-point' || mode === 'multi-point') && waypoints.length < 2)
    return flash('此模式至少需要兩個航點');
  captureActive();
  if (d.trailLine) { map.removeLayer(d.trailLine); d.trailLine = null; }
  await sim.start(activeId, buildRouteFrom(d));
});
$('btn-pause').addEventListener('click', () => { if (activeId) sim.pause(activeId); });
$('btn-clear').addEventListener('click', async () => {
  if (activeId) {
    const d = connected.get(activeId);
    await sim.stop(activeId);
    if (d?.trailLine) { map.removeLayer(d.trailLine); d.trailLine = null; }
    if (d?.posMarker) { map.removeLayer(d.posMarker); d.posMarker = null; }
  }
  waypoints = [];
  redrawWaypoints();
  resetTelemetry();
});

// ── 搖桿 ──
const keyMap: Record<string, number> = { ArrowUp: 0, ArrowRight: 90, ArrowDown: 180, ArrowLeft: 270 };
document.querySelectorAll('.dbtn[data-dir]').forEach((b) => {
  const dir = +(b as HTMLElement).dataset.dir!;
  const down = () => { if (!activeId) return; b.classList.add('held'); sim.setHeading(activeId, dir, true); };
  const up = () => { b.classList.remove('held'); if (activeId) sim.setHeading(activeId, dir, false); };
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
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    if (currentState === 'running' && activeId) sim.pause(activeId);
    else (($('btn-start') as HTMLButtonElement)).click();
    return;
  }
  if (!(e.key in keyMap) || currentState !== 'running' || !activeId) return;
  e.preventDefault(); sim.setHeading(activeId, keyMap[e.key], true);
});
document.addEventListener('keyup', (e) => {
  if (isTyping() || !(e.key in keyMap) || !activeId) return;
  sim.setHeading(activeId, keyMap[e.key], false);
});

// ── 來自 main 的事件（每筆都帶 udid）──
let currentState = 'idle';

sim.onPosition(({ udid, pos, session }) => {
  const d = connected.get(udid);
  if (!d) return;
  const ll: [number, number] = [pos.lat, pos.lng];
  if (!d.posMarker) d.posMarker = L.marker(ll, { icon: posIconColored(d.color), zIndexOffset: 1000 }).addTo(map);
  else d.posMarker.setLatLng(ll);
  if (!d.trailLine) d.trailLine = L.polyline([ll], { color: d.color, weight: 3, opacity: .9 }).addTo(map);
  else d.trailLine.addLatLng(ll);

  d.coveredM = session.coveredM ?? 0;
  d.totalM = session.totalM ?? 0;
  d.progress = session.progress ?? 0;
  updateSessionRow(d);

  if (udid === activeId) {
    if (settings.follow) map.panTo(ll, { animate: true, duration: 0.2 });
    $('t-pos').textContent = `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
    $('t-dist').textContent = fmtDist(d.coveredM);
    const pct = Math.round(d.progress * 100);
    $('t-prog').textContent = `${pct}%`;
    ($('t-bar') as HTMLElement).style.width = `${pct}%`;
    const speedMs = (+($('speed') as HTMLInputElement).value) * MS_PER_KMH;
    const remainM = Math.max(0, d.totalM - d.coveredM);
    $('t-eta').textContent = d.totalM > 0 && speedMs > 0 ? fmtDuration(remainM / speedMs) : '—';
  }
});

function setParamLock(locked: boolean): void {
  // 移動中/暫停中鎖住結構性參數；速度（即時調整）與跟隨（顯示偏好）不鎖
  ['loop', 'jitter', 'reverse', 'repeat', 'dwell', 'vary'].forEach((id) => {
    const el = $(id) as HTMLInputElement;
    if (el) el.disabled = locked;
  });
}

sim.onState(({ udid, state }) => {
  const d = connected.get(udid);
  if (!d) return;
  d.state = state as DeviceState['state'];
  updateSessionRow(d);
  if (udid === activeId) { currentState = state; reflectActiveState(); }
});

sim.onDeviceStatus((s) => {
  if (s && s.error) { flash(`裝置錯誤：${s.error}`); appendLog(`裝置錯誤：${s.error}`); }
});
sim.onDeviceLog((m) => { console.log('[device]', m); appendLog(m); });

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
const filterTypes = new Set<SpotType>(settings.spotTypes);
let filterMinScore = settings.spotMinScore;
let sortKey: 'score' | 'lng' | 'tz' = settings.spotSort;
let sortDir: 1 | -1 = settings.spotSortDir;   // -1 = 降序
let editingId: string | null = null; // null = 新增
let spotPickMode = false;
let selectedSpotId: string | null = null;  // 清單中目前選取（高亮）的地點

// 把目前篩選/排序寫回設定（下次開啟還原）
function persistSpotFilters(): void {
  settings.spotTypes = [...filterTypes];
  settings.spotMinScore = filterMinScore;
  settings.spotSort = sortKey;
  settings.spotSortDir = sortDir;
  saveSettings();
}
// 把篩選狀態反映到 UI 控制項（開啟時呼叫）
function applySpotFilterUI(): void {
  document.querySelectorAll('#sf-types .chip').forEach((c) => {
    const t = (c as HTMLElement).dataset.type as SpotType;
    c.classList.toggle('active', filterTypes.has(t));
  });
  ($('sf-score') as HTMLInputElement).value = String(filterMinScore);
  $('sf-score-val').textContent = filterMinScore.toFixed(1);
  ($('sf-sort') as HTMLSelectElement).value = sortKey;
  $('sf-dir').textContent = sortDir === 1 ? '↑' : '↓';
}

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
        return `<div class="spot${s.id === selectedSpotId ? ' active' : ''}" data-id="${s.id}">
          <span class="sicon" style="background:${t.color}22;color:${t.color}">${t.glyph}</span>
          <div class="sbody">
            <div class="sname">${esc(s.name)}</div>
            <div class="smeta">${s.score.toFixed(1)} 分 · ${esc(tz)}</div>
            <div class="scoord">${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</div>
          </div>
          <div class="sact">
            <button data-act="load" data-id="${s.id}" aria-label="載入到地圖" title="載入到地圖"><svg class="ic"><use href="#i-target"/></svg></button>
            <button data-act="copy" data-id="${s.id}" aria-label="複製座標" title="複製座標"><svg class="ic"><use href="#i-copy"/></svg></button>
            <button data-act="edit" data-id="${s.id}" aria-label="編輯" title="編輯"><svg class="ic"><use href="#i-edit"/></svg></button>
            <button data-act="del" data-id="${s.id}" aria-label="刪除" title="刪除"><svg class="ic"><use href="#i-trash"/></svg></button>
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

// 複製文字到剪貼簿（座標等）
async function copyText(text: string, okMsg = '已複製座標'): Promise<void> {
  try { await navigator.clipboard.writeText(text); flash(okMsg); }
  catch { flash('複製失敗'); }
}
function coordStr(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
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
  if (btn) {
    const spot = allSpots.find((s) => s.id === btn.dataset.id);
    if (!spot) return;
    const act = btn.dataset.act;
    if (act === 'load') loadSpotToMap(spot);
    else if (act === 'copy') copyText(coordStr(spot.lat, spot.lng));
    else if (act === 'edit') openForm(spot);
    else if (act === 'del') deleteSpot(spot);
    return;
  }
  // 點列上的其他區域 → 選取並載入該地點
  const row = (e.target as HTMLElement).closest('.spot[data-id]') as HTMLElement | null;
  if (row?.dataset.id) {
    const spot = allSpots.find((s) => s.id === row.dataset.id);
    if (spot) loadSpotToMap(spot);
  }
});

// 高亮目前選取的地點列（不重繪整個清單）
function highlightSelectedSpot(): void {
  document.querySelectorAll('#spot-list .spot').forEach((el) =>
    el.classList.toggle('active', (el as HTMLElement).dataset.id === selectedSpotId));
}

function loadSpotToMap(s: Spot): void {
  selectedSpotId = s.id;
  highlightSelectedSpot();
  if (currentState === 'running' || currentState === 'paused') { flash('移動中無法套用座標，請先停止'); return; }
  addWaypoint({ lat: s.lat, lng: s.lng });   // 依目前模式放上地圖
  map.panTo([s.lat, s.lng], { animate: true });
  flash(`已載入「${s.name}」到地圖`);
}

async function deleteSpot(s: Spot): Promise<void> {
  if (!confirm(`確定刪除地點「${s.name}」？此動作無法復原。`)) return;
  if (selectedSpotId === s.id) selectedSpotId = null;
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
  persistSpotFilters();
  renderSpots();
});
$('sf-score').addEventListener('input', (e) => {
  filterMinScore = +(e.target as HTMLInputElement).value;
  $('sf-score-val').textContent = filterMinScore.toFixed(1);
  persistSpotFilters();
  renderSpots();
});
$('sf-sort').addEventListener('change', (e) => {
  sortKey = (e.target as HTMLSelectElement).value as typeof sortKey;
  persistSpotFilters();
  renderSpots();
});
$('sf-dir').addEventListener('click', () => {
  sortDir = sortDir === 1 ? -1 : 1;
  $('sf-dir').textContent = sortDir === 1 ? '↑' : '↓';
  persistSpotFilters();
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

applySpotFilterUI();
loadSpots();

/* ════════════════════════════════════════════════════════
   地圖搜尋（地點名稱或座標）＋ 複製座標
   ════════════════════════════════════════════════════════ */
let searchMarker: any = null;
let searchResults: Array<{ kind: 'coord' | 'spot'; lat: number; lng: number; name: string; id?: string }> = [];
let searchSel = -1;

// 解析座標字串："25.03, 121.56" / "25.03 121.56" / "25.03,121.56"
function parseCoords(q: string): { lat: number; lng: number } | null {
  const m = q.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90) return null;
  return normPt({ lat, lng });
}

function runSearch(q: string): void {
  const box = $('map-search-results');
  const query = q.trim();
  if (!query) { box.style.display = 'none'; searchResults = []; searchSel = -1; return; }

  const coord = parseCoords(query);
  if (coord) {
    searchResults = [{ kind: 'coord', lat: coord.lat, lng: coord.lng, name: '前往座標' }];
  } else {
    const low = query.toLowerCase();
    searchResults = allSpots
      .filter((s) => s.name.toLowerCase().includes(low))
      .slice(0, 8)
      .map((s) => ({ kind: 'spot' as const, lat: s.lat, lng: s.lng, name: s.name, id: s.id }));
  }
  searchSel = searchResults.length ? 0 : -1;
  renderSearchResults();
}

function renderSearchResults(): void {
  const box = $('map-search-results');
  if (!searchResults.length) {
    box.innerHTML = '<div class="msr" style="cursor:default;color:var(--faint)">查無結果</div>';
    box.style.display = 'block';
    return;
  }
  box.innerHTML = searchResults
    .map((r, i) => {
      const label = r.kind === 'coord' ? '前往座標' : esc(r.name);
      return `<div class="msr${i === searchSel ? ' sel' : ''}" data-i="${i}">
        <div class="mi">
          <div class="mn">${label}</div>
          <div class="mc">${coordStr(r.lat, r.lng)}</div>
        </div>
        <button class="mcopy" data-copy="${i}" title="複製座標"><svg class="ic" style="width:14px;height:14px"><use href="#i-copy"/></svg></button>
      </div>`;
    })
    .join('');
  box.style.display = 'block';
}

function gotoSearch(i: number): void {
  const r = searchResults[i];
  if (!r) return;
  if (r.kind === 'spot' && r.id) { selectedSpotId = r.id; highlightSelectedSpot(); }
  map.setView([r.lat, r.lng], Math.max(map.getZoom(), 15), { animate: true });
  if (searchMarker) map.removeLayer(searchMarker);
  searchMarker = L.marker([r.lat, r.lng], {
    icon: L.divIcon({
      className: '',
      html: '<div style="width:16px;height:16px;border-radius:50%;background:#f472b6;border:2px solid #0c0f14;box-shadow:0 0 0 4px #f472b644"></div>',
      iconSize: [16, 16], iconAnchor: [8, 8],
    }),
  }).addTo(map).bindPopup(`${esc(r.name)}<br>${coordStr(r.lat, r.lng)}`).openPopup();
  $('map-search-results').style.display = 'none';
  flash(r.kind === 'coord' ? `已前往 ${coordStr(r.lat, r.lng)}` : `已定位「${r.name}」`);
}

$('map-search-input').addEventListener('input', (e) => runSearch((e.target as HTMLInputElement).value));
$('map-search-input').addEventListener('keydown', (e) => {
  const ke = e as KeyboardEvent;
  if (!searchResults.length && ke.key !== 'Escape') return;
  if (ke.key === 'ArrowDown') { ke.preventDefault(); searchSel = Math.min(searchSel + 1, searchResults.length - 1); renderSearchResults(); }
  else if (ke.key === 'ArrowUp') { ke.preventDefault(); searchSel = Math.max(searchSel - 1, 0); renderSearchResults(); }
  else if (ke.key === 'Enter') { ke.preventDefault(); if (searchSel >= 0) gotoSearch(searchSel); }
  else if (ke.key === 'Escape') { $('map-search-results').style.display = 'none'; ($('map-search-input') as HTMLInputElement).blur(); }
});
$('map-search-results').addEventListener('click', (e) => {
  const cp = (e.target as HTMLElement).closest('[data-copy]') as HTMLElement | null;
  if (cp) { const r = searchResults[+cp.dataset.copy!]; if (r) copyText(coordStr(r.lat, r.lng)); return; }
  const row = (e.target as HTMLElement).closest('.msr[data-i]') as HTMLElement | null;
  if (row) gotoSearch(+row.dataset.i!);
});
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#map-search')) $('map-search-results').style.display = 'none';
});

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
      if (idx >= 0) { routePts[idx] = normPt({ lat: ll.lat, lng: ll.lng }); }
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
          <button data-act="load" data-id="${r.id}" aria-label="載入到地圖" title="載入到地圖"><svg class="ic"><use href="#i-target"/></svg></button>
          <button data-act="edit" data-id="${r.id}" aria-label="編輯" title="編輯"><svg class="ic"><use href="#i-edit"/></svg></button>
          <button data-act="del" data-id="${r.id}" aria-label="刪除" title="刪除"><svg class="ic"><use href="#i-trash"/></svg></button>
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
  if (currentState === 'running' || currentState === 'paused') { flash('移動中無法套用路徑，請先停止'); return; }
  mode = 'multi-point';
  document.querySelectorAll('.mode-btn').forEach((x) =>
    x.classList.toggle('active', (x as HTMLElement).dataset.mode === 'multi-point'),
  );
  $('dpad-section').style.display = 'none';

  waypoints = r.points.map((p) => normPt(p));
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
          <button data-act="del" title="刪除"><svg class="ic" style="width:13px;height:13px"><use href="#i-x"/></svg></button>
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
  routePts.push(normPt(pt));
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
  routePts = (route?.points ?? []).map((p) => normPt(p));
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
  routePts = waypoints.map((p) => normPt(p));
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
  routePts = waypoints.map((p) => normPt(p));
  renderRoutePoints();
  flash(`已用目前 ${routePts.length} 個航點覆蓋`);
});
$('route-speed').addEventListener('input', (e) =>
  ($('route-speed-val').textContent = (e.target as HTMLInputElement).value));

$('btn-route-save').addEventListener('click', async () => {
  const name = ($('route-name') as HTMLInputElement).value.trim();
  const pts = routePts
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => normPt(p));
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
  setTunnelPill('checking');
  try { setTunnelPill((await sim.tunnelStatus()) ? 'up' : 'down'); }
  catch { setTunnelPill('down'); }
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
setInterval(() => { if ($('tunnel-row').style.display !== 'none') refreshTunnel(); }, 8000);

/* ════════════════════════════════════════════════════════
   可用裝置清單（新增裝置彈窗內）— 點擊即連線
   ════════════════════════════════════════════════════════ */
let iosDevices: IosDevice[] = [];
let connectingId: string | null = null;   // 正在連線中的裝置（顯示 spinner）

let scanning = false;
async function refreshDevices(): Promise<void> {
  if (connectingId || scanning) return;            // 連線中 / 掃描中皆不重複觸發
  scanning = true;
  const btn = $('btn-dev-refresh') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = '掃描中…';
  $('dev-list').innerHTML = '<div class="dev-empty">掃描中…</div>';
  let list: IosDevice[] = [];
  try { list = await sim.listDevices(); } catch { list = []; }
  iosDevices = list;
  renderDevices();
  scanning = false;
  btn.disabled = false;
  btn.textContent = '↻ 重新整理';
}

function renderDevices(): void {
  const el = $('dev-list');
  $('dev-count').textContent = iosDevices.length ? `(${iosDevices.length})` : '';
  if (iosDevices.length === 0) {
    el.innerHTML = '<div class="dev-empty">未偵測到裝置。請以 USB 連接並在 iPhone 上點「信任」，或確認 WiFi 連線已啟用且同一網段。</div>';
    return;
  }
  el.innerHTML = iosDevices
    .map((d) => {
      const isOn = connected.has(d.udid);
      const connecting = d.udid === connectingId;
      const name = d.name ? esc(d.name) : esc(d.udid.slice(0, 12) + '…');
      const badge = d.connection === 'wifi' ? '<span class="dev-badge wifi">WiFi</span>' : '<span class="dev-badge usb">USB</span>';
      const sub = connecting
        ? '連線中…'
        : isOn
          ? '已連接'
          : [d.iosVersion ? `iOS ${esc(d.iosVersion)}` : null, d.tunnelReady ? '通道就緒' : '尚無通道'].filter(Boolean).join(' · ');
      const right = connecting ? '<span class="spinner"></span>' : '<span class="dev-sel"></span>';
      const cls = `dev${isOn ? ' active' : ''}${connecting ? ' connecting' : ''}`;
      return `<div class="${cls}" data-udid="${esc(d.udid)}" data-on="${isOn ? '1' : ''}">
        <div class="dev-info">
          <div class="dev-name">${name} ${badge}</div>
          <div class="dev-sub">${sub}</div>
        </div>
        ${right}
      </div>`;
    })
    .join('');
  // 連線進行中時，整個清單暫時不可再點
  el.classList.toggle('busy', !!connectingId);
}

$('dev-list').addEventListener('click', (e) => {
  if (connectingId) return;                       // 連線中忽略點擊
  const row = (e.target as HTMLElement).closest('.dev') as HTMLElement | null;
  if (!row || !row.dataset.udid) return;
  if (row.dataset.on === '1') { applyActive(row.dataset.udid); closeAddDevice(); return; }
  const dev = iosDevices.find((x) => x.udid === row.dataset.udid);
  connectDevice('ios', { udid: row.dataset.udid, name: dev?.name ?? row.dataset.udid, connection: dev?.connection });
});
$('btn-dev-refresh').addEventListener('click', () => { if (!connectingId) refreshDevices(); });

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
  ($('set-autotunnel') as HTMLInputElement).checked = settings.autoTunnel;
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
$('set-autotunnel').addEventListener('change', () => {
  settings.autoTunnel = ($('set-autotunnel') as HTMLInputElement).checked;
  saveSettings();
  renderSessions();                               // 重算通道列顯示
  if (settings.autoTunnel) {                      // 立即暖機一次
    $('tunnel-row').style.display = 'flex';
    setTunnelPill('checking');
    sim.tunnelPrewarm().then(() => refreshTunnel()).catch(() => setTunnelPill('down'));
  }
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
   記住上次的地圖視角
   ════════════════════════════════════════════════════════ */
map.on('moveend', () => {
  if (!settings.rememberLast) return;
  const c = map.getCenter();
  try { localStorage.setItem('lastView', JSON.stringify({ lat: c.lat, lng: c.lng, z: map.getZoom() })); } catch { /* ignore */ }
});
function restoreLast(): void {
  if (!settings.rememberLast) return;
  try {
    const v = JSON.parse(localStorage.getItem('lastView') || 'null');
    if (v && isFinite(v.lat) && isFinite(v.lng)) map.setView([v.lat, v.lng], v.z || map.getZoom());
  } catch { /* ignore */ }
}

// 複製目前座標（遙測）
$('btn-copy-pos').addEventListener('click', () => {
  const v = $('t-pos').textContent ?? '';
  if (v && v !== '—') copyText(v);
});

// ── 初始化 ──
applySettings();
restoreLast();
renderSessions();
clearActive();

// 啟動時預先把 iOS 通道拉起來（設定可關）。先連裝置時就不會卡在建立通道。
if (settings.autoTunnel) {
  $('tunnel-row').style.display = 'flex';
  setTunnelPill('checking');
  sim.tunnelPrewarm()
    .then(() => refreshTunnel())
    .catch(() => setTunnelPill('down'));
}
