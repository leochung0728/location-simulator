/**
 * license-preload.ts — 未授權視窗用的最小 contextBridge。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('licenseApi', {
  machineId: (): Promise<string> => ipcRenderer.invoke('license:machineId'),
  importLicense: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('license:import'),
  copy: (text: string): Promise<boolean> => ipcRenderer.invoke('license:copy', text),
  quit: (): Promise<void> => ipcRenderer.invoke('license:quit'),
});
