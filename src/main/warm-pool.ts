/**
 * warm-pool.ts — iOS helper 的「暖機備援行程池」（4c）
 *
 * 連線最慢的部分是 helper 啟動時的 `import pymobiledevice3`。這裡在 App 閒置時
 * 先養一支 helper（以 --warm 啟動：import 完成後發出 {event:"warm"} 待命），
 * 連線時直接把這支接管、送出 connect 指令，省掉 import 成本；接管後立刻在背景
 * 再補一支備援。維持「一裝置一行程」的隔離，連線一樣快。
 *
 * 取不到備援（停用 / 啟動失敗）時回傳 null，呼叫端應退回原本的現場 spawn。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';

export interface WarmHandle {
  proc: ChildProcessWithoutNullStreams;
  rl: readline.Interface;
}

export interface WarmPoolOptions {
  command: string;        // helperExe 或 python 執行檔
  baseArgs: string[];     // exe 為 []；python 為 [scriptPath]
  warmTimeoutMs?: number; // 等 {event:"warm"} 的逾時（逾時仍交出，連線端另有逾時）
  onLog?: (msg: string) => void;
}

export class WarmPool {
  private spare: WarmHandle | null = null;
  private warming: Promise<WarmHandle | null> | null = null;
  private enabled = true;
  private readonly warmTimeout: number;

  constructor(private readonly opts: WarmPoolOptions) {
    this.warmTimeout = opts.warmTimeoutMs ?? 20_000;
  }

  /** 在背景養一支暖機備援（已有或正在養則不重複）。閒置中若死掉會自動再補。 */
  prewarm(): void {
    if (!this.enabled || this.spare || this.warming) return;
    this.warming = this.spawnWarm().then((h) => {
      this.warming = null;
      this.spare = h;
      if (h) {
        // 閒置中的備援若死掉（且尚未被取用），自動再補一支
        h.proc.once('exit', () => {
          if (this.spare === h) {
            this.spare = null;
            if (this.enabled) this.prewarm();
          }
        });
      } else if (this.enabled) {
        setTimeout(() => this.prewarm(), 3000); // 養失敗，退避後再試（避免緊密迴圈）
      }
      return h;
    });
  }

  /**
   * 取一支已暖機的行程；沒有就現場養一支。回傳 null 表示停用或啟動失敗
   * （呼叫端應退回原本的現場 spawn）。取用後會在背景自動補一支。
   */
  async acquire(): Promise<WarmHandle | null> {
    if (!this.enabled) return null;
    let h: WarmHandle | null = null;
    if (this.spare) {
      h = this.spare;
      this.spare = null;
    } else if (this.warming) {
      h = await this.warming;
      this.spare = null;
    }
    if (h && h.proc.exitCode !== null) h = null; // 閒置中死掉的備援不可用
    if (!h) h = await this.spawnWarm();
    this.prewarm(); // 背景補一支
    return h && h.proc.exitCode === null ? h : null;
  }

  /** 結束未使用的備援（App 關閉時呼叫）。 */
  dispose(): void {
    this.enabled = false;
    const kill = (h: WarmHandle | null) => {
      if (!h) return;
      try { h.rl.close(); } catch { /* */ }
      try { h.proc.kill(); } catch { /* */ }
    };
    kill(this.spare);
    this.spare = null;
    if (this.warming) this.warming.then(kill).catch(() => undefined);
  }

  private spawnWarm(): Promise<WarmHandle | null> {
    return new Promise((resolve) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn(this.opts.command, [...this.opts.baseArgs, '--warm'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        this.opts.onLog?.(`暖機行程啟動失敗：${String(e)}`);
        resolve(null);
        return;
      }
      const rl = readline.createInterface({ input: proc.stdout });
      let settled = false;
      const finish = (h: WarmHandle | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rl.off('line', onLine);
        proc.off('exit', onExit);
        proc.stderr.off('data', onErr);
        resolve(h);
      };
      const onLine = (line: string): void => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.event === 'warm') finish({ proc, rl });
      };
      const onExit = (): void => finish(null);
      const onErr = (d: Buffer): void => this.opts.onLog?.(`[warm stderr] ${String(d).trim()}`);
      // 逾時仍交出 handle：helper 可能較慢，但連線端送出 connect 後另有自己的逾時把關
      const timer = setTimeout(() => finish({ proc, rl }), this.warmTimeout);
      rl.on('line', onLine);
      proc.on('exit', onExit);
      proc.stderr.on('data', onErr);
    });
  }
}
