凍結後的 iOS helper 執行檔會放在這裡（ios-location-helper.exe）。

在 Windows 上執行專案根目錄的 build-helper.cmd 即可產生。
產生後 npm run dist 會自動把它打包進安裝檔的 resources/helper/，
App 啟動時若偵測到它就會用它（不需目標電腦安裝 Python）。

未產生時這個資料夾保持空的也沒關係：npm run dist 仍可打包，
App 會退回使用 Python 腳本（需目標電腦有 Python + pymobiledevice3）。
