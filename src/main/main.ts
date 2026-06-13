/**
 * main.ts — Electron 主程序入口
 *
 * 建立視窗、實例化 SimulatorController（擁有引擎與 adapter），
 * 並把 renderer 透過 preload 橋接送來的 IPC 請求轉給 controller。
 */
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { SimulatorController } from './simulator-controller';
import { SpotStore, type SpotInput } from './spot-store';
import { RouteStore, type RouteInput } from './route-store';
import type { Platform } from './core/device-adapter';
import type { Route } from './core/movement-engine';
import { ensureLicensed } from './license';

let controller: SimulatorController | null = null;
let spotStore: SpotStore | null = null;
let routeStore: RouteStore | null = null;

// ── Windows 自我提權（tunneld 需要系統管理員權限）──
const ELEV_FLAG = '--elevated';

function isWindowsElevated(): boolean {
  if (process.platform !== 'win32') return true;
  try {
    execSync('net session', { stdio: 'ignore' }); // 非管理員會拋錯
    return true;
  } catch {
    return false;
  }
}

function needsElevation(): boolean {
  return (
    process.platform === 'win32' &&
    app.isPackaged &&
    !process.argv.includes(ELEV_FLAG) &&
    !isWindowsElevated()
  );
}

function relaunchElevated(): void {
  const exe = process.execPath.replace(/'/g, "''");
  const ps = `Start-Process -FilePath '${exe}' -Verb RunAs -ArgumentList '${ELEV_FLAG}'`;
  try {
    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch {
    /* 使用者取消 UAC 或啟動失敗 → 直接結束 */
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    backgroundColor: '#0c0f14',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // 開發時 helper 在專案 python/ 下；打包後放在 resources/
  const iosScriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'python', 'ios-location-helper.py')
    : path.join(__dirname, '../../python', 'ios-location-helper.py');

  // 打包後若有凍結的 helper exe（自帶 Python）就優先使用，找不到才退回 Python 腳本
  let iosHelperExe: string | undefined;
  let iosTunnelExe: string | undefined;
  if (app.isPackaged) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    // mac 的凍結二進位是 build 機器的架構（CI 為 arm64）。
    // 在非該架構的 Mac（Intel）上不能跑，故略過、退回系統 python3 + pymobiledevice3。
    const archOk = process.platform !== 'darwin' || process.arch === 'arm64';
    if (archOk) {
      const helper = path.join(process.resourcesPath, 'helper', `ios-location-helper${ext}`);
      if (fs.existsSync(helper)) iosHelperExe = helper;
      const tunnel = path.join(process.resourcesPath, 'helper', `tunneld${ext}`);
      if (fs.existsSync(tunnel)) iosTunnelExe = tunnel;
    }
  }

  controller = new SimulatorController(win, { iosScriptPath, iosHelperExe, iosTunnelExe });
}

function registerIpc(): void {
  ipcMain.handle('device:connect', (_e, platform: Platform, opts) =>
    controller!.connect(platform, opts),
  );
  ipcMain.handle('device:disconnect', (_e, id: string) => controller!.disconnect(id));
  ipcMain.handle('device:list', () => controller!.listDevices());
  ipcMain.handle('sim:start', (_e, id: string, route: Route) => controller!.start(id, route));
  ipcMain.handle('sim:pause', (_e, id: string) => controller!.pause(id));
  ipcMain.handle('sim:resume', (_e, id: string) => controller!.resume(id));
  ipcMain.handle('sim:stop', (_e, id: string) => controller!.stop(id));
  ipcMain.handle('sim:setHeading', (_e, id: string, deg: number, moving: boolean) =>
    controller!.setHeading(id, deg, moving),
  );
  ipcMain.handle('sim:setSpeed', (_e, id: string, speedKmh: number) =>
    controller!.setSpeed(id, speedKmh),
  );

  // 地點庫
  ipcMain.handle('spots:list', () => spotStore!.list());
  ipcMain.handle('spots:create', (_e, input: SpotInput) => spotStore!.create(input));
  ipcMain.handle('spots:update', (_e, id: string, changes: Partial<SpotInput>) =>
    spotStore!.update(id, changes),
  );
  ipcMain.handle('spots:delete', (_e, id: string) => {
    spotStore!.remove(id);
    return { ok: true };
  });
  ipcMain.handle('spots:import', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win, {
      title: '匯入地點 CSV',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) {
      return { ok: false, canceled: true, added: 0, skipped: 0, errors: [] };
    }
    try {
      const text = fs.readFileSync(res.filePaths[0], 'utf-8');
      return { ok: true, ...spotStore!.importCsv(text) };
    } catch (e) {
      return { ok: false, added: 0, skipped: 0, errors: [`讀取失敗：${String(e)}`] };
    }
  });

  // 路線庫
  ipcMain.handle('routes:list', () => routeStore!.list());
  ipcMain.handle('routes:create', (_e, input: RouteInput) => routeStore!.create(input));
  ipcMain.handle('routes:update', (_e, id: string, changes: Partial<RouteInput>) =>
    routeStore!.update(id, changes),
  );
  ipcMain.handle('routes:delete', (_e, id: string) => {
    routeStore!.remove(id);
    return { ok: true };
  });

  // 通道狀態 / 重啟
  ipcMain.handle('tunnel:status', () => controller!.tunnelStatus());
  ipcMain.handle('tunnel:prewarm', () => controller!.prewarmTunnel());
  ipcMain.handle('tunnel:restart', () => controller!.tunnelRestart());

  // 庫備份 / 還原
  ipcMain.handle('backup:export', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showSaveDialog(win, {
      title: '匯出備份',
      defaultPath: `定位模擬器備份-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const payload = {
        app: 'location-simulator',
        version: 1,
        exportedAt: Date.now(),
        spots: spotStore!.list(),
        routes: routeStore!.list(),
      };
      fs.writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf-8');
      return { ok: true, path: res.filePath, spots: payload.spots.length, routes: payload.routes.length };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  ipcMain.handle('backup:import', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win, {
      title: '還原備份',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    try {
      const data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf-8'));
      const spots = spotStore!.replaceAll(data.spots);
      const routes = routeStore!.replaceAll(data.routes);
      return { ok: true, spots, routes };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
}

if (needsElevation()) {
  // 非提權實例：以管理員身分重啟自己後結束
  relaunchElevated();
  app.quit();
} else {
  app.whenReady().then(async () => {
    // 裝置授權閘門：未通過只顯示授權視窗，不啟動主程式
    const licensed = await ensureLicensed();
    if (!licensed) return;

    spotStore = new SpotStore();
    routeStore = new RouteStore();
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    controller?.shutdown();
    if (process.platform !== 'darwin') app.quit();
  });
}
