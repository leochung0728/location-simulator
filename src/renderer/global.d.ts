export {};

interface SimulatorBridge {
  connect(platform: 'ios' | 'android', opts?: { udid?: string; name?: string; connection?: string }): Promise<void>;
  disconnect(id: string): Promise<void>;
  listDevices(): Promise<IosDevice[]>;
  start(id: string, route: unknown): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  setHeading(id: string, deg: number, moving: boolean): Promise<void>;
  setSpeed(id: string, speedKmh: number): Promise<void>;
  tunnelStatus(): Promise<boolean>;
  tunnelPrewarm(): Promise<boolean>;
  tunnelRestart(): Promise<boolean>;
  licenseInfo(): Promise<{ machineId: string; valid: boolean; reason?: string; issuedAt?: string; expires?: string | null; note?: string; devBypass: boolean }>;
  licenseReplace(): Promise<{ ok: boolean; reason?: string }>;
  onPosition(cb: (p: { udid: string; pos: { lat: number; lng: number }; session: any }) => void): () => void;
  onState(cb: (s: { udid: string; state: string }) => void): () => void;
  onDeviceStatus(cb: (s: any) => void): () => void;
  onDeviceLog(cb: (m: string) => void): () => void;
}

interface BackupBridge {
  export(): Promise<{ ok: boolean; canceled?: boolean; path?: string; spots?: number; routes?: number; error?: string }>;
  import(): Promise<{ ok: boolean; canceled?: boolean; spots?: number; routes?: number; error?: string }>;
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

  interface IosDevice {
    udid: string;
    name: string | null;
    iosVersion: string | null;
    connection: 'usb' | 'wifi';
    tunnelReady: boolean;
  }

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
    backup: BackupBridge;
  }

  // Leaflet 由 CDN 以全域 L 載入
  const L: any;
}
