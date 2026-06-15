/**
 * test/fake-helper.cjs — 假 helper（壓測用）
 *
 * 模擬 python/ios-location-helper.py 的 stdin/stdout JSON 行協定，但完全不碰真機：
 *   --warm           → 立刻發 {event:"warm"} 待命；收到 {cmd:"connect",udid,...} 才「連線」
 *   （無 --warm）     → 直接「連線」（對應 fallback 現場 spawn 路徑）
 *   連線 = 發 {event:"ready",transport:"rsd",udid}，之後進 serve 迴圈
 *   serve：{id,cmd:"set"|"clear"|"ping"|"quit"} → {id,ok:true}
 *
 * 可用環境變數注入異常行為（壓測各種邊界）：
 *   FAKE_WARM_DELAY_MS   發 warm 前延遲
 *   FAKE_READY_DELAY_MS  發 ready 前延遲
 *   FAKE_FATAL=1         連線時改發 {event:"fatal"} 並以 code 1 退出
 *   FAKE_CRASH_AFTER_SET 第 N 次 set 後直接異常退出（模擬 helper 中途崩潰）
 */
'use strict';
const readline = require('node:readline');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const WARM = has('--warm');
let udid = valOf('--udid') || null;

const num = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const WARM_DELAY = num('FAKE_WARM_DELAY_MS', 0);
const READY_DELAY = num('FAKE_READY_DELAY_MS', 0);
const FATAL = process.env.FAKE_FATAL === '1';
const CRASH_AFTER_SET = num('FAKE_CRASH_AFTER_SET', 0);

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 簡單的 async 逐行讀取
const queue = [];
let waiter = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { if (waiter) { const w = waiter; waiter = null; w(line); } else queue.push(line); });
rl.on('close', () => { if (waiter) { const w = waiter; waiter = null; w(null); } });
const readLine = () =>
  queue.length ? Promise.resolve(queue.shift()) : new Promise((res) => { waiter = res; });

async function doConnect() {
  if (READY_DELAY) await sleep(READY_DELAY);
  if (FATAL) { emit({ event: 'fatal', error: 'fake fatal' }); process.exit(1); }
  emit({ event: 'ready', transport: 'rsd', udid: udid || 'fake-udid' });
}

async function serve() {
  let setCount = 0;
  for (;;) {
    const line = await readLine();
    if (line === null) break;
    const s = String(line).trim();
    if (!s) continue;
    let req;
    try { req = JSON.parse(s); } catch { emit({ ok: false, error: 'invalid json' }); continue; }
    const { id, cmd } = req;
    if (cmd === 'set') {
      setCount++;
      emit({ id, ok: true });
      if (CRASH_AFTER_SET && setCount >= CRASH_AFTER_SET) process.exit(2);
    } else if (cmd === 'clear') emit({ id, ok: true });
    else if (cmd === 'ping') emit({ id, ok: true, pong: true });
    else if (cmd === 'quit') { emit({ id, ok: true }); break; }
    else emit({ id, ok: false, error: 'unknown cmd: ' + cmd });
  }
}

(async () => {
  if (WARM) {
    if (WARM_DELAY) await sleep(WARM_DELAY);
    emit({ event: 'warm' });
    for (;;) {
      const line = await readLine();
      if (line === null) process.exit(0); // 未被使用就結束
      const s = String(line).trim();
      if (!s) continue;
      let req;
      try { req = JSON.parse(s); } catch { continue; }
      if (req.cmd === 'connect') { udid = req.udid || udid; await doConnect(); break; }
      if (req.cmd === 'quit') process.exit(0);
    }
  } else {
    await doConnect();
  }
  await serve();
  process.exit(0);
})();
