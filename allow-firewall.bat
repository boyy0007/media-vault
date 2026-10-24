@echo off
REM One-time setup on a new PC: lets phones reach Media Vault (port 8091) and its sites server (8092) - or the ports
REM setup chose (mediavault.json). Only your home network and Tailscale (100.64.0.0/10) are allowed in - not the internet.
REM Site backends (e.g. CubeWord's save server) listen on 127.0.0.1 only and don't need this.
REM "allow-firewall.bat /quiet" doesn't wait for a key at the end (setup uses that).
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
set VP=8091
set SP=8092
for /f "tokens=1,2" %%a in ('powershell -NoProfile -ExecutionPolicy Bypass -File scripts\mv-common.ps1 -PrintPorts') do (
  set VP=%%a
  set SP=%%b
)
REM Rules for ports used before go first (setup can change the ports).
powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName 'Media Vault (*)', 'Media Vault sites (*)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule"
netsh advfirewall firewall add rule name="Media Vault (%VP%)" dir=in action=allow protocol=TCP localport=%VP% remoteip=LocalSubnet,100.64.0.0/10 profile=any
netsh advfirewall firewall add rule name="Media Vault sites (%SP%)" dir=in action=allow protocol=TCP localport=%SP% remoteip=LocalSubnet,100.64.0.0/10 profile=any
if /i not "%~1"=="/quiet" pause
