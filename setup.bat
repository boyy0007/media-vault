@echo off
REM Opens Media Vault setup (scripts\Setup.ps1): ports, the admin dashboard account, Tailscale https addresses, site backends
REM such as CubeWord's save server, the firewall and startup. Safe to run again on an existing install - it starts from
REM what's set up now and keeps your library.
cd /d "%~dp0"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\Setup.ps1"
