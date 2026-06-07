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

  interface Window {
    simulator: SimulatorBridge;
    spots: SpotsBridge;
  }

  // Leaflet 由 CDN 以全域 L 載入
  const L: any;
}
