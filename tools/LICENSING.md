# 裝置授權（方案 B：離線簽章授權檔）操作說明

把安裝檔綁定到特定機器：安裝檔外流到別台 → 沒有對應授權檔，跑不起來；授權檔外流 → machine-id 不符，也跑不起來。離線、不需伺服器。

## 檔案

| 檔案 | 位置 | 說明 |
|---|---|---|
| `license.ts` | `src/main/` | App 端：取機器碼、驗章、未授權視窗、匯入流程 |
| `license-preload.ts` | `src/preload/` | 未授權視窗的 contextBridge |
| `keygen.js` | `tools/` | 產生金鑰對（一次），並把公鑰注入 license.ts |
| `license-sign.js` | `tools/` | 為某台機器簽發授權檔 |

主程序已在 `main.ts` 啟動時呼叫 `ensureLicensed()`——未通過只顯示授權視窗、不啟動主程式。

## 一次性設定（你本機）

```bash
# 1) 產生金鑰對；私鑰寫到 tools/keys/private.pem，公鑰自動注入 src/main/license.ts
node tools/keygen.js
```

**重要**：

- `tools/keys/private.pem` 是簽發授權的私鑰，**務必保密、加進 `.gitignore`**。遺失＝無法再簽新授權；外洩＝別人可偽造授權。
- 把 `tools/keys/` 和 `licenses/` 加入 `.gitignore`：

  ```gitignore
  tools/keys/
  licenses/
  ```

- 重新跑 keygen 會換金鑰，**已發出的舊授權檔全部失效**（只有要強制全體重新授權時才做）。

## 發放流程（每台一次）

1. **使用者**安裝通用安裝檔、開啟 App → 出現「此裝置尚未授權」視窗 → 點「複製」取得**本機機器碼**，回報給你。
2. **你**用機器碼簽發授權檔：

   ```bash
   # 永久授權
   node tools/license-sign.js --machine <機器碼> --note "Lab-01"

   # 指定到期日（可選）
   node tools/license-sign.js --machine <機器碼> --expires 2026-12-31 --note "外包-王"
   ```

   產生 `licenses/<機器碼前12碼>.lic`。

3. 把該 `.lic` 檔交給對應使用者 → 在授權視窗點「**匯入授權檔**」選取它 → 驗證通過會**自動重啟**並進入程式。授權檔會存到 `userData/license.lic`。

> 20 台就重複步驟 1–3（你只需保管一支私鑰，逐台簽 `.lic`）。新增第 21 台同理，不必改程式或重新打包。

## 驗證規則（App 端）

依序檢查，任一不過即擋下並顯示原因：

1. **簽章有效**（用內嵌公鑰驗 Ed25519；非本系統核發或被竄改 → 失敗）。
2. **machine-id 相符**（授權檔內的 id == 本機 id；換台機器 → 失敗）。
3. **未到期**（有 `expires` 才檢查）。

## 開發 / 例外

- 開發模式（`app.isPackaged === false`，即 `npm start`）**自動略過**授權檢查。
- 緊急略過：設環境變數 `LICENSE_BYPASS=1` 啟動。
- 只有正式打包（`npm run dist*`）的版本才會強制授權。

## 機器碼怎麼來

- Windows：登錄檔 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`
- macOS：`IOPlatformUUID`
- 取得後加鹽 SHA-256、取前 32 碼（不直接暴露原始 UUID）。

> 注意：重灌系統 / 換主機板 / VM 重建可能改變機器碼，屆時需重新簽發授權檔。

## 安全性定位

這是**用戶端**保護，能擋掉絕大多數「安裝檔/授權檔隨手轉傳」的情況；搭配既有的**混淆 + Electron Fuses + ASAR 完整性**，patch 掉驗證的難度也提高。但對能逆向二進位的人並非絕對——若日後需要可遠端撤銷/席次控管，再升級為「線上啟用」。
