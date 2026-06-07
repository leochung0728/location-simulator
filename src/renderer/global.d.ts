export {};

interface SimulatorBridge {
  connect(platform: 'ios' | 'android', opts?: { udid?: string }): Promise<void>;
  disconnect(): Promise<void>;
  start(route: unknown): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  setHeading(deg: number, moving: boolean): Promise<void>;
  onPosition(cb: (p: { pos: { lat: number; lng: number }; session: any }) => void): () => void;
  onState(cb: (s: string) => void): () => void;
  onDeviceStatus(cb: (s: any) => void): () => void;
  onDeviceLog(cb: (m: string) => void): () => void;
}

interface SpotsBridge {
  list(): Promise<Spot[]>;
  create(input: SpotInput): Promise<Spot>;
  update(id: string, changes: Partial<SpotInput>): Promise<Spot>;
  remove(id: string): Promise<{ ok: boolean }>;
  importCsv(): Promise<{ ok: boolean; canceled?: boolean; added: number; skipped: number; errors: string[] }>;
}

interface RoutesBridge {
  list(): Promise<SavedRoute[]>;
  create(input: RouteInput): Promise<SavedRoute>;
  update(id: string, changes: Partial<RouteInput>): Promise<SavedRoute>;
  remove(id: string): Promise<{ ok: boolean }>;
}

declare global {
  type SpotType = 'flower' | 'mushroom' | 'hidden';

  interface Spot {
    id: string;
    name: string;
    lat: number;
    lng: number;
    score: number;
    type: SpotType;
    country?: string;
    timezone?: string;
    utcOffsetMinutes?: number;
    createdAt: number;
    updatedAt: number;
  }

  interface SpotInput {
    name: string;
    lat: number;
    lng: number;
    score: number;
    type: SpotType;
  }

  interface RoutePoint {
    lat: number;
    lng: number;
  }

  interface SavedRoute {
    id: string;
    name: string;
    points: RoutePoint[];
    loop: boolean;
    speedKmh?: number;
    createdAt: number;
    updatedAt: number;
  }

  interface RouteInput {
    name: string;
    points: RoutePoint[];
    loop: boolean;
    speedKmh?: number;
  }

  interface Window {
    simulator: SimulatorBridge;
    spots: SpotsBridge;
    routes: RoutesBridge;
  }

  // Leaflet 由 CDN 以全域 L 載入
  const L: any;
}
