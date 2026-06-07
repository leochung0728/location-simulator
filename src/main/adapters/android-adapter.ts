/**
 * android-adapter.ts — Android 裝置橋接層（ADB mock location）
 *
 * Android 的模擬定位是官方開發者功能。本 adapter 提供兩條注入路徑：
 *
 *   1. 模擬器（emulator）：直接用 `adb emu geo fix <lng> <lat>`，零額外設定。
 *   2. 實體裝置（companion）：透過一支持有 mock-location 權限的伴隨 App
 *      呼叫 LocationManager.addTestProvider / setTestProviderLocation。
 *      desktop 端用 `adb forward` 打通一條 localabstract socket，把座標傳給它。
 *      （非 root 的實體裝置無法純靠 adb shell 持續灌定位，這是平台限制。
 *       伴隨 App 的核心程式見 android-companion/MockLocationService.kt）
 *
 * 介面與 IOSAdapter 相同，SimulatorController 無需改動即可切換平台。
 * 僅供裝置定位功能測試。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as net from 'node:net';
import type { Coordinate } from '../core/movement-engine';
import type { DeviceAdapter } from '../core/device-adapter';

const execFileAsync = promisify(execFile);

export interface AndroidAdapterOptions {
  adbPath?: string;          // adb 執行檔，預設 'adb'
  serial?: string;           // 指定裝置（adb -s）；不給則用第一台
  companionPackage?: string; // 伴隨 App 套件名
  companionSocket?: string;  // 伴隨 App 的 localabstract socket 名稱
  localPort?: number;        // 本機端 forward 的 TCP port
  onLog?: (msg: string) => void;
}

type Transport = 'emulator' | 'companion';

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

const DEFAULT_PACKAGE = 'com.example.mocklocation';
const DEFAULT_SOCKET = 'mocklocation';
const DEFAULT_PORT = 27042;

export class AndroidAdapter implements DeviceAdapter {
  private readonly adb: string;
  private readonly pkg: string;
  private readonly socketName: string;
  private readonly localPort: number;
  private readonly onLog?: (msg: string) => void;

  private serial: string | null;
  private transport: Transport | null = null;
  private socket: net.Socket | null = null;

  // 高頻 setLocation 的「最新優先」合併
  private inflight = false;
  private latest: Coordinate | null = null;
  private waiters: Waiter[] = [];

  constructor(opts: AndroidAdapterOptions = {}) {
    this.adb = opts.adbPath ?? 'adb';
    this.serial = opts.serial ?? null;
    this.pkg = opts.companionPackage ?? DEFAULT_PACKAGE;
    this.socketName = opts.companionSocket ?? DEFAULT_SOCKET;
    this.localPort = opts.localPort ?? DEFAULT_PORT;
    this.onLog = opts.onLog;
  }

  async connect(_method: 'usb' | 'wifi' = 'usb'): Promise<void> {
    await this.ensureAdb();
    this.serial = this.serial ?? (await this.pickDevice());

    if (await this.isEmulator()) {
      this.transport = 'emulator';
      this.onLog?.(`已連線模擬器 ${this.serial}（emu geo fix）`);
      return;
    }

    // 實體裝置：透過伴隨 App
    await this.setupCompanion();
    await this.openSocket();
    this.transport = 'companion';
    this.onLog?.(`已連線實體裝置 ${this.serial}（companion ${this.pkg}）`);
  }

  async setLocation(coord: Coordinate): Promise<void> {
    if (!this.transport) throw new Error('尚未連線');
    this.latest = coord;
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.flush();
    });
  }

  async disconnect(): Promise<void> {
    if (this.transport === 'companion') {
      this.socket?.destroy();
      this.socket = null;
      try {
        await this.runAdb(['shell', 'am', 'force-stop', this.pkg]);
        await this.runAdb(['forward', '--remove', `tcp:${this.localPort}`]);
      } catch { /* 忽略清理錯誤 */ }
    }
    this.transport = null;
    this.failWaiters(new Error('已斷線'));
  }

  // ── 合併送出 ──

  private flush(): void {
    if (this.inflight || this.latest === null) return;
    const coord = this.latest;
    const batch = this.waiters;
    this.latest = null;
    this.waiters = [];
    this.inflight = true;

    this.push(coord)
      .then(() => batch.forEach((w) => w.resolve()))
      .catch((e) => batch.forEach((w) => w.reject(e as Error)))
      .finally(() => {
        this.inflight = false;
        this.flush();
      });
  }

  private async push(coord: Coordinate): Promise<void> {
    if (this.transport === 'emulator') {
      // 注意：emu geo fix 的參數順序是「經度 緯度」
      await this.runAdb(['emu', 'geo', 'fix', String(coord.lng), String(coord.lat)]);
    } else {
      if (!this.socket) throw new Error('socket 未連線');
      await new Promise<void>((resolve, reject) => {
        this.socket!.write(`${coord.lat},${coord.lng}\n`, (err) =>
          err ? reject(err) : resolve(),
        );
      });
    }
  }

  // ── ADB 與裝置設定 ──

  private async ensureAdb(): Promise<void> {
    try {
      await this.runAdb(['start-server']);
    } catch (e) {
      throw new Error(`找不到 adb（${this.adb}）：${(e as Error).message}`);
    }
  }

  private async pickDevice(): Promise<string> {
    const out = await this.runAdb(['devices']);
    const devices = out
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.endsWith('\tdevice'))
      .map((l) => l.split('\t')[0]);
    if (devices.length === 0) throw new Error('沒有偵測到已授權的 Android 裝置');
    return devices[0];
  }

  private async isEmulator(): Promise<boolean> {
    if (this.serial?.startsWith('emulator-')) return true;
    try {
      const qemu = (await this.runAdb(['shell', 'getprop', 'ro.boot.qemu'])).trim();
      return qemu === '1';
    } catch {
      return false;
    }
  }

  private async setupCompanion(): Promise<void> {
    // 確認伴隨 App 已安裝
    const pkgs = await this.runAdb(['shell', 'pm', 'list', 'packages', this.pkg]);
    if (!pkgs.includes(this.pkg)) {
      throw new Error(
        `實體裝置需要伴隨 App「${this.pkg}」。請先 build 並安裝 ` +
          `android-companion 的 APK，並在「開發者選項 → 選擇模擬位置應用程式」選擇它。`,
      );
    }
    // 授予 mock location（多數版本 appops 即可；部分版本仍需手動於開發者選項選擇）
    await this.runAdb(['shell', 'appops', 'set', this.pkg, 'android:mock_location', 'allow']);
    // 啟動伴隨服務（建立 LocalServerSocket 並註冊 test provider）
    await this.runAdb(['shell', 'am', 'start-foreground-service', '-n', `${this.pkg}/.MockLocationService`]);
    // 打通 localabstract socket
    await this.runAdb(['forward', `tcp:${this.localPort}`, `localabstract:${this.socketName}`]);
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = net.connect(this.localPort, '127.0.0.1');
      sock.once('connect', () => { this.socket = sock; resolve(); });
      sock.once('error', (err) => reject(err));
      sock.on('close', () => { this.socket = null; });
    });
  }

  private async runAdb(args: string[]): Promise<string> {
    const full = this.serial ? ['-s', this.serial, ...args] : args;
    const { stdout } = await execFileAsync(this.adb, full, { timeout: 15_000 });
    return stdout;
  }

  private failWaiters(err: Error): void {
    this.waiters.forEach((w) => w.reject(err));
    this.waiters = [];
    this.inflight = false;
  }
}
