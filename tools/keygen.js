#!/usr/bin/env node
/**
 * tools/keygen.js — 授權金鑰對管理。
 *
 *   node tools/keygen.js
 *     - 若 tools/keys/private.pem 不存在：產生新金鑰對並注入公鑰到 license.ts。
 *     - 若已存在：沿用既有私鑰，僅把對應公鑰「重新注入」到 license.ts
 *       （適用：更新過 license.ts 後公鑰被洗回佔位符時，重新注入即可，
 *        已簽發的 .lic 仍有效）。
 *
 *   node tools/keygen.js --force
 *     - 強制重新產生新金鑰對（會讓所有舊授權檔失效，僅在要換金鑰時用）。
 *
 * 私鑰 tools/keys/private.pem 請保密、加入 .gitignore。
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

const force = process.argv.includes('--force');
let pubPem;

if (fs.existsSync(PRIV) && !force) {
  // 沿用既有私鑰，由它推導出公鑰（保證與簽發私鑰相符）
  const priv = crypto.createPrivateKey(fs.readFileSync(PRIV));
  const pub = crypto.createPublicKey(priv);
  pubPem = pub.export({ type: 'spki', format: 'pem' }).toString().trim();
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(PUB, pubPem + '\n');
  console.log('沿用既有私鑰，僅重新注入公鑰（已簽發的授權檔仍有效）。');
} else {
  if (force) console.log('--force：重新產生新金鑰對（舊授權檔將失效）。');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(PRIV, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
  fs.writeFileSync(PUB, pubPem + '\n');
  console.log(`已產生新金鑰對：\n  私鑰：${PRIV}（請保密、加入 .gitignore）\n  公鑰：${PUB}`);
}

// 注入 license.ts
let src = fs.readFileSync(LICENSE_TS, 'utf8');
const re = /const PUBLIC_KEY_PEM = `[\s\S]*?`;/;
if (!re.test(src)) {
  console.error('⚠ 在 license.ts 找不到 PUBLIC_KEY_PEM 常數，請確認檔案。');
  process.exit(1);
}
src = src.replace(re, 'const PUBLIC_KEY_PEM = `' + pubPem + '`;');
fs.writeFileSync(LICENSE_TS, src);
console.log('✅ 已把公鑰注入 src/main/license.ts');
console.log('   下一步：重新建置 / 打包（npm run dist:win）後，授權檔即可驗證通過。');