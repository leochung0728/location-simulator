/**
 * license.ts — 裝置綁定授權（方案 B：離線簽章授權檔）
 *
 * 流程：
 *  - 取本機 machine-id（雜湊後顯示用）。
 *  - 讀 userData/license.lic，驗 Ed25519 簽章 → 比對 machine-id → 檢查到期日。
 *  - 通過才回 true；否則顯示「未授權」視窗（顯示機器碼 + 匯入授權檔）。
 *
 * 金鑰：公鑰內嵌於下方 PUBLIC_KEY_PEM（由 tools/keygen.js 自動注入），
 *       私鑰只在你手上、用 tools/license-sign.js 簽發授權檔。
 *
 * 開發模式（app.isPackaged === false）或設環境變數 LICENSE_BYPASS=1 時略過檢查。
 */
import { app, BrowserWindow, ipcMain, dialog, clipboard } from 'electron';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── 由 keygen 注入（請勿手動改格式）──
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAy/qxbx+y6Gz0CtjGzICOz/ZMmqSXAk63/C8HW2mmBgU=
-----END PUBLIC KEY-----`;
// ── 注入結束 ──

interface LicensePayload {
  v: number;
  machineId: string;
  issuedAt: string;
  expires?: string | null;
  note?: string;
  sig: string; // base64
}

/** 簽章涵蓋的訊息字串（signer 與 verifier 必須一致）。 */
export function signedMessage(p: Pick<LicensePayload, 'v' | 'machineId' | 'issuedAt' | 'expires' | 'note'>): string {
  return `locsim-license:v${p.v}|${p.machineId}|${p.issuedAt}|${p.expires ?? ''}|${p.note ?? ''}`;
}

function rawMachineId(): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', [
        'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid',
      ], { encoding: 'utf8' });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
      if (m) return m[1];
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
      const m = out.match(/IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    } else {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
      }
    }
  } catch { /* 落到下方 fallback */ }
  return 'unknown-' + (process.platform);
}

/** 對外顯示與綁定用的機器碼（雜湊、App 專屬、固定 32 hex）。 */
export function getMachineId(): string {
  const raw = rawMachineId();
  return crypto.createHash('sha256').update('locsim:' + raw).digest('hex').slice(0, 32);
}

function licensePath(): string {
  return path.join(app.getPath('userData'), 'license.lic');
}

type VerifyResult = { ok: true; expires?: string | null } | { ok: false; reason: string };

/** 驗證指定機器碼的授權檔。 */
export function verifyLicense(machineId: string): VerifyResult {
  const p = licensePath();
  if (!fs.existsSync(p)) return { ok: false, reason: '尚未匯入授權檔' };

  let lic: LicensePayload;
  try {
    lic = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { ok: false, reason: '授權檔格式錯誤' };
  }
  if (!lic || typeof lic.sig !== 'string' || typeof lic.machineId !== 'string') {
    return { ok: false, reason: '授權檔內容不完整' };
  }

  // 驗簽章
  let valid = false;
  try {
    valid = crypto.verify(
      null,
      Buffer.from(signedMessage(lic)),
      PUBLIC_KEY_PEM,
      Buffer.from(lic.sig, 'base64'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: '授權檔簽章無效（可能非本系統核發或已被竄改）' };

  // 綁定機器
  if (lic.machineId !== machineId) return { ok: false, reason: '此授權檔不屬於本機' };

  // 到期日（可選）
  if (lic.expires) {
    const today = new Date().toISOString().slice(0, 10);
    if (today > lic.expires) return { ok: false, reason: `授權已於 ${lic.expires} 到期` };
  }
  return { ok: true, expires: lic.expires ?? null };
}

function isConfigured(): boolean {
  return !PUBLIC_KEY_PEM.includes('REPLACE_WITH_YOUR_PUBLIC_KEY');
}

/**
 * 啟動時呼叫：通過授權回 true（可繼續建立主視窗）；
 * 否則顯示未授權視窗並回 false（呼叫端不要再建立主視窗）。
 */
export async function ensureLicensed(): Promise<boolean> {
  // 開發 / 緊急略過
  if (!app.isPackaged || process.env.LICENSE_BYPASS === '1') return true;

  const machineId = getMachineId();
  const res = verifyLicense(machineId);
  if (res.ok) return true;

  showLicenseWindow(machineId, isConfigured() ? res.reason : '應用程式尚未設定授權公鑰');
  return false;
}

let licenseWin: BrowserWindow | null = null;
let licenseIpcReady = false;

function showLicenseWindow(machineId: string, reason: string): void {
  registerLicenseIpc();
  licenseWin = new BrowserWindow({
    width: 460, height: 420, resizable: false, fullscreenable: false, maximizable: false,
    title: '裝置授權', backgroundColor: '#0a0d12',
    webPreferences: {
      preload: path.join(__dirname, '../preload/license-preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  licenseWin.removeMenu?.();
  licenseWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(licenseHtml(machineId, reason)));
  licenseWin.on('closed', () => { licenseWin = null; if (!relaunching) app.quit(); });
}

let relaunching = false;

function registerLicenseIpc(): void {
  if (licenseIpcReady) return;
  licenseIpcReady = true;

  ipcMain.handle('license:machineId', () => getMachineId());
  ipcMain.handle('license:copy', (_e, text: string) => { clipboard.writeText(String(text)); return true; });
  ipcMain.handle('license:quit', () => { app.quit(); });

  ipcMain.handle('license:import', async () => {
    const r = await dialog.showOpenDialog(licenseWin ?? undefined as never, {
      title: '選擇授權檔',
      filters: [{ name: '授權檔', extensions: ['lic', 'json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, reason: '已取消' };

    try {
      const data = fs.readFileSync(r.filePaths[0], 'utf8');
      JSON.parse(data); // 先確認可解析
      fs.writeFileSync(licensePath(), data, 'utf8');
    } catch (e) {
      return { ok: false, reason: '讀取/寫入授權檔失敗：' + String(e) };
    }

    const v = verifyLicense(getMachineId());
    if (!v.ok) {
      try { fs.unlinkSync(licensePath()); } catch { /* */ }
      return { ok: false, reason: v.reason };
    }
    // 成功 → 重啟讓正常流程接手
    relaunching = true;
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
}

function licenseHtml(machineId: string, reason: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root{--bg:#0a0d12;--panel:#11151c;--surface:#161b24;--border:#222a36;--text:#e7ecf3;--muted:#8b97a8;--faint:#5b6675;--signal:#2dd4bf;--stop:#f87171}
  *{box-sizing:border-box;margin:0}body{font-family:system-ui,"Noto Sans TC",sans-serif;background:var(--bg);color:var(--text);padding:26px;height:100vh;display:flex;flex-direction:column;gap:16px}
  h1{font-size:16px;display:flex;align-items:center;gap:9px}.pip{width:9px;height:9px;border-radius:50%;background:var(--stop)}
  .reason{font-size:13px;color:var(--muted);background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:11px 13px;line-height:1.5}
  .lbl{font-size:11px;color:var(--faint);margin-bottom:7px}
  .code{display:flex;gap:8px}
  .code input{flex:1;font-family:ui-monospace,monospace;font-size:13px;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;color:var(--text)}
  button{font-family:inherit;font-size:13px;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer}
  button:hover{background:#1d2430}button.primary{background:var(--signal);color:#04221d;border-color:transparent;font-weight:600}
  .row{display:flex;gap:9px;margin-top:auto}.row button{flex:1}
  .hint{font-size:11.5px;color:var(--faint);line-height:1.6}
  .err{color:#fca5a5;font-size:12.5px;min-height:16px}
</style></head><body>
  <h1><span class="pip"></span> 此裝置尚未授權</h1>
  <div class="reason">${esc(reason)}</div>
  <div>
    <div class="lbl">本機機器碼（請回報給管理者以取得授權檔）</div>
    <div class="code">
      <input id="mid" readonly value="${esc(machineId)}">
      <button id="copy">複製</button>
    </div>
  </div>
  <div class="hint">取得授權檔後，點「匯入授權檔」選取該 .lic 檔；驗證通過會自動重新啟動並進入程式。</div>
  <div class="err" id="err"></div>
  <div class="row">
    <button id="quit">結束</button>
    <button id="import" class="primary">匯入授權檔</button>
  </div>
<script>
  const $=(id)=>document.getElementById(id);
  $('copy').onclick=async()=>{ await window.licenseApi.copy($('mid').value); $('copy').textContent='已複製'; setTimeout(()=>$('copy').textContent='複製',1200); };
  $('quit').onclick=()=>window.licenseApi.quit();
  $('import').onclick=async()=>{
    $('err').textContent='';
    const r=await window.licenseApi.importLicense();
    if(!r.ok && r.reason!=='已取消') $('err').textContent='匯入失敗：'+r.reason;
  };
</script></body></html>`;
}
