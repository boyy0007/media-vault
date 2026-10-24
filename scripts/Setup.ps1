<#
  Media Vault setup (setup.bat; start.bat opens it on a fresh copy; "Setup..." in the status window). A step-by-step
  window that asks for what this PC needs and then does it:
    - ports: Media Vault (8091) and the sites server (8092, the second PocketBase in pb_sites\) -> mediavault.json
    - the admin dashboard (/_/) account -> `pocketbase superuser upsert`
    - Tailscale HTTPS addresses: Media Vault on 8443 (tailnet only), the sites on 443 (public through Funnel, or not)
    - site backends: extra PocketBase servers that hosted sites call, e.g. CubeWord's accounts and cloud saves, each
      in its own folder on 127.0.0.1:{port}, optionally published by Tailscale on an https port of its own
    - firewall rule (allow-firewall.bat), startup and desktop shortcuts
  Safe to run again: it starts from what's set up now and only changes what differs. Nothing in pb_data is touched
  except the admin account, and only when asked. Settings file format: mv-common.ps1.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot # (the scripts are in Media Vault's scripts folder)
Set-Location $Root
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
. (Join-Path $PSScriptRoot 'mv-common.ps1')
# (A copy unzipped from a download: clear Windows' internet mark first - see Unblock-MvFolder.)
try { [void](Unblock-MvFolder $Root) } catch {}
$Title = 'Media Vault setup'

$created = $false
$mutex = New-Object Threading.Mutex($true, $MvSetupMutex, [ref]$created)
if (-not $created) { [Windows.Forms.MessageBox]::Show('Media Vault setup is already open (check the taskbar).', $Title) | Out-Null; return }
# This copy's status window keeps using the settings it started with, so it has to be closed while they change.
# (A window opened before windows were per-copy has the old name; only an install in use can have one of those.)
$names = @($MvWindowMutex)
if ((Test-Path (Join-Path (Get-MvDataDir $Root (Get-MvConfig $Root)) 'data.db')) -or (Test-Path (Join-Path $Root 'mediavault.json'))) { $names += 'Local\MediaVaultStatusWindow' }
while ($true) {
  $m = $null
  $open = $false
  foreach ($n in $names) { if ([Threading.Mutex]::TryOpenExisting($n, [ref]$m)) { $m.Dispose(); $open = $true } }
  if (-not $open) { break }
  $a = [Windows.Forms.MessageBox]::Show("The Media Vault window is open. Close it first (the servers can keep running), then press Retry.`n`nSetup opens it again when it's done.", $Title, 'RetryCancel', 'Information')
  if ($a -ne 'Retry') { $mutex.ReleaseMutex(); return }
}

$Exe = Join-Path $Root 'pocketbase.exe'
$Old = Get-MvConfig $Root            # what's set up now
$OldData = Get-MvDataDir $Root $Old # where the library is now
$HasData = Test-Path -LiteralPath (Join-Path $OldData 'data.db')
$Fresh = -not $HasData -and -not $Old.saved
$Ts = Get-MvTailscale

# ---------- what's there already ----------
# Who listens on a port: @{ Free; Ours (a PocketBase run from $dir, i.e. this server already running); Text }.
function Get-PortUse([int]$port, [string]$dir) {
  $id = Get-MvListenPid $port
  if (-not $id) { return @{ Free = $true; Ours = $false; Text = 'free' } }
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  $path = ''; try { $path = "$($p.Path)" } catch {}
  $wd = if ($path) { Split-Path $path } else { '' }
  $isPb = $p -and $p.ProcessName -eq 'pocketbase'
  # Backends may run on Media Vault's own pocketbase.exe, so for them only "a PocketBase" can be checked.
  if ($isPb -and ($wd -eq $dir -or ($dir -ne $Root -and $wd -eq $Root))) { return @{ Free = $false; Ours = $true; Text = 'running now (this server)' } }
  $who = if ($p) { "$($p.ProcessName) (PID $id)" } else { "PID $id" }
  if ($isPb -and $wd) { $who = "another PocketBase in $wd" }
  @{ Free = $false; Ours = $false; Text = "in use by $who" }
}

# The PID of the PocketBase on $port if it runs from $dir (backends may run on this folder's pocketbase.exe), else
# $null - so setup never stops a server that belongs to another copy of Media Vault.
function Get-OurPid([int]$port, [string]$dir) {
  $id = Get-MvListenPid $port
  if (-not $id) { return $null }
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  $path = ''; try { $path = "$($p.Path)" } catch {}
  if (-not $p -or $p.ProcessName -ne 'pocketbase' -or -not $path) { return $null }
  $wd = Split-Path $path
  if ($wd -eq $dir -or ($dir -ne $Root -and $wd -eq $Root)) { $id } else { $null }
}

# Whether local port $port belongs to this install: a PocketBase from this folder (or one of its backends' folders) is
# listening on it, or - when nothing is - it's a port this install was set up with before. A fresh copy owns nothing
# it isn't running, so a second copy on the same PC never takes over or turns off the first one's Tailscale addresses.
function Test-OurPort([int]$port) {
  $id = Get-MvListenPid $port
  if ($id) {
    $path = ''; try { $path = "$((Get-Process -Id $id).Path)" } catch {}
    if (-not $path) { return $false }
    $wd = Split-Path $path
    # (Backends taken off the list aren't ours any more: removing one leaves it and its address alone.)
    $dirs = @($Root) + @($Want.backends | Where-Object { $_ } | ForEach-Object { Resolve-MvDir $Root $_.dir })
    return [bool]($dirs | Where-Object { $_ -eq $wd })
  }
  if ($Fresh) { return $false }
  $kept = @($Old.backends | Where-Object { $d = Resolve-MvDir $Root $_.dir; $Want.backends | Where-Object { (Resolve-MvDir $Root $_.dir) -eq $d } })
  (@($Old.vaultPort, $Old.sitesPort) + @($kept | ForEach-Object { $_.port })) -contains $port
}
# Tailscale addresses the choices would take from something that isn't this install, e.g. another copy of Media Vault
# on this PC: "https port 8443 (now 127.0.0.1:8091)" each.
function Get-Takeovers {
  if (-not ($Ts.Installed -and $Ts.State -eq 'Running')) { return @() }
  $plan = Get-WantedServe
  @(foreach ($h in $plan.Keys) {
    $cur = $Ts.Entries[$h]
    if ($cur -and $cur.Port -ne $plan[$h].Port -and -not (Test-OurPort $cur.Port)) { "https port $h (now 127.0.0.1:$($cur.Port))" }
  })
}

# Backends to offer when none are set up yet: ones that came with this copy (backends\{name}\backend.json, written by
# make-package.ps1), and - on an install that's already in use - PocketBase servers running now that tailscale serve
# publishes (e.g. CubeWord's save server started from its own folder). A fresh copy doesn't pick up running ones:
# they belong to some other install.
function Find-Backends {
  $found = @()
  $bd = Join-Path $Root 'backends'
  if (Test-Path $bd) {
    foreach ($d in @(Get-ChildItem -LiteralPath $bd -Directory)) {
      $info = $null; try { $info = [IO.File]::ReadAllText((Join-Path $d.FullName 'backend.json')) | ConvertFrom-Json } catch {}
      $port = if ($info -and (Test-MvPort $info.port)) { [int]$info.port } else { 0 }
      $https = if ($info -and (Test-MvPort $info.httpsPort)) { [int]$info.httpsPort } else { 0 }
      $access = if ($https -and $info -and "$($info.access)" -in 'public', 'tailnet') { "$($info.access)" } else { 'off' }
      $found += @(@{ name = $(if ($info -and $info.name) { "$($info.name)" } else { $d.Name }); dir = "backends\$($d.Name)"
                     port = $port; httpsPort = $https; access = $access; note = 'came with this copy'; review = $true })
    }
  }
  foreach ($h in @($Ts.Entries.Keys)) {
    if ($Fresh) { break }
    $e = $Ts.Entries[$h]
    if ($e.Port -in $Old.vaultPort, $Old.sitesPort) { continue }
    $id = Get-MvListenPid $e.Port
    if (-not $id) { continue }
    $path = ''; try { $path = "$((Get-Process -Id $id).Path)" } catch {}
    if (-not $path -or (Split-Path -Leaf $path) -ne 'pocketbase.exe') { continue }
    $dir = Split-Path $path
    if ($dir -eq $Root -or ($found | Where-Object { (Resolve-MvDir $Root $_.dir) -eq $dir })) { continue }
    $found += @(@{ name = (Get-MvBackendName $dir); dir = $dir; port = $e.Port; httpsPort = [int]$h
                   access = $(if ($e.Public) { 'public' } else { 'tailnet' }); note = 'running now' })
  }
  $taken = @($Old.vaultPort, $Old.sitesPort) + @($found | ForEach-Object { $_.port })
  foreach ($b in $found) { if (-not $b.port) { $b.port = Get-MvFreePort $taken; $taken += $b.port } }
  $found
}

# The choices, filled in from what's set up now (or sensible defaults on a fresh copy).
$Want = @{
  vaultPort = $Old.vaultPort; sitesPort = $Old.sitesPort; dataDir = $Old.dataDir
  backends = @($Old.backends | ForEach-Object { @{ name = $_.name; dir = $_.dir; port = $_.port; httpsPort = $_.httpsPort; access = $_.access; exeSha256 = $_.exeSha256; note = '' } })
  admin = $Fresh; adminEmail = ''; adminPass = ''
  vaultMode = 'off'; sitesMode = 'off'
  firewall = $false; startup = $false; desktop = $false; startNow = $true
}
if (-not $Want.backends.Count) { $Want.backends = @(Find-Backends) }
# A fresh copy whose default ports are taken (e.g. by another copy of Media Vault) starts on free ones.
if ($Fresh) {
  $taken = @($Want.backends | ForEach-Object { $_.port })
  if (Get-MvListenPid $Want.vaultPort) { $Want.vaultPort = Get-MvFreePort $taken 8191 }
  $taken += $Want.vaultPort
  if ((Get-MvListenPid $Want.sitesPort) -or $taken -contains $Want.sitesPort) { $Want.sitesPort = Get-MvFreePort $taken ($Want.vaultPort + 1) }
}
$vaultEntry = @($Ts.Entries.Values | Where-Object { $_.Port -eq $Old.vaultPort -and (Test-OurPort $_.Port) })
$sitesEntry = @($Ts.Entries.Values | Where-Object { $_.Port -eq $Old.sitesPort -and (Test-OurPort $_.Port) })
if ($vaultEntry.Count -or $Fresh) { $Want.vaultMode = 'tailnet' }
if ($sitesEntry | Where-Object { $_.Public }) { $Want.sitesMode = 'public' } elseif ($sitesEntry.Count -or $Fresh) { $Want.sitesMode = 'tailnet' }
# On a fresh copy, an https port that's already serving something else starts off, not taken over.
if ($Fresh -and $Ts.Entries[$MvVaultHttps]) { $Want.vaultMode = 'off' }
if ($Fresh -and $Ts.Entries[$MvSitesHttps]) { $Want.sitesMode = 'off' }
$fwNow = try { @(Get-NetFirewallRule -DisplayName "Media Vault ($($Old.vaultPort))", "Media Vault sites ($($Old.sitesPort))" -ErrorAction Stop | Where-Object { "$($_.Enabled)" -eq 'True' }).Count -ge 2 } catch { $false }
$Want.firewall = -not $fwNow
# Shortcuts that already open another copy of Media Vault aren't taken over unless asked.
$StartupNow = Get-MvShortcutState $Root $MvStartupLnk
$DesktopNow = Get-MvShortcutState $Root $MvDesktopLnk
$Want.startup = $StartupNow -in 'on', 'stale' -or ($Fresh -and $StartupNow -eq 'off') # (a dead one: it was meant to)
$Want.desktop = $DesktopNow -in 'off', 'stale'

# ---------- window ----------
# The look (colours, fonts, cards, buttons) is shared with the status window: mv-look.ps1.
. (Join-Path $PSScriptRoot 'mv-look.ps1')
. (Join-Path $PSScriptRoot 'mv-qr.ps1') # (QR codes for the last page's Connect a phone)

$form = New-Object Windows.Forms.Form
$form.Text = $Title; $form.Icon = New-MvIcon; $form.Font = $Font
$form.StartPosition = 'CenterScreen'; $form.ClientSize = New-Object Drawing.Size(920, 620); $form.MinimumSize = New-Object Drawing.Size(760, 540)
$form.BackColor = [Drawing.Color]::White; $form.ForeColor = $Ink

$outer = New-Object Windows.Forms.TableLayoutPanel; $outer.Dock = 'Fill'; $outer.ColumnCount = 2; $outer.RowCount = 2
[void]$outer.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Absolute', 224)))
[void]$outer.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Percent', 100)))
[void]$outer.RowStyles.Add((New-Object Windows.Forms.RowStyle('Percent', 100)))
[void]$outer.RowStyles.Add((New-Object Windows.Forms.RowStyle('AutoSize')))
$form.Controls.Add($outer)

# Steps down the left: the app's mark and name, then a numbered rail (done = tick, current = white, next = outline).
$side = New-Object Windows.Forms.Panel; $side.Dock = 'Fill'; $side.BackColor = $SideBg; $side.Margin = New-Object Windows.Forms.Padding(0)
Set-DoubleBuffered $side
$outer.Controls.Add($side, 0, 0); $outer.SetRowSpan($side, 2)
$StepNames = @('Welcome', 'Servers', 'Your account', 'Tailscale', 'Site backends', 'Windows', 'Review', 'Set up')
$side.Add_Paint({
  $g = $_.Graphics; $g.SmoothingMode = 'AntiAlias'
  $white = { param($a) [Drawing.Color]::FromArgb($a, 255, 255, 255) }
  Draw-MvMark $g 24 26 34
  [Windows.Forms.TextRenderer]::DrawText($g, 'Media Vault', $HeadFont, (New-Object Drawing.Point 68, 25), [Drawing.Color]::White)
  [Windows.Forms.TextRenderer]::DrawText($g, 'Setup', $Font, (New-Object Drawing.Point 69, 45), (& $white 150))
  $x = 38; $top = 112; $gap = 46; $r = 12
  for ($k = 0; $k -lt $StepNames.Count; $k++) {
    $y = $top + $k * $gap
    if ($k -gt 0) { $g.DrawLine((New-Object Drawing.Pen $(if ($k -le $script:Step) { $Brand } else { & $white 45 }), 2), $x, ($y - $gap + $r + 4), $x, ($y - $r - 4)) }
    $num = "$($k + 1)"
    if ($k -lt $script:Step) {
      $g.FillEllipse((New-Object Drawing.SolidBrush $Brand), ($x - $r), ($y - $r), (2 * $r), (2 * $r))
      $pen = New-Object Drawing.Pen ([Drawing.Color]::White), 2; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
      $g.DrawLines($pen, [Drawing.PointF[]]@((New-Object Drawing.PointF ($x - 5), $y), (New-Object Drawing.PointF ($x - 1.5), ($y + 3.5)), (New-Object Drawing.PointF ($x + 5), ($y - 4))))
      $label = & $white 210; $lf = $Font
    } elseif ($k -eq $script:Step) {
      $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(90, $Brand))), ($x - $r - 5), ($y - $r - 5), (2 * $r + 10), (2 * $r + 10))
      $g.FillEllipse([Drawing.Brushes]::White, ($x - $r), ($y - $r), (2 * $r), (2 * $r))
      [Windows.Forms.TextRenderer]::DrawText($g, $num, $SmallBold, (New-Object Drawing.Rectangle ($x - $r), ($y - $r), (2 * $r), (2 * $r)), $Brand, [Windows.Forms.TextFormatFlags]'HorizontalCenter, VerticalCenter, SingleLine')
      $label = [Drawing.Color]::White; $lf = $HeadFont
    } else {
      $g.DrawEllipse((New-Object Drawing.Pen (& $white 70), 1.5), ($x - $r), ($y - $r), (2 * $r), (2 * $r))
      [Windows.Forms.TextRenderer]::DrawText($g, $num, $SmallBold, (New-Object Drawing.Rectangle ($x - $r), ($y - $r), (2 * $r), (2 * $r)), (& $white 140), [Windows.Forms.TextFormatFlags]'HorizontalCenter, VerticalCenter, SingleLine')
      $label = & $white 130; $lf = $Font
    }
    [Windows.Forms.TextRenderer]::DrawText($g, $StepNames[$k], $lf, (New-Object Drawing.Rectangle ($x + 24), ($y - 14), 160, 28), $label, [Windows.Forms.TextFormatFlags]'VerticalCenter, SingleLine')
  }
})

$host_ = New-Object Windows.Forms.Panel; $host_.Dock = 'Fill'; $host_.Padding = New-Object Windows.Forms.Padding(36, 26, 20, 4)
$outer.Controls.Add($host_, 1, 0)

# Buttons along the bottom, under a hairline.
$nav = New-Object Windows.Forms.FlowLayoutPanel; $nav.Dock = 'Fill'; $nav.AutoSize = $true; $nav.FlowDirection = 'RightToLeft'
$nav.Padding = New-Object Windows.Forms.Padding(24, 14, 28, 14); $nav.Margin = New-Object Windows.Forms.Padding(0)
$nav.Add_Paint({ $_.Graphics.DrawLine((New-Object Drawing.Pen $Line), 0, 0, $this.Width, 0) })
$outer.Controls.Add($nav, 1, 1)
function New-NavButton([string]$text) { $b = New-Object Windows.Forms.Button; $b.Text = $text; $b.AutoSize = $true; $b.MinimumSize = New-Object Drawing.Size(104, 36); $b.Margin = New-Object Windows.Forms.Padding(8, 0, 0, 0); $nav.Controls.Add($b); $b }
$btnNext = New-NavButton 'Next'
$btnBack = New-NavButton 'Back'
$btnCancel = New-NavButton 'Cancel'
Set-ButtonLook $btnNext 'primary'; Set-ButtonLook $btnBack; Set-ButtonLook $btnCancel
$btnCancel.Margin = New-Object Windows.Forms.Padding(0, 0, 16, 0) # (set apart from Back / Next)

# Pages: a top-to-bottom flow of headings, notes and controls, some of them grouped in cards (Start-Card / End-Card).
$Pages = @()
$Notes = New-Object Collections.Generic.List[object]
$Cards = New-Object Collections.Generic.List[object]
$Stretch = New-Object Collections.Generic.List[object] # controls as wide as the card they're in
function New-Page([string]$heading) {
  $p = New-Object Windows.Forms.FlowLayoutPanel; $p.Dock = 'Fill'; $p.FlowDirection = 'TopDown'; $p.WrapContents = $false; $p.AutoScroll = $true
  $p.Visible = $false; $host_.Controls.Add($p)
  $n = New-Object Windows.Forms.Label; $n.Text = "STEP $($script:Pages.Count + 1) OF $($StepNames.Count)"; $n.AutoSize = $true; $n.Font = $SmallBold; $n.ForeColor = $Brand
  $n.Margin = New-Object Windows.Forms.Padding(1, 0, 0, 2)
  $t = New-Object Windows.Forms.Label; $t.Text = $heading; $t.AutoSize = $true; $t.Font = $TitleFont; $t.Margin = New-Object Windows.Forms.Padding(0, 0, 0, 10)
  $p.Controls.AddRange(@($n, $t))
  $script:Pages += $p; $script:Page = $p; $script:Into = $p
  $p
}
# A soft rounded box that the Add-* helpers fill until End-Card.
function Start-Card {
  $c = New-MvCard
  $script:Page.Controls.Add($c); $Cards.Add($c); $script:Into = $c; $c
}
function End-Card { $script:Into = $script:Page }
function Add-Ctl($c, [int]$indent = 0) { $c.Margin = New-Object Windows.Forms.Padding($indent, $c.Margin.Top, 0, $c.Margin.Bottom); $script:Into.Controls.Add($c); $c }
function Add-Heading([string]$text) {
  # (The first thing in a card sits at its top; elsewhere a heading gets room above it.)
  $first = $script:Into -ne $script:Page -and $script:Into.Controls.Count -eq 0
  $l = New-Object Windows.Forms.Label; $l.AutoSize = $true; $l.Text = $text; $l.Font = $HeadFont; $l.Margin = New-Object Windows.Forms.Padding(0, $(if ($first) { 0 } else { 14 }), 0, 4)
  $script:Into.Controls.Add($l); $l
}
function Add-Note([string]$text, $color = $null, [int]$indent = 0) {
  $l = New-Object Windows.Forms.Label; $l.AutoSize = $true; $l.Text = $text; $l.Margin = New-Object Windows.Forms.Padding($indent, 0, 0, 6)
  $l.ForeColor = if ($color) { $color } else { $Ink }
  $Notes.Add($l); $script:Into.Controls.Add($l); $l
}
function Add-Check([string]$text, [bool]$checked, [int]$indent = 12) {
  $c = New-Object Windows.Forms.CheckBox; $c.Text = $text; $c.Checked = $checked; $c.AutoSize = $true
  $c.Margin = New-Object Windows.Forms.Padding($indent, 4, 0, 4); $script:Into.Controls.Add($c); $c
}
# A row: label + control (+ a status label after it).
function Add-Field([string]$label, $ctl, [int]$labelWidth = 150) {
  $row = New-Object Windows.Forms.FlowLayoutPanel; $row.AutoSize = $true; $row.WrapContents = $false
  $row.Margin = New-Object Windows.Forms.Padding($(if ($script:Into -eq $script:Page) { 12 } else { 0 }), 2, 0, 4)
  $l = New-Object Windows.Forms.Label; $l.Text = $label; $l.AutoSize = $false; $l.Width = $labelWidth; $l.Height = 28; $l.TextAlign = 'MiddleLeft'
  $ctl.Margin = New-Object Windows.Forms.Padding(0, 3, 0, 0)
  $s = New-Object Windows.Forms.Label; $s.AutoSize = $true; $s.Margin = New-Object Windows.Forms.Padding(10, 7, 0, 0); $s.ForeColor = $Grey
  $row.Controls.AddRange(@($l, $ctl, $s)); $script:Into.Controls.Add($row)
  $s
}
function New-PortBox([int]$value) {
  $n = New-Object Windows.Forms.NumericUpDown; $n.Minimum = 1; $n.Maximum = 65535; $n.Value = $value; $n.Width = 90; $n
}
function Open-Target([string]$t) { if ($t) { Start-Process $t } }
function Show-Msg([string]$text, $icon = 'Warning') { [Windows.Forms.MessageBox]::Show($text, $Title, 'OK', $icon) | Out-Null }

# ---------- 1. welcome ----------
[void](New-Page 'Set up Media Vault')
[void](Add-Note "Media Vault is your own photo, GIF and video library, running on this PC. This sets it up: which ports it uses, your account, its private https:// address over Tailscale, the hosted-sites server and any servers your sites need (like CubeWord's save server), and how it starts with Windows.`n`nIt takes a few minutes. All you need is an email address and a password for your account; Tailscale is optional. The defaults are fine for almost everyone - just press Next. Nothing changes until the last step, and you can run setup again any time (setup.bat).")
[void](Start-Card)
[void](Add-Heading 'This PC')
$chkFolder = Add-Note '' $null
$chkExe = Add-Note '' $null
$btnPbGet = New-Object Windows.Forms.Button; $btnPbGet.Text = 'Try the download again'; $btnPbGet.AutoSize = $true; $btnPbGet.Visible = $false
[void](Add-Ctl $btnPbGet 0)
$script:PbState = '' # '' / 'downloading' / 'failed: why'
# pocketbase.exe isn't in a git checkout: fetch the pinned build (mv-common.ps1) with progress on this page.
function Get-PocketBase {
  if ((Test-Path $Exe) -or $script:PbState -eq 'downloading') { return }
  $script:PbState = 'downloading'; $btnPbGet.Visible = $false; $btnNext.Enabled = $false; Update-Welcome
  try {
    Install-MvPocketBase $Root { param($n) $chkExe.Text = "pocketbase.exe: downloading PocketBase $MvPbVersion... {0:N1} MB" -f ($n / 1MB) }
    $script:PbState = ''
  } catch { $script:PbState = "failed: $($_.Exception.Message)" }
  $btnNext.Enabled = $true; Update-Welcome
}
$btnPbGet.Add_Click({ Get-PocketBase })
$chkData = Add-Note '' $null
$chkTs = Add-Note '' $null
End-Card
function Update-Welcome {
  if ($env:OneDrive -and $Root.StartsWith($env:OneDrive, [StringComparison]::OrdinalIgnoreCase)) {
    $chkFolder.Text = "Folder: $Root`n  Inside OneDrive - syncing a live database can corrupt it. Better to move this folder out (e.g. to C:\Media Vault) first."
    $chkFolder.ForeColor = $Amber
  } else { $chkFolder.Text = "Folder: $Root"; $chkFolder.ForeColor = $Ink }
  $btnPbGet.Visible = $false
  if (Test-Path $Exe) { $chkExe.Text = 'pocketbase.exe: found'; $chkExe.ForeColor = $Green }
  elseif ($script:PbState -eq 'downloading') { $chkExe.ForeColor = $Amber; if ($chkExe.Text -notmatch 'downloading') { $chkExe.Text = "pocketbase.exe: downloading PocketBase $MvPbVersion (about 13 MB)..." } }
  elseif ($script:PbState) {
    $chkExe.Text = "pocketbase.exe: $($script:PbState.Substring(8)). Check the internet connection and try again - or download PocketBase $MvPbVersion for Windows from github.com/pocketbase/pocketbase/releases and put pocketbase.exe in this folder."
    $chkExe.ForeColor = $Red; $btnPbGet.Visible = $true
  } else { $chkExe.Text = "pocketbase.exe: not here yet - it's downloaded automatically (PocketBase $MvPbVersion)"; $chkExe.ForeColor = $Amber }
  if ($HasData) { $chkData.Text = "Library: found ($(if ($Old.dataDir) { $OldData } else { 'pb_data' })) - your photos, accounts and sites are kept as they are"; $chkData.ForeColor = $Green }
  else { $chkData.Text = 'Library: none yet - a new, empty one is made the first time Media Vault starts'; $chkData.ForeColor = $Ink }
  if (-not $Ts.Installed) { $chkTs.Text = "Tailscale: not installed (optional - for the https:// address and public sites; see the Tailscale step)"; $chkTs.ForeColor = $Amber }
  elseif ($Ts.State -eq 'Running') { $chkTs.Text = "Tailscale: connected as $($Ts.Dns)"; $chkTs.ForeColor = $Green }
  else { $chkTs.Text = "Tailscale: installed, not connected ($($Ts.State))"; $chkTs.ForeColor = $Amber }
}

# ---------- 2. servers ----------
[void](New-Page 'Servers')
[void](Add-Note 'Media Vault runs as two PocketBase servers on this PC, on ports of their own. The defaults are fine unless something else already uses them (port 8090 is often taken by another PocketBase app).')
[void](Start-Card)
[void](Add-Heading 'Media Vault')
$numVault = New-PortBox $Want.vaultPort
$stVault = Add-Field 'Port' $numVault
[void](Add-Note 'The library itself: the app, the Android app, share links and the admin dashboard. Reachable from this PC, your home Wi-Fi and Tailscale - never the public internet.' $Grey)
End-Card
[void](Start-Card)
[void](Add-Heading 'Sites server')
$numSites = New-PortBox $Want.sitesPort
$stSites = Add-Field 'Port' $numSites
[void](Add-Note "Serves the HTML projects you publish from Media Vault > Sites (games like CubeWord, portfolios...) at http://<this PC>:<port>/<site>/. It's a second, separate PocketBase on purpose, so a hosted page can't read your Media Vault login. It has no admin of its own; its files are in pb_sites\www." $Grey)
End-Card
[void](Start-Card)
[void](Add-Heading 'Where your library is stored')
$txtData = New-Object Windows.Forms.TextBox; $txtData.ReadOnly = $true; $txtData.Margin = New-Object Windows.Forms.Padding(0, 2, 0, 4)
[void](Add-Ctl $txtData 0); $Stretch.Add($txtData)
$btnDataPick = New-Object Windows.Forms.Button; $btnDataPick.Text = 'Change...'; $btnDataPick.AutoSize = $true; Set-ButtonLook $btnDataPick
$btnDataDefault = New-Object Windows.Forms.Button; $btnDataDefault.Text = 'Use the default'; $btnDataDefault.AutoSize = $true; Set-ButtonLook $btnDataDefault
$dataRow = New-Object Windows.Forms.FlowLayoutPanel; $dataRow.AutoSize = $true; $dataRow.WrapContents = $false
$btnDataPick.Margin = New-Object Windows.Forms.Padding(0, 0, 8, 0); $btnDataDefault.Margin = New-Object Windows.Forms.Padding(0)
$dataRow.Controls.AddRange(@($btnDataPick, $btnDataDefault)); [void](Add-Ctl $dataRow 0)
$stData = Add-Note '' $Grey
[void](Add-Note "Your photos, videos, files, accounts and locked folder - everything people upload. The default is pb_data in Media Vault's folder; choose a folder on another drive if this one is small. Not a OneDrive, Dropbox or network folder: syncing a live database can corrupt it." $Grey)
End-Card
# The folder chosen ('' = the default pb_data), the problem with a folder ('' if none), and what happens to it.
$script:DataPick = $Want.dataDir
function Get-DataPath([string]$pick) { Get-MvDataDir $Root @{ dataDir = $pick } }
function Get-FolderBytes([string]$dir) {
  $b = 0L; if (Test-Path -LiteralPath $dir) { foreach ($f in (New-Object IO.DirectoryInfo $dir).EnumerateFiles('*', 'AllDirectories')) { $b += $f.Length } }; $b
}
function Test-DataDir([string]$full) {
  $def = Join-Path $Root 'pb_data'
  if ($full -eq $OldData) { return '' }
  if ($full.StartsWith('\\')) { return 'Network folders are too slow and unreliable for a live database - pick a folder on a drive in this PC.' }
  if (-not [IO.Path]::IsPathRooted($full)) { return 'Pick a whole folder path, like D:\Media Vault library.' }
  try { $drv = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($full)) } catch { return "Can't use $full." }
  if (-not $drv.IsReady) { return "Drive $($drv.Name) isn't available - plug it in, or pick another." }
  if ("$($drv.DriveType)" -eq 'Network') { return 'Network drives are too slow and unreliable for a live database - pick a drive in this PC.' }
  foreach ($cloud in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial) | Where-Object { $_ }) {
    if ($full.StartsWith($cloud, [StringComparison]::OrdinalIgnoreCase)) { return 'That folder is synced by OneDrive, which can corrupt a live database. Pick one outside OneDrive.' }
  }
  if ($full -match '\\(Dropbox|Google Drive|iCloudDrive)(\\|$)') { return 'That folder is synced to the cloud, which can corrupt a live database. Pick one that isn''t.' }
  if ($full -ne $def -and ($full -eq $Root -or $full.StartsWith("$Root\", [StringComparison]::OrdinalIgnoreCase))) {
    return "Inside Media Vault's folder only the default (pb_data) can be used - other folders there are shown to browsers or replaced by updates. Pick one outside it, or press Use the default."
  }
  if ($HasData -and ($full.StartsWith("$OldData\", [StringComparison]::OrdinalIgnoreCase) -or $OldData.StartsWith("$full\", [StringComparison]::OrdinalIgnoreCase))) {
    return "The library can't be moved into a folder inside itself (or the other way round). Pick a separate folder."
  }
  $hasLib = Test-Path -LiteralPath (Join-Path $full 'data.db')
  if ($HasData -and -not $hasLib -and (Test-Path -LiteralPath $full) -and @(Get-ChildItem -LiteralPath $full -Force -ErrorAction SilentlyContinue).Count) {
    return "$full isn't empty. Pick an empty folder (or a new one) for the library."
  }
  # Moving to another drive copies it, so that drive needs room for all of it.
  if ($HasData -and -not $hasLib -and [IO.Path]::GetPathRoot($full) -ne [IO.Path]::GetPathRoot($OldData)) {
    if ($null -eq $script:OldDataBytes) { $script:OldDataBytes = Get-FolderBytes $OldData }
    if ($drv.AvailableFreeSpace -lt $script:OldDataBytes * 1.05 + 1GB) { return ('Drive {0} has {1:N1} GB free; the library needs {2:N1} GB. Pick a drive with more room.' -f $drv.Name, ($drv.AvailableFreeSpace / 1GB), ($script:OldDataBytes / 1GB)) }
  }
  ''
}
function Update-DataStatus {
  $full = Get-DataPath $script:DataPick
  $txtData.Text = $full
  $btnDataDefault.Enabled = [bool]$script:DataPick
  $hasLib = Test-Path -LiteralPath (Join-Path $full 'data.db')
  $stData.ForeColor = $Grey
  $stData.Text = if ($full -eq $OldData) { $(if ($HasData) { 'Your library is here now.' } else { 'A new, empty library is made here the first time Media Vault starts.' }) }
    elseif ($HasData -and $hasLib) { 'That folder has a Media Vault library of its own - setup switches to it, and your current one stays where it is.' }
    elseif ($HasData) { $(if ([IO.Path]::GetPathRoot($full) -eq [IO.Path]::GetPathRoot($OldData)) { 'Setup moves your library here (Media Vault stops for a moment while it does).' } else { 'Setup copies your library here and checks the copy; the old folder is kept, renamed, until you delete it. Media Vault is stopped while it copies.' }) }
    elseif ($hasLib) { 'That folder has a Media Vault library - setup uses it.' }
    else { 'A new, empty library is made here the first time Media Vault starts.' }
  $bad = Test-DataDir $full
  if ($bad) { $stData.Text = $bad; $stData.ForeColor = $Red }
}
$btnDataPick.Add_Click({
  $fb = New-Object Windows.Forms.FolderBrowserDialog
  $fb.Description = 'Choose where your library is stored - an empty folder (or make one with "Make New Folder"), e.g. D:\Media Vault library'
  $fb.SelectedPath = Get-DataPath $script:DataPick
  if ($fb.ShowDialog($form) -ne 'OK') { return }
  $p = $fb.SelectedPath.TrimEnd('\')
  # A folder with other things in it gets a folder of its own inside it (e.g. picking D:\ itself).
  if ($p -match '^[A-Za-z]:$' -or -not (Test-Path -LiteralPath (Join-Path $p 'data.db')) -and @(Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue).Count) { $p = Join-Path $p 'Media Vault library' }
  $script:DataPick = if ($p -eq (Join-Path $Root 'pb_data')) { '' } else { $p }
  Update-DataStatus
})
$btnDataDefault.Add_Click({ $script:DataPick = ''; Update-DataStatus })
Update-DataStatus

function Update-PortStatus {
  foreach ($x in @(@($numVault, $stVault, $Old.vaultPort), @($numSites, $stSites, $Old.sitesPort))) {
    $u = Get-PortUse ([int]$x[0].Value) $Root
    $x[1].Text = $u.Text
    $x[1].ForeColor = if ($u.Free -or $u.Ours) { $Green } else { $Red }
  }
}
$numVault.Add_ValueChanged({ Update-PortStatus }); $numSites.Add_ValueChanged({ Update-PortStatus })

# ---------- 3. admin ----------
[void](New-Page 'Your account')
[void](Add-Note 'One email and password for you. Setup makes them your Media Vault account - the owner, who invites people and manages storage and Sites - and the admin dashboard account (PocketBase''s back office at http://localhost:<port>/_/, which only opens on this PC).')
[void](Start-Card)
[void](Add-Heading 'Your account')
$adminPanel = New-Object Windows.Forms.FlowLayoutPanel; $adminPanel.FlowDirection = 'TopDown'; $adminPanel.AutoSize = $true; $adminPanel.WrapContents = $false
$adminPanel.Margin = New-Object Windows.Forms.Padding(0, 0, 0, 6)
[void]$script:Into.Controls.Add($adminPanel)
$rbKeep = New-Object Windows.Forms.RadioButton; $rbKeep.Text = 'Keep the accounts as they are'; $rbKeep.AutoSize = $true; $rbKeep.Margin = New-Object Windows.Forms.Padding(0, 2, 0, 2)
$rbSet = New-Object Windows.Forms.RadioButton; $rbSet.Text = 'Set the admin dashboard account (email + password) - and make it your Media Vault account if there''s none yet'; $rbSet.AutoSize = $true; $rbSet.Margin = New-Object Windows.Forms.Padding(0, 2, 0, 2)
$adminPanel.Controls.AddRange(@($rbKeep, $rbSet))
$txtEmail = New-Object Windows.Forms.TextBox; $txtEmail.Width = 280
$txtPass = New-Object Windows.Forms.TextBox; $txtPass.Width = 280; $txtPass.UseSystemPasswordChar = $true
$txtPass2 = New-Object Windows.Forms.TextBox; $txtPass2.Width = 280; $txtPass2.UseSystemPasswordChar = $true
[void](Add-Field 'Email' $txtEmail 140)
[void](Add-Field 'Password' $txtPass 140)
$stPass = Add-Field 'Password again' $txtPass2 140
[void](Add-Note 'At least 10 characters. Write it down somewhere safe. You sign in to Media Vault with it on any device; the admin dashboard takes it only on this PC.' $Grey)
[void](Add-Note 'Later, a new password set in the app changes your Media Vault sign-in only - run setup to change the dashboard''s too. Other people get their own accounts with invite codes (Media Vault''s menu > Invite people).' $Grey)
End-Card
if ($Fresh) { $rbKeep.Visible = $false; $rbSet.Visible = $false; $rbSet.Checked = $true } elseif ($Want.admin) { $rbSet.Checked = $true } else { $rbKeep.Checked = $true }
function Update-Admin { foreach ($c in $txtEmail, $txtPass, $txtPass2) { $c.Enabled = $rbSet.Checked } }
$rbKeep.Add_CheckedChanged({ Update-Admin }); $rbSet.Add_CheckedChanged({ Update-Admin })

# ---------- 4. tailscale ----------
[void](New-Page 'Tailscale')
[void](Add-Note 'Tailscale (free for personal use) gives your phones and laptops a private https:// address for Media Vault that works from anywhere, and can make hosted sites public with Funnel. Without it, Media Vault still works on your home Wi-Fi.')
[void](Start-Card)
$tsState = Add-Note '' $null 0
$tsRow = New-Object Windows.Forms.FlowLayoutPanel; $tsRow.AutoSize = $true; $tsRow.WrapContents = $false
$btnTsGet = New-Object Windows.Forms.Button; $btnTsGet.Text = 'Get Tailscale'; $btnTsGet.AutoSize = $true
$btnTsLogin = New-Object Windows.Forms.Button; $btnTsLogin.Text = 'Sign in'; $btnTsLogin.AutoSize = $true
$btnTsCheck = New-Object Windows.Forms.Button; $btnTsCheck.Text = 'Check again'; $btnTsCheck.AutoSize = $true
foreach ($b in $btnTsGet, $btnTsLogin) { $b.Margin = New-Object Windows.Forms.Padding(0, 0, 8, 0) }
$tsRow.Controls.AddRange(@($btnTsGet, $btnTsLogin, $btnTsCheck))
[void](Add-Ctl $tsRow 0)
End-Card
$btnTsGet.Add_Click({ Open-Target 'https://tailscale.com/download/windows' })
$btnTsLogin.Add_Click({
  $ipn = Join-Path $env:ProgramFiles 'Tailscale\tailscale-ipn.exe'
  if (Test-Path $ipn) { Start-Process $ipn }
  Show-Msg "Sign in from the Tailscale icon in the taskbar's notification area (by the clock), then press Check again." 'Information'
})
$btnTsCheck.Add_Click({ $form.Cursor = 'WaitCursor'; $script:Ts = Get-MvTailscale; $form.Cursor = 'Default'; Update-Tailscale; Update-Welcome })

[void](Start-Card)
[void](Add-Heading "Media Vault's https:// address")
$vaultPanel = New-Object Windows.Forms.FlowLayoutPanel; $vaultPanel.FlowDirection = 'TopDown'; $vaultPanel.AutoSize = $true; $vaultPanel.WrapContents = $false
[void](Add-Ctl $vaultPanel)
$VaultRadios = [ordered]@{}
foreach ($o in @(@('tailnet', 'On - for your devices on Tailscale only (recommended; never public)'), @('off', 'Off'))) {
  $rb = New-Object Windows.Forms.RadioButton; $rb.Text = $o[1]; $rb.Tag = $o[0]; $rb.AutoSize = $true; $rb.Margin = New-Object Windows.Forms.Padding(0, 2, 0, 2)
  $vaultPanel.Controls.Add($rb); $VaultRadios[$o[0]] = $rb
}
$vaultAddr = Add-Note '' $Brand 18
End-Card
[void](Start-Card)
[void](Add-Heading 'Hosted sites')
$sitesPanel = New-Object Windows.Forms.FlowLayoutPanel; $sitesPanel.FlowDirection = 'TopDown'; $sitesPanel.AutoSize = $true; $sitesPanel.WrapContents = $false
[void](Add-Ctl $sitesPanel)
$SitesRadios = [ordered]@{}
foreach ($o in @(@('public', 'Public - anyone with the link, no Tailscale needed (Funnel)'), @('tailnet', 'Tailnet only - just your devices on Tailscale'), @('off', 'No https:// address - only http://<this PC>:<sites port>/ at home and on Tailscale'))) {
  $rb = New-Object Windows.Forms.RadioButton; $rb.Text = $o[1]; $rb.Tag = $o[0]; $rb.AutoSize = $true; $rb.Margin = New-Object Windows.Forms.Padding(0, 2, 0, 2)
  $sitesPanel.Controls.Add($rb); $SitesRadios[$o[0]] = $rb
}
$sitesAddr = Add-Note '' $Brand 18
End-Card
$tsTake = Add-Note '' $Amber
[void](Add-Note "Each site also has its own setting in Media Vault > Sites (public, password or private), so a public address doesn't make every site open. The first time, Tailscale may ask in your browser to turn on HTTPS certificates or Funnel for your tailnet - setup opens that page." $Grey)
$VaultRadios[$Want.vaultMode].Checked = $true; $SitesRadios[$Want.sitesMode].Checked = $true
function Update-Tailscale {
  $ok = $Ts.Installed -and $Ts.State -eq 'Running'
  if (-not $Ts.Installed) { $tsState.Text = 'Tailscale is not installed. Install it, sign in, then press Check again - or skip this step.'; $tsState.ForeColor = $Amber }
  elseif (-not $ok) { $tsState.Text = "Tailscale is installed but not connected ($($Ts.State)). Sign in, then press Check again - or skip this step."; $tsState.ForeColor = $Amber }
  else { $tsState.Text = "Connected as $($Ts.Dns) ($($Ts.Ip))"; $tsState.ForeColor = $Green }
  $btnTsGet.Visible = -not $Ts.Installed; $btnTsLogin.Visible = $Ts.Installed -and -not $ok
  $vaultPanel.Enabled = $ok; $sitesPanel.Enabled = $ok
  $d = if ($Ts.Dns) { $Ts.Dns } else { '<this PC>.<tailnet>.ts.net' }
  $vaultAddr.Text = if (-not $ok) { 'Skipped - Tailscale is not connected.' } elseif ($VaultRadios.tailnet.Checked) { "https://${d}:$MvVaultHttps/" } else { "Use http://$($Ts.Ip):$([int]$numVault.Value)/ instead." }
  $sitesAddr.Text = if (-not $ok) { 'Skipped - Tailscale is not connected.' } elseif ($SitesRadios.off.Checked) { "http://<this PC>:$([int]$numSites.Value)/<site>/" } else { "https://$d/<site>/" }
  # Addresses already in use by something else on this PC (e.g. another copy of Media Vault).
  $busy = @()
  if ($ok) { foreach ($h in $MvVaultHttps, $MvSitesHttps) { $cur = $Ts.Entries[$h]; if ($cur -and -not (Test-OurPort $cur.Port)) { $busy += "$h (now 127.0.0.1:$($cur.Port))" } } }
  $tsTake.Visible = $busy.Count -gt 0
  $tsTake.Text = "Tailscale already uses https port $($busy -join ' and ') for another server on this PC - maybe another copy of Media Vault. Turning that address on here would take it over, so it starts off. Leave it off unless you mean to replace the other one."
}
foreach ($rb in @($VaultRadios.Values) + @($SitesRadios.Values)) { $rb.Add_CheckedChanged({ if ($this.Checked) { Update-Tailscale } }) }

# ---------- 5. site backends ----------
[void](New-Page 'Site backends')
[void](Add-Note "Some sites need a server of their own - CubeWord, for example, keeps players' accounts and cloud saves in its own PocketBase. Each backend is a folder with its own PocketBase data and code (pb_hooks, pb_migrations). Media Vault starts it along with the other two, shows it in its window, and can give it an https:// address. Leave the list empty if your sites don't need one.")
$bkList = New-Object Windows.Forms.ListView; $bkList.View = 'Details'; $bkList.FullRowSelect = $true; $bkList.HideSelection = $false; $bkList.MultiSelect = $false
$bkList.Width = 620; $bkList.Height = 160; $bkList.BorderStyle = 'None'; $bkList.BackColor = $CardBg
foreach ($c in @(@('Name', 140), @('Port', 60), @('Address', 220), @('Folder', 200))) { [void]$bkList.Columns.Add($c[0], $c[1]) }
# The folder column takes what's left, so the list never scrolls sideways.
$bkList.Add_Resize({ $this.Columns[3].Width = [math]::Max(120, $this.ClientSize.Width - 140 - 60 - 220) })
[void](Start-Card)
[void](Add-Ctl $bkList 0); $Stretch.Add($bkList)
$bkRow = New-Object Windows.Forms.FlowLayoutPanel; $bkRow.AutoSize = $true; $bkRow.WrapContents = $false; $bkRow.Margin = New-Object Windows.Forms.Padding(0, 10, 0, 4)
$btnBkAdd = New-Object Windows.Forms.Button; $btnBkAdd.Text = 'Add...'; $btnBkAdd.AutoSize = $true
$btnBkEdit = New-Object Windows.Forms.Button; $btnBkEdit.Text = 'Edit...'; $btnBkEdit.AutoSize = $true
$btnBkDel = New-Object Windows.Forms.Button; $btnBkDel.Text = 'Remove'; $btnBkDel.AutoSize = $true
foreach ($b in $btnBkAdd, $btnBkEdit) { $b.Margin = New-Object Windows.Forms.Padding(0, 0, 8, 0) }
$bkRow.Controls.AddRange(@($btnBkAdd, $btnBkEdit, $btnBkDel))
[void](Add-Ctl $bkRow 0)
End-Card
Set-ButtonLook $btnBkAdd 'primary'
$bkFound = Add-Note '' $Amber
[void](Add-Note "A site talks to its backend at the address shown above, so put that into the site (in CubeWord it's SAVE_SERVER near the top of index.html). Public backends should only answer what the site needs; CubeWord's does that with pb_hooks\public_only.pb.js. Removing one here only stops Media Vault starting it - its folder and data stay." $Grey)

function Get-BackendAddress($b) {
  $d = if ($Ts.Dns) { $Ts.Dns } else { '<this PC>.ts.net' }
  switch ($b.access) {
    'public' { "https://${d}:$($b.httpsPort)/ (public)" }
    'tailnet' { "https://${d}:$($b.httpsPort)/ (tailnet)" }
    default { "http://127.0.0.1:$($b.port)/ (this PC only)" }
  }
}
function Update-Backends {
  $bkList.Items.Clear()
  foreach ($b in $Want.backends) {
    $it = New-Object Windows.Forms.ListViewItem($b.name)
    [void]$it.SubItems.Add("$($b.port)"); [void]$it.SubItems.Add((Get-BackendAddress $b)); [void]$it.SubItems.Add((Resolve-MvDir $Root $b.dir))
    $it.Tag = $b; [void]$bkList.Items.Add($it)
  }
  $found = @($Want.backends | Where-Object { $_.note })
  $bkFound.Visible = $found.Count -gt 0
  $bkFound.Text = 'Found on this PC: ' + (($found | ForEach-Object { "$($_.name) ($($_.note))" }) -join ', ') + ". Check them - remove any Media Vault shouldn't start."
  $btnBkEdit.Enabled = $false; $btnBkDel.Enabled = $false
}
$bkList.Add_SelectedIndexChanged({ $sel = $bkList.SelectedItems.Count -gt 0; $btnBkEdit.Enabled = $sel; $btnBkDel.Enabled = $sel })

# Add / edit one backend in a small dialog. Returns the backend, or $null on Cancel.
function Edit-Backend($b) {
  $isNew = -not $b
  if ($isNew) {
    $taken = @([int]$numVault.Value, [int]$numSites.Value) + @($Want.backends | ForEach-Object { $_.port })
    $usedHttps = @($Want.backends | ForEach-Object { $_.httpsPort })
    $b = @{ name = ''; dir = ''; port = (Get-MvFreePort $taken); httpsPort = $(if ($usedHttps -notcontains 10000) { 10000 } else { 0 }); access = 'off'; note = '' }
  }
  $dlg = New-Object Windows.Forms.Form; $dlg.Text = $(if ($isNew) { 'Add a site backend' } else { 'Edit site backend' }); $dlg.Font = $Font
  $dlg.FormBorderStyle = 'FixedDialog'; $dlg.MaximizeBox = $false; $dlg.MinimizeBox = $false; $dlg.StartPosition = 'CenterParent'
  $dlg.AutoSize = $true; $dlg.AutoSizeMode = 'GrowAndShrink'; $dlg.BackColor = [Drawing.Color]::White
  $f = New-Object Windows.Forms.TableLayoutPanel; $f.AutoSize = $true; $f.ColumnCount = 3; $f.Padding = New-Object Windows.Forms.Padding(14)
  $dlg.Controls.Add($f)
  function Row([string]$label, $ctl, $extra = $null) {
    $l = New-Object Windows.Forms.Label; $l.Text = $label; $l.AutoSize = $true; $l.Margin = New-Object Windows.Forms.Padding(0, 7, 10, 0)
    $f.Controls.Add($l); $f.Controls.Add($ctl); if ($extra) { $f.Controls.Add($extra) } else { $f.Controls.Add((New-Object Windows.Forms.Label -Property @{ AutoSize = $true })) }
  }
  $tName = New-Object Windows.Forms.TextBox; $tName.Width = 300; $tName.Text = $b.name
  $tDir = New-Object Windows.Forms.TextBox; $tDir.Width = 300; $tDir.Text = $b.dir
  $bDir = New-Object Windows.Forms.Button; $bDir.Text = 'Browse...'; $bDir.AutoSize = $true
  $nPort = New-PortBox $b.port
  $cAccess = New-Object Windows.Forms.ComboBox; $cAccess.DropDownStyle = 'DropDownList'; $cAccess.Width = 300
  $AccessKeys = @('public', 'tailnet', 'off')
  [void]$cAccess.Items.AddRange(@('Public - anyone (Tailscale Funnel)', 'Tailnet only (tailscale serve)', 'No https:// address (this PC only)'))
  $cAccess.SelectedIndex = [array]::IndexOf($AccessKeys, $b.access)
  $cHttps = New-Object Windows.Forms.ComboBox; $cHttps.Width = 90; [void]$cHttps.Items.AddRange(@('10000', '8443', '443'))
  $cHttps.Text = $(if ($b.httpsPort) { "$($b.httpsPort)" } else { '10000' })
  $hint = New-Object Windows.Forms.Label; $hint.AutoSize = $true; $hint.ForeColor = $Grey; $hint.MaximumSize = New-Object Drawing.Size(420, 0)
  Row 'Name' $tName
  Row 'Folder' $tDir $bDir
  Row 'Local port' $nPort
  Row 'https:// address' $cAccess
  Row 'https port' $cHttps
  $f.Controls.Add((New-Object Windows.Forms.Label)); $f.Controls.Add($hint); $f.SetColumnSpan($hint, 2)
  $btns = New-Object Windows.Forms.FlowLayoutPanel; $btns.AutoSize = $true; $btns.FlowDirection = 'RightToLeft'; $btns.Dock = 'Fill'
  $ok = New-Object Windows.Forms.Button; $ok.Text = 'OK'; $ok.MinimumSize = New-Object Drawing.Size(88, 28)
  $cancel = New-Object Windows.Forms.Button; $cancel.Text = 'Cancel'; $cancel.DialogResult = 'Cancel'; $cancel.MinimumSize = New-Object Drawing.Size(88, 28)
  $btns.Controls.AddRange(@($ok, $cancel)); $f.Controls.Add($btns); $f.SetColumnSpan($btns, 3)
  $dlg.AcceptButton = $ok; $dlg.CancelButton = $cancel
  $showHint = {
    $k = $AccessKeys[$cAccess.SelectedIndex]; $cHttps.Enabled = $k -ne 'off'
    $d = if ($Ts.Dns) { $Ts.Dns } else { '<this PC>.ts.net' }
    $hint.Text = switch ($k) {
      'public' { "Sites call it at https://${d}:$($cHttps.Text)/ - anyone on the internet can reach it. Media Vault blocks its admin dashboard and superuser sign-in there (use http://127.0.0.1:$([int]$nPort.Value)/_/ on this PC) and limits each visitor to 300 requests per 10 seconds; its own API rules protect the rest. Funnel can only use ports 443, 8443 and 10000 (443 and 8443 are normally taken by the sites and Media Vault)." }
      'tailnet' { "Reachable at https://${d}:$($cHttps.Text)/ from your devices on Tailscale only (at most 300 requests per 10 seconds each)." }
      default { "Only programs on this PC can reach it (http://127.0.0.1:$([int]$nPort.Value)/)." }
    }
  }
  $cAccess.Add_SelectedIndexChanged($showHint); $cHttps.Add_TextChanged($showHint); $nPort.Add_ValueChanged($showHint); & $showHint
  $bDir.Add_Click({
    $fb = New-Object Windows.Forms.FolderBrowserDialog; $fb.Description = "The backend's folder (with its pb_hooks / pb_migrations / pb_data)"
    if ($tDir.Text -and (Test-Path -LiteralPath (Resolve-MvDir $Root $tDir.Text))) { $fb.SelectedPath = Resolve-MvDir $Root $tDir.Text }
    if ($fb.ShowDialog($dlg) -eq 'OK') {
      $tDir.Text = $fb.SelectedPath
      if (-not $tName.Text.Trim()) { $tName.Text = Get-MvBackendName $fb.SelectedPath }
    }
  })
  $ok.Add_Click({
    $dir = $tDir.Text.Trim(); $full = if ($dir) { Resolve-MvDir $Root $dir } else { '' }
    $k = $AccessKeys[$cAccess.SelectedIndex]; $hp = 0
    if (-not $tName.Text.Trim()) { Show-Msg 'Give it a name.'; return }
    if (-not $full -or -not (Test-Path -LiteralPath $full -PathType Container)) { Show-Msg 'Choose the folder it lives in.'; return }
    if ($full.TrimEnd('\') -eq $Root.TrimEnd('\') -or $full.StartsWith((Join-Path $Root 'pb_'), [StringComparison]::OrdinalIgnoreCase)) { Show-Msg "That's Media Vault's own folder. A backend needs a folder of its own."; return }
    $hasPb = @('pb_hooks', 'pb_migrations', 'pb_data') | Where-Object { Test-Path -LiteralPath (Join-Path $full $_) }
    if (-not $hasPb) {
      $a = [Windows.Forms.MessageBox]::Show("There's no PocketBase project in that folder yet (no pb_hooks, pb_migrations or pb_data).`n`nUse it as a new, empty backend? Setup makes the pb_hooks and pb_migrations folders; put the site's server code in them.", $Title, 'OKCancel', 'Question')
      if ($a -ne 'OK') { return }
    }
    if ($k -ne 'off') {
      if (-not (Test-MvPort $cHttps.Text)) { Show-Msg 'Enter the https port (e.g. 10000).'; return }
      $hp = [int]$cHttps.Text
      if ($k -eq 'public' -and $MvFunnelPorts -notcontains $hp) { Show-Msg "Tailscale Funnel can only publish ports 443, 8443 and 10000."; return }
    }
    $b.name = $tName.Text.Trim(); $b.dir = $dir; $b.port = [int]$nPort.Value; $b.httpsPort = $hp; $b.access = $k; $b.note = ''
    if (-not $hasPb) { foreach ($s in 'pb_hooks', 'pb_migrations') { New-Item -ItemType Directory -Force (Join-Path $full $s) | Out-Null } }
    $dlg.DialogResult = 'OK'
  })
  $dlg.ForeColor = $Ink; $f.Padding = New-Object Windows.Forms.Padding(20, 18, 20, 16)
  $ok.Margin = New-Object Windows.Forms.Padding(8, 14, 0, 0); $cancel.Margin = New-Object Windows.Forms.Padding(0, 14, 0, 0)
  Set-ButtonLook $ok 'primary'; Set-Looks $dlg
  $r = $dlg.ShowDialog($form)
  if ($r -eq 'OK') { $b } else { $null }
}
$btnBkAdd.Add_Click({ $b = Edit-Backend $null; if ($b) { $Want.backends = @($Want.backends) + @($b); Update-Backends } })
$btnBkEdit.Add_Click({ if ($bkList.SelectedItems.Count) { if (Edit-Backend $bkList.SelectedItems[0].Tag) { Update-Backends } } })
$bkList.Add_DoubleClick({ if ($bkList.SelectedItems.Count) { if (Edit-Backend $bkList.SelectedItems[0].Tag) { Update-Backends } } })
$btnBkDel.Add_Click({ if ($bkList.SelectedItems.Count) { $t = $bkList.SelectedItems[0].Tag; $Want.backends = @($Want.backends | Where-Object { -not [object]::ReferenceEquals($_, $t) }); Update-Backends } })

# ---------- 6. windows ----------
[void](New-Page 'Windows')
[void](Start-Card)
[void](Add-Heading 'Network')
$cbFirewall = Add-Check 'Let phones on home Wi-Fi and Tailscale through the Windows firewall (asks for admin)' $Want.firewall 0
$fwNote = Add-Note '' $Grey 18
End-Card
[void](Start-Card)
[void](Add-Heading 'Starting up')
$cbStartup = Add-Check 'Start Media Vault when I sign in to Windows (its window opens minimized)' $Want.startup 0
$cbDesktop = Add-Check 'Put a Media Vault shortcut on the desktop' $Want.desktop 0
$elsewhere = @(); if ($StartupNow -eq 'elsewhere') { $elsewhere += 'start-with-Windows' }; if ($DesktopNow -eq 'elsewhere') { $elsewhere += 'desktop' }
if ($elsewhere.Count) { [void](Add-Note "The $($elsewhere -join ' and ') shortcut already opens another copy of Media Vault. Ticking the box makes it open this copy instead." $Amber 18) }
$cbStart = Add-Check 'Start Media Vault when setup is done' $Want.startNow 0
End-Card
[void](Add-Note "Backends listen on 127.0.0.1 only and don't need the firewall; Tailscale reaches them from this PC. Closing the Media Vault window asks whether to stop the servers (its Settings tab can make that the default)." $Grey)

# Read-only text in a card (the review and the progress log).
function Add-TextCard([int]$height) {
  $t = New-Object Windows.Forms.TextBox; $t.Multiline = $true; $t.ReadOnly = $true; $t.ScrollBars = 'Vertical'; $t.BorderStyle = 'None'
  $t.Width = 620; $t.Height = $height; $t.BackColor = $CardBg; $t.Font = $MonoFont; $t.TabStop = $false
  [void](Start-Card); [void](Add-Ctl $t 0); $Stretch.Add($t); End-Card
  $t
}

# ---------- 7. review ----------
[void](New-Page 'Review')
[void](Add-Note 'Setup will do this. Press Set up to go ahead.' $Grey)
$review = Add-TextCard 352

# ---------- 8. set up ----------
[void](New-Page 'Setting up')
$progress = Add-TextCard 330
$doneRow = New-Object Windows.Forms.FlowLayoutPanel; $doneRow.AutoSize = $true; $doneRow.WrapContents = $false; $doneRow.Visible = $false
$btnOpenApp = New-Object Windows.Forms.Button; $btnOpenApp.Text = 'Open Media Vault'; $btnOpenApp.AutoSize = $true; $btnOpenApp.Margin = New-Object Windows.Forms.Padding(0, 0, 8, 0)
$btnOpenDash = New-Object Windows.Forms.Button; $btnOpenDash.Text = 'Admin dashboard'; $btnOpenDash.AutoSize = $true
$btnPhone = New-Object Windows.Forms.Button; $btnPhone.Text = 'Connect a phone (QR code)...'; $btnPhone.AutoSize = $true; $btnPhone.Margin = New-Object Windows.Forms.Padding(8, 0, 0, 0)
$doneRow.Controls.AddRange(@($btnOpenApp, $btnOpenDash, $btnPhone))
[void](Add-Ctl $doneRow 0)
Set-ButtonLook $btnOpenApp 'primary'
$btnOpenApp.Add_Click({ Open-Target "http://localhost:$($Want.vaultPort)/" })
$btnOpenDash.Add_Click({ Open-Target "http://localhost:$($Want.vaultPort)/_/" })
Set-ButtonLook $btnPhone
$btnPhone.Add_Click({ $c = Get-SetupPhoneChoices; Show-MvPhoneQr $form $c })

# Cards fill the page's width and notes wrap at it (set when a page is shown too: hidden pages aren't laid out).
function Fit-Notes($page) {
  $w = [math]::Max(320, $page.ClientSize.Width - 30)
  $inner = $w - 36 # (a card's padding)
  foreach ($c in $Cards) { if ($c.Parent -eq $page) { $c.MinimumSize = New-Object Drawing.Size($w, 0); $c.MaximumSize = New-Object Drawing.Size($w, 0) } }
  foreach ($x in $Stretch) { if ($x.Parent.Parent -eq $page) { $x.Width = $inner } }
  foreach ($l in $Notes) {
    if ($l.Parent -eq $page) { $l.MaximumSize = New-Object Drawing.Size(($w - $l.Margin.Left), 0) }
    elseif ($l.Parent.Parent -eq $page) { $l.MaximumSize = New-Object Drawing.Size(($inner - $l.Margin.Left), 0) }
  }
}
foreach ($p in $Pages) { $p.Add_Resize({ Fit-Notes $this }) }
Set-Looks $form

# ---------- reading the choices + checking them ----------
function Read-Choices {
  $Want.vaultPort = [int]$numVault.Value; $Want.sitesPort = [int]$numSites.Value; $Want.dataDir = $script:DataPick
  $Want.admin = $rbSet.Checked; $Want.adminEmail = $txtEmail.Text.Trim(); $Want.adminPass = $txtPass.Text
  $tsOk = $Ts.Installed -and $Ts.State -eq 'Running'
  $Want.tsOk = $tsOk
  $Want.vaultMode = ($VaultRadios.Values | Where-Object Checked).Tag
  $Want.sitesMode = ($SitesRadios.Values | Where-Object Checked).Tag
  $Want.firewall = $cbFirewall.Checked; $Want.startup = $cbStartup.Checked; $Want.desktop = $cbDesktop.Checked; $Want.startNow = $cbStart.Checked
}
# The problem with page $i's choices, or '' if there's none.
function Test-Page([int]$i) {
  Read-Choices
  switch ($StepNames[$i]) {
    'Welcome' { if (-not (Test-Path $Exe)) { return $(if ($script:PbState -eq 'downloading') { 'PocketBase is still downloading - one moment.' } else { 'PocketBase (pocketbase.exe) is needed first - press "Try the download again", or put pocketbase.exe in this folder.' }) } }
    'Servers' {
      if ($Want.vaultPort -eq $Want.sitesPort) { return 'Media Vault and the sites server need different ports.' }
      $bad = Test-DataDir (Get-DataPath $Want.dataDir); if ($bad) { return "Library folder: $bad" }
      foreach ($x in @(@($Want.vaultPort, 'Media Vault'), @($Want.sitesPort, 'The sites server'))) {
        $u = Get-PortUse $x[0] $Root
        if (-not $u.Free -and -not $u.Ours) {
          $free = Get-MvFreePort @($Want.vaultPort, $Want.sitesPort) ($x[0] + 100)
          return "$($x[1]) can't use port $($x[0]): it's $($u.Text). Pick another port - $free is free."
        }
      }
    }
    'Tailscale' { return (Confirm-Takeovers) }
    'Your account' {
      if ($Want.admin) {
        if ($Want.adminEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { return 'Enter your email address.' }
        if ($Want.adminPass.Length -lt 10) { return 'The password needs at least 10 characters.' }
        if ($Want.adminPass.Length -gt 71) { return 'The password can be up to 71 characters.' } # (PocketBase's limit for accounts)
        if ($Want.adminPass -ne $txtPass2.Text) { return "The two passwords don't match." }
        if ($Want.adminPass.Contains('"')) { return "The password can't contain a double quote (`")." }
      }
    }
    'Site backends' {
      $ports = @{ $Want.vaultPort = 'Media Vault'; $Want.sitesPort = 'the sites server' }
      $https = @{}
      if ($Want.vaultMode -eq 'tailnet') { $https[$MvVaultHttps] = "Media Vault's https address" }
      if ($Want.sitesMode -ne 'off') { $https[$MvSitesHttps] = "the sites' https address" }
      foreach ($b in $Want.backends) {
        if ($ports.ContainsKey($b.port)) { return "$($b.name) uses port $($b.port), which $($ports[$b.port]) uses too. Edit it and pick another." }
        $ports[$b.port] = $b.name
        $u = Get-PortUse $b.port (Resolve-MvDir $Root $b.dir)
        if (-not $u.Free -and -not $u.Ours) { return "$($b.name) can't use port $($b.port): it's $($u.Text)." }
        if ($b.access -ne 'off' -and $Want.tsOk) {
          if ($https.ContainsKey($b.httpsPort)) { return "$($b.name)'s https port $($b.httpsPort) is already $($https[$b.httpsPort]). Edit it and pick another (10000 is usually free)." }
          $https[$b.httpsPort] = "used by $($b.name)"
        }
      }
      # A backend's code runs with this Windows account's rights, so backends that came with a packaged copy, and
      # pocketbase.exe files Media Vault didn't download, each need a yes first.
      $unseen = @($Want.backends | Where-Object { $_.review })
      if ($unseen.Count) {
        $what = foreach ($b in $unseen) {
          $hooks = @(Get-ChildItem -LiteralPath (Join-Path (Resolve-MvDir $Root $b.dir) 'pb_hooks') -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
          "$($b.name): " + $(if ($hooks.Count) { $hooks -join ', ' } else { 'no hooks' })
        }
        $a = [Windows.Forms.MessageBox]::Show("These backends came with this copy of Media Vault. Each runs its own server code (pb_hooks) on this PC, with your Windows account's rights:`n`n  $($what -join "`n  ")`n`nKeep them only if you trust where this copy came from (the files are in the backends folder). Keep them?", $Title, 'YesNo', 'Warning')
        if ($a -ne 'Yes') { return "Remove the backends you don't want (select one, then Remove), then continue." }
        foreach ($b in $unseen) { $b.review = $false }
      }
      foreach ($b in $Want.backends) {
        $own = Join-Path (Resolve-MvDir $Root $b.dir) 'pocketbase.exe'
        if (-not (Test-Path -LiteralPath $own)) { continue }
        $sha = Get-MvFileHash $own
        if ($sha -eq $MvPbSha256 -or $sha -eq $b.exeSha256) { continue }
        $a = [Windows.Forms.MessageBox]::Show("$($b.name)'s folder has its own pocketbase.exe, and it isn't the PocketBase $MvPbVersion that Media Vault downloads and checks:`n`n  $own`n`nRun it, with your Windows account's rights? Only if you put it there yourself (e.g. a PocketBase version the backend needs). If the file changes later, Media Vault won't start it until you approve it here again.", $Title, 'YesNo', 'Warning')
        if ($a -ne 'Yes') { return "Remove $($b.name), or delete its pocketbase.exe so it runs on Media Vault's own copy, then continue." }
        $b.exeSha256 = $sha
      }
      return (Confirm-Takeovers)
    }
  }
  ''
}
# Taking a Tailscale address away from another server only after a yes (asked once for the same set).
$script:TakeoversOk = ''
function Confirm-Takeovers {
  $t = @(Get-Takeovers)
  if (-not $t.Count -or $script:TakeoversOk -eq ($t -join '|')) { return '' }
  $a = [Windows.Forms.MessageBox]::Show("These Tailscale addresses already go to another server on this PC - maybe another copy of Media Vault:`n`n  $($t -join "`n  ")`n`nTake them over for this install? The other server loses that address.", $Title, 'YesNo', 'Warning')
  if ($a -eq 'Yes') { $script:TakeoversOk = $t -join '|'; return '' }
  'Choose Off for those addresses (or another https port for a backend), then continue.'
}

# What Tailscale should send where: @{ {https port} = @{ Port; Public; What } }.
function Get-WantedServe {
  $w = @{} # (not [ordered]: that indexes by position when the key is a number)
  if ($Want.vaultMode -eq 'tailnet') { $w[$MvVaultHttps] = @{ Port = $Want.vaultPort; Public = $false; What = 'Media Vault' } }
  if ($Want.sitesMode -ne 'off') { $w[$MvSitesHttps] = @{ Port = $Want.sitesPort; Public = ($Want.sitesMode -eq 'public'); What = 'the sites' } }
  foreach ($b in $Want.backends) { if ($b.access -ne 'off') { $w[$b.httpsPort] = @{ Port = $b.port; Public = ($b.access -eq 'public'); What = $b.name } } }
  $w
}
# tailscale steps to get from what's there now to that. Only addresses pointing at our servers (old or new ports) are
# turned off; anything else on this PC's tailscale serve is left alone. Media Vault's 8443 goes first, so moving from
# the old layout (vault on 443, sites on 8443) never leaves it without an address.
function Get-ServeSteps {
  $plan = Get-WantedServe # (not $want: variable names ignore case, so that would hide $Want)
  $ports = @($plan.Keys) + @($Ts.Entries.Keys) | Select-Object -Unique | Sort-Object { if ($_ -eq $MvVaultHttps) { 0 } else { 1 } }
  $steps = @()
  foreach ($h in $ports) {
    $w = $plan[$h]; $cur = $Ts.Entries[$h]
    if ($w) {
      if ($cur -and $cur.Port -eq $w.Port -and $cur.Public -eq $w.Public) { continue }
      $to = "http://127.0.0.1:$($w.Port)"
      if ($w.Public) { $steps += @{ A = "funnel --bg --https=$h $to"; Must = $true; Say = "https port $h -> $($w.What) (public, Funnel)" } }
      else {
        $steps += @{ A = "funnel --https=$h off"; Must = $false; Say = '' }
        $steps += @{ A = "serve --bg --https=$h $to"; Must = $true; Say = "https port $h -> $($w.What) (tailnet only)" }
      }
    } elseif ($cur -and (Test-OurPort $cur.Port)) {
      $steps += @{ A = "funnel --https=$h off"; Must = $false; Say = '' }
      $steps += @{ A = "serve --https=$h off"; Must = $false; Say = "https port $h -> off" }
    }
  }
  $steps
}

function Update-Review {
  Read-Choices
  $lines = New-Object Collections.Generic.List[string]
  $lines.Add('SERVERS')
  $lines.Add("  Media Vault   http://localhost:$($Want.vaultPort)/   (home Wi-Fi + Tailscale)")
  $lines.Add("  Sites server  http://localhost:$($Want.sitesPort)/<site>/")
  foreach ($b in $Want.backends) { $lines.Add("  $($b.name)  127.0.0.1:$($b.port)  from $(Resolve-MvDir $Root $b.dir)") }
  $lines.Add('  -> saved to mediavault.json')
  $chg = @()
  if ($Old.vaultPort -ne $Want.vaultPort -and (Get-OurPid $Old.vaultPort $Root)) { $chg += "Media Vault (port $($Old.vaultPort))" }
  if ($Old.sitesPort -ne $Want.sitesPort -and (Get-OurPid $Old.sitesPort $Root)) { $chg += "the sites server (port $($Old.sitesPort))" }
  foreach ($ob in $Old.backends) {
    $nb = $Want.backends | Where-Object { (Resolve-MvDir $Root $_.dir) -eq (Resolve-MvDir $Root $ob.dir) } | Select-Object -First 1
    if ($nb -and $nb.port -ne $ob.port -and (Get-OurPid $ob.port (Resolve-MvDir $Root $ob.dir))) { $chg += "$($ob.name) (port $($ob.port))" }
  }
  if ($chg) { $lines.Add("  -> stops $($chg -join ', ') first, since the port changes") }
  $lines.Add(''); $lines.Add('LIBRARY')
  $newData = Get-DataPath $Want.dataDir
  if ($newData -eq $OldData) { $lines.Add($(if ($HasData) { "  Stays in $OldData" } else { "  A new, empty library in $OldData" })) }
  elseif ($HasData -and -not (Test-Path -LiteralPath (Join-Path $newData 'data.db'))) {
    $lines.Add("  Moves from $OldData"); $lines.Add("        to $newData")
    $lines.Add($(if ([IO.Path]::GetPathRoot($newData) -eq [IO.Path]::GetPathRoot($OldData)) { '  (same drive: a quick move)' } else { '  (another drive: copied and checked; the old folder is kept, renamed, until you delete it)' }))
  } else { $lines.Add("  Uses $newData") }
  $lines.Add(''); $lines.Add('YOUR ACCOUNT')
  if (-not $Want.admin) { $lines.Add('  Kept as it is') }
  elseif ($Fresh) { $lines.Add("  $($Want.adminEmail): your Media Vault account (the owner) + the admin dashboard") }
  else { $lines.Add("  Admin dashboard: $($Want.adminEmail) (created, or its password changed)"); $lines.Add('  Also your Media Vault account, if Media Vault has none yet') }
  $lines.Add(''); $lines.Add('TAILSCALE')
  if (-not $Want.tsOk) { $lines.Add('  Skipped - Tailscale is not connected. Run setup again later to add the https:// addresses.') }
  else {
    $steps = @(Get-ServeSteps | Where-Object { $_.Say })
    if ($steps) { foreach ($s in $steps) { $lines.Add("  $($s.Say)") } } else { $lines.Add('  Already set up like this - no changes') }
    if ($Want.vaultMode -eq 'tailnet') { $lines.Add("  Media Vault: https://$($Ts.Dns):$MvVaultHttps/") }
    if ($Want.sitesMode -ne 'off') { $lines.Add("  Sites: https://$($Ts.Dns)/<site>/" + $(if ($Want.sitesMode -eq 'public') { ' (public)' } else { '' })) }
    foreach ($b in $Want.backends) { if ($b.access -ne 'off') { $lines.Add("  $($b.name): https://$($Ts.Dns):$($b.httpsPort)/" + $(if ($b.access -eq 'public') { ' (public)' } else { '' })) } }
  }
  $lines.Add(''); $lines.Add('WINDOWS')
  $lines.Add($(if ($Want.firewall) { "  Firewall: allow ports $($Want.vaultPort) and $($Want.sitesPort) from home Wi-Fi + Tailscale (admin prompt)" } else { '  Firewall: unchanged' }))
  $lines.Add('  Start with Windows: ' + $(if ($Want.startup) { 'on' } elseif ($StartupNow -eq 'elsewhere') { 'off (the other copy''s shortcut is left alone)' } else { 'off' }))
  $lines.Add('  Desktop shortcut: ' + $(if ($Want.desktop) { 'yes' } else { 'unchanged' }))
  if ($Want.startNow) { $lines.Add(''); $lines.Add('Then starts Media Vault and opens its window.') }
  $review.Text = $lines -join "`r`n"
}

# ---------- doing it ----------
$LogFile = Join-Path $Root 'logs\setup.log'
function Say([string]$text) {
  $progress.AppendText($text + "`r`n"); [Windows.Forms.Application]::DoEvents()
  try { New-Item -ItemType Directory -Force (Split-Path $LogFile) | Out-Null; Add-Content -Path $LogFile -Value "$(Get-Date -Format s) $text" } catch {}
}
# Makes the owner (first) Media Vault account through the app's sign-up, which is open only while there are no
# accounts: 'made', 'exists' (there's an owner already - nothing changed) or 'failed: why'.
function Add-MvOwner([string]$base, [string]$email, [string]$pass) {
  try { $st = Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 "$base/api/library/setup" } catch { return "failed: Media Vault didn't answer - $($_.Exception.Message)" }
  if (-not $st.needsOwner) { return 'exists' }
  $json = ConvertTo-Json @{ email = $email; password = $pass; passwordConfirm = $pass; emailVisibility = $false }
  try {
    Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) "$base/api/collections/users/records" | Out-Null
    'made'
  } catch {
    $why = $_.Exception.Message
    try { $e = $_.ErrorDetails.Message | ConvertFrom-Json; $why = (@($e.message) + @($e.data.PSObject.Properties | ForEach-Object { "$($_.Name): $($_.Value.message)" })) -join ' ' } catch {}
    "failed: $why"
  }
}

# Moves the library folder $from to $to (which is missing or empty). Same drive: a rename. Another drive: robocopy,
# then the copy is checked (file count and bytes) and $from renamed to "{name}-old-{date}", which is returned.
function Move-Library([string]$from, [string]$to) {
  if (Test-Path -LiteralPath $to) {
    if (@(Get-ChildItem -LiteralPath $to -Force).Count) { throw "$to isn't empty" }
    Remove-Item -LiteralPath $to -Force
  }
  New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
  if ([IO.Path]::GetPathRoot($from) -eq [IO.Path]::GetPathRoot($to)) {
    # (A server that just stopped can hold its files for a moment.)
    for ($i = 1; ; $i++) { try { [IO.Directory]::Move($from, $to); return '' } catch { if ($i -ge 5) { throw }; Start-Sleep -Seconds 1 } }
  }
  Say "...  Copying the library ($('{0:N1}' -f ((Get-FolderBytes $from) / 1GB)) GB) - this can take a while"
  $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\robocopy.exe') -WindowStyle Hidden -PassThru `
    -ArgumentList "`"$from`"", "`"$to`"", '/E', '/COPY:DAT', '/DCOPY:T', '/R:2', '/W:2', '/NP', '/NFL', '/NDL'
  $t0 = Get-Date; $next = 30
  while (-not $p.WaitForExit(200)) {
    [Windows.Forms.Application]::DoEvents()
    if (((Get-Date) - $t0).TotalSeconds -ge $next) { Say "     still copying ($([int]((Get-Date) - $t0).TotalMinutes) min)"; $next += 60 }
  }
  if ($p.ExitCode -ge 8) { throw "robocopy reported a problem (code $($p.ExitCode))" }
  $count = { param($d) $n = 0; $b = 0L; foreach ($f in (New-Object IO.DirectoryInfo $d).EnumerateFiles('*', 'AllDirectories')) { $n++; $b += $f.Length }; "$n/$b" }
  if ((& $count $from) -ne (& $count $to)) { throw "the copy doesn't match the original (the original is untouched; the partial copy is in $to)" }
  $kept = "$from-old-$(Get-Date -Format yyyyMMdd-HHmm)"
  [IO.Directory]::Move($from, $kept)
  $kept
}

function Invoke-Setup {
  $failed = 0
  Say "Media Vault setup - $(Get-Date -Format 'd MMM yyyy h:mm tt')"
  Say ''

  # Servers whose port changes are stopped, so the new one isn't blocked and the old one doesn't linger.
  # Only servers running from this copy's folders: another copy of Media Vault on these ports is left alone.
  if ($Old.vaultPort -ne $Want.vaultPort -and (Get-OurPid $Old.vaultPort $Root) -and (Stop-MvPort $Old.vaultPort)) { Say "Stopped Media Vault on port $($Old.vaultPort)" }
  if ($Old.sitesPort -ne $Want.sitesPort -and (Get-OurPid $Old.sitesPort $Root) -and (Stop-MvPort $Old.sitesPort)) { Say "Stopped the sites server on port $($Old.sitesPort)" }
  foreach ($ob in $Old.backends) {
    $nb = $Want.backends | Where-Object { (Resolve-MvDir $Root $_.dir) -eq (Resolve-MvDir $Root $ob.dir) } | Select-Object -First 1
    if ($nb -and $nb.port -ne $ob.port -and (Get-OurPid $ob.port (Resolve-MvDir $Root $ob.dir)) -and (Stop-MvPort $ob.port)) { Say "Stopped $($ob.name) on port $($ob.port)" }
  }

  # Backends get Media Vault's hooks before Tailscale points at them: flood protection for any https address, and the
  # guard (no admin dashboard or superusers through Tailscale) for public ones; one that can't have them is saved as
  # tailnet-only.
  foreach ($b in $Want.backends) {
    try {
      Set-MvBackendGuard (Resolve-MvDir $Root $b.dir) $b.access
      if ($b.access -eq 'public') { Say "OK   $($b.name): admin dashboard and superusers blocked from the internet, flood protection on" }
      elseif ($b.access -eq 'tailnet') { Say "OK   $($b.name): flood protection on" }
    } catch {
      if ($b.access -ne 'public') { continue }
      $failed++; $b.access = 'tailnet'
      Say "FAIL $($b.name): couldn't add Media Vault's guard hook to its pb_hooks, so it stays tailnet-only - $($_.Exception.Message)"
    }
  }

  # The library's folder: Media Vault is stopped first (it has the database open), then an existing library is moved
  # (same drive) or copied, checked and the old folder set aside (another drive). If that fails it stays where it was.
  $newData = Get-DataPath $Want.dataDir
  if ($newData -ne $OldData) {
    if ((Get-OurPid $Old.vaultPort $Root) -and (Stop-MvPort $Old.vaultPort)) { Say "Stopped Media Vault on port $($Old.vaultPort) to change its library folder" }
    if ($HasData -and -not (Test-Path -LiteralPath (Join-Path $newData 'data.db'))) {
      try {
        $kept = Move-Library $OldData $newData
        Say "OK   Library moved to $newData"
        if ($kept) { Say "     The old copy is kept as $kept - delete it once Media Vault works from the new place." }
      } catch {
        $failed++; $Want.dataDir = $Old.dataDir
        Say "FAIL Couldn't move the library to $newData - $($_.Exception.Message). It stays in $OldData."
      }
    } else { Say "OK   Library folder: $newData" }
  }
  # Other accounts on this PC mustn't be able to read the library or change Media Vault's files.
  foreach ($d in @($Root, (Get-DataPath $Want.dataDir)) | Select-Object -Unique) {
    try {
      New-Item -ItemType Directory -Force $d | Out-Null
      if (Protect-MvFolder $d) { Say "OK   Only your Windows account can open $d now" }
    } catch { Say "     Couldn't limit $d to your Windows account: $($_.Exception.Message)" }
  }

  try {
    foreach ($d in 'logs', 'pb_sites\www', 'pb_sites\staging') { New-Item -ItemType Directory -Force (Join-Path $Root $d) | Out-Null }
    Save-MvConfig $Root $Want
    Say "OK   Settings saved (mediavault.json): Media Vault on $($Want.vaultPort), sites on $($Want.sitesPort), $($Want.backends.Count) backend(s)"
  } catch { $failed++; Say "FAIL Couldn't save mediavault.json: $($_.Exception.Message)" }

  if ($Want.admin) {
    try {
      $r = Set-MvSuperuser $Exe (Get-DataPath $Want.dataDir) $Want.adminEmail $Want.adminPass
      if ($r.Ok) { Say "OK   Admin dashboard account $($Want.adminEmail) is ready (http://localhost:$($Want.vaultPort)/_/, on this PC)" }
      else { $failed++; Say "FAIL Couldn't set the admin account: $($r.Out)" }
    } catch { $failed++; Say "FAIL Couldn't set the admin account: $($_.Exception.Message)" }
  }

  if ($Want.tsOk) {
    $steps = @(Get-ServeSteps)
    if (-not $steps) { Say 'OK   Tailscale addresses already set up' }
    foreach ($s in $steps) {
      $r = Invoke-Ts $s.A
      if ($r.Ok) { if ($s.Say) { Say "OK   Tailscale: $($s.Say)" }; continue }
      if (-not $s.Must) { continue }
      $failed++
      $m = [regex]::Match($r.Out, 'https://login\.tailscale\.com/\S+')
      if ($m.Success) {
        Say "WAIT Tailscale: $($s.Say) - needs allowing for your tailnet first ($($m.Value)). Allow it in the browser, then run setup again."
        Open-Target $m.Value
      } else {
        $why = if ($r.TimedOut) { "didn't finish within 20 seconds" } else { $r.Out }
        Say "FAIL Tailscale: $($s.Say) - $why"
      }
    }
  } else { Say 'SKIP Tailscale is not connected - run setup again later for the https:// addresses' }

  if ($Want.firewall) {
    Say '...  Firewall: answer the admin prompt'
    try {
      $p = Start-Process -FilePath (Join-Path $Root 'allow-firewall.bat') -ArgumentList '/quiet' -WorkingDirectory $Root -Verb RunAs -WindowStyle Hidden -PassThru
      while (-not $p.WaitForExit(100)) { [Windows.Forms.Application]::DoEvents() }
      $fw = @(Get-NetFirewallRule -DisplayName "Media Vault ($($Want.vaultPort))", "Media Vault sites ($($Want.sitesPort))" -ErrorAction SilentlyContinue).Count
      if ($fw -ge 2) { Say "OK   Firewall: phones can reach ports $($Want.vaultPort) and $($Want.sitesPort)" } else { $failed++; Say 'FAIL Firewall rules not found afterwards - try allow-firewall.bat' }
    } catch { Say 'SKIP Firewall: admin prompt cancelled - run allow-firewall.bat later' }
  }

  try {
    # Off removes this copy's own shortcut (or a dead one); one that opens another copy stays.
    if ($Want.startup -or $StartupNow -in 'on', 'stale') { Set-MvShortcut $Root $MvStartupLnk $Want.startup -Minimized }
    Say $(if ($Want.startup) { 'OK   Starts with Windows' } else { 'OK   Does not start with Windows' })
  } catch { $failed++; Say "FAIL Startup shortcut: $($_.Exception.Message)" }
  if ($Want.desktop) {
    try { Set-MvShortcut $Root $MvDesktopLnk $true; Say 'OK   Desktop shortcut made' } catch { $failed++; Say "FAIL Desktop shortcut: $($_.Exception.Message)" }
  }

  Say ''
  # Your Media Vault account gets the same email and password as the dashboard's. It's made through the app's own
  # first sign-up (open only while there are no accounts), so Media Vault has to answer first - when it isn't meant to
  # keep running, it's started just for this and stopped again.
  $base = "http://127.0.0.1:$($Want.vaultPort)"
  $waitUp = {
    $until = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $until) {
      for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Milliseconds 100; [Windows.Forms.Application]::DoEvents() }
      try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$base/api/health").StatusCode -eq 200) { return $true } } catch {}
    }
    $false
  }
  $up = $false; $tmpServer = $null; $owner = ''
  if ($Want.startNow) {
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -WorkingDirectory $Root -WindowStyle Hidden `
      -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$(Join-Path $PSScriptRoot 'MediaVault.ps1')`""
    Say 'Starting Media Vault...'
    $up = & $waitUp
    if ($up) { Say "OK   Media Vault is running: http://localhost:$($Want.vaultPort)/" }
    else { $failed++; Say "FAIL Media Vault didn't answer within 30 seconds - see the Logs tab in its window" }
  } elseif ($Want.admin) {
    $srv = @(Get-MvServers $Root $Want)[0]
    try { $tmpServer = Start-Process -FilePath $srv.Exe -ArgumentList $srv.Args -WorkingDirectory $srv.Dir -WindowStyle Hidden -PassThru; $up = & $waitUp } catch {}
  }
  if ($up -and $Want.admin) { $owner = Add-MvOwner $base $Want.adminEmail $Want.adminPass }
  if ($tmpServer) { try { Stop-Process -Id $tmpServer.Id -Force -Confirm:$false } catch {} }
  if ($owner -eq 'made') { Say "OK   Your Media Vault account $($Want.adminEmail) is ready - sign in with the same email and password" }
  elseif ($owner -like 'failed*') {
    $failed++
    Say "FAIL Couldn't make your Media Vault account ($($owner.Substring(8))). Create it in the browser instead - the first account becomes the owner."
  } elseif ($Want.admin -and -not $up -and -not $Want.startNow) { Say 'SKIP Your Media Vault account: Media Vault didn''t start - create it in the browser after starting it (the first account becomes the owner).' }
  if ($Want.startNow -and $up -and (-not $HasData -or $owner)) {
    if ($owner -ne 'made' -and $owner -ne 'exists') { Say '     Create your owner account in the browser window that opened.' }
    Open-Target "http://localhost:$($Want.vaultPort)/"
  }
  if (-not $Want.startNow) { Say 'Run start.bat (or the desktop shortcut) to start Media Vault.' }
  Say ''
  Say $(if ($failed) { "Done, with $failed problem(s) above. Fix them and run setup again - it only redoes what's needed." } else { 'All done.' })
  Show-Addresses
  $doneRow.Visible = $true
}

# The addresses a phone can use now, for the QR code window (mv-qr.ps1).
function Get-SetupPhoneChoices {
  $tsNow = Get-MvTailscale
  $lanIps = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' -and $_.Description -notmatch 'Tailscale|Hyper-V|Virtual|VPN|Loopback' } |
    ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
    Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and -not $_.Address.ToString().StartsWith('169.254.') } |
    ForEach-Object { $_.Address.ToString() })
  $vp = $Want.vaultPort
  $httpsUrl = if ($tsNow.Dns -and $tsNow.Entries[$MvVaultHttps] -and $tsNow.Entries[$MvVaultHttps].Port -eq $vp) { "https://$($tsNow.Dns):$MvVaultHttps/" } else { '' }
  Get-MvPhoneChoices $httpsUrl $tsNow.Ip $lanIps $vp (Test-Path (Join-Path $Root 'pb_public\downloads\media-vault.apk'))
}

# Where to open it from now on, and what to type into the phone app.
function Show-Addresses {
  $ts = Get-MvTailscale
  $lan = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' -and $_.Description -notmatch 'Tailscale|Hyper-V|Virtual|VPN|Loopback' } |
    ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
    Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and -not $_.Address.ToString().StartsWith('169.254.') } |
    ForEach-Object { $_.Address.ToString() })
  $vp = $Want.vaultPort
  $vaultHttps = $ts.Dns -and $ts.Entries[$MvVaultHttps] -and $ts.Entries[$MvVaultHttps].Port -eq $vp
  $phone = if ($vaultHttps) { "https://$($ts.Dns):$MvVaultHttps" } elseif ($ts.Ip) { "http://$($ts.Ip):$vp" } elseif ($lan.Count) { "http://$($lan[0]):$vp" } else { "http://<this PC's address>:$vp" }
  Say ''
  Say 'HOW TO OPEN MEDIA VAULT'
  Say "  On this PC:          http://localhost:$vp/"
  if ($vaultHttps) { Say "  Anywhere (Tailscale): https://$($ts.Dns):$MvVaultHttps/" }
  elseif ($ts.Ip) { Say "  Anywhere (Tailscale): http://$($ts.Ip):$vp/" }
  foreach ($ip in $lan) { Say "  Home Wi-Fi:           http://${ip}:$vp/" }
  Say "  Admin dashboard:     http://localhost:$vp/_/"
  if (Test-Path (Join-Path $Root 'pb_public\downloads\media-vault.apk')) {
    Say ''
    Say 'ANDROID APP'
    Say "  Download on the phone: $phone/downloads/media-vault.apk"
    Say "  When it asks for the server address, enter:  $phone"
  }
  Say ''
  Say 'The first account you create in the app becomes the owner; invite others from its menu ("Invite people").'
  Say 'Change any of this later with setup.bat or the Setup... button in the Media Vault window.'
}

# ---------- moving between steps ----------
$script:Step = 0; $script:Busy = $false
function Show-Step([int]$i) {
  $script:Step = $i
  for ($k = 0; $k -lt $Pages.Count; $k++) { $Pages[$k].Visible = $k -eq $i }
  $side.Invalidate()
  Fit-Notes $Pages[$i]
  switch ($StepNames[$i]) {
    'Welcome' { Update-Welcome }
    'Servers' { Update-PortStatus }
    'Tailscale' { Update-Tailscale }
    'Site backends' { Update-Backends }
    'Windows' { $fwNote.Text = "Ports $([int]$numVault.Value) and $([int]$numSites.Value), from your home network and Tailscale only - not the internet." + $(if ($fwNow -and $Old.vaultPort -eq [int]$numVault.Value -and $Old.sitesPort -eq [int]$numSites.Value) { ' (Already set up.)' } else { '' }) }
    'Review' { Update-Review }
  }
  $btnBack.Enabled = $i -gt 0 -and $i -lt $Pages.Count - 1
  $btnNext.Text = if ($StepNames[$i] -eq 'Review') { 'Set up' } elseif ($i -eq $Pages.Count - 1) { 'Close' } else { 'Next' }
  $btnCancel.Visible = $i -lt $Pages.Count - 1
}
$btnBack.Add_Click({ if ($script:Step -gt 0) { Show-Step ($script:Step - 1) } })
$btnNext.Add_Click({
  if ($script:Step -eq $Pages.Count - 1) { $form.Close(); return }
  $err = Test-Page $script:Step
  if ($err) { Show-Msg $err; return }
  if ($StepNames[$script:Step] -eq 'Review') {
    # Check every step once more (a port can be taken while the window was open).
    for ($k = 0; $k -lt $script:Step; $k++) { $err = Test-Page $k; if ($err) { Show-Step $k; Show-Msg $err; return } }
    Show-Step ($script:Step + 1)
    $btnNext.Enabled = $false; $form.Cursor = 'WaitCursor'; $script:Busy = $true
    try { Invoke-Setup } catch { Say "FAIL $($_.Exception.Message)" } finally { $form.Cursor = 'Default'; $btnNext.Enabled = $true; $script:Busy = $false }
    return
  }
  Show-Step ($script:Step + 1)
})
$btnCancel.Add_Click({ $form.Close() })
$form.Add_FormClosing({
  param($src, $e)
  if ($script:Busy) { $e.Cancel = $true; return }
  if ($script:Step -gt 0 -and $script:Step -lt $Pages.Count - 1) {
    if ([Windows.Forms.MessageBox]::Show('Leave setup? Nothing has been changed.', $Title, 'YesNo', 'Question') -ne 'Yes') { $e.Cancel = $true }
  }
})
$form.Add_Shown({ Show-Step 0; $Pages[0].PerformLayout(); $form.PerformLayout(); Get-PocketBase })
Update-Admin
[void]$form.ShowDialog()
$mutex.ReleaseMutex()
