<#
  Run by the installer's uninstaller (installer\MediaVault.iss) just before it removes Media Vault's files:
    - stops this copy's status window, setup and servers (only ones running from this folder or its backends' - another
      copy of Media Vault is left alone);
    - removes the Startup and desktop shortcuts if they open this copy;
    - turns off the Tailscale addresses (tailscale serve / Funnel) that point at this copy's servers - Media Vault, the
      sites, its backends - and nothing else on this PC's Tailscale;
    - removes the firewall rules allow-firewall.bat made for this copy's ports. That needs admin rights, so Windows asks
      once; with -Silent (a silent uninstall) it doesn't ask and leaves them.
  A port that something else is listening on once our servers are stopped belongs to another program (or another copy
  of Media Vault), so its Tailscale address and firewall rule stay. The library, settings, hosted sites and projects
  stay too; the uninstaller says where. Exit code 2 = the firewall rules are still there.
#>
param([switch]$Silent)
$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path $PSScriptRoot # (the scripts are in Media Vault's scripts folder)
. (Join-Path $PSScriptRoot 'mv-common.ps1')
$cfg = Get-MvConfig $Root

# ---------- stop this copy ----------
$ours = "$Root\scripts\"
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.ProcessId -ne $PID -and "$($_.CommandLine)".IndexOf($ours, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$backendDirs = @($cfg.backends | ForEach-Object { Resolve-MvDir $Root $_.dir })
Get-Process pocketbase | Where-Object {
  $p = "$($_.Path)"
  $p -and ($p.StartsWith("$Root\", [StringComparison]::OrdinalIgnoreCase) -or ($backendDirs | Where-Object { $p.StartsWith("$_\", [StringComparison]::OrdinalIgnoreCase) }))
} | Stop-Process -Force
# (Backends that run on Media Vault's own pocketbase.exe are covered by the first test: that exe is in this folder.)
Start-Sleep -Milliseconds 800

foreach ($lnk in $MvStartupLnk, $MvDesktopLnk) {
  if ((Get-MvShortcutState $Root $lnk) -eq 'on') { Remove-Item -LiteralPath $lnk -Force }
}

# This copy's ports, unless something else has taken one now that ours are stopped.
$ports = @(@($cfg.vaultPort, $cfg.sitesPort) + @($cfg.backends | ForEach-Object { $_.port }) | Where-Object { $_ -and -not (Get-MvListenPid $_) })

# ---------- Tailscale ----------
# tailscale can wait on a login page, so each command gets 20 seconds.
function Invoke-TsQuiet([string]$argLine) {
  $p = Start-Process -FilePath $TsExe -ArgumentList $argLine -WindowStyle Hidden -PassThru
  if (-not $p.WaitForExit(20000)) { try { $p.Kill() } catch {} }
}
$ts = Get-MvTailscale
if ($ts.Installed) {
  foreach ($h in @($ts.Entries.Keys)) {
    $e = $ts.Entries[$h]
    if ($ports -notcontains $e.Port) { continue }
    if ($e.Public) { Invoke-TsQuiet "funnel --https=$h off" }
    Invoke-TsQuiet "serve --https=$h off"
  }
}

# ---------- firewall ----------
$names = @()
if ($ports -contains $cfg.vaultPort) { $names += "Media Vault ($($cfg.vaultPort))" }
if ($ports -contains $cfg.sitesPort) { $names += "Media Vault sites ($($cfg.sitesPort))" }
$hasRules = { [bool]@(Get-NetFirewallRule -DisplayName $names -ErrorAction SilentlyContinue).Count }
if ($names.Count -and (& $hasRules)) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $list = ($names | ForEach-Object { "'$_'" }) -join ','
  if ($admin) { Remove-NetFirewallRule -DisplayName $names }
  elseif (-not $Silent) {
    try {
      Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -WindowStyle Hidden -Wait `
        -ArgumentList '-NoProfile', '-Command', "Remove-NetFirewallRule -DisplayName $list"
    } catch {} # (No on the admin prompt)
  }
  if (& $hasRules) { exit 2 }
}
exit 0
