<#
  Makes packages\Media-Vault-Setup-{version}.exe: an installer for another PC (or someone else) with the same files as
  make-package.ps1's zip - the program without your library, settings, logs, hosted sites or the Android signing key.
  It installs to C:\Media Vault (or a folder you pick) without admin rights, adds a Start menu entry and opens setup;
  run on a PC that has Media Vault already, it updates the program and keeps the library. See installer\MediaVault.iss.

  Needs Inno Setup 6 on this PC (free; only for building - the installer itself needs nothing):
    winget install --id JRSoftware.InnoSetup --scope user

    powershell -ExecutionPolicy Bypass -File scripts\make-installer.ps1 [-Version 2026.10.21]
  Without -Version it's today's date. Unsigned, so Windows shows "Windows protected your PC" once on other PCs
  (More info > Run anyway) - unlike a zip, only for the installer itself.
#>
param([string]$Version)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot # (the scripts are in Media Vault's scripts folder)
. (Join-Path $PSScriptRoot 'mv-common.ps1')
if (-not $Version) { $Version = Get-Date -Format 'yyyy.M.d' }
if ($Version -notmatch '^\d+(\.\d+){0,3}$') { throw "The version is numbers and dots, like 2026.10.21" }

$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
  Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $iscc) { $c = Get-Command iscc.exe -ErrorAction SilentlyContinue; if ($c) { $iscc = $c.Source } }
if (-not $iscc) { throw "Inno Setup 6 isn't installed. Install it with:  winget install --id JRSoftware.InnoSetup --scope user" }
if (-not (Test-Path -LiteralPath (Join-Path $Root 'pocketbase.exe'))) { Write-Warning "pocketbase.exe isn't here, so the installer won't include it - setup then downloads it on the other PC." }

# The installer's pictures in Media Vault's look (instead of Inno Setup's box and disc): the tall one beside the
# welcome and finish pages - the dark sidebar colour with the mark and the name - and the small one at the top
# right of the other pages. Drawn at twice Inno's size so they stay sharp on high-DPI screens.
function Save-WizardImages([string]$dir) {
  Add-Type -AssemblyName System.Drawing
  $mark = {
    param($g, [float]$x, [float]$y, [float]$d)
    $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(109, 93, 252))), $x, $y, $d, $d)
    $pts = [Drawing.PointF[]]@((New-Object Drawing.PointF ($x + $d * 0.375), ($y + $d * 0.28)), (New-Object Drawing.PointF ($x + $d * 0.72), ($y + $d * 0.5)), (New-Object Drawing.PointF ($x + $d * 0.375), ($y + $d * 0.72)))
    $g.FillPolygon([Drawing.Brushes]::White, $pts)
  }
  $big = New-Object Drawing.Bitmap 328, 628
  $g = [Drawing.Graphics]::FromImage($big); $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([Drawing.Color]::FromArgb(23, 21, 51))
  & $mark $g 104 190 120
  $f = New-Object Drawing.Font('Segoe UI Semibold', 26, [Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object Drawing.StringFormat; $sf.Alignment = 'Center'
  $g.DrawString('Media Vault', $f, [Drawing.Brushes]::White, (New-Object Drawing.RectangleF 0, 336, 328, 40), $sf)
  $f2 = New-Object Drawing.Font('Segoe UI', 16, [Drawing.GraphicsUnit]::Pixel)
  $g.DrawString("Your photos, on your PC", $f2, (New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(196, 189, 254))), (New-Object Drawing.RectangleF 0, 376, 328, 30), $sf)
  $g.Dispose(); $big.Save((Join-Path $dir 'wizard-large.bmp'), [Drawing.Imaging.ImageFormat]::Bmp); $big.Dispose()
  $small = New-Object Drawing.Bitmap 110, 110
  $g = [Drawing.Graphics]::FromImage($small); $g.SmoothingMode = 'AntiAlias'; $g.Clear([Drawing.Color]::White)
  & $mark $g 18 18 74 # (room around it: Inno crops the edges)
  $g.Dispose(); $small.Save((Join-Path $dir 'wizard-small.bmp'), [Drawing.Imaging.ImageFormat]::Bmp); $small.Dispose()
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ('mv-installer-' + [guid]::NewGuid().ToString('N'))
$out = Join-Path $Root 'packages'
try {
  & (Join-Path $PSScriptRoot 'make-package.ps1') -Folder $stage
  Save-MvIcon (Join-Path $stage 'mediavault.ico') # (the installer's and the shortcuts' icon)
  $art = "$stage-art"; New-Item -ItemType Directory -Force $art, $out | Out-Null # (outside the stage: not installed)
  Save-WizardImages $art
  & $iscc /Q "/DStageDir=$stage" "/DArtDir=$art" "/DAppVersion=$Version" "/DOutDir=$out" (Join-Path $Root 'installer\MediaVault.iss')
  if ($LASTEXITCODE) { throw "Inno Setup couldn't build the installer (exit code $LASTEXITCODE) - its messages are above." }
  $exe = Join-Path $out "Media-Vault-Setup-$Version.exe"
  Write-Host ("Made {0} ({1:N1} MB). On the other PC: run it - it installs Media Vault and opens setup." -f $exe, ((Get-Item -LiteralPath $exe).Length / 1MB))
} finally {
  Remove-Item -LiteralPath $stage, "$stage-art" -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
}
