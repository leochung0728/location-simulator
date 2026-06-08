/**
 * preload.ts — 安全橋接
 *
 * 在 contextIsolation 下，把一組有限的 API 掛到 renderer 的 window.simulator。
 * renderer 不能直接碰 Node / Electron，只能透過這層呼叫 main。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type Unsubscribe = () => void;

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api = {
  // 裝置
  connect: (platform: 'ios' | 'android', opts: { udid?: string } = {}) =>
    ipcRenderer.invoke('device:connect', platform, opts),
  disconnect: () => ipcRenderer.invoke('device:disconnect'),

  // 模擬控制
  start: (route: unknown) => ipcRenderer.invoke('sim:start', route),
  pause: () => ipcRenderer.invoke('sim:pause'),
  resume: () => ipcRenderer.invoke('sim:resume'),
  stop: () => ipcRenderer.invoke('sim:stop'),
  setHeading: (deg: number, moving: boolean) =>
    ipcRenderer.invoke('sim:setHeading', deg, moving),

  // 通道
  tunnelStatus: (): Promise<boolean> => ipcRenderer.invoke('tunnel:status'),
  tunnelRestart: (): Promise<boolean> => ipcRenderer.invoke('tunnel:restart'),

  // 事件訂閱（main → renderer）
  onPosition: (cb: (p: unknown) => void) => subscribe('sim:position', cb),
  onState: (cb: (s: string) => void) => subscribe('sim:state', cb),
  onDeviceStatus: (cb: (s: unknown) => void) => subscribe('device:status', cb),
  onDeviceLog: (cb: (m: string) => void) => subscribe('device:log', cb),
};

contextBridge.exposeInMainWorld('simulator', api);

const spotsApi = {
  list: () => ipcRenderer.invoke('spots:list'),
  create: (input: unknown) => ipcRenderer.invoke('spots:create', input),
  update: (id: string, changes: unknown) => ipcRenderer.invoke('spots:update', id, changes),
  remove: (id: string) => ipcRenderer.invoke('spots:delete', id),
  importCsv: () => ipcRenderer.invoke('spots:import'),
};

contextBridge.exposeInMainWorld('spots', spotsApi);

const routesApi = {
  list: () => ipcRenderer.invoke('routes:list'),
  create: (input: unknown) => ipcRenderer.invoke('routes:create', input),
  update: (id: string, changes: unknown) => ipcRenderer.invoke('routes:update', id, changes),
  remove: (id: string) => ipcRenderer.invoke('routes:delete', id),
};

contextBridge.exposeInMainWorld('routes', routesApi);

const backupApi = {
  export: () => ipcRenderer.invoke('backup:export'),
  import: () => ipcRenderer.invoke('backup:import'),
};

contextBridge.exposeInMainWorld('backup', backupApi);

export type SimulatorBridge = typeof api;
export type SpotsBridge = typeof spotsApi;
export type RoutesBridge = typeof routesApi;
export type BackupBridge = typeof backupApi;
