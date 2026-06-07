/**
 * movement-engine.ts
 *
 * 定位模擬工具的核心移動引擎 —— 完全平台無關的純邏輯。
 * 不依賴任何 UI 框架或裝置 API，方便單元測試，也能在 Node 與瀏覽器執行。
 *
 * 內容：
 *   1. 球面幾何工具：haversine（距離）、bearing（方位角）、destination（推進）
 *   2. generator 路徑產生器：walkSegment / walkRoute（含多點分段）
 *   3. MovementEngine：用定時器驅動 generator，逐 tick 回報座標
 *
 * 用途僅供定位功能測試。
 */

// ────────────────────────────────────────────────────────────
// 型別定義
// ────────────────────────────────────────────────────────────

export interface Coordinate {
  lat: number;        // 緯度
  lng: number;        // 經度
  altitude?: number;  // 海拔（可選）
}

export type MoveMode = 'teleport' | 'two-point' | 'multi-point' | 'joystick';

export interface Route {
  mode: MoveMode;
  points: Coordinate[];   // 單點=1, 兩點=2, 多點=N
  speedKmh: number;       // 移動速度（公里/小時）
  loop?: boolean;         // 是否循環（多點時會繞回起點）
  jitterM?: number;       // 座標隨機抖動半徑（公尺），模擬真實 GPS 訊號
}

export type SessionState = 'idle' | 'running' | 'paused' | 'finished';

export interface Session {
  state: SessionState;
  currentPos: Coordinate | null;
  coveredM: number;       // 已移動距離（公尺）
  totalM: number;         // 路徑總長（公尺，loop 模式為單圈長度）
  progress: number;       // 0~1（loop 模式為當圈進度）
}

// ────────────────────────────────────────────────────────────
// 球面幾何工具
// ────────────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** 兩座標間的大圓距離（公尺）。 */
export function haversine(a: Coordinate, b: Coordinate): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** 從 a 指向 b 的初始方位角（度，0=正北，順時針）。 */
export function bearing(a: Coordinate, b: Coordinate): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** 從 origin 沿 bearingDeg 方向推進 distanceM 公尺後的座標。 */
export function destination(
  origin: Coordinate,
  distanceM: number,
  bearingDeg: number,
): Coordinate {
  const delta = distanceM / EARTH_RADIUS_M; // 角距離
  const theta = toRad(bearingDeg);
  const lat1 = toRad(origin.lat);
  const lng1 = toRad(origin.lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(delta) +
      Math.cos(lat1) * Math.sin(delta) * Math.cos(theta),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(lat1),
      Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2),
    );

  return {
    lat: toDeg(lat2),
    lng: ((toDeg(lng2) + 540) % 360) - 180, // 正規化到 -180~180
    altitude: origin.altitude,
  };
}

/** 對座標套用隨機抖動，讓軌跡不要是完美直線。 */
function withJitter(coord: Coordinate, jitterM: number): Coordinate {
  if (jitterM <= 0) return coord;
  return destination(coord, Math.random() * jitterM, Math.random() * 360);
}

// ────────────────────────────────────────────────────────────
// Generator 路徑產生器
// ────────────────────────────────────────────────────────────

/**
 * 走完單一段（from → to），每 tick 推進一步。
 * 不產生起點，最後一定剛好落在 to。
 */
export function* walkSegment(
  from: Coordinate,
  to: Coordinate,
  speedMs: number,
  tickMs: number,
  jitterM = 0,
): Generator<Coordinate, void, void> {
  const stepDist = speedMs * (tickMs / 1000);
  if (stepDist <= 0) throw new Error('speed 必須大於 0');

  let current: Coordinate = { ...from };
  // 距離大於一步時，沿著「當前 → 目標」的方位角持續推進
  while (haversine(current, to) > stepDist) {
    current = destination(current, stepDist, bearing(current, to));
    yield withJitter(current, jitterM);
  }
  yield { ...to }; // 最後一步直接吸附到精確目標
}

/**
 * 依 Route 產生完整座標序列。
 *   - teleport：直接吐出最後一個點
 *   - two-point / multi-point：逐段串接
 *   - loop：跑完最後一段後繞回起點，無限循環
 * joystick 模式為即時控制，不走這裡（見 MovementEngine.setHeading）。
 */
export function* walkRoute(
  route: Route,
  tickMs = 1000,
): Generator<Coordinate, void, void> {
  const pts = route.points;
  if (pts.length === 0) return;

  if (route.mode === 'teleport') {
    yield { ...pts[pts.length - 1] };
    return;
  }

  const speedMs = (route.speedKmh * 1000) / 3600;
  const jitter = route.jitterM ?? 0;

  yield { ...pts[0] }; // 先回報起點

  do {
    for (let i = 0; i < pts.length - 1; i++) {
      yield* walkSegment(pts[i], pts[i + 1], speedMs, tickMs, jitter);
    }
    if (route.loop && pts.length > 1) {
      // 繞回起點，形成封閉路線
      yield* walkSegment(pts[pts.length - 1], pts[0], speedMs, tickMs, jitter);
    }
  } while (route.loop);
}

/** 計算一條路線的總長度（公尺）。loop 會把繞回起點的那段也算進去。 */
export function routeLength(route: Route): number {
  const pts = route.points;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += haversine(pts[i], pts[i + 1]);
  if (route.loop && pts.length > 1) total += haversine(pts[pts.length - 1], pts[0]);
  return total;
}

// ────────────────────────────────────────────────────────────
// MovementEngine：用定時器驅動 generator
// ────────────────────────────────────────────────────────────

export type PositionListener = (pos: Coordinate, session: Readonly<Session>) => void;
export type EndListener = () => void;

export class MovementEngine {
  private readonly tickMs: number;
  private iterator: Generator<Coordinate, void, void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private positionListeners: PositionListener[] = [];
  private endListeners: EndListener[] = [];

  // joystick 模式狀態
  private joystick = { active: false, heading: 0, moving: false, speedMs: 0, jitterM: 0 };

  private session: Session = {
    state: 'idle',
    currentPos: null,
    coveredM: 0,
    totalM: 0,
    progress: 0,
  };

  constructor(tickMs = 1000) {
    this.tickMs = tickMs;
  }

  /** 訂閱每一次座標更新。回傳取消訂閱函式。 */
  onPosition(fn: PositionListener): () => void {
    this.positionListeners.push(fn);
    return () => {
      this.positionListeners = this.positionListeners.filter((f) => f !== fn);
    };
  }

  /** 訂閱路線跑完事件（loop 模式不會觸發）。 */
  onEnd(fn: EndListener): () => void {
    this.endListeners.push(fn);
    return () => {
      this.endListeners = this.endListeners.filter((f) => f !== fn);
    };
  }

  getSession(): Readonly<Session> {
    return this.session;
  }

  /** 開始執行一條路線。 */
  start(route: Route): void {
    this.stop();

    if (route.mode === 'joystick') {
      this.startJoystick(route);
      return;
    }

    this.iterator = walkRoute(route, this.tickMs);
    this.session = {
      state: 'running',
      currentPos: null,
      coveredM: 0,
      totalM: routeLength(route),
      progress: 0,
    };

    this.tick();                                    // 立刻回報第一個座標
    if (this.session.state === 'running') {
      this.timer = setInterval(() => this.tick(), this.tickMs);
    }
  }

  private tick(): void {
    if (!this.iterator) return;

    const next = this.iterator.next();
    if (next.done) {
      this.session.state = 'finished';
      this.session.progress = 1;
      this.clearTimer();
      this.endListeners.forEach((fn) => fn());
      return;
    }

    const prev = this.session.currentPos;
    const pos = next.value;
    if (prev) this.session.coveredM += haversine(prev, pos);
    this.session.currentPos = pos;
    if (this.session.totalM > 0) {
      this.session.progress = Math.min(this.session.coveredM / this.session.totalM, 1);
    }

    this.positionListeners.forEach((fn) => fn(pos, this.session));
  }

  // ── joystick：即時方向控制 ──

  private startJoystick(route: Route): void {
    this.joystick = {
      active: true,
      heading: 0,
      moving: false,
      speedMs: (route.speedKmh * 1000) / 3600,
      jitterM: route.jitterM ?? 0,
    };
    this.session = {
      state: 'running',
      currentPos: route.points[0] ?? { lat: 0, lng: 0 },
      coveredM: 0,
      totalM: 0,
      progress: 0,
    };
    this.positionListeners.forEach((fn) => fn(this.session.currentPos!, this.session));
    this.timer = setInterval(() => this.joystickTick(), this.tickMs);
  }

  private joystickTick(): void {
    if (!this.joystick.active || !this.joystick.moving || !this.session.currentPos) return;
    const stepDist = this.joystick.speedMs * (this.tickMs / 1000);
    let pos = destination(this.session.currentPos, stepDist, this.joystick.heading);
    pos = withJitter(pos, this.joystick.jitterM);
    this.session.coveredM += haversine(this.session.currentPos, pos);
    this.session.currentPos = pos;
    this.positionListeners.forEach((fn) => fn(pos, this.session));
  }

  /** joystick 模式：設定移動方向（度）與是否前進。 */
  setHeading(headingDeg: number, moving = true): void {
    this.joystick.heading = ((headingDeg % 360) + 360) % 360;
    this.joystick.moving = moving;
  }

  // ── 狀態控制 ──

  pause(): void {
    if (this.session.state !== 'running') return;
    this.session.state = 'paused';
    this.joystick.moving = false;
    this.clearTimer();
  }

  resume(): void {
    if (this.session.state !== 'paused') return;
    this.session.state = 'running';
    const tickFn = this.joystick.active
      ? () => this.joystickTick()
      : () => this.tick();
    this.timer = setInterval(tickFn, this.tickMs);
  }

  stop(): void {
    this.clearTimer();
    this.iterator = null;
    this.joystick.active = false;
    this.joystick.moving = false;
    if (this.session.state !== 'idle') this.session.state = 'idle';
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
