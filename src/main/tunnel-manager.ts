/**
 * tunnel-manager.ts — 自動管理 pymobiledevice3 的 tunneld 服務（住在 main 程序）
 *
 * iOS 17+ 的開發者服務需要 tunnel。本管理器會：
 *   1. 偵測 tunneld 是否已在跑（GET http://127.0.0.1:49151）
 *   2. 沒在跑就啟動它（py -m pymobiledevice3 remote tunneld，或凍結的 tunneld exe）
 *   3. 輪詢到就緒才回傳
 *   4. App 結束時收掉自己啟動的那個
 *
 * 注意：tunneld 需要系統管理員權限（建立網路通道）。本管理器假設 main 程序
 * 已在提權狀態下執行（見 main.ts 的自我提權），spawn 出的子程序會繼承權限。
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';

/** 把字串包成安全的 shell 單引號參數。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface TunnelManagerOptions {
  pythonPath?: string;     // 'py'（Windows）或 'python3'
  tunnelExe?: string;      // 凍結的 tunneld 執行檔（可選；設了就用它，免 Python）
  port?: number;           // tunneld 服務埠，預設 49151
  readyTimeoutMs?: number; // 等待就緒逾時，預設 40s
  onLog?: (msg: string) => void;
}

export class TunnelManager {
  private proc: ChildProcess | null = null;
  private startedByUs = false;
  private launchError: string | null = null;

  private readonly py: string;
  private readonly exe?: string;
  private readonly port: number;
  private readonly timeout: number;
  private readonly onLog?: (msg: string) => void;

  constructor(opts: TunnelManagerOptions = {}) {
    this.py = opts.pythonPath ?? 'python3';
    this.exe = opts.tunnelExe;
    this.port = opts.port ?? 49151;
    this.timeout = opts.readyTimeoutMs ?? 40_000;
    this.onLog = opts.onLog;
  }

  /** 確保 tunneld 在跑：已在跑就重用，否則啟動並等到就緒。 */
  async ensureRunning(): Promise<void> {
    if (await this.isReady()) {
      this.onLog?.('偵測到既有 tunnel，直接使用');
      return;
    }
    this.start();
    await this.waitReady();
  }

  /** 結束自己啟動的 tunneld（重用既有的不會被關掉）。 */
  stop(): void {
    if (this.proc && this.startedByUs) {
      this.proc.kill();
      this.proc = null;
      this.startedByUs = false;
    }
  }

  // ── 內部 ──

  private start(): void {
    if (this.proc) return;
    this.launchError = null;
    if (process.platform === 'darwin') {
      this.startDarwin();
      return;
    }
    // Windows（已提權，子程序繼承）/ Linux：直接 spawn
    const cmd = this.exe ?? this.py;
    const args = this.exe ? [] : ['-m', 'pymobiledevice3', 'remote', 'tunneld'];
    this.onLog?.(`啟動 tunneld：${cmd} ${args.join(' ')}`);
    this.proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.startedByUs = true;
    const log = (d: unknown) => this.onLog?.(`[tunneld] ${String(d).trim()}`);
    this.proc.stdout?.on('data', log);
    this.proc.stderr?.on('data', log);
    this.proc.on('exit', (code) => {
      this.onLog?.(`tunneld 已結束（code ${code}）`);
      this.proc = null;
      this.startedByUs = false;
    });
  }

  /**
   * macOS：tunneld 需 root，用原生授權對話框以管理員執行單一指令。
   * 因為 GUI app 與 root shell 的 PATH 都很精簡，這裡先在登入 shell 下
   * 解析出 pymobiledevice3 / python3 的絕對路徑，再丟進授權指令，避免找不到。
   */
  private startDarwin(): void {
    const cmd = this.resolveMacTunnelCmd();
    if (!cmd) {
      this.launchError =
        '找不到 pymobiledevice3，請先在這台 Mac 安裝（pip3 install pymobiledevice3）';
      this.onLog?.(this.launchError);
      return;
    }
    // 背景執行，讓 osascript 立即返回；輸出導到 log 檔
    const inner = `${cmd} > /tmp/locsim-tunneld.log 2>&1 &`;
    const escaped = inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const osa = `do shell script "${escaped}" with administrator privileges`;
    this.onLog?.('要求授權以啟動 tunneld（需輸入密碼 / Touch ID）…');
    this.proc = spawn('osascript', ['-e', osa], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.startedByUs = true;
    this.proc.stderr?.on('data', (d) => this.onLog?.(`[osascript] ${String(d).trim()}`));
    this.proc.on('exit', (code) => {
      // osascript 啟動背景 tunneld 後即返回；非 0 代表授權被取消或啟動失敗
      this.proc = null;
      this.startedByUs = false;
      if (code && code !== 0) this.launchError = '授權被取消或 tunneld 啟動失敗';
    });
  }

  /** 解析 macOS 上要執行的 tunnel 指令（絕對路徑）；找不到回傳 null。 */
  private resolveMacTunnelCmd(): string | null {
    if (this.exe) return shellQuote(this.exe);

    const shell = process.env.SHELL || '/bin/zsh';
    const find = (what: string): string | null => {
      try {
        // 登入+互動 shell 以載入使用者 PATH（Homebrew、pip 使用者目錄等）
        const out = execSync(`${shell} -lic 'command -v ${what}' 2>/dev/null`, {
          encoding: 'utf8',
        }).trim();
        return out ? out.split('\n').pop()!.trim() : null;
      } catch {
        return null;
      }
    };

    let p = find('pymobiledevice3');
    if (!p) {
      for (const cand of [
        '/opt/homebrew/bin/pymobiledevice3',
        '/usr/local/bin/pymobiledevice3',
      ]) {
        if (fs.existsSync(cand)) { p = cand; break; }
      }
    }
    if (p) return `${shellQuote(p)} remote tunneld`;

    // 退而求其次：用 python3 -m
    const py = find('python3') || '/usr/bin/python3';
    return `${shellQuote(py)} -m pymobiledevice3 remote tunneld`;
  }

  private isReady(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.port, path: '/', timeout: 1500 },
        (res) => { res.resume(); resolve(true); },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      if (await this.isReady()) {
        this.onLog?.('tunnel 已就緒');
        return;
      }
      if (this.launchError) throw new Error(this.launchError);
      await new Promise((r) => setTimeout(r, 800));
    }
    throw new Error(
      process.platform === 'darwin'
        ? 'tunnel 啟動逾時（請確認已授權，且這台 Mac 已安裝 pymobiledevice3）'
        : 'tunnel 啟動逾時（請確認 App 以系統管理員權限執行）',
    );
  }
}