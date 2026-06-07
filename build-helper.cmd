@echo off
REM Freeze ios-location-helper.py into a standalone exe (bundles Python + pymobiledevice3).
REM Run on Windows where pymobiledevice3 + pywin32 are already installed.
 
py -m pip show pyinstaller >nul 2>&1 || py -m pip install pyinstaller || goto :err
 
py -m PyInstaller --onefile --noconfirm --clean --collect-all pymobiledevice3 --hidden-import win32security --hidden-import win32file --hidden-import win32event --distpath helper-bin --workpath helper-build --specpath helper-build --name ios-location-helper python\ios-location-helper.py || goto :err
 
echo.
echo Done: helper-bin\ios-location-helper.exe
echo Next: npm run dist:win
goto :eof
 
:err
echo.
echo Failed. Make sure Python, pymobiledevice3 and pywin32 are installed.
exit /b 1