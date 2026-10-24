@echo off
REM The old way to run Media Vault: both servers in this console window, no status window (start.bat opens that).
REM Useful for troubleshooting - errors print straight here. Closing the window stops both servers.
REM Media Vault on port 8091 (the patrol app uses 8090, so both can run on one machine): http://localhost:8091,
REM admin dashboard http://localhost:8091/_/. Uploaded files are stored in the library folder (pb_data, or the one chosen in setup) - back it up.
REM The sites server on port 8092 (hosted HTML projects from "Sites", files in pb_sites\www) is a separate server so
REM hosted pages can't reach your login. The ports come from mediavault.json if setup changed them. Site backends
REM (e.g. CubeWord's save server) aren't started here - start.bat does that. Keep these arguments in step with
REM Get-MvServers in scripts\mv-common.ps1.
cd /d "%~dp0"
if not exist "pocketbase.exe" (
  echo pocketbase.exe isn't here yet. Run setup.bat first - it downloads it.
  pause
  exit /b 1
)
set VP=8091
set SP=8092
for /f "tokens=1,2" %%a in ('powershell -NoProfile -ExecutionPolicy Bypass -File scripts\mv-common.ps1 -PrintPorts') do (
  set VP=%%a
  set SP=%%b
)
start "" /b pocketbase.exe serve --http 0.0.0.0:%SP% --dir pb_sites\pb_data --hooksDir pb_sites\pb_hooks --migrationsDir pb_sites\pb_migrations --publicDir pb_sites\www --indexFallback=false
set DD=pb_data
for /f "delims=" %%d in ('powershell -NoProfile -ExecutionPolicy Bypass -File scripts\mv-common.ps1 -PrintDataDir') do set "DD=%%d"
pocketbase.exe serve --http 0.0.0.0:%VP% --dir "%DD%" --hooksDir pb_hooks --migrationsDir pb_migrations --publicDir pb_public
