declare module 'tz-lookup' {
  /** 由經緯度回傳 IANA 時區字串，例如 'Asia/Taipei'。 */
  export default function tzlookup(lat: number, lon: number): string;
}
