/**
 * geo-info.ts — 由經緯度離線推算「時區 + 國家 + UTC 偏移」
 *
 *   tz-lookup：經緯度 → IANA 時區（例如 Asia/Taipei）
 *   countries-and-timezones：時區 → 國家 + UTC 偏移
 *
 * 國家是由時區反推的近似值，在國界/跨時區邊緣可能不夠精準，
 * 但對地點分類與排序足夠。皆為離線資料，會隨 app 一起打包。
 */
import tzlookup from 'tz-lookup';
import * as ct from 'countries-and-timezones';

export interface GeoInfo {
  country?: string;
  timezone?: string;
  utcOffsetMinutes?: number;
}

export function geoInfoFor(lat: number, lng: number): GeoInfo {
  try {
    const timezone = tzlookup(lat, lng);
    const tz = ct.getTimezone(timezone);
    const countryCode = tz?.countries?.[0];
    const country = countryCode ? ct.getCountry(countryCode)?.name : undefined;
    return { timezone, country, utcOffsetMinutes: tz?.utcOffset };
  } catch {
    return {};
  }
}
