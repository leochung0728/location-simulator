#!/usr/bin/env node
/**
 * tools/license-sign.js — 為某台機器簽發授權檔（.lic）。
 *
 *   node tools/license-sign.js --machine <機器碼> [--expires 2026-12-31] [--note "張三的Mac"] [--out path]
 *
 * 範例：
 *   node tools/license-sign.js --machine 1a2b3c... --note "Lab-01"
 *   node tools/license-sign.js --machine 1a2b3c... --expires 2026-12-31 --note "外包-王"
 *
 * 預設輸出到 licenses/<機器碼前12碼>.lic。把該檔交給對應機器、在 App 內「匯入授權檔」即可。
 * 需要 tools/keys/private.pem（由 keygen.js 產生，保密）。
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const machineId = arg('machine');
if (!machineId) {
  console.error('用法：node tools/license-sign.js --machine <機器碼> [--expires YYYY-MM-DD] [--note "..."] [--out path]');
  process.exit(1);
}
const expires = arg('expires', null);     // 不給 = 永久
const note = arg('note', '');
const keyPath = arg('key', path.join(__dirname, 'keys', 'private.pem'));

if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
  console.error('--expires 格式需為 YYYY-MM-DD');
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  console.error(`找不到私鑰 ${keyPath}，請先執行 node tools/keygen.js`);
  process.exit(1);
}

const v = 1;
const issuedAt = new Date().toISOString().slice(0, 10);

// 必須與 src/main/license.ts 的 signedMessage 完全一致
const message = `locsim-license:v${v}|${machineId}|${issuedAt}|${expires ?? ''}|${note ?? ''}`;

const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
const sig = crypto.sign(null, Buffer.from(message), privateKey).toString('base64');

const lic = { v, machineId, issuedAt, expires: expires ?? null, note, sig };

const outDir = path.resolve(__dirname, '..', 'licenses');
fs.mkdirSync(outDir, { recursive: true });
const out = arg('out', path.join(outDir, machineId.slice(0, 12) + '.lic'));
fs.writeFileSync(out, JSON.stringify(lic, null, 2));

console.log('✅ 已簽發授權檔：' + out);
console.log(`   機器碼：${machineId}`);
console.log(`   到期日：${expires ?? '永久'}`);
if (note) console.log(`   備註：${note}`);
