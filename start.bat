@echo off
REM Starts Media Vault and opens its status window (scripts\MediaVault.ps1): the servers - Media Vault (port 8091), the sites
REM server (8092) and any site backends such as CubeWord's save server, as set in setup - run hidden in the background,
REM with their state, addresses, library and disk usage shown in the window and their output in logs\. Closing the
REM window asks whether to stop them.
REM On a fresh copy (no mediavault.json and no library yet), or when pocketbase.exe isn't here yet (a git checkout -
REM setup downloads it), this opens setup instead (scripts\Setup.ps1; also setup.bat).
REM Open http://localhost:8091 on this PC, https://<this PC>.<tailnet>.ts.net:8443/ over Tailscale.
REM To run in a plain console window instead (e.g. to see startup errors), use start-console.bat.
cd /d "%~dp0"
if not exist "pocketbase.exe" goto setup
if exist "mediavault.json" goto run
if exist "pb_data\data.db" goto run
:setup
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\Setup.ps1"
exit /b
:run
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\MediaVault.ps1"
