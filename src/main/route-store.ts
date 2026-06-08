/**
 * route-store.ts — 路線庫的持久化與 CRUD（住在 main 程序）
 *
 * 與 SpotStore 同一套作法：JSON 存於 app.getPath('userData')/routes.json，
 * 啟動讀進記憶體，每次變更原子寫回。路線是一組有序座標 + 名稱 + 循環 + 速度。
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface RoutePoint {
  lat: number;
  lng: number;
}

export interface SavedRoute {
  id: string;
  name: string;
  points: RoutePoint[];
  loop: boolean;
  speedKmh?: number;
  createdAt: number;
  updatedAt: number;
}

export type RouteInput = Pick<SavedRoute, 'name' | 'points' | 'loop' | 'speedKmh'>;

function cleanPoints(pts: unknown): RoutePoint[] {
  if (!Array.isArray(pts)) return [];
  return pts
    .map((p) => ({ lat: Number((p as RoutePoint)?.lat), lng: Number((p as RoutePoint)?.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

export class RouteStore {
  private readonly file: string;
  private routes: SavedRoute[] = [];

  constructor(file?: string) {
    this.file = file ?? path.join(app.getPath('userData'), 'routes.json');
    this.load();
  }

  list(): SavedRoute[] {
    return this.routes.slice();
  }

  /** 以匯入的清單整批取代（備份還原用），做基本欄位清洗。 */
  replaceAll(items: unknown): number {
    const arr = Array.isArray(items) ? items : [];
    const now = Date.now();
    this.routes = arr
      .map((raw) => {
        const r = raw as Partial<SavedRoute>;
        const points = cleanPoints(r.points);
        if (points.length === 0) return null;
        return {
          id: typeof r.id === 'string' && r.id ? r.id : randomUUID(),
          name: String(r.name ?? '未命名路線'),
          points,
          loop: !!r.loop,
          speedKmh: r.speedKmh !== undefined ? Number(r.speedKmh) : undefined,
          createdAt: Number(r.createdAt) || now,
          updatedAt: Number(r.updatedAt) || now,
        } as SavedRoute;
      })
      .filter((r): r is SavedRoute => r !== null);
    this.persist();
    return this.routes.length;
  }

  create(input: RouteInput): SavedRoute {
    const now = Date.now();
    const route: SavedRoute = {
      id: randomUUID(),
      name: String(input.name || '未命名路線'),
      points: cleanPoints(input.points),
      loop: !!input.loop,
      speedKmh: input.speedKmh !== undefined ? Number(input.speedKmh) : undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.routes.push(route);
    this.persist();
    return route;
  }

  update(id: string, changes: Partial<RouteInput>): SavedRoute {
    const i = this.routes.findIndex((r) => r.id === id);
    if (i < 0) throw new Error('找不到該路線');

    const next: SavedRoute = { ...this.routes[i] };
    if (changes.name !== undefined) next.name = String(changes.name || '未命名路線');
    if (changes.points !== undefined) next.points = cleanPoints(changes.points);
    if (changes.loop !== undefined) next.loop = !!changes.loop;
    if (changes.speedKmh !== undefined) next.speedKmh = Number(changes.speedKmh);
    next.updatedAt = Date.now();

    this.routes[i] = next;
    this.persist();
    return next;
  }

  remove(id: string): void {
    this.routes = this.routes.filter((r) => r.id !== id);
    this.persist();
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (Array.isArray(data)) this.routes = data;
    } catch {
      this.routes = [];
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.routes, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }
}
