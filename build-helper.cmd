@echo off
REM ============================================================
REM build-helper.cmd
REM Freeze ios-location-helper.py and tunneld-launcher.py into
REM standalone exes (bundling Python + pymobiledevice3) under helper-bin\.
REM Then "npm run dist:win" packs them into resources\helper\.
REM Requires Python, pymobiledevice3 and pywin32 installed on this machine.
REM Note: --collect-all pytun_pmd3 bundles the Windows wintun.dll needed by the tunnel.
REM ============================================================

py -m pip show pyinstaller >nul 2>&1 || py -m pip install pyinstaller || goto :err

echo [1/2] Freezing ios-location-helper (this can take a few minutes)...
py -m PyInstaller --onefile --noconfirm --clean --collect-all pymobiledevice3 --collect-all pytun_pmd3 --recursive-copy-metadata pymobiledevice3 --hidden-import win32security --hidden-import win32file --hidden-import win32event --distpath helper-bin --workpath helper-build --specpath helper-build --name ios-location-helper python\ios-location-helper.py || goto :err

echo [2/2] Freezing tunneld (this can take a few minutes)...
py -m PyInstaller --onefile --noconfirm --clean --collect-all pymobiledevice3 --collect-all pytun_pmd3 --recursive-copy-metadata pymobiledevice3 --hidden-import win32security --hidden-import win32file --hidden-import win32event --distpath helper-bin --workpath helper-build --specpath helper-build --name tunneld python\tunneld-launcher.py || goto :err

echo.
echo Done: helper-bin\ios-location-helper.exe + helper-bin\tunneld.exe
echo Next: npm run dist:win
goto :eof

:err
echo.
echo Failed. Make sure Python, pymobiledevice3, pytun_pmd3 and pywin32 are installed.
exit /b 1