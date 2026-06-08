/**
 * simulator-controller.ts — 應用核心的協調者（住在 main 程序）
 *
 * 擁有唯一的 MovementEngine 與目前的 DeviceAdapter，並把兩者串起來：
 * 引擎每個 tick 產生的座標會 (1) 透過 IPC 推給 renderer 畫地圖，
 * (2) 若已連線裝置，同時寫進該裝置。renderer 永遠只是展示層。
 *
 * 未連線裝置時仍可執行 —— 此時只在地圖上預覽路徑（不碰任何實體裝置）。
 */
import type { BrowserWindow } from 'electron';
import { MovementEngine, type Route } from './core/movement-engine';
import type { DeviceAdapter, Platform } from './core/device-adapter';
import { IOSAdapter } from './adapters/ios-adapter';
import { AndroidAdapter } from './adapters/android-adapter';
import { TunnelManager } from './tunnel-manager';

export interface ControllerOptions {
  iosScriptPath: string;   // ios-location-helper.py 的絕對路徑（開發模式用）
  iosHelperExe?: string;   // 凍結的 helper 執行檔（打包後優先使用）
  iosTunnelExe?: string;   // 凍結的 tunneld 執行檔（可選）
}

export class SimulatorController {
  private readonly engine = new MovementEngine(1000);
  private adapter: DeviceAdapter | null = null;
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
    this.engine.onPosition((pos, session) => {
      this.send('sim:position', { pos, session });
      // 已連線才寫入裝置；失敗時回報但不中斷地圖預覽
      this.adapter?.setLocation(pos).catch((e) =>
        this.send('device:status', { connected: false, error: String(e) }),
      );
    });
    this.engine.onEnd(() => this.send('sim:state', 'finished'));
  }

  async connect(platform: Platform, deviceOpts: { udid?: string } = {}): Promise<void> {
    await this.disconnect();
    if (platform === 'ios') {
      // 自動確保 tunnel 就緒（iOS 17+ 必要）；App 已提權，子程序繼承權限
      this.send('device:log', '確保 tunnel 就緒中…');
      await this.tunnel.ensureRunning();
    }
    this.adapter =
      platform === 'ios'
        ? new IOSAdapter({
            pythonPath: this.py,
            scriptPath: this.opts.iosScriptPath,
            helperExe: this.opts.iosHelperExe,
            waitTunnel: true,
            udid: deviceOpts.udid,
            onLog: (m) => this.send('device:log', m),
          })
        : new AndroidAdapter({ serial: deviceOpts.udid });
    await this.adapter.connect('usb');
    this.send('device:status', { connected: true, platform });
  }

  async disconnect(): Promise<void> {
    if (this.adapter) {
      await this.adapter.disconnect().catch(() => undefined);
      this.adapter = null;
    }
    this.send('device:status', { connected: false });
  }

  /** App 結束時呼叫：斷開裝置並收掉自動啟動的 tunnel。 */
  async shutdown(): Promise<void> {
    await this.disconnect().catch(() => undefined);
    this.tunnel.stop();
  }

  start(route: Route): void {
    this.engine.start(route);
    this.send('sim:state', 'running');
  }
  pause(): void {
    this.engine.pause();
    this.send('sim:state', 'paused');
  }
  resume(): void {
    this.engine.resume();
    this.send('sim:state', 'running');
  }
  stop(): void {
    this.engine.stop();
    this.send('sim:state', 'idle');
  }
  setHeading(deg: number, moving: boolean): void {
    this.engine.setHeading(deg, moving);
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
