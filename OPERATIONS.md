# 定位模擬器 — 操作指令參考

> GPS 定位模擬器（Electron 桌面 App）。本文件彙整各情境的指令與操作步驟，供日後查閱。
> 技術棧：Electron 33 · electron-builder 26 · TypeScript 5 · Leaflet 1.9.4(CDN) · pymobiledevice3 v9.16 · Node 20(CI)

---

## 目錄

1. [專案結構與路徑](#1-專案結構與路徑)
2. [開發環境](#2-開發環境)
3. [打包與發佈](#3-打包與發佈)
4. [程式碼保護（混淆 / Fuses / 簽章）](#4-程式碼保護混淆--fuses--簽章)
5. [GitHub Actions（CI）](#5-github-actionsci)
6. [Python helper / tunneld](#6-python-helper--tunneld)
7. [iOS 裝置連線情境](#7-ios-裝置連線情境)
8. [App 操作流程](#8-app-操作流程)
9. [驗證與維護](#9-驗證與維護)
10. [疑難排解](#10-疑難排解)
11. [裝置授權（發放與管理）](#11-裝置授權發放與管理)
12. [.gitignore 建議](#12-gitignore-建議)

---

## 1. 專案結構與路徑

```
electron-app/
├─ src/
│  ├─ main/                  # 主程序（Node 情境）
│  │  ├─ main.ts             # 進入點、IPC、視窗、自我提權、授權閘門、路徑解析
│  │  ├─ license.ts          # 裝置授權（機器碼、驗章、未授權視窗、匯入）
│  │  ├─ simulator-controller.ts  # 多裝置工作階段協調者（共用 tunnel）
│  │  ├─ tunnel-manager.ts   # tunneld 管理（埠 49151）
│  │  ├─ spot-store.ts / route-store.ts  # 地點 / 路線 CRUD（JSON）
│  │  ├─ core/movement-engine.ts         # 移動引擎（純邏輯）
│  │  └─ adapters/ios-adapter.ts, android-adapter.ts
│  ├─ preload/
│  │  ├─ preload.ts          # 主視窗 contextBridge：window.simulator/spots/routes/backup
│  │  └─ license-preload.ts  # 未授權視窗的 contextBridge
│  └─ renderer/
│     ├─ index.html          # UI（深色儀表板，CSS 內嵌）
│     ├─ renderer.ts         # UI 邏輯（瀏覽器情境，純腳本，不可用 require/import）
│     └─ global.d.ts         # 型別宣告（瀏覽器全域）
├─ python/
│  ├─ ios-location-helper.py # 持久 stdio JSON helper + 一次性模式(--list/--wifi-on)
│  └─ tunneld-launcher.py    # 凍結用的 tunneld 進入點
├─ tools/
│  ├─ keygen.js              # 產生授權金鑰對（公鑰注入 license.ts）
│  ├─ license-sign.js        # 為機器碼簽發授權檔
│  └─ keys/private.pem       # 簽發私鑰（保密、勿進 git）
├─ licenses/                 # 簽發出來的 .lic（勿進 git）
├─ scripts/obfuscate.js      # build 後混淆 dist/ 的 JS
├─ electron-builder.yml      # 打包設定（含 electronFuses）
├─ package.json
└─ .github/workflows/build-mac.yml
```

**輸出 / 執行期路徑**

| 用途 | 位置 |
|---|---|
| 編譯後 JS | `dist/`（tsc 產出，electron-builder 打包來源） |
| 安裝檔 | `release/` |
| 凍結的 helper/tunneld | `helper-bin/` → 打包進 `resources/helper/` |
| 額外資源（python 腳本） | `python/` → 打包進 `resources/python/` |
| 使用者資料（執行期） | `spots.json` / `routes.json` 於 `app.getPath('userData')` |
| 授權檔（執行期） | `license.lic` 於 `app.getPath('userData')`（使用者匯入後存於此） |
| App 設定 | 瀏覽器 `localStorage` 的 `appSettings` 鍵 |

---

## 2. 開發環境

```bash
# 安裝相依套件（本機）
npm install

# 若尚未安裝混淆套件
npm i -D javascript-obfuscator

# 型別檢查（不產生檔案）
npm run typecheck

# 只編譯（tsc + 複製 renderer 資源到 dist/）
npm run build

# 開發執行（編譯後直接開 Electron，不混淆）
npm run start

# 快速打包成未壓縮資料夾（--dir，方便檢視打包結果、不混淆）
npm run pack
```

> 開發時 `start` / `pack` 走 `npm run build`，**不會混淆**，方便除錯。
> 真正的安裝檔（`dist*`）才會跑 `protect`（build + 混淆）。

---

## 3. 打包與發佈

```bash
# 目前平台
npm run dist

# 指定平台
npm run dist:mac
npm run dist:win
npm run dist:linux
```

`dist*` 等同：`npm run protect && electron-builder [--平台]`
其中 `protect` = `npm run build && npm run obfuscate`。

```bash
# 臨時跳過混淆（除錯打包問題時用）
SKIP_OBFUSCATE=1 npm run dist:win        # macOS/Linux
set SKIP_OBFUSCATE=1 && npm run dist:win  # Windows CMD
$env:SKIP_OBFUSCATE=1; npm run dist:win   # Windows PowerShell
```

**package.json scripts 對照**

```json
"typecheck": "tsc --noEmit",
"build":     "tsc && <複製 renderer 的非 .ts 資源到 dist/>",
"obfuscate": "node scripts/obfuscate.js",
"protect":   "npm run build && npm run obfuscate",
"start":     "npm run build && electron .",
"pack":      "npm run build && electron-builder --dir",
"dist":      "npm run protect && electron-builder",
"dist:mac":  "npm run protect && electron-builder --mac",
"dist:win":  "npm run protect && electron-builder --win",
"dist:linux":"npm run protect && electron-builder --linux"
```

---

## 4. 程式碼保護（混淆 / Fuses / 簽章）

### 4.1 混淆（javascript-obfuscator）

```bash
# 由 protect / dist* 自動觸發，也可單獨執行（需先有 dist/）
npm run build
npm run obfuscate
```

- 就地混淆 `dist/` 內所有 `.js`；renderer 用 `browser` 目標、main/preload 用 `node`。
- **不重命名全域**（`renameGlobals:false`），以免破壞 `window.simulator/spots/routes/backup` 與 Leaflet 的 `L`。
- 環境變數 `SKIP_OBFUSCATE=1` 可跳過。

### 4.2 Electron Fuses + ASAR 完整性（已設定於 electron-builder.yml）

```yaml
electronFuses:
  runAsNode: false                            # 禁止當純 Node 跑
  enableNodeOptionsEnvironmentVariable: false # 禁 NODE_OPTIONS 注入
  enableNodeCliInspectArguments: false        # 禁 --inspect
  enableEmbeddedAsarIntegrityValidation: true # asar 完整性驗證
  onlyLoadAppFromAsar: true                   # 只從 app.asar 載入
  enableCookieEncryption: true
```

> 需 Electron 16+（macOS）/ 30+（Windows）。asar 完整性在 macOS 需**簽章**後才完整生效。

### 4.3 簽章 / 公證（用環境變數提供憑證）

| 變數 | 用途 |
|---|---|
| `CSC_LINK` | 憑證檔（.p12/.pfx）路徑或 base64（Win + Mac 簽章） |
| `CSC_KEY_PASSWORD` | 憑證密碼 |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | macOS 公證 |

啟用 macOS 公證：
1. electron-builder.yml 的 `mac.notarize: true` 取消註解。
2. 提供上述 Apple 三個變數。
3. CI 移除 `CSC_IDENTITY_AUTO_DISCOVERY: false`，改用 secrets。

> bytecode（.jsc）**未採用**：需 per-OS/架構編譯、與通用版 Mac 衝突、且箭頭函式在 Electron 下可能崩潰，風險高於效益。

---

## 5. GitHub Actions（CI）

**觸發方式**

```bash
# 方式一：推 v 開頭的 tag
git tag v0.1.0
git push --tags

# 方式二：GitHub 網頁 → Actions 分頁 → Build macOS → Run workflow
```

**workflow 重點步驟（build-mac.yml，macOS runner / Apple Silicon arm64）**

```bash
# 安裝（跳過套件腳本，避開 lavamoat postinstall 在 CI 失敗）
npm install --ignore-scripts

# 確保 Electron 執行檔下載（含重試）
node node_modules/electron/install.js

# 凍結 Python helper 與 tunneld（自帶 pymobiledevice3）
pip install pymobiledevice3 pyinstaller
pyinstaller --onefile --noconfirm \
  --collect-all pymobiledevice3 --recursive-copy-metadata pymobiledevice3 \
  --name ios-location-helper --distpath helper-bin python/ios-location-helper.py
pyinstaller --onefile --noconfirm \
  --collect-all pymobiledevice3 --recursive-copy-metadata pymobiledevice3 \
  --name tunneld --distpath helper-bin python/tunneld-launcher.py

# 打包（含混淆，不發佈）
npm run protect
npx electron-builder --mac --publish never
```

> `--recursive-copy-metadata pymobiledevice3` 是**必要**的：少了它，凍結後的 tunneld 會丟 `readchar` 的 `PackageNotFoundError`。

---

## 6. Python helper / tunneld

### 6.1 App 內建 helper 的模式（手動測試用）

```bash
# 列出可見 iOS 裝置（USB + WiFi 合併），輸出 JSON 的 {"event":"devices",...}
python3 python/ios-location-helper.py --list

# 對指定裝置開啟「透過 WiFi 連線」
python3 python/ios-location-helper.py --wifi-on --udid <UDID>

# 持久 stdio 模式（App 主程序用）：以 JSON 行下指令
#   {"cmd":"set","lat":25.03,"lng":121.56}
#   {"cmd":"clear"} / {"cmd":"ping"} / {"cmd":"quit"}
python3 python/ios-location-helper.py --wait-tunnel --udid <UDID>
```

### 6.2 tunneld（RSD 通道，需系統授權）

```bash
# App 是透過 tunnel-manager 以 pymobiledevice3 啟動 tunneld（埠 49151）
# 手動啟動（除錯用，需 sudo / 系統授權）
sudo pymobiledevice3 remote tunneld

# 列出 usbmux 裝置（確認裝置有被看到）
pymobiledevice3 usbmux list
```

### 6.3 凍結後語法檢查

```bash
python3 -m py_compile python/ios-location-helper.py python/tunneld-launcher.py
```

> 注意：pymobiledevice3 v9.16 的 `usbmux.list_devices()` 是 **async**，helper 內以 `await` 處理。

---

## 7. iOS 裝置連線情境

### 7.1 首次連線（USB）

1. iPhone 用 USB 接電腦。
2. iPhone 跳出「信任這台電腦？」→ 點**信任**、輸入密碼。
3. App 內「＋ 連接裝置」→ 平台選 iOS →「重新整理」→ 點裝置連線。

### 7.2 改用 WiFi（免線）

1. 先以 USB 完成一次配對信任（上述）。
2. 確認手機與電腦在**同一網段**。
3. App 連線時會自動嘗試 `--wifi-on`（開啟「透過 WiFi 連線」）。
4. 之後拔線，「重新整理」即可看到 WiFi 裝置（badge 顯示 WiFi）。

### 7.3 通道（tunnel）

- 預設**程式啟動時自動暖機**通道（設定可關）；首次連 iOS 不會卡在建立通道。
- macOS 啟動暖機時會跳一次授權；不想開 App 就被要求授權 → 設定關閉「啟動時自動建立 iOS 通道」，改回第一次連線才建立。
- 通道狀態列：就緒 / 建立中 / 失敗；可按「重啟」。

### 7.4 多裝置同時控制

- 連多台後，左側「裝置工作階段」每台一列、各有顏色。
- 點某列 → 切換「作用中」裝置，控制面板與地圖航點切到該台。
- 所有 iOS 共用**一個** tunnel；最後一台中斷時才收掉。

---

## 8. App 操作流程

### 移動模式

| 模式 | 說明 |
|---|---|
| 單點傳送 | 直接跳到一個座標 |
| 兩點移動 | 兩點間移動 |
| 多點路線 | 多航點依序走 |
| 搖桿模式 | 方向鍵 / 螢幕 D-pad 即時控制 |

> **移動中（running/paused）禁止切換模式**，模式選擇器會變灰；需先停止。

### 路線 / 地點庫（右側）

- **地點**：新增、匯入 CSV、依類型/分數篩選、依分數/經度/時區排序（**篩選與排序會記住**）。
- 點地點列任一處 → 載入到地圖並**高亮該列**；列上動作鈕：載入 ⌖ / 複製座標 / 編輯 / 刪除。
- **路線**：從目前航點儲存、新路線、地圖點選航點、用目前地圖航點覆蓋。

### 地圖

- **搜尋框**：輸入地點名稱即時搜尋；或輸入座標（`25.033, 121.565` / 空白分隔）直接前往並落標記。
- **複製座標**：地點列、搜尋結果、遙測「目前座標」皆有複製鈕。
- 地圖限制為**單一世界**（不橫向重複），取點不會超出經度 ±180。

### 群組操作（連 2 台以上時出現）

- **全部開始**：每台各跑自己設定的路線。
- **全部停止**。
- **套用目前路線到全部**：把作用中裝置的路線/參數複製到其他台。

### 設定

- 預設速度、抖動半徑、單位（公制/英制）。
- 記住上次的地圖視角。
- **啟動時自動建立 iOS 通道**（預設開）。
- 跟隨鏡頭（開關，移動時鏡頭跟著走）。
- 備份**匯出 / 匯入**（地點＋路線）。

---

## 9. 驗證與維護

```bash
# 型別檢查（本機已裝相依套件時最簡單）
npm run typecheck
```

**改動 renderer.ts 後的自我檢查重點**

- `renderer.ts` 跑在**瀏覽器情境**，編譯後的 `renderer.js` **不可**含 `require(` / `module.exports` / 頂層 `import`。
- renderer 用到的資料型別要放進 `global.d.ts` 的 `declare global`（腳本情境才看得到）。
- 頂層 `let` 變數名不可與 contextBridge 全域（`simulator`/`spots`/`routes`/`backup`）衝突 → 路線陣列命名為 `allRoutes`。

```bash
# 確認 renderer 編譯後無 Node 模組語法（人工檢查可用）
npx tsc src/renderer/renderer.ts --outDir /tmp/chk --skipLibCheck \
  --target ES2020 --module ESNext --moduleResolution node --noEmitOnError false
grep -c 'require(\|module.exports' /tmp/chk/renderer.js   # 應為 0
```

---

## 10. 疑難排解

| 症狀 | 原因 / 解法 |
|---|---|
| 凍結後 tunneld 丟 `readchar PackageNotFoundError` | freeze 指令缺 `--recursive-copy-metadata pymobiledevice3`（已加入 workflow）。 |
| 裝置清單看不到手機 | USB 接好並在手機點「信任」；按「重新整理」；WiFi 需同網段且已啟用 WiFi 連線。 |
| 通道一直不就緒 | 看**日誌面板**的 `[helper stderr]`；按通道列「重啟」；確認系統授權有通過。 |
| 連線卡很久 | iOS 走 WiFi + 首次建立通道會數秒（spinner 正常）；若超久多半是信任配對或 tunnel 問題。 |
| 路線/航點跑到地圖另一端 | 早期經度超出 ±180（被多繞 360）；已加 `normPt` 正規化，**重新載入該路線**即修正；開編輯器再存可洗乾淨存檔。 |
| 連線中無回饋 | 已修：點裝置後該列顯示「連線中…」+ spinner，成功才關彈窗、失敗顯示錯誤。 |
| 打包後執行異常但開發正常 | 多半與混淆有關 → 用 `SKIP_OBFUSCATE=1` 重打包比對；確認 renderer 沒踩到全域重命名。 |
| 開啟就跳「此裝置尚未授權」 | 正常的授權閘門。複製機器碼回報以取得授權檔、匯入即可。開發可用 `npm start` 或 `LICENSE_BYPASS=1` 略過。 |
| 匯入授權檔顯示「不屬於本機」 | 該授權檔是別台的；用此機機器碼重新簽發。 |
| 匯入顯示「簽章無效」 | 授權檔被改過，或 App 內嵌公鑰與簽發私鑰不成對（換過金鑰）→ 用目前私鑰重簽。 |

**常看的地方**

- App 內**日誌面板**（標頭的清單圖示）：helper / tunnel 的即時訊息與 `[helper stderr]`。
- CI 失敗：GitHub Actions → 對應 job 的 log（freeze / electron-builder 步驟）。

---

## 11. 裝置授權（發放與管理）

方案 B：離線簽章授權檔。把 App 綁定到特定機器——安裝檔外流到別台沒有對應授權檔跑不起來；授權檔外流到別台 machine-id 不符也跑不起來。離線、不需伺服器。

### 一次性設定（你本機，只做一次）

```bash
# 產生 Ed25519 金鑰對：私鑰寫 tools/keys/private.pem，公鑰自動注入 src/main/license.ts
node tools/keygen.js
```

- `tools/keys/private.pem` 是簽發私鑰，**務必保密、加入 .gitignore**。遺失＝無法再簽新授權；外洩＝可被偽造。
- 重跑 keygen 會換金鑰、**讓所有舊授權檔失效**（只有要強制全體重新授權才做；需加 `--force`）。

### 發放流程（每台一次；20 台就重複）

```bash
# 1) 使用者開啟 App → 「此裝置尚未授權」視窗 → 複製「本機機器碼」回報給你

# 2) 你用機器碼簽發授權檔
node tools/license-sign.js --machine <機器碼> --note "Lab-01"                 # 永久
node tools/license-sign.js --machine <機器碼> --expires 2026-12-31 --note "外包-王"   # 設到期日（可選）
#   → 產生 licenses/<機器碼前12碼>.lic

# 3) 把 .lic 交給對應使用者 → App 授權視窗點「匯入授權檔」選該檔
#    → 驗證通過自動重啟進入程式（授權檔存到 userData/license.lic）
```

新增第 21 台同理，不必改程式或重新打包。

### App 端驗證規則（依序，任一不過即擋）

1. **簽章有效**：內嵌公鑰驗 Ed25519（非本系統核發或被竄改 → 失敗）。
2. **machine-id 相符**：授權檔內 id == 本機 id（換台 → 失敗）。
3. **未到期**：有 `expires` 才檢查。

### 開發 / 例外

```bash
npm start                 # 未打包（app.isPackaged=false）自動略過授權
LICENSE_BYPASS=1 <啟動>   # 緊急略過
```

> 只有正式打包（`npm run dist*`）的版本才強制授權。

### 機器碼來源

Windows `MachineGuid`、macOS `IOPlatformUUID` → 加鹽 SHA-256 取前 32 碼。
重灌系統 / 換主機板 / VM 重建可能改變機器碼，屆時需重新簽發。

### 相關檔案

| 檔案 | 位置 | 說明 |
|---|---|---|
| `license.ts` | `src/main/` | 取機器碼、驗章、未授權視窗、匯入流程 |
| `license-preload.ts` | `src/preload/` | 未授權視窗的 contextBridge |
| `keygen.js` | `tools/` | 產生金鑰對、注入公鑰（一次） |
| `license-sign.js` | `tools/` | 簽發授權檔 |
| `license.lic` | `userData/`（執行期） | 使用者匯入後存於此 |

主程序已在 `main.ts` 啟動時呼叫 `ensureLicensed()`：未通過只顯示授權視窗、不啟動主程式。

### 安全性定位

這是**用戶端**保護，能擋掉絕大多數「安裝檔／授權檔隨手轉傳」的情況；搭配既有的**混淆 + Electron Fuses + ASAR 完整性**，連 patch 掉驗證的難度也提高。但對能逆向二進位的人並非絕對——若日後需要可遠端撤銷／席次控管，再升級為「線上啟用」。

---

## 12. .gitignore 建議

```gitignore
# 編譯 / 打包產物
dist/
release/
helper-bin/
node_modules/

# 授權（機密，切勿進版控）
tools/keys/
licenses/

# 其他
.DS_Store
```

> 重點：`tools/keys/`（簽發私鑰）與 `licenses/`（已簽發的授權檔）**絕不可進 git**。

---

*最後更新：依目前實作整理。新增功能或改流程時，請同步更新本文件。*