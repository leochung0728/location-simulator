/**
 * test/stress-multidevice.cjs — 多裝置壓測（假 helper，不需真機）
 *
 * 目的：把階段二/三新加的「暖機備援池 + 一裝置一行程 + fallback」並行/生命週期邏輯
 * 操到極限，抓 race、行程洩漏、pending 洩漏、補養失效等問題。測的是 dist 裡編好的
 * 真正 WarmPool / IOSAdapter（非複製品）。
 *
 * 先 build 再跑：  npm run build && node test/stress-multidevice.cjs
 * 或用 npm script： npm run stress
 *
 * 做法：攔截 child_process.spawn 記錄每個被 spawn 的（假）helper 行程，
 * 用以偵測「行程洩漏」與「暖機備援補養」。
 */
'use strict';
const path = require('node:path');
const cp = require('node:child_process');

// ── 1) 攔截 spawn 以追蹤所有被 spawn 的子程序（在 require dist 模組「之前」）──
const realSpawn = cp.spawn;
const live = new Set();            // 仍存活的子程序
let totalSpawns = 0;
let warmSpawns = 0;                // 以 --warm 啟動的次數
cp.spawn = function patchedSpawn(command, args, options) {
  const child = realSpawn.call(this, command, args, options);
  totalSpawns++;
  const a = Array.isArray(args) ? args : [];
  const isWarm = a.includes('--warm');
  if (isWarm) warmSpawns++;
  const rec = { child, isWarm };
  live.add(rec);
  child.once('exit', () => live.delete(rec));
  return child;
};

// ── 2) 載入真正的類別（dist 編譯產物，CommonJS）──
let WarmPool, IOSAdapter;
try {
  ({ WarmPool } = require('../dist/main/warm-pool.js'));
  ({ IOSAdapter } = require('../dist/main/adapters/ios-adapter.js'));
} catch (e) {
  console.error('找不到編譯產物，請先執行  npm run build  再跑壓測。\n', e.message);
  process.exit(1);
}

const NODE = process.execPath;
const FAKE = path.join(__dirname, 'fake-helper.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const liveCount = () => live.size;
const liveWarm = () => [...live].filter((r) => r.isWarm);

// ── 小型測試執行器 ──
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n       ${e && e.message ? e.message : e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function makePool() {
  return new WarmPool({ command: NODE, baseArgs: [FAKE], warmTimeoutMs: 8000, onLog: () => {} });
}
function makeAdapter(udid, warm) {
  return new IOSAdapter({
    pythonPath: NODE,          // fallback 時用 node 跑假 helper
    scriptPath: FAKE,
    waitTunnel: true,
    udid,
    warm,                      // 有就走暖機接管，無則走現場 spawn
    connectTimeoutMs: 8000,
    onLog: () => {},
  });
}

/** 完整一次：取暖機備援 → 連線 → set 數次 → 中斷。 */
async function oneCycle(pool, udid, sets = 3) {
  const warm = (await pool.acquire()) || undefined;
  if (warm) assert(warm.proc.exitCode === null, 'acquire 不應回傳已死的 handle');
  const ad = makeAdapter(udid, warm);
  await ad.connect('usb');
  for (let i = 0; i < sets; i++) await ad.setLocation({ lat: 25 + i * 0.001, lng: 121 + i * 0.001 });
  await ad.disconnect();
}

(async () => {
  console.log('多裝置壓測開始（假 helper）…\n');

  const pool = makePool();
  pool.prewarm();
  await sleep(1500); // 等第一支暖機備援就緒
  await test('啟動後有暖機備援待命', async () => {
    assert(liveWarm().length >= 1, `預期至少 1 支暖機備援，實際 ${liveWarm().length}`);
  });

  await test('A 連續 30 次 連→set→中斷', async () => {
    for (let i = 0; i < 30; i++) await oneCycle(pool, `devA-${i}`);
  });

  await test('B 併發連 5 台、各 set、再全部中斷', async () => {
    const warms = [];
    for (let i = 0; i < 5; i++) warms.push((await pool.acquire()) || undefined);
    const ads = warms.map((w, i) => makeAdapter(`devB-${i}`, w));
    await Promise.all(ads.map((a) => a.connect('usb')));
    await Promise.all(ads.map((a) => a.setLocation({ lat: 25, lng: 121 })));
    await Promise.all(ads.map((a) => a.disconnect()));
  });

  await test('C 同一裝置快速 連→斷→重連 ×20', async () => {
    for (let i = 0; i < 20; i++) await oneCycle(pool, 'devC', 1);
  });

  await test('D 暖機備援閒置中被殺 → 自動補養', async () => {
    await sleep(800);
    const before = warmSpawns;
    const spare = liveWarm()[0];
    assert(spare, '應有一支閒置暖機備援');
    spare.child.kill();                 // 模擬閒置中死亡
    await sleep(1500);
    assert(warmSpawns > before, '備援死亡後應自動再養一支（warmSpawns 未增加）');
    assert(liveWarm().length >= 1, '補養後應再次有暖機備援待命');
  });

  await test('E fallback：無暖機 handle 也能連（現場 spawn）', async () => {
    for (let i = 0; i < 10; i++) {
      const ad = makeAdapter(`devE-${i}`, undefined);
      await ad.connect('usb');
      await ad.setLocation({ lat: 25, lng: 121 });
      await ad.disconnect();
    }
  });

  // 收掉池後再測異常情境（用環境變數注入，避免污染暖機備援）
  pool.dispose();
  await sleep(500);

  await test('F 連線時 fatal → connect 應 reject 且不洩漏行程', async () => {
    process.env.FAKE_FATAL = '1';
    const beforeLive = liveCount();
    const ad = makeAdapter('devF', undefined);
    let threw = false;
    try { await ad.connect('usb'); } catch { threw = true; }
    delete process.env.FAKE_FATAL;
    await sleep(300);
    assert(threw, 'fatal 時 connect 應 reject');
    assert(liveCount() <= beforeLive, 'fatal 後不應留下存活行程');
  });

  await test('G helper 中途崩潰 → 後續 set 以錯誤收場、不卡死', async () => {
    process.env.FAKE_CRASH_AFTER_SET = '2';
    const ad = makeAdapter('devG', undefined);
    await ad.connect('usb');
    let errors = 0;
    for (let i = 0; i < 6; i++) {
      try { await ad.setLocation({ lat: 25, lng: 121 }); } catch { errors++; }
    }
    await ad.disconnect().catch(() => {});
    delete process.env.FAKE_CRASH_AFTER_SET;
    assert(errors > 0, '崩潰後的 set 應以錯誤 reject（不應全部成功或永久卡住）');
  });

  // ── 收尾：等殘留行程退出，檢查洩漏 ──
  await sleep(1500);
  await test('無行程洩漏（全部子程序皆已結束）', async () => {
    assert(liveCount() === 0, `仍有 ${liveCount()} 個子程序存活（疑似洩漏）`);
  });

  console.log(`\n統計：spawn 總數 ${totalSpawns}（其中 --warm ${warmSpawns}）`);
  console.log(`結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('壓測未預期錯誤：', e); process.exit(1); });
