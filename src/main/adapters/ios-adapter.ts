/**
 * ios-adapter.ts — iOS 裝置橋接層（與 python/ios-location-helper.py 對齊）
 *
 * 內部 spawn 出常駐的 helper（包了 pymobiledevice3），透過 stdin/stdout 的
 * 換行分隔 JSON 收發指令，用遞增 id 對應請求與回應。
 *
 * 協定（與 helper 一致）：
 *   - helper 啟動後自行連線，連線成功發 {event:"ready"}、失敗發 {event:"fatal"}
 *   - 連線後可送 {id,cmd:"set"|"clear"|"quit"} 指令，回 {id,ok}
 *   - udid 透過 CLI 參數 --udid 指定
 *
 * 對上層只暴露 DeviceAdapter 介面，完全隱藏 iOS 連線細節。
 * 僅供裝置定位功能測試。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import type { Coordinate } from '../core/movement-engine';
import type { DeviceAdapter } from '../core/device-adapter';
import type { WarmHandle } from '../warm-pool';

export interface IOSAdapterOptions {
  pythonPath?: string;        // python 執行檔，預設 'python3'
  scriptPath?: string;        // helper 腳本路徑，預設 './ios-location-helper.py'
  helperExe?: string;         // 已凍結的 helper 執行檔；設定後直接 spawn 它（不需 Python）
  waitTunnel?: boolean;       // 傳 --wait-tunnel，讓 helper 多等 tunnel 建立
  udid?: string;              // 指定裝置；不給則用第一台
  connectTimeoutMs?: number;  // 等待 ready 的逾時，預設 30s
  warm?: WarmHandle;          // 暖機備援行程（4c）：有的話直接接管、送 connect 指令
  onLog?: (msg: string) => void;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

export class IOSAdapter implements DeviceAdapter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  private readonly py: string;
  private readonly script: string;
  private readonly helperExe?: string;
  private readonly waitTunnel: boolean;
  private readonly udid?: string;
  private readonly timeout: number;
  private warm?: WarmHandle;
  private readonly onLog?: (msg: string) => void;

  constructor(opts: IOSAdapterOptions = {}) {
    this.py = opts.pythonPath ?? 'python3';
    this.script = opts.scriptPath ?? './ios-location-helper.py';
    this.helperExe = opts.helperExe;
    this.waitTunnel = opts.waitTunnel ?? false;
    this.udid = opts.udid;
    this.timeout = opts.connectTimeoutMs ?? 30_000;
    this.warm = opts.warm;
    this.onLog = opts.onLog;
  }

  /**
   * 啟動 helper 並等待裝置連線就緒。
   * iOS 17+ 的傳輸由 tunneld 處理，method 僅供相容（USB 為標準做法）。
   */
  connect(_method: 'usb' | 'wifi' = 'usb'): Promise<void> {
    if (this.proc) return Promise.resolve();

    let proc: ChildProcessWithoutNullStreams;
    let rl: readline.Interface;
    if (this.warm && this.warm.proc.exitCode === null) {
      // 4c：接管暖機備援行程（已 import 完成），送出 connect 指令開始連線
      proc = this.warm.proc;
      rl = this.warm.rl;
      this.warm = undefined;
      this.onLog?.('使用暖機行程連線');
      proc.stdin.write(
        JSON.stringify({ cmd: 'connect', udid: this.udid, waitTunnel: this.waitTunnel }) + '\n',
      );
    } else {
      // 沒有可用備援 → 退回現場 spawn（自帶 Python 的凍結 exe，或 python + 腳本）
      this.warm = undefined;
      const command = this.helperExe ?? this.py;
      const args = this.helperExe ? [] : [this.script];
      if (this.waitTunnel) args.push('--wait-tunnel');
      if (this.udid) args.push('--udid', this.udid);
      proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      rl = readline.createInterface({ input: proc.stdout });
    }
    this.proc = proc;
    this.rl = rl;

    proc.stderr.on('data', (d) => this.onLog?.(`[helper stderr] ${String(d).trim()}`));
    proc.on('exit', (code) => {
      this.failAll(new Error(`helper 已結束（code ${code}）`));
      this.proc = null;
    });

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('連線逾時：裝置未就緒'));
        this.teardown();
      }, this.timeout);

      // 連線階段：等待 ready / fatal
      const onReadyLine = (line: string) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line); } catch { return; }

        if (msg.event === 'ready') {
          clearTimeout(timer);
          rl.off('line', onReadyLine);
          this.attachResponseHandler();
          this.onLog?.(`已連線（transport=${msg.transport}, udid=${msg.udid}）`);
          resolve();
        } else if (msg.event === 'fatal') {
          clearTimeout(timer);
          reject(new Error(String(msg.error ?? '裝置連線失敗')));
          this.teardown();
        } else if (msg.event === 'info') {
          this.onLog?.(String(msg.message ?? ''));
        }
      };
      rl.on('line', onReadyLine);
    });
  }

  /** 設定模擬座標。MovementEngine 每個 tick 會呼叫一次。 */
  async setLocation(coord: Coordinate): Promise<void> {
    await this.request('set', { lat: coord.lat, lng: coord.lng });
  }

  /** 清除模擬定位，讓裝置回到真實 GPS。 */
  async clear(): Promise<void> {
    await this.request('clear', {});
  }

  /** 結束 helper（helper 會在收到 quit 時自動清除定位）。 */
  async disconnect(): Promise<void> {
    const proc = this.proc;
    if (proc) {
      try { await this.request('quit', {}); } catch { /* 程序可能已結束 */ }
      // 等 helper 自行收尾退出（讓它乾淨關閉 RSD 連線，避免突然斷線干擾 tunneld），
      // 最多等 ~2s 再強制清理。
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve();
        const t = setTimeout(resolve, 2000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    this.teardown();
  }

  // ── 內部 ──

  private attachResponseHandler(): void {
    this.rl?.on('line', (line: string) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.event === 'info') return this.onLog?.(String(msg.message ?? ''));
      const id = msg.id as number | undefined;
      if (typeof id !== 'number') return;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(String(msg.error ?? '未知錯誤')));
    });
  }

  private request(cmd: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null) {
        return reject(new Error('helper 未啟動，請先 connect'));
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n');
    });
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private teardown(): void {
    this.rl?.close();
    this.rl = null;
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
      this.proc = null;
    }
    this.failAll(new Error('已斷線'));
  }
}
