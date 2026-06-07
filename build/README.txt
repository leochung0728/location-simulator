放置打包資源。electron-builder 會自動採用此處的圖示（buildResources 目錄）：

  icon.icns   — macOS（建議 512×512 以上）
  icon.ico    — Windows
  icon.png    — Linux（512×512）
  entitlements.mac.plist — macOS hardened runtime entitlements（已提供）

若未提供圖示，electron-builder 會使用 Electron 預設圖示並顯示警告，仍可正常產出安裝檔。
