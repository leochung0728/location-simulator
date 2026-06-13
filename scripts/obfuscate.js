/**
 * scripts/obfuscate.js
 *
 * 在 tsc 編譯之後、electron-builder 打包之前執行，
 * 就地混淆 dist/ 內所有 .js（main / preload / renderer）。
 *
 * 重點：
 *  - renameGlobals 必須為 false——renderer 以 <script> 載入，依賴 window.simulator /
 *    window.spots / window.routes / window.backup 與 Leaflet 的全域 L，改名會直接壞掉。
 *  - renderer 用 'browser' 目標（跑在 Chromium）；main / preload 用 'node'。
 *  - 不開 selfDefending / debugProtection（與 bytecode 或除錯情境衝突，先求穩）。
 *
 * 用法： node scripts/obfuscate.js  （build 腳本會自動呼叫）
 *       設環境變數 SKIP_OBFUSCATE=1 可跳過（開發時用）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

if (process.env.SKIP_OBFUSCATE === '1') {
  console.log('[obfuscate] SKIP_OBFUSCATE=1，略過混淆');
  process.exit(0);
}

let JO;
try {
  JO = require('javascript-obfuscator');
} catch {
  console.error('[obfuscate] 找不到 javascript-obfuscator，請先安裝：npm i -D javascript-obfuscator');
  process.exit(1);
}

const DIST = path.resolve(__dirname, '..', 'dist');
if (!fs.existsSync(DIST)) {
  console.error(`[obfuscate] 找不到 ${DIST}，請先執行 tsc 編譯`);
  process.exit(1);
}

// 共用基底設定（偏保守，確保不破壞執行）
const base = {
  compact: true,
  simplify: true,
  numbersToExpressions: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,          // 不可改 true
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 10,
  transformObjectKeys: true,
};

// renderer 跑在 UI，控制流攤平放輕一點避免拖慢；main/preload 可以重一些。
function optionsFor(file) {
  const isRenderer = file.split(path.sep).includes('renderer');
  return {
    ...base,
    target: isRenderer ? 'browser' : 'node',
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: isRenderer ? 0.4 : 0.7,
    deadCodeInjection: !isRenderer,
    deadCodeInjectionThreshold: 0.2,
  };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(DIST);
let n = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const res = JO.obfuscate(src, optionsFor(f)).getObfuscatedCode();
  fs.writeFileSync(f, res, 'utf8');
  n++;
  console.log(`[obfuscate] ${path.relative(DIST, f)}`);
}
console.log(`[obfuscate] 完成，共混淆 ${n} 個檔案`);
