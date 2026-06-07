/**
 * device-adapter.ts — 所有平台橋接層共用的介面。
 * MovementEngine 透過此介面操作裝置，完全不需知道底下是哪個平台。
 */
import type { Coordinate } from './movement-engine';

export type { Coordinate };

export type Platform = 'ios' | 'android';

export interface DeviceAdapter {
  /** 建立與裝置的連線（iOS 走 tunnel/usbmux，Android 走 ADB）。 */
  connect(method?: 'usb' | 'wifi'): Promise<void>;
  /** 設定裝置的模擬定位。每個移動 tick 會呼叫一次。 */
  setLocation(coord: Coordinate): Promise<void>;
  /** 清除模擬定位並關閉連線。 */
  disconnect(): Promise<void>;
}
