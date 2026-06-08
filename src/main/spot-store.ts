/**
 * spot-store.ts — 地點庫的持久化與 CRUD（住在 main 程序）
 *
 * 資料存成 JSON 於 app.getPath('userData')/spots.json，
 * 啟動時讀進記憶體，每次變更寫回（先寫暫存再改名，避免寫壞）。
 * 新增/編輯時自動依經緯度算好國家與時區並快取。
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { geoInfoFor } from './geo-info';

export type SpotType = 'flower' | 'mushroom' | 'hidden';

export interface Spot {
  id: string;
  name: string;
  lat: number;
  lng: number;
  score: number;             // 0~10
  type: SpotType;
  country?: string;
  timezone?: string;
  utcOffsetMinutes?: number;
  createdAt: number;
  updatedAt: number;
}

export type SpotInput = Pick<Spot, 'name' | 'lat' | 'lng' | 'score' | 'type'>;

const clampScore = (v: number): number => Math.max(0, Math.min(10, Number(v)));

/** 把各種寫法的類型字串正規化；未知或空值預設為菇。 */
function normalizeType(v: string | undefined): SpotType {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'flower' || s === '花') return 'flower';
  if (s === 'hidden' || s === '隱藏' || s === '隐藏') return 'hidden';
  return 'mushroom'; // mushroom / 菇 / 空值 / 未知
}

/** 極簡 RFC4180 CSV 解析：支援雙引號欄位、欄內逗號與換行、跳脫的 ""。 */
function parseCsv(input: string): string[][] {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export interface ImportResult {
  added: number;
  skipped: number;
  errors: string[];
}

export class SpotStore {
  private readonly file: string;
  private spots: Spot[] = [];

  constructor(file?: string) {
    this.file = file ?? path.join(app.getPath('userData'), 'spots.json');
    this.load();
  }

  list(): Spot[] {
    return this.spots.slice();
  }

  /** 以匯入的清單整批取代（備份還原用），做基本欄位清洗。 */
  replaceAll(items: unknown): number {
    const arr = Array.isArray(items) ? items : [];
    const now = Date.now();
    this.spots = arr
      .map((raw) => {
        const s = raw as Partial<Spot>;
        const lat = Number(s.lat);
        const lng = Number(s.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return {
          id: typeof s.id === 'string' && s.id ? s.id : randomUUID(),
          name: String(s.name ?? '未命名'),
          lat,
          lng,
          score: clampScore(Number(s.score ?? 0)),
          type: normalizeType(String(s.type ?? 'mushroom')),
          country: s.country,
          timezone: s.timezone,
          utcOffsetMinutes: s.utcOffsetMinutes,
          createdAt: Number(s.createdAt) || now,
          updatedAt: Number(s.updatedAt) || now,
        } as Spot;
      })
      .filter((s): s is Spot => s !== null);
    this.persist();
    return this.spots.length;
  }

  create(input: SpotInput): Spot {
    const now = Date.now();
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    const spot: Spot = {
      id: randomUUID(),
      name: String(input.name),
      lat,
      lng,
      score: clampScore(input.score),
      type: input.type,
      ...geoInfoFor(lat, lng),
      createdAt: now,
      updatedAt: now,
    };
    this.spots.push(spot);
    this.persist();
    return spot;
  }

  update(id: string, changes: Partial<SpotInput>): Spot {
    const i = this.spots.findIndex((s) => s.id === id);
    if (i < 0) throw new Error('找不到該地點');

    const next: Spot = { ...this.spots[i] };
    if (changes.name !== undefined) next.name = String(changes.name);
    if (changes.type !== undefined) next.type = changes.type;
    if (changes.score !== undefined) next.score = clampScore(changes.score);

    let geoDirty = false;
    if (changes.lat !== undefined) { next.lat = Number(changes.lat); geoDirty = true; }
    if (changes.lng !== undefined) { next.lng = Number(changes.lng); geoDirty = true; }
    if (geoDirty) Object.assign(next, geoInfoFor(next.lat, next.lng));

    next.updatedAt = Date.now();
    this.spots[i] = next;
    this.persist();
    return next;
  }

  remove(id: string): void {
    this.spots = this.spots.filter((s) => s.id !== id);
    this.persist();
  }

  /**
   * 從 CSV 文字匯入多筆地點。需含標題列，可辨識的欄名（不分大小寫）：
   *   name/名稱、lat/緯度、lng/經度、score/分數、type/類型（缺 type 預設菇）。
   * lat、lng 為必要欄位；其餘可缺。回傳新增/略過筆數與錯誤摘要。
   */
  importCsv(text: string): ImportResult {
    const rows = parseCsv(text);
    if (rows.length < 2) {
      return { added: 0, skipped: 0, errors: ['檔案沒有資料列（需含標題列 + 至少一筆）'] };
    }

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (names: string[]) => header.findIndex((h) => names.includes(h));
    const ci = {
      name: col(['name', '名稱']),
      lat: col(['lat', 'latitude', '緯度']),
      lng: col(['lng', 'lon', 'long', 'longitude', '經度']),
      score: col(['score', '分數']),
      type: col(['type', '類型', '類別']),
    };
    if (ci.lat < 0 || ci.lng < 0) {
      return { added: 0, skipped: 0, errors: ['找不到 lat / lng 欄位（標題列需含經緯度欄）'] };
    }

    const errors: string[] = [];
    const now = Date.now();
    let added = 0;
    let skipped = 0;

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (row.length === 1 && row[0].trim() === '') continue; // 空行

      const lat = Number(row[ci.lat]);
      const lng = Number(row[ci.lng]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        skipped++;
        if (errors.length < 10) errors.push(`第 ${r + 1} 行：經緯度無效`);
        continue;
      }

      const name = (ci.name >= 0 ? row[ci.name] ?? '' : '').trim();
      const scoreNum = ci.score >= 0 ? Number(row[ci.score]) : 0;

      this.spots.push({
        id: randomUUID(),
        name: name || `匯入地點 ${r}`,
        lat,
        lng,
        score: clampScore(Number.isFinite(scoreNum) ? scoreNum : 0),
        type: normalizeType(ci.type >= 0 ? row[ci.type] : undefined),
        ...geoInfoFor(lat, lng),
        createdAt: now,
        updatedAt: now,
      });
      added++;
    }

    if (added > 0) this.persist();
    return { added, skipped, errors };
  }

  // ── 內部 ──

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (Array.isArray(data)) this.spots = data;
    } catch {
      this.spots = []; // 檔案不存在或損毀 → 視為空庫
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.spots, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }
}
