<#
  Media Vault status window (opened by start.bat). Starts the PocketBase servers hidden - Media Vault (8091), the
  sites server (8092) and any site backends such as CubeWord's save server, all from mediavault.json (written by
  Setup.ps1; format and server arguments in mv-common.ps1) - and shows their state, the addresses, Tailscale,
  what's in the library and how much disk it uses. Logs go to logs\. Closing the window asks whether to stop the
  servers; if they're left running, opening the window again picks them up by their ports. "Setup..." closes this
  window and opens Setup.ps1 (which reopens it).
  Library numbers come from /api/status (pb_hooks/status.pb.js), which needs the secret in pb_data\.status-token.
  The Settings tab changes `tailscale serve`/`funnel` (sites public / tailnet only, the vault's HTTPS address - never
  public), the Windows startup shortcut, the firewall rule (allow-firewall.bat) and what closing the window does
  (saved in pb_data\.window-settings.json), and adds sites with their own backend (Add-Project: pick the project's
  folder; the site is published and the backend set up and started). -Minimized opens the window minimized (used by
  the startup shortcut).
#>
param([switch]$Minimized)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot # (the scripts are in Media Vault's scripts folder)
Set-Location $Root
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$created = $false
. (Join-Path $PSScriptRoot 'mv-common.ps1')
# (A copy unzipped from a download: clear Windows' internet mark first - see Unblock-MvFolder.)
try { [void](Unblock-MvFolder $Root) } catch {}
# No pocketbase.exe yet (a git checkout): setup downloads it.
if (-not (Test-Path (Join-Path $Root 'pocketbase.exe'))) {
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -WorkingDirectory $Root -WindowStyle Hidden `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$(Join-Path $PSScriptRoot 'Setup.ps1')`""
  return
}
$mutex = New-Object Threading.Mutex($true, $MvWindowMutex, [ref]$created)
if (-not $created) {
  [Windows.Forms.MessageBox]::Show('The Media Vault window is already open (check the taskbar).', 'Media Vault') | Out-Null
  return
}

$LogDir = Join-Path $Root 'logs'
$ProjectsDir = Join-Path $Root 'projects' # where sites with a backend can be kept (optional; Add-Project)
$Cfg = Get-MvConfig $Root
$DataDir = Get-MvDataDir $Root $Cfg # the library: pb_data, unless setup put it somewhere else
$TokenFile = Join-Path $DataDir '.status-token'
$VaultPort = $Cfg.vaultPort; $SitesPort = $Cfg.sitesPort
$Servers = @(Get-MvServers $Root $Cfg)
$Backends = @($Servers | Where-Object { $_.Kind -eq 'backend' })

# ---------- helpers ----------
function Format-Bytes([double]$b) {
  if ($b -ge 1TB) { return '{0:N2} TB' -f ($b / 1TB) }
  if ($b -ge 1GB) { return '{0:N2} GB' -f ($b / 1GB) }
  if ($b -ge 1MB) { return '{0:N1} MB' -f ($b / 1MB) }
  if ($b -ge 1KB) { return '{0:N0} KB' -f ($b / 1KB) }
  return '{0:N0} B' -f $b
}
function Format-Span([TimeSpan]$t) {
  if ($t.TotalDays -ge 1) { return '{0}d {1}h' -f [int][math]::Floor($t.TotalDays), $t.Hours }
  if ($t.TotalHours -ge 1) { return '{0}h {1}m' -f $t.Hours, $t.Minutes }
  if ($t.TotalMinutes -ge 1) { return '{0}m' -f $t.Minutes }
  return 'just now'
}
function Plural([long]$n, [string]$word) { if ($n -eq 1) { "1 $word" } else { '{0:N0} {1}s' -f $n, $word } }
function Get-ListenPid([int]$port) { Get-MvListenPid $port }
function Get-Token {
  if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force $DataDir | Out-Null }
  if (-not (Test-Path $TokenFile) -or (Get-Item $TokenFile).Length -lt 32) {
    $b = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    [IO.File]::WriteAllText($TokenFile, (-join ($b | ForEach-Object { $_.ToString('x2') })))
  }
  ([IO.File]::ReadAllText($TokenFile)).Trim()
}
$Token = Get-Token

function Start-Servers {
  New-Item -ItemType Directory -Force $LogDir | Out-Null
  foreach ($s in $Servers) {
    $s.Error = $null
    if ($s.Kind -eq 'backend' -and (Test-Path -LiteralPath $s.Dir -PathType Container)) {
      # Even when it's running already: PocketBase picks up hook changes by itself.
      try { Set-MvBackendGuard $s.Dir $s.Access } catch {
        if ($s.Access -eq 'public') {
          $s.Error = "couldn't add Media Vault's guard hook to its pb_hooks ($($_.Exception.Message))"
          # Public without the guard would show its admin dashboard to the internet - stop it if it runs from here.
          $id = Get-ListenPid $s.Port
          if ($id -and "$((Get-Process -Id $id -ErrorAction SilentlyContinue).Path)" -eq $s.Exe) { [void](Stop-MvPort $s.Port) }
          continue
        }
      }
    }
    if (Get-ListenPid $s.Port) { continue }
    try {
      if (-not (Test-Path -LiteralPath $s.Dir -PathType Container)) { throw "its folder is missing ($($s.Dir))" }
      if ($s.Kind -eq 'backend') { Assert-MvBackendExe $s }
      $s.Proc = Start-Process -FilePath $s.Exe -ArgumentList $s.Args -WorkingDirectory $s.Dir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogDir "$($s.Log).log") -RedirectStandardError (Join-Path $LogDir "$($s.Log).err.log")
      $s.StartedAt = Get-Date
    } catch { $s.Error = $_.Exception.Message }
  }
  # Media Vault or the sites server not starting is worth a message; a backend's problem shows in its row.
  $core = @($Servers | Where-Object { $_.Kind -ne 'backend' -and $_.Error })
  if ($core.Count) { throw (($core | ForEach-Object { "$($_.Name): $($_.Error)" }) -join "`n") }
}
function Stop-Servers {
  foreach ($s in $Servers) {
    $id = Get-ListenPid $s.Port
    if (-not $id -and $s.Proc -and -not $s.Proc.HasExited) { $id = $s.Proc.Id }
    if (-not $id) { continue }
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'pocketbase') { Stop-Process -Id $id -Force -Confirm:$false }
    $s.Proc = $null; $s.StartedAt = $null
  }
  # Wait (briefly) for the ports to free up so a restart doesn't find them taken.
  $until = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $until -and ($Servers | Where-Object { Get-ListenPid $_.Port })) { Start-Sleep -Milliseconds 200 }
}

# ---------- background snapshot (so slow checks never freeze the window) ----------
$Snapshot = {
  param($Root, $TsExe, $Token, $Ports, $Full, $VaultPort, $SitesPort, $DataDir)
  function Get-Http([string]$url, [hashtable]$hdr, [int]$timeout) {
    try {
      $req = [Net.HttpWebRequest]::Create($url); $req.Timeout = $timeout; $req.Proxy = $null
      foreach ($k in $hdr.Keys) { $req.Headers.Add($k, $hdr[$k]) }
      $res = $req.GetResponse()
      $body = (New-Object IO.StreamReader($res.GetResponseStream())).ReadToEnd(); $res.Close()
      return $body
    } catch { return $null }
  }
  $out = @{ Servers = @{}; Status = $null; Full = $Full }
  foreach ($port in $Ports) {
    $i = @{ Pid = $null; Name = ''; Started = $null; Healthy = $false }
    try { $i.Pid = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess } catch {}
    if ($i.Pid) { try { $p = Get-Process -Id $i.Pid -ErrorAction Stop; $i.Name = $p.ProcessName; $i.Started = $p.StartTime } catch {} }
    $i.Healthy = [bool](Get-Http "http://127.0.0.1:$port/api/health" @{} 2000)
    $out.Servers[$port] = $i
  }
  if ($out.Servers[$Ports[0]].Healthy) {
    $j = Get-Http "http://127.0.0.1:$($Ports[0])/api/status" @{ 'X-Status-Token' = $Token } 5000
    if ($j) { try { $out.Status = $j | ConvertFrom-Json } catch {} }
  }
  if (-not $Full) { return $out }

  $t = @{ Installed = (Test-Path $TsExe); State = ''; Online = $false; Dns = ''; Ip = ''; Serve = $false; ServeSites = $false; Funnel = $false; FunnelSites = $false; HttpsOk = $false
          VaultPorts = @(); SitesPorts = @(); OldLayout = $false; OldSitesPublic = $false; StaleHosts = @(); Other = @{} }
  if ($t.Installed) {
    try {
      $st = (& $TsExe status --json) | Out-String | ConvertFrom-Json
      $t.State = "$($st.BackendState)"; $t.Online = [bool]$st.Self.Online
      $t.Dns = "$($st.Self.DNSName)".TrimEnd('.'); $t.Ip = "$(@($st.Self.TailscaleIPs)[0])"
    } catch {}
    try {
      $sv = (& $TsExe serve status --json) | Out-String | ConvertFrom-Json
      # Layout: Media Vault on 8443 (tailnet only), the sites on 443 (tailnet, or public through Funnel). VaultPorts /
      # SitesPorts list wherever each one is served, so the old layout (vault 443, sites 8443) can be spotted and moved.
      # Entries are keyed "{name}:{port}". After the machine is renamed in Tailscale, the old name's entries stay in the
      # config but no longer answer, so only this machine's current name counts; the others are offered for clearing.
      $to = @{}
      $mine = { param($key) -not $t.Dns -or $key.Substring(0, $key.LastIndexOf(':')) -eq $t.Dns }
      if ($sv.Web) {
        foreach ($w in $sv.Web.PSObject.Properties) {
          if (-not (& $mine $w.Name)) { $t.StaleHosts += @($w.Name.Substring(0, $w.Name.LastIndexOf(':'))); continue }
          $port = $w.Name.Substring($w.Name.LastIndexOf(':') + 1); $to[$w.Name] = "$($w.Value.Handlers.'/'.Proxy)".TrimEnd('/')
          if ($to[$w.Name] -like "*:$VaultPort") { $t.VaultPorts += @($port) }
          elseif ($to[$w.Name] -like "*:$SitesPort") { $t.SitesPorts += @($port) }
          else {
            # Anything else (site backends): local port -> @{ Https; Public }.
            $m = [regex]::Match($to[$w.Name], ':(\d+)$')
            if ($m.Success) { $t.Other[[int]$m.Groups[1].Value] = @{ Https = $port; Public = $false } }
          }
        }
      }
      $t.Serve = $t.VaultPorts -contains '8443'; $t.ServeSites = $t.SitesPorts -contains '443'
      $t.OldLayout = ($t.VaultPorts -contains '443') -or ($t.SitesPorts -contains '8443')
      # Funnel in front of the sites server (or a site backend) is meant to be public; in front of the vault it's not.
      if ($sv.AllowFunnel) {
        foreach ($f in @($sv.AllowFunnel.PSObject.Properties | Where-Object { $_.Value })) {
          if (-not (& $mine $f.Name)) { continue }
          if ("$($to[$f.Name])" -like "*:$SitesPort") {
            if ($f.Name -like '*:443') { $t.FunnelSites = $true } elseif ($f.Name -like '*:8443') { $t.OldSitesPublic = $true }
          } elseif ("$($to[$f.Name])" -like "*:$VaultPort") { $t.Funnel = $true }
          else { foreach ($o in $t.Other.Values) { if ($f.Name -like "*:$($o.Https)") { $o.Public = $true } } }
        }
      }
      $t.StaleHosts = @($t.StaleHosts | Select-Object -Unique)
    } catch {}
    if ($t.Dns -and $t.Serve) { $t.HttpsOk = [bool](Get-Http "https://$($t.Dns):8443/api/health" @{} 6000) }
  }
  $out.Tailscale = $t

  $out.Lan = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' -and $_.Description -notmatch 'Tailscale|Hyper-V|Virtual|VPN|Loopback' } |
    ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
    Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and -not $_.Address.ToString().StartsWith('169.254.') } |
    ForEach-Object { $_.Address.ToString() })
  $out.Firewall = try {
    $fw = @(Get-NetFirewallRule -DisplayName "Media Vault ($VaultPort)", "Media Vault sites ($SitesPort)" -ErrorAction Stop | Where-Object { "$($_.Enabled)" -eq 'True' })
    if ($fw.Count -ge 2) { 'ok' } else { 'missing' }
  } catch { 'missing' }

  $size = { param($dir) $n = 0; $b = 0L
    if (Test-Path $dir) { foreach ($f in (New-Object IO.DirectoryInfo $dir).EnumerateFiles('*', 'AllDirectories')) { $n++; $b += $f.Length } }
    @{ Files = $n; Bytes = $b } }
  $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($DataDir)) # (the drive uploads go to)
  $out.Disk = @{ Data = (& $size $DataDir); Sites = (& $size (Join-Path $Root 'pb_sites\www'))
                 Drive = $drive.Name.TrimEnd('\'); Free = $drive.AvailableFreeSpace; Total = $drive.TotalSize }
  $out
}

# ---------- window ----------
# Same look as setup (mv-look.ps1): a dark sidebar with the pages and a light per server, a header with the overall
# state and the main buttons, and white pages of soft cards.
. (Join-Path $PSScriptRoot 'mv-look.ps1')
. (Join-Path $PSScriptRoot 'mv-qr.ps1') # (QR codes for Connect a phone)

$form = New-Object Windows.Forms.Form
$form.Text = 'Media Vault'
$form.Icon = New-MvIcon
$form.Font = $Font
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object Drawing.Size(1000, 660)
$form.MinimumSize = New-Object Drawing.Size(820, 560)
$form.BackColor = [Drawing.Color]::White; $form.ForeColor = $Ink
if ($Minimized) { $form.WindowState = 'Minimized' }

$outer = New-Object Windows.Forms.TableLayoutPanel; $outer.Dock = 'Fill'; $outer.ColumnCount = 2; $outer.RowCount = 1
[void]$outer.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Absolute', 220)))
[void]$outer.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Percent', 100)))
[void]$outer.RowStyles.Add((New-Object Windows.Forms.RowStyle('Percent', 100)))
$form.Controls.Add($outer)

# Sidebar: the mark and name, the pages (Status / Settings / Logs), and at the bottom a light for each server.
$PageNames = @('Status', 'Settings', 'Logs')
$PageIcons = @{ Status = [char]0xE9D9; Settings = [char]0xE713; Logs = [char]0xE8FD }
$script:PageName = 'Status'; $script:NavHover = -1; $script:Lights = @()
$NavTop = 104; $NavStep = 42
$side = New-Object Windows.Forms.Panel; $side.Dock = 'Fill'; $side.BackColor = $SideBg; $side.Margin = New-Object Windows.Forms.Padding(0)
Set-DoubleBuffered $side
$outer.Controls.Add($side, 0, 0)
$side.Add_Paint({
  $g = $_.Graphics; $g.SmoothingMode = 'AntiAlias'
  $white = { param($a) [Drawing.Color]::FromArgb($a, 255, 255, 255) }
  Draw-MvMark $g 22 24 34
  [Windows.Forms.TextRenderer]::DrawText($g, 'Media Vault', $HeadFont, (New-Object Drawing.Point 66, 23), [Drawing.Color]::White)
  [Windows.Forms.TextRenderer]::DrawText($g, 'on this PC', $Font, (New-Object Drawing.Point 67, 43), (& $white 150))
  for ($k = 0; $k -lt $PageNames.Count; $k++) {
    $n = $PageNames[$k]; $y = $NavTop + $k * $NavStep; $on = $n -eq $script:PageName
    if ($on -or $k -eq $script:NavHover) {
      $path = New-RoundRect 12 $y ($side.Width - 24) 36 9
      $g.FillPath((New-Object Drawing.SolidBrush (& $white $(if ($on) { 30 } else { 14 }))), $path); $path.Dispose()
    }
    if ($on) { $g.FillRectangle((New-Object Drawing.SolidBrush $Brand), 12, ($y + 9), 3, 18) }
    $c = if ($on) { [Drawing.Color]::White } else { & $white 175 }
    [Windows.Forms.TextRenderer]::DrawText($g, [string]$PageIcons[$n], $IconFont, (New-Object Drawing.Rectangle 26, $y, 24, 36), $c, [Windows.Forms.TextFormatFlags]'HorizontalCenter, VerticalCenter, SingleLine')
    [Windows.Forms.TextRenderer]::DrawText($g, $n, $(if ($on) { $HeadFont } else { $Font }), (New-Object Drawing.Rectangle 58, $y, 150, 36), $c, [Windows.Forms.TextFormatFlags]'VerticalCenter, SingleLine')
  }
  # Servers, from the bottom up.
  $y = $side.Height - 24 - $script:Lights.Count * 26
  [Windows.Forms.TextRenderer]::DrawText($g, 'SERVERS', $SmallBold, (New-Object Drawing.Point 22, ($y - 22)), (& $white 120))
  foreach ($l in $script:Lights) {
    $dot = switch ($l.State) { 'up' { [Drawing.Color]::FromArgb(74, 222, 128) } 'starting' { [Drawing.Color]::FromArgb(251, 191, 36) } default { [Drawing.Color]::FromArgb(248, 113, 113) } }
    $g.FillEllipse((New-Object Drawing.SolidBrush $dot), 24, ($y + 8), 8, 8)
    [Windows.Forms.TextRenderer]::DrawText($g, $l.Name, $Font, (New-Object Drawing.Rectangle 40, $y, ($side.Width - 52), 24), (& $white 200), [Windows.Forms.TextFormatFlags]'VerticalCenter, SingleLine, EndEllipsis')
    $y += 26
  }
})
$side.Add_Resize({ $this.Invalidate() })
function Get-NavAt([int]$y) { $k = [math]::Floor(($y - $NavTop) / $NavStep); if ($k -ge 0 -and $k -lt $PageNames.Count -and ($y - $NavTop) % $NavStep -lt 36) { $k } else { -1 } }
$side.Add_MouseMove({ $k = Get-NavAt $_.Y; if ($k -ne $script:NavHover) { $script:NavHover = $k; $side.Cursor = $(if ($k -ge 0) { 'Hand' } else { 'Default' }); $side.Invalidate() } })
$side.Add_MouseLeave({ $script:NavHover = -1; $side.Invalidate() })
$side.Add_MouseClick({ $k = Get-NavAt $_.Y; if ($k -ge 0) { Show-Page $PageNames[$k] } })

# Main column: header (state + buttons), the page, and a line saying when it was last checked.
$main = New-Object Windows.Forms.TableLayoutPanel; $main.Dock = 'Fill'; $main.ColumnCount = 1; $main.RowCount = 3
$main.Padding = New-Object Windows.Forms.Padding(30, 22, 22, 10); $main.Margin = New-Object Windows.Forms.Padding(0)
[void]$main.RowStyles.Add((New-Object Windows.Forms.RowStyle('AutoSize')))
[void]$main.RowStyles.Add((New-Object Windows.Forms.RowStyle('Percent', 100)))
[void]$main.RowStyles.Add((New-Object Windows.Forms.RowStyle('AutoSize')))
$outer.Controls.Add($main, 1, 0)

$header = New-Object Windows.Forms.FlowLayoutPanel; $header.FlowDirection = 'TopDown'; $header.WrapContents = $false; $header.AutoSize = $true
$header.Dock = 'Fill'; $header.Margin = New-Object Windows.Forms.Padding(0, 0, 0, 10)
$stateRow = New-Object Windows.Forms.FlowLayoutPanel; $stateRow.AutoSize = $true; $stateRow.WrapContents = $false; $stateRow.Margin = New-Object Windows.Forms.Padding(0)
$stateDot = New-Object Windows.Forms.Label; $stateDot.AutoSize = $true; $stateDot.Text = [char]0x25CF; $stateDot.Font = New-Object Drawing.Font('Segoe UI', 15); $stateDot.ForeColor = $Grey
$stateDot.Margin = New-Object Windows.Forms.Padding(0, 4, 2, 0)
$state = New-Object Windows.Forms.Label; $state.AutoSize = $true; $state.Font = $TitleFont; $state.Text = 'Checking...'; $state.Margin = New-Object Windows.Forms.Padding(0)
$stateRow.Controls.AddRange(@($stateDot, $state))
$detail = New-Object Windows.Forms.Label; $detail.AutoSize = $true; $detail.ForeColor = $Grey; $detail.Margin = New-Object Windows.Forms.Padding(2, 0, 0, 12)
# Sets the big state line: the dot takes the colour, the words stay dark.
function Set-State([string]$text, $color) { $state.Text = $text; $stateDot.ForeColor = $color }

$bar = New-Object Windows.Forms.FlowLayoutPanel; $bar.AutoSize = $true; $bar.WrapContents = $true; $bar.Margin = New-Object Windows.Forms.Padding(0)
function New-Button([string]$text, [scriptblock]$onClick, [string]$kind = 'secondary') {
  $b = New-Object Windows.Forms.Button; $b.Text = $text; $b.AutoSize = $true; $b.Margin = New-Object Windows.Forms.Padding(0, 0, 8, 6)
  $b.Add_Click($onClick); $bar.Controls.Add($b); Set-ButtonLook $b $kind; $b
}
$header.Controls.AddRange(@($stateRow, $detail, $bar))
$main.Controls.Add($header, 0, 0)

$script:LastSnap = $null
function Open-Target([string]$t) { if ($t) { Start-Process $t } }
function Get-AppUrl {
  $ts = if ($script:LastTs) { $script:LastTs } else { $null }
  if ($ts -and $ts.Serve -and $ts.Dns) { "https://$($ts.Dns):$MvVaultHttps/" } else { "http://localhost:$VaultPort/" }
}
[void](New-Button 'Open Media Vault' { Open-Target (Get-AppUrl) } 'primary')
$btnStart = New-Button 'Start' { Start-Servers; Request-Refresh }
$btnStop = New-Button 'Stop' { $form.Cursor = 'WaitCursor'; Stop-Servers; $form.Cursor = 'Default'; Request-Refresh }
$btnRestart = New-Button 'Restart' { $form.Cursor = 'WaitCursor'; Stop-Servers; Start-Servers; $form.Cursor = 'Default'; Request-Refresh }
[void](New-Button 'Admin dashboard' { Open-Target "http://localhost:$VaultPort/_/" })
# (The data folder opens from its row under Storage; "Check now" is next to the last-checked time.)
# Setup changes what this window started with (ports, backends), so it closes this window and reopens it when done.
$script:ToSetup = $false
function Open-Setup {
  $a = [Windows.Forms.MessageBox]::Show("Open Media Vault setup?`n`nIt changes ports, the admin account, Tailscale addresses, site backends and startup. This window closes while it runs (the servers keep running) and opens again when setup is done.", 'Media Vault', 'OKCancel', 'Question')
  if ($a -eq 'OK') { $script:ToSetup = $true; $form.Close() }
}
[void](New-Button 'Setup...' { Open-Setup })

# Pages, one shown at a time.
$pages = New-Object Windows.Forms.Panel; $pages.Dock = 'Fill'; $pages.Margin = New-Object Windows.Forms.Padding(0)
$main.Controls.Add($pages, 0, 1)
function New-PagePanel {
  $p = New-Object Windows.Forms.FlowLayoutPanel; $p.Dock = 'Fill'; $p.FlowDirection = 'TopDown'; $p.WrapContents = $false; $p.AutoScroll = $true
  $p.Padding = New-Object Windows.Forms.Padding(0, 0, 8, 8); $pages.Controls.Add($p); $p
}
$pgStatus = New-PagePanel; $pgSettings = New-PagePanel
$pgLogs = New-Object Windows.Forms.TableLayoutPanel; $pgLogs.Dock = 'Fill'; $pgLogs.ColumnCount = 1; $pgLogs.RowCount = 2; $pages.Controls.Add($pgLogs)
$PagePanels = @{ Status = $pgStatus; Settings = $pgSettings; Logs = $pgLogs }
function Show-Page([string]$name) {
  $script:PageName = $name
  foreach ($k in $PagePanels.Keys) { $PagePanels[$k].Visible = $k -eq $name }
  Fit-Cards; $side.Invalidate()
}

# Cards fill the page's width; notes and values wrap inside them (set again when the window is resized or a page shown).
$Cards = New-Object Collections.Generic.List[object]
$Notes = New-Object Collections.Generic.List[object]
$ValueLabels = New-Object Collections.Generic.List[object]
function Fit-Cards {
  foreach ($p in $pgStatus, $pgSettings) {
    if (-not $p.Visible) { continue }
    $w = [math]::Max(360, $p.ClientSize.Width - 14)
    foreach ($c in $Cards) { if ($c.Parent -eq $p) { $c.MinimumSize = New-Object Drawing.Size($w, 0); $c.MaximumSize = New-Object Drawing.Size($w, 0) } }
    foreach ($l in $Notes) { if ($l.Parent -and $l.Parent.Parent -eq $p) { $l.MaximumSize = New-Object Drawing.Size(($w - 40 - $l.Margin.Left), 0) } elseif ($l.Parent -eq $p) { $l.MaximumSize = New-Object Drawing.Size($w, 0) } }
  }
  foreach ($v in $ValueLabels) { $v.MaximumSize = New-Object Drawing.Size([math]::Max(200, $pgStatus.ClientSize.Width - 14 - 40 - 200), 0) }
}
$pages.Add_Resize({ Fit-Cards })
function Add-Card($page, [string]$title) {
  $c = New-MvCard; $page.Controls.Add($c); $Cards.Add($c)
  if ($title) {
    $h = New-Object Windows.Forms.Label; $h.AutoSize = $true; $h.Text = $title; $h.Font = $HeadFont; $h.Margin = New-Object Windows.Forms.Padding(0, 0, 0, 6)
    $c.Controls.Add($h)
  }
  $c
}

# ---------- status page: cards of label / value rows. Click an address or folder to open it; right-click to copy. ----------
$Groups = [ordered]@{}
foreach ($name in 'Servers', 'Addresses', 'Phones', 'Library', 'Locked folder', 'Storage') { $Groups[$name] = Add-Card $pgStatus $name }
# Phones: a QR code of the best address (and the Android app's download) to scan instead of typing it (mv-qr.ps1).
$phoneRow = New-Object Windows.Forms.FlowLayoutPanel; $phoneRow.AutoSize = $true; $phoneRow.WrapContents = $false; $phoneRow.Margin = New-Object Windows.Forms.Padding(0, 2, 0, 2)
$btnPhone = New-Object Windows.Forms.Button; $btnPhone.Text = 'Connect a phone...'; $btnPhone.AutoSize = $true; Set-ButtonLook $btnPhone 'primary'
$phoneNote = New-Object Windows.Forms.Label; $phoneNote.AutoSize = $true; $phoneNote.ForeColor = $Grey; $phoneNote.Margin = New-Object Windows.Forms.Padding(10, 8, 0, 0)
$phoneNote.Text = 'Shows a QR code - scan it with the phone''s camera instead of typing the address.'
$phoneRow.Controls.AddRange(@($btnPhone, $phoneNote)); $Groups['Phones'].Controls.Add($phoneRow)
$btnPhone.Add_Click({
  $t = $script:LastTs
  $https = if ($t -and $t.Dns -and $t.Serve) { "https://$($t.Dns):$MvVaultHttps/" } else { '' }
  $apk = Test-Path -LiteralPath (Join-Path $Root 'pb_public\downloads\media-vault.apk')
  Show-MvPhoneQr $form (Get-MvPhoneChoices $https $(if ($t) { $t.Ip } else { '' }) $script:LastLan $VaultPort $apk)
})
$Rows = @{}
$tips = New-Object Windows.Forms.ToolTip
$menu = New-Object Windows.Forms.ContextMenuStrip
$rowOf = { $v = $menu.SourceControl; if ($v -and $v.Tag) { $v.Tag } elseif ($v) { $v.Text } }
[void]$menu.Items.Add('Copy', $null, { $t = & $rowOf; if ($t) { [Windows.Forms.Clipboard]::SetText($t) } })
[void]$menu.Items.Add('Open', $null, { if ($menu.SourceControl.Tag) { Open-Target $menu.SourceControl.Tag } })
$menu.Add_Opening({ $menu.Items[1].Enabled = [bool]$menu.SourceControl.Tag })
function Set-Row([string]$group, [string]$key, [string]$label, [string]$value, $color = $null, [string]$target = '') {
  $r = $Rows[$key]
  if (-not $r) {
    $row = New-Object Windows.Forms.TableLayoutPanel; $row.AutoSize = $true; $row.ColumnCount = 2; $row.RowCount = 1; $row.Margin = New-Object Windows.Forms.Padding(0, 2, 0, 2)
    [void]$row.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Absolute', 200)))
    [void]$row.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('AutoSize')))
    $l = New-Object Windows.Forms.Label; $l.AutoSize = $true; $l.ForeColor = $Grey; $l.Margin = New-Object Windows.Forms.Padding(0, 3, 8, 3)
    $v = New-Object Windows.Forms.Label; $v.AutoSize = $true; $v.Margin = New-Object Windows.Forms.Padding(0, 3, 0, 3); $v.ContextMenuStrip = $menu
    $v.MaximumSize = New-Object Drawing.Size([math]::Max(200, $pgStatus.ClientSize.Width - 254), 0)
    $v.Add_Click({ if ($this.Tag) { Open-Target $this.Tag } })
    $v.Add_MouseEnter({ if ($this.Tag) { $this.Font = New-Object Drawing.Font($Font, [Drawing.FontStyle]::Underline) } })
    $v.Add_MouseLeave({ $this.Font = $Font })
    $row.Controls.Add($l, 0, 0); $row.Controls.Add($v, 1, 0)
    $Groups[$group].Controls.Add($row); $ValueLabels.Add($v)
    $r = @{ Row = $row; Label = $l; Value = $v }; $Rows[$key] = $r
  }
  if ($r.Label.Text -ne $label) { $r.Label.Text = $label }
  if ($r.Value.Text -ne $value) { $r.Value.Text = $value }
  $c = if ($color) { $color } elseif ($target) { $Brand } else { $Ink }
  if ($r.Value.ForeColor -ne $c) { $r.Value.ForeColor = $c }
  $r.Value.Tag = $target
  $r.Value.Cursor = if ($target) { 'Hand' } else { 'Default' }
  $tips.SetToolTip($r.Value, $(if ($target) { "$target`n(click to open, right-click to copy)" } else { '' }))
}
function Remove-Row([string]$key) {
  $r = $Rows[$key]
  if ($r) { $r.Row.Parent.Controls.Remove($r.Row); [void]$ValueLabels.Remove($r.Value); $r.Row.Dispose(); $Rows.Remove($key) }
}

# ---------- logs page ----------
[void]$pgLogs.RowStyles.Add((New-Object Windows.Forms.RowStyle('AutoSize')))
[void]$pgLogs.RowStyles.Add((New-Object Windows.Forms.RowStyle('Percent', 100)))
$logBar = New-Object Windows.Forms.FlowLayoutPanel; $logBar.Dock = 'Fill'; $logBar.AutoSize = $true; $logBar.Margin = New-Object Windows.Forms.Padding(0, 0, 0, 8)
$logLabel = New-Object Windows.Forms.Label; $logLabel.Text = 'Log'; $logLabel.AutoSize = $true; $logLabel.Font = $HeadFont; $logLabel.Margin = New-Object Windows.Forms.Padding(0, 5, 10, 0)
$logPick = New-Object Windows.Forms.ComboBox; $logPick.DropDownStyle = 'DropDownList'; $logPick.Width = 260; $logPick.Margin = New-Object Windows.Forms.Padding(0, 4, 12, 0)
$LogFiles = [ordered]@{ 'Media Vault' = 'media-vault.log'; 'Media Vault errors' = 'media-vault.err.log'; 'Sites' = 'sites.log'; 'Sites errors' = 'sites.err.log' }
foreach ($b in $Backends) { $LogFiles[$b.Name] = "$($b.Log).log"; $LogFiles["$($b.Name) errors"] = "$($b.Log).err.log" }
$LogFiles['Setup'] = 'setup.log'
foreach ($k in $LogFiles.Keys) { [void]$logPick.Items.Add($k) }
$logPick.SelectedIndex = 1
$logOpen = New-Object Windows.Forms.Button; $logOpen.Text = 'Open logs folder'; $logOpen.AutoSize = $true
$logOpen.Add_Click({ New-Item -ItemType Directory -Force $LogDir | Out-Null; Open-Target $LogDir })
Set-ButtonLook $logOpen
$logBar.Controls.AddRange(@($logLabel, $logPick, $logOpen))
$pgLogs.Controls.Add($logBar, 0, 0)
# The log itself, in a card (a plain panel here, so the text box can fill it).
$logCard = New-Object Windows.Forms.Panel; $logCard.Dock = 'Fill'; $logCard.BackColor = $CardBg; $logCard.Padding = New-Object Windows.Forms.Padding(14, 12, 6, 12)
$logCard.Margin = New-Object Windows.Forms.Padding(0, 0, 8, 8); Set-DoubleBuffered $logCard
$logCard.Add_Paint({
  $g = $_.Graphics; $g.SmoothingMode = 'AntiAlias'; $g.Clear([Drawing.Color]::White)
  $path = New-RoundRect 0.5 0.5 ($this.Width - 1.5) ($this.Height - 1.5) 10
  $g.FillPath((New-Object Drawing.SolidBrush $CardBg), $path); $g.DrawPath((New-Object Drawing.Pen ([Drawing.Color]::FromArgb(234, 234, 242))), $path); $path.Dispose()
})
$logCard.Add_Resize({ $this.Invalidate() })
$logBox = New-Object Windows.Forms.TextBox; $logBox.Multiline = $true; $logBox.ReadOnly = $true; $logBox.ScrollBars = 'Both'; $logBox.WordWrap = $false
$logBox.Dock = 'Fill'; $logBox.Font = $MonoFont; $logBox.BackColor = $CardBg; $logBox.BorderStyle = 'None'
$logCard.Controls.Add($logBox)
$pgLogs.Controls.Add($logCard, 0, 1)
$script:LogSig = ''
function Update-Log {
  $path = Join-Path $LogDir $LogFiles[$logPick.SelectedItem]
  $text = ''; $sig = $path
  if (Test-Path $path) {
    try {
      $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
      $sig = "$path|$($fs.Length)"
      if ($sig -eq $script:LogSig) { $fs.Close(); return }
      $start = [math]::Max(0, $fs.Length - 65536); [void]$fs.Seek($start, 'Begin')
      $text = (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd(); $fs.Close()
      $text = [regex]::Replace($text, '\x1B\[[0-9;]*[A-Za-z]', '') -replace "(?<!`r)`n", "`r`n"
    } catch { $text = "Couldn't read the log: $($_.Exception.Message)" }
  } elseif ($sig -eq $script:LogSig) { return }
  $script:LogSig = $sig
  if (-not $text.Trim()) { $text = '(empty - nothing logged yet)' }
  $logBox.Text = $text; $logBox.SelectionStart = $logBox.TextLength; $logBox.ScrollToCaret()
}
$logPick.Add_SelectedIndexChanged({ $script:LogSig = ''; Update-Log })

# ---------- settings tab ----------
# Window preferences (just what closing the window does), kept next to the status token.
$SettingsFile = Join-Path $DataDir '.window-settings.json'
function Get-WindowSettings {
  $s = @{ OnClose = 'ask' }
  try { if (Test-Path $SettingsFile) { $j = Get-Content -Raw $SettingsFile | ConvertFrom-Json; if ($j.OnClose -in 'ask', 'keep', 'stop') { $s.OnClose = $j.OnClose } } } catch {}
  $s
}
function Save-WindowSettings { try { $script:WinSettings | ConvertTo-Json | Set-Content -Encoding utf8 $SettingsFile } catch {} }
$script:WinSettings = Get-WindowSettings

# Start with Windows: a shortcut in the user's Startup folder that opens this window minimized (mv-common.ps1).
function Get-StartupState { Get-MvShortcutState $Root $MvStartupLnk }
function Set-Startup([bool]$on) { Set-MvShortcut $Root $MvStartupLnk $on -Minimized }

# Tailscale changes run through Invoke-Ts (mv-common.ps1): the window keeps running while tailscale works.
# Steps: @{ A = 'tailscale arguments'; Must = $true } - a failing step that isn't a Must (e.g. "off" for something
# that's already off) is ignored. Returns whether it all worked (after saying what went wrong if not).
function Invoke-TsSteps($steps) {
  $script:SettingsBusy = $true; $setPanel.Enabled = $false; $form.Cursor = 'WaitCursor'
  $fail = $null
  try { foreach ($s in $steps) { $r = Invoke-Ts $s.A; if (-not $r.Ok -and $s.Must) { $fail = $r; break } } }
  finally { $form.Cursor = 'Default'; $setPanel.Enabled = $true; $script:SettingsBusy = $false; $script:TsChangedAt = Get-Date; Request-Refresh -Full }
  if (-not $fail) { return $true }
  $false
  $out = $fail.Out; if ($out.Length -gt 1500) { $out = $out.Substring(0, 1500) + '...' }
  $m = [regex]::Match($out, 'https://login\.tailscale\.com/\S+')
  if ($m.Success) {
    $a = [Windows.Forms.MessageBox]::Show("Tailscale needs this allowed for your tailnet first.`n`nOpen the page to allow it? Afterwards, choose the option here again.`n`n$out", 'Media Vault', 'YesNo', 'Information')
    if ($a -eq 'Yes') { Open-Target $m.Value }
  } else {
    $why = if ($fail.TimedOut) { "Tailscale didn't finish within 20 seconds." } else { "Tailscale couldn't make the change." }
    [Windows.Forms.MessageBox]::Show("$why`n`n$out", 'Media Vault', 'OK', 'Warning') | Out-Null
  }
}
# Layout: the sites on 443 (only they are ever funnelled), Media Vault on 8443 (tailnet only or off).
$VaultOn = @(@{ A = 'funnel --https=8443 off'; Must = $false }, @{ A = "serve --bg --https=8443 http://127.0.0.1:$VaultPort"; Must = $true })
$SitesTo = "http://127.0.0.1:$SitesPort"
# Moving from the old layout (vault on 443, sites on 8443): put the vault on 8443 first, so changing 443 for the
# sites never leaves it without an address; or clear the sites off 8443 if the vault isn't coming back there.
function Get-MoveSteps {
  $ts = $script:LastTs
  if (-not $ts) { return @() }
  if (($ts.VaultPorts -contains '443') -and -not $ts.Serve) { return $VaultOn }
  if ($ts.SitesPorts -contains '8443') { return @(@{ A = 'funnel --https=8443 off'; Must = $false }, @{ A = 'serve --https=8443 off'; Must = $false }) }
  @()
}
# The whole move in one go, keeping the sites public if they were.
function Move-ToNewLayout {
  $ts = $script:LastTs
  if (-not $ts -or -not $ts.OldLayout) { return }
  $to = $SitesTo
  $steps = @(Get-MoveSteps)
  if ($ts.OldSitesPublic) { $steps += @{ A = "funnel --bg --https=443 $to"; Must = $true } }
  elseif ($ts.SitesPorts -contains '8443') { $steps += @(@{ A = 'funnel --https=443 off'; Must = $false }, @{ A = "serve --bg --https=443 $to"; Must = $true }) }
  elseif ($ts.VaultPorts -contains '443') { $steps += @(@{ A = 'funnel --https=443 off'; Must = $false }, @{ A = 'serve --https=443 off'; Must = $false }) }
  Invoke-TsSteps $steps
}
function Set-SitesAccess([string]$mode) {
  $to = $SitesTo
  $steps = @(Get-MoveSteps)
  switch ($mode) {
    'public' { $steps += @{ A = "funnel --bg --https=443 $to"; Must = $true } }
    'tailnet' { $steps += @(@{ A = 'funnel --https=443 off'; Must = $false }, @{ A = "serve --bg --https=443 $to"; Must = $true }) }
    'off' { $steps += @(@{ A = 'funnel --https=443 off'; Must = $false }, @{ A = 'serve --https=443 off'; Must = $false }) }
  }
  Invoke-TsSteps $steps
}
function Set-VaultAccess([string]$mode) {
  $steps = if ($mode -eq 'tailnet') { @($VaultOn) } else { @(@{ A = 'funnel --https=8443 off'; Must = $false }, @{ A = 'serve --https=8443 off'; Must = $false }) }
  # The old layout's vault on 443 goes either way (443 is the sites' address now).
  if ($script:LastTs -and $script:LastTs.VaultPorts -contains '443') { $steps += @(@{ A = 'funnel --https=443 off'; Must = $false }, @{ A = 'serve --https=443 off'; Must = $false }) }
  Invoke-TsSteps $steps
}
# After a rename in Tailscale, the old name's entries can only be removed by resetting the whole serve config, so put
# back what this name has (vault on 8443, the sites on 443 - public or not, site backends) straight after.
function Clear-StaleHosts {
  $ts = $script:LastTs
  if (-not $ts -or -not $ts.StaleHosts.Count) { return }
  $steps = @(@{ A = 'serve reset'; Must = $true })
  if ($ts.Serve) { $steps += $VaultOn }
  if ($ts.FunnelSites) { $steps += @{ A = "funnel --bg --https=443 $SitesTo"; Must = $true } }
  elseif ($ts.ServeSites) { $steps += @{ A = "serve --bg --https=443 $SitesTo"; Must = $true } }
  foreach ($port in @($ts.Other.Keys)) {
    $o = $ts.Other[$port]
    $steps += @{ A = "$(if ($o.Public) { 'funnel' } else { 'serve' }) --bg --https=$($o.Https) http://127.0.0.1:$port"; Must = $true }
  }
  Invoke-TsSteps $steps
}

# ---------- adding a site and/or its backend (Settings > Sites with a backend) ----------
# "Add a site or backend...": pick a project's folder and this works out what's in it:
#   the site - the folder with its index.html (at the top, or in dist / build / out / _site / public / www /
#     pb_public), copied to pb_sites\staging\import-{x}\ and put live by POST /api/status/sites/import (sites.pb.js);
#   the backend - the PocketBase project (pb_hooks / pb_migrations / pb_data, in the folder or one level down), run on
#     a free port with an https port Tailscale isn't using on this PC (10000 is left for public ones - Funnel only has
#     443, 8443 and 10000), its admin account (Set-MvSuperuser), Media Vault's hooks (Start-Servers), mediavault.json.
# Only names, who can open each and the backend's admin account are asked. A backend address the site's pages name
# (e.g. CubeWord's SAVE_SERVER) is changed to the new one in the published copy. A backend folder that a PocketBase
# is running from already is offered as a separate copy (backends\{name}\, its own database), since two servers on one
# pb_data can damage it. Changing or removing a backend is in setup.
function Show-Msg([string]$text, $icon = 'Warning') { [Windows.Forms.MessageBox]::Show($text, 'Media Vault', 'OK', $icon) | Out-Null }
# Shows an auto-sized dialog, made to scroll when it's taller than the screen (a laptop at 1280 x 720 can't fit the add
# dialog, and its buttons would end up below the screen's edge).
function Show-FitDialog($dlg) {
  $dlg.Add_Load({
    $wa = [Windows.Forms.Screen]::FromControl($this).WorkingArea
    if ($this.Height -le $wa.Height) { return }
    $w = $this.Width + [Windows.Forms.SystemInformation]::VerticalScrollBarWidth
    $this.AutoSize = $false; $this.AutoScroll = $true; $this.MaximumSize = New-Object Drawing.Size(0, 0)
    $this.Bounds = New-Object Drawing.Rectangle(($wa.X + [Math]::Max(0, ($wa.Width - $w) / 2)), $wa.Y, $w, $wa.Height)
  })
  $dlg.ShowDialog($form)
}
# What a site upload leaves out, as the app's does (SITE_SKIP in app.js, plus hidden files), and server things that
# don't belong on a static site.
$SiteSkip = @('node_modules', '__MACOSX', 'Thumbs.db', 'desktop.ini', 'pb_data', 'pb_hooks', 'pb_migrations')
$SiteSkipExt = @('.exe', '.dll', '.bat', '.cmd', '.ps1')
$SiteMaxFiles = 5000 # (SITE_MAX_FILES in app.js)
function Test-PbFolder([string]$d) { [bool](@('pb_hooks', 'pb_migrations', 'pb_data') | Where-Object { Test-Path -LiteralPath (Join-Path $d $_) -PathType Container }) }
# The PocketBase project in $dir: $dir itself, or its only sub-folder that is one (an unzipped download is often a
# folder in a folder); $null if neither.
function Find-PbFolder([string]$dir) {
  if (Test-PbFolder $dir) { return $dir }
  $subs = @(Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | Where-Object { Test-PbFolder $_.FullName })
  if ($subs.Count -eq 1) { $subs[0].FullName } else { $null }
}
# Folders in the project with an index.html, most likely first.
function Find-SiteFolders([string]$dir, [string]$pb) {
  $c = @($dir) + @('dist', 'build', 'out', '_site', 'public', 'www', 'pb_public' | ForEach-Object { Join-Path $dir $_ })
  if ($pb -and $pb -ne $dir) { $c += Join-Path $pb 'pb_public' }
  $c += @(Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin $SiteSkip -and -not $_.Name.StartsWith('.') } | ForEach-Object { $_.FullName })
  @($c | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'index.html') -PathType Leaf } | Select-Object -Unique)
}
# A site's files, as paths relative to $dir ("css/app.css"); folders in $skip are left out (the backend's own folder
# when it's inside the site's).
function Get-SiteFiles([string]$dir, [string[]]$skip) {
  $out = New-Object Collections.Generic.List[string]
  $walk = {
    param($d, $rel)
    foreach ($i in @(Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)) {
      if ($i.Name -in $SiteSkip -or ($i.Name.StartsWith('.') -and $i.Name -ne '.well-known')) { continue }
      $r = if ($rel) { "$rel/$($i.Name)" } else { $i.Name }
      if ($i.PSIsContainer) { if ($skip -notcontains $i.FullName) { & $walk $i.FullName $r } }
      elseif ($SiteSkipExt -notcontains $i.Extension.ToLowerInvariant()) { $out.Add($r) }
    }
  }
  & $walk $dir ''
  $out
}
# Backend addresses the site's pages name: Tailscale or this-PC addresses with a port that isn't Media Vault's or the
# sites' (e.g. CubeWord's SAVE_SERVER = 'https://{pc}.{tailnet}.ts.net:10000'). @{ address = @(files it's in) }.
function Find-BackendUrls([string]$dir, $files) {
  $found = [ordered]@{}
  $own = @("$VaultPort", "$SitesPort", "$MvVaultHttps", "$MvSitesHttps")
  foreach ($f in @($files | Where-Object { $_ -match '\.(html?|m?js)$' } | Select-Object -First 300)) {
    $p = Join-Path $dir $f
    if ((Get-Item -LiteralPath $p).Length -gt 3MB) { continue }
    foreach ($m in [regex]::Matches([IO.File]::ReadAllText($p), 'https?://(?:[A-Za-z0-9-]+\.)+ts\.net:(\d+)|https?://(?:127\.0\.0\.1|localhost):(\d+)')) {
      $n = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
      if ($own -contains $n) { continue }
      if (-not $found.Contains($m.Value)) { $found[$m.Value] = @() }
      if ($found[$m.Value] -notcontains $f) { $found[$m.Value] += $f }
    }
  }
  $found
}
# An https port no Tailscale address on this PC and no backend uses; 0 if there's none.
function Get-FreeHttpsPort([string]$access, $ts) {
  $used = @($MvVaultHttps, $MvSitesHttps) + @($ts.Entries.Keys) + @($Cfg.backends | ForEach-Object { $_.httpsPort })
  foreach ($h in $(if ($access -eq 'public') { $MvFunnelPorts } else { 10001..10099 })) { if ($used -notcontains $h) { return $h } }
  0
}
function ConvertTo-Slug([string]$text) { $s = ($text.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-'); if ($s.Length -gt 40) { $s = $s.Substring(0, 40).TrimEnd('-') }; $s }
# POST to one of Media Vault's status-window routes (they need the status secret): @{ Code; Data }.
function Invoke-StatusApi([string]$path, $body, [string]$method = 'POST') {
  $req = [Net.HttpWebRequest]::Create("http://127.0.0.1:$VaultPort$path"); $req.Method = $method; $req.ContentType = 'application/json'
  $req.Proxy = $null; $req.Timeout = 120000; $req.Headers.Add('X-Status-Token', $Token)
  if ($method -eq 'POST') {
    $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $body -Compress))
    $rs = $req.GetRequestStream(); $rs.Write($bytes, 0, $bytes.Length); $rs.Close()
  }
  try { $res = $req.GetResponse() } catch [Net.WebException] { $res = $_.Exception.Response; if (-not $res) { throw } }
  $text = (New-Object IO.StreamReader($res.GetResponseStream())).ReadToEnd(); $code = [int]$res.StatusCode; $res.Close()
  @{ Code = $code; Data = $(try { $text | ConvertFrom-Json } catch { $null }) }
}

function Add-Project {
  $fb = New-Object Windows.Forms.FolderBrowserDialog
  $fb.Description = "Choose the project's folder - the site (its index.html) and its backend (pb_hooks / pb_migrations), if it has one"
  if (Test-Path -LiteralPath $ProjectsDir) { $fb.SelectedPath = $ProjectsDir }
  if ($fb.ShowDialog($form) -ne 'OK') { return }
  $picked = $fb.SelectedPath.TrimEnd('\')
  $home_ = $Root.TrimEnd('\')
  if ($picked -eq $home_ -or $home_.StartsWith("$picked\", [StringComparison]::OrdinalIgnoreCase) -or $picked.StartsWith("$home_\pb_", [StringComparison]::OrdinalIgnoreCase)) {
    Show-Msg "That's Media Vault's own folder (or holds it). Pick the project's folder."; return
  }
  if ($picked -eq $ProjectsDir) { Show-Msg "That's the projects folder itself. Pick one project's folder inside it."; return }
  $form.Cursor = 'WaitCursor'
  $pb = Find-PbFolder $picked
  $sites = @(Find-SiteFolders $picked $pb)
  $emptyPb = $false
  if (-not $pb -and -not $sites.Count) {
    $form.Cursor = 'Default'
    $a = [Windows.Forms.MessageBox]::Show("There's no site (index.html) or PocketBase backend (pb_hooks, pb_migrations or pb_data) in that folder.`n`nUse it as a new, empty backend? Media Vault makes the pb_hooks and pb_migrations folders for the site's server code.", 'Media Vault', 'OKCancel', 'Question')
    if ($a -ne 'OK') { return }
    $pb = $picked; $emptyPb = $true; $form.Cursor = 'WaitCursor'
  }
  $ts = Get-MvTailscale
  $tsOk = $ts.Installed -and $ts.State -eq 'Running'
  $taken = @($Servers | ForEach-Object { $_.Port })
  $port = Get-MvFreePort $taken # (skips anything listening, e.g. a copy of this backend already running)

  # The backend: already set up here, running from its folder now (not by Media Vault), what's in it.
  $inCfg = $null; $running = @(); $oldPort = 0; $info = $null; $hasData = $false; $hasExe = $false; $ownExe = ''
  $bkFound = @()
  if ($pb) {
    $inCfg = $Cfg.backends | Where-Object { (Resolve-MvDir $Root $_.dir).TrimEnd('\') -eq $pb } | Select-Object -First 1
    if (-not $inCfg) {
      $running = @(Get-Process pocketbase -ErrorAction SilentlyContinue | Where-Object { $x = ''; try { $x = "$($_.Path)" } catch {}; $x -and (Split-Path $x) -eq $pb })
      foreach ($p in $running) { try { $oldPort = [int](Get-NetTCPConnection -OwningProcess $p.Id -State Listen -ErrorAction Stop | Select-Object -First 1).LocalPort; break } catch {} }
    }
    # (backend.json: one that came in a package made by make-package.ps1.)
    try { $info = [IO.File]::ReadAllText((Join-Path $pb 'backend.json')) | ConvertFrom-Json } catch {}
    $hooks = @(Get-ChildItem -LiteralPath (Join-Path $pb 'pb_hooks') -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin $MvGuardName, $MvFloodName } | ForEach-Object { $_.Name })
    $migs = @(Get-ChildItem -LiteralPath (Join-Path $pb 'pb_migrations') -File -ErrorAction SilentlyContinue).Count
    $hasData = Test-Path -LiteralPath (Join-Path $pb 'pb_data\data.db')
    $ownExe = Join-Path $pb 'pocketbase.exe'; $hasExe = Test-Path -LiteralPath $ownExe
    $bkFound += $(if ($hooks.Count) { "server code (pb_hooks): $($hooks -join ', ')" } else { 'no server code (pb_hooks) yet' })
    if ($migs) { $bkFound += "$migs migration file(s)" }
    $bkFound += $(if ($hasData) { 'its data (pb_data)' } else { 'no data yet' })
    if ($hasExe) { $bkFound += 'its own pocketbase.exe' }
  }
  $bkName = if ($inCfg) { $inCfg.name } elseif ($info -and "$($info.name)".Trim()) { "$($info.name)".Trim() } elseif ($pb) { Get-MvBackendName $pb } else { '' }
  # The site: a name from its <title>.
  $siteName = ''
  if ($sites.Count) {
    try { $m = [regex]::Match([IO.File]::ReadAllText((Join-Path $sites[0] 'index.html')), '<title[^>]*>\s*([^<]{1,100}?)\s*</title>', 'IgnoreCase'); if ($m.Success) { $siteName = [Net.WebUtility]::HtmlDecode($m.Groups[1].Value).Trim() } } catch {}
    if (-not $siteName) { $siteName = Split-Path -Leaf $picked }
  }
  $form.Cursor = 'Default'

  # ----- the dialog -----
  $dlg = New-Object Windows.Forms.Form; $dlg.Text = 'Add a site or backend'; $dlg.Font = $Font; $dlg.ForeColor = $Ink
  $dlg.FormBorderStyle = 'FixedDialog'; $dlg.MaximizeBox = $false; $dlg.MinimizeBox = $false; $dlg.StartPosition = 'CenterParent'; $dlg.ShowInTaskbar = $false
  $dlg.AutoSize = $true; $dlg.AutoSizeMode = 'GrowAndShrink'; $dlg.BackColor = [Drawing.Color]::White
  $f = New-Object Windows.Forms.TableLayoutPanel; $f.AutoSize = $true; $f.ColumnCount = 2; $f.Padding = New-Object Windows.Forms.Padding(20, 16, 20, 14)
  $dlg.Controls.Add($f)
  function Row([string]$label, $ctl) {
    $l = New-Object Windows.Forms.Label; $l.Text = $label; $l.AutoSize = $true; $l.Margin = New-Object Windows.Forms.Padding(0, 7, 12, 0)
    $ctl.Margin = New-Object Windows.Forms.Padding(0, 3, 0, 3); $f.Controls.Add($l); $f.Controls.Add($ctl)
  }
  function Wide($ctl, [int]$top = 0) { $ctl.Margin = New-Object Windows.Forms.Padding(0, $top, 0, 4); $f.Controls.Add($ctl); $f.SetColumnSpan($ctl, 2); $ctl }
  function New-Text([string]$text, $color, $lf = $null) {
    $l = New-Object Windows.Forms.Label; $l.Text = $text; $l.AutoSize = $true; $l.MaximumSize = New-Object Drawing.Size(560, 0); $l.ForeColor = $color
    if ($lf) { $l.Font = $lf }; $l
  }
  function New-Box([int]$w = 340, [switch]$Secret) { $t = New-Object Windows.Forms.TextBox; $t.Width = $w; $t.UseSystemPasswordChar = [bool]$Secret; $t }
  # A tick box whose text wraps at the dialog's width (an auto-sized one stays on one line and runs off the edge).
  function New-Check {
    $c = New-Object Windows.Forms.CheckBox; $c.AutoSize = $false; $c.Width = 560; $c.CheckAlign = 'TopLeft'; $c.TextAlign = 'TopLeft'
    $fit = { $this.Height = [Windows.Forms.TextRenderer]::MeasureText($this.Text, $this.Font, (New-Object Drawing.Size(($this.Width - 22), 0)), 'WordBreak').Height + 4 }
    $c.Add_TextChanged($fit); $c.Add_FontChanged($fit); $c
  }
  function New-Pick([string[]]$items, [int]$w = 340) { $c = New-Object Windows.Forms.ComboBox; $c.DropDownStyle = 'DropDownList'; $c.Width = $w; [void]$c.Items.AddRange($items); $c.SelectedIndex = 0; $c }
  [void](Wide (New-Text $picked $Grey))
  # Moving it into projects\ (optional, for keeping projects together): only a folder outside Media Vault's, on the same
  # drive (a rename, so nothing is half-copied), that no server - Media Vault's or another - runs from.
  $moveTo = ''
  $cbMove = New-Check
  if (-not $inCfg -and -not $running.Count -and -not $picked.StartsWith("$home_\", [StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetPathRoot($picked) -eq [IO.Path]::GetPathRoot($ProjectsDir)) {
    $leaf = Split-Path -Leaf $picked; $moveTo = Join-Path $ProjectsDir $leaf; $i = 2
    while (Test-Path -LiteralPath $moveTo) { $moveTo = Join-Path $ProjectsDir "$leaf-$i"; $i++ }
    $cbMove.Text = "Move it into Media Vault's projects folder (projects\$(Split-Path -Leaf $moveTo))"
    [void](Wide $cbMove 2)
  }

  # Site
  $cbSite = New-Object Windows.Forms.CheckBox; $cbSite.AutoSize = $true; $cbSite.Font = $HeadFont; $cbSite.Text = 'Publish the site'; $cbSite.Checked = $sites.Count -gt 0
  $siteCtls = @()
  if ($sites.Count) {
    [void](Wide $cbSite 4)
    $cSite = New-Pick @($sites | ForEach-Object { if ($_ -eq $picked) { 'index.html at the top of the folder' } else { "index.html in $($_.Substring($picked.Length + 1))" } })
    Row 'Site files' $cSite
    $siteCount = Wide (New-Text '' $Grey)
    $tSite = New-Box; $tSite.Text = $siteName; Row 'Name' $tSite
    $tSlug = New-Box; $tSlug.Text = ConvertTo-Slug $siteName; Row 'Address' $tSlug
    $slugHint = Wide (New-Text '' $Grey)
    $SiteAccessKeys = @('public', 'password', 'private')
    $cSiteAccess = New-Pick @('Public - anyone with the link', 'Password - visitors type a password once', 'Only me - opened from Media Vault > Sites')
    Row 'Who can open it' $cSiteAccess
    $tSitePass = New-Box; Row 'Password' $tSitePass
    $cbPoint = New-Check; [void](Wide $cbPoint 4)
    $siteCtls = @($cSite, $tSite, $tSlug, $cSiteAccess, $tSitePass, $cbPoint)
  }

  # Backend
  $bkModes = @(); $bkLabels = @()
  if ($pb) {
    if ($inCfg) {
      $bkModes += 'existing'; $at = if ($inCfg.access -ne 'off' -and $ts.Dns) { "https://$($ts.Dns):$($inCfg.httpsPort)" } else { "http://127.0.0.1:$($inCfg.port)" }
      $bkLabels += "Use $($inCfg.name), already set up ($at)"
    } else {
      $bkModes += 'here'; $bkLabels += $(if ($running.Count) { 'Add it from this folder - shares the running copy''s database (not recommended)' } else { 'Add it, running from this folder' })
    }
    if (-not $emptyPb) { $bkModes += 'copy'; $bkLabels += 'Add a separate copy - its code copied to backends\, its own empty database' }
  }
  if ($sites.Count) { $bkModes += 'none'; $bkLabels += 'No backend - just the site' }
  $AccessKeys = @('public', 'tailnet', 'off')
  $bkCtls = @()
  if ($pb) {
    [void](Wide (New-Text 'Backend' $Ink $HeadFont) 14)
    [void](Wide (New-Text ('Found: ' + ($bkFound -join '; ')) $Grey))
    $warnRun = Wide (New-Text "A PocketBase is running from this folder now$(if ($oldPort) { " (port $oldPort)" }) - not started by Media Vault. Running a second server on the same pb_data can damage its database, so add a separate copy, or stop the other one first. The running one is left alone either way." $Amber)
    $warnRun.Visible = $running.Count -gt 0
    $cBk = New-Pick $bkLabels 420; Row 'Backend' $cBk
    $cBk.SelectedIndex = [array]::IndexOf($bkModes, $(if ($inCfg) { 'existing' } elseif ($running.Count) { 'copy' } else { 'here' }))
    $tName = New-Box; $tName.Text = $bkName; Row 'Name' $tName
    $cAccess = New-Pick @('Public - anyone on the internet (a game anyone can play)', 'Tailnet only - just your devices on Tailscale', 'This PC only - no https:// address')
    $access = if (-not $tsOk) { 'off' } elseif ($info -and "$($info.access)" -in $AccessKeys) { "$($info.access)" } else { 'tailnet' }
    $cAccess.SelectedIndex = [array]::IndexOf($AccessKeys, $access)
    Row 'Who can reach it' $cAccess
    $hint = Wide (New-Text '' $Grey)
    $cbAdmin = New-Check; $cbAdmin.Checked = -not $hasData
    $cbAdmin.Text = 'Set its admin account (create one, or change the password of one) - untick to keep the one it has'
    [void](Wide (New-Text "Its admin account - for its own dashboard, http://127.0.0.1:$port/_/ on this PC (separate from Media Vault's):" $Ink) 8)
    if ($hasData) { [void](Wide $cbAdmin) }
    $tEmail = New-Box; $tPass = New-Box -Secret; $tPass2 = New-Box -Secret
    Row 'Email' $tEmail; Row 'Password' $tPass; Row 'Password again' $tPass2
    [void](Wide (New-Text "At least 10 characters. Its server code runs on this PC with your Windows account's rights - only add a backend you trust." $Grey))
    $bkCtls = @($tName, $cAccess, $cbAdmin, $tEmail, $tPass, $tPass2)
  }
  $btns = New-Object Windows.Forms.FlowLayoutPanel; $btns.AutoSize = $true; $btns.FlowDirection = 'RightToLeft'; $btns.Dock = 'Fill'
  $ok = New-Object Windows.Forms.Button; $ok.Text = 'Add'; $ok.MinimumSize = New-Object Drawing.Size(88, 28); $ok.Margin = New-Object Windows.Forms.Padding(8, 14, 0, 0)
  $cancel = New-Object Windows.Forms.Button; $cancel.Text = 'Cancel'; $cancel.DialogResult = 'Cancel'; $cancel.MinimumSize = New-Object Drawing.Size(88, 28); $cancel.Margin = New-Object Windows.Forms.Padding(0, 14, 0, 0)
  $btns.Controls.AddRange(@($ok, $cancel)); [void](Wide $btns)
  $dlg.AcceptButton = $ok; $dlg.CancelButton = $cancel

  # ----- keeping it in step -----
  $httpsFor = { param($k) Get-FreeHttpsPort $k $ts }
  $modeNow = { if ($pb) { $bkModes[$cBk.SelectedIndex] } else { 'none' } }
  # Where the site will find its backend.
  $bkAddr = {
    switch (& $modeNow) {
      'existing' { if ($inCfg.access -ne 'off' -and $ts.Dns) { "https://$($ts.Dns):$($inCfg.httpsPort)" } else { "http://127.0.0.1:$($inCfg.port)" } }
      'none' { '' }
      default { $k = $AccessKeys[$cAccess.SelectedIndex]; $h = & $httpsFor $k; if ($k -ne 'off' -and $h) { "https://$($ts.Dns):$h" } else { "http://127.0.0.1:$port" } }
    }
  }
  $siteState = @{ Dir = ''; Files = @(); Urls = [ordered]@{} }
  $sync = {
    $mode = & $modeNow; $new = $mode -in 'here', 'copy'
    if ($pb) {
      foreach ($c in $bkCtls) { $c.Enabled = $new }
      if ($mode -eq 'copy') { $cbAdmin.Checked = $true; $cbAdmin.Enabled = $false }
      foreach ($c in $tEmail, $tPass, $tPass2) { $c.Enabled = $new -and $cbAdmin.Checked }
      $k = $AccessKeys[$cAccess.SelectedIndex]; $h = & $httpsFor $k
      $hint.ForeColor = if ($new -and $k -ne 'off' -and -not $h) { $Red } else { $Grey }
      $hint.Text = if (-not $new) { '' }
        elseif ($k -ne 'off' -and -not $h) { 'Tailscale Funnel can only publish ports 443, 8443 and 10000, and they are all in use on this PC. Choose Tailnet only, or free port 10000 in Setup.' }
        elseif ($k -eq 'public') { "At https://$($ts.Dns):$h/ - anyone on the internet can reach it. Its admin dashboard and superuser sign-in are blocked there, and each visitor gets at most 300 requests per 10 seconds; its own API rules protect the rest." }
        elseif ($k -eq 'tailnet') { "At https://$($ts.Dns):$h/ - only your devices on Tailscale can reach it." }
        elseif ($tsOk) { "Only programs on this PC can reach it (http://127.0.0.1:$port/), so a site's visitors can't." }
        else { "Tailscale isn't connected, so only this PC can reach it for now (http://127.0.0.1:$port/). Once it's connected, give it an https:// address in Setup." }
    }
    if ($sites.Count) {
      foreach ($c in $siteCtls) { $c.Enabled = $cbSite.Checked }
      $tSitePass.Enabled = $cbSite.Checked -and $SiteAccessKeys[$cSiteAccess.SelectedIndex] -eq 'password'
      $slug = $tSlug.Text.Trim().ToLowerInvariant()
      $slugHint.Text = if ($script:LastTs -and $script:LastTs.Dns -and $script:LastTs.ServeSites) { "https://$($script:LastTs.Dns)/$slug/" } else { "http://<this PC>:$SitesPort/$slug/" }
      $target = & $bkAddr
      $urls = @($siteState.Urls.Keys | Where-Object { $_ -ne $target })
      $cbPoint.Enabled = $cbSite.Checked -and $target -and $urls.Count
      if (-not $cbPoint.Enabled) { $cbPoint.Checked = $false }
      $cbPoint.Text = if (-not $target) { "The site won't be pointed at a backend." }
        elseif (-not $urls.Count) { "Its pages don't name a backend address - if it needs one, put $target into the site." }
        else { "Point it at the backend: change $($urls -join ', ') to $target (in $(@($urls | ForEach-Object { $siteState.Urls[$_] } | Select-Object -Unique) -join ', '))" }
    }
  }
  $loadSite = {
    $d = $sites[$cSite.SelectedIndex]; $skip = @()
    if ($pb -and $pb -ne $d -and $pb.StartsWith("$d\", [StringComparison]::OrdinalIgnoreCase)) { $skip += $pb }
    if ($pb -eq $d) { $skip += (Join-Path $d 'pb_public') } # (the backend's own public folder)
    $dlg.Cursor = 'WaitCursor'
    $siteState.Dir = $d; $siteState.Files = @(Get-SiteFiles $d $skip); $siteState.Urls = Find-BackendUrls $d $siteState.Files
    $dlg.Cursor = 'Default'
    $siteCount.Text = "$($siteState.Files.Count) file(s) from $d"
    $cbPoint.Checked = $siteState.Urls.Count -gt 0
    & $sync
  }
  if ($pb) { $cBk.Add_SelectedIndexChanged($sync); $cAccess.Add_SelectedIndexChanged($sync); $cbAdmin.Add_CheckedChanged($sync) }
  if ($sites.Count) { $cSite.Add_SelectedIndexChanged($loadSite); $cbSite.Add_CheckedChanged($sync); $cSiteAccess.Add_SelectedIndexChanged($sync); $tSlug.Add_TextChanged($sync); & $loadSite }
  & $sync

  $ok.Add_Click({
    $mode = & $modeNow; $new = $mode -in 'here', 'copy'
    if (-not $new -and -not $cbSite.Checked) { Show-Msg 'There is nothing to add - tick "Publish the site", or choose a backend.'; return }
    if ($cbSite.Checked) {
      $slug = $tSlug.Text.Trim().ToLowerInvariant()
      if (-not $tSite.Text.Trim()) { Show-Msg 'Give the site a name.'; return }
      if ($slug -notmatch '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$') { Show-Msg "The site's address uses lowercase letters, numbers and dashes (up to 40), and can't start or end with a dash."; return }
      if ($slug -in 'api', 's') { Show-Msg 'That address is reserved. Pick another.'; return }
      if ($SiteAccessKeys[$cSiteAccess.SelectedIndex] -eq 'password' -and -not $tSitePass.Text) { Show-Msg 'Choose a password for the site.'; return }
      if (-not $siteState.Files.Count) { Show-Msg 'There are no files to publish in that folder.'; return }
      if ($siteState.Files.Count -gt $SiteMaxFiles) { Show-Msg "That's $($siteState.Files.Count) files; a site can have up to $SiteMaxFiles. Pick just the built site (its dist folder, for example)."; return }
      $up = $false; try { $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$VaultPort/api/health").StatusCode -eq 200 } catch {}
      if (-not $up) { Show-Msg 'Media Vault needs to be running to publish the site - press Start, then try again.'; return }
    }
    if ($new) {
      $n = $tName.Text.Trim(); $k = $AccessKeys[$cAccess.SelectedIndex]
      if (-not $n) { Show-Msg 'Give the backend a name.'; return }
      if ($n -in 'Media Vault', 'Sites', 'Setup' -or ($Cfg.backends | Where-Object { $_.name -eq $n })) { Show-Msg "There's already a server called $n. Give this one another name."; return }
      if ($k -ne 'off' -and -not (& $httpsFor $k)) { Show-Msg 'There is no free https port for the backend. Choose another option.'; return }
      if ($cbAdmin.Checked) {
        if ($tEmail.Text.Trim() -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { Show-Msg 'Enter an email address for its admin account.'; return }
        if ($tPass.Text.Length -lt 10) { Show-Msg 'The admin password needs at least 10 characters.'; return }
        if ($tPass.Text -ne $tPass2.Text) { Show-Msg "The two passwords don't match."; return }
        if ($tPass.Text.Contains('"')) { Show-Msg "The admin password can't contain a double quote (`")."; return }
      }
      if ($mode -eq 'here' -and $running.Count) {
        $a = [Windows.Forms.MessageBox]::Show("A PocketBase is running from that folder already. Running a second one on the same data can damage its database.`n`nAdd it from this folder anyway?", 'Media Vault', 'YesNo', 'Warning')
        if ($a -ne 'Yes') { return }
      }
    }
    $dlg.DialogResult = 'OK'
  })
  Set-ButtonLook $ok 'primary'; Set-Looks $dlg
  if ((Show-FitDialog $dlg) -ne 'OK') { return }

  # ----- doing it -----
  $mode = & $modeNow; $done = @(); $target = & $bkAddr; $siteUrl = ''
  if ($cbMove.Checked) {
    try {
      New-Item -ItemType Directory -Force $ProjectsDir | Out-Null
      Move-Item -LiteralPath $picked -Destination $moveTo -ErrorAction Stop
    } catch { Show-Msg "Couldn't move $picked into the projects folder - $($_.Exception.Message)`n`nIf it's open in another program (an editor, File Explorer), close it and try again. Nothing was added."; return }
    $moved = { param($p) if ($p -and $p.StartsWith($picked, [StringComparison]::OrdinalIgnoreCase)) { $moveTo + $p.Substring($picked.Length) } else { $p } }
    $pb = & $moved $pb; $ownExe = & $moved $ownExe; $siteState.Dir = & $moved $siteState.Dir; $picked = $moveTo
    $done += "Moved the project to $moveTo"
  }
  if ($mode -in 'here', 'copy') {
    $name = $tName.Text.Trim(); $k = $AccessKeys[$cAccess.SelectedIndex]
    $h = if ($k -ne 'off') { & $httpsFor $k } else { 0 }
    # A pocketbase.exe Media Vault didn't download only runs after a yes (remembered by its checksum, as in setup).
    $sha = ''
    if ($hasExe) {
      $sha = Get-MvFileHash $ownExe
      if ($sha -eq $MvPbSha256) { $sha = '' }
      else {
        $a = [Windows.Forms.MessageBox]::Show("The backend has its own pocketbase.exe, and it isn't the PocketBase $MvPbVersion that Media Vault downloads and checks:`n`n  $ownExe`n`nRun it, with your Windows account's rights? Only if you put it there yourself (e.g. a PocketBase version the backend needs). Otherwise choose No, delete that file and add it again - it then runs on Media Vault's own copy.`n`nIf the file changes later, Media Vault won't start it until you approve it again in Setup.", 'Media Vault', 'YesNo', 'Warning')
        if ($a -ne 'Yes') { return }
      }
    }
    $form.Cursor = 'WaitCursor'
    $before = $Cfg.backends; $bdir = $pb
    try {
      if ($mode -eq 'copy') {
        # Its code only (as make-package.ps1 copies it): a database of its own starts empty.
        $slug = ConvertTo-Slug $name; if (-not $slug) { $slug = 'backend' }
        $bdir = Join-Path $Root "backends\$slug"; $i = 2
        while (Test-Path -LiteralPath $bdir) { $bdir = Join-Path $Root "backends\$slug-$i"; $i++ }
        New-Item -ItemType Directory -Force $bdir | Out-Null
        foreach ($d in 'pb_hooks', 'pb_migrations', 'pb_public') { if (Test-Path -LiteralPath (Join-Path $pb $d)) { Copy-Item -LiteralPath (Join-Path $pb $d) -Destination (Join-Path $bdir $d) -Recurse -Force } }
        foreach ($x in $MvGuardName, $MvFloodName) { Remove-Item -LiteralPath (Join-Path $bdir "pb_hooks\$x") -Force -ErrorAction SilentlyContinue }
        if ($hasExe) { Copy-Item -LiteralPath $ownExe -Destination $bdir }
      }
      if ($emptyPb) { foreach ($d in 'pb_hooks', 'pb_migrations') { New-Item -ItemType Directory -Force (Join-Path $bdir $d) | Out-Null } }
      # (Before the first start, so a new backend doesn't open PocketBase's "create an admin" page in the browser.)
      if ($cbAdmin.Checked) {
        $res = Set-MvSuperuser $(if ($hasExe) { Join-Path $bdir 'pocketbase.exe' } else { Join-Path $Root 'pocketbase.exe' }) (Join-Path $bdir 'pb_data') $tEmail.Text.Trim() $tPass.Text
        if (-not $res.Ok) { throw "couldn't set up its admin account: $($res.Out)" }
      }
      # Kept relative when it's inside this folder (e.g. backends\{name}), so it moves along with Media Vault.
      $rel = if ($bdir.StartsWith("$home_\", [StringComparison]::OrdinalIgnoreCase)) { $bdir.Substring($home_.Length + 1) } else { $bdir }
      $Cfg.backends = @($Cfg.backends) + @(@{ name = $name; dir = $rel; port = $port; httpsPort = $h; access = $k; exeSha256 = $sha })
      Save-MvConfig $Root $Cfg
    } catch {
      $Cfg.backends = $before; $form.Cursor = 'Default'
      Show-Msg "Couldn't add $name - $($_.Exception.Message)"; return
    }
    # Into this window's list (the last server is the new one), then started with Media Vault's hooks.
    $s = @(Get-MvServers $Root $Cfg)[-1]
    $script:Servers += @($s); $script:Backends += @($s)
    foreach ($pair in @(@($s.Name, "$($s.Log).log"), @("$($s.Name) errors", "$($s.Log).err.log"))) {
      $LogFiles.Insert($LogFiles.Count - 1, $pair[0], $pair[1]); $logPick.Items.Insert($logPick.Items.Count - 1, $pair[0])
    }
    try { Start-Servers } catch {} # (only complains about Media Vault or the sites server)
    $form.Cursor = 'Default'
    Update-Settings; Request-Refresh -Full
    if ($s.Error) { $done += "$name is added, but it couldn't start: $($s.Error) (its log is on the Logs page)." }
    else {
      $to = "http://127.0.0.1:$port"
      $steps = @(switch ($k) {
        'public' { @{ A = "funnel --bg --https=$h $to"; Must = $true } }
        'tailnet' { @{ A = "funnel --https=$h off"; Must = $false }; @{ A = "serve --bg --https=$h $to"; Must = $true } }
      })
      if ($steps.Count -and -not (Invoke-TsSteps $steps)) {
        $done += "$name is added and running on this PC ($to/), but its https:// address isn't set up yet (see the message before this one) - Setup... tries again."
      } else { $done += "$name is running: $target/  (admin dashboard on this PC: http://127.0.0.1:$port/_/)" }
    }
  } elseif ($mode -eq 'existing') { $done += "Backend: $($inCfg.name) at $target/" }

  if ($cbSite.Checked) {
    $form.Cursor = 'WaitCursor'
    $stage = 'import-' + -join (1..12 | ForEach-Object { 'abcdefghijklmnopqrstuvwxyz0123456789'[(Get-Random -Maximum 36)] })
    $sdir = Join-Path $Root "pb_sites\staging\$stage"
    try {
      $i = 0
      foreach ($rel in $siteState.Files) {
        $dest = Join-Path $sdir ($rel -replace '/', '\')
        [void][IO.Directory]::CreateDirectory((Split-Path $dest))
        [IO.File]::Copy((Join-Path $siteState.Dir ($rel -replace '/', '\')), $dest, $true)
        if ((++$i % 50) -eq 0) { [Windows.Forms.Application]::DoEvents() }
      }
      # The published copy is pointed at the backend; the project's own files stay as they are.
      if ($cbPoint.Checked -and $target) {
        $utf8 = New-Object Text.UTF8Encoding($false)
        foreach ($u in @($siteState.Urls.Keys | Where-Object { $_ -ne $target })) {
          foreach ($rel in $siteState.Urls[$u]) {
            $p = Join-Path $sdir ($rel -replace '/', '\')
            [IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p).Replace($u, $target), $utf8)
          }
        }
      }
      $body = @{ staging = $stage; name = $tSite.Text.Trim(); slug = $tSlug.Text.Trim().ToLowerInvariant(); access = $SiteAccessKeys[$cSiteAccess.SelectedIndex]; password = $tSitePass.Text; replace = $false
                mirror = -not $siteState.Dir.StartsWith("$ProjectsDir\", [StringComparison]::OrdinalIgnoreCase) } # (a project in projects\ is its own copy)
      $r = Invoke-StatusApi '/api/status/sites/import' $body
      if ($r.Code -eq 409) {
        $form.Cursor = 'Default'
        $a = [Windows.Forms.MessageBox]::Show("There's already a site at /$($body.slug)/ (`"$($r.Data.exists)`").`n`nReplace its files with these?", 'Media Vault', 'YesNo', 'Question')
        if ($a -ne 'Yes') { throw 'it was left as it is (that address is taken)' }
        $form.Cursor = 'WaitCursor'; $body.replace = $true
        $r = Invoke-StatusApi '/api/status/sites/import' $body
      }
      if ($r.Code -ne 200) { throw $(if ($r.Data -and $r.Data.message) { $r.Data.message } else { "Media Vault answered $($r.Code)" }) }
      $siteUrl = if ($r.Data.https) { "https://$($r.Data.https.host)/$($r.Data.slug)/" } else { "http://localhost:$($r.Data.port)/$($r.Data.slug)/" }
      $done += "The site `"$($r.Data.name)`" is live: $siteUrl" + $(if ($r.Data.access -eq 'private') { ' (only you - open it from Media Vault > Sites)' } elseif ($r.Data.access -eq 'password') { ' (password)' } else { '' }) +
        $(if ($r.Data.copy) { "`n(A copy is in $($r.Data.copy -replace '/', '\'), with your other sites.)" } else { '' })
    } catch {
      $done += "The site wasn't published: $($_.Exception.Message)"
    } finally {
      Remove-Item -LiteralPath $sdir -Recurse -Force -ErrorAction SilentlyContinue
      $form.Cursor = 'Default'
    }
    Request-Refresh -Full
  }

  $text = ($done -join "`n`n")
  if ($siteUrl -and $r.Data.access -eq 'public') {
    $a = [Windows.Forms.MessageBox]::Show("$text`n`nOpen the site?", 'Media Vault', 'YesNo', 'Information')
    if ($a -eq 'Yes') { Open-Target $siteUrl }
  } else { Show-Msg $text 'Information' }
}

# ---------- removing sites and backends (Settings > Sites with a backend) ----------
# "Remove a site or backend...": a ticked list of the backends (mediavault.json) and the sites (GET /api/status/sites,
# when Media Vault is running). A site is linked to the backends whose address its pages name (Find-BackendUrls on its
# live files), so ticking one ticks the other. Removing a site deletes it and its files (DELETE /api/status/sites/{slug});
# removing a backend stops it, turns off its Tailscale address, takes Media Vault's hooks out of its pb_hooks and takes
# it off the list - its folder and data stay, unless it's a copy Media Vault made in backends\ and that's asked for.
function Remove-Project {
  $form.Cursor = 'WaitCursor'
  $siteList = @(); $sitesOk = $false
  try { $r = Invoke-StatusApi '/api/status/sites' $null 'GET'; if ($r.Code -eq 200) { $siteList = @($r.Data.sites); $sitesOk = $true } } catch {}
  $ts = Get-MvTailscale
  $bks = @($Cfg.backends)
  # Which backends each site calls: ts.net addresses by https port, this-PC ones by local port.
  $links = @{}
  foreach ($st in $siteList) {
    $d = Join-Path $Root "pb_sites\www\$($st.slug)"
    $urls = if (Test-Path -LiteralPath $d) { Find-BackendUrls $d @(Get-SiteFiles $d @()) } else { @{} }
    $links[$st.slug] = @($bks | Where-Object { $b = $_; @($urls.Keys | Where-Object {
      ($_ -match 'ts\.net:(\d+)$' -and $b.access -ne 'off' -and [int]$Matches[1] -eq $b.httpsPort) -or ($_ -match '(127\.0\.0\.1|localhost):(\d+)$' -and [int]$Matches[2] -eq $b.port) }).Count })
  }
  $form.Cursor = 'Default'
  if (-not $bks.Count -and -not $siteList.Count) { Show-Msg $(if ($sitesOk) { 'There are no sites or backends to remove.' } else { 'There are no backends to remove. (Start Media Vault to remove sites too.)' }) 'Information'; return }

  $dlg = New-Object Windows.Forms.Form; $dlg.Text = 'Remove a site or backend'; $dlg.Font = $Font; $dlg.ForeColor = $Ink
  $dlg.FormBorderStyle = 'FixedDialog'; $dlg.MaximizeBox = $false; $dlg.MinimizeBox = $false; $dlg.StartPosition = 'CenterParent'; $dlg.ShowInTaskbar = $false
  $dlg.AutoSize = $true; $dlg.AutoSizeMode = 'GrowAndShrink'; $dlg.BackColor = [Drawing.Color]::White
  $f = New-Object Windows.Forms.FlowLayoutPanel; $f.FlowDirection = 'TopDown'; $f.WrapContents = $false; $f.AutoSize = $true; $f.Padding = New-Object Windows.Forms.Padding(20, 16, 20, 14)
  $dlg.Controls.Add($f)
  function New-Text([string]$text, $color) { $l = New-Object Windows.Forms.Label; $l.Text = $text; $l.AutoSize = $true; $l.MaximumSize = New-Object Drawing.Size(600, 0); $l.ForeColor = $color; $l.Margin = New-Object Windows.Forms.Padding(0, 0, 0, 8); $f.Controls.Add($l); $l }
  [void](New-Text 'Tick what to remove. A site and the backend it calls are ticked together (untick either one to keep it).' $Ink)
  if (-not $sitesOk) { [void](New-Text 'Media Vault isn''t running, so only backends are listed - press Start to remove sites too.' $Amber) }
  $list = New-Object Windows.Forms.CheckedListBox; $list.CheckOnClick = $true; $list.Width = 600; $list.BorderStyle = 'FixedSingle'
  $list.IntegralHeight = $false; $list.Height = [math]::Min(300, 24 * ($bks.Count + $siteList.Count) + 8)
  $items = @() # @{ Kind = 'site' | 'backend'; It }, in list order
  foreach ($st in $siteList) {
    $uses = @($links[$st.slug] | ForEach-Object { $_.name })
    [void]$list.Items.Add("Site: $($st.name)  -  /$($st.slug)/" + $(if ($uses.Count) { "  -  calls $($uses -join ', ')" } else { '' }))
    $items += @{ Kind = 'site'; It = $st }
  }
  foreach ($b in $bks) {
    $at = if ($b.access -ne 'off' -and $ts.Dns) { "https://$($ts.Dns):$($b.httpsPort)" } else { "http://127.0.0.1:$($b.port)" }
    [void]$list.Items.Add("Backend: $($b.name)  -  $at  -  $(Resolve-MvDir $Root $b.dir)")
    $items += @{ Kind = 'backend'; It = $b }
  }
  $list.Margin = New-Object Windows.Forms.Padding(0, 0, 0, 8); $f.Controls.Add($list)
  $cbFolder = New-Object Windows.Forms.CheckBox; $cbFolder.AutoSize = $true; $cbFolder.Enabled = $false; $cbFolder.Margin = New-Object Windows.Forms.Padding(0, 0, 0, 6)
  $cbFolder.Text = 'Also delete the folders of backend copies Media Vault made (in backends\) - with their data'
  $f.Controls.Add($cbFolder)
  [void](New-Text "Removing a site deletes it and its files from the sites server (your project folder isn't touched). A backend in a folder of your own is stopped and taken off the list; its files and data stay." $Grey)
  $btns = New-Object Windows.Forms.FlowLayoutPanel; $btns.AutoSize = $true; $btns.FlowDirection = 'RightToLeft'; $btns.MinimumSize = New-Object Drawing.Size(600, 0)
  $ok = New-Object Windows.Forms.Button; $ok.Text = 'Remove'; $ok.MinimumSize = New-Object Drawing.Size(88, 28); $ok.Margin = New-Object Windows.Forms.Padding(8, 8, 0, 0); $ok.Enabled = $false
  $cancel = New-Object Windows.Forms.Button; $cancel.Text = 'Cancel'; $cancel.DialogResult = 'Cancel'; $cancel.MinimumSize = New-Object Drawing.Size(88, 28); $cancel.Margin = New-Object Windows.Forms.Padding(0, 8, 0, 0)
  $btns.Controls.AddRange(@($ok, $cancel)); $f.Controls.Add($btns)
  $dlg.AcceptButton = $ok; $dlg.CancelButton = $cancel

  # Ticking a site ticks the backends it calls (when no other site calls them); ticking a backend ticks the sites
  # that call it. Unticking is left as it is.
  $guard = @{ On = $false }
  $isCopy = { param($b) (Resolve-MvDir $Root $b.dir).StartsWith((Join-Path $Root 'backends\'), [StringComparison]::OrdinalIgnoreCase) }
  $list.Add_ItemCheck({
    $i = $_.Index; $on = "$($_.NewValue)" -eq 'Checked'
    if (-not $guard.On -and $on) {
      $guard.On = $true
      try {
        $x = $items[$i]
        for ($j = 0; $j -lt $items.Count; $j++) {
          if ($j -eq $i -or $list.GetItemChecked($j)) { continue }
          $y = $items[$j]
          if ($x.Kind -eq 'site' -and $y.Kind -eq 'backend' -and ($links[$x.It.slug] -contains $y.It)) {
            $others = @($siteList | Where-Object { $_.slug -ne $x.It.slug -and ($links[$_.slug] -contains $y.It) })
            if (-not $others.Count) { $list.SetItemChecked($j, $true) }
          } elseif ($x.Kind -eq 'backend' -and $y.Kind -eq 'site' -and ($links[$y.It.slug] -contains $x.It)) { $list.SetItemChecked($j, $true) }
        }
      } finally { $guard.On = $false }
    }
    # (ItemCheck comes before the change, so work out what will be ticked.)
    $ticked = @(for ($j = 0; $j -lt $items.Count; $j++) { if ($(if ($j -eq $i) { $on } else { $list.GetItemChecked($j) })) { $items[$j] } })
    $ok.Enabled = $ticked.Count -gt 0
    $cbFolder.Enabled = @($ticked | Where-Object { $_.Kind -eq 'backend' -and (& $isCopy $_.It) }).Count -gt 0
    if (-not $cbFolder.Enabled) { $cbFolder.Checked = $false }
  })
  $ok.Add_Click({ $dlg.DialogResult = 'OK' })
  Set-ButtonLook $ok 'primary'; Set-Looks $dlg
  if ((Show-FitDialog $dlg) -ne 'OK') { return }
  $pick = @(foreach ($j in $list.CheckedIndices) { $items[$j] })
  $delFolders = $cbFolder.Checked
  $sitesGo = @($pick | Where-Object { $_.Kind -eq 'site' } | ForEach-Object { $_.It })
  $bksGo = @($pick | Where-Object { $_.Kind -eq 'backend' } | ForEach-Object { $_.It })
  $what = @($sitesGo | ForEach-Object { "the site $($_.name) (/$($_.slug)/) and its files" }) +
          @($bksGo | ForEach-Object { "the backend $($_.name)" + $(if ($delFolders -and (& $isCopy $_)) { ', with its folder and data' } else { ' (its folder stays)' }) })
  $a = [Windows.Forms.MessageBox]::Show("Remove:`n`n  $($what -join "`n  ")`n`nThis can't be undone.", 'Media Vault', 'YesNo', 'Warning')
  if ($a -ne 'Yes') { return }

  $form.Cursor = 'WaitCursor'
  $done = @(); $steps = @()
  foreach ($st in $sitesGo) {
    try {
      $r = Invoke-StatusApi "/api/status/sites/$($st.slug)" $null 'DELETE'
      if ($r.Code -ne 204) { throw $(if ($r.Data -and $r.Data.message) { $r.Data.message } else { "Media Vault answered $($r.Code)" }) }
      $done += "Removed the site $($st.name)."
    } catch { $done += "Couldn't remove the site $($st.name): $($_.Exception.Message)" }
  }
  foreach ($b in $bksGo) {
    $dir = Resolve-MvDir $Root $b.dir
    $srv = $Servers | Where-Object { $_.Kind -eq 'backend' -and $_.Port -eq $b.port } | Select-Object -First 1
    # Stopped only if it's the one Media Vault runs (its pocketbase.exe), never another program on that port.
    $id = Get-ListenPid $b.port
    if ($id -and $srv) {
      $p = Get-Process -Id $id -ErrorAction SilentlyContinue
      $path = ''; try { $path = "$($p.Path)" } catch {}
      if ($p -and $p.ProcessName -eq 'pocketbase' -and $path -eq $srv.Exe) { [void](Stop-MvPort $b.port) }
    }
    # Its Tailscale address, if it still goes to this backend.
    $e = if ($b.httpsPort) { $ts.Entries[$b.httpsPort] } else { $null }
    if ($e -and $e.Port -eq $b.port) { $steps += @(@{ A = "funnel --https=$($b.httpsPort) off"; Must = $false }, @{ A = "serve --https=$($b.httpsPort) off"; Must = $false }) }
    try { if (Test-Path -LiteralPath $dir) { Set-MvBackendGuard $dir 'off' } } catch {}
    $Cfg.backends = @($Cfg.backends | Where-Object { -not [object]::ReferenceEquals($_, $b) })
    if ($srv) {
      $script:Servers = @($Servers | Where-Object { -not [object]::ReferenceEquals($_, $srv) })
      $script:Backends = @($Backends | Where-Object { -not [object]::ReferenceEquals($_, $srv) })
      foreach ($k in @($srv.Name, "$($srv.Name) errors")) { if ($LogFiles.Contains($k)) { $LogFiles.Remove($k); $logPick.Items.Remove($k) } }
      if ($logPick.SelectedIndex -lt 0) { $logPick.SelectedIndex = 1 }
    }
    Remove-Row "srv$($b.port)"; Remove-Row "b$($b.port)"
    $msg = "Removed the backend $($b.name)."
    if ($delFolders -and (& $isCopy $b)) {
      try { Remove-Item -LiteralPath $dir -Recurse -Force -Confirm:$false; $msg += ' Its folder is deleted.' }
      catch { $msg += " Its folder couldn't be deleted ($($_.Exception.Message)) - delete $dir yourself." }
    } else { $msg += " Its folder stays: $dir" }
    $done += $msg
  }
  if ($bksGo.Count) {
    try { Save-MvConfig $Root $Cfg } catch { $done += "Couldn't save mediavault.json: $($_.Exception.Message) - the removed backends come back when this window is opened again." }
  }
  $form.Cursor = 'Default'
  if ($steps.Count -and -not (Invoke-TsSteps $steps)) { $done += "A Tailscale address couldn't be turned off (see the message before this one) - Setup... can do it." }
  Update-Settings; Request-Refresh -Full
  Show-Msg ($done -join "`n`n") 'Information'
}

# The settings page: notes at the top, then a card per topic. Add-* put things into the card started last.
$setPanel = $pgSettings
$script:SetInto = $setPanel
function Add-Set($c) { $script:SetInto.Controls.Add($c); $c }
function Start-SetCard([string]$title) { $script:SetInto = Add-Card $setPanel $title }
function End-SetCard { $script:SetInto = $setPanel }
function Add-Note([string]$text, $color = $Grey) {
  $l = New-Object Windows.Forms.Label; $l.AutoSize = $true; $l.Text = $text; $l.ForeColor = $color; $l.Margin = New-Object Windows.Forms.Padding(0, 0, 0, 6)
  $Notes.Add($l); Add-Set $l
}
# A group of radio buttons ($options: @(key, text) pairs); returns key -> button. $onPick runs with $this = the button.
function Add-Radios($options, [scriptblock]$onPick) {
  $f = New-Object Windows.Forms.FlowLayoutPanel; $f.FlowDirection = 'TopDown'; $f.WrapContents = $false; $f.AutoSize = $true
  $f.AutoSizeMode = 'GrowAndShrink'; $f.Margin = New-Object Windows.Forms.Padding(0, 2, 0, 4)
  $r = [ordered]@{}
  foreach ($o in $options) {
    $rb = New-Object Windows.Forms.RadioButton; $rb.Text = $o[1]; $rb.Tag = $o[0]; $rb.AutoSize = $true; $rb.Margin = New-Object Windows.Forms.Padding(0, 2, 0, 2)
    $rb.Add_CheckedChanged($onPick); $f.Controls.Add($rb); $r[$o[0]] = $rb
  }
  [void](Add-Set $f); $r
}
# A link in a card (an address to open).
function Add-Link {
  $k = New-Object Windows.Forms.LinkLabel; $k.AutoSize = $true; $k.Margin = New-Object Windows.Forms.Padding(0, 0, 0, 6)
  $k.LinkColor = $Brand; $k.ActiveLinkColor = $BrandDark; $k.LinkBehavior = 'HoverUnderline'
  $k.Add_LinkClicked({ Open-Target $this.Tag }); Add-Set $k
}
# A message with a button beside it (shown only when it applies).
function Add-ActionRow([string]$button, [scriptblock]$onClick) {
  $row = New-Object Windows.Forms.FlowLayoutPanel; $row.AutoSize = $true; $row.WrapContents = $false; $row.Margin = New-Object Windows.Forms.Padding(0, 4, 0, 6)
  $l = New-Object Windows.Forms.Label; $l.AutoSize = $true; $l.Margin = New-Object Windows.Forms.Padding(0, 9, 10, 0)
  $b = New-Object Windows.Forms.Button; $b.AutoSize = $true; $b.Text = $button; $b.Add_Click($onClick); Set-ButtonLook $b
  $row.Controls.AddRange(@($l, $b)); [void](Add-Set $row)
  @{ Row = $row; Label = $l; Button = $b }
}
$script:Syncing = $false; $script:SettingsBusy = $false

$tsNote = Add-Note 'Checking Tailscale...' $Amber
$move = Add-ActionRow 'Switch to the new layout' {
  $a = [Windows.Forms.MessageBox]::Show("Switch addresses?`n`nMedia Vault moves to https://$($script:LastTs.Dns):8443/ (still tailnet only) and the sites to https://$($script:LastTs.Dns)/{site}/ - public if they're public now.`n`nBrowsers need to sign in again at the new address. The Android app is sent there by itself.", 'Media Vault', 'OKCancel', 'Question')
  if ($a -eq 'OK') { Move-ToNewLayout }
}
$moveRow = $move.Row; $move.Label.ForeColor = $Amber; $move.Label.Text = 'Tailscale still has the old layout (Media Vault on 443, sites on 8443).'
$stale = Add-ActionRow 'Clear them' {
  $a = [Windows.Forms.MessageBox]::Show("Clear the addresses left over from $($script:LastTs.StaleHosts -join ', ')?`n`nThey stopped working when this PC was renamed in Tailscale. What's set up for $($script:LastTs.Dns) is put back straight after.", 'Media Vault', 'OKCancel', 'Question')
  if ($a -eq 'OK') { Clear-StaleHosts }
}
$staleRow = $stale.Row; $staleLabel = $stale.Label; $staleLabel.ForeColor = $Amber

Start-SetCard 'Hosted sites'
[void](Add-Note "Who can open the sites you publish from Media Vault > Sites, and public share links. The sites server only hands out the sites' files and public links - no login, no dashboard, nothing else from your library.")
$SitesRadios = Add-Radios @(
  @('public', 'Public - anyone with the link, no Tailscale needed (Tailscale Funnel)'),
  @('tailnet', 'Tailnet only - just your devices signed in to Tailscale'),
  @('off', "No HTTPS address - only http://<this PC>:$SitesPort on Tailscale and home Wi-Fi")
) {
  if ($script:Syncing -or -not $this.Checked) { return }
  if ($this.Tag -eq 'public') {
    $a = [Windows.Forms.MessageBox]::Show("Make your hosted sites public?`n`nAnyone with a site's address will be able to open it, without Tailscale. Media Vault itself stays private.`n`nA site without an index.html shows its list of files.", 'Media Vault', 'OKCancel', 'Question')
    if ($a -ne 'OK') { Update-Settings; return }
  }
  Set-SitesAccess $this.Tag
}
$sitesLink = Add-Link
End-SetCard

Start-SetCard 'Media Vault HTTPS address'
[void](Add-Note 'The https:// address (port 8443) your devices on Tailscale use for Media Vault - browsers and the Android app. It is never made public.')
$vaultLink = Add-Link
$VaultRadios = Add-Radios @(
  @('tailnet', 'On - tailnet only (recommended)'),
  @('off', "Off - use http://<Tailscale IP>:$VaultPort instead")
) {
  if ($script:Syncing -or -not $this.Checked) { return }
  if ($this.Tag -eq 'off') {
    $a = [Windows.Forms.MessageBox]::Show("Turn off the HTTPS address?`n`nPhones and browsers that use https://$($script:LastTs.Dns):8443/ lose access until it's turned back on.", 'Media Vault', 'OKCancel', 'Question')
    if ($a -ne 'OK') { Update-Settings; return }
  }
  Set-VaultAccess $this.Tag
}
$vaultWarn = Add-Note 'Tailscale Funnel is publishing Media Vault itself to the internet. Choose "On - tailnet only" to make it private again.' $Red
End-SetCard

Start-SetCard 'Windows'
$chkStartup = New-Object Windows.Forms.CheckBox; $chkStartup.AutoSize = $true; $chkStartup.Margin = New-Object Windows.Forms.Padding(0, 2, 0, 4)
$chkStartup.Text = 'Start Media Vault when I sign in to Windows (this window opens minimized)'
$chkStartup.Add_CheckedChanged({
  if ($script:Syncing) { return }
  try { Set-Startup $chkStartup.Checked } catch { [Windows.Forms.MessageBox]::Show("Couldn't change the startup shortcut:`n$($_.Exception.Message)", 'Media Vault', 'OK', 'Warning') | Out-Null }
  Update-Settings
})
[void](Add-Set $chkStartup)
$startupNote = Add-Note ''
$fw = Add-ActionRow 'Allow phones (needs admin)' {
  try { Start-Process -FilePath (Join-Path $Root 'allow-firewall.bat') -WorkingDirectory $Root -Verb RunAs } catch { return } # Cancel on the admin prompt
  $fwLabel.Text = 'Firewall: finish in the window that opened - this updates within 30 seconds'
}
$fwLabel = $fw.Label; $fwButton = $fw.Button; $fwLabel.Text = 'Firewall: checking...'
[void](Add-Note "Lets phones on your home Wi-Fi and Tailscale reach ports $VaultPort and $SitesPort - not the internet. Runs allow-firewall.bat.")
End-SetCard

Start-SetCard 'When this window is closed'
$CloseRadios = Add-Radios @(
  @('ask', 'Ask each time'),
  @('keep', 'Keep Media Vault running in the background'),
  @('stop', 'Stop the servers')
) {
  if ($script:Syncing -or -not $this.Checked) { return }
  $script:WinSettings.OnClose = $this.Tag; Save-WindowSettings
}
End-SetCard

Start-SetCard 'Sites with a backend'
[void](Add-Note "For a site that needs a server of its own, like CubeWord's accounts and cloud saves: pick the project's folder. Media Vault finds the site (its index.html) and its backend (pb_hooks / pb_migrations), publishes the site, starts the backend on its own port and https:// address with its own admin account, and points the site at it. Only names, who can open them and the admin account are asked. Plain sites work here too, or in Media Vault > Sites.")
[void](Add-Note 'Backends set up now:')
$bkText = Add-Note '' $Ink
$btnBkAdd = New-Object Windows.Forms.Button; $btnBkAdd.AutoSize = $true; $btnBkAdd.Text = 'Add a site or backend...'; $btnBkAdd.Add_Click({ Add-Project }); Set-ButtonLook $btnBkAdd 'primary'
$btnBkDel = New-Object Windows.Forms.Button; $btnBkDel.AutoSize = $true; $btnBkDel.Text = 'Remove a site or backend...'; $btnBkDel.Add_Click({ Remove-Project }); Set-ButtonLook $btnBkDel
$btnBkDir = New-Object Windows.Forms.Button; $btnBkDir.AutoSize = $true; $btnBkDir.Text = 'Open the projects folder'; Set-ButtonLook $btnBkDir
$btnBkDir.Add_Click({ New-Item -ItemType Directory -Force $ProjectsDir | Out-Null; Open-Target $ProjectsDir })
$bkRow = New-Object Windows.Forms.FlowLayoutPanel; $bkRow.AutoSize = $true; $bkRow.WrapContents = $false; $bkRow.Margin = New-Object Windows.Forms.Padding(0, 2, 0, 6)
$bkRow.Controls.AddRange(@($btnBkAdd, $btnBkDel, $btnBkDir)); [void](Add-Set $bkRow)
[void](Add-Note 'Optional: keep each project (site + backend) in its own folder inside projects\ - "Add a site or backend..." starts there and can move a project there for you.')
End-SetCard

Start-SetCard 'Library folder, ports, admin account, backends'
[void](Add-Note "Changed in setup: where your library is stored (now $DataDir - setup can move it, e.g. to a bigger drive), which ports the servers use, the admin dashboard account, and changing site backends.")
$setupRow = New-Object Windows.Forms.Button; $setupRow.AutoSize = $true; $setupRow.Text = 'Open setup...'; $setupRow.Add_Click({ Open-Setup }); Set-ButtonLook $setupRow
$setupRow.Margin = New-Object Windows.Forms.Padding(0, 2, 0, 6); [void](Add-Set $setupRow)
End-SetCard

# Show the current state. Called after every full status check (Tailscale, firewall) and after each change here.
function Update-Settings {
  if ($script:SettingsBusy) { return }
  $script:Syncing = $true
  try {
    $ts = $script:LastTs
    $tsOk = $ts -and $ts.Installed -and $ts.State -eq 'Running'
    $tsNote.Visible = -not $tsOk
    $tsNote.Text = if (-not $ts) { 'Checking Tailscale...' } elseif (-not $ts.Installed) { "Tailscale isn't installed, so the HTTPS addresses can't be set up." } else { "Tailscale isn't running ($($ts.State)), so these can't be changed right now." }
    foreach ($rb in @($SitesRadios.Values) + @($VaultRadios.Values)) { $rb.Enabled = [bool]$tsOk }
    $sm = if (-not $ts) { '' } elseif ($ts.FunnelSites) { 'public' } elseif ($ts.ServeSites) { 'tailnet' } else { 'off' }
    foreach ($k in $SitesRadios.Keys) { $SitesRadios[$k].Checked = ($k -eq $sm) }
    $vm = if (-not $ts) { '' } elseif ($ts.Serve) { 'tailnet' } else { 'off' }
    foreach ($k in $VaultRadios.Keys) { $VaultRadios[$k].Checked = ($k -eq $vm) }
    $vaultWarn.Visible = $ts -and $ts.Funnel
    $moveRow.Visible = $tsOk -and $ts.OldLayout
    $hasStale = $tsOk -and $ts.StaleHosts.Count -gt 0
    $staleRow.Visible = $hasStale # (not read back: .Visible says false while the page is hidden)
    if ($hasStale) { $staleLabel.Text = "Tailscale still has addresses for an old name of this PC ($($ts.StaleHosts -join ', '))." }
    $vaultLink.Visible = $ts -and $ts.Dns -and $vm -eq 'tailnet'
    $vaultLink.Tag = "https://$($ts.Dns):8443/"; $vaultLink.Text = $vaultLink.Tag
    $showLink = $ts -and $ts.Dns -and $sm -ne 'off'
    $sitesLink.Visible = $showLink # (reading .Visible back says false while the page is hidden)
    if ($showLink) {
      $u = "https://$($ts.Dns)/"; $sitesLink.Tag = $u
      $sitesLink.Text = if ($sm -eq 'public') { "$u{site}/ - open to anyone" } else { "$u{site}/ - on your tailnet" }
    }

    $ss = Get-StartupState
    $chkStartup.Checked = $ss -eq 'on'
    $startupNote.Visible = $ss -in 'elsewhere', 'stale'
    $startupNote.Text = if ($ss -eq 'stale') { "The Media Vault startup shortcut opens a folder that isn't there any more, so it does nothing. Tick the box to point it here." } else { 'A Media Vault startup shortcut points at another copy of this folder. Tick the box to point it here.' }

    switch ($script:LastFw) {
      'ok' { $fwLabel.Text = 'Firewall: phones are allowed in'; $fwLabel.ForeColor = $Green; $fwButton.Text = 'Set up again (needs admin)' }
      'missing' { $fwLabel.Text = 'Firewall: not set up - phones on Wi-Fi can''t connect'; $fwLabel.ForeColor = $Amber; $fwButton.Text = 'Allow phones (needs admin)' }
    }

    $CloseRadios[$script:WinSettings.OnClose].Checked = $true

    $bkText.Text = if (-not $Cfg.backends.Count) { 'None yet.' } else {
      ($Cfg.backends | ForEach-Object {
        $at = if ($_.access -ne 'off' -and $ts -and $ts.Dns) { "https://$($ts.Dns):$($_.httpsPort)/" + $(if ($_.access -eq 'public') { ' (public)' } else { ' (tailnet)' }) } else { "http://127.0.0.1:$($_.port)/ (this PC)" }
        "$($_.name)  -  $at  -  admin: http://127.0.0.1:$($_.port)/_/"
      }) -join "`n"
    }
  } finally { $script:Syncing = $false }
}

$foot = New-Object Windows.Forms.FlowLayoutPanel; $foot.AutoSize = $true; $foot.WrapContents = $false; $foot.Margin = New-Object Windows.Forms.Padding(0, 6, 0, 0)
$statusText = New-Object Windows.Forms.Label; $statusText.Text = 'Starting...'; $statusText.AutoSize = $true; $statusText.ForeColor = $Grey
$statusText.Margin = New-Object Windows.Forms.Padding(0)
$checkNow = New-Object Windows.Forms.LinkLabel; $checkNow.Text = 'Check now'; $checkNow.AutoSize = $true; $checkNow.Margin = New-Object Windows.Forms.Padding(10, 0, 0, 0)
$checkNow.LinkColor = $Brand; $checkNow.ActiveLinkColor = $BrandDark; $checkNow.LinkBehavior = 'HoverUnderline'
$checkNow.Add_LinkClicked({ Request-Refresh -Full })
$foot.Controls.AddRange(@($statusText, $checkNow))
$main.Controls.Add($foot, 0, 2)
Show-Page 'Status'

# ---------- refresh loop ----------
$script:Job = $null; $script:JobPs = $null; $script:NextAt = Get-Date; $script:NextFullAt = Get-Date; $script:LastTs = $null; $script:LastDisk = $null; $script:LastLan = @()
$script:LastFw = ''; $script:JobAt = Get-Date; $script:TsChangedAt = [DateTime]::MinValue
function Request-Refresh([switch]$Full) { $script:NextAt = Get-Date; if ($Full) { $script:NextFullAt = Get-Date } }
function Start-Snapshot {
  $script:JobAt = Get-Date
  $full = (Get-Date) -ge $script:NextFullAt
  if ($full) { $script:NextFullAt = (Get-Date).AddSeconds(30) }
  $ps = [PowerShell]::Create()
  [void]$ps.AddScript($Snapshot.ToString()).AddArgument($Root).AddArgument($TsExe).AddArgument($Token).AddArgument(@($Servers | ForEach-Object { $_.Port })).AddArgument($full).AddArgument($VaultPort).AddArgument($SitesPort).AddArgument($DataDir)
  $script:JobPs = $ps; $script:Job = $ps.BeginInvoke()
}
function Show-Snapshot($snap) {
  if ($snap.Full) {
    $script:LastTs = $snap.Tailscale; $script:LastDisk = $snap.Disk; $script:LastLan = $snap.Lan; $script:LastFw = $snap.Firewall
    # A check that started before a change on the Settings tab would show the old state, so skip it there.
    if ($script:JobAt -gt $script:TsChangedAt) { Update-Settings }
  }
  $ts = $script:LastTs; $disk = $script:LastDisk
  $warn = New-Object Collections.Generic.List[string]
  $now = Get-Date

  # Servers
  $states = @{}
  foreach ($s in $Servers) {
    $i = $snap.Servers[$s.Port]
    $key = "srv$($s.Port)"; $label = "$($s.Name) (port $($s.Port))"
    if ($i.Healthy) {
      $up = if ($i.Started) { ' - up ' + (Format-Span ($now - $i.Started)) } else { '' }
      Set-Row 'Servers' $key $label ("Running$up - PID $($i.Pid)") $Green; $states[$s.Port] = 'up'
      $s.StartedAt = $null
    } elseif ($i.Pid -and $i.Name -ne 'pocketbase') {
      Set-Row 'Servers' $key $label "Port taken by another program ($($i.Name), PID $($i.Pid))" $Red; $states[$s.Port] = 'down'
      $warn.Add("port $($s.Port) is used by $($i.Name)")
    } elseif (($i.Pid -or ($s.Proc -and -not $s.Proc.HasExited)) -and $s.StartedAt -and ($now - $s.StartedAt).TotalSeconds -lt 60) {
      Set-Row 'Servers' $key $label 'Starting...' $Amber; $states[$s.Port] = 'starting'
    } elseif ($s.Proc -and $s.Proc.HasExited) {
      Set-Row 'Servers' $key $label "Stopped unexpectedly (exit code $($s.Proc.ExitCode)) - see the errors log" $Red; $states[$s.Port] = 'down'
      $warn.Add("$($s.Name) server crashed")
    } elseif ($i.Pid) {
      Set-Row 'Servers' $key $label "Not answering (PID $($i.Pid))" $Amber; $states[$s.Port] = 'starting'
    } elseif ($s.Error) {
      Set-Row 'Servers' $key $label "Couldn't start: $($s.Error)" $Red; $states[$s.Port] = 'down'
      $warn.Add("$($s.Name) couldn't start")
    } else {
      Set-Row 'Servers' $key $label 'Stopped' $Grey; $states[$s.Port] = 'down'
    }
  }
  $mvUp = $states[$VaultPort] -eq 'up'

  # Addresses
  if ($ts) {
    if (-not $ts.Installed) { Set-Row 'Addresses' 'ts' 'Tailscale' 'Not installed' $Amber }
    elseif ($ts.State -eq 'Running' -and $ts.Online) { Set-Row 'Addresses' 'ts' 'Tailscale' "Connected as $($ts.Dns)" $Green }
    else { Set-Row 'Addresses' 'ts' 'Tailscale' "Not connected ($($ts.State))" $Red; $warn.Add('Tailscale is not connected') }
    if ($ts.Dns -and $ts.Serve) {
      $u = "https://$($ts.Dns):8443/"
      if ($ts.HttpsOk) { Set-Row 'Addresses' 'https' 'Tailnet (HTTPS)' "$u  - reachable" $Green $u }
      elseif ($mvUp) { Set-Row 'Addresses' 'https' 'Tailnet (HTTPS)' "$u  - not answering yet" $Amber $u }
      else { Set-Row 'Addresses' 'https' 'Tailnet (HTTPS)' $u $Grey $u }
    } elseif ($ts.OldLayout) {
      Set-Row 'Addresses' 'https' 'Tailnet (HTTPS)' 'Old layout (Media Vault on 443) - Settings > "Switch to the new layout"' $Amber
      $warn.Add('Tailscale addresses need switching (Settings)')
    } elseif ($ts.Installed) {
      Set-Row 'Addresses' 'https' 'Tailnet (HTTPS)' 'Not set up - turn it on in Settings (or see docs\MOVING.md)' $Amber
      $warn.Add('HTTPS address not set up')
    }
    $su = "https://$($ts.Dns)/"
    if ($ts.Dns -and $ts.FunnelSites) { Set-Row 'Addresses' 'shttps' 'Sites (public)' "$su  - anyone on the internet" $Green $su }
    elseif ($ts.Dns -and $ts.ServeSites) { Set-Row 'Addresses' 'shttps' 'Sites (HTTPS)' "$su  - tailnet only" $null $su }
    else { Remove-Row 'shttps' }
    # Site backends' https addresses, as tailscale serve has them now (Setup sets them up).
    foreach ($b in $Backends) {
      $o = if ($ts.Other) { $ts.Other[$b.Port] } else { $null }
      if ($ts.Dns -and $o) {
        $bu = "https://$($ts.Dns):$($o.Https)/"
        Set-Row 'Addresses' "b$($b.Port)" $b.Name ("$bu  - " + $(if ($o.Public) { 'public (Funnel)' } else { 'tailnet only' })) $null $bu
      } elseif ($b.Access -ne 'off') {
        Set-Row 'Addresses' "b$($b.Port)" $b.Name "No https address yet - run Setup... to add it" $Amber
      } else { Set-Row 'Addresses' "b$($b.Port)" $b.Name "http://127.0.0.1:$($b.Port)/ - this PC only" $Grey }
    }
    if ($ts.Ip) { Set-Row 'Addresses' 'tsip' 'Tailscale IP' "http://$($ts.Ip):$VaultPort/" $null "http://$($ts.Ip):$VaultPort/" }
    if ($ts.Funnel) { Set-Row 'Addresses' 'funnel' 'Public internet' 'ON - Tailscale Funnel is publishing Media Vault itself to the internet - fix it in Settings' $Red; $warn.Add('Funnel is on for the vault (public)') }
    elseif ($ts.FunnelSites -or $ts.OldSitesPublic -or ($ts.Other -and @($ts.Other.Values | Where-Object { $_.Public }).Count)) {
      $what = @(); if ($ts.FunnelSites -or $ts.OldSitesPublic) { $what += 'the sites' }
      foreach ($b in $Backends) { if ($ts.Other[$b.Port] -and $ts.Other[$b.Port].Public) { $what += $b.Name } }
      if (-not $what.Count) { $what = @('other servers on this PC') }
      Set-Row 'Addresses' 'funnel' 'Public internet' "Only $($what -join ', ') - Media Vault itself is tailnet and home Wi-Fi only" $Green
    }
    else { Set-Row 'Addresses' 'funnel' 'Public internet' 'Off - only your tailnet and home Wi-Fi can reach it' $Green }
  }
  $lan = @($script:LastLan)
  if ($lan.Count) { Set-Row 'Addresses' 'lan' 'Home Wi-Fi' (($lan | ForEach-Object { "http://${_}:$VaultPort/" }) -join '   ') $null "http://$($lan[0]):$VaultPort/" }
  Set-Row 'Addresses' 'local' 'This PC' "http://localhost:$VaultPort/" $null "http://localhost:$VaultPort/"

  # Library + locked folder (from /api/status)
  $st = $snap.Status
  if ($st) {
    $k = @{}; foreach ($x in @($st.kinds)) { $k[$x.kind] = $x }
    $owner = if ($st.owner) { " - owner: $($st.owner)" } else { '' }
    Set-Row 'Library' 'users' 'Accounts' ((Plural $st.users 'account') + $owner + ' - ' + (Plural $st.invites 'invite code'))
    $total = 0; $bytes = 0
    foreach ($kind in @(@('image', 'Photos', 'photo'), @('video', 'Videos', 'video'), @('gif', 'GIFs', 'GIF'), @('file', 'Files', 'file'))) {
      $x = $k[$kind[0]]; $n = 0; $b = 0
      if ($x) { $n = [long]$x.count; $b = [double]$x.bytes }
      $total += $n; $bytes += $b
      Set-Row 'Library' "k$($kind[0])" $kind[1] ($(if ($n) { (Plural $n $kind[2]) + ' - ' + (Format-Bytes $b) } else { 'None' }))
    }
    Set-Row 'Library' 'total' 'Total' ((Plural $total 'item') + ' - ' + (Format-Bytes $bytes) + ' - ' + (Plural $st.favorites 'favorite'))
    Set-Row 'Library' 'orgs' 'Albums and folders' ((Plural $st.albums 'album') + ' - ' + (Plural $st.folders 'folder'))
    Set-Row 'Library' 'shares' 'Share links' ($(if ($st.shares) { (Plural $st.shares 'active link') + ' (anyone with the link can open it)' } else { 'None' }))
    $tc = [long]$st.trash.count
    Set-Row 'Library' 'trash' 'Trash' ($(if ($tc) { (Plural $tc 'item') + ' - ' + (Format-Bytes $st.trash.bytes) + ' - deleted for good after 30 days' } else { 'Empty' }))
    if ($st.lastUpload) {
      $at = [DateTime]::Parse($st.lastUpload.Replace(' ', 'T'), $null, 'AdjustToUniversal, AssumeUniversal').ToLocalTime()
      Set-Row 'Library' 'last' 'Last upload' ($at.ToString('d MMM yyyy, h:mm tt') + ' (' + $(if (($now - $at).TotalMinutes -lt 1) { 'just now' } else { (Format-Span ($now - $at)) + ' ago' }) + ')')
    } else { Set-Row 'Library' 'last' 'Last upload' 'Nothing uploaded yet' }
    if ($st.locked.users) {
      Set-Row 'Locked folder' 'locked' 'Locked folder' ((Plural $st.locked.count 'encrypted item') + ' - ' + (Format-Bytes $st.locked.bytes) + ' - set up by ' + (Plural $st.locked.users 'account')) $null
    } else { Set-Row 'Locked folder' 'locked' 'Locked folder' 'Not set up' $Grey }
    Set-Row 'Locked folder' 'lockednote' 'Encryption' 'End-to-end - only the passphrase or recovery key can open it; the server never sees the contents' $Grey
  } elseif (-not $mvUp) {
    Set-Row 'Library' 'total' 'Total' 'Start Media Vault to see the library' $Grey
  } else {
    Set-Row 'Library' 'total' 'Total' "Couldn't read the library numbers (restart to load pb_hooks\status.pb.js)" $Amber
  }

  # Storage
  if ($disk) {
    $where = if ($Cfg.dataDir) { " in $DataDir" } else { '' }
    Set-Row 'Storage' 'data' 'Library folder' ((Format-Bytes $disk.Data.Bytes) + ' in ' + (Plural $disk.Data.Files 'file') + $where + ' - back up this folder while stopped') $null $DataDir
    $sitesN = if ($st) { (Plural $st.sites 'site') + ' - ' } else { '' }
    Set-Row 'Storage' 'sites' 'Hosted sites (pb_sites\www)' ($sitesN + (Format-Bytes $disk.Sites.Bytes)) $null (Join-Path $Root 'pb_sites\www')
    $free = [double]$disk.Free
    $c = if ($free -lt 5GB) { $Red } elseif ($free -lt 20GB) { $Amber } else { $null }
    Set-Row 'Storage' 'free' "Free space on $($disk.Drive)" ((Format-Bytes $free) + ' of ' + (Format-Bytes $disk.Total)) $c
    if ($free -lt 5GB) { $warn.Add('disk almost full') }
  }
  if ($env:OneDrive -and $Root.StartsWith($env:OneDrive, [StringComparison]::OrdinalIgnoreCase)) {
    Set-Row 'Storage' 'onedrive' 'Location' "Inside OneDrive ($Root) - OneDrive syncing a live database can corrupt it; consider moving the folder out" $Amber
  } else { Set-Row 'Storage' 'onedrive' 'Location' $Root }

  # Banner
  $sitesUp = $states[$SitesPort] -eq 'up'
  $bkDown = @($Backends | Where-Object { $states[$_.Port] -eq 'down' } | ForEach-Object { $_.Name })
  if ($mvUp -and $sitesUp -and -not $bkDown.Count) { Set-State 'Running' $Green }
  elseif ($mvUp -and $sitesUp) { Set-State "Running - $($bkDown -join ', ') is down" $Amber }
  elseif ($mvUp) { Set-State 'Running - sites server is down' $Amber }
  elseif ($states.Values -contains 'starting') { Set-State 'Starting...' $Amber }
  else { Set-State 'Stopped' $Red }
  $script:Lights = @($Servers | ForEach-Object { @{ Name = $_.Name; State = $states[$_.Port] } }); $side.Invalidate()
  $mv = $snap.Servers[$VaultPort]
  $up = if ($mvUp -and $mv.Started) { 'Up ' + (Format-Span ($now - $mv.Started)) } elseif ($mvUp) { 'Up' } else { 'Press Start to run Media Vault' }
  $detail.Text = $up + ' - ' + $(if ($warn.Count) { 'Needs attention: ' + ($warn -join ', ') } else { 'Everything looks good' })
  $detail.ForeColor = if ($warn.Count) { $Amber } else { $Grey }
  $btnStart.Enabled = -not ($mvUp -and $sitesUp -and -not $bkDown.Count)
  $btnStop.Enabled = ($states.Values | Where-Object { $_ -ne 'down' }).Count -gt 0
  $statusText.Text = 'Last checked ' + $now.ToString('h:mm:ss tt') + ' - click an address or folder to open it, right-click to copy'
}

$timer = New-Object Windows.Forms.Timer; $timer.Interval = 1000
$timer.Add_Tick({
  if ($script:Job -and $script:Job.IsCompleted) {
    try {
      $r = $script:JobPs.EndInvoke($script:Job)
      if ($r.Count) { Show-Snapshot $r[$r.Count - 1] }
    } catch {
      $statusText.Text = "Status check failed: $($_.Exception.Message) (details in logs\window.log)"
      try { Add-Content -Path (Join-Path $LogDir 'window.log') -Value "$(Get-Date -Format s) line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)" } catch {}
    }
    $script:JobPs.Dispose(); $script:Job = $null; $script:NextAt = (Get-Date).AddSeconds(5)
  }
  if (-not $script:Job -and (Get-Date) -ge $script:NextAt) { Start-Snapshot }
  Update-Log
})

$form.Add_Shown({
  try { Start-Servers } catch { [Windows.Forms.MessageBox]::Show("Couldn't start the servers:`n$($_.Exception.Message)", 'Media Vault', 'OK', 'Error') | Out-Null }
  Fit-Cards
  Update-Settings; Request-Refresh -Full; $timer.Start()
})
$form.Add_FormClosing({
  param($src, $e)
  $running = @($Servers | Where-Object { Get-ListenPid $_.Port }).Count
  if ($script:ToSetup -or -not $running) { $timer.Stop(); return }
  $a = switch ($script:WinSettings.OnClose) {
    'keep' { 'No' }
    'stop' { 'Yes' }
    default {
      [Windows.Forms.MessageBox]::Show(
        "Stop Media Vault too?`n`nYes - stop the servers (phones and browsers lose access).`nNo - just close this window; Media Vault keeps running in the background. Run start.bat again to reopen this window.`n`n(Settings > When this window is closed can make this the default.)",
        'Media Vault', 'YesNoCancel', 'Question')
    }
  }
  if ($a -eq 'Cancel') { $e.Cancel = $true; return }
  $timer.Stop()
  if ($a -eq 'Yes') { $form.Cursor = 'WaitCursor'; Stop-Servers }
})

[void]$form.ShowDialog()
$timer.Dispose()
$mutex.ReleaseMutex(); $mutex.Dispose() # (disposed, so setup doesn't still see this window as open)
if ($script:ToSetup) {
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -WorkingDirectory $Root -WindowStyle Hidden `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$(Join-Path $PSScriptRoot 'Setup.ps1')`""
}
