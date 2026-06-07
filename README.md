# 定位模擬器 · Electron 骨架

把先前各步驟的模組組裝成一個可執行的 Electron 應用。用途為裝置定位功能測試。

## 架構

```
                 ┌─────────────── main 程序 (Node) ───────────────┐
                 │  SimulatorController                            │
   renderer ──IPC─▶   ├─ MovementEngine（產生座標序列）             │
   (地圖/UI)  ◀─IPC─┤   └─ DeviceAdapter ─┬─ IOSAdapter ─▶ python helper ─▶ 裝置
                 │                       └─ AndroidAdapter ─▶ adb ─▶ 裝置 │
                 └─────────────────────────────────────────────────┘
```

- **引擎與 adapter 都在 main 程序**（需要 Node API：spawn、之後的 ADB）。
- 引擎每個 tick 的座標同時 (1) 經 IPC 推給 renderer 畫地圖、(2) 寫進已連線的裝置。
- **renderer 只是展示層**，透過 preload 的 `window.simulator` 橋接呼叫 main，
  不能直接碰 Node / Electron（contextIsolation）。
- **未連線裝置也能跑** —— 此時只在地圖上預覽路徑，不碰實體裝置。

## 目錄

```
src/
  main/
    main.ts                 入口：建立視窗、註冊 IPC
    simulator-controller.ts 協調者：擁有引擎 + adapter
    core/
      movement-engine.ts    平台無關的移動引擎
      device-adapter.ts     共用裝置介面
    adapters/
      ios-adapter.ts        iOS 橋接（管理 python helper）
      android-adapter.ts    Android 橋接（ADB mock location）
  preload/
    preload.ts              contextBridge 安全橋接
  renderer/
    index.html              UI
    renderer.ts             展示層邏輯
    global.d.ts             window.simulator / L 型別
python/
  ios-location-helper.py    pymobiledevice3 常駐定位 helper
android-companion/
  MockLocationService.kt    實體 Android 裝置用伴隨服務（核心參考，需另建 APK）
```

## 執行

```bash
npm install          # 開發機需可下載 electron
pip install pymobiledevice3 --break-system-packages   # iOS helper 相依
npm run typecheck    # 型別檢查
npm start            # 編譯 + 啟動 Electron
```

## 打包成安裝檔（electron-builder）

設定在 `electron-builder.yml`，安裝檔輸出到 `release/`（與 tsc 的 `dist/` 分開）。

```bash
npm run pack         # 只產出未壓縮的 app 目錄（最快，供測試）
npm run dist         # 產出目前平台的安裝檔
npm run dist:mac     # macOS（dmg + zip）
npm run dist:win     # Windows（nsis 安裝精靈）
npm run dist:linux   # Linux（AppImage + deb）
```

跨平台打包通常需在對應作業系統上進行（例如 Windows 的 nsis、macOS 的簽章/公證）。
`python/` 與 `android-companion/` 透過 `extraResources` 放到 asar 之外（子程序腳本
必須是磁碟上的實體檔），對應 `main.ts` 以 `process.resourcesPath` 解析的路徑。

> **重要：安裝檔不會內含外部工具。** 應用本身會被打包，但裝置功能仍依賴使用者機器上
> 已安裝的外部工具：iOS 需要 `python3` + `pymobiledevice3`，Android 需要 `adb`
> （platform-tools）。這些屬系統層相依，不由 electron-builder 打包。

## iOS 實機前置需求

- 裝置已透過 USB 連接並「信任此電腦」
- iOS 16+：開啟「開發者模式」
- iOS 17+：先在背景啟動 tunnel ── `sudo pymobiledevice3 remote tunneld`
- iOS 16 以下：需已掛載 Developer Disk Image

## Android 實機前置需求

- 安裝 Android platform-tools（提供 `adb`），裝置開啟「USB 偵錯」
- **模擬器**：零額外設定，adapter 直接用 `adb emu geo fix`
- **實體裝置**：非 root 無法純靠 adb 灌定位，需搭配伴隨 App：
  1. 將 `android-companion/MockLocationService.kt` 建成 APK 並安裝
  2. 於「開發者選項 → 選擇模擬位置應用程式」選擇該 App
  3. adapter 會自動 `appops` 授權、啟動服務、`adb forward` 打通 socket

## 組裝時的一處修正

先前交付的 `ios-adapter.ts` 與 `ios-location-helper.py` 協定不一致
（adapter 去 spawn 一支叫 `ios_location_service.py` 的檔、並在啟動後另送
`connect` 指令；但 helper 實際檔名是 `ios-location-helper.py`、於啟動時就
連線、連好才發 `ready`，且不吃 `connect` 指令）。組裝時已將 `src/main/adapters/
ios-adapter.ts` 對齊 helper 的協定：連線改為「spawn + 等待 ready/fatal」、
腳本路徑指向真正的 helper、udid 走 CLI 參數。

## 注意

僅供裝置定位功能測試。將模擬定位用於違反第三方服務條款的行為（例如位置型遊戲）
可能導致帳號被停權，請自行確認用途合規。
