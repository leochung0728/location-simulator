#!/usr/bin/env node
/**
 * tools/keygen.js — 產生授權用的 Ed25519 金鑰對（只需執行一次）。
 *
 *   node tools/keygen.js
 *
 * 會：
 *   1) 產生金鑰對。
 *   2) 私鑰寫到 tools/keys/private.pem（請務必加進 .gitignore、妥善保管，遺失或外洩都很麻煩）。
 *   3) 自動把公鑰注入 src/main/license.ts 的 PUBLIC_KEY_PEM。
 *
 * 重新產生會讓「已發出的舊授權檔全部失效」——只有換金鑰、強制重新授權時才這麼做。
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KEY_DIR = path.join(__dirname, 'keys');
const PRIV = path.join(KEY_DIR, 'private.pem');
const PUB = path.join(KEY_DIR, 'public.pem');
const LICENSE_TS = path.join(ROOT, 'src', 'main', 'license.ts');

if (fs.existsSync(PRIV) && process.argv[2] !== '--force') {
  console.error(`已存在 ${PRIV}\n若確定要重新產生（會讓所有舊授權檔失效），加 --force。`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();

fs.mkdirSync(KEY_DIR, { recursive: true });
fs.writeFileSync(PRIV, privPem, { mode: 0o600 });
fs.writeFileSync(PUB, pubPem + '\n');
console.log(`✅ 私鑰：${PRIV}（請保密、加入 .gitignore）`);
console.log(`✅ 公鑰：${PUB}`);

// 注入 license.ts
let src = fs.readFileSync(LICENSE_TS, 'utf8');
const re = /const PUBLIC_KEY_PEM = `[\s\S]*?`;/;
if (!re.test(src)) {
  console.error('⚠ 在 license.ts 找不到 PUBLIC_KEY_PEM 常數，請手動貼入公鑰。');
  process.exit(1);
}
src = src.replace(re, 'const PUBLIC_KEY_PEM = `' + pubPem + '`;');
fs.writeFileSync(LICENSE_TS, src);
console.log('✅ 已把公鑰注入 src/main/license.ts');
console.log('\n下一步：用 tools/license-sign.js 為各機器簽發授權檔。');
