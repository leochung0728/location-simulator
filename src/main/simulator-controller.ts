/**
 * simulator-controller.ts — 應用核心的協調者（住在 main 程序）
 *
 * 管理「多個裝置工作階段」：每台連線的手機是一個 DeviceSession，
 * 各自擁有一個 MovementEngine 與一個 DeviceAdapter，彼此獨立運作。
 * 所有 iOS 工作階段共用同一個 tunneld（TunnelManager）。
 *
 * 引擎每個 tick 產生的座標會 (1) 透過 IPC（帶 udid）推給 renderer 畫地圖，
 * (2) 寫進「該工作階段對應的裝置」。renderer 永遠只是展示層。
 */
import type { BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { MovementEngine, type Route } from './core/movement-engine';
import type { DeviceAdapter, Platform } from './core/device-adapter';
import { IOSAdapter } from './adapters/ios-adapter';
import { AndroidAdapter } from './adapters/android-adapter';
import { TunnelManager } from './tunnel-manager';

export interface IosDevice {
  udid: string;
  name: string | null;
  iosVersion: string | null;
  connection: 'usb' | 'wifi';
  tunnelReady: boolean;
}

export interface ControllerOptions {
  iosScriptPath: string;   // ios-location-helper.py 的絕對路徑（開發模式用）
  iosHelperExe?: string;   // 凍結的 helper 執行檔（打包後優先使用）
  iosTunnelExe?: string;   // 凍結的 tunneld 執行檔（可選）
}

interface ConnectOpts {
  udid?: string;
  name?: string;
  connection?: 'usb' | 'wifi';
}

interface DeviceSession {
  id: string;            // udid（iOS）或 serial / 'android'
  platform: Platform;
  name: string;
  connection: 'usb' | 'wifi' | '';
  adapter: DeviceAdapter;
  engine: MovementEngine;
  state: 'idle' | 'running' | 'paused' | 'finished';
}

export class SimulatorController {
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly py = process.platform === 'win32' ? 'py' : 'python3';
  private readonly tunnel: TunnelManager;

  constructor(
    private readonly win: BrowserWindow,
    private readonly opts: ControllerOptions,
  ) {
    this.tunnel = new TunnelManager({
      pythonPath: this.py,
      tunnelExe: opts.iosTunnelExe,
      onLog: (m) => this.send('device:log', m),
    });
  }

  private sessionId(platform: Platform, opts: ConnectOpts): string {
    if (opts.udid) return opts.udid;
    return platform === 'android' ? 'android' : 'ios-default';
  }

  async connect(platform: Platform, opts: ConnectOpts = {}): Promise<void> {
    const id = this.sessionId(platform, opts);

    // 已存在相同工作階段 → 先收掉再重建
    if (this.sessions.has(id)) await this.disconnect(id);

    if (platform === 'ios') {
      this.send('device:log', '確保 tunnel 就緒中…');
      await this.tunnel.ensureRunning();
    }

    const engine = new MovementEngine(1000);
    const adapter: DeviceAdapter =
      platform === 'ios'
        ? new IOSAdapter({
            pythonPath: this.py,
            scriptPath: this.opts.iosScriptPath,
            helperExe: this.opts.iosHelperExe,
            waitTunnel: true,
            udid: opts.udid,
            onLog: (m) => this.send('device:log', `[${opts.name ?? id}] ${m}`),
          })
        : new AndroidAdapter({ serial: opts.udid });

    const session: DeviceSession = {
      id,
      platform,
      name: opts.name ?? id,
      connection: opts.connection ?? '',
      adapter,
      engine,
      state: 'idle',
    };

    // 每個工作階段獨立串接：引擎座標 → IPC（帶 udid）＋ 寫入該裝置
    engine.onPosition((pos, sess) => {
      this.send('sim:position', { udid: id, pos, session: sess });
      adapter.setLocation(pos).catch((e) =>
        this.send('device:status', { udid: id, connected: false, error: String(e) }),
      );
    });
    engine.onEnd(() => {
      session.state = 'finished';
      this.send('sim:state', { udid: id, state: 'finished' });
    });

    await adapter.connect('usb');
    this.sessions.set(id, session);
    this.send('device:status', {
      udid: id, connected: true, platform,
      name: session.name, connection: session.connection,
    });

    // 連上後在背景啟用裝置的 WiFi 連線設定（持久設定，不需每次連線都等它；
    // 為 lockdown 操作、與本次 RSD 連線無關）。失敗只記 log，不影響已建立的連線。
    if (platform === 'ios' && opts.udid) {
      this.enableWifi(opts.udid).catch((e) =>
        this.send('device:log', `背景啟用 WiFi 連線失敗（不影響本次連線）：${String(e)}`),
      );
    }
  }

  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    try { session.engine.stop(); } catch { /* */ }
    await session.adapter.disconnect().catch(() => undefined);
    this.sessions.delete(id);
    this.send('device:status', { udid: id, connected: false });

    // 沒有任何 iOS 工作階段時才收掉共用 tunnel
    if (![...this.sessions.values()].some((s) => s.platform === 'ios')) {
      this.tunnel.stop();
    }
  }

  /** App 結束時呼叫：斷開所有裝置並收掉 tunnel。 */
  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.disconnect(id).catch(() => undefined);
    }
    this.tunnel.stop();
  }

  private withSession(id: string, fn: (s: DeviceSession) => void): void {
    const s = this.sessions.get(id);
    if (s) fn(s);
  }

  start(id: string, route: Route): void {
    this.withSession(id, (s) => {
      s.engine.start(route);
      s.state = 'running';
      this.send('sim:state', { udid: id, state: 'running' });
    });
  }
  pause(id: string): void {
    this.withSession(id, (s) => {
      s.engine.pause();
      s.state = 'paused';
      this.send('sim:state', { udid: id, state: 'paused' });
    });
  }
  resume(id: string): void {
    this.withSession(id, (s) => {
      s.engine.resume();
      s.state = 'running';
      this.send('sim:state', { udid: id, state: 'running' });
    });
  }
  stop(id: string): void {
    this.withSession(id, (s) => {
      s.engine.stop();
      s.state = 'idle';
      this.send('sim:state', { udid: id, state: 'idle' });
    });
  }
  setHeading(id: string, deg: number, moving: boolean): void {
    this.withSession(id, (s) => s.engine.setHeading(deg, moving));
  }
  setSpeed(id: string, speedKmh: number): void {
    this.withSession(id, (s) => s.engine.setSpeed(speedKmh));
  }

  /** 列出可見的 iOS 裝置（USB＋WiFi 合併）。連線前用來挑裝置。 */
  async listDevices(): Promise<IosDevice[]> {
    const events = await this.runHelperOnce(['--list'], 30000);
    const ev = events.find((e) => e.event === 'devices');
    const list = (ev?.devices as IosDevice[] | undefined) ?? [];
    return Array.isArray(list) ? list : [];
  }

  /** 對指定裝置開啟「透過 WiFi 連線」（best-effort，不丟例外）。 */
  private async enableWifi(udid: string): Promise<void> {
    this.send('device:log', `嘗試對 ${udid} 開啟 WiFi 連線…`);
    const events = await this.runHelperOnce(['--wifi-on', '--udid', udid], 20000);
    const ev = events.find((e) => e.event === 'wifi-on');
    if (ev?.ok) this.send('device:log', 'WiFi 連線已啟用');
    else this.send('device:log', `WiFi 連線未啟用：${ev?.error ?? '未知'}（可忽略，USB 仍可用）`);
  }

  /** 起一支一次性的 helper（凍結檔或 python 腳本），收集其 JSON 輸出後結束。 */
  private runHelperOnce(extraArgs: string[], timeoutMs = 30000): Promise<Record<string, unknown>[]> {
    return new Promise((resolve) => {
      const command = this.opts.iosHelperExe ?? this.py;
      const args = this.opts.iosHelperExe ? [] : [this.opts.iosScriptPath];
      args.push(...extraArgs);

      const events: Record<string, unknown>[] = [];
      let proc;
      try {
        proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        this.send('device:log', `helper 啟動失敗：${String(e)}`);
        resolve(events);
        return;
      }

      const rl = readline.createInterface({ input: proc.stdout! });
      rl.on('line', (line) => {
        try { events.push(JSON.parse(line)); } catch { /* 忽略非 JSON 行 */ }
      });
      proc.stderr?.on('data', (d) => this.send('device:log', `[helper stderr] ${String(d).trim()}`));

      const timer = setTimeout(() => { try { proc?.kill(); } catch { /* */ } }, timeoutMs);
      proc.on('exit', () => { clearTimeout(timer); rl.close(); resolve(events); });
      proc.on('error', (e) => {
        clearTimeout(timer);
        this.send('device:log', `helper 錯誤：${String(e)}`);
        resolve(events);
      });
    });
  }

  /** 啟動時預先把 tunnel 拉起來（best-effort，失敗不丟例外）。 */
  async prewarmTunnel(): Promise<boolean> {
    try {
      this.send('device:log', '啟動時預先建立 tunnel…');
      await this.tunnel.ensureRunning();
      this.send('device:log', 'tunnel 已就緒');
      return true;
    } catch (e) {
      this.send('device:log', `tunnel 預先建立失敗（連線時會再試）：${String(e)}`);
      return false;
    }
  }

  /** 查詢 tunnel 狀態（true=就緒）。 */
  tunnelStatus(): Promise<boolean> {
    return this.tunnel.status();
  }

  /** 重啟 tunnel，並把結果回報到日誌。 */
  async tunnelRestart(): Promise<boolean> {
    try {
      await this.tunnel.restart();
      this.send('device:log', 'tunnel 已就緒');
      return true;
    } catch (e) {
      this.send('device:log', `tunnel 重啟失敗：${String(e)}`);
      return false;
    }
  }

  private send(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }
}
